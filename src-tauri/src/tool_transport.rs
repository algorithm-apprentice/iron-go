use std::{
    future::{pending, Future},
    io,
    process::ExitStatus,
    sync::Arc,
    time::Duration,
};

use serde::Serialize;
use serde_json::Value;
use tauri::{ipc::Channel, AppHandle, Manager};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    process::Child,
    sync::{mpsc, oneshot},
    time::{sleep_until, Instant},
};

use crate::{
    process_owner::{OwnedChild, ProcessGroup},
    CommandResult, Core, Session,
};

const MAX_HEADER: u64 = 8192;
const MAX_MESSAGE: usize = 16 * 1024 * 1024;
const DRAIN_LIMIT: Duration = Duration::from_millis(300);

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    Message { message: Value },
    Closed { reason: String },
}

#[derive(Clone, Copy)]
pub enum ToolKind {
    Gopls,
    Delve,
}

impl ToolKind {
    fn slot(self, session: &mut Session) -> &mut Option<RunningServer> {
        match self {
            Self::Gopls => &mut session.lsp,
            Self::Delve => &mut session.debug,
        }
    }

    fn stopped(self) -> &'static str {
        match self {
            Self::Gopls => "gopls stopped",
            Self::Delve => "Debug session stopped",
        }
    }

    fn input_closed(self) -> &'static str {
        match self {
            Self::Gopls => "gopls input closed",
            Self::Delve => "Delve input closed",
        }
    }

    fn output_closed(self) -> &'static str {
        match self {
            Self::Gopls => "gopls output closed",
            Self::Delve => "Delve disconnected",
        }
    }

    fn exited(self, status: ExitStatus, connected: bool) -> String {
        match (self, connected) {
            (Self::Gopls, _) => format!("gopls exited: {status}"),
            (Self::Delve, true) => format!("Delve exited: {status}"),
            (Self::Delve, false) => format!("Delve stopped before connecting: {status}"),
        }
    }
}

pub struct RunningServer {
    id: u64,
    input: mpsc::Sender<String>,
    stop: Option<oneshot::Sender<()>>,
    group: Arc<ProcessGroup>,
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.group.kill();
    }
}

