use std::{
    future::{poll_fn, Future},
    io,
    process::ExitStatus,
    sync::{Arc, Mutex},
    task::Poll,
};

use tokio::process::Child;

// Serialize the signal syscall with the poll that can reap the leader.
pub struct ProcessGroup(Mutex<Option<i32>>);

impl ProcessGroup {
    fn signal_with(&self, signal: impl FnOnce(i32)) {
        let mut group = self.0.lock().unwrap();
        if let Some(pid) = group.take() {
            signal(pid);
        }
    }

    pub fn kill(&self) {
        self.signal_with(|pid| {
            // SAFETY: this is the group of an owned, unreaped leader. The
            // mutex is held through the syscall, not just the ID claim.
            unsafe { libc::kill(-pid, libc::SIGKILL) };
        });
    }

    fn poll_reap(
        &self,
        poll: impl FnOnce() -> Poll<io::Result<ExitStatus>>,
    ) -> Poll<io::Result<ExitStatus>> {
        let mut group = self.0.lock().unwrap();
        let result = poll();
        if matches!(result, Poll::Ready(Ok(_))) {
            *group = None;
        }
        result
    }

    #[cfg(test)]
    pub(crate) fn unarmed() -> Arc<Self> {
        Arc::new(Self(Mutex::new(None)))
    }
}

pub struct OwnedChild {
    pub child: Child,
    pub group: Arc<ProcessGroup>,
}

impl OwnedChild {
    // The caller must spawn this child as the leader of its own group.
    pub fn new(child: Child) -> Self {
        let pid = child.id().expect("new group child has a pid") as i32;
        Self {
            child,
            group: Arc::new(ProcessGroup(Mutex::new(Some(pid)))),
        }
    }

    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        let wait = self.child.wait();
        tokio::pin!(wait);
        poll_fn(|cx| self.group.poll_reap(|| wait.as_mut().poll(cx))).await
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        // Tokio's Child destructor may reap or hand off reaping. Disarm by
        // signaling first, even if the worker future was never polled.
        self.group.kill();
    }
}

#[cfg(test)]
#[test]
fn a_competing_signal_cannot_use_an_id_after_the_reap_poll() {
    use std::{os::unix::process::ExitStatusExt, sync::mpsc::channel, thread};
    // Synthetic ID: no signals are sent to any OS process by this test.
    let group = ProcessGroup(Mutex::new(Some(7)));
    let (entered, wait) = channel();
    let (release, proceed) = channel();
    thread::scope(|scope| {
        let reap = scope.spawn(|| {
            group.poll_reap(move || {
                entered.send(()).unwrap();
                proceed.recv().unwrap();
                Poll::Ready(Ok(ExitStatus::from_raw(0)))
            })
        });
        wait.recv().unwrap();
        let locked = group.0.try_lock().is_err();
        let stop =
            scope.spawn(|| group.signal_with(|_| panic!("would signal a reused process-group ID")));
        release.send(()).unwrap();
        assert!(locked, "wait may reap only under the group lock");
        assert!(matches!(reap.join().unwrap(), Poll::Ready(Ok(_))));
        stop.join().unwrap();
    });
}
