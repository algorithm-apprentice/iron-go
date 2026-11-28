use std::{
    fs::File,
    io,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tokio::{
    process::Command,
    sync::{oneshot, watch},
};

use crate::{
    debug::{connect_adapter, delve_command, private_socket_directory, spawn_adapter},
    process_owner::{bind_child_directory, OwnedChild},
    tasks::{
        literal_package_selector, spawn_child, supervise, verify_executable, RunLaunch,
        RunningTask, TaskEvent, MAX_OUTPUT,
    },
    tool_transport::{prepare_server, ToolKind},
    tools::command,
    workspace::{package_dir, run_directory},
    CommandResult, Core, Session,
};

const STOPPED: &str = "Debug session stopped";

pub(crate) struct ProgramDebug {
    pub(crate) id: u64,
    done: watch::Sender<bool>,
    cancelled: bool,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProgramDebugEvent {
    Build {
        event: TaskEvent,
    },
    Ready {
        output: String,
        path: Option<String>,
    },
    Message {
        message: serde_json::Value,
    },
    Closed {
        reason: String,
    },
}

#[tauri::command]
pub async fn start_program_debug(
    app: AppHandle,
    state: State<'_, Core>,
    id: u64,
    package: String,
    launch: RunLaunch,
    events: Channel<ProgramDebugEvent>,
) -> CommandResult<u64> {
    if package.len() > 512 || !literal_package_selector(&package) {
        return Err("Choose one local executable Go package for debugging.".into());
    }
    launch.validate()?;
    let mut session = state.0.lock().unwrap();
    let root = session.root(id)?;
    if session.task.is_some()
        || session.debug.is_some()
        || session.program_debug.is_some()
        || session.terminal_go()
        || session.terminal_cutover
    {
        return Err("A Go task or debug session is already running.".into());
    }
    package_dir(root, &package)?;
    let workspace = session.workspace.as_ref().unwrap();
    let working = run_directory(workspace, &launch.directory)?;
    let directory = private_socket_directory()?;
    let binary = directory.path().join("inferior");
    let output = binary
        .to_str()
        .ok_or("The debug output path is not valid UTF-8.")?
        .to_owned();
    let delve = delve_command()?;
    let mut go = command("go")?;
    bind_child_directory(&mut go, run_directory(workspace, ".")?);
    go.args(["build", "-gcflags=all=-N -l", "-o"])
        .arg(&binary)
        .arg(&package);
    let child = spawn_child(&mut go).map_err(|error| format!("Start debug build: {error}"))?;
    let (send, mut stop) = oneshot::channel();
    let server = session.next_id();
    #[cfg(feature = "e2e")]
    let handoff = session.acceptance.run_handoff.clone();
    session
        .run_directories
        .insert(server, directory.path().to_path_buf());
    session.task = Some(RunningTask {
        id: server,
        stop: Some(send),
        group: child.group.clone(),
    });
    session.program_debug = Some(ProgramDebug {
        id: server,
        done: watch::channel(false).0,
        cancelled: false,
    });
    tauri::async_runtime::spawn(async move {
        let notify = |event| {
            let _ = events.send(ProgramDebugEvent::Build { event });
        };
        notify(TaskEvent::Started {
            command: format!("Build debuggable Go package {package}"),
            structured_tests: false,
        });
        let mut budget = MAX_OUTPUT;
        let finished = supervise(child, &mut stop, &mut budget, notify).await;
        let reason = match finished {
            TaskEvent::Finished { success: true, .. } => {
                #[cfg(feature = "e2e")]
                let proceed = handoff.wait(directory.path(), &mut stop).await;
                #[cfg(not(feature = "e2e"))]
                let proceed = true;
                if proceed {
                    match admit_adapter(
                        app.state::<Core>().inner(),
                        id,
                        server,
                        &launch.directory,
                        working,
                        &binary,
                        delve,
                        events.clone(),
                    ) {
                        Ok(Some(adapter)) => {
                            let _ = events.send(ProgramDebugEvent::Ready {
                                output,
                                path: std::env::var("PATH").ok(),
                            });
                            adapter.run().await
                        }
                        Ok(None) => STOPPED.into(),
                        Err(error) => format!("Debug failed: {error}"),
                    }
                } else {
                    STOPPED.into()
                }
            }
            TaskEvent::Finished {
                cancelled: true, ..
            } => STOPPED.into(),
            _ => "Debug failed: Go build did not complete successfully.".into(),
        };
        remove_directory(directory).await;
        let core = app.state::<Core>();
        let mut session = core.0.lock().unwrap();
        if session.task.as_ref().is_some_and(|task| task.id == server) {
            session.task.take();
        }
        session.debug.take();
        session.run_directories.remove(&server);
        let program = session
            .program_debug
            .take()
            .expect("program launch owns the native reservation");
        program.done.send_replace(true);
        #[cfg(feature = "e2e")]
        core.2.notify_all();
        let reason = if program.cancelled {
            STOPPED.into()
        } else {
            reason
        };
        drop(session);
        let _ = events.send(ProgramDebugEvent::Closed { reason });
    });
    Ok(server)
}

fn admit_adapter(
    core: &Core,
    workspace_id: u64,
    server: u64,
    directory: &str,
    working: File,
    binary: &Path,
    mut delve: Command,
    events: Channel<ProgramDebugEvent>,
) -> CommandResult<Option<AdapterWorker<impl std::future::Future<Output = String> + Send>>> {
    let mut session = core.0.lock().unwrap();
    if session.root(workspace_id).is_err()
        || !session
            .task
            .as_ref()
            .is_some_and(|task| task.id == server && task.stop.is_some())
    {
        return Ok(None);
    }
    verify_executable(binary)?;
    let current = run_directory(session.workspace.as_ref().unwrap(), directory)?;
    let identity = |file: File| {
        file.metadata()
            .map(|metadata| (metadata.dev(), metadata.ino()))
            .map_err(|error| error.to_string())
    };
    if identity(working.try_clone().map_err(|error| error.to_string())?)? != identity(current)? {
        return Err("The configured working directory was replaced during the debug build.".into());
    }
    bind_child_directory(&mut delve, working);
    let (child, listener) = spawn_adapter(
        &mut delve,
        binary.parent().expect("private executable directory"),
    )?;
    let group = child.id().expect("spawned adapter process") as i32;
    let inferior = Arc::new(Mutex::new(None));
    let observed = inferior.clone();
    let executable = binary.canonicalize().unwrap_or_else(|_| binary.to_owned());
    #[cfg(feature = "e2e")]
    let allow_disconnect = !session.acceptance.hold_debug_disconnect;
    #[cfg(not(feature = "e2e"))]
    let allow_disconnect = true;
    let (adapter, worker) = prepare_server(
        ToolKind::DebugProgram { allow_disconnect },
        server,
        child,
        connect_adapter(listener),
        move |message| {
            if message.get("event").and_then(|event| event.as_str()) == Some("process") {
                if let Some(pid) = message
                    .pointer("/body/systemProcessId")
                    .and_then(|pid| pid.as_i64())
                    .and_then(|pid| i32::try_from(pid).ok())
                    .filter(|pid| *pid > 0)
                {
                    let mut observed = observed.lock().unwrap();
                    if observed.is_none() {
                        *observed = Some(Inferior::observe(pid, group, &executable)?);
                    }
                }
            }
            events
                .send(ProgramDebugEvent::Message { message })
                .map_err(io::Error::other)
        },
    );
    session.task.take();
    session.debug = Some(adapter);
    Ok(Some(AdapterWorker {
        worker,
        group,
        inferior,
    }))
}

struct AdapterWorker<F> {
    worker: F,
    group: i32,
    inferior: Arc<Mutex<Option<Inferior>>>,
}

impl<F: std::future::Future<Output = String>> AdapterWorker<F> {
    async fn run(self) -> String {
        let reason = self.worker.await;
        let mut inferior = self.inferior.lock().unwrap().take();
        if let Some(anchor) = inferior
            .as_mut()
            .and_then(|inferior| inferior.anchor.take())
        {
            let mut anchor = anchor;
            anchor.group.kill();
            let _ = anchor.wait().await;
        }
        while group_exists(self.group)
            || inferior.as_ref().is_some_and(|inferior| {
                inferior.process.alive()
                    || (inferior.process.group != self.group
                        && group_exists(inferior.process.group))
            })
        {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        reason
    }
}

struct Inferior {
    process: ProcessStamp,
    anchor: Option<OwnedChild>,
}

impl Inferior {
    fn observe(pid: i32, adapter: i32, executable: &Path) -> io::Result<Self> {
        let process = ProcessStamp::of(pid)
            .ok_or_else(|| io::Error::other("Delve did not report a live executable."))?;
        let owned_parent = process.parent == adapter
            || ProcessStamp::of(process.parent).is_some_and(|parent| parent.parent == adapter);
        if !owned_parent
            || !is_executable(pid, executable)
            || (process.group != adapter && process.group != pid)
        {
            return Err(io::Error::other(
                "Delve did not launch the executable in an owned process group.",
            ));
        }
        let anchor = if process.group != adapter {
            // debugserver gives the inferior a new process group. A blocked
            // native child in that group keeps its identity reserved even if
            // the inferior exits before its same-group descendants.
            let child = Command::new("/bin/cat")
                .process_group(process.group)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()?;
            if !process.alive() {
                return Err(io::Error::other(
                    "The debuggee exited before its group could be bound.",
                ));
            }
            Some(OwnedChild::in_group(child, process.group))
        } else {
            None
        };
        Ok(Self { process, anchor })
    }
}

fn is_executable(pid: i32, executable: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let mut buffer = [0; 4096];
    let length =
        unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    length > 0
        && std::ffi::CStr::from_bytes_until_nul(&buffer)
            .is_ok_and(|path| path.to_bytes() == executable.as_os_str().as_bytes())
}

fn group_exists(group: i32) -> bool {
    // Signal 0 only observes the group. The live owner handles real signals.
    unsafe {
        libc::kill(-group, 0) == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
}

pub(crate) struct ProcessStamp {
    pid: i32,
    parent: i32,
    group: i32,
    started: (u64, u64),
}

impl ProcessStamp {
    pub(crate) fn of(pid: i32) -> Option<Self> {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        let read = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        };
        if read != size {
            return None;
        }
        let info = unsafe { info.assume_init() };
        Some(Self {
            pid,
            parent: info.pbi_ppid as i32,
            group: info.pbi_pgid as i32,
            started: (info.pbi_start_tvsec, info.pbi_start_tvusec),
        })
    }

    pub(crate) fn alive(&self) -> bool {
        Self::of(self.pid).is_some_and(|current| current.started == self.started)
    }

    pub(crate) fn confirmed_gone(&self) -> bool {
        if let Some(current) = Self::of(self.pid) {
            return current.started != self.started;
        }
        // A failed metadata query is not exit. ESRCH is an independent
        // observation; signal zero never delivers a signal.
        unsafe {
            libc::kill(self.pid, 0) != 0
                && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        }
    }
}

pub(crate) async fn remove_directory(directory: tempfile::TempDir) {
    let path: PathBuf = directory.path().to_path_buf();
    if directory.close().is_ok() {
        return;
    }
    loop {
        match std::fs::remove_dir_all(&path) {
            Ok(()) => return,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return,
            Err(_) => tokio::time::sleep(Duration::from_secs(1)).await,
        }
    }
}

impl Session {
    pub(crate) fn request_program_stop(
        &mut self,
        server: Option<u64>,
    ) -> Option<watch::Receiver<bool>> {
        let program = self
            .program_debug
            .as_mut()
            .filter(|program| server.is_none_or(|id| id == program.id))?;
        program.cancelled = true;
        if let Some(task) = self.task.as_mut() {
            task.cancel();
        }
        if let Some(adapter) = self.debug.as_mut() {
            adapter.request_stop();
        }
        Some(program.done.subscribe())
    }
}

pub(crate) async fn stop_program(core: &Core, server: Option<u64>) -> CommandResult<()> {
    let stopping = core.0.lock().unwrap().request_program_stop(server);
    if let Some(mut stopped) = stopping {
        tokio::time::timeout(Duration::from_secs(5), stopped.wait_for(|done| *done)).await
            .map_err(|_| "Executable debugger cleanup is still pending. Try Stop or Quit again once the processes exit.".to_owned())?
            .map_err(|_| "Executable debugger cleanup could not be confirmed.".to_owned())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_program_debug(state: State<'_, Core>, server: u64) -> CommandResult<()> {
    stop_program(&state, Some(server)).await
}
