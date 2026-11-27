use std::{
    collections::hash_map::DefaultHasher,
    fs::{self, File, Metadata, OpenOptions, TryLockError},
    hash::{Hash, Hasher},
    io::{self, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

use regex::RegexBuilder;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::workspace_disk::{DiskObservation, RootAnchor};
use crate::{blocking, CommandResult, Core};

pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ENTRIES: usize = 6_000;
const MAX_DEPTH: usize = 40;
const MAX_RESULTS: usize = 200;
const MAX_SEARCH_BYTES: usize = 32 * 1024 * 1024;
const HIDDEN: &[&str] = &[".git", ".DS_Store", "node_modules"];
// Private save names use only ASCII punctuation and digits. The profile
// lock and inode checks, not this string filter, protect stage ownership.
const SAVE_STAGE_PREFIX: &str = ".~73827978-";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub id: u64,
    name: String,
    path: String,
}

pub struct Workspace {
    pub info: WorkspaceInfo,
    pub root: PathBuf,
    pub anchor: RootAnchor,
}

impl Workspace {
    pub fn open(path: &Path) -> CommandResult<Self> {
        let root = path.canonicalize().map_err(fail("Open folder"))?;
        if !root.is_dir() {
            return Err("Select a directory, not a file.".into());
        }
        let path = root
            .to_str()
            .ok_or("The workspace path is not valid UTF-8.")?
            .to_owned();
        let name = root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&path)
            .to_owned();
        let anchor = RootAnchor::new(&root).map_err(fail("Open workspace directory"))?;
        Ok(Self {
            info: WorkspaceInfo { id: 0, name, path },
            root,
            anchor,
        })
    }
}

fn fail(action: &'static str) -> impl FnOnce(io::Error) -> String {
    move |error| format!("{action}: {error}")
}

fn components(relative: &str) -> CommandResult<Vec<&str>> {
    let parts: Vec<_> = relative.split('/').collect();
    if parts.len() > MAX_DEPTH
        || parts.iter().any(|part| {
            part.is_empty() || matches!(*part, "." | "..") || part.contains(['\\', '\0'])
        })
    {
        return Err("Use a relative workspace path without '.' or '..' segments.".into());
    }
    if parts.iter().any(|part| part.starts_with(SAVE_STAGE_PREFIX)) {
        return Err("This path is reserved for temporary saves.".into());
    }
    Ok(parts)
}

fn direct_path(root: &Path, parts: &[&str]) -> CommandResult<PathBuf> {
    let mut target = root.to_path_buf();
    for part in parts {
        target.push(part);
        let meta = fs::symlink_metadata(&target).map_err(fail("Read workspace path"))?;
        if meta.is_symlink() {
            return Err("Symbolic links are not opened by the workbench.".into());
        }
    }
    Ok(target)
}

fn read_text(root: &Path, relative: &str, limit: u64) -> CommandResult<String> {
    let path = direct_path(root, &components(relative)?)?;
    let mut text = String::new();
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(OPEN_REGULAR)
        .open(&path)
        .map_err(fail("Open file"))?;
    let info = regular_file(&file, "Read file")?;
    if info.len() > limit {
        return Err("Open a regular text file smaller than the size limit (2 MB).".into());
    }
    file.take(limit + 1)
        .read_to_string(&mut text)
        .map_err(fail("Read UTF-8 text"))?;
    if text.as_bytes().contains(&0) || text.len() as u64 > limit {
        return Err("Binary or oversized files cannot be opened in the editor.".into());
    }
    Ok(text)
}

const SAVE_LOCK: &str = "save.lock";
const OPEN_REGULAR: libc::c_int = libc::O_NOFOLLOW | libc::O_NONBLOCK;
const SAVE_CONFLICT: &str = "The file changed on disk. Reload the tab before saving.";

fn file_identity(info: &Metadata) -> (u64, u64) {
    (info.dev(), info.ino())
}

