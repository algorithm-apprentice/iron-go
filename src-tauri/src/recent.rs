use std::{
    fs::File,
    io,
    sync::MutexGuard,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
    blocking,
    drafts::{
        commit_index, open_profile, open_profile_lock, read_json, stage_record, unique, unlink,
        ProjectKey, Retirement,
    },
    install_workspace_locked,
    quit::live_ticket,
    workspace::{components, Workspace, WorkspaceInfo},
    CommandResult, Core, Session,
};

const MAX_INDEX: u64 = 1024 * 1024;
const PROJECTS: usize = 20;
const TABS: usize = 32;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTab {
    path: String,
    line: u32,
    column: u32,
    first_line: u32,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct EditorSession {
    tabs: Vec<SavedTab>,
    active: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct Entry {
    id: String,
    key: ProjectKey,
    name: String,
    visited: u64,
    editor: Option<EditorSession>,
}

#[derive(Deserialize, Serialize)]
struct History {
    schema: u8,
    entries: Vec<Entry>,
}

impl Default for History {
    fn default() -> Self {
        Self {
            schema: 1,
            entries: Vec::new(),
        }
    }
}

pub(crate) struct AdmittedRecent {
    id: String,
    revision: u64,
}

#[derive(Serialize)]
pub struct RecentItem {
    id: String,
    name: String,
    path: String,
}

fn profile(app: &AppHandle) -> CommandResult<File> {
    open_profile(app, "recent-v1").map_err(problem)
}

fn problem(error: impl std::fmt::Display) -> String {
    format!("Recent projects: {error}")
}

fn validate_path(path: &str) -> bool {
    path.len() <= 1024 && components(path).is_ok()
}

impl EditorSession {
    fn valid(&self) -> bool {
        self.tabs.len() <= TABS
            && self.tabs.iter().all(|tab| {
                validate_path(&tab.path)
                    && [tab.line, tab.column, tab.first_line]
                        .into_iter()
                        .all(|value| (1..=i32::MAX as u32).contains(&value))
            })
            && self
                .active
                .as_ref()
                .is_none_or(|active| self.tabs.iter().any(|tab| &tab.path == active))
    }
}

impl History {
    fn read(profile: &File) -> CommandResult<Self> {
        let history: Self = match read_json(profile, "index.json", MAX_INDEX) {
            Ok(history) => history,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(error) => return Err(problem(error)),
        };
        if history.schema != 1
            || history.entries.len() > PROJECTS
            || history.entries.iter().any(|entry| {
                entry.id.is_empty()
                    || entry.id.len() > 96
                    || entry.name.len() > 512
                    || entry.key.path.to_str().is_none_or(|path| path.len() > 4096)
                    || !entry.key.path.is_absolute()
                    || entry.editor.as_ref().is_some_and(|editor| !editor.valid())
            })
        {
            return Err(
                "The recent project history is invalid. Clear it to start a new history.".into(),
            );
        }
        Ok(history)
    }

    fn store(
        &self,
        profile: &File,
        check: impl FnOnce() -> CommandResult<()>,
    ) -> CommandResult<()> {
        let stage = stage_record(profile, self, MAX_INDEX).map_err(problem)?;
        if let Err(error) = check() {
            let _ = unlink(profile, &stage, 0);
            return Err(error);
        }
        commit_index(profile, &stage).map_err(problem)
    }

    fn remember(&mut self, workspace: &Workspace) -> CommandResult<Entry> {
        let key = ProjectKey::new(&workspace.root, &workspace.anchor)?;
        let name = &workspace.info.name;
        if name.len() > 512 || key.path.to_str().is_none_or(|path| path.len() > 4096) {
            return Err("The project path is too long to remember.".into());
        }
        let mut entry = self
            .entries
            .iter()
            .position(|entry| entry.key == key)
            .map(|index| self.entries.remove(index))
            .unwrap_or_else(|| Entry {
                id: unique("recent-"),
                key,
                name: name.clone(),
                visited: 0,
                editor: None,
            });
        entry.visited = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        self.entries.insert(0, entry.clone());
        self.entries.truncate(PROJECTS);
        Ok(entry)
    }

    fn update(&mut self, admitted: &AdmittedRecent, revision: u64, editor: EditorSession) -> bool {
        if revision <= admitted.revision {
            return false;
        }
        let Some(entry) = self
            .entries
            .iter_mut()
            .find(|entry| entry.id == admitted.id)
        else {
            return false;
        };
        entry.editor = Some(editor);
        true
    }
}

fn lock_session<'a>(
    state: &'a Core,
    profile: &File,
    quit: bool,
) -> CommandResult<(MutexGuard<'a, Session>, File)> {
    let deadline = Instant::now()
        + if quit {
            Duration::ZERO
        } else {
            Duration::from_secs(2)
        };
    loop {
        if let Ok(session) = state.0.try_lock() {
            match open_profile_lock(profile, true) {
                Ok(lock) => return Ok((session, lock)),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => (),
                Err(error) => return Err(problem(error)),
            }
        }
        if Instant::now() >= deadline {
            return Err("Recent project storage is busy; the previous state was kept.".into());
        }
        // Never hold the workspace mutex while waiting for another writer.
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub(crate) fn remember(
    app: &AppHandle,
    state: &Core,
    info: WorkspaceInfo,
    restore: bool,
) -> WorkspaceInfo {
    let result = (|| {
        let profile = profile(app)?;
        let (mut session, _lock) = lock_session(state, &profile, false)?;
        session.root(info.id)?;
        let mut history = History::read(&profile)?;
        let entry = history.remember(session.workspace.as_ref().unwrap())?;
        history.store(&profile, || Ok(()))?;
        session.recent = Some(AdmittedRecent {
            id: entry.id,
            revision: 0,
        });
        let mut info = info.clone();
        if restore {
            info.editor_session = entry.editor;
        }
        Ok::<_, String>(info)
    })();
    result.unwrap_or_else(|error| {
        let mut info = info;
        info.recent_error = Some(error);
        info
    })
}

#[tauri::command]
pub async fn list_recent(app: AppHandle) -> CommandResult<Vec<RecentItem>> {
    blocking(move || {
        let profile = profile(&app)?;
        let _lock = open_profile_lock(&profile, false).map_err(problem)?;
        Ok(History::read(&profile)?
            .entries
            .into_iter()
            .map(|entry| RecentItem {
                id: entry.id,
                name: entry.name,
                path: entry.key.path.to_string_lossy().into_owned(),
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn open_recent(
    app: AppHandle,
    entry: String,
    retirement: Option<Retirement>,
) -> CommandResult<WorkspaceInfo> {
    let prepared = {
        let app = app.clone();
        let entry = entry.clone();
        blocking(move || {
            let profile = profile(&app)?;
            let _lock = open_profile_lock(&profile, false).map_err(problem)?;
            let history = History::read(&profile)?;
            let stored = history.entries.iter().find(|item| item.id == entry).ok_or("This recent project is no longer in the history.")?;
            let workspace = Workspace::open(&stored.key.path).map_err(|error| format!("This recent project is unavailable. Use Open Project to select its location: {error}"))?;
            if ProjectKey::new(&workspace.root, &workspace.anchor)? != stored.key {
                return Err("This recent folder was replaced. Use Open Project to admit the new location.".into());
            }
            Ok(workspace)
        }).await?
    };
    let fence = crate::terminal::fence_cutover(&app, None).await?;
    blocking(move || {
        let _fence = fence;
        let state = app.state::<Core>();
        let profile = profile(&app)?;
        let (mut session, _lock) = lock_session(&state, &profile, false)?;
        let mut history = History::read(&profile)?;
        let stored = history
            .entries
            .iter()
            .find(|item| item.id == entry)
            .ok_or("This recent project is no longer in the history.")?;
        let workspace = prepared;
        if ProjectKey::new(&workspace.root, &workspace.anchor)? != stored.key {
            return Err(
                "This recent folder was replaced. Use Open Project to admit the new location."
                    .into(),
            );
        }
        let restore = session
            .workspace
            .as_ref()
            .is_none_or(|active| active.root != workspace.root);
        let stored = stored.clone();
        install_workspace_locked(&mut session, workspace, retirement.map(|plan| (&app, plan)))?;
        session.recent = Some(AdmittedRecent {
            id: stored.id,
            revision: 0,
        });
        let workspace = session.workspace.as_mut().unwrap();
        if restore {
            workspace.info.editor_session = stored.editor;
        }
        if let Err(error) = history
            .remember(workspace)
            .and_then(|_| history.store(&profile, || Ok(())))
        {
            workspace.info.recent_error = Some(error);
        }
        Ok(workspace.info.clone())
    })
    .await
}

#[tauri::command]
pub async fn write_editor_session(
    app: AppHandle,
    id: u64,
    revision: u64,
    editor: EditorSession,
    quit_ticket: Option<u64>,
) -> CommandResult<()> {
    if !editor.valid() || revision == 0 {
        return Err("The editor session is invalid or exceeds its limits.".into());
    }
    blocking(move || {
        let state = app.state::<Core>();
        let profile = profile(&app)?;
        let (mut session, _lock) = lock_session(&state, &profile, quit_ticket.is_some())?;
        session.root(id)?;
        let Some(admitted) = session.recent.as_mut() else {
            return Ok(());
        };
        let mut history = History::read(&profile)?;
        if !history.update(admitted, revision, editor) {
            return Ok(());
        }
        history.store(&profile, || {
            if quit_ticket.is_some_and(|ticket| !live_ticket(&app, ticket)) {
                return Err(
                    "The Quit decision expired before the editor session could be stored.".into(),
                );
            }
            Ok(())
        })?;
        admitted.revision = revision;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn forget_recent(app: AppHandle, entry: Option<String>) -> CommandResult<()> {
    blocking(move || {
        let profile = profile(&app)?;
        let _lock = open_profile_lock(&profile, false).map_err(problem)?;
        let history = if let Some(entry) = entry {
            let mut history = History::read(&profile)?;
            history.entries.retain(|item| item.id != entry);
            history
        } else {
            History::default()
        };
        history.store(&profile, || Ok(()))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stale_writer_cannot_overwrite_the_readded_incarnation() {
        let fixture = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(fixture.path()).unwrap();
        let mut history = History::default();
        let first = history.remember(&workspace).unwrap().id;
        let old_owner = AdmittedRecent {
            id: first,
            revision: 0,
        };
        history.entries.clear();
        let replacement = history.remember(&workspace).unwrap().id;
        assert_ne!(replacement, old_owner.id);
        let data = EditorSession {
            tabs: vec![SavedTab {
                path: "test.go".into(),
                line: 12,
                column: 3,
                first_line: 6,
            }],
            active: Some("test.go".into()),
        };
        assert!(!history.update(&old_owner, 100, data.clone()));
        assert!(history.entries[0].editor.is_none());
        assert!(history.update(
            &AdmittedRecent {
                id: replacement,
                revision: 1
            },
            2,
            data
        ));
    }
}
