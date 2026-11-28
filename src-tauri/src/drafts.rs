use std::{
    collections::{HashMap, HashSet},
    ffi::{CStr, CString},
    fs::{self, File},
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, IntoRawFd},
        unix::fs::MetadataExt,
    },
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::{
    blocking,
    workspace::{components, observation_root, VersionedText, Workspace, MAX_FILE_BYTES},
    workspace_disk::{create_at, open_at, open_root, DiskObservation, RootAnchor},
    CommandResult, Core,
};

const MAX_INDEX: u64 = 256 * 1024;
const MAX_PAYLOAD: u64 = 24 * 1024 * 1024 + 4096;
const MAX_TOTAL: u64 = 128 * 1024 * 1024;
const RECORDS: usize = 128;
const WRITERS: usize = 64;
const FENCES: usize = 4096;
const INDEX: &str = "index.json";
const LEASE: &str = "owner.lock";

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub(crate) struct ProjectKey {
    pub(crate) path: PathBuf,
    device: u64,
    inode: u64,
    created: u128,
}

impl ProjectKey {
    pub(crate) fn new(path: &Path, anchor: &RootAnchor) -> CommandResult<Self> {
        anchor.verify(path)?;
        Self::admitted(path, anchor)
    }

    fn admitted(path: &Path, anchor: &RootAnchor) -> CommandResult<Self> {
        let metadata = anchor
            .open_directory(&[])
            .and_then(|directory| directory.metadata())
            .map_err(text_error)?;
        let created = metadata
            .created()
            .map_err(text_error)?
            .duration_since(UNIX_EPOCH)
            .map_err(text_error)?
            .as_nanos();
        Ok(Self {
            path: path.to_owned(),
            device: metadata.dev(),
            inode: metadata.ino(),
            created,
        })
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct Entry {
    project: ProjectKey,
    path: String,
    payload: String,
    revision: u64,
    modified: u64,
}

#[derive(Deserialize, Serialize)]
struct Index {
    schema: u8,
    entries: Vec<Entry>,
}

impl Default for Index {
    fn default() -> Self {
        Self {
            schema: 1,
            entries: Vec::new(),
        }
    }
}

#[derive(Deserialize, Serialize)]
pub struct Payload {
    text: String,
    baseline: String,
    version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftItem {
    writer: String,
    payload: String,
    path: String,
    project_path: PathBuf,
    revision: u64,
    modified: u64,
    detached: bool,
}

#[derive(Serialize)]
pub struct Recovered {
    payload: Payload,
    observed: DiskObservation,
}

#[derive(Deserialize)]
pub struct Retirement {
    pub id: u64,
    pub revision: u64,
}

#[derive(Default)]
pub struct DraftRuntime(Mutex<Runtime>, #[cfg(feature = "e2e")] Mutex<Option<File>>);

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn test_hold_draft_profile(app: AppHandle, hold: bool) -> CommandResult<()> {
    let runtime = app.state::<DraftRuntime>();
    let mut held = runtime.1.lock().unwrap();
    if hold && held.is_none() {
        let profile = open_profile(&app, "recovery-v1").map_err(text_error)?;
        *held = Some(open_profile_lock(&profile, true).map_err(text_error)?);
    } else if !hold {
        held.take();
    }
    Ok(())
}

#[derive(Default)]
struct Runtime {
    profile: Option<File>,
    writer: Option<Writer>,
    paths: HashMap<(ProjectKey, String), u64>,
    projects: HashMap<ProjectKey, u64>,
    subtrees: HashMap<(ProjectKey, String), u64>,
    quit: Option<QuitStage>,
}

struct Writer {
    id: String,
    dir: File,
    _lease: File,
}
struct QuitStage {
    ticket: u64,
    stage: Option<String>,
    approved: bool,
}

fn text_error(error: impl std::fmt::Display) -> String {
    format!("Recovery drafts: {error}")
}

fn private(file: File, directory: bool) -> io::Result<File> {
    let info = file.metadata()?;
    if info.uid() != unsafe { libc::geteuid() }
        || info.mode() & 0o077 != 0
        || if directory {
            !info.is_dir()
        } else {
            !info.is_file() || info.nlink() != 1
        }
    {
        return Err(io::Error::other(
            "An app recovery path does not have private ownership or permissions.",
        ));
    }
    Ok(file)
}

fn mkdir(parent: &File, name: &str, existing: bool) -> io::Result<File> {
    let name = CString::new(name)?;
    if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
        let error = io::Error::last_os_error();
        if !existing || error.kind() != io::ErrorKind::AlreadyExists {
            return Err(error);
        }
    }
    private(open_at(parent, name.as_bytes(), libc::O_DIRECTORY)?, true)
}

fn lock_file(dir: &File, name: &str) -> io::Result<File> {
    match create_at(dir, name.as_bytes(), 0o600) {
        Ok(file) => private(file, false),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => private(
            open_at(dir, name.as_bytes(), libc::O_NONBLOCK | libc::O_RDWR)?,
            false,
        ),
        Err(error) => Err(error),
    }
}

fn flock(file: &File, flags: i32) -> io::Result<()> {
    loop {
        if unsafe { libc::flock(file.as_raw_fd(), flags) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

pub(crate) fn open_profile(app: &AppHandle, directory: &str) -> io::Result<File> {
    let base = app.path().app_local_data_dir().map_err(io::Error::other)?;
    fs::create_dir_all(&base)?;
    mkdir(&open_root(&base.canonicalize()?)?, directory, true)
}

pub(crate) fn open_profile_lock(dir: &File, nonblocking: bool) -> io::Result<File> {
    let file = lock_file(dir, "profile.lock")?;
    flock(
        &file,
        libc::LOCK_EX | if nonblocking { libc::LOCK_NB } else { 0 },
    )?;
    Ok(file)
}

pub(crate) fn unique(prefix: &str) -> String {
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{prefix}{:x}-{now:x}-{:x}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    )
}

fn valid_name(name: &str, prefix: &str) -> bool {
    name.strip_prefix(prefix).is_some_and(|tail| {
        !tail.is_empty()
            && tail.len() < 80
            && tail
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    })
}

struct Directory(*mut libc::DIR);
impl Drop for Directory {
    fn drop(&mut self) {
        unsafe { libc::closedir(self.0) };
    }
}

fn names(dir: &File, max: usize) -> io::Result<Vec<String>> {
    let fd = open_at(dir, b".", libc::O_DIRECTORY)?.into_raw_fd();
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        let error = io::Error::last_os_error();
        unsafe { libc::close(fd) };
        return Err(error);
    }
    let stream = Directory(stream);
    let mut result = Vec::new();
    loop {
        // readdir uses errno to distinguish end of directory from failure.
        let entry = unsafe {
            *libc::__error() = 0;
            libc::readdir(stream.0)
        };
        if entry.is_null() {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(0) {
                Ok(result)
            } else {
                Err(error)
            };
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_string_lossy();
        if name != "." && name != ".." {
            result.push(name.into_owned());
        }
        if result.len() > max {
            return Err(io::Error::other(
                "The recovery directory exceeds its entry limit.",
            ));
        }
    }
}

pub(crate) fn unlink(dir: &File, name: &str, flags: i32) -> io::Result<()> {
    let name = CString::new(name)?;
    if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), flags) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.kind() == io::ErrorKind::NotFound {
        Ok(())
    } else {
        Err(error)
    }
}

fn write_new(dir: &File, name: &str, bytes: &[u8]) -> io::Result<()> {
    let mut file = create_at(dir, name.as_bytes(), 0o600)?;
    match file.write_all(bytes).and_then(|()| file.sync_all()) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = unlink(dir, name, 0);
            Err(error)
        }
    }
}

pub(crate) fn read_json<T: DeserializeOwned>(dir: &File, name: &str, limit: u64) -> io::Result<T> {
    let file = private(open_at(dir, name.as_bytes(), libc::O_NONBLOCK)?, false)?;
    if file.metadata()?.len() > limit {
        return Err(io::Error::other(
            "A recovery record exceeds its size limit.",
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::other(
            "A recovery record exceeds its size limit.",
        ));
    }
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}

fn read_index(dir: &File) -> io::Result<Index> {
    let index: Index = match read_json(dir, INDEX, MAX_INDEX) {
        Ok(index) => index,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Index::default()),
        Err(error) => return Err(error),
    };
    if index.schema != 1
        || index.entries.len() > RECORDS
        || index
            .entries
            .iter()
            .any(|entry| !valid_name(&entry.payload, "draft-"))
    {
        return Err(io::Error::other(
            "The recovery index is not supported or exceeds its limits.",
        ));
    }
    Ok(index)
}

fn stage_index(dir: &File, index: &Index) -> io::Result<String> {
    stage_record(dir, index, MAX_INDEX)
}

pub(crate) fn stage_record(dir: &File, record: &impl Serialize, limit: u64) -> io::Result<String> {
    let bytes = serde_json::to_vec(record).map_err(io::Error::other)?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::other(
            "The profile index exceeds its byte limit.",
        ));
    }
    let stage = unique("stage-");
    write_new(dir, &stage, &bytes)?;
    Ok(stage)
}

