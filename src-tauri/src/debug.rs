use std::{
    fs::Permissions, os::unix::fs::PermissionsExt, path::Path, process::Stdio, time::Duration,
};

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, State};
use tokio::{
    io::BufReader,
    net::{
        unix::{OwnedReadHalf, OwnedWriteHalf},
        UnixListener,
    },
    process::{Child, Command},
};

use crate::{
    tool_transport::{self, ServerEvent, ToolKind},
    tools::command,
    workspace::package_dir,
    CommandResult, Core,
};

#[derive(Serialize)]
pub struct DebugAdapter {
    server: u64,
    output: String,
}

pub(crate) fn private_socket_directory() -> CommandResult<tempfile::TempDir> {
    tempfile::Builder::new()
        .prefix("ig-dap-")
        .permissions(Permissions::from_mode(0o700))
        .tempdir()
        .map_err(|error| error.to_string())
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
    if session.task.is_some()
        || session.debug.is_some()
        || session.program_debug.is_some()
        || session.terminal_go()
        || session.terminal_cutover
    {
        return Err("A Go task or debug session is already running.".into());
    }
    package_dir(&root, &package)?;
    let mut delve = delve_command()?;
    // Delve dials a private socket. The directory is already owner-only
    // when the listener is bound, and there is no network port.
    let directory = private_socket_directory()?;
    let output = directory
        .path()
        .join("inferior")
        .to_str()
        .ok_or("The debug output path is not valid UTF-8.")?
        .to_owned();
    let (child, listener) = spawn_adapter(delve.current_dir(root), directory.path())?;
    let server = session.next_id();
    session.debug = Some(tool_transport::start(
        app,
        ToolKind::Delve,
        server,
        child,
        connect_adapter(listener),
        directory,
        events,
    ));
    Ok(DebugAdapter { server, output })
}

pub(crate) fn delve_command() -> CommandResult<Command> {
    command("dlv").map_err(|_| {
        "Install Delve with `brew install delve`, then check the tools in Settings.".into()
    })
}

pub(crate) fn spawn_adapter(
    delve: &mut Command,
    directory: &Path,
) -> CommandResult<(Child, UnixListener)> {
    let endpoint = directory.join("d.sock");
    let listener = UnixListener::bind(&endpoint)
        .map_err(|error| format!("Create private debugger socket: {error}"))?;
    let child = delve
        .args([
            "dap",
            "--client-addr",
            &format!("unix:{}", endpoint.display()),
        ])
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Start Delve: {error}"))?;
    Ok((child, listener))
}

pub(crate) async fn connect_adapter(
    listener: UnixListener,
) -> CommandResult<(BufReader<OwnedReadHalf>, OwnedWriteHalf)> {
    let accepted = tokio::time::timeout(Duration::from_secs(8), listener.accept()).await;
    let (stream, _) = accepted
        .map_err(|_| "Delve did not connect to its socket.".to_owned())?
        .map_err(|error| error.to_string())?;
    let (reader, writer) = stream.into_split();
    Ok((BufReader::new(reader), writer))
}

#[tauri::command]
pub async fn send_debug(state: State<'_, Core>, server: u64, message: String) -> CommandResult<()> {
    tool_transport::send(&state, ToolKind::Delve, server, message).await
}

#[tauri::command]
pub fn stop_debug(state: State<'_, Core>, server: u64) {
    if state
        .0
        .lock()
        .unwrap()
        .program_debug
        .as_ref()
        .is_some_and(|program| program.id == server)
    {
        return;
    }
    tool_transport::stop(&state, ToolKind::Delve, server);
}

#[cfg(test)]
#[test]
fn debugger_socket_directory_is_owner_only() {
    let directory = private_socket_directory().unwrap();
    let mode = std::fs::metadata(directory.path())
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(
        mode & 0o077,
        0,
        "other users cannot reach the debugger socket"
    );
}
