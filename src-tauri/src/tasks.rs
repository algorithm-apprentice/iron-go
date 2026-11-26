use std::{io, process::Stdio, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tokio::{io::AsyncReadExt, process::Child, sync::oneshot};

use crate::{
    tools::{command, ProcessGroup},
    workspace::package_dir,
    CommandResult, Core,
};

const MAX_OUTPUT: usize = 512 * 1024;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Run,
    Build,
    Test,
}

impl TaskKind {
    fn verb(self) -> &'static str {
        match self {
            Self::Run => "run",
            Self::Build => "build",
            Self::Test => "test",
        }
    }
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum Stream {
    Stdout,
    Stderr,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TaskEvent {
    Started {
        command: String,
    },
    Output {
        stream: Stream,
        bytes: Vec<u8>,
    },
    Notice {
        message: String,
    },
    Finished {
        success: bool,
        code: Option<i32>,
        cancelled: bool,
    },
}

pub struct RunningTask {
    id: u64,
    stop: Option<oneshot::Sender<()>>,
    group: Arc<ProcessGroup>,
}

impl RunningTask {
    fn cancel(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.group.kill();
    }
}

impl Drop for RunningTask {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[tauri::command]
pub async fn start_task(
    app: AppHandle,
    state: State<'_, Core>,
    id: u64,
    kind: TaskKind,
    package: String,
    events: Channel<TaskEvent>,
) -> CommandResult<()> {
    if package.len() > 512 || package.contains(['\n', '\r']) {
        return Err("Enter a relative Go package such as './cmd/app'.".into());
    }
    if matches!(kind, TaskKind::Run) && package.contains("...") {
        return Err("Go Run requires one executable package, not a pattern.".into());
    }
    let mut session = state.0.lock().unwrap();
    let root = session.root(id)?;
    if session.task.is_some() {
        return Err("A Go task is already running.".into());
    }
    package_dir(root, &package)?;
    let mut command = command("go")?;
    command.arg(kind.verb());
    let flags = if matches!(kind, TaskKind::Test) {
        command.arg("-v");
        " -v"
    } else {
        ""
    };
    let child = command
        .arg(&package)
        .current_dir(root)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Start Go task: {error}"))?;
    let group = ProcessGroup::from_pid(child.id().unwrap());
    let (send, receive) = oneshot::channel();
    let task_id = session.next_id();
    session.task = Some(RunningTask {
        id: task_id,
        stop: Some(send),
        group: group.clone(),
    });
    tauri::async_runtime::spawn(async move {
        let _ = events.send(TaskEvent::Started {
            command: format!("go {}{flags} {package}", kind.verb()),
        });
        let finished = supervise(child, receive, &group, |event| {
            let _ = events.send(event);
        })
        .await;
        let core = app.state::<Core>();
        let mut session = core.0.lock().unwrap();
        if session.task.as_ref().is_some_and(|task| task.id == task_id) {
            session.task.take();
        }
        drop(session);
        let _ = events.send(finished);
    });
    Ok(())
}

fn output(emit: &mut impl FnMut(TaskEvent), budget: &mut usize, bytes: &[u8], stream: Stream) {
    let count = bytes.len().min(*budget);
    if count > 0 {
        *budget -= count;
        emit(TaskEvent::Output {
            stream,
            bytes: bytes[..count].to_vec(),
        });
        if *budget == 0 {
            emit(TaskEvent::Notice {
                message: "Output limit reached; remaining output is hidden.".into(),
            });
        }
    }
}

async fn supervise(
    mut child: Child,
    mut stop: oneshot::Receiver<()>,
    group: &ProcessGroup,
    mut emit: impl FnMut(TaskEvent),
) -> TaskEvent {
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let (mut out, mut err) = ([0; 4096], [0; 4096]);
    let (mut has_stdout, mut has_stderr) = (true, true);
    let mut budget = MAX_OUTPUT;
    let (status, cancelled) = loop {
        tokio::select! {
            _ = &mut stop => {
                group.kill();
                break (child.wait().await, true);
            }
            status = child.wait() => break (status, false),
            count = stdout.read(&mut out), if has_stdout => {
                has_stdout = handle_read(count, &out, Stream::Stdout, &mut budget, &mut emit);
            }
            count = stderr.read(&mut err), if has_stderr => {
                has_stderr = handle_read(count, &err, Stream::Stderr, &mut budget, &mut emit);
            }
        }
    };
    group.disarm();
    if !cancelled {
        // Drain output written just before exit, without waiting forever for
        // an unrelated process that inherited the descriptors.
        let _ = tokio::time::timeout(Duration::from_millis(300), async {
            while has_stdout || has_stderr {
                tokio::select! {
                    count = stdout.read(&mut out), if has_stdout => {
                        has_stdout = handle_read(count, &out, Stream::Stdout, &mut budget, &mut emit);
                    }
                    count = stderr.read(&mut err), if has_stderr => {
                        has_stderr = handle_read(count, &err, Stream::Stderr, &mut budget, &mut emit);
                    }
                }
            }
        }).await;
    }
    match status {
        Ok(status) => TaskEvent::Finished {
            success: status.success() && !cancelled,
            code: status.code(),
            cancelled,
        },
        Err(error) => {
            emit(TaskEvent::Notice {
                message: format!("Wait for Go process: {error}"),
            });
            TaskEvent::Finished {
                success: false,
                code: None,
                cancelled,
            }
        }
    }
}

fn handle_read(
    count: io::Result<usize>,
    buf: &[u8],
    stream: Stream,
    budget: &mut usize,
    emit: &mut impl FnMut(TaskEvent),
) -> bool {
    match count {
        Ok(0) => false,
        Ok(count) => {
            output(emit, budget, &buf[..count], stream);
            true
        }
        Err(error) => {
            emit(TaskEvent::Notice {
                message: format!("Read task output: {error}"),
            });
            false
        }
    }
}

#[tauri::command]
pub fn stop_task(state: State<'_, Core>, id: u64) -> CommandResult<()> {
    let mut session = state.0.lock().unwrap();
    session.root(id)?;
    if let Some(task) = &mut session.task {
        task.cancel();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn runs_sample_go_program_and_drains_output() {
        let Ok(mut go) = command("go") else { return };
        let child = go
            .args(["run", "./cmd/orbit"])
            .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../examples/orbit"))
            .process_group(0)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let group = ProcessGroup::from_pid(child.id().unwrap());
        let (_send, receive) = oneshot::channel();
        let mut bytes = vec![];
        let event = supervise(child, receive, &group, |event| {
            if let TaskEvent::Output { bytes: data, .. } = event {
                bytes.extend(data);
            }
        })
        .await;
        assert!(
            matches!(event, TaskEvent::Finished { success: true, .. }),
            "{}",
            String::from_utf8_lossy(&bytes)
        );
        assert!(String::from_utf8_lossy(&bytes).contains("orbit v0.1.0 is online"));
    }

    #[tokio::test]
    async fn stops_a_running_process_group() {
        let child = tokio::process::Command::new("/bin/sleep")
            .arg("60")
            .process_group(0)
            .kill_on_drop(true)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let group = ProcessGroup::from_pid(child.id().unwrap());
        let (send, receive) = oneshot::channel();
        send.send(()).unwrap();
        let event = tokio::time::timeout(
            Duration::from_secs(2),
            supervise(child, receive, &group, |_| {}),
        )
        .await
        .unwrap();
        assert!(matches!(
            event,
            TaskEvent::Finished {
                cancelled: true,
                success: false,
                ..
            }
        ));
    }
}