pub(crate) fn commit_index(dir: &File, stage: &str) -> io::Result<()> {
    let staging = CString::new(stage)?;
    if unsafe {
        libc::renameat(
            dir.as_raw_fd(),
            staging.as_ptr(),
            dir.as_raw_fd(),
            c"index.json".as_ptr(),
        )
    } != 0
    {
        let error = io::Error::last_os_error();
        let _ = unlink(dir, stage, 0);
        return Err(error);
    }
    Ok(())
}

fn reclaim(dir: &File, index: &Index) -> io::Result<()> {
    let referenced = index
        .entries
        .iter()
        .map(|entry| entry.payload.as_str())
        .collect::<HashSet<_>>();
    for name in names(dir, 2 * RECORDS + 16)? {
        if (valid_name(&name, "draft-") && !referenced.contains(name.as_str()))
            || valid_name(&name, "stage-")
        {
            unlink(dir, &name, 0)?;
        }
    }
    Ok(())
}

fn detached(dir: &File) -> io::Result<Option<File>> {
    let lease = lock_file(dir, LEASE)?;
    match flock(&lease, libc::LOCK_EX | libc::LOCK_NB) {
        Ok(()) => Ok(Some(lease)),
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(None),
        Err(error) => Err(error),
    }
}

fn writer_dir(profile: &File, id: &str) -> io::Result<File> {
    if !valid_name(id, "writer-") {
        return Err(io::Error::other("Invalid recovery writer."));
    }
    private(open_at(profile, id.as_bytes(), libc::O_DIRECTORY)?, true)
}

