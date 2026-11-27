#[cfg(feature = "e2e")]
mod acceptance;
mod debug;
mod lsp;
mod packages;
mod process_owner;
mod quit;
mod tasks;
mod tool_transport;
mod tools;
mod workspace;
mod workspace_disk;

use std::{path::PathBuf, sync::Mutex};
use tauri::{Manager, State};
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
    watcher: Option<workspace_disk::WorkspaceWatch>,
    task: Option<tasks::RunningTask>,
    discovery: Option<packages::Discovery>,
    lsp: Option<tool_transport::RunningServer>,
    debug: Option<tool_transport::RunningServer>,
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
        // Dropping the handles closes the workers' cancellation channels.
        self.task.take();
        self.discovery.take();
        self.lsp.take();
        self.debug.take();
    }

    fn retire_workspace(&mut self) {
        self.workspace.take();
        self.watcher.take();
        self.stop_processes();
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
    mut workspace: Workspace,
) -> CommandResult<workspace::WorkspaceInfo> {
    let mut session = state.0.lock().unwrap();
    #[cfg(feature = "e2e")]
    session.acceptance.check()?;
    session.retire_workspace();
    workspace.info.id = session.next_id();
    let info = workspace.info.clone();
    session.workspace = Some(workspace);
    Ok(info)
}

#[tauri::command]
async fn open_workspace(state: State<'_, Core>) -> CommandResult<Option<workspace::WorkspaceInfo>> {
    #[cfg(feature = "e2e")]
    let fixture = std::env::var_os("IRON_GO_E2E_WORKSPACE").map(PathBuf::from);
    #[cfg(feature = "e2e")]
    if fixture.is_some()
        && std::mem::take(&mut state.0.lock().unwrap().acceptance.cancel_next_picker)
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
    install_workspace(&state, workspace).map(Some)
}

#[tauri::command]
async fn new_module(
    state: State<'_, Core>,
    name: String,
    module: String,
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
    let workspace = blocking(move || workspace::create_module(&parent, &name, &module)).await?;
    install_workspace(&state, workspace).map(Some)
}

#[tauri::command]
fn close_workspace(state: State<'_, Core>, id: u64) -> CommandResult<()> {
    let mut session = state.0.lock().unwrap();
    session.root(id)?;
    session.retire_workspace();
    Ok(())
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
            workspace_disk::start_workspace_watch,
            workspace_disk::wait_workspace_watch,
            workspace::save_file,
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
        ])
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                api.prevent_close();
                quit::request_termination();
            }
            tauri::WindowEvent::Destroyed => {
                window.state::<Core>().0.lock().unwrap().retire_workspace();
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("could not initialize Iron Go")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<Core>().0.lock().unwrap().retire_workspace();
            }
        });
}
