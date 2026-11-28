use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    io::{self, Read, Write},
    os::fd::{AsRawFd, FromRawFd},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tokio::{
    io::unix::AsyncFd,
    process::Command,
    sync::{mpsc, oneshot, watch},
};

use crate::{
    debug_program::ProcessStamp,
    go_launch::{prepare_build, verify_handoff, PreparedBinary},
    process_owner::{bind_child_directory, exited_without_reaping, OwnedChild},
    tasks::{spawn_child, supervise, RunLaunch, RunningTask, TaskEvent, MAX_OUTPUT},
    workspace::run_directory,
    CommandResult, Core, Session,
};

const CREDIT: usize = 64 * 1024;
const CHUNK: usize = 4096;
const INPUT: usize = 8192;
const FRAME_LIMIT: usize = 32;
const HUP_GRACE: Duration = Duration::from_millis(300);
const BATCH: Duration = Duration::from_millis(10);
const SAMPLE: Duration = Duration::from_millis(25);
// Darwin's _IO('t', 95), confirmed against the macOS SDK and a real PTY.
const TIOCSIG: libc::c_ulong = 0x2000745f;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Launch {
    Shell,
    Go { package: String, launch: RunLaunch },
}

#[derive(Clone, Copy, Deserialize)]
pub struct Size {
    cols: u16,
    rows: u16,
}