fn writers(profile: &File) -> io::Result<Vec<String>> {
    Ok(names(profile, WRITERS + 1)?
        .into_iter()
        .filter(|name| valid_name(name, "writer-"))
        .collect())
}

fn usage(profile: &File, current: Option<&Writer>) -> io::Result<(usize, usize, u64)> {
    let mut count = 0;
    let mut records = 0;
    let mut bytes = 0u64;
    for id in writers(profile)? {
        let dir = writer_dir(profile, &id)?;
        let index = read_index(&dir)?;
        let own = current.is_some_and(|writer| writer.id == id);
        let lease = if own { None } else { detached(&dir)? };
        if own || lease.is_some() {
            reclaim(&dir, &index)?;
        }
        if index.entries.is_empty() && lease.is_some() {
            unlink(&dir, INDEX, 0)?;
            unlink(&dir, LEASE, 0)?;
            unlink(profile, &id, libc::AT_REMOVEDIR)?;
            continue;
        }
        count += 1;
        records += index.entries.len();
        for name in names(&dir, 2 * RECORDS + 16)?
            .into_iter()
            .filter(|name| valid_name(name, "draft-"))
        {
            let file = private(open_at(&dir, name.as_bytes(), libc::O_NONBLOCK)?, false)?;
            bytes = bytes.saturating_add(file.metadata()?.len());
        }
    }
    Ok((count, records, bytes))
}

impl Runtime {
    fn subtree_revoked(&self, project: &ProjectKey, path: &str, revision: u64) -> bool {
        self.subtrees.iter().any(|((key, prefix), fence)| {
            key == project && *fence >= revision && subtree(path, prefix)
        })
    }
    fn profile(&mut self, app: &AppHandle) -> io::Result<&File> {
        if self.profile.is_none() {
            self.profile = Some(open_profile(app, "recovery-v1")?);
        }
        Ok(self.profile.as_ref().unwrap())
    }

