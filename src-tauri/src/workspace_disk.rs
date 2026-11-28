use std::{
    ffi::CString,
    fs::{File, Metadata},
    io::{self, Read},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, Path},
    sync::Arc,
    time::Duration,
};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::State;
use tokio::sync::watch;

use crate::{
    blocking,
    workspace::{excluded_name, observation_root},
    CommandResult, Core,
};

const DIRECTORY: libc::c_int = libc::O_DIRECTORY;
const FILE: libc::c_int = libc::O_NONBLOCK;

pub(super) fn open_at(parent: &File, name: &[u8], flags: libc::c_int) -> io::Result<File> {
    open_at_mode(parent, name, flags, 0)
}

pub(super) fn create_at(parent: &File, name: &[u8], mode: libc::c_uint) -> io::Result<File> {
    open_at_mode(
        parent,
        name,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | FILE,
        mode,
    )
}

fn open_at_mode(
    parent: &File,
    name: &[u8],
    flags: libc::c_int,
    mode: libc::c_uint,
) -> io::Result<File> {
    let name = CString::new(name)?;
    // The parent descriptor stays open across the call. A successful open
    // transfers the newly allocated descriptor to File.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | flags,
            mode,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

pub(crate) fn open_root(path: &Path) -> io::Result<File> {
    let mut parts = path.components();
    if parts.next() != Some(Component::RootDir) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Expected an absolute workspace path",
        ));
    }
    let mut directory = File::open("/")?;
    for part in parts {
        let Component::Normal(name) = part else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Expected a canonical workspace path",
            ));
        };
        directory = open_at(&directory, name.as_bytes(), DIRECTORY)?;
    }
    Ok(directory)
}

fn identity(info: &Metadata) -> (u64, u64) {
    (info.dev(), info.ino())
}

fn version(info: &Metadata) -> ((u64, u64), u64, u32, i64, i64, i64, i64) {
    (
        identity(info),
        info.len(),
        info.mode(),
        info.mtime(),
        info.mtime_nsec(),
        info.ctime(),
        info.ctime_nsec(),
    )
}

pub(super) fn review_version(info: &Metadata) -> String {
    let ((device, inode), size, mode, modified, modified_ns, changed, changed_ns) = version(info);
    format!("{device:x}:{inode:x}:{size:x}:{mode:x}:{modified:x}:{modified_ns:x}:{changed:x}:{changed_ns:x}")
}

#[derive(Debug, Hash, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiskObservation {
    Text { text: String, version: String },
    Missing,
    Unavailable,
    Retry,
}

#[derive(Clone)]
pub struct RootAnchor {
    root: Arc<File>,
    identity: (u64, u64),
}

impl RootAnchor {
    pub fn new(path: &Path) -> io::Result<Self> {
        let root = open_root(path)?;
        let identity = identity(&root.metadata()?);
        Ok(Self {
            root: Arc::new(root),
            identity,
        })
    }

    pub fn verify(&self, path: &Path) -> CommandResult<()> {
        match open_root(path).and_then(|root| root.metadata()) {
            Ok(info) if identity(&info) == self.identity => Ok(()),
            _ => Err(
                "The workspace folder is unavailable or has been replaced. Reopen it to continue."
                    .into(),
            ),
        }
    }

    pub(super) fn open_directory(&self, parts: &[&str]) -> io::Result<File> {
        let mut directory = self.root.try_clone()?;
        for part in parts {
            directory = open_at(&directory, part.as_bytes(), DIRECTORY)?;
        }
        Ok(directory)
    }

    fn open_file(&self, parts: &[&str]) -> io::Result<File> {
        let (leaf, parents) = parts.split_last().expect("validated workspace path");
        open_at(&self.open_directory(parents)?, leaf.as_bytes(), FILE)
    }

    pub(super) fn source_version(&self, parts: &[&str]) -> CommandResult<String> {
        let file = self.open_file(parts).map_err(|error| error.to_string())?;
        let info = file.metadata().map_err(|error| error.to_string())?;
        if !info.is_file() {
            return Err("The source path is not a regular file.".into());
        }
        Ok(review_version(&info))
    }

    pub fn create_file(&self, path: &Path, parts: &[&str]) -> CommandResult<()> {
        self.verify(path)?;
        let (leaf, parents) = parts.split_last().expect("validated workspace path");
        let mut directory = None;
        for parent in parents {
            let current = directory.as_ref().unwrap_or(self.root.as_ref());
            let name = CString::new(parent.as_bytes()).map_err(|error| error.to_string())?;
            // mkdirat resolves the new directory in the same open parent we
            // later use to open it. A concurrently created symlink is rejected.
            if unsafe { libc::mkdirat(current.as_raw_fd(), name.as_ptr(), 0o777) } != 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::AlreadyExists {
                    return Err(format!("Create directory: {error}"));
                }
            }
            directory = Some(
                open_at(current, parent.as_bytes(), DIRECTORY)
                    .map_err(|error| format!("Open workspace directory: {error}"))?,
            );
        }
        create_at(
            directory.as_ref().unwrap_or(&self.root),
            leaf.as_bytes(),
            0o666,
        )
        .map(|_| ())
        .map_err(|error| format!("Create file: {error}"))
    }

    pub fn inspect(&self, path: &Path, parts: &[&str], limit: u64) -> DiskObservation {
        if self.verify(path).is_err() {
            return DiskObservation::Unavailable;
        }
        let observation = self.inspect_file(parts, limit);
        if self.verify(path).is_err() {
            return DiskObservation::Unavailable;
        }
        observation
    }

    fn inspect_file(&self, parts: &[&str], limit: u64) -> DiskObservation {
        use DiskObservation::*;
        let file = match self.open_file(parts) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Missing,
            Err(_) => return Unavailable,
        };
        let Ok(initial) = file.metadata() else {
            return Unavailable;
        };
        if !initial.is_file() || initial.len() > limit {
            return Unavailable;
        }
        let mut bytes = Vec::new();
        let result = (&file).take(limit + 1).read_to_end(&mut bytes);
        let current = self.open_file(parts).and_then(|current| current.metadata());
        if !current.is_ok_and(|info| version(&info) == version(&initial)) {
            return Retry;
        }
        if result.is_err() || bytes.len() as u64 > limit || bytes.contains(&0) {
            return Unavailable;
        }
        match String::from_utf8(bytes) {
            Ok(text) => Text {
                text,
                version: review_version(&initial),
            },
            Err(_) => Unavailable,
        }
    }
}

