use super::*;
use std::{
    os::unix::process::ExitStatusExt,
    pin::Pin,
    process::Stdio,
    task::{Context, Poll},
};
use tokio::{
    io::{self as async_io, AsyncRead, BufReader, Empty, ReadBuf, Sink},
    process::Command,
    time::timeout,
};

struct StopOnBody {
    bytes: &'static [u8],
    stop: Option<oneshot::Sender<()>>,
}

impl AsyncRead for StopOnBody {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let count = self.bytes.len().min(output.remaining());
        output.put_slice(&self.bytes[..count]);
        self.bytes = &self.bytes[count..];
        if let Some(stop) = self.stop.take() {
            stop.send(()).unwrap();
        }
        Poll::Ready(Ok(()))
    }
}

impl AsyncBufRead for StopOnBody {
    fn poll_fill_buf(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<&[u8]>> {
        Poll::Ready(Ok(self.bytes))
    }

    fn consume(mut self: Pin<&mut Self>, count: usize) {
        self.bytes = &self.bytes[count..];
    }
}

#[tokio::test]
async fn cancellation_while_completing_a_frame_prevents_delivery() {
    let (_input, mut outgoing) = mpsc::channel(1);
    let (stop, mut cancel) = oneshot::channel();
    let wait = std::future::ready(Ok(ExitStatus::from_raw(0)));
    tokio::pin!(wait);
    let reader = StopOnBody {
        bytes: b"Content-Length: 2\r\n\r\n{}",
        stop: Some(stop),
    };
    let mut delivered = 0;
    let end = relay(
        ToolKind::Delve,
        (reader, async_io::sink()),
        &mut outgoing,
        &mut cancel,
        wait,
        &mut |_| {
            delivered += 1;
            Ok(())
        },
    )
    .await;
    assert_eq!(end.reason, "Debug session stopped");
    assert_eq!(
        delivered, 0,
        "cancellation during the body read must win over the completed frame"
    );
}

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
}

#[tokio::test]
async fn partial_header_is_not_a_clean_boundary_eof() {
    for fragment in [
        "Content-Type: application/json\r\n",
        "Content-Length: 2",
        "Content-Length: 2\r\n\r\n{",
    ] {
        let error = frame(&mut fragment.as_bytes())
            .await
            .expect_err("a truncated frame is not EOF between frames");
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof, "{fragment:?}");
    }
}

#[tokio::test]
async fn rejects_duplicate_lengths_and_oversized_headers_or_bodies() {
    let huge_header = "x".repeat(MAX_HEADER as usize);
    for header in [
        "Content-Length: 999999999\r\n\r\n",
        "Content-Length: 2\r\ncontent-length: 2\r\n\r\n{}",
        &huge_header,
    ] {
        assert_eq!(
            frame(&mut header.as_bytes()).await.unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}

#[tokio::test]
async fn child_exit_drains_a_partially_read_frame() {
    let (mut peer, receive) = async_io::duplex(1);
    let (_input, mut outgoing) = mpsc::channel(1);
    let (_stop, mut cancel) = oneshot::channel();
    let (exit, terminated) = oneshot::channel();
    let (observed, got_exit) = oneshot::channel();
    let wait = async {
        terminated.await.unwrap();
        observed.send(()).unwrap();
        Ok(ExitStatus::from_raw(0))
    };
    tokio::pin!(wait);
    let mut messages = Vec::new();
    let mut emit = |value| {
        messages.push(value);
        Ok(())
    };
    let run = relay(
        ToolKind::Gopls,
        (BufReader::new(receive), async_io::sink()),
        &mut outgoing,
        &mut cancel,
        wait,
        &mut emit,
    );
    let feed = async {
        peer.write_all(b"Content-Length: 7\r\n\r\n{\"x\":")
            .await
            .unwrap();
        exit.send(()).unwrap();
        got_exit.await.unwrap();
        peer.write_all(b"1}").await.unwrap();
        drop(peer);
    };
    let (end, _) = timeout(Duration::from_secs(2), async { tokio::join!(run, feed) })
        .await
        .unwrap();
    assert_eq!(messages, [serde_json::json!({"x": 1})]);
    assert!(end.reaped && end.reason.starts_with("gopls exited:"));
}

struct BrokenWriter(Option<oneshot::Sender<()>>);

impl AsyncWrite for BrokenWriter {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
        _: &[u8],
    ) -> Poll<io::Result<usize>> {
        if let Some(observed) = self.0.take() {
            let _ = observed.send(());
        }
        Poll::Ready(Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "fixture writer closed",
        )))
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

#[tokio::test]
async fn peer_write_failure_still_drains_readable_frames() {
    let (mut peer, receive) = async_io::duplex(1);
    let (input, mut outgoing) = mpsc::channel(1);
    let (_stop, mut cancel) = oneshot::channel();
    let (observed, failed) = oneshot::channel();
    let wait = pending();
    tokio::pin!(wait);
    let mut messages = Vec::new();
    let mut emit = |value| {
        messages.push(value);
        Ok(())
    };
    let run = relay(
        ToolKind::Delve,
        (BufReader::new(receive), BrokenWriter(Some(observed))),
        &mut outgoing,
        &mut cancel,
        wait,
        &mut emit,
    );
    let feed = async {
        peer.write_all(b"Content-Length: 7\r\n\r\n{\"x\":")
            .await
            .unwrap();
        input.send("{}".into()).await.unwrap();
        failed.await.unwrap();
        peer.write_all(b"1}").await.unwrap();
        drop(peer);
    };
    let (end, _) = timeout(Duration::from_secs(2), async { tokio::join!(run, feed) })
        .await
        .unwrap();
    assert_eq!(messages, [serde_json::json!({"x": 1})]);
    assert_eq!(end.reason, "fixture writer closed");
    assert!(!end.reaped);
}

#[tokio::test]
async fn cancellation_interrupts_a_drain_between_ready_frames() {
    let mut reader = b"Content-Length: 2\r\n\r\n{}Content-Length: 2\r\n\r\n{}".as_slice();
    let (_input, mut outgoing) = mpsc::channel(1);
    let (stop, mut cancel) = oneshot::channel();
    let mut stop = Some(stop);
    let wait = std::future::ready(Ok(ExitStatus::from_raw(0)));
    tokio::pin!(wait);
    let mut delivered = 0;
    let end = relay(
        ToolKind::Delve,
        (&mut reader, async_io::sink()),
        &mut outgoing,
        &mut cancel,
        wait,
        &mut |_| {
            delivered += 1;
            if let Some(stop) = stop.take() {
                stop.send(()).unwrap();
            }
            Ok(())
        },
    )
    .await;
    assert_eq!(end.reason, "Debug session stopped");
    assert_eq!(delivered, 1);
    assert!(end.reaped);
}

#[tokio::test]
async fn exhausted_drain_does_not_wait_for_an_open_reader() {
    let (_inherited, receive) = async_io::duplex(1);
    let (_input, mut outgoing) = mpsc::channel(1);
    let (_stop, mut cancel) = oneshot::channel();
    let wait = std::future::ready(Ok(ExitStatus::from_raw(0)));
    tokio::pin!(wait);
    let start = Instant::now();
    let end = timeout(
        Duration::from_secs(2),
        relay(
            ToolKind::Delve,
            (BufReader::new(receive), async_io::sink()),
            &mut outgoing,
            &mut cancel,
            wait,
            &mut |_| panic!("a dangling reader produces no messages"),
        ),
    )
    .await
    .unwrap();
    assert!(start.elapsed() >= DRAIN_LIMIT && end.reaped);
}

fn child(command: &str, args: &[&str]) -> (u32, OwnedChild) {
    let process = Command::new(command)
        .args(args)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    (process.id().unwrap(), OwnedChild::new(process))
}

fn assert_reaped(pid: u32) {
    // SAFETY: this PID belongs to the test's own disposable child. No
    // pointer is supplied for the optional status output.
    assert_eq!(
        unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), libc::WNOHANG) },
        -1
    );
    assert_eq!(
        io::Error::last_os_error().raw_os_error(),
        Some(libc::ECHILD)
    );
}

