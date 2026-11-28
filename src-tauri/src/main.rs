#[cfg(feature = "e2e")]
mod acceptance;
mod debug;
mod debug_program;
mod drafts;
mod go_source;
mod lsp;
mod packages;
mod process_owner;
mod quit;
mod recent;
mod tasks;
mod terminal;
mod tool_transport;
mod tools;
mod workspace;
mod workspace_disk;
mod workspace_files;

use std::{path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager};
use workspace::Workspace;

type CommandResult<T> = Result<T, String>;

#[derive(Default)]
struct Core(
    Mutex<Session>,
    #[cfg(feature = "e2e")] workspace::TestSaveHold,
    #[cfg(feature = "e2e")] std::sync::Condvar,
);

#[derive(Default)]
struct Session {
    serial: u64,
    workspace: Option<Workspace>,
    recent: Option<recent::AdmittedRecent>,
    watcher: Option<workspace_disk::WorkspaceWatch>,
    task: Option<tasks::RunningTask>,
    run_directories: std::collections::BTreeMap<u64, PathBuf>,
    discovery: Option<packages::Discovery>,
    lsp: Option<tool_transport::RunningServer>,
    debug: Option<tool_transport::RunningServer>,
    program_debug: Option<debug_program::ProgramDebug>,
    terminal: Option<terminal::Owner>,
    terminal_cutover: bool,
    #[cfg(feature = "e2e")]
    acceptance: acceptance::Admission,
}

impl Session {
    fn next_id(&mut self) -> u64 {
        self.serial += 1;
        self.serial
    }

    fn root(&self, id: u64) -> CommandResult<&std::path::Path> {
        #[cfg(feature = "e2e")]
        self.acceptance.check()?;
        self.workspace
            .as_ref()
            .filter(|workspace| workspace.info.id == id)
            .map(|workspace| workspace.root.as_path())
            .ok_or_else(|| "The workspace is no longer open.".to_owned())
    }

    fn stop_processes(&mut self) {
        self.request_terminal_stop(None);
        // Dropping the handles closes the workers' cancellation channels.
        if self.request_program_stop(None).is_none() {
            self.task.take();
            self.debug.take();
        }
        self.discovery.take();
        self.lsp.take();
    }

    fn retire_workspace(&mut self) {
        self.workspace.take();
        self.recent.take();
        self.watcher.take();
        self.stop_processes();
    }

    fn retire_on_exit(&mut self) {
        self.retire_workspace();
        self.clean_run_directories();
    }