impl Size {
    fn validate(self) -> CommandResult<Self> {
        if !(2..=500).contains(&self.cols) || !(2..=300).contains(&self.rows) {
            return Err("The terminal size is outside its supported range.".into());
        }
        Ok(self)
    }
    fn native(self) -> libc::winsize {
        libc::winsize {
            ws_row: self.rows,
            ws_col: self.cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Ready {
        id: u64,
    },
    Output {
        id: u64,
        sequence: u64,
        bytes: Vec<u8>,
    },
    Build {
        id: u64,
        event: TaskEvent,
    },
    Cleanup {
        id: u64,
        reason: String,
    },
    Closed {
        id: u64,
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Cleanup {
    Live,
    Retiring,
    Unconfirmed { reason: String, retryable: bool },
    Retired,
}

pub(crate) struct Owner {
    id: u64,
    pub(crate) go: bool,
    stop: watch::Sender<u64>,
    done: watch::Sender<Cleanup>,
    input: mpsc::Sender<Vec<u8>>,
    ack: mpsc::Sender<u64>,
    size: watch::Sender<Size>,
    #[cfg(feature = "e2e")]
    observed: TestProbe,
}

struct Streams {
    stop: watch::Receiver<u64>,
    input: mpsc::Receiver<Vec<u8>>,
    ack: mpsc::Receiver<u64>,
    size: watch::Receiver<Size>,
    #[cfg(feature = "e2e")]
    observed: TestProbe,
}

#[cfg(feature = "e2e")]
type TestProbe = std::sync::Arc<std::sync::Mutex<TestSample>>;

#[cfg(feature = "e2e")]
#[derive(Clone, Default, Serialize)]
pub struct TestSample {
    leader: i32,
    foreground: Vec<i32>,
    cols: u16,
    rows: u16,
    credit: usize,
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn test_terminal_observation(state: State<'_, Core>) -> Option<TestSample> {
    let session = state.0.lock().unwrap();
    session
        .terminal
        .as_ref()
        .map(|terminal| terminal.observed.lock().unwrap().clone())
}

impl Owner {
    fn new(id: u64, go: bool, size: Size) -> (Self, Streams) {
        let (stop, stop_rx) = watch::channel(0);
        // Three queued chunks and the chunk being written share 32 KiB.
        let (input, input_rx) = mpsc::channel(3);
        let (ack, ack_rx) = mpsc::channel(FRAME_LIMIT);
        let (size, size_rx) = watch::channel(size);
        #[cfg(feature = "e2e")]
        let observed = TestProbe::default();
        (
            Self {
                id,
                go,
                stop,
                done: watch::channel(Cleanup::Live).0,
                input,
                ack,
                size,
                #[cfg(feature = "e2e")]
                observed: observed.clone(),
            },
            Streams {
                stop: stop_rx,
                input: input_rx,
                ack: ack_rx,
                size: size_rx,
                #[cfg(feature = "e2e")]
                observed,
            },
        )
    }
}

impl Session {
    pub(crate) fn terminal_go(&self) -> bool {
        self.terminal.as_ref().is_some_and(|owner| owner.go)
    }

    fn ack_terminal(&self, terminal: u64, sequence: u64) {
        if let Ok(owner) = check_owner(self, terminal) {
            let _ = owner.ack.try_send(sequence);
        }
    }

    pub(crate) fn request_terminal_stop(
        &mut self,
        id: Option<u64>,
    ) -> Option<watch::Receiver<Cleanup>> {
        let owner = self
            .terminal
            .as_ref()
            .filter(|owner| id.is_none_or(|id| id == owner.id))?;
        let request = match *owner.done.borrow() {
            Cleanup::Live
            | Cleanup::Unconfirmed {
                retryable: true, ..
            } => true,
            _ => false,
        };
        if request {
            owner.done.send_replace(Cleanup::Retiring);
            owner.stop.send_modify(|attempt| *attempt += 1);
        }
        if let Some(task) = self.task.as_mut().filter(|task| task.id == owner.id) {
            task.cancel();
        }
        Some(owner.done.subscribe())
    }
}

pub(crate) fn begin_cutover(
    app: &AppHandle,
    ticket: Option<u64>,
) -> CommandResult<crate::workspace_admission::Lease> {
    let core = app.state::<Core>();
    let mut session = core.0.lock().unwrap();
    if ticket.is_some_and(|ticket| !crate::quit::live_ticket(app, ticket)) {
        return Err("The Quit decision expired before the terminal could close.".into());
    }
    crate::workspace_admission::Lease::begin(
        app,
        &mut session,
        ticket.map_or(
            crate::workspace_admission::Kind::Cutover,
            crate::workspace_admission::Kind::Quit,
        ),
    )
}

pub(crate) async fn retire_for_cutover(
    app: &AppHandle,
    lease: &crate::workspace_admission::Lease,
    ticket: Option<u64>,
) -> CommandResult<()> {
    let done = {
        let core = app.state::<Core>();
        let mut session = core.0.lock().unwrap();
        if ticket.is_some_and(|ticket| !crate::quit::live_ticket(app, ticket)) {
            return Err("The Quit decision expired before the terminal could close.".into());
        }
        lease.begin_teardown(&mut session)?;
        session.request_terminal_stop(None)
    };
    wait_cleanup(done).await
}

pub(crate) async fn fence_cutover(
    app: &AppHandle,
    ticket: Option<u64>,
) -> CommandResult<crate::workspace_admission::Lease> {
    let fence = begin_cutover(app, ticket)?;
    retire_for_cutover(app, &fence, ticket).await?;
    Ok(fence)
}

async fn wait_stop(core: &Core, id: Option<u64>) -> CommandResult<()> {
    let done = core.0.lock().unwrap().request_terminal_stop(id);
    wait_cleanup(done).await
}

async fn wait_cleanup(done: Option<watch::Receiver<Cleanup>>) -> CommandResult<()> {
    if let Some(mut done) = done {
        let terminal = tokio::time::timeout(Duration::from_secs(5), done.wait_for(|status| {
            matches!(status, Cleanup::Retired | Cleanup::Unconfirmed { .. })
        })).await
            .map_err(|_| "Terminal cleanup could not be confirmed. The terminal is still tracked; try Close Terminal again.".to_owned())?
            .map_err(|_| "The native terminal closed without proving process cleanup.".to_owned())?;
        if let Cleanup::Unconfirmed { reason, .. } = &*terminal {
            return Err(reason.clone());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_terminal(state: State<'_, Core>, terminal: u64) -> CommandResult<()> {
    wait_stop(&state, Some(terminal)).await
}

fn check_owner(session: &Session, terminal: u64) -> CommandResult<&Owner> {
    session
        .terminal
        .as_ref()
        .filter(|owner| owner.id == terminal)
        .ok_or_else(|| "This terminal is no longer active.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_reap_retry_resamples_the_foreground_before_signaling_again() {
        use std::{
            cell::{Cell, RefCell},
            future::ready,
        };

        let (request, mut stop) = watch::channel(1);
        let current_group = Cell::new(1);
        let trace = RefCell::new(Vec::new());
        let mut foreground = Foreground::default();
        let mut proof = std::pin::pin!(wait_for_cleanup_proof(
            &mut foreground,
            &mut stop,
            |_| trace.borrow_mut().push(("sample", current_group.get())),
            |_| trace.borrow_mut().push(("kill", current_group.get())),
            false,
            |waited| ready((
                true,
                if waited {
                    Ok(())
                } else {
                    Err(("transient wait failure".into(), true))
                },
            )),
            |status| if matches!(status, Cleanup::Unconfirmed { .. }) {
                trace
                    .borrow_mut()
                    .push(("unconfirmed", current_group.get()));
            },
        ));
        tokio::select! {
            biased;
            _ = &mut proof => panic!("a failed reap must not release the terminal"),
            () = ready(()) => {},
        }
        current_group.set(2);
        request.send_replace(2);
        proof.await;
        assert_eq!(
            *trace.borrow(),
            [
                ("sample", 1),
                ("kill", 1),
                ("unconfirmed", 1),
                ("sample", 2),
                ("kill", 2)
            ]
        );
    }

    #[test]
    fn incomplete_foreground_enumeration_requires_the_master_to_remain_available() {
        let mut foreground = Foreground::default();
        assert!(!foreground.needs_resample());
        foreground.uncertain.insert(7);
        assert!(foreground.needs_resample());
        foreground.uncertain.clear();
        foreground.missing_observation = true;
        assert!(foreground.needs_resample());
    }

    #[test]
    fn stale_requests_do_not_stop_or_credit_the_replacement_terminal() {
        let (owner, mut streams) = Owner::new(2, false, Size { cols: 80, rows: 24 });
        let mut session = Session {
            terminal: Some(owner),
            ..Session::default()
        };

        assert!(session.request_terminal_stop(Some(1)).is_none());
        session.ack_terminal(1, 12);
        assert_eq!(*streams.stop.borrow(), 0);
        assert!(matches!(
            streams.ack.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));

        session.ack_terminal(2, 13);
        assert_eq!(streams.ack.try_recv().unwrap(), 13);
        let done = session.request_terminal_stop(Some(2)).unwrap();
        assert_eq!(*streams.stop.borrow(), 1);
        assert_eq!(*done.borrow(), Cleanup::Retiring);
        assert_eq!(check_owner(&session, 2).unwrap().id, 2);
    }

    #[tokio::test]
    async fn stop_waits_for_an_explicit_cleanup_confirmation() {
        let (owner, streams) = Owner::new(2, false, Size { cols: 80, rows: 24 });
        let core = Core::default();
        core.0.lock().unwrap().terminal = Some(owner);
        let mut wait = std::pin::pin!(wait_stop(&core, Some(2)));
        tokio::select! {
            biased;
            result = &mut wait => panic!("Stop completed before cleanup: {result:?}"),
            () = std::future::ready(()) => {}
        }
        assert_eq!(*streams.stop.borrow(), 1);
        let owner = core.0.lock().unwrap().terminal.take().unwrap();
        owner.done.send_replace(Cleanup::Retired);
        assert!(wait.await.is_ok());
    }

    #[tokio::test]
    async fn dropping_the_cleanup_sender_is_not_confirmation() {
        let (owner, streams) = Owner::new(2, false, Size { cols: 80, rows: 24 });
        let core = Core::default();
        core.0.lock().unwrap().terminal = Some(owner);
        let mut wait = std::pin::pin!(wait_stop(&core, Some(2)));
        tokio::select! {
            biased;
            result = &mut wait => panic!("Stop completed before cleanup: {result:?}"),
            () = std::future::ready(()) => {}
        }
        assert_eq!(*streams.stop.borrow(), 1);
        drop(core.0.lock().unwrap().terminal.take());
        assert_eq!(
            wait.await.unwrap_err(),
            "The native terminal closed without proving process cleanup."
        );
    }

    #[tokio::test]
    async fn unconfirmed_cleanup_rejects_stop_and_retains_the_same_owner_for_retry() {
        let (owner, mut streams) = Owner::new(2, true, Size { cols: 80, rows: 24 });
        let core = Core::default();
        core.0.lock().unwrap().terminal = Some(owner);
        let mut first = std::pin::pin!(wait_stop(&core, Some(2)));
        tokio::select! {
            biased;
            result = &mut first => panic!("Stop completed before cleanup: {result:?}"),
            () = std::future::ready(()) => {}
        }
        assert_eq!(*streams.stop.borrow_and_update(), 1);
        check_owner(&core.0.lock().unwrap(), 2)
            .unwrap()
            .done
            .send_replace(Cleanup::Unconfirmed {
                reason: "The foreground could not be observed.".into(),
                retryable: true,
            });
        assert_eq!(
            first.await.unwrap_err(),
            "The foreground could not be observed."
        );
        assert!(core.0.lock().unwrap().terminal_go());

        let mut retry = std::pin::pin!(wait_stop(&core, Some(2)));
        tokio::select! {
            biased;
            result = &mut retry => panic!("Retry completed before cleanup: {result:?}"),
            () = std::future::ready(()) => {}
        }
        assert_eq!(*streams.stop.borrow(), 2);
        assert_eq!(
            *check_owner(&core.0.lock().unwrap(), 2)
                .unwrap()
                .done
                .borrow(),
            Cleanup::Retiring
        );
        let owner = core.0.lock().unwrap().terminal.take().unwrap();
        owner.done.send_replace(Cleanup::Retired);
        assert!(retry.await.is_ok());
    }
}

#[tauri::command]
pub fn terminal_input(state: State<'_, Core>, terminal: u64, text: String) -> CommandResult<()> {
    if text.len() > INPUT {
        return Err("The terminal input chunk exceeds its limit.".into());
    }
    let session = state.0.lock().unwrap();
    let owner = check_owner(&session, terminal)?;
    if *owner.done.borrow() != Cleanup::Live {
        return Err("The terminal is retiring and no longer accepts input.".into());
    }
    owner
        .input
        .try_send(text.into_bytes())
        .map_err(|_| "The terminal input queue is full or closed.".into())
}

#[tauri::command]
pub fn terminal_ack(state: State<'_, Core>, terminal: u64, sequence: u64) {
    state.0.lock().unwrap().ack_terminal(terminal, sequence);
}

#[tauri::command]
pub fn terminal_resize(state: State<'_, Core>, terminal: u64, size: Size) -> CommandResult<()> {
    check_owner(&state.0.lock().unwrap(), terminal)?
        .size
        .send_replace(size.validate()?);
    Ok(())
}

#[tauri::command]
pub async fn start_terminal(
    app: AppHandle,
    state: State<'_, Core>,
    id: u64,
    launch: Launch,
    size: Size,
    events: Channel<Event>,
) -> CommandResult<u64> {
    let size = size.validate()?;
    let mut session = state.0.lock().unwrap();
    session.root(id)?;
    if session.terminal.is_some() || session.cutover_pending() {
        return Err("Close the previous terminal before starting another.".into());
    }
    let terminal = session.next_id();
    let (owner, streams) = Owner::new(terminal, !matches!(launch, Launch::Shell), size);
    match launch {
        Launch::Shell => {
            let workspace = session.workspace.as_ref().unwrap();
            let mut command = shell();
            bind_child_directory(&mut command, run_directory(workspace, ".")?);
            let pty = Pty::spawn(&mut command, size)?;
            session.terminal = Some(owner);
            tauri::async_runtime::spawn(async move {
                let reason = run(&app, terminal, pty, streams, &events).await;
                finish(&app, terminal, reason, events);
            });
        }
        Launch::Go { package, launch } => {
            if session.go_busy() || session.workspace_busy() {
                return Err("A Go task or debug session is already running.".into());
            }
            let workspace = session.workspace.as_ref().unwrap();
            let (
                PreparedBinary {
                    directory,
                    binary,
                    working,
                },
                mut go,
            ) = prepare_build(
                workspace,
                &package,
                &launch,
                || {
                    tempfile::Builder::new()
                        .prefix("iron-go-terminal-")
                        .tempdir()
                        .map_err(|error| error.to_string())
                },
                "program",
                &[],
            )?;
            let child = spawn_child(&mut go)
                .map_err(|error| format!("Start terminal Go build: {error}"))?;
            let (send, mut stop) = oneshot::channel();
            #[cfg(feature = "e2e")]
            let handoff = session.acceptance.run_handoff.clone();
            session
                .run_directories
                .insert(terminal, directory.path().to_owned());
            session.task = Some(RunningTask {
                id: terminal,
                stop: Some(send),
                group: Some(child.group.clone()),
            });
            session.terminal = Some(owner);
            tauri::async_runtime::spawn(async move {
                let emit = |event| {
                    let _ = events.send(Event::Build {
                        id: terminal,
                        event,
                    });
                };
                emit(TaskEvent::Started {
                    command: format!("Build Go package {package} for the terminal"),
                    structured_tests: false,
                });
                let mut budget = MAX_OUTPUT;
                let built = supervise(child, &mut stop, &mut budget, emit).await;
                let reason = if matches!(built, TaskEvent::Finished { success: true, .. }) {
                    #[cfg(feature = "e2e")]
                    let proceed = handoff.wait(directory.path(), &mut stop).await;
                    #[cfg(not(feature = "e2e"))]
                    let proceed = true;
                    if proceed {
                        let size = *streams.size.borrow();
                        match admit_program(
                            app.state::<Core>().inner(),
                            id,
                            terminal,
                            &binary,
                            working,
                            launch,
                            size,
                        ) {
                            Ok(Some(pty)) => run(&app, terminal, pty, streams, &events).await,
                            Ok(None) => "Terminal stopped".into(),
                            Err(error) => error,
                        }
                    } else {
                        "Terminal stopped".into()
                    }
                } else if matches!(
                    built,
                    TaskEvent::Finished {
                        cancelled: true,
                        ..
                    }
                ) {
                    "Terminal stopped".into()
                } else {
                    "The Go build failed before the terminal program started.".into()
                };
                crate::debug_program::remove_directory(directory).await;
                finish(&app, terminal, reason, events);
            });
        }
    }
    Ok(terminal)
}

fn finish(app: &AppHandle, terminal: u64, reason: String, events: Channel<Event>) {
    let core = app.state::<Core>();
    let mut session = core.0.lock().unwrap();
    if session
        .task
        .as_ref()
        .is_some_and(|task| task.id == terminal)
    {
        session.task.take();
    }
    session.run_directories.remove(&terminal);
    if session
        .terminal
        .as_ref()
        .is_some_and(|owner| owner.id == terminal)
    {
        let owner = session.terminal.take().unwrap();
        owner.done.send_replace(Cleanup::Retired);
    }
    #[cfg(feature = "e2e")]
    core.2.notify_all();
    drop(session);
    let _ = events.send(Event::Closed {
        id: terminal,
        reason,
    });
}

fn shell() -> Command {
    let chosen = std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_file());
    #[cfg(feature = "e2e")]
    if std::env::var_os("IRON_GO_E2E_WORKSPACE").is_some() {
        let mut command = Command::new("/bin/zsh");
        command.args(["-f", "-i"]);
        return command;
    }
    let mut command = Command::new(chosen.unwrap_or_else(|| PathBuf::from("/bin/zsh")));
    command.args(["-l", "-i"]);
    command
}

fn admit_program(
    core: &Core,
    workspace_id: u64,
    terminal: u64,
    binary: &Path,
    cwd: File,
    launch: RunLaunch,
    size: Size,
) -> CommandResult<Option<Pty>> {
    let mut session = core.0.lock().unwrap();
    if session.root(workspace_id).is_err()
        || session.cutover_tearing_down()
        || !check_owner(&session, terminal).is_ok_and(|owner| *owner.done.borrow() == Cleanup::Live)
    {
        return Ok(None);
    }
    if !session
        .task
        .as_ref()
        .is_some_and(|task| task.id == terminal && task.stop.is_some())
    {
        return Ok(None);
    }
    verify_handoff(
        session.workspace.as_ref().unwrap(),
        &launch.directory,
        &cwd,
        binary,
    )?;
    let mut command = Command::new(binary);
    command.args(launch.args).envs(launch.environment);
    bind_child_directory(&mut command, cwd);
    let pty = Pty::spawn(&mut command, size)?;
    session.task.take();
    Ok(Some(pty))
}

struct Pty {
    master: AsyncFd<File>,
    child: OwnedChild,
}

impl Pty {
    fn spawn(command: &mut Command, size: Size) -> CommandResult<Self> {
        let mut make = || -> io::Result<Self> {
            let (mut master, mut slave) = (-1, -1);
            let mut winsize = size.native();
            if unsafe {
                libc::openpty(
                    &mut master,
                    &mut slave,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut winsize,
                )
            } != 0
            {
                return Err(io::Error::last_os_error());
            }
            let master = unsafe { File::from_raw_fd(master) };
            let slave = unsafe { File::from_raw_fd(slave) };
            for file in [&master, &slave] {
                if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
                    return Err(io::Error::last_os_error());
                }
            }
            if unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) } == -1 {
                return Err(io::Error::last_os_error());
            }
            // The owned File keeps this distinct, nonblocking descriptor
            // open until after AsyncFd deregisters it.
            let master = unsafe { AsyncFd::register(master) }?;
            // Stdio is installed before pre_exec; fd 0 refers to the slave.
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() == -1
                        || libc::ioctl(libc::STDIN_FILENO, libc::TIOCSCTTY.into(), 0) == -1
                    {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let child = command
                .env("TERM", "xterm-256color")
                .env("COLORTERM", "truecolor")
                .stdin(Stdio::from(slave.try_clone()?))
                .stdout(Stdio::from(slave.try_clone()?))
                .stderr(Stdio::from(slave))
                .kill_on_drop(true)
                .spawn()?;
            Ok(Self {
                master,
                child: OwnedChild::new(child),
            })
        };
        make().map_err(|error| format!("Start native terminal: {error}"))
    }
}

async fn read(master: &AsyncFd<File>, bytes: &mut [u8]) -> io::Result<usize> {
    loop {
        let mut ready = master.readable().await?;
        if let Ok(result) = ready.try_io(|fd| {
            let mut file = fd.get_ref();
            let mut used = file.read(bytes)?;
            if used == 0 {
                return Ok(0);
            }
            // Darwin can return short reads even during a continuous burst.
            // Coalesce bytes already ready without ever holding up input.
            while used < bytes.len() {
                match file.read(&mut bytes[used..]) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => used += count,
                }
            }
            Ok(used)
        }) {
            return result;
        }
    }
}

async fn write(master: &AsyncFd<File>, input: &mut mpsc::Receiver<Vec<u8>>) -> io::Result<()> {
    while let Some(bytes) = input.recv().await {
        let mut pending = bytes.as_slice();
        while !pending.is_empty() {
            let mut ready = master.writable().await?;
            if let Ok(result) = ready.try_io(|fd| fd.get_ref().write(pending)) {
                let count = result?;
                if count == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "The PTY stopped accepting input.",
                    ));
                }
                pending = &pending[count..];
            }
        }
    }
    Ok(())
}

#[derive(Default)]
struct Foreground {
    seen: HashMap<i32, ProcessStamp>,
    uncertain: HashSet<i32>,
    missing_observation: bool,
}

impl Foreground {
    fn needs_resample(&self) -> bool {
        self.missing_observation || !self.uncertain.is_empty()
    }