    fn publish(
        &mut self,
        project: ProjectKey,
        path: String,
        revision: u64,
        payload: Payload,
    ) -> io::Result<()> {
        let key = (project.clone(), path.clone());
        if self.subtree_revoked(&project, &path, revision) {
            return Ok(());
        }
        if self
            .projects
            .get(&project)
            .is_some_and(|seen| *seen >= revision)
            || self.paths.get(&key).is_some_and(|seen| *seen >= revision)
        {
            return Ok(());
        }
        if self.quit.is_some() {
            return Err(io::Error::other(
                "Draft recording is paused while Quit is pending.",
            ));
        }
        if !self.paths.contains_key(&key) && self.paths.len() >= FENCES {
            return Err(io::Error::other(
                "Restart the app to reset its draft revision limit.",
            ));
        }
        // Even a failed newer publication revokes queued writes based on the
        // earlier snapshot. Retain the last completed index if this write fails.
        self.paths.insert(key, revision);
        let profile = self
            .profile
            .as_ref()
            .ok_or_else(|| io::Error::other("Recovery profile was not opened."))?
            .try_clone()?;
        let _lock = open_profile_lock(&profile, false)?;
        let (writer_count, records, bytes) = usage(&profile, self.writer.as_ref())?;
        if self.writer.is_none() {
            if writer_count >= WRITERS {
                return Err(io::Error::other(
                    "Too many recovery writers. Remove detached drafts from the Recovery dialog.",
                ));
            }
            let id = unique("writer-");
            let dir = mkdir(&profile, &id, false)?;
            let lease = detached(&dir)?
                .ok_or_else(|| io::Error::other("The new draft writer is already leased."))?;
            self.writer = Some(Writer {
                id,
                dir,
                _lease: lease,
            });
        }
        let writer = self.writer.as_ref().unwrap();
        let mut index = read_index(&writer.dir)?;
        let existing = index
            .entries
            .iter()
            .position(|entry| entry.project == project && entry.path == path);
        let encoded = serde_json::to_vec(&payload).map_err(io::Error::other)?;
        if encoded.len() as u64 > MAX_PAYLOAD
            || bytes.saturating_add(encoded.len() as u64) > MAX_TOTAL
            || (records >= RECORDS && existing.is_none())
        {
            return Err(io::Error::other(
                "Recovery storage is full. Remove detached drafts from the Recovery dialog.",
            ));
        }
        let name = unique("draft-");
        let entry = Entry {
            project,
            path,
            payload: name.clone(),
            revision,
            modified: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        };
        if let Some(position) = existing {
            index.entries[position] = entry;
        } else {
            index.entries.push(entry);
        }
        write_new(&writer.dir, &name, &encoded)?;
        if let Err(error) =
            stage_index(&writer.dir, &index).and_then(|stage| commit_index(&writer.dir, &stage))
        {
            let _ = unlink(&writer.dir, &name, 0);
            return Err(error);
        }
        reclaim(&writer.dir, &index)?;
        Ok(())
    }

    #[cfg(test)]
    fn retire(
        &mut self,
        project: ProjectKey,
        path: Option<String>,
        revision: u64,
    ) -> io::Result<()> {
        self.retire_checked(project, path, revision, || Ok(()))
    }

    fn retire_checked(
        &mut self,
        project: ProjectKey,
        path: Option<String>,
        revision: u64,
        check: impl FnOnce() -> io::Result<()>,
    ) -> io::Result<()> {
        if path
            .as_ref()
            .is_some_and(|path| self.subtree_revoked(&project, path, revision))
        {
            return check();
        }
        if self.quit.is_some() {
            return Err(io::Error::other(
                "Draft retirement is paused while Quit is pending.",
            ));
        }
        if self.paths.len() >= FENCES
            && path
                .as_ref()
                .is_some_and(|path| !self.paths.contains_key(&(project.clone(), path.clone())))
        {
            return Err(io::Error::other(
                "Restart the app to reset its draft revision limit.",
            ));
        }
        if let Some(writer) = &self.writer {
            let _lock = open_profile_lock(self.profile.as_ref().unwrap(), false)?;
            let mut index = read_index(&writer.dir)?;
            let count = index.entries.len();
            index.entries.retain(|entry| {
                entry.project != project
                    || path.as_ref().is_some_and(|path| *path != entry.path)
                    || entry.revision > revision
            });
            let stage = if count != index.entries.len() {
                Some(stage_index(&writer.dir, &index)?)
            } else {
                None
            };
            if let Err(error) = check() {
                if let Some(stage) = &stage {
                    let _ = unlink(&writer.dir, stage, 0);
                }
                return Err(error);
            }
            if let Some(stage) = stage {
                commit_index(&writer.dir, &stage)?;
            }
        } else {
            check()?;
        }
        if let Some(path) = path {
            let seen = self.paths.entry((project, path)).or_default();
            *seen = (*seen).max(revision);
        } else {
            let seen = self.projects.entry(project.clone()).or_default();
            *seen = (*seen).max(revision);
            self.paths
                .retain(|(key, _), seen| key != &project || *seen > revision);
            self.subtrees
                .retain(|(key, _), seen| key != &project || *seen > revision);
        }
        Ok(())
    }
}

