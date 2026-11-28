use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{self, Read},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, LazyLock},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tokio::{io::AsyncReadExt, process::Command, sync::oneshot};

use crate::{
    go_launch::{prepare_build, verify_handoff},
    process_owner::{bind_child_directory, OwnedChild, ProcessGroup},
    tools::command,
    workspace::{excluded_name, go_source_signature, package_dir, run_directory},
    workspace_disk::RootAnchor,
    CommandResult, Core, Workspace,
};

pub(crate) const MAX_OUTPUT: usize = 512 * 1024;
const MAX_TEST_WIRE: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Run,
    Build,
    Test,
}

impl TaskKind {
    fn verb(self) -> &'static str {
        match self {
            Self::Run => "run",
            Self::Build => "build",
            Self::Test => "test",
        }
    }
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum Stream {
    Stdout,
    Stderr,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TaskEvent {
    Started {
        command: String,
        #[serde(rename = "structuredTests")]
        structured_tests: bool,
    },
    Output {
        stream: Stream,
        bytes: Vec<u8>,
    },
    Notice {
        message: String,
    },
    OutputLimit,
    Finished {
        success: bool,
        code: Option<i32>,
        cancelled: bool,
    },
}

pub struct RunningTask {
    pub(crate) id: u64,
    pub(crate) stop: Option<oneshot::Sender<()>>,
    pub(crate) group: Option<Arc<ProcessGroup>>,
}

struct PreparingRerun {
    app: AppHandle,
    id: u64,
    stop: Option<oneshot::Receiver<()>>,
}

impl Drop for PreparingRerun {
    fn drop(&mut self) {
        let core = self.app.state::<Core>();
        let mut session = core.0.lock().unwrap();
        if session
            .task
            .as_ref()
            .is_some_and(|task| task.id == self.id && task.group.is_none())
        {
            session.task.take();
        }
    }
}

#[cfg(feature = "e2e")]
pub struct TestRunHandoff {
    gate: tokio::sync::watch::Sender<bool>,
    directory: std::sync::Mutex<Option<PathBuf>>,
}

#[cfg(feature = "e2e")]
impl Default for TestRunHandoff {
    fn default() -> Self {
        Self {
            gate: tokio::sync::watch::channel(false).0,
            directory: Default::default(),
        }
    }
}

#[cfg(feature = "e2e")]
impl TestRunHandoff {
    pub(crate) async fn wait(&self, directory: &Path, stop: &mut oneshot::Receiver<()>) -> bool {
        let mut gate = self.gate.subscribe();
        if !*gate.borrow() {
            return true;
        }
        *self.directory.lock().unwrap() = Some(directory.to_path_buf());
        let proceed = tokio::select! {
            _ = stop => false,
            result = gate.wait_for(|hold| !*hold) => result.is_ok(),
        };
        self.directory.lock().unwrap().take();
        proceed
    }
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn test_run_handoff(state: State<'_, Core>, hold: Option<bool>) -> Option<PathBuf> {
    let handoff = state.0.lock().unwrap().acceptance.run_handoff.clone();
    if let Some(hold) = hold {
        handoff.gate.send_replace(hold);
    }
    let directory = handoff.directory.lock().unwrap().clone();
    directory
}

impl RunningTask {
    pub(crate) fn cancel(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(group) = &self.group {
            group.kill();
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunLaunch {
    pub(crate) directory: String,
    pub(crate) args: Vec<String>,
    pub(crate) environment: BTreeMap<String, String>,
}

impl RunLaunch {
    pub(crate) fn validate(&self) -> CommandResult<()> {
        if self.directory.len() > 512
            || self.args.len() > 128
            || self.environment.len() > 64
            || self
                .args
                .iter()
                .any(|arg| arg.len() > 4096 || arg.contains('\0'))
            || self.environment.iter().any(|(key, value)| {
                let mut bytes = key.bytes();
                !bytes
                    .next()
                    .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
                    || key.len() > 128
                    || !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                    || value.len() > 4096
                    || value.contains(['\0', '\n', '\r'])
            })
            || self.args.iter().map(String::len).sum::<usize>()
                + self
                    .environment
                    .iter()
                    .map(|(key, value)| key.len() + value.len())
                    .sum::<usize>()
                > 64 * 1024
        {
            return Err(
                "The run configuration exceeds the supported argument or environment limits."
                    .into(),
            );
        }
        Ok(())
    }
}

impl Drop for RunningTask {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[tauri::command]
pub async fn start_task(
    app: AppHandle,
    state: State<'_, Core>,
    id: u64,
    kind: TaskKind,
    packages: Vec<String>,
    test_name: Option<String>,
    launch: Option<RunLaunch>,
    rerun_import_path: Option<String>,
    events: Channel<TaskEvent>,
) -> CommandResult<()> {
    if packages.is_empty()
        || packages.len() > 128
        || packages
            .iter()
            .any(|package| package.len() > 512 || package.contains(['\n', '\r']))
    {
        return Err("Choose one or more relative Go packages such as './cmd/app'.".into());
    }
    if matches!(kind, TaskKind::Run) && (packages.len() != 1 || packages[0].contains("...")) {
        return Err("Go Run requires one executable package, not a pattern.".into());
    }
    let rerunning = rerun_import_path.is_some();
    let filter = test_name
        .as_deref()
        .map(|name| {
            if rerunning {
                rerun_test_filter(name)
            } else {
                exact_test_filter(name)
            }
        })
        .transpose()?;
    if let Some(import) = &rerun_import_path {
        if filter.is_none()
            || !matches!(kind, TaskKind::Test)
            || packages.len() != 1
            || !literal_package_selector(&packages[0])
            || import.is_empty()
            || import.len() > 1024
            || import
                .chars()
                .any(|ch| ch.is_control() || ch.is_whitespace())
        {
            return Err("Choose one verified Go package and a test name to rerun.".into());
        }
    }
    if filter.is_some()
        && (!matches!(kind, TaskKind::Test) || packages.len() != 1 || packages[0].contains("..."))
    {
        return Err("A single test must run in one package.".into());
    }
    if let Some(launch) = &launch {
        if !matches!(kind, TaskKind::Run) {
            return Err("A run configuration is only valid for Go Run.".into());
        }
        launch.validate()?;
    }
    let mut preparing = None;
    let rerun = if let Some(import_path) = rerun_import_path {
        let (root, anchor, token) = {
            let mut session = state.0.lock().unwrap();
            let root = session.root(id)?.to_path_buf();
            if session.go_busy() || session.workspace_busy() {
                return Err("A Go task or workspace operation is already in progress.".into());
            }
            let anchor = session.workspace.as_ref().unwrap().anchor.clone();
            let task = session.next_id();
            let (send, receive) = oneshot::channel();
            session.task = Some(RunningTask {
                id: task,
                stop: Some(send),
                group: None,
            });
            (
                root,
                anchor,
                PreparingRerun {
                    app: app.clone(),
                    id: task,
                    stop: Some(receive),
                },
            )
        };
        let source_root = root.clone();
        let source_anchor = anchor.clone();
        let signature =
            crate::blocking(move || go_source_signature(&source_root, &source_anchor)).await;
        {
            let session = state.0.lock().unwrap();
            if !can_admit_followup(&session, id, token.id) {
                return Err("Go rerun was canceled before it started.".into());
            }
        }
        preparing = Some(token);
        Some(TestRerun {
            root,
            anchor,
            signature: signature?,
            import_path,
            selector: packages[0].clone(),
            filter: filter.clone().unwrap(),
        })
    } else {
        None
    };
    let data_dir = if rerunning {
        Some(
            app.path()
                .app_local_data_dir()
                .map_err(|error| error.to_string())?,
        )
    } else {
        None
    };
    let mut session = state.0.lock().unwrap();
    let root = session.root(id)?;
    let admitted = if let Some(preparing) = &preparing {
        can_admit_followup(&session, id, preparing.id)
    } else {
        !session.go_busy() && !session.workspace_busy()
    };
    if !admitted {
        return Err("A Go task or debug session is already running.".into());
    }
    let (temporary, mut command) = if let Some(launch) = &launch {
        let (prepared, command) = prepare_build(
            session.workspace.as_ref().unwrap(),
            &packages[0],
            launch,
            || {
                tempfile::Builder::new()
                    .prefix("iron-go-run-")
                    .tempdir()
                    .map_err(|error| format!("Prepare executable directory: {error}"))
            },
            "program",
            &[],
        )?;
        (Some(prepared), command)
    } else {
        for package in &packages {
            package_dir(root, package)?;
        }
        let mut command = command("go")?;
        if rerun.is_some() {
            bind_child_directory(
                &mut command,
                run_directory(session.workspace.as_ref().unwrap(), ".")?,
            );
            command.args(["env", "-json", "GOWORK", "GOFLAGS"]);
        } else {
            command.current_dir(root);
            command.arg(kind.verb());
        }
        (None, command)
    };
    let mut flags = String::new();
    if matches!(kind, TaskKind::Test) {
        if !rerunning {
            command.args(["-json", "-fullpath"]);
        }
        flags.push_str(" -json -fullpath");
    }
    if rerunning {
        flags.push_str(" -count=1");
    }
    if let Some(filter) = filter {
        if !rerunning {
            command.args(["-run", &filter]);
        }
        flags.push_str(&format!(" -run '{filter}'"));
    }
    if !rerunning && temporary.is_none() {
        command.args(&packages);
    }
    let child = spawn_child(&mut command).map_err(|error| format!("Start Go task: {error}"))?;
    let (task_id, mut receive) = if let Some(preparing) = &mut preparing {
        session.task.as_mut().unwrap().group = Some(child.group.clone());
        (preparing.id, preparing.stop.take().unwrap())
    } else {
        let (send, receive) = oneshot::channel();
        let task_id = session.next_id();
        session.task = Some(RunningTask {
            id: task_id,
            stop: Some(send),
            group: Some(child.group.clone()),
        });
        (task_id, receive)
    };
    #[cfg(feature = "e2e")]
    let handoff = session.acceptance.run_handoff.clone();
    if let Some(prepared) = &temporary {
        session
            .run_directories
            .insert(task_id, prepared.directory.path().to_path_buf());
    }
    tauri::async_runtime::spawn(async move {
        let label = if launch.is_some() {
            format!("Build configured Go package {}", packages[0])
        } else {
            format!("go {}{flags} {}", kind.verb(), packages.join(" "))
        };
        let structured_tests = matches!(kind, TaskKind::Test);
        let _ = events.send(TaskEvent::Started {
            command: label,
            structured_tests,
        });
        let mut budget = if structured_tests {
            MAX_TEST_WIRE
        } else {
            MAX_OUTPUT
        };
        let emit = |event| {
            let _ = events.send(event);
        };
        let mut finished = if let Some(rerun) = rerun {
            let prepared = verify_test_rerun(&app, id, task_id, child, &mut receive, &rerun).await;
            let process = match prepared {
                Ok(Some(environment)) => {
                    #[cfg(feature = "e2e")]
                    let proceed = handoff.wait(&rerun.root, &mut receive).await;
                    #[cfg(not(feature = "e2e"))]
                    let proceed = true;
                    if proceed {
                        admit_rerun(&app, id, task_id, rerun, environment, data_dir.unwrap()).await
                    } else {
                        Ok(None)
                    }
                }
                Ok(None) => Ok(None),
                Err(error) => {
                    let core = app.state::<Core>();
                    if can_admit_followup(&core.0.lock().unwrap(), id, task_id) {
                        Err(error)
                    } else {
                        Ok(None)
                    }
                }
            };
            finish_phase(process, &mut receive, &mut budget, emit, WaitPolicy::Leader).await
        } else {
            supervise(child, &mut receive, &mut budget, emit).await
        };
        let cleaned = if let (Some(launch), Some(prepared)) = (launch, temporary) {
            if matches!(finished, TaskEvent::Finished { success: true, .. }) {
                #[cfg(feature = "e2e")]
                let proceed = handoff.wait(prepared.directory.path(), &mut receive).await;
                #[cfg(not(feature = "e2e"))]
                let proceed = true;
                let program = if proceed {
                    admit_executable(
                        &app,
                        id,
                        task_id,
                        &prepared.binary,
                        prepared.working,
                        launch,
                    )
                } else {
                    Ok(None)
                };
                if matches!(program, Ok(Some(_))) {
                    emit(TaskEvent::Notice {
                        message: "Running the configured Go program.".into(),
                    });
                }
                finished =
                    finish_phase(program, &mut receive, &mut budget, emit, WaitPolicy::Group).await;
            }
            prepared.directory.close().is_ok()
        } else {
            true
        };
        let core = app.state::<Core>();
        let mut session = core.0.lock().unwrap();
        if cleaned {
            session.run_directories.remove(&task_id);
        }
        if let Some(task) = session.task.as_ref().filter(|task| task.id == task_id) {
            if task.stop.is_none() {
                finished = TaskEvent::Finished {
                    success: false,
                    code: None,
                    cancelled: true,
                };
            }
            session.task.take();
        }
        drop(session);
        let _ = events.send(finished);
    });
    Ok(())
}

pub(crate) fn spawn_child(command: &mut Command) -> io::Result<OwnedChild> {
    command
        .process_group(0)
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map(OwnedChild::new)
}

fn admit_executable(
    app: &AppHandle,
    workspace_id: u64,
    task_id: u64,
    path: &Path,
    working: File,
    launch: RunLaunch,
) -> CommandResult<Option<OwnedChild>> {
    admit_followup(app, workspace_id, task_id, |workspace| {
        verify_handoff(workspace, &launch.directory, &working, path)?;
        let mut command = Command::new(path);
        bind_child_directory(&mut command, working);
        command.args(launch.args).envs(launch.environment);
        spawn_child(&mut command).map_err(|error| format!("Start configured Go program: {error}"))
    })
}

fn admit_followup(
    app: &AppHandle,
    workspace_id: u64,
    task_id: u64,
    spawn: impl FnOnce(&Workspace) -> CommandResult<OwnedChild>,
) -> CommandResult<Option<OwnedChild>> {
    let core = app.state::<Core>();
    let mut session = core.0.lock().unwrap();
    if !can_admit_followup(&session, workspace_id, task_id) {
        return Ok(None);
    }
    let child = spawn(session.workspace.as_ref().unwrap())?;
    session.task.as_mut().unwrap().group = Some(child.group.clone());
    Ok(Some(child))
}

fn can_admit_followup(session: &crate::Session, workspace_id: u64, task_id: u64) -> bool {
    !session.cutover_tearing_down()
        && session.root(workspace_id).is_ok()
        && session
            .task
            .as_ref()
            .is_some_and(|task| task.id == task_id && task.stop.is_some())
}

async fn admit_rerun(
    app: &AppHandle,
    workspace_id: u64,
    task_id: u64,
    rerun: TestRerun,
    environment: GoEnvironment,
    data_dir: PathBuf,
) -> CommandResult<Option<OwnedChild>> {
    let app = app.clone();
    crate::blocking(move || {
        let result = (|| {
            let _save = crate::workspace::try_save_lock(&data_dir)?;
            rerun.unchanged()?;
            admit_followup(&app, workspace_id, task_id, |workspace| {
                rerun.spawn(workspace, &environment)
            })
        })();
        let core = app.state::<Core>();
        if result.is_err() && !can_admit_followup(&core.0.lock().unwrap(), workspace_id, task_id) {
            Ok(None)
        } else {
            result
        }
    })
    .await
}

async fn finish_phase(
    phase: CommandResult<Option<OwnedChild>>,
    stop: &mut oneshot::Receiver<()>,
    budget: &mut usize,
    mut emit: impl FnMut(TaskEvent),
    wait: WaitPolicy,
) -> TaskEvent {
    match phase {
        Ok(Some(child)) => supervise_phase(child, stop, budget, emit, wait).await,
        Ok(None) => TaskEvent::Finished {
            success: false,
            code: None,
            cancelled: true,
        },
        Err(message) => {
            emit(TaskEvent::Notice { message });
            TaskEvent::Finished {
                success: false,
                code: None,
                cancelled: false,
            }
        }
    }
}

#[derive(Clone)]
struct TestRerun {
    root: PathBuf,
    anchor: RootAnchor,
    signature: String,
    import_path: String,
    selector: String,
    filter: String,
}

#[derive(Deserialize)]
struct GoEnvironment {
    #[serde(rename = "GOWORK")]
    work_file: String,
    #[serde(rename = "GOFLAGS")]
    flags: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct VerifiedPackage {
    import_path: String,
    dir: PathBuf,
    module: Option<VerifiedModule>,
}

#[derive(Deserialize)]
struct VerifiedModule {
    #[serde(rename = "GoMod")]
    go_mod: PathBuf,
}

impl TestRerun {
    fn unchanged(&self) -> CommandResult<()> {
        if go_source_signature(&self.root, &self.anchor)? != self.signature {
            return Err("The Go package identity changed before rerun. Run the tests again from the current workspace.".into());
        }
        Ok(())
    }

    fn spawn(
        &self,
        workspace: &Workspace,
        environment: &GoEnvironment,
    ) -> CommandResult<OwnedChild> {
        package_dir(&workspace.root, &self.selector)?;
        let mut command = command("go")?;
        bind_child_directory(&mut command, run_directory(workspace, ".")?);
        command
            .args([
                "test",
                "-json",
                "-fullpath",
                "-count=1",
                "-run",
                &self.filter,
                &self.selector,
            ])
            .env("GOWORK", &environment.work_file)
            .env("GOFLAGS", &environment.flags);
        spawn_child(&mut command).map_err(|error| format!("Start Go rerun: {error}"))
    }
}

fn verified_manifest(root: &Path, path: &Path, name: &str) -> CommandResult<PathBuf> {
    let absolute = root.join(path);
    let canonical = absolute
        .canonicalize()
        .map_err(|error| format!("Verify Go manifest: {error}"))?;
    let contained = absolute.strip_prefix(root).ok().is_some_and(|relative| {
        relative.components().all(|part| {
            matches!(part, std::path::Component::Normal(name) if name.to_str().is_some_and(|name| !excluded_name(name)))
        })
    });
    if path.file_name().and_then(|part| part.to_str()) != Some(name)
        || canonical.file_name().and_then(|part| part.to_str()) != Some(name)
        || !contained
        || absolute != canonical
    {
        return Err(format!(
            "Go rerun requires a standard {name} inside the opened workspace."
        ));
    }
    Ok(canonical)
}

fn verify_package(rerun: &TestRerun, metadata: VerifiedPackage) -> CommandResult<()> {
    let expected = rerun
        .root
        .join(rerun.selector.strip_prefix("./").unwrap_or(&rerun.selector));
    if metadata.import_path != rerun.import_path
        || metadata.dir != expected.canonicalize().map_err(|error| error.to_string())?
    {
        return Err(
            "The Go package identity changed. Run the tests again from the current workspace."
                .into(),
        );
    }
    let manifest = metadata
        .module
        .ok_or("Go rerun requires a verified module in the opened workspace.")?;
    verified_manifest(&rerun.root, &manifest.go_mod, "go.mod")?;
    Ok(())
}

async fn verify_test_rerun(
    app: &AppHandle,
    workspace_id: u64,
    task_id: u64,
    child: OwnedChild,
    stop: &mut oneshot::Receiver<()>,
    rerun: &TestRerun,
) -> CommandResult<Option<GoEnvironment>> {
    let Some(env) = verification_output(child, stop).await? else {
        return Ok(None);
    };
    let mut environment: GoEnvironment = serde_json::from_slice(&env)
        .map_err(|_| "Could not verify the effective Go environment.")?;
    environment.flags = verified_rerun_flags(environment.flags)?;
    environment.work_file = if environment.work_file.is_empty() || environment.work_file == "off" {
        "off".into()
    } else {
        verified_manifest(&rerun.root, Path::new(&environment.work_file), "go.work")?
            .into_os_string()
            .into_string()
            .map_err(|_| "Cannot use a non-UTF-8 workfile for Go rerun.")?
    };
    let Some(list) = admit_followup(app, workspace_id, task_id, |workspace| {
        let mut go = command("go")?;
        bind_child_directory(&mut go, run_directory(workspace, ".")?);
        go.args([
            "list",
            "-find",
            "-json=ImportPath,Dir,Module",
            &rerun.selector,
        ])
        .env("GOWORK", &environment.work_file)
        .env("GOFLAGS", &environment.flags);
        spawn_child(&mut go).map_err(|error| format!("Verify Go package: {error}"))
    })?
    else {
        return Ok(None);
    };
    let Some(bytes) = verification_output(list, stop).await? else {
        return Ok(None);
    };
    let package = serde_json::from_slice(&bytes)
        .map_err(|_| "Go did not resolve exactly one package for rerun.")?;
    verify_package(rerun, package)?;
    let check = rerun.clone();
    let result = crate::blocking(move || check.unchanged()).await;
    if !can_admit_followup(
        &app.state::<Core>().0.lock().unwrap(),
        workspace_id,
        task_id,
    ) {
        return Ok(None);
    }
    result?;
    Ok(Some(environment))
}

fn verified_rerun_flags(flags: String) -> CommandResult<String> {
    if flags.contains("-overlay") || flags.contains("-modfile") || flags.contains(['\'', '"', '\\'])
    {
        return Err("Go rerun does not support manifest overrides, overlays, or quoted GOFLAGS. Use the normal Go Test command.".into());
    }
    // cmd/go falls back to the GOENV preference if the environment value
    // is empty. Nonempty whitespace supplies the verified empty flag list.
    Ok(if flags.is_empty() { " ".into() } else { flags })
}

async fn verification_output(
    child: OwnedChild,
    stop: &mut oneshot::Receiver<()>,
) -> CommandResult<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    let mut budget = 64 * 1024;
    let event = tokio::time::timeout(
        Duration::from_secs(8),
        supervise(child, stop, &mut budget, |event| {
            if let TaskEvent::Output {
                stream: Stream::Stdout,
                bytes: chunk,
            } = event
            {
                bytes.extend(chunk);
            }
        }),
    )
    .await
    .map_err(|_| "Go package verification timed out.")?;
    match event {
        TaskEvent::Finished {
            cancelled: true, ..
        } => Ok(None),
        TaskEvent::Finished { success: true, .. } if budget > 0 => Ok(Some(bytes)),
        _ => Err("Could not verify the Go package for rerun.".into()),
    }
}

pub(crate) fn verify_executable(path: &Path) -> CommandResult<()> {
    let error = "The configured Go package did not build a macOS executable.";
    let mut binary = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| error)?;
    let info = binary.metadata().map_err(|_| error)?;
    let mut header = [0; 16];
    if !info.is_file()
        || info.permissions().mode() & 0o111 == 0
        || binary.read_exact(&mut header).is_err()
        || header[..4] != [0xcf, 0xfa, 0xed, 0xfe]
        || header[12..16] != [2, 0, 0, 0]
    {
        return Err(error.into());
    }
    Ok(())
}

fn exact_test_filter(name: &str) -> CommandResult<String> {
    static LOWERCASE_LETTER: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^\p{Ll}").unwrap());
    if name.len() > 200
        || !name.strip_prefix("Test").is_some_and(|suffix| {
            !LOWERCASE_LETTER.is_match(suffix)
                && suffix.chars().all(|c| c.is_alphanumeric() || c == '_')
        })
    {
        return Err("Choose a named Go test function.".into());
    }
    Ok(format!("^{}$", regex::escape(name)))
}

pub(crate) fn literal_package_selector(path: &str) -> bool {
    path == "." || (path.starts_with("./") && !path.contains("..."))
}

fn rerun_test_filter(name: &str) -> CommandResult<String> {
    let segments: Vec<_> = name.split('/').collect();
    if name.len() > 1024 || segments.len() > 32 || name.chars().any(|ch| ch.is_control()) {
        return Err("The selected Go test name is outside the supported limits.".into());
    }
    exact_test_filter(segments[0])?;
    Ok(segments
        .into_iter()
        .map(|segment| {
            let mut literal = String::from("^");
            for ch in segment.chars() {
                if matches!(
                    ch,
                    '\\' | '.'
                        | '+'
                        | '*'
                        | '?'
                        | '('
                        | ')'
                        | '|'
                        | '['
                        | ']'
                        | '{'
                        | '}'
                        | '^'
                        | '$'
                ) {
                    literal.push('\\');
                }
                literal.push(ch);
            }
            literal.push('$');
            literal
        })
        .collect::<Vec<_>>()
        .join("/"))
}

fn output(emit: &mut impl FnMut(TaskEvent), budget: &mut usize, bytes: &[u8], stream: Stream) {
    let count = bytes.len().min(*budget);
    if count > 0 {
        *budget -= count;
        emit(TaskEvent::Output {
            stream,
            bytes: bytes[..count].to_vec(),
        });
        if *budget == 0 {
            emit(TaskEvent::OutputLimit);
        }
    }
}

pub(crate) async fn supervise(
    child: OwnedChild,
    stop: &mut oneshot::Receiver<()>,
    budget: &mut usize,
    emit: impl FnMut(TaskEvent),
) -> TaskEvent {
    supervise_phase(child, stop, budget, emit, WaitPolicy::Leader).await
}

#[derive(Clone, Copy)]
enum WaitPolicy {
    Leader,
    Group,
}

async fn supervise_phase(
    mut child: OwnedChild,
    stop: &mut oneshot::Receiver<()>,
    budget: &mut usize,
    mut emit: impl FnMut(TaskEvent),
    wait: WaitPolicy,
) -> TaskEvent {
    let group = match wait {
        WaitPolicy::Leader => None,
        WaitPolicy::Group => child.child.id().map(|id| id as i32),
    };
    let mut stdout = child.child.stdout.take().unwrap();
    let mut stderr = child.child.stderr.take().unwrap();
    let (mut out, mut err) = ([0; 4096], [0; 4096]);
    let (mut has_stdout, mut has_stderr) = (true, true);
    let (status, mut cancelled) = loop {
        tokio::select! {
            _ = &mut *stop => {
                child.group.kill();
                break (child.wait().await, true);
            }
            status = async {
                match wait {
                    WaitPolicy::Leader => child.wait().await,
                    WaitPolicy::Group => child.wait_and_retire_group().await,
                }
            } => break (status, false),
            count = stdout.read(&mut out), if has_stdout => {
                has_stdout = handle_read(count, &out, Stream::Stdout, budget, &mut emit);
            }
            count = stderr.read(&mut err), if has_stderr => {
                has_stderr = handle_read(count, &err, Stream::Stderr, budget, &mut emit);
            }
        }
    };
    if !cancelled {
        // Drain output written just before exit, without waiting forever for
        // an unrelated process that inherited the descriptors.
        let drain = tokio::time::timeout(Duration::from_millis(300), async {
            while has_stdout || has_stderr {
                tokio::select! {
                    biased;
                    _ = &mut *stop => return false,
                    count = stdout.read(&mut out), if has_stdout => {
                        has_stdout = handle_read(count, &out, Stream::Stdout, budget, &mut emit);
                    }
                    count = stderr.read(&mut err), if has_stderr => {
                        has_stderr = handle_read(count, &err, Stream::Stderr, budget, &mut emit);
                    }
                }
            }
            true
        })
        .await;
        cancelled = matches!(drain, Ok(false));
    }
    if let Some(group) = group {
        // The group has already been signaled with its leader reserved.
        // After reaping the leader only observe; never signal a recycled ID.
        while unsafe {
            libc::kill(-group, 0) == 0
                || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        } {
            if !cancelled && !matches!(stop.try_recv(), Err(oneshot::error::TryRecvError::Empty)) {
                cancelled = true;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    match status {
        Ok(status) => TaskEvent::Finished {
            success: status.success() && !cancelled,
            code: status.code(),
            cancelled,
        },
        Err(error) => {
            emit(TaskEvent::Notice {
                message: format!("Wait for Go process: {error}"),
            });
            TaskEvent::Finished {
                success: false,
                code: None,
                cancelled,
            }
        }
    }
}

fn handle_read(
    count: io::Result<usize>,
    buf: &[u8],
    stream: Stream,
    budget: &mut usize,
    emit: &mut impl FnMut(TaskEvent),
) -> bool {
    match count {
        Ok(0) => false,
        Ok(count) => {
            output(emit, budget, &buf[..count], stream);
            true
        }
        Err(error) => {
            emit(TaskEvent::Notice {
                message: format!("Read task output: {error}"),
            });
            false
        }
    }
}

#[tauri::command]
pub fn stop_task(state: State<'_, Core>, id: u64) -> CommandResult<()> {
    let mut session = state.0.lock().unwrap();
    session.root(id)?;
    if session.program_debug.is_none() && !session.terminal_go() {
        if let Some(task) = &mut session.task {
            task.cancel();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stopped_preparing_rerun_cannot_admit_its_first_process() {
        let fixture = tempfile::tempdir().unwrap();
        let mut workspace = Workspace::open(fixture.path()).unwrap();
        workspace.info.id = 1;
        let (stop, mut cancelled) = oneshot::channel();
        let mut session = crate::Session {
            workspace: Some(workspace),
            task: Some(RunningTask {
                id: 2,
                stop: Some(stop),
                group: None,
            }),
            ..Default::default()
        };
        assert!(can_admit_followup(&session, 1, 2));
        assert!(!can_admit_followup(&session, 1, 3));
        session.task.as_mut().unwrap().cancel();
        assert!(cancelled.try_recv().is_ok());
        assert!(!can_admit_followup(&session, 1, 2));
    }

    #[test]
    fn rerun_uses_a_literal_selector_and_quotes_go_regexp_components() {
        assert!(literal_package_selector("./pkg"));
        assert!(!literal_package_selector("./abc...def"));
        assert!(!literal_package_selector("example.com/pkg"));
        assert_eq!(
            rerun_test_filter("TestName/child.+/case#1").unwrap(),
            r"^TestName$/^child\.\+$/^case#1$"
        );
        assert!(rerun_test_filter("Example").is_err());
        assert!(rerun_test_filter("FuzzFoo/seed#1").is_err());
        assert_eq!(rerun_test_filter("Testʰ").unwrap(), "^Testʰ$");
    }

    #[tokio::test]
    async fn rerun_pins_empty_flags_and_rejects_untracked_manifest_inputs() {
        assert!(verified_rerun_flags("-overlay=outside.json".into()).is_err());
        assert!(verified_rerun_flags("-modfile=.git/go.mod".into()).is_err());
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        std::fs::create_dir(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/go.mod"), "module example.test/hidden\n").unwrap();
        assert!(verified_manifest(&root, Path::new(".git/go.mod"), "go.mod").is_err());
        std::fs::create_dir(root.join("node_modules")).unwrap();
        std::fs::write(root.join("go.mod"), "module example.test/tracked\n").unwrap();
        std::os::unix::fs::symlink(root.join("go.mod"), root.join("node_modules/go.mod")).unwrap();
        assert!(verified_manifest(&root, Path::new("node_modules/go.mod"), "go.mod").is_err());
        assert_eq!(
            verified_manifest(&root, Path::new("go.mod"), "go.mod").unwrap(),
            root.join("go.mod")
        );
        let Ok(mut go) = command("go") else { return };
        let prefs = root.join("preferences");
        std::fs::write(&prefs, "GOFLAGS=-modfile=external.mod\n").unwrap();
        let result = go
            .args(["env", "GOFLAGS"])
            .env("GOENV", prefs)
            .env("GOFLAGS", verified_rerun_flags(String::new()).unwrap())
            .current_dir(&root)
            .output()
            .await
            .unwrap();
        assert!(result.status.success());
        assert_eq!(result.stdout, b" \n");
    }

    #[tokio::test]
    async fn rerun_refuses_a_package_whose_module_is_above_the_open_root() {
        let Ok(mut go) = command("go") else { return };
        let fixture = tempfile::tempdir().unwrap();
        let parent = fixture.path();
        std::fs::write(
            parent.join("go.mod"),
            "module example.test/ancestor\n\ngo 1.22\n",
        )
        .unwrap();
        let root = parent.join("pkg");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("package.go"), "package pkg\n").unwrap();
        let workspace = Workspace::open(&root).unwrap();
        let output = go
            .args(["list", "-find", "-json=ImportPath,Dir,Module", "."])
            .current_dir(&workspace.root)
            .env("GOENV", "off")
            .env("GOWORK", "off")
            .env("GOFLAGS", "")
            .output()
            .await
            .unwrap();
        assert!(output.status.success());
        let metadata: VerifiedPackage = serde_json::from_slice(&output.stdout).unwrap();
        let rerun = TestRerun {
            root: workspace.root,
            anchor: workspace.anchor,
            signature: String::new(),
            import_path: "example.test/ancestor/pkg".into(),
            selector: ".".into(),
            filter: "^TestName$".into(),
        };
        assert!(verify_package(&rerun, metadata)
            .unwrap_err()
            .contains("inside the opened workspace"));
    }

    #[tokio::test]
    async fn runs_sample_go_program_and_drains_output() {
        let Ok(mut go) = command("go") else { return };
        let child = go
            .args(["run", "./cmd/orbit"])
            .current_dir(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../tests/fixtures/orbit"
            ))
            .process_group(0)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let (_send, mut receive) = oneshot::channel();
        let mut budget = MAX_OUTPUT;
        let mut bytes = vec![];
        let event = supervise(OwnedChild::new(child), &mut receive, &mut budget, |event| {
            if let TaskEvent::Output { bytes: data, .. } = event {
                bytes.extend(data);
            }
        })
        .await;
        assert!(
            matches!(event, TaskEvent::Finished { success: true, .. }),
            "{}",
            String::from_utf8_lossy(&bytes)
        );
        assert!(String::from_utf8_lossy(&bytes).contains("orbit v0.1.0 is online"));
    }

    #[tokio::test]
    async fn stops_a_running_process_group() {
        let child = tokio::process::Command::new("/bin/sleep")
            .arg("60")
            .process_group(0)
            .kill_on_drop(true)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let (send, mut receive) = oneshot::channel();
        let mut budget = MAX_OUTPUT;
        send.send(()).unwrap();
        let event = tokio::time::timeout(
            Duration::from_secs(2),
            supervise(OwnedChild::new(child), &mut receive, &mut budget, |_| {}),
        )
        .await
        .unwrap();
        assert!(matches!(
            event,
            TaskEvent::Finished {
                cancelled: true,
                success: false,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn stop_during_pipe_drain_overrides_the_reaped_leaders_result() {
        let child =
            spawn_child(Command::new("/bin/sh").args(["-c", "/bin/sleep 1 & exit 1"])).unwrap();
        let group = child.group.clone();
        let (send, mut receive) = oneshot::channel();
        let result = tokio::spawn(async move {
            let mut budget = MAX_OUTPUT;
            supervise(child, &mut receive, &mut budget, |_| {}).await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while group.armed() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        send.send(()).unwrap();
        assert!(matches!(
            result.await.unwrap(),
            TaskEvent::Finished {
                cancelled: true,
                success: false,
                ..
            }
        ));
    }
}
