use std::{collections::BTreeMap, sync::Mutex};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, State,
};

use crate::CommandResult;

type Item = (&'static str, &'static str, Option<&'static str>);

#[derive(Default)]
pub(crate) struct MenuState(Mutex<Projection>);

#[derive(Default)]
struct Projection {
    generation: u64,
    revision: u64,
    items: BTreeMap<String, MenuItem<tauri::Wry>>,
}

impl Projection {
    fn begin_document(&mut self) {
        self.generation += 1;
        self.revision = 0;
    }

    fn accept_update(&mut self, generation: u64, revision: u64) -> bool {
        if self.generation != generation || revision <= self.revision {
            return false;
        }
        self.revision = revision;
        true
    }

    fn current_command<'a>(&self, item_id: &'a str) -> Option<&'a str> {
        let (generation, command) = item_id.strip_prefix("irongo:")?.split_once(':')?;
        (self.revision != 0 && generation.parse::<u64>().ok() == Some(self.generation))
            .then_some(command)
    }
}

pub(crate) fn build(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let state = app.state::<MenuState>();
    let generation = state.0.lock().unwrap().generation;
    let menu = Menu::default(app)?;
    let defaults = menu.items()?;
    let submenu = |name| {
        defaults
            .iter()
            .filter_map(|item| item.as_submenu())
            .find(|submenu| submenu.text().is_ok_and(|text| text == name))
            .ok_or(tauri::Error::AssetNotFound(format!("Native {name} menu")))
    };
    let native_id = |id: &str| format!("irongo:{generation}:{id}");
    let settings = MenuItem::with_id(
        app,
        native_id("settings"),
        "Settings…",
        false,
        Some("Cmd+,"),
    )?;
    if let Some(app_menu) = defaults.first().and_then(|item| item.as_submenu()) {
        app_menu.insert(&settings, 1)?;
    }
    let mut items = BTreeMap::from([("settings".to_owned(), settings)]);
    let mut add = |menu: &Submenu<tauri::Wry>, at: usize, entries: &[Item]| -> tauri::Result<()> {
        for (index, &(id, title, accelerator)) in entries.iter().enumerate() {
            let item = MenuItem::with_id(app, native_id(id), title, false, accelerator)?;
            menu.insert(&item, at + index)?;
            items.insert(id.to_owned(), item);
        }
        Ok(())
    };
    let file = submenu("File")?;
    file.insert(&PredefinedMenuItem::separator(app)?, 0)?;
    add(
        file,
        0,
        &[
            ("new-project", "New Project…", Some("Cmd+N")),
            ("open-project", "Open Project…", Some("Cmd+O")),
            ("recent", "Open Recent…", None),
            ("close-project", "Close Project", None),
        ],
    )?;
    file.insert(&PredefinedMenuItem::separator(app)?, 4)?;
    add(
        file,
        5,
        &[
            ("new-file", "New File…", None),
            ("save", "Save File", None),
            ("save-all", "Save All", None),
            ("reload", "Reload File from Disk", None),
        ],
    )?;
    let edit = submenu("Edit")?;
    add(
        edit,
        edit.items()?.len(),
        &[
            ("find", "Find…", None),
            ("format", "Format Go File", None),
            ("organize", "Organize Imports", None),
            ("rename", "Rename Go Symbol…", None),
        ],
    )?;
    let view = submenu("View")?;
    add(
        view,
        view.items()?.len(),
        &[
            ("explorer", "Explorer", None),
            ("search", "Search Saved Files…", None),
            ("sidebar", "Toggle Sidebar", None),
            ("panel", "Toggle Bottom Panel", None),
            ("commands", "Command Palette…", None),
        ],
    )?;
    let go = Submenu::new(app, "Go", true)?;
    add(
        &go,
        0,
        &[
            ("back", "Back", None),
            ("forward", "Forward", None),
            ("quick-open", "Go to File…", None),
            ("line", "Go to Line…", None),
            ("symbol", "Go to Symbol in File…", None),
            ("definition", "Go to Definition", None),
            ("references", "Find References", None),
            ("next-editor", "Next Editor", None),
            ("previous-editor", "Previous Editor", None),
        ],
    )?;
    let run = Submenu::new(app, "Run", true)?;
    add(
        &run,
        0,
        &[
            ("run", "Run Selected Target", None),
            ("build", "Build Packages", None),
            ("test", "Run Tests", None),
            ("test-at-cursor", "Run Test at Cursor", None),
            ("debug", "Debug Go Program", None),
            ("debug-test", "Debug Test at Cursor", None),
            ("stop", "Stop Task", None),
            ("shell", "Start Shell", None),
            ("run-in-terminal", "Run Go Program in Terminal", None),
            ("close-terminal", "Close Terminal…", None),
        ],
    )?;
    let window = submenu("Window")?;
    // The pinned default Window menu ends in a separator and a second Close.
    window.remove_at(3)?;
    window.remove_at(2)?;
    let at = defaults
        .iter()
        .position(|item| item.id() == window.id())
        .unwrap_or(defaults.len());
    menu.insert(&go, at)?;
    menu.insert(&run, at + 1)?;
    app.state::<MenuState>().0.lock().unwrap().items = items;
    Ok(menu)
}

