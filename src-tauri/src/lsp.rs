use std::{io, process::Stdio, sync::Arc};

use serde::Serialize;
use serde_json::Value;
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot},
};

use crate::{
    tools::{command, ProcessGroup},
    CommandResult, Core,
};

pub(crate) const MAX_MESSAGE: usize = 16 * 1024 * 1024;

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    Message { message: Value },
    Closed { reason: String },
}

pub struct RunningServer {
    pub(crate) id: u64,
    pub(crate) input: mpsc::Sender<String>,
    pub(crate) stop: Option<oneshot::Sender<()>>,
    pub(crate) group: Arc<ProcessGroup>,
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.group.kill();
    }
}

pub(crate) async fn frame(reader: &mut (impl AsyncBufRead + Unpin)) -> io::Result<Option<Value>> {
    let invalid = || {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid protocol message header",
        )
    };
    let mut length: Option<usize> = None;
    let mut header = String::new();
    let mut limited = (&mut *reader).take(8192);
    loop {
        header.clear();
        if limited.read_line(&mut header).await? == 0 {
            return if length.is_none() {
                Ok(None)
            } else {
                Err(invalid())
            };
        }
        if header == "\r\n" || header == "\n" {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("Content-Length") {
                length = Some(value.trim().parse().map_err(|_| invalid())?);
            }
        }
    }
    let length = length
        .filter(|len| *len <= MAX_MESSAGE)
        .ok_or_else(invalid)?;
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).await?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(io::Error::other)
}

pub(crate) async fn write_frame(
    writer: &mut (impl tokio::io::AsyncWrite + Unpin),
    message: &str,
) -> io::Result<()> {
    writer
        .write_all(format!("Content-Length: {}\r\n\r\n", message.len()).as_bytes())
        .await?;
    writer.write_all(message.as_bytes()).await
}

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
    let mut writer = child.stdin.take().unwrap();
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    let (input, mut outgoing) = mpsc::channel::<String>(32);
    let (send, receive) = oneshot::channel();
    let group = ProcessGroup::from_pid(child.id().unwrap());
    let server = session.next_id();
    session.lsp = Some(RunningServer {
        id: server,
        input,
        stop: Some(send),
        group: group.clone(),
    });
    tauri::async_runtime::spawn(async move {
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
        let reason = tokio::select! {
            _ = receive => "gopls stopped".to_owned(),
            result = child.wait() => {
                group.disarm();
                format!("gopls exited: {}", result.map_or_else(|e| e.to_string(), |s| s.to_string()))
            }
            result = send => result.err().map_or_else(|| "gopls input closed".to_owned(), |error| error.to_string()),
            result = read => result.err().map_or_else(|| "gopls output closed".to_owned(), |error| error.to_string()),
        };
        group.kill();
        let _ = child.wait().await;
        let core = app.state::<Core>();
        let mut session = core.0.lock().unwrap();
        if session
            .lsp
            .as_ref()
            .is_some_and(|active| active.id == server)
        {
            session.lsp.take();
        }
        drop(session);
        let _ = events.send(ServerEvent::Closed { reason });
    });
    Ok(server)
}

#[tauri::command]
pub async fn send_gopls(state: State<'_, Core>, server: u64, message: String) -> CommandResult<()> {
    if message.len() > MAX_MESSAGE {
        return Err("The language server message is too large.".into());
    }
    let input = state
        .0
        .lock()
        .unwrap()
        .lsp
        .as_ref()
        .filter(|active| active.id == server)
        .map(|active| active.input.clone())
        .ok_or("The Go language server is not running.")?;
    input
        .send(message)
        .await
        .map_err(|_| "The Go language server closed its input.".into())
}

#[tauri::command]
pub fn stop_gopls(state: State<'_, Core>, server: u64) {
    let mut session = state.0.lock().unwrap();
    if session
        .lsp
        .as_ref()
        .is_some_and(|active| active.id == server)
    {
        session.lsp.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_unicode_and_multiple_messages_by_byte_length() {
        let first = r#"{"text":"Go 🚀"}"#;
        let second = r#"{"id":2}"#;
        let wire = format!(
            "Content-Length: {}\r\n\r\n{first}content-length: {}\r\n\r\n{second}",
            first.len(),
            second.len()
        );
        let mut stream = BufReader::with_capacity(3, wire.as_bytes());
        assert_eq!(frame(&mut stream).await.unwrap().unwrap()["text"], "Go 🚀");
        assert_eq!(frame(&mut stream).await.unwrap().unwrap()["id"], 2);
        assert!(frame(&mut stream).await.unwrap().is_none());
        let mut invalid = "Content-Length: 999999999\r\n\r\n".as_bytes();
        assert!(frame(&mut invalid).await.is_err());
    }
}