    fn clean_run_directories(&mut self) {
        for (_, directory) in std::mem::take(&mut self.run_directories) {
            let _ = std::fs::remove_dir_all(directory);
        }
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> CommandResult<T> + Send + 'static,
) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

async fn pick_folder(title: &'static str) -> CommandResult<Option<PathBuf>> {
    // On macOS RFD's async picker automatically attaches a sheet to the
    // main window, even without an explicit parent. The synchronous picker
    // presents an independent NSOpenPanel; RFD dispatches it to AppKit.
    blocking(move || Ok(rfd::FileDialog::new().set_title(title).pick_folder())).await
}

fn install_workspace(
    state: &Core,
    workspace: Workspace,
    retirement: Option<(&AppHandle, drafts::Retirement)>,
    history: Option<&AppHandle>,
) -> CommandResult<workspace::WorkspaceInfo> {
    let mut session = state.0.lock().unwrap();
    let restore = session
        .workspace
        .as_ref()
        .is_none_or(|active| active.root != workspace.root);
    install_workspace_locked(&mut session, workspace, retirement)?;
    let info = session.workspace.as_ref().unwrap().info.clone();
    drop(session);
    Ok(if let Some(app) = history {
        recent::remember(app, state, info, restore)
    } else {
        info
    })
}

fn install_workspace_locked(
    session: &mut Session,
    mut workspace: Workspace,
    retirement: Option<(&AppHandle, drafts::Retirement)>,
) -> CommandResult<()> {
    #[cfg(feature = "e2e")]
    session.acceptance.check()?;
    if let Some((app, plan)) = retirement {
        let outgoing = session
            .workspace
            .as_ref()
            .ok_or("The outgoing project is no longer open.")?;
        drafts::retire_project(app, outgoing, plan, || {
            workspace.anchor.verify(&workspace.root)
        })?;
    } else {
        workspace.anchor.verify(&workspace.root)?;
    }
    session.retire_workspace();
    workspace.info.id = session.next_id();
    session.workspace = Some(workspace);
    Ok(())
}

#[tauri::command]
async fn open_workspace(
    app: AppHandle,
    retirement: Option<drafts::Retirement>,
) -> CommandResult<Option<workspace::WorkspaceInfo>> {
    #[cfg(feature = "e2e")]
    let fixture = std::env::var_os("IRON_GO_E2E_WORKSPACE").map(PathBuf::from);
    #[cfg(feature = "e2e")]
    if fixture.is_some()
        && std::mem::take(
            &mut app
                .state::<Core>()
                .0
                .lock()
                .unwrap()
                .acceptance
                .cancel_next_picker,
        )
    {
        return Ok(None);
    }
    #[cfg(not(feature = "e2e"))]
    let fixture = None;
    let selection = match fixture {
        Some(path) => Some(path),
        None => pick_folder("Open Project").await?,
    };
    let Some(root) = selection else {
        return Ok(None);
    };
    let workspace = blocking(move || Workspace::open(&root)).await?;
    let fence = terminal::fence_cutover(&app, None).await?;
    blocking(move || {
        let _fence = fence;
        install_workspace(
            app.state::<Core>().inner(),
            workspace,
            retirement.map(|plan| (&app, plan)),
            Some(&app),
        )
        .map(Some)
    })
    .await
}

#[tauri::command]
async fn new_module(
    app: AppHandle,
    name: String,
    module: String,
    retirement: Option<drafts::Retirement>,
) -> CommandResult<Option<workspace::WorkspaceInfo>> {
    workspace::validate_module(&name, &module)?;
    #[cfg(feature = "e2e")]
    let fixture_parent = std::env::var_os("IRON_GO_E2E_WORKSPACE").and_then(|path| {
        PathBuf::from(path)
            .parent()
            .map(std::path::Path::to_path_buf)
    });
    #[cfg(not(feature = "e2e"))]
    let fixture_parent = None;
    let selection = match fixture_parent {
        Some(path) => Some(path),
        None => pick_folder("Choose a Location for the New Go Project").await?,
    };
    let Some(parent) = selection else {
        return Ok(None);
    };
    let intended = parent.join(&name);
    let workspace = blocking(move || workspace::create_module(&parent, &name, &module)).await?;
    let fence = terminal::fence_cutover(&app, None).await?;
    blocking(move || {
        let _fence = fence;
        install_workspace(
            app.state::<Core>().inner(),
            workspace,
            retirement.map(|plan| (&app, plan)),
            Some(&app),
        )
        .map(Some)
        .map_err(|error| {
            format!(
                "Project created in {}. The open project was retained: {error}",
                intended.display()
            )
        })
    })
    .await
}

#[tauri::command]
async fn close_workspace(
    app: AppHandle,
    id: u64,
    retirement: Option<drafts::Retirement>,
) -> CommandResult<()> {
    app.state::<Core>().0.lock().unwrap().root(id)?;
    let fence = terminal::fence_cutover(&app, None).await?;
    blocking(move || {
        let _fence = fence;
        let core = app.state::<Core>();
        let mut session = core.0.lock().unwrap();
        session.root(id)?;
        if let Some(plan) = retirement {
            drafts::retire_project(&app, session.workspace.as_ref().unwrap(), plan, || Ok(()))?;
        }
        session.retire_workspace();
        Ok(())
    })
    .await
}

fn main() {
    #[cfg(all(feature = "e2e", not(debug_assertions)))]
    compile_error!("The native test driver is for debug builds only.");

    let builder = tauri::Builder::default();
    #[cfg(feature = "e2e")]
    let builder = if let (Ok(port), Some(_)) = (
        std::env::var("TAURI_WEBDRIVER_PORT")
            .unwrap_or_default()
            .parse::<u16>(),
        std::env::var_os("IRON_GO_E2E_WORKSPACE"),
    ) {
        builder.plugin(tauri_plugin_wdio_webdriver::init_with_port(port))
    } else {
        builder
    };

    builder
        .manage(Core::default())
        .manage(drafts::DraftRuntime::default())
        .manage(quit::ExitGate::default())
        .setup(|app| {
            quit::install(app.handle())?;
            #[cfg(feature = "e2e")]
            acceptance::watch(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            new_module,
            close_workspace,
            workspace::snapshot,
            workspace::read_file,
            workspace::inspect_file,
            workspace::go_source_revision,
            go_source::read_go_source,
            workspace_disk::start_workspace_watch,
            workspace_disk::wait_workspace_watch,
            workspace::save_file,
            workspace::save_new_file,
            workspace_files::inspect_file_operation,
            workspace_files::mutate_workspace_files,
            drafts::write_draft,
            drafts::retire_draft,
            drafts::list_drafts,
            drafts::recover_draft,
            drafts::remove_draft,
            #[cfg(feature = "e2e")]
            drafts::test_hold_draft_profile,
            recent::list_recent,
            recent::open_recent,
            recent::write_editor_session,
            recent::forget_recent,
            terminal::start_terminal,
            terminal::stop_terminal,
            terminal::terminal_input,
            terminal::terminal_ack,
            terminal::terminal_resize,
            #[cfg(feature = "e2e")]
            terminal::test_terminal_observation,
            workspace::create_file,
            workspace::search_files,
            tools::go_tools,
            tools::format_go,
            tasks::start_task,
            tasks::stop_task,
            packages::discover_packages,
            lsp::start_gopls,
            lsp::send_gopls,
            lsp::stop_gopls,
            debug::start_debug,
            debug_program::start_program_debug,
            debug_program::stop_program_debug,
            debug::send_debug,
            debug::stop_debug,
            quit::resolve_app_exit,
            quit::present_app_exit,
            #[cfg(feature = "e2e")]
            quit::test_quit_menu_action,
            #[cfg(feature = "e2e")]
            quit::test_perform_window_close,
            #[cfg(feature = "e2e")]
            quit::test_quit_window_state,
            #[cfg(feature = "e2e")]
            quit::test_quit_deadline,
            #[cfg(feature = "e2e")]
            workspace::test_hold_save,
            #[cfg(feature = "e2e")]
            acceptance::test_cancel_next_picker,
            #[cfg(feature = "e2e")]
            acceptance::test_hold_debug_disconnect,
            #[cfg(feature = "e2e")]
            acceptance::test_draft_quit,
            #[cfg(feature = "e2e")]
            tasks::test_run_handoff,
        ])
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                api.prevent_close();
                quit::request_termination();
            }
            tauri::WindowEvent::Destroyed => {
                window.state::<Core>().0.lock().unwrap().retire_on_exit();
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("could not initialize Iron Go")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                drafts::commit_quit(app);
                app.state::<Core>().0.lock().unwrap().retire_on_exit();
            }
        });
}