fn regular_file(file: &File, action: &'static str) -> CommandResult<Metadata> {
    let info = file.metadata().map_err(fail(action))?;
    if !info.is_file() {
        return Err(format!("{action}: expected a regular file."));
    }
    Ok(info)
}

fn open_save_target(path: &Path) -> CommandResult<(File, Metadata)> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(OPEN_REGULAR)
        .open(path)
        .map_err(fail("Open save target"))?;
    let info = regular_file(&file, "Read save target")?;
    Ok((file, info))
}

fn distinct_from_lock(info: &Metadata, lock_info: &Metadata) -> CommandResult<()> {
    if file_identity(info) == file_identity(lock_info) {
        return Err("The app profile's save lock is reserved.".into());
    }
    Ok(())
}

struct SaveStage(Option<tempfile::NamedTempFile>);

impl SaveStage {
    fn new(parent: &Path) -> CommandResult<Self> {
        let temp = tempfile::Builder::new()
            .prefix(SAVE_STAGE_PREFIX)
            // Only our identity-aware guard may remove this name.
            .disable_cleanup(true)
            .tempfile_in(parent)
            .map_err(fail("Prepare save"))?;
        Ok(Self(Some(temp)))
    }

    fn owns_path(temp: &tempfile::NamedTempFile) -> bool {
        let Ok(opened) = temp.as_file().metadata() else {
            return false;
        };
        fs::symlink_metadata(temp.path()).is_ok_and(|at_path| {
            at_path.is_file() && file_identity(&opened) == file_identity(&at_path)
        })
    }

    fn verify(&self) -> CommandResult<()> {
        if Self::owns_path(self.0.as_ref().unwrap()) {
            Ok(())
        } else {
            Err("The temporary save file was replaced. No changes were saved.".into())
        }
    }

    fn persist(mut self, path: &Path) -> CommandResult<()> {
        match self.0.take().unwrap().persist(path) {
            Ok(_) => Ok(()),
            Err(error) => {
                self.0 = Some(error.file);
                Err(fail("Save file")(error.error))
            }
        }
    }
}

