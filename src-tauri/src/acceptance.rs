use std::{io, time::Duration};

use crate::{CommandResult, Core, Session};
use tauri::{AppHandle, Manager};
#[cfg(test)]
use {crate::tools::short_output, tokio::process::Command};

#[derive(Default)]
pub struct Admission {
    sealed: bool,
    short_tools: usize,
    unproved_exit: bool,
    pub cancel_next_picker: bool,
    pub run_handoff: std::sync::Arc<crate::tasks::TestRunHandoff>,
    pub hold_debug_disconnect: bool,
    pub draft_quit: std::sync::Arc<TestDraftQuit>,
}

pub struct TestDraftQuit {
    state: tokio::sync::watch::Sender<(bool, bool)>,
    staged: std::sync::atomic::AtomicBool,
}

impl Default for TestDraftQuit {
    fn default() -> Self {
        Self {
            state: tokio::sync::watch::channel((false, false)).0,
            staged: false.into(),
        }
    }
}

impl TestDraftQuit {
    pub async fn wait(&self) -> bool {
        use std::sync::atomic::Ordering;
        let mut state = self.state.subscribe();
        self.staged.store(true, Ordering::Release);
        let refuse = state
            .wait_for(|(hold, _)| !*hold)
            .await
            .is_ok_and(|state| state.1);
        self.staged.store(false, Ordering::Release);
        refuse
    }
}

#[tauri::command]
pub fn test_draft_quit(
    state: tauri::State<'_, Core>,
    hold: Option<bool>,
    refuse: Option<bool>,
) -> bool {
    let probe = state.0.lock().unwrap().acceptance.draft_quit.clone();
    if let Some(hold) = hold {
        probe.state.send_replace((hold, refuse.unwrap_or(false)));
    }
    probe.staged.load(std::sync::atomic::Ordering::Acquire)
}

#[tauri::command]
pub fn test_hold_debug_disconnect(state: tauri::State<'_, Core>, hold: bool) -> CommandResult<()> {
    let mut session = state.0.lock().unwrap();
    session.acceptance.check()?;
    session.acceptance.hold_debug_disconnect = hold;
    Ok(())
}

#[tauri::command]
pub fn test_cancel_next_picker(state: tauri::State<'_, Core>) -> CommandResult<()> {
    let mut session = state.0.lock().unwrap();
    session.acceptance.check()?;
    session.acceptance.cancel_next_picker = true;
    Ok(())
}

impl Admission {
    pub fn check(&self) -> CommandResult<()> {
        if self.sealed {
            Err("The acceptance app is shutting down.".into())
        } else {
            Ok(())
        }
    }
}

fn seal(session: &mut Session) {
    session.acceptance.sealed = true;
    session.stop_processes();
}

pub fn watch(app: &AppHandle) {
    if std::env::var_os("IRON_GO_E2E_WATCH_STDIN").as_deref() != Some(std::ffi::OsStr::new("1"))
        || std::env::var_os("IRON_GO_E2E_WORKSPACE").is_none()
        || std::env::var("TAURI_WEBDRIVER_PORT")
            .ok()
            .and_then(|port| port.parse::<u16>().ok())
            .is_none()
    {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let eof = io::copy(&mut io::stdin().lock(), &mut io::sink());
        let core = app.state::<Core>();
        let mut session = core.0.lock().unwrap();
        seal(&mut session);
        let (mut session, _) = core
            .2
            .wait_timeout_while(session, Duration::from_secs(10), |session| {
                session.acceptance.short_tools != 0
                    || session.program_debug.is_some()
                    || session.terminal.is_some()
            })
            .unwrap();
        let drained = eof.is_ok()
            && session.acceptance.short_tools == 0
            && session.program_debug.is_none()
            && session.terminal.is_none()
            && !session.acceptance.unproved_exit;
        session.clean_run_directories();
        drop(session);
        if drained {
            println!("IRON_E2E_SUPERVISOR_STOP_COMPLETE");
        } else {
            eprintln!("Acceptance supervisor did not verify process cleanup.");
        }
        app.exit(if drained { 0 } else { 1 });
    });
}

pub(crate) struct ShortTool<'a> {
    core: &'a Core,
    needs_proof: bool,
}

impl<'a> ShortTool<'a> {
    pub(crate) fn admit(core: &'a Core) -> CommandResult<Self> {
        let mut session = core.0.lock().unwrap();
        session.acceptance.check()?;
        session.acceptance.short_tools += 1;
        Ok(Self {
            core,
            needs_proof: false,
        })
    }

    pub(crate) fn require_proof(&mut self) {
        self.needs_proof = true;
    }
    pub(crate) fn confirm_cleanup(&mut self) {
        self.needs_proof = false;
    }
}

impl Drop for ShortTool<'_> {
    fn drop(&mut self) {
        let mut session = self.core.0.lock().unwrap();
        session.acceptance.short_tools -= 1;
        session.acceptance.unproved_exit |= self.needs_proof;
        self.core.2.notify_all();
    }
}

#[cfg(test)]
#[test]
fn sealed_session_cannot_admit_queued_work_or_new_tools() {
    let core = Core::default();
    let fixture = tempfile::tempdir().unwrap();
    let project = crate::install_workspace(
        &core,
        crate::Workspace::open(fixture.path()).unwrap(),
        None,
        None,
    )
    .unwrap();
    let old = ShortTool::admit(&core).unwrap();
    seal(&mut core.0.lock().unwrap());
    assert!(core.0.lock().unwrap().root(project.id).is_err());
    assert!(ShortTool::admit(&core).is_err());
    assert!(crate::install_workspace(
        &core,
        crate::Workspace::open(fixture.path()).unwrap(),
        None,
        None
    )
    .is_err());
    assert_eq!(core.0.lock().unwrap().acceptance.short_tools, 1);
    drop(old);
    assert_eq!(core.0.lock().unwrap().acceptance.short_tools, 0);
}

#[cfg(test)]
#[tokio::test]
async fn timed_out_short_tool_is_reaped_before_its_lease_is_released() {
    let core = Core::default();
    let err = short_output(
        &core,
        Command::new("/bin/sleep").arg("30"),
        None,
        Duration::from_millis(10),
        "fixture",
    )
    .await
    .unwrap_err();
    assert!(err.contains("timed out"));
    let session = core.0.lock().unwrap();
    assert_eq!(session.acceptance.short_tools, 0);
    assert!(!session.acceptance.unproved_exit);
}

#[cfg(test)]
#[tokio::test]
async fn timeout_stops_descendant_retaining_short_tool_output() {
    let core = Core::default();
    let fixture = tempfile::tempdir().unwrap();
    let marker = fixture.path().join("child-pid");
    let mut command = Command::new("/bin/sh");
    command
        .args([
            "-c",
            "/bin/sleep 4 & printf '%s' \"$!\" > \"$1\"; exit 0",
            "fixture",
        ])
        .arg(&marker);
    assert!(short_output(
        &core,
        &mut command,
        None,
        Duration::from_millis(300),
        "fixture"
    )
    .await
    .unwrap_err()
    .contains("timed out"));
    let pid: i32 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            // SAFETY: signal zero only observes the child created by this fixture.
            if unsafe { libc::kill(pid, 0) } == -1
                && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the pipe-retaining descendant must be stopped before cleanup is proved");
    assert!(!core.0.lock().unwrap().acceptance.unproved_exit);
}