#[tokio::test]
async fn stop_before_connect_kills_and_reaps_the_child() {
    let (pid, child) = child("/bin/sleep", &["30"]);
    let (_send, outgoing) = mpsc::channel(1);
    let (stop, cancel) = oneshot::channel();
    stop.send(()).unwrap();
    let reason = timeout(
        Duration::from_secs(2),
        supervise(
            ToolKind::Delve,
            child,
            pending::<CommandResult<(Empty, Sink)>>(),
            outgoing,
            cancel,
            |_| unreachable!(),
        ),
    )
    .await
    .unwrap();
    assert_eq!(reason, "Debug session stopped");
    assert_reaped(pid);
}

#[tokio::test]
async fn early_child_exit_and_live_child_disconnect_are_distinct() {
    let (early_pid, early) = child("/bin/sh", &["-c", "exit 7"]);
    let (_send, outgoing) = mpsc::channel(1);
    let (_stop, cancel) = oneshot::channel();
    let reason = timeout(
        Duration::from_secs(2),
        supervise(
            ToolKind::Delve,
            early,
            pending::<CommandResult<(Empty, Sink)>>(),
            outgoing,
            cancel,
            |_| unreachable!(),
        ),
    )
    .await
    .unwrap();
    assert!(reason.starts_with("Delve stopped before connecting:"));
    assert_reaped(early_pid);

    let (live_pid, live) = child("/bin/sleep", &["30"]);
    let (_send, outgoing) = mpsc::channel(1);
    let (_stop, cancel) = oneshot::channel();
    let reason = timeout(
        Duration::from_secs(2),
        supervise(
            ToolKind::Delve,
            live,
            std::future::ready(Ok((async_io::empty(), async_io::sink()))),
            outgoing,
            cancel,
            |_| unreachable!(),
        ),
    )
    .await
    .unwrap();
    assert_eq!(reason, "Delve disconnected");
    assert_reaped(live_pid);
}

#[test]
fn obsolete_worker_notifies_only_its_original_channel() {
    let (input, _) = mpsc::channel(1);
    let mut slot = Some(RunningServer {
        id: 2,
        input,
        stop: None,
        group: ProcessGroup::unarmed(),
    });
    let (replaced, old) = std::sync::mpsc::channel();
    let (_current, new) = std::sync::mpsc::channel::<ServerEvent>();
    finish(
        "obsolete".into(),
        || retire(&mut slot, 1),
        |event| replaced.send(event).unwrap(),
    );
    assert!(
        matches!(old.try_recv().unwrap(), ServerEvent::Closed { reason } if reason == "obsolete")
    );
    assert!(old.try_recv().is_err() && new.try_recv().is_err());
    assert_eq!(slot.as_ref().unwrap().id, 2);
    retire(&mut slot, 2);
    assert!(slot.is_none());
}