impl Drop for SaveStage {
    fn drop(&mut self) {
        if let Some(temp) = self.0.as_ref().filter(|temp| Self::owns_path(temp)) {
            let _ = fs::remove_file(temp.path());
        }
    }
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum SavePoint {
    BeforeStage,
    Staged,
    Contended,
    Validated,
}

fn persist_text(
    root: &Path,
    data_dir: &Path,
    relative: &str,
    expected: &str,
    text: &str,
) -> CommandResult<()> {
    persist_text_impl(
        root,
        data_dir,
        relative,
        expected,
        text,
        #[cfg(test)]
        &mut |_| Ok(()),
    )
}

fn persist_text_impl(
    root: &Path,
    data_dir: &Path,
    relative: &str,
    expected: &str,
    text: &str,
    #[cfg(test)] observe: &mut impl FnMut(SavePoint) -> CommandResult<()>,
) -> CommandResult<()> {
    if text.len() as u64 > MAX_FILE_BYTES || text.as_bytes().contains(&0) {
        return Err("Save a UTF-8 text file smaller than 2 MB.".into());
    }
    let parts = components(relative)?;
    let path = direct_path(root, &parts)?;
    fs::create_dir_all(data_dir).map_err(fail("Prepare save lock directory"))?;
    // Keep this file and inode stable for all cooperating writers in the
    // profile, including when a workspace encloses the data directory.
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(OPEN_REGULAR)
        .open(data_dir.join(SAVE_LOCK))
        .map_err(fail("Open save lock"))?;
    let lock_info = regular_file(&lock, "Read save lock")?;
    // Keep the original handle alive so its inode cannot be reused during
    // this transaction, even if the destination is replaced while waiting.
    let (_initial, staged_info) = open_save_target(&path)?;
    distinct_from_lock(&staged_info, &lock_info)?;
    match lock.try_lock() {
        Ok(()) => (),
        Err(TryLockError::WouldBlock) => {
            #[cfg(test)]
            observe(SavePoint::Contended)?;
            lock.lock().map_err(fail("Acquire save lock"))?;
        }
        Err(TryLockError::Error(error)) => return Err(fail("Acquire save lock")(error)),
    }
    #[cfg(test)]
    observe(SavePoint::BeforeStage)?;
    let mut stage = SaveStage::new(path.parent().unwrap())?;
    let temp = stage.0.as_mut().unwrap();
    temp.write_all(text.as_bytes())
        .map_err(fail("Write file"))?;
    temp.as_file()
        .set_permissions(staged_info.permissions())
        .map_err(fail("Set file permissions"))?;
    #[cfg(test)]
    observe(SavePoint::Staged)?;
    let (destination, final_info) = open_save_target(&direct_path(root, &parts)?)?;
    distinct_from_lock(&final_info, &lock_info)?;
    if file_identity(&final_info) != file_identity(&staged_info)
        || final_info.len() > MAX_FILE_BYTES
    {
        return Err(SAVE_CONFLICT.into());
    }
    let mut bytes = Vec::new();
    destination
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(fail("Read save target"))?;
    if bytes != expected.as_bytes() || bytes.len() as u64 > MAX_FILE_BYTES || bytes.contains(&0) {
        return Err(SAVE_CONFLICT.into());
    }
    let current =
        fs::symlink_metadata(direct_path(root, &parts)?).map_err(fail("Read save target"))?;
    distinct_from_lock(&current, &lock_info)?;
    if !current.is_file() || file_identity(&current) != file_identity(&final_info) {
        return Err(SAVE_CONFLICT.into());
    }
    stage.verify()?;
    #[cfg(test)]
    observe(SavePoint::Validated)?;
    stage.persist(&path)
}

fn new_file(root: &Path, anchor: &RootAnchor, relative: &str) -> CommandResult<()> {
    let parts = components(relative)?;
    if parts.iter().any(|part| HIDDEN.contains(part)) {
        return Err("This path is excluded from the workspace tree.".into());
    }
    anchor.create_file(root, &parts)
}

pub fn validate_module(name: &str, module: &str) -> CommandResult<()> {
    let valid_segment = |part: &str| {
        !part.is_empty()
            && part.starts_with(|c: char| c.is_ascii_alphanumeric())
            && part.ends_with(|c: char| c.is_ascii_alphanumeric())
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    };
    if name.len() > 80 || !valid_segment(name) {
        return Err("Use a folder name such as 'hello-go' (letters, digits, -, _ or .).".into());
    }
    if module.len() > 240 || !module.split('/').all(valid_segment) {
        return Err("Use a Go module path such as 'example.com/hello-go'.".into());
    }
    Ok(())
}

pub fn create_module(parent: &Path, name: &str, module: &str) -> CommandResult<Workspace> {
    validate_module(name, module)?;
    let path = parent.join(name);
    fs::create_dir(&path).map_err(fail("Create module folder"))?;
    let files = [
        ("go.mod", format!("module {module}\n\ngo 1.22\n")),
        ("main.go", "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tfmt.Println(\"Hello from Iron Go!\")\n}\n".to_owned()),
    ];
    // create_new also protects a file added by another process during setup.
    for (name, text) in files {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path.join(name))
            .and_then(|mut file| file.write_all(text.as_bytes()))
            .map_err(fail("Write starter module"))?;
    }
    Workspace::open(&path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    path: String,
    directory: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    entries: Vec<Entry>,
    truncated: bool,
    module: Option<String>,
    go_work: bool,
    package_revision: Option<String>,
}

pub fn excluded_name(name: &str) -> bool {
    HIDDEN.contains(&name) || name.contains('\\') || name.starts_with(SAVE_STAGE_PREFIX)
}

fn collect(root: &Path) -> CommandResult<Snapshot> {
    let mut entries = Vec::new();
    let mut folders = vec![(String::new(), 0)];
    let mut truncated = false;
    'walk: while let Some((folder, depth)) = folders.pop() {
        let batch = match fs::read_dir(root.join(&folder)) {
            Ok(batch) => batch,
            Err(_) if !folder.is_empty() => continue,
            Err(error) => return Err(fail("List workspace")(error)),
        };
        for item in batch.flatten() {
            let name = item.file_name();
            let Some(name) = name.to_str() else { continue };
            if excluded_name(name) {
                continue;
            }
            let Ok(kind) = item.file_type() else { continue };
            if !kind.is_dir() && !kind.is_file() {
                continue;
            }
            if entries.len() == MAX_ENTRIES {
                truncated = true;
                break 'walk;
            }
            let path = if folder.is_empty() {
                name.to_owned()
            } else {
                format!("{folder}/{name}")
            };
            if kind.is_dir() {
                if depth + 1 < MAX_DEPTH {
                    folders.push((path.clone(), depth + 1));
                } else {
                    truncated = true;
                }
            }
            entries.push(Entry {
                path,
                directory: kind.is_dir(),
            });
        }
    }
    entries.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    let module = read_text(root, "go.mod", 64 * 1024).ok().and_then(|text| {
        text.lines().find_map(|line| {
            let mut fields = line.split_whitespace();
            (fields.next()? == "module")
                .then(|| {
                    fields
                        .next()
                        .map(|value| value.trim_matches('"').to_owned())
                })
                .flatten()
        })
    });
    let go_work = entries
        .iter()
        .any(|entry| !entry.directory && entry.path == "go.work");
    Ok(Snapshot {
        entries,
        truncated,
        module,
        go_work,
        package_revision: None,
    })
}