pub(crate) fn reset(app: &AppHandle) {
    let state = app.state::<MenuState>();
    let mut projection = state.0.lock().unwrap();
    projection.begin_document();
    for item in projection.items.values() {
        let _ = item.set_enabled(false);
    }
    drop(projection);
    // Tauri queues only the native item ID. Give the replacement document
    // distinct IDs so a queued click from the old menu cannot be relabeled.
    if let Err(error) = build(app).and_then(|menu| app.set_menu(menu)) {
        eprintln!("Restore workbench menu: {error}");
    }
}

pub(crate) fn dispatch(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let state = app.state::<MenuState>();
    let projection = state.0.lock().unwrap();
    let Some(id) = projection.current_command(event.id().as_ref()) else {
        return;
    };
    if projection.items.contains_key(id) {
        let _ = app.emit_to("main", "iron-go-menu", (projection.generation, id));
    }
}

#[tauri::command]
pub fn workbench_menu_generation(state: State<'_, MenuState>) -> u64 {
    state.0.lock().unwrap().generation
}

#[tauri::command]
pub async fn update_workbench_menu(
    app: AppHandle,
    generation: u64,
    revision: u64,
    enabled: Vec<String>,
) -> CommandResult<()> {
    let window_app = app.clone();
    app.run_on_main_thread(move || {
        let state = window_app.state::<MenuState>();
        let mut projection = state.0.lock().unwrap();
        if !projection.accept_update(generation, revision) {
            return;
        }
        for (id, item) in &projection.items {
            let _ = item.set_enabled(enabled.contains(id));
        }
    })
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_current_document_can_advance_the_menu_revision() {
        let mut projection = Projection::default();
        projection.begin_document();
        assert!(projection.accept_update(1, 3));
        assert!(!projection.accept_update(1, 2));
        assert!(!projection.accept_update(1, 3));
        assert!(!projection.accept_update(2, 100));
        assert!(projection.accept_update(1, 4));
        projection.begin_document();
        assert!(!projection.accept_update(1, 100));
        assert!(!projection.accept_update(2, 0));
        assert!(projection.accept_update(2, 1));
    }

    #[test]
    fn a_queued_click_cannot_cross_the_document_boundary() {
        let mut projection = Projection::default();
        projection.begin_document();
        let old_click = "irongo:1:save";
        assert_eq!(projection.current_command(old_click), None);
        assert!(projection.accept_update(1, 1));
        assert_eq!(projection.current_command(old_click), Some("save"));
        projection.begin_document();
        let new_click = "irongo:2:save";
        assert_eq!(projection.current_command(new_click), None);
        assert!(projection.accept_update(2, 1));
        assert_eq!(projection.current_command(old_click), None);
        assert_eq!(projection.current_command(new_click), Some("save"));
        assert_eq!(projection.current_command("quit"), None);
        assert_eq!(projection.current_command("irongo:invalid:save"), None);
    }
}
