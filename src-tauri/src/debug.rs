use std::{io, process::Stdio, time::Duration};

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tokio::{
    io::BufReader,
    net::UnixListener,
    sync::{mpsc, oneshot},
};

use crate::{
    lsp::{frame, write_frame, RunningServer, ServerEvent, MAX_MESSAGE},
    tools::{command, ProcessGroup},
    workspace::package_dir,
    CommandResult, Core,
};

#[derive(Serialize)]
pub struct DebugAdapter {
    server: u64,
    output: String,
}

#[tauri::command]
pub async fn start_debug(
    app: AppHandle,
    state: State<'_, Core>,
    id: u64,
    package: String,
    events: Channel<ServerEvent>,
) -> CommandResult<DebugAdapter> {
    if package.len() > 512 || package.contains(['\n', '\r']) || package.contains("...") {
        return Err("Choose one local Go package for debugging.".into());
    }
    let mut session = state.0.lock().unwrap();
    let root = session.root(id)?.to_path_buf();
    if session.task.is_some() || session.debug.is_some() {
        return Err("A Go task or debug session is already running.".into());
    }
    package_dir(&root, &package)?;
    let mut delve = command("dlv").map_err(|_| {
        "Install Delve with `brew install delve`, then check the tools in Settings."
    })?;
    // Delve dials a private socket inside a 0700 directory. There is no
    // debug port exposed to other users or the network.
    let directory = tempfile::Builder::new()
        .prefix("ig-dap-")
        .tempdir()
        .map_err(|error| error.to_string())?;
    let endpoint = directory.path().join("d.sock");
    let output = directory
        .path()
        .join("inferior")
        .to_str()
        .ok_or("The debug output path is not valid UTF-8.")?
        .to_owned();
    let listener = UnixListener::bind(&endpoint)
        .map_err(|error| format!("Create private debugger socket: {error}"))?;
    let mut child = delve
        .args([
            "dap",
            "--client-addr",
            &format!("unix:{}", endpoint.display()),
        ])
        .current_dir(root)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Start Delve: {error}"))?;
    let group = ProcessGroup::from_pid(child.id().unwrap());
    let (input, mut outgoing) = mpsc::channel::<String>(32);
    let (stop, mut cancelled) = oneshot::channel();
    let server = session.next_id();
    session.debug = Some(RunningServer {
        id: server,
        input,
        stop: Some(stop),
        group: group.clone(),
    });
    tauri::async_runtime::spawn(async move {
        let _directory = directory;
        let connection = tokio::select! {
            _ = &mut cancelled => Err("Debug session stopped".to_owned()),
            status = child.wait() => {
                group.disarm();
                Err(format!("Delve stopped before connecting: {}", status.map_or_else(|e| e.to_string(), |s| s.to_string())))
            },
            connection = tokio::time::timeout(Duration::from_secs(8), listener.accept()) => connection
                .map_err(|_| "Delve did not connect to its socket.".to_owned())
                .and_then(|accepted| accepted.map(|(stream, _)| stream).map_err(|error| error.to_string())),
        };
        drop(listener);
        let reason = match connection {
            Err(error) => error,
            Ok(stream) => {
                let (reader, mut writer) = stream.into_split();
                let mut reader = BufReader::new(reader);
                let send = async {
                    while let Some(message) = outgoing.recv().await {
                        write_frame(&mut writer, &message).await?;
                    }
                    Ok::<_, io::Error>(())
                };
                let read = async {
                    while let Some(message) = frame(&mut reader).await? {
                        events
                            .send(ServerEvent::Message { message })
                            .map_err(io::Error::other)?;
                    }
                    Ok::<_, io::Error>(())
                };
                tokio::select! {
                    _ = cancelled => "Debug session stopped".to_owned(),
                    result = child.wait() => {
                        group.disarm();
                        format!("Delve exited: {}", result.map_or_else(|e| e.to_string(), |s| s.to_string()))
                    },
                    result = send => result.err().map_or_else(|| "Delve input closed".to_owned(), |error| error.to_string()),
                    result = read => result.err().map_or_else(|| "Delve disconnected".to_owned(), |error| error.to_string()),
                }
            }
        };
        group.kill();
        let _ = child.wait().await;
        let core = app.state::<Core>();
        let mut session = core.0.lock().unwrap();
        if session
            .debug
            .as_ref()
            .is_some_and(|active| active.id == server)
        {
            session.debug.take();
        }
        drop(session);
        let _ = events.send(ServerEvent::Closed { reason });
    });
    Ok(DebugAdapter { server, output })
}

#[tauri::command]
pub async fn send_debug(state: State<'_, Core>, server: u64, message: String) -> CommandResult<()> {
    if message.len() > MAX_MESSAGE {
        return Err("Debugger message is too large.".into());
    }
    let input = state
        .0
        .lock()
        .unwrap()
        .debug
        .as_ref()
        .filter(|active| active.id == server)
        .map(|active| active.input.clone())
        .ok_or("The debugger is not running.")?;
    input
        .send(message)
        .await
        .map_err(|_| "The debugger closed its input.".into())
}

#[tauri::command]
pub fn stop_debug(state: State<'_, Core>, server: u64) {
    let mut session = state.0.lock().unwrap();
    if session
        .debug
        .as_ref()
        .is_some_and(|active| active.id == server)
    {
        session.debug.take();
    }
}