fn package_revision(root: &Path, anchor: &RootAnchor, entries: &[Entry]) -> String {
    let mut revision = DefaultHasher::new();
    for name in ["go.mod", "go.work"] {
        anchor.inspect(root, &[name], 64 * 1024).hash(&mut revision);
    }
    let mut modules = 0;
    for entry in entries.iter().filter(|entry| !entry.directory) {
        let name = entry.path.rsplit('/').next().unwrap_or(&entry.path);
        if name == "go.mod" && entry.path != "go.mod" {
            entry.path.hash(&mut revision);
            if modules < 128 {
                if let Ok(parts) = components(&entry.path) {
                    anchor.inspect(root, &parts, 64 * 1024).hash(&mut revision);
                }
                modules += 1;
            }
        } else if name.ends_with(".go") {
            entry.path.hash(&mut revision);
        }
    }
    format!("{:016x}", revision.finish())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Match {
    path: String,
    line: usize,
    column: usize,
    length: usize,
    preview: String,
}

#[derive(Serialize)]
pub struct SearchResult {
    matches: Vec<Match>,
    truncated: bool,
}

fn search(root: &Path, query: &str, case_sensitive: bool) -> CommandResult<SearchResult> {
    let mut matches = Vec::new();
    if query.is_empty() || query.len() > 512 || query.contains(['\n', '\r']) {
        return Err("Enter a single-line search term (up to 512 bytes).".into());
    }
    let pattern = RegexBuilder::new(&regex::escape(query))
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|error| error.to_string())?;
    let snapshot = collect(root)?;
    let mut truncated = snapshot.truncated;
    let mut bytes = 0;
    'files: for file in snapshot
        .entries
        .into_iter()
        .filter(|entry| !entry.directory)
    {
        let Ok(text) = read_text(root, &file.path, 512 * 1024) else {
            continue;
        };
        bytes += text.len();
        if bytes > MAX_SEARCH_BYTES {
            truncated = true;
            break;
        }
        for (index, line) in text.lines().enumerate() {
            for found in pattern.find_iter(line) {
                if matches.len() == MAX_RESULTS {
                    truncated = true;
                    break 'files;
                }
                let column = line[..found.start()].encode_utf16().count() + 1;
                matches.push(Match {
                    path: file.path.clone(),
                    line: index + 1,
                    column,
                    length: found.as_str().encode_utf16().count(),
                    preview: line.trim().chars().take(240).collect(),
                });
            }
        }
    }
    Ok(SearchResult { matches, truncated })
}