async fn frame(reader: &mut (impl AsyncBufRead + Unpin)) -> io::Result<Option<Value>> {
    let invalid = || {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid protocol message header",
        )
    };
    let truncated = || {
        io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Truncated protocol message header",
        )
    };
    let mut length: Option<usize> = None;
    let mut saw_header = false;
    let mut header = String::new();
    let mut limited = (&mut *reader).take(MAX_HEADER);
    loop {
        header.clear();
        if limited.read_line(&mut header).await? == 0 {
            return if limited.limit() == 0 {
                Err(invalid())
            } else if saw_header {
                Err(truncated())
            } else {
                Ok(None)
            };
        }
        if !header.ends_with('\n') {
            return Err(if limited.limit() == 0 {
                invalid()
            } else {
                truncated()
            });
        }
        saw_header = true;
        if header == "\r\n" || header == "\n" {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("Content-Length") {
                if length.is_some() {
                    return Err(invalid());
                }
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

async fn write_frames(
    writer: &mut (impl AsyncWrite + Unpin),
    outgoing: &mut mpsc::Receiver<String>,
) -> io::Result<()> {
    while let Some(message) = outgoing.recv().await {
        writer
            .write_all(format!("Content-Length: {}\r\n\r\n", message.len()).as_bytes())
            .await?;
        writer.write_all(message.as_bytes()).await?;
    }
    Ok(())
}

struct End {
    reason: String,
    reaped: bool,
}

async fn relay<R, W>(
    kind: ToolKind,
    (mut reader, mut writer): (R, W),
    outgoing: &mut mpsc::Receiver<String>,
    stop: &mut oneshot::Receiver<()>,
    mut wait: std::pin::Pin<&mut impl Future<Output = io::Result<ExitStatus>>>,
    emit: &mut impl FnMut(Value) -> io::Result<()>,
) -> End
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let send = write_frames(&mut writer, outgoing);
    tokio::pin!(send);
    let mut reaped = false;
    let mut drain: Option<(Instant, String)> = None;
    let reason = 'frames: loop {
        let next = frame(&mut reader);
        tokio::pin!(next);
        loop {
            let deadline = drain.as_ref().map(|(deadline, _)| *deadline);
            let expired = async move {
                match deadline {
                    Some(deadline) if deadline > Instant::now() => sleep_until(deadline).await,
                    Some(_) => (),
                    None => pending().await,
                }
            };
            tokio::select! {
                biased;
                _ = &mut *stop => break 'frames kind.stopped().to_owned(),
                _ = expired => break 'frames drain.take().unwrap().1,
                status = &mut wait, if !reaped => match status {
                    Ok(status) => {
                        reaped = true;
                        drain.get_or_insert_with(|| (Instant::now() + DRAIN_LIMIT, kind.exited(status, true)));
                    }
                    Err(error) => break 'frames format!("Wait for protocol process: {error}"),
                },
                result = &mut send, if drain.is_none() => {
                    let reason = result.err().map_or_else(|| kind.input_closed().to_owned(), |error| error.to_string());
                    drain = Some((Instant::now() + DRAIN_LIMIT, reason));
                }
                result = &mut next => {
                    // A frame poll can parse JSON synchronously. Stop or
                    // expiry can arrive after select's initial checks.
                    if !matches!(stop.try_recv(), Err(oneshot::error::TryRecvError::Empty)) {
                        break 'frames kind.stopped().to_owned();
                    }
                    if drain.as_ref().is_some_and(|(deadline, _)| Instant::now() >= *deadline) {
                        break 'frames drain.take().unwrap().1;
                    }
                    match result {
                        Ok(Some(message)) => {
                            if let Err(error) = emit(message) { break 'frames error.to_string(); }
                            // Yield even if reads and delivery are both always ready.
                            tokio::task::yield_now().await;
                            continue 'frames;
                        }
                        Ok(None) => break 'frames drain.take().map_or_else(|| kind.output_closed().to_owned(), |(_, reason)| reason),
                        Err(error) => break 'frames error.to_string(),
                    }
                }
            }
        }
    };
    End { reason, reaped }
}

async fn supervise<R, W>(
    kind: ToolKind,
    mut child: OwnedChild,
    connect: impl Future<Output = CommandResult<(R, W)>>,
    mut outgoing: mpsc::Receiver<String>,
    mut stop: oneshot::Receiver<()>,
    mut emit: impl FnMut(Value) -> io::Result<()>,
) -> String
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let end = {
        let wait = child.wait();
        tokio::pin!(wait);
        tokio::select! {
            biased;
            _ = &mut stop => End { reason: kind.stopped().to_owned(), reaped: false },
            connected = connect => match connected {
                Ok(connection) => relay(kind, connection, &mut outgoing, &mut stop, wait, &mut emit).await,
                Err(reason) => End { reason, reaped: false },
            },
            status = &mut wait => match status {
                Ok(status) => End { reason: kind.exited(status, false), reaped: true },
                Err(error) => End { reason: format!("Wait for protocol process: {error}"), reaped: false },
            },
        }
    };
    if !end.reaped {
        child.group.kill();
        let _ = child.wait().await;
    }
    end.reason
}

fn retire(slot: &mut Option<RunningServer>, id: u64) {
    if slot.as_ref().is_some_and(|handle| handle.id == id) {
        slot.take();
    }
}

fn finish(reason: String, retire: impl FnOnce(), emit: impl FnOnce(ServerEvent)) {
    retire();
    emit(ServerEvent::Closed { reason });
}

pub fn start<R, W>(
    app: AppHandle,
    kind: ToolKind,
    id: u64,
    child: Child,
    connect: impl Future<Output = CommandResult<(R, W)>> + Send + 'static,
    resource: impl Send + 'static,
    events: Channel<ServerEvent>,
) -> RunningServer
where
    R: AsyncBufRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let child = OwnedChild::new(child);
    let group = child.group.clone();
    let (input, outgoing) = mpsc::channel(32);
    let (send, receive) = oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let reason = supervise(kind, child, connect, outgoing, receive, |message| {
            events
                .send(ServerEvent::Message { message })
                .map_err(io::Error::other)
        })
        .await;
        drop(resource);
        finish(
            reason,
            || stop(app.state::<Core>().inner(), kind, id),
            |event| {
                let _ = events.send(event);
            },
        );
    });
    RunningServer {
        id,
        input,
        stop: Some(send),
        group,
    }
}

pub async fn send(core: &Core, kind: ToolKind, id: u64, message: String) -> CommandResult<()> {
    let (too_large, not_running, closed) = match kind {
        ToolKind::Gopls => (
            "The language server message is too large.",
            "The Go language server is not running.",
            "The Go language server closed its input.",
        ),
        ToolKind::Delve => (
            "Debugger message is too large.",
            "The debugger is not running.",
            "The debugger closed its input.",
        ),
    };
    if message.len() > MAX_MESSAGE {
        return Err(too_large.into());
    }
    let input = kind
        .slot(&mut core.0.lock().unwrap())
        .as_ref()
        .filter(|handle| handle.id == id)
        .map(|handle| handle.input.clone())
        .ok_or(not_running)?;
    input.send(message).await.map_err(|_| closed.into())
}

pub fn stop(core: &Core, kind: ToolKind, id: u64) {
    retire(kind.slot(&mut core.0.lock().unwrap()), id);
}

#[cfg(test)]
mod tests;
