use std::{
    fs::File,
    future::{poll_fn, Future},
    io,
    os::fd::AsRawFd,
    process::ExitStatus,
    sync::{Arc, Mutex},
    task::Poll,
    time::Duration,
};

use tokio::process::{Child, Command};

pub(crate) fn bind_child_directory(command: &mut Command, directory: File) {
    // The captured File stays open until exec. Only fchdir is called in the child.
    unsafe {
        command.pre_exec(move || {
            if libc::fchdir(directory.as_raw_fd()) == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });
    }
    command.env_remove("PWD");
}

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

    #[cfg(test)]
    pub(crate) fn armed(&self) -> bool {
        self.0.lock().unwrap().is_some()
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
        Self::in_group(child, pid)
    }

    pub(crate) fn in_group(child: Child, group: i32) -> Self {
        // The freshly spawned child is a member of this group and remains
        // unreaped while its owner can signal the group.
        Self {
            child,
            group: Arc::new(ProcessGroup(Mutex::new(Some(group)))),
        }
    }

    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        let wait = self.child.wait();
        tokio::pin!(wait);
        poll_fn(|cx| self.group.poll_reap(|| wait.as_mut().poll(cx))).await
    }

    pub(crate) async fn wait_and_retire_group(&mut self) -> io::Result<ExitStatus> {
        let pid = self.child.id().expect("owned process has not been reaped");
        while !exited_without_reaping(pid)? {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        self.group.kill();
        self.wait().await
    }
}

pub(crate) fn exited_without_reaping(pid: u32) -> io::Result<bool> {
    // The unreaped leader keeps the group ID reserved until we signal it.
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid,
                &mut info,
                libc::WEXITED | libc::WNOWAIT | libc::WNOHANG,
            )
        };
        if result == 0 {
            return Ok(unsafe { info.si_pid() } != 0);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
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