pub fn package_dir(root: &Path, package: &str) -> CommandResult<()> {
    if package == "." {
        return Ok(());
    }
    let relative = package
        .strip_prefix("./")
        .ok_or("Use '.' or a relative package such as './cmd/app'.")?;
    if relative == "..." {
        return Ok(());
    }
    let directory = direct_path(
        root,
        &components(relative.strip_suffix("/...").unwrap_or(relative))?,
    )?;
    if directory.is_dir() {
        Ok(())
    } else {
        Err("The Go package must be a directory in this workspace.".into())
    }
}

#[tauri::command]
pub async fn snapshot(state: State<'_, Core>, id: u64) -> CommandResult<Snapshot> {
    let (root, anchor) = observation_root(&state, id)?;
    blocking(move || {
        anchor.verify(&root)?;
        let mut snapshot = collect(&root)?;
        snapshot.package_revision = Some(package_revision(&root, &anchor, &snapshot.entries));
        anchor.verify(&root)?;
        Ok(snapshot)
    })
    .await
}

pub(crate) fn observation_root(state: &Core, id: u64) -> CommandResult<(PathBuf, RootAnchor)> {
    let session = state.0.lock().unwrap();
    let root = session.root(id)?.to_path_buf();
    let anchor = session.workspace.as_ref().unwrap().anchor.clone();
    Ok((root, anchor))
}

#[tauri::command]
pub async fn inspect_file(
    state: State<'_, Core>,
    id: u64,
    path: String,
) -> CommandResult<DiskObservation> {
    let (root, anchor) = observation_root(&state, id)?;
    blocking(move || Ok(anchor.inspect(&root, &components(&path)?, MAX_FILE_BYTES))).await
}

#[tauri::command]
pub async fn read_file(state: State<'_, Core>, id: u64, path: String) -> CommandResult<String> {
    use DiskObservation::*;
    match inspect_file(state, id, path).await? {
        Text { text } => Ok(text),
        Missing => Err("The file no longer exists.".into()),
        Unavailable => {
            Err("The file is unavailable. Open a regular UTF-8 text file smaller than 2 MB.".into())
        }
        Retry => Err("The file changed while opening. Try again.".into()),
    }
}

#[tauri::command]
pub async fn save_file(
    app: AppHandle,
    state: State<'_, Core>,
    id: u64,
    path: String,
    expected: String,
    text: String,
) -> CommandResult<()> {
    let (root, anchor) = observation_root(&state, id)?;
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Resolve save lock directory: {error}"))?;
    #[cfg(feature = "e2e")]
    state.1.wait().await?;
    blocking(move || {
        anchor.verify(&root)?;
        persist_text(&root, &data_dir, &path, &expected, &text)
    })
    .await
}

#[cfg(feature = "e2e")]
pub struct TestSaveHold {
    gate: tokio::sync::watch::Sender<bool>,
    waiting: std::sync::atomic::AtomicBool,
}

#[cfg(feature = "e2e")]
impl Default for TestSaveHold {
    fn default() -> Self {
        Self {
            gate: tokio::sync::watch::channel(false).0,
            waiting: false.into(),
        }
    }
}

