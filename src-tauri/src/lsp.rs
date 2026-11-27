use std::{future, process::Stdio};

use tauri::{ipc::Channel, AppHandle, State};
use tokio::io::BufReader;

use crate::{
    tool_transport::{self, ServerEvent, ToolKind},
    tools::command,
    CommandResult, Core,
};

#[tauri::command]
pub async fn start_gopls(
    app: AppHandle,
    state: State<'_, Core>,
    id: u64,
    events: Channel<ServerEvent>,
) -> CommandResult<u64> {
    let mut session = state.0.lock().unwrap();
    let root = session.root(id)?.to_path_buf();
    let mut child = command("gopls")?
        .arg("serve")
        .current_dir(root)
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Start gopls: {error}"))?;
    let writer = child.stdin.take().unwrap();
    let reader = BufReader::new(child.stdout.take().unwrap());
    let server = session.next_id();
    session.lsp = Some(tool_transport::start(
        app,
        ToolKind::Gopls,
        server,
        child,
        future::ready(Ok((reader, writer))),
        (),
        events,
    ));
    Ok(server)
}

#[tauri::command]
pub async fn send_gopls(state: State<'_, Core>, server: u64, message: String) -> CommandResult<()> {
    tool_transport::send(&state, ToolKind::Gopls, server, message).await
}

#[tauri::command]
pub fn stop_gopls(state: State<'_, Core>, server: u64) {
    tool_transport::stop(&state, ToolKind::Gopls, server);
}