pub(crate) fn subtree(path: &str, root: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

// The caller holds native workspace state and the stable Save lock. Preserve
// the previous index unless the native filesystem mutation actually commits.
pub(crate) fn rebind_paths<T>(
    app: &AppHandle,
    workspace: &Workspace,
    source: &str,
    destination: Option<&str>,
    revision: u64,
    mutate: impl FnOnce() -> CommandResult<(T, bool)>,
) -> CommandResult<(T, Option<String>)> {
    let project = ProjectKey::admitted(&workspace.root, &workspace.anchor)?;
    let state = app.state::<DraftRuntime>();
    let mut runtime = state.0.lock().unwrap();
    if runtime.quit.is_some() || runtime.subtrees.len() + 2 > FENCES {
        return Err("Recovery storage cannot reserve another file operation.".into());
    }
    let writer = runtime.writer.as_ref();
    let _lock = if writer.is_some() {
        Some(open_profile_lock(runtime.profile.as_ref().unwrap(), false).map_err(text_error)?)
    } else {
        None
    };
    let mut stage = None;
    if let Some(writer) = writer {
        let mut index = read_index(&writer.dir).map_err(text_error)?;
        if let Some(to) = destination {
            if index.entries.iter().any(|entry| {
                entry.project == project
                    && subtree(&entry.path, to)
                    && !subtree(&entry.path, source)
            }) {
                return Err("The destination already has an outstanding recovery draft.".into());
            }
        }
        if index
            .entries
            .iter()
            .any(|entry| entry.project == project && subtree(&entry.path, source))
        {
            if let Some(to) = destination {
                for entry in index
                    .entries
                    .iter_mut()
                    .filter(|entry| entry.project == project && subtree(&entry.path, source))
                {
                    entry.path = format!("{to}{}", &entry.path[source.len()..]);
                    valid_input(&entry.path, revision)?;
                }
            } else {
                index
                    .entries
                    .retain(|entry| entry.project != project || !subtree(&entry.path, source));
            }
            stage = Some(stage_index(&writer.dir, &index).map_err(text_error)?);
        }
    }
    let result = mutate();
    let warning = if let (Some(writer), Some(stage)) = (writer, stage) {
        if result.as_ref().is_ok_and(|(_, publish)| *publish) {
            commit_index(&writer.dir, &stage).err().map(text_error)
        } else {
            let _ = unlink(&writer.dir, &stage, 0);
            None
        }
    } else {
        None
    };
    let (result, _) = result?;
    for path in [Some(source), destination].into_iter().flatten() {
        let fence = runtime
            .subtrees
            .entry((project.clone(), path.to_owned()))
            .or_default();
        *fence = (*fence).max(revision);
    }
    Ok((result, warning))
}

fn project(state: &Core, id: u64) -> CommandResult<(ProjectKey, PathBuf, RootAnchor)> {
    let (path, anchor) = observation_root(state, id)?;
    Ok((ProjectKey::new(&path, &anchor)?, path, anchor))
}

fn valid_input(path: &str, revision: u64) -> CommandResult<()> {
    if path.len() > 1024 || revision == 0 {
        return Err("The draft path or revision is invalid.".into());
    }
    components(path)?;
    Ok(())
}

fn validate_payload(payload: &Payload) -> CommandResult<()> {
    if payload.text.len() as u64 > MAX_FILE_BYTES
        || payload.baseline.len() as u64 > MAX_FILE_BYTES
        || payload.version.is_empty()
        || payload.version.len() > 256
        || payload.text.contains('\0')
        || payload.baseline.contains('\0')
    {
        return Err(
            "The file exceeds recovery draft bounds or has no stable disk baseline.".into(),
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn write_draft(
    app: AppHandle,
    state: State<'_, Core>,
    id: u64,
    path: String,
    revision: u64,
    payload: Payload,
) -> CommandResult<()> {
    valid_input(&path, revision)?;
    validate_payload(&payload)?;
    let (project, _, _) = project(&state, id)?;
    blocking(move || {
        let state = app.state::<DraftRuntime>();
        let mut runtime = state.0.lock().unwrap();
        runtime.profile(&app).map_err(text_error)?;
        runtime
            .publish(project, path, revision, payload)
            .map_err(text_error)
    })
    .await
}

#[tauri::command]
pub async fn retire_draft(
    app: AppHandle,
    state: State<'_, Core>,
    id: u64,
    path: String,
    revision: u64,
    reviewed: Option<VersionedText>,
) -> CommandResult<()> {
    valid_input(&path, revision)?;
    let (path_root, anchor) = observation_root(&state, id)?;
    let project = ProjectKey::admitted(&path_root, &anchor)?;
    #[cfg(feature = "e2e")]
    if reviewed.is_some() {
        state.1.wait(&path).await?;
    }
    blocking(move || {
        let reviewed_path = path.clone();
        let current = || {
            if let Some(reviewed) = &reviewed {
                let parts = components(&reviewed_path).map_err(io::Error::other)?;
                let observed = anchor.inspect(&path_root, &parts, MAX_FILE_BYTES);
                if !matches!(observed, DiskObservation::Text { text, version } if text == reviewed.text && version == reviewed.version) {
                    return Err(io::Error::other("The reviewed disk version changed. Compare again before reloading."));
                }
            }
            Ok(())
        };
        app.state::<DraftRuntime>()
            .0
            .lock()
            .unwrap()
            .retire_checked(project, Some(path), revision, current)
            .map_err(text_error)
    })
    .await
}

#[tauri::command]
pub async fn list_drafts(
    app: AppHandle,
    state: State<'_, Core>,
    id: Option<u64>,
) -> CommandResult<Vec<DraftItem>> {
    let project = id
        .map(|id| project(&state, id).map(|(key, _, _)| key))
        .transpose()?;
    blocking(move || {
        let runtime = app.state::<DraftRuntime>();
        let mut runtime = runtime.0.lock().unwrap();
        let profile = runtime.profile(&app).map_err(text_error)?;
        let _lock = open_profile_lock(profile, false).map_err(text_error)?;
        let mut result = Vec::new();
        for writer in writers(profile).map_err(text_error)? {
            let dir = writer_dir(profile, &writer).map_err(text_error)?;
            let index = read_index(&dir).map_err(text_error)?;
            let detached = detached(&dir).map_err(text_error)?.is_some();
            if project.is_none() && !detached {
                continue;
            }
            for entry in index
                .entries
                .into_iter()
                .filter(|entry| project.as_ref().is_none_or(|key| &entry.project == key))
            {
                if result.len() >= RECORDS {
                    return Err("The recovery result exceeds its record limit.".into());
                }
                result.push(DraftItem {
                    writer: writer.clone(),
                    payload: entry.payload,
                    path: entry.path,
                    project_path: entry.project.path,
                    revision: entry.revision,
                    modified: entry.modified,
                    detached,
                });
            }
        }
        result.sort_by_key(|draft| std::cmp::Reverse(draft.modified));
        Ok(result)
    })
    .await
}

fn find_entry<'a>(
    index: &'a Index,
    project: Option<&ProjectKey>,
    payload: &str,
    revision: u64,
) -> CommandResult<&'a Entry> {
    index
        .entries
        .iter()
        .find(|entry| {
            project.is_none_or(|project| &entry.project == project)
                && entry.payload == payload
                && entry.revision == revision
        })
        .ok_or_else(|| "The recovery record changed. Refresh the list and select it again.".into())
}

#[tauri::command]
pub async fn recover_draft(
    app: AppHandle,
    state: State<'_, Core>,
    id: u64,
    writer: String,
    payload: String,
    revision: u64,
) -> CommandResult<Recovered> {
    let (project, path, anchor) = project(&state, id)?;
    blocking(move || {
        let runtime = app.state::<DraftRuntime>();
        let mut runtime = runtime.0.lock().unwrap();
        let profile = runtime.profile(&app).map_err(text_error)?;
        let lock = open_profile_lock(profile, false).map_err(text_error)?;
        let dir = writer_dir(profile, &writer).map_err(text_error)?;
        let index = read_index(&dir).map_err(text_error)?;
        let entry = find_entry(&index, Some(&project), &payload, revision)?;
        let parts = components(&entry.path)?;
        let payload = read_json(&dir, &entry.payload, MAX_PAYLOAD).map_err(text_error)?;
        validate_payload(&payload)?;
        drop(lock);
        let observed = anchor.inspect(&path, &parts, MAX_FILE_BYTES);
        Ok(Recovered { payload, observed })
    })
    .await
}

#[tauri::command]
pub async fn remove_draft(
    app: AppHandle,
    state: State<'_, Core>,
    id: Option<u64>,
    writer: String,
    payload: String,
    revision: u64,
) -> CommandResult<()> {
    let project = id
        .map(|id| project(&state, id).map(|(key, _, _)| key))
        .transpose()?;
    blocking(move || {
        let runtime = app.state::<DraftRuntime>();
        let mut runtime = runtime.0.lock().unwrap();
        let profile = runtime.profile(&app).map_err(text_error)?;
        let _lock = open_profile_lock(profile, false).map_err(text_error)?;
        let dir = writer_dir(profile, &writer).map_err(text_error)?;
        let _lease = detached(&dir)
            .map_err(text_error)?
            .ok_or("The recovery writer is still open; its drafts cannot be removed here.")?;
        let mut index = read_index(&dir).map_err(text_error)?;
        find_entry(&index, project.as_ref(), &payload, revision)?;
        index.entries.retain(|entry| entry.payload != payload);
        let stage = stage_index(&dir, &index).map_err(text_error)?;
        commit_index(&dir, &stage).map_err(text_error)?;
        let _ = reclaim(&dir, &index);
        Ok(())
    })
    .await
}

pub(crate) fn retire_project(
    app: &AppHandle,
    workspace: &Workspace,
    plan: Retirement,
    check: impl FnOnce() -> CommandResult<()>,
) -> CommandResult<()> {
    if workspace.info.id != plan.id {
        return Err("The outgoing project changed before its draft retirement.".into());
    }
    let key = ProjectKey::admitted(&workspace.root, &workspace.anchor)?;
    app.state::<DraftRuntime>()
        .0
        .lock()
        .unwrap()
        .retire_checked(key, None, plan.revision, || {
            check().map_err(io::Error::other)
        })
        .map_err(text_error)
}

pub(crate) async fn prepare_quit(
    app: AppHandle,
    ticket: u64,
    plan: Retirement,
) -> CommandResult<()> {
    blocking(move || {
        let state = app.state::<DraftRuntime>();
        let core = app.state::<Core>();
        let deadline = Instant::now() + Duration::from_secs(1);
        let live = || crate::quit::live_ticket(&app, ticket);
        let expired = "The Quit decision expired before recovery drafts could be retired.";
        let attempt = || -> CommandResult<bool> {
            let Ok(session) = core.0.try_lock() else { return Ok(false); };
            let root = session.root(plan.id)?;
            let project = ProjectKey::admitted(root, &session.workspace.as_ref().unwrap().anchor)?;
            let Ok(mut runtime) = state.0.try_lock() else { return Ok(false); };
            if runtime.quit.is_some() { return Err("Another draft retirement is staged.".into()); }
            let mut stage = None;
            if let Some(writer) = &runtime.writer {
                let _lock = match open_profile_lock(runtime.profile.as_ref().unwrap(), true) {
                    Ok(lock) => lock,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(false),
                    Err(error) => return Err(text_error(error)),
                };
                let mut index = read_index(&writer.dir).map_err(text_error)?;
                let count = index.entries.len();
                index.entries.retain(|entry| entry.project != project || entry.revision > plan.revision);
                if count != index.entries.len() { stage = Some(stage_index(&writer.dir, &index).map_err(text_error)?); }
                if !live() {
                    if let Some(stage) = &stage { let _ = unlink(&writer.dir, stage, 0); }
                    return Err(expired.into());
                }
            }
            runtime.quit = Some(QuitStage { ticket, stage, approved: false });
            Ok(true)
        };
        loop {
            if !live() { return Err(expired.into()); }
            if attempt()? { return Ok(()); }
            if Instant::now() >= deadline { return Err("Recovery storage is busy. The project and its drafts remain open; try Quit again.".into()); }
            std::thread::sleep(Duration::from_millis(20));
        }
    })
    .await
}

pub(crate) fn approve_quit(app: &AppHandle, ticket: u64) -> CommandResult<()> {
    let state = app.state::<DraftRuntime>();
    let mut runtime = state
        .0
        .try_lock()
        .map_err(|_| "Recovery storage is busy. Try Quit again.")?;
    let quit = runtime
        .quit
        .as_mut()
        .filter(|quit| quit.ticket == ticket)
        .ok_or("The recovery retirement ticket is no longer current.")?;
    quit.approved = true;
    Ok(())
}

pub(crate) async fn cancel_quit(app: AppHandle, ticket: u64) -> CommandResult<()> {
    blocking(move || {
        let state = app.state::<DraftRuntime>();
        let mut runtime = state.0.lock().unwrap();
        if runtime
            .quit
            .as_ref()
            .is_some_and(|quit| quit.ticket == ticket)
        {
            if let Some(stage) = runtime.quit.take().and_then(|quit| quit.stage) {
                if let Some(writer) = &runtime.writer {
                    let _ = unlink(&writer.dir, &stage, 0);
                }
            }
        }
        Ok(())
    })
    .await
}

pub(crate) fn commit_quit(app: &AppHandle) {
    let state = app.state::<DraftRuntime>();
    let Ok(mut runtime) = state.0.try_lock() else {
        return;
    };
    let Some(quit) = runtime.quit.take().filter(|quit| quit.approved) else {
        return;
    };
    if let (Some(stage), Some(writer), Some(profile)) =
        (quit.stage, &runtime.writer, &runtime.profile)
    {
        if let Ok(_lock) = open_profile_lock(profile, true) {
            let _ = commit_index(&writer.dir, &stage);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(text: &str) -> Payload {
        Payload {
            text: text.into(),
            baseline: "original".into(),
            version: "disk-version".into(),
        }
    }

    fn fixture() -> (tempfile::TempDir, Runtime, ProjectKey) {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let dir = open_root(&root).unwrap();
        let profile = mkdir(&dir, "profile", false).unwrap();
        let project = ProjectKey::new(&root, &RootAnchor::new(&root).unwrap()).unwrap();
        (
            fixture,
            Runtime {
                profile: Some(profile),
                ..Runtime::default()
            },
            project,
        )
    }

    #[test]
    fn publishes_immutable_payloads_and_fences_old_revisions() {
        let (_fixture, mut runtime, project) = fixture();
        let path = "main.go".to_owned();
        runtime
            .publish(project.clone(), path.clone(), 1, payload("one"))
            .unwrap();
        let writer = runtime.writer.as_ref().unwrap();
        let old_index = read_index(&writer.dir).unwrap();
        let old_name = &old_index.entries[0].payload;
        let old = open_at(&writer.dir, old_name.as_bytes(), libc::O_NONBLOCK).unwrap();
        assert!(detached(&writer.dir).unwrap().is_none());
        runtime
            .publish(project.clone(), path.clone(), 3, payload("three"))
            .unwrap();
        runtime
            .publish(
                project.clone(),
                path.clone(),
                2,
                payload("obsolete baseline"),
            )
            .unwrap();
        let mut old_bytes = Vec::new();
        old.take(MAX_PAYLOAD).read_to_end(&mut old_bytes).unwrap();
        assert_eq!(
            serde_json::from_slice::<Payload>(&old_bytes).unwrap().text,
            "one"
        );
        let writer = runtime.writer.as_ref().unwrap();
        let index = read_index(&writer.dir).unwrap();
        assert_eq!(index.entries[0].revision, 3);
        assert_ne!(&index.entries[0].payload, old_name);
        assert!(find_entry(&index, Some(&project), old_name, 1).is_err());
        runtime
            .retire(project.clone(), Some(path.clone()), 4)
            .unwrap();
        runtime
            .publish(
                project.clone(),
                path.clone(),
                3,
                payload("stale after retirement"),
            )
            .unwrap();
        assert!(read_index(&runtime.writer.as_ref().unwrap().dir)
            .unwrap()
            .entries
            .is_empty());
        runtime
            .publish(project.clone(), path.clone(), 6, payload("new edit"))
            .unwrap();
        runtime.retire(project.clone(), None, 7).unwrap();
        runtime
            .publish(project, path, 6, payload("stale after cutover"))
            .unwrap();
        assert!(read_index(&runtime.writer.as_ref().unwrap().dir)
            .unwrap()
            .entries
            .is_empty());
    }

    #[test]
    fn leases_separate_writers_and_reject_symlinked_records() {
        let (fixture, mut first, project) = fixture();
        let mut second = Runtime {
            profile: Some(first.profile.as_ref().unwrap().try_clone().unwrap()),
            ..Runtime::default()
        };
        first
            .publish(
                project.clone(),
                "main.go".into(),
                1,
                payload("first writer"),
            )
            .unwrap();
        second
            .publish(project, "main.go".into(), 1, payload("second writer"))
            .unwrap();
        let profile = second.profile.as_ref().unwrap();
        let first_dir = writer_dir(profile, &first.writer.as_ref().unwrap().id).unwrap();
        assert!(detached(&first_dir).unwrap().is_none());
        let first_id = first.writer.as_ref().unwrap().id.clone();
        // Other Rust tests can fork between these two statements and hold
        // a CLOEXEC descriptor until exec. Release this test lease explicitly.
        flock(&first.writer.as_ref().unwrap()._lease, libc::LOCK_UN).unwrap();
        drop(first);
        let lease = detached(&first_dir).unwrap().unwrap();
        let entry = read_index(&first_dir).unwrap().entries.pop().unwrap();
        let outside = fixture.path().join("outside.txt");
        fs::write(&outside, "outside").unwrap();
        unlink(&first_dir, &entry.payload, 0).unwrap();
        std::os::unix::fs::symlink(
            &outside,
            fixture
                .path()
                .join("profile")
                .join(first_id)
                .join(&entry.payload),
        )
        .unwrap();
        assert!(read_json::<Payload>(&first_dir, &entry.payload, MAX_PAYLOAD).is_err());
        drop(lease);
        assert_eq!(fs::read_to_string(outside).unwrap(), "outside");
        assert!(validate_payload(&payload(&"x".repeat(MAX_FILE_BYTES as usize + 1))).is_err());
    }
}