#[cfg(feature = "e2e")]
impl TestSaveHold {
    async fn wait(&self) -> CommandResult<()> {
        use std::sync::atomic::Ordering;
        let mut held = self.gate.subscribe();
        if !*held.borrow() {
            return Ok(());
        }
        self.waiting.store(true, Ordering::SeqCst);
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            held.wait_for(|hold| !*hold),
        )
        .await;
        self.waiting.store(false, Ordering::SeqCst);
        outcome
            .map_err(|_| "Test did not release the pending save.")?
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn test_hold_save(state: State<'_, Core>, hold: Option<bool>) -> bool {
    if let Some(hold) = hold {
        state.1.gate.send_replace(hold);
    }
    state.1.waiting.load(std::sync::atomic::Ordering::SeqCst)
}

#[tauri::command]
pub async fn create_file(state: State<'_, Core>, id: u64, path: String) -> CommandResult<()> {
    let (root, anchor) = observation_root(&state, id)?;
    blocking(move || new_file(&root, &anchor, &path)).await
}

#[tauri::command]
pub async fn search_files(
    state: State<'_, Core>,
    id: u64,
    query: String,
    case_sensitive: bool,
) -> CommandResult<SearchResult> {
    let root = state.0.lock().unwrap().root(id)?.to_path_buf();
    blocking(move || search(&root, &query, case_sensitive)).await
}

#[cfg(test)]
mod save_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_saves_without_overwriting_external_edits() {
        let dir = tempfile::tempdir().unwrap();
        let project = create_module(dir.path(), "hello-go", "example.com/hello-go").unwrap();
        assert!(create_module(dir.path(), "hello-go", "example.com/other").is_err());
        assert_eq!(
            collect(&project.root).unwrap().module.as_deref(),
            Some("example.com/hello-go")
        );
        new_file(&project.root, &project.anchor, "sub/file.go").unwrap();
        assert!(new_file(&project.root, &project.anchor, "sub/file.go").is_err());
        let profile = dir.path().join("profile");
        persist_text(&project.root, &profile, "sub/file.go", "", "package sub\n").unwrap();
        assert!(persist_text(&project.root, &profile, "sub/file.go", "", "oops").is_err());
        assert_eq!(
            read_text(&project.root, "sub/file.go", 1024).unwrap(),
            "package sub\n"
        );
    }

    #[test]
    fn refuses_an_external_edit_after_staging() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("file.txt");
        fs::write(&target, "original").unwrap();
        let profile = tempfile::tempdir().unwrap();
        let result = persist_text_impl(
            dir.path(),
            profile.path(),
            "file.txt",
            "original",
            "editor",
            &mut |point| {
                if point == SavePoint::Staged {
                    fs::write(&target, "external").unwrap();
                }
                Ok(())
            },
        );
        assert!(result.is_err(), "must reject a change after staging");
        assert_eq!(fs::read_to_string(&target).unwrap(), "external");
        assert_eq!(
            fs::read_dir(dir.path()).unwrap().count(),
            1,
            "discard the staging file"
        );
    }

    #[test]
    #[cfg(unix)]
    fn rejects_traversal_and_excludes_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(dir.path().join("secret.txt"), "not workspace content").unwrap();
        std::os::unix::fs::symlink(dir.path(), root.join("escape")).unwrap();
        assert!(collect(&root).unwrap().entries.is_empty());
        assert!(read_text(&root, "../secret.txt", 1024).is_err());
        assert!(read_text(&root, "escape/secret.txt", 1024).is_err());
        let workspace = Workspace::open(&root).unwrap();
        assert!(new_file(&workspace.root, &workspace.anchor, "escape/other.txt").is_err());
        assert!(package_dir(&root, "./escape/...").is_err());
    }

    #[test]
    fn finds_literal_matches_with_utf16_positions() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("data.txt"), "🚀 Foo.* foo.*\nFoo!\n").unwrap();
        let result = search(dir.path(), "foo.*", false).unwrap();
        assert_eq!(result.matches.len(), 2);
        assert_eq!(result.matches[0].column, 4);
        assert_eq!(result.matches[0].length, 5);
        assert_eq!(search(dir.path(), "foo.*", true).unwrap().matches.len(), 1);
    }
}