    fn sample(&mut self, master: i32) {
        self.seen.retain(|_, process| !process.confirmed_gone());
        self.uncertain.retain(|group| !confirmed_absent(-*group));
        let group = unsafe { libc::tcgetpgrp(master) };
        if group < 0 {
            self.missing_observation = true;
            return;
        }
        self.missing_observation = false;
        if group == 0 {
            return;
        }
        let mut pids = [0i32; 256];
        let bytes = unsafe {
            libc::proc_listpids(
                2,
                group as u32,
                pids.as_mut_ptr().cast(),
                std::mem::size_of_val(&pids) as i32,
            )
        };
        if bytes <= 0 || bytes as usize >= std::mem::size_of_val(&pids) {
            self.uncertain.insert(group);
            return;
        }
        self.uncertain.remove(&group);
        for &pid in &pids[..bytes as usize / std::mem::size_of::<i32>()] {
            if pid <= 0 || self.seen.contains_key(&pid) {
                continue;
            }
            if let Some(process) = ProcessStamp::of(pid) {
                self.seen.insert(pid, process);
            } else if !confirmed_absent(pid) {
                self.uncertain.insert(group);
            }
        }
    }

    fn unresolved(&self, leader: i32) -> bool {
        self.missing_observation
            || self.uncertain.iter().any(|group| !confirmed_absent(-group))
            || self
                .seen
                .iter()
                .any(|(pid, process)| *pid != leader && !process.confirmed_gone())
    }
}

fn confirmed_absent(pid_or_group: i32) -> bool {
    unsafe {
        libc::kill(pid_or_group, 0) != 0
            && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
}

fn send_foreground(master: i32, signal: i32) {
    // The ioctl selects the foreground group under the kernel's tty lock.
    // We never send a real signal to a process ID obtained by observation.
    unsafe { libc::ioctl(master, TIOCSIG, signal) };
}

async fn run(
    app: &AppHandle,
    terminal: u64,
    pty: Pty,
    mut streams: Streams,
    events: &Channel<Event>,
) -> String {
    let master = pty.master.get_ref().as_raw_fd();
    let child = pty.child;
    let leader = child.child.id().expect("PTY child is not reaped") as i32;
    let mut foreground = Foreground::default();
    let mut outstanding = BTreeMap::<u64, usize>::new();
    let mut credit = CREDIT;
    let mut sequence = 0;
    let mut buffer = [0; CHUNK];
    let mut ticker = tokio::time::interval(SAMPLE);
    let mut reading = true;
    let mut exited = None;
    let mut pending = 0;
    let mut flush_at = None;
    let _ = events.send(Event::Ready { id: terminal });
    let reason = {
        let writer = write(&pty.master, &mut streams.input);
        tokio::pin!(writer);
        loop {
            let limit = credit.min(CHUNK);
            let deadline = flush_at;
            let flush = async move {
                if let Some(deadline) = deadline {
                    tokio::time::sleep_until(deadline).await;
                } else {
                    std::future::pending::<()>().await;
                }
            };
            tokio::select! {
                biased;
                _ = streams.stop.wait_for(|stop| *stop != 0) => break "Terminal stopped".to_owned(),
                _ = ticker.tick() => {
                    let leader_exited = exited_without_reaping(leader as u32).unwrap_or(false);
                    foreground.sample(master);
                    #[cfg(feature = "e2e")]
                    {
                        let mut native = Size { cols: 0, rows: 0 }.native();
                        unsafe { libc::ioctl(master, libc::TIOCGWINSZ, &mut native) };
                        *streams.observed.lock().unwrap() = TestSample { leader, foreground: foreground.seen.keys().copied().collect(),
                            cols: native.ws_col, rows: native.ws_row, credit: credit - pending };
                    }
                    if leader_exited {
                        let deadline = *exited.get_or_insert_with(|| tokio::time::Instant::now() + HUP_GRACE);
                        if (!reading && pending == 0) || tokio::time::Instant::now() >= deadline { break "Terminal process exited".to_owned(); }
                    }
                }
                ack = streams.ack.recv() => if let Some(seq) = ack {
                    if let Some(bytes) = outstanding.remove(&seq) { credit += bytes; }
                },
                size = streams.size.changed() => if size.is_ok() {
                    let winsize = streams.size.borrow_and_update().native();
                    unsafe { libc::ioctl(master, libc::TIOCSWINSZ, &winsize) };
                },
                _ = flush => {
                    sequence += 1;
                    credit -= pending;
                    outstanding.insert(sequence, pending);
                    if events.send(Event::Output { id: terminal, sequence, bytes: buffer[..pending].to_vec() }).is_err() {
                        break "The terminal renderer disconnected".to_owned();
                    }
                    pending = 0;
                    flush_at = None;
                },
                result = read(&pty.master, &mut buffer[pending..limit]), if reading && pending < limit && outstanding.len() < FRAME_LIMIT => {
                    match result {
                        Ok(0) => reading = false,
                        Ok(count) => {
                            pending += count;
                            let now = tokio::time::Instant::now();
                            if pending == limit { flush_at = Some(now); }
                            else { flush_at.get_or_insert(now + BATCH); }
                        }
                        Err(error) if error.raw_os_error() == Some(libc::EIO) => reading = false,
                        Err(error) => break format!("Read terminal: {error}"),
                    }
                },
                result = &mut writer => break result.err().map_or_else(|| "Terminal input closed".into(), |error| format!("Write terminal: {error}")),
            }
        }
    };
    retire_pty(child, pty.master, foreground, &mut streams.stop, |status| {
        publish_cleanup(app, terminal, status, events);
    })
    .await;
    reason
}

fn publish_cleanup(app: &AppHandle, terminal: u64, status: Cleanup, events: &Channel<Event>) {
    let reason = match &status {
        Cleanup::Retiring => "Retiring terminal processes…".into(),
        Cleanup::Unconfirmed { reason, .. } => reason.clone(),
        _ => return,
    };
    let core = app.state::<Core>();
    {
        let session = core.0.lock().unwrap();
        let Ok(owner) = check_owner(&session, terminal) else {
            return;
        };
        owner.done.send_replace(status);
    }
    let _ = events.send(Event::Cleanup {
        id: terminal,
        reason,
    });
}

async fn retire_pty(
    child: OwnedChild,
    owned_master: AsyncFd<File>,
    mut foreground: Foreground,
    stop: &mut watch::Receiver<u64>,
    mut publish: impl FnMut(Cleanup),
) {
    let master = owned_master.get_ref().as_raw_fd();
    let leader = child.child.id().expect("PTY child is not reaped") as i32;
    publish(Cleanup::Retiring);
    foreground.sample(master);
    send_foreground(master, libc::SIGHUP);
    let deadline = tokio::time::Instant::now() + HUP_GRACE;
    while tokio::time::Instant::now() < deadline {
        if !foreground.unresolved(leader) && exited_without_reaping(leader as u32).unwrap_or(false)
        {
            break;
        }
        tokio::time::sleep(SAMPLE).await;
        foreground.sample(master);
    }
    let group = child.group.clone();
    wait_for_cleanup_proof(
        &mut foreground,
        stop,
        |foreground| foreground.sample(master),
        |reaped| {
            send_foreground(master, libc::SIGKILL);
            if !reaped {
                group.kill();
            }
        },
        child,
        |mut child| async move {
            let result = match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(error)) => Err((
                    format!("Could not reap the terminal leader: {error}"),
                    error.raw_os_error() != Some(libc::ECHILD),
                )),
                Err(_) => Err((
                    "The terminal leader did not exit within the cleanup wait.".into(),
                    true,
                )),
            };
            (child, result)
        },
        publish,
    )
    .await;
    drop(owned_master);
    // Recorded process identities remain observable after the PTY is closed.
    while foreground.unresolved(leader) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_for_cleanup_proof<Child, Reap>(
    foreground: &mut Foreground,
    stop: &mut watch::Receiver<u64>,
    mut sample: impl FnMut(&mut Foreground),
    mut kill: impl FnMut(bool),
    mut child: Child,
    mut reap: impl FnMut(Child) -> Reap,
    mut publish: impl FnMut(Cleanup),
) where
    Reap: std::future::Future<Output = (Child, Result<(), (String, bool)>)>,
{
    let mut reaped = false;
    loop {
        let attempt = *stop.borrow_and_update();
        // The PTY may have acquired a different foreground group since a
        // failed reap parked this worker. Renew evidence before every signal.
        sample(foreground);
        kill(reaped);
        let wait_error = if reaped {
            None
        } else {
            let (owned, result) = reap(child).await;
            child = owned;
            match result {
                Ok(()) => {
                    reaped = true;
                    None
                }
                Err(error) => Some(error),
            }
        };
        foreground
            .uncertain
            .retain(|group| !confirmed_absent(-*group));
        let unconfirmed = wait_error.or_else(|| {
            foreground.needs_resample().then(|| {
                (
                    "The terminal foreground could not be observed; try Close Terminal again."
                        .into(),
                    true,
                )
            })
        });
        let Some((reason, retryable)) = unconfirmed else {
            break;
        };
        publish(Cleanup::Unconfirmed { reason, retryable });
        if !retryable {
            // No timer can change this result. Keep the owner reserved until shutdown.
            std::future::pending::<()>().await;
        }
        let retry = tokio::select! {
            result = stop.wait_for(|requested| *requested != attempt) => result.is_ok(),
            () = async {
                while foreground.uncertain.iter().any(|group| !confirmed_absent(-group)) {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }, if reaped && !foreground.missing_observation && !foreground.uncertain.is_empty() => {
                foreground.uncertain.clear();
                // There is no new signal in this path. All uncertain groups
                // disappeared; the caller will wait on the recorded stamps.
                break;
            }
        };
        if !retry {
            std::future::pending::<()>().await;
        }
        publish(Cleanup::Retiring);
    }
}