pub struct WorkspaceWatch {
    _watcher: RecommendedWatcher,
    revision: watch::Receiver<Option<u32>>,
}

fn relevant(path: &Path, root: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return true;
    };
    !relative
        .components()
        .any(|part| part.as_os_str().to_str().is_some_and(excluded_name))
}

impl WorkspaceWatch {
    fn start(root: &Path) -> CommandResult<Self> {
        let (updates, revision) = watch::channel(Some(0u32));
        let observed_root = root.to_path_buf();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<Event>| match result {
                Ok(event)
                    if event.need_rescan()
                        || (!matches!(event.kind, EventKind::Access(_))
                            && (event.paths.is_empty()
                                || event
                                    .paths
                                    .iter()
                                    .any(|path| relevant(path, &observed_root)))) =>
                {
                    updates.send_modify(|current| {
                        *current = current.map(|revision| revision.wrapping_add(1))
                    });
                }
                Ok(_) => (),
                Err(_) => {
                    updates.send_replace(None);
                }
            })
            .map_err(watch_error)?;
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(watch_error)?;
        Ok(Self {
            _watcher: watcher,
            revision,
        })
    }
}

fn watch_error(error: notify::Error) -> String {
    format!("File watching is unavailable. Use Refresh Project to check for changes. ({error})")
}

#[tauri::command]
pub async fn start_workspace_watch(state: State<'_, Core>, id: u64) -> CommandResult<()> {
    let (root, anchor) = observation_root(&state, id)?;
    let watcher = blocking(move || {
        anchor.verify(&root)?;
        let watcher = WorkspaceWatch::start(&root)?;
        anchor.verify(&root)?;
        Ok(watcher)
    })
    .await?;
    let mut session = state.0.lock().unwrap();
    session.root(id)?;
    session.watcher = Some(watcher);
    Ok(())
}

#[tauri::command]
pub async fn wait_workspace_watch(
    state: State<'_, Core>,
    id: u64,
    revision: u32,
) -> CommandResult<Option<u32>> {
    let (mut updates, root, anchor) = {
        let session = state.0.lock().unwrap();
        let Ok(root) = session.root(id) else {
            return Ok(None);
        };
        let updates = session
            .watcher
            .as_ref()
            .ok_or("The workspace is not being watched.")?
            .revision
            .clone();
        (
            updates,
            root.to_path_buf(),
            session.workspace.as_ref().unwrap().anchor.clone(),
        )
    };
    let failure = loop {
        let changed = updates.wait_for(|latest| *latest != Some(revision));
        let result = tokio::time::timeout(Duration::from_secs(3), changed)
            .await
            .map(|result| result.map(|latest| *latest));
        match result {
            Ok(Ok(Some(latest))) => return Ok(Some(latest)),
            Ok(Ok(None)) => {
                break "File watching stopped. Use Refresh Project to check for changes.".into()
            }
            Ok(Err(_)) => return Ok(None),
            // FSEvents can be silent when an ancestor of the watched root
            // moves. Verify the root identity without rescanning the tree.
            Err(_) => {
                let (root, anchor) = (root.clone(), anchor.clone());
                if let Err(error) = blocking(move || anchor.verify(&root)).await {
                    break error;
                }
            }
        }
    };
    let mut session = state.0.lock().unwrap();
    if session
        .watcher
        .as_ref()
        .is_some_and(|watcher| watcher.revision.same_channel(&updates))
    {
        session.watcher.take();
        return Err(failure);
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn observation_never_adopts_a_replaced_root() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().canonicalize().unwrap().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("file"), "original").unwrap();
        let anchor = RootAnchor::new(&root).unwrap();
        assert!(
            matches!(anchor.inspect(&root, &["file"], 1024), DiskObservation::Text { text, .. } if text == "original")
        );
        fs::rename(&root, parent.path().join("retired")).unwrap();
        fs::create_dir(&root).unwrap();
        fs::write(root.join("file"), "replacement").unwrap();
        assert_eq!(
            anchor.inspect(&root, &["file"], 1024),
            DiskObservation::Unavailable
        );
    }

    #[test]
    fn observation_rejects_replaced_parent_and_fifo_without_opening_outside_text() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().canonicalize().unwrap().join("project");
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("nested/file"), "original").unwrap();
        let anchor = RootAnchor::new(&root).unwrap();
        fs::rename(root.join("nested"), parent.path().join("outside")).unwrap();
        assert_eq!(
            anchor.inspect(&root, &["nested", "file"], 1024),
            DiskObservation::Missing
        );
        std::os::unix::fs::symlink(parent.path().join("outside"), root.join("nested")).unwrap();
        assert_eq!(
            anchor.inspect(&root, &["nested", "file"], 1024),
            DiskObservation::Unavailable
        );
        let fifo = CString::new(root.join("fifo").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert_eq!(
            anchor.inspect(&root, &["fifo"], 1024),
            DiskObservation::Unavailable
        );
    }
}
