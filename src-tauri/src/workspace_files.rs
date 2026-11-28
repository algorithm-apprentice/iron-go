use std::{
    collections::{BTreeMap, HashSet},
    ffi::CString,
    fs::File,
    io,
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::{Path, PathBuf},
};

use objc2::rc::autoreleasepool;
use objc2_foundation::{NSFileManager, NSString, NSURL};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::{
    blocking,
    drafts::{self, subtree},
    workspace::{
        components, descriptor_path, excluded_name, observation_root, open_save_lock,
        verify_save_directory, Workspace,
    },
    workspace_disk::{open_at, review_version, DiskObservation, RootAnchor},
    CommandResult, Core,
};

#[derive(Serialize)]
pub struct FileOperationSource {
    version: String,
    directory: bool,
}

#[derive(Deserialize)]
pub struct Baseline {
    path: String,
    version: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Operation {
    NewFolder {
        path: String,
    },
    Move {
        source: String,
        destination: String,
        version: String,
        revision: u64,
        baselines: Vec<Baseline>,
    },
    Trash {
        source: String,
        version: String,
        revision: u64,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Outcome {
    Folder {
        path: String,
    },
    Moved {
        path: String,
        versions: BTreeMap<String, String>,
    },
    Trashed {
        path: String,
    },
    Stranded {
        path: String,
        error: String,
    },
    UnverifiedMove {
        path: String,
        error: String,
    },
}

#[derive(Serialize)]
pub struct Mutation {
    outcome: Outcome,
    warning: Option<String>,
}

fn failure(label: &'static str) -> impl FnOnce(io::Error) -> String {
    move |error| format!("{label}: {error}")
}

fn parts(path: &str) -> CommandResult<Vec<&str>> {
    let parts = components(path)?;
    if path.len() > 1024 || parts.iter().any(|name| excluded_name(name)) {
        return Err("Choose an indexed workspace path.".into());
    }
    Ok(parts)
}

struct Location<'a> {
    root: &'a Path,
    anchor: &'a RootAnchor,
    parts: Vec<&'a str>,
    parent: File,
}

impl<'a> Location<'a> {
    fn new(root: &'a Path, anchor: &'a RootAnchor, path: &'a str) -> CommandResult<Self> {
        let parts = parts(path)?;
        let parent = anchor
            .open_directory(&parts[..parts.len() - 1])
            .map_err(failure("Open workspace parent"))?;
        let expected = root.join(path).parent().unwrap().to_path_buf();
        if descriptor_path(&parent).map_err(failure("Read workspace parent"))? != expected {
            return Err("Choose the workspace parent's actual spelling.".into());
        }
        Ok(Self {
            root,
            anchor,
            parts,
            parent,
        })
    }

    fn leaf(&self) -> &str {
        self.parts[self.parts.len() - 1]
    }

    fn verify(&self) -> CommandResult<()> {
        verify_save_directory(
            self.root,
            self.anchor,
            &self.parts[..self.parts.len() - 1],
            &self.parent,
        )
    }

    fn open(&self) -> CommandResult<File> {
        let file = open_at(&self.parent, self.leaf().as_bytes(), libc::O_NONBLOCK)
            .map_err(failure("Open workspace item"))?;
        let info = file.metadata().map_err(failure("Inspect workspace item"))?;
        if !info.is_dir() && (!info.is_file() || info.nlink() != 1) {
            return Err(
                "Only regular files without aliases and ordinary directories can be moved.".into(),
            );
        }
        let actual = descriptor_path(&file).map_err(failure("Read workspace item path"))?;
        if actual != self.root.join(self.parts.join("/")) {
            return Err("Choose the item's actual spelling.".into());
        }
        Ok(file)
    }

    fn protect(&self, profile: &ProfileBoundary, source: Option<&File>) -> CommandResult<()> {
        let path = self.root.join(self.parts.join("/"));
        let is_ancestor = if let Some(source) = source {
            let info = source
                .metadata()
                .map_err(failure("Inspect protected paths"))?;
            info.is_dir() && profile.ancestors.contains(&(info.dev(), info.ino()))
        } else {
            false
        };
        if path.starts_with(&profile.path) || profile.path.starts_with(&path) || is_ancestor {
            return Err(
                "The app profile, its ancestors, and its contents cannot be changed here.".into(),
            );
        }
        for depth in 0..self.parts.len() {
            let ancestor = self
                .anchor
                .open_directory(&self.parts[..depth])
                .map_err(failure("Verify protected path ancestors"))?;
            if identity(&ancestor).map_err(failure("Inspect protected path ancestors"))?
                == profile.identity
            {
                return Err("The app profile and its contents cannot be changed here.".into());
            }
        }
        Ok(())
    }
}

struct ProfileBoundary {
    path: PathBuf,
    identity: (u64, u64),
    ancestors: HashSet<(u64, u64)>,
}

impl ProfileBoundary {
    fn new(path: PathBuf) -> CommandResult<Self> {
        let identity_of = |path: &Path| {
            crate::workspace_disk::open_root(path)
                .and_then(|file| identity(&file))
                .map_err(failure("Verify app profile identity"))
        };
        let identity = identity_of(&path)?;
        let ancestors = path
            .ancestors()
            .map(identity_of)
            .collect::<CommandResult<_>>()?;
        Ok(Self {
            path,
            identity,
            ancestors,
        })
    }
}

fn identity(file: &File) -> io::Result<(u64, u64)> {
    file.metadata().map(|info| (info.dev(), info.ino()))
}

fn rename_exclusive(from: &File, leaf: &str, to: &File, destination: &str) -> io::Result<()> {
    let leaf = CString::new(leaf)?;
    let destination = CString::new(destination)?;
    if unsafe {
        libc::renameatx_np(
            from.as_raw_fd(),
            leaf.as_ptr(),
            to.as_raw_fd(),
            destination.as_ptr(),
            libc::RENAME_EXCL,
        )
    } == 0
    {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn make_directory(dir: &File, name: &str, mode: libc::mode_t) -> io::Result<()> {
    let name = CString::new(name)?;
    if unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), mode) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn verify_source(location: &Location<'_>, file: &File, version: &str) -> CommandResult<()> {
    location.verify()?;
    let current = location.open()?;
    let info = current
        .metadata()
        .map_err(failure("Recheck workspace item"))?;
    if identity(file).map_err(failure("Recheck original workspace item"))?
        != (info.dev(), info.ino())
        || review_version(&info) != version
    {
        return Err(
            "The confirmed workspace item changed. Select it again before continuing.".into(),
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn inspect_file_operation(
    state: State<'_, Core>,
    id: u64,
    path: String,
) -> CommandResult<FileOperationSource> {
    let (root, anchor) = observation_root(&state, id)?;
    blocking(move || {
        let loc = Location::new(&root, &anchor, &path)?;
        loc.verify()?;
        let info = loc
            .open()?
            .metadata()
            .map_err(failure("Inspect workspace item"))?;
        Ok(FileOperationSource {
            version: review_version(&info),
            directory: info.is_dir(),
        })
    })
    .await
}

#[tauri::command]
pub async fn mutate_workspace_files(
    app: AppHandle,
    id: u64,
    operation: Operation,
) -> CommandResult<Mutation> {
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    blocking(move || {
        let state = app.state::<Core>();
        let (lease, workspace) = {
            let mut session = state.0.lock().unwrap();
            session.root(id)?;
            let workspace = session.workspace.as_ref().unwrap().clone();
            let lease = crate::workspace_admission::Lease::begin(
                &app,
                &mut session,
                crate::workspace_admission::Kind::Mutation,
            )?;
            (lease, workspace)
        };
        let lock = open_save_lock(&data)?;
        let info = lock.metadata().map_err(failure("Inspect Save lock"))?;
        if !info.is_file() || info.nlink() != 1 {
            return Err("The Save lock is not a private regular file.".into());
        }
        lock.lock().map_err(failure("Acquire Save lock"))?;
        let profile = ProfileBoundary::new(
            data.canonicalize()
                .map_err(failure("Resolve app profile"))?,
        )?;
        workspace.anchor.verify(&workspace.root)?;
        lease.check(&state.0.lock().unwrap())?;
        match operation {
            Operation::NewFolder { path } => {
                let loc = Location::new(&workspace.root, &workspace.anchor, &path)?;
                loc.protect(&profile, None)?;
                loc.verify()?;
                lease.admit_effect()?;
                make_directory(&loc.parent, loc.leaf(), 0o777).map_err(failure("Create folder"))?;
                Ok(Mutation {
                    outcome: Outcome::Folder { path },
                    warning: None,
                })
            }
            Operation::Move {
                source,
                destination,
                version,
                revision,
                baselines,
            } => {
                if subtree(&destination, &source) || baselines.len() > 128 || revision == 0 {
                    return Err("Choose a different destination outside the source.".into());
                }
                move_item(
                    &app,
                    &workspace,
                    &profile,
                    &source,
                    &destination,
                    &version,
                    revision,
                    baselines,
                    &lease,
                )
            }
            Operation::Trash {
                source,
                version,
                revision,
            } => {
                if revision == 0 {
                    return Err("The Trash operation has no recovery revision.".into());
                }
                let from = Location::new(&workspace.root, &workspace.anchor, &source)?;
                let file = from.open()?;
                from.protect(&profile, Some(&file))?;
                let (outcome, warning) = drafts::rebind_paths(
                    &app,
                    &workspace,
                    &source,
                    None,
                    revision,
                    || lease.admit_effect(),
                    || {
                        verify_source(&from, &file, &version)?;
                        let outcome = trash_item(&from, &file, platform_trash)?;
                        let trashed = matches!(outcome, Outcome::Trashed { .. });
                        Ok((outcome, trashed))
                    },
                )?;
                Ok(Mutation { outcome, warning })
            }
        }
    })
    .await
}

fn move_item(
    app: &AppHandle,
    workspace: &Workspace,
    profile: &ProfileBoundary,
    source: &str,
    destination: &str,
    version: &str,
    revision: u64,
    baselines: Vec<Baseline>,
    lease: &crate::workspace_admission::Lease,
) -> CommandResult<Mutation> {
    let from = Location::new(&workspace.root, &workspace.anchor, source)?;
    let to = Location::new(&workspace.root, &workspace.anchor, destination)?;
    let file = from.open()?;
    from.protect(profile, Some(&file))?;
    to.protect(profile, None)?;
    let (outcome, warning) = drafts::rebind_paths(
        app,
        workspace,
        source,
        Some(destination),
        revision,
        || lease.admit_effect(),
        || {
            let verified = baselines
                .iter()
                .filter(|baseline| subtree(&baseline.path, source))
                .filter_map(|baseline| {
                    let location =
                        Location::new(&workspace.root, &workspace.anchor, &baseline.path).ok()?;
                    let file = location.open().ok()?;
                    let info = file.metadata().ok()?;
                    if review_version(&info) != baseline.version || !info.is_file() {
                        return None;
                    }
                    // A direct rename can update the file's ctime. Capture
                    // its exact bytes while its original token is still live.
                    let original = if baseline.path == source {
                        match workspace.anchor.inspect(
                            &workspace.root,
                            &location.parts,
                            crate::workspace::MAX_FILE_BYTES,
                        ) {
                            DiskObservation::Text { text, version }
                                if version == baseline.version =>
                            {
                                Some(text)
                            }
                            _ => None,
                        }
                    } else {
                        None
                    };
                    Some((baseline, file, original))
                })
                .collect::<Vec<_>>();
            verify_source(&from, &file, version)?;
            to.verify()?;
            rename_exclusive(&from.parent, from.leaf(), &to.parent, to.leaf())
                .map_err(failure("Move without replacing a destination"))?;
            let relative = match confirm_move_destination(&to, &file) {
                Ok(relative) => relative,
                Err(error) => {
                    return Ok((
                        Outcome::UnverifiedMove {
                            path: destination.to_owned(),
                            error,
                        },
                        false,
                    ))
                }
            };
            let mut versions = BTreeMap::new();
            for (old, before, original) in verified {
                let path = format!("{relative}{}", &old.path[source.len()..]);
                let Ok(location) = Location::new(&workspace.root, &workspace.anchor, &path) else {
                    continue;
                };
                let Ok(after) = location.open() else {
                    continue;
                };
                if !identity(&before)
                    .ok()
                    .is_some_and(|prior| identity(&after).ok() == Some(prior))
                {
                    continue;
                }
                let Ok(info) = after.metadata() else {
                    continue;
                };
                let current = review_version(&info);
                let unchanged = current == old.version || original.is_some_and(|expected| matches!(
                    workspace.anchor.inspect(&workspace.root, &location.parts, crate::workspace::MAX_FILE_BYTES),
                    DiskObservation::Text { text, version } if text == expected && version == current
                ));
                if unchanged {
                    versions.insert(path, current);
                }
            }
            let exact = relative == destination;
            Ok((
                Outcome::Moved {
                    path: relative,
                    versions,
                },
                exact,
            ))
        },
    )?;
    let warning = warning.or_else(|| matches!(&outcome, Outcome::Moved { path, .. } if path != destination)
        .then(|| "The filesystem returned a different spelling. The original recovery snapshot remains available.".to_owned()));
    Ok(Mutation { outcome, warning })
}

fn confirm_move_destination(to: &Location<'_>, source: &File) -> CommandResult<String> {
    to.verify()?;
    let moved = open_at(&to.parent, to.leaf().as_bytes(), libc::O_NONBLOCK)
        .map_err(failure("Verify renamed item"))?;
    if identity(source).map_err(failure("Inspect original item"))?
        != identity(&moved).map_err(failure("Inspect renamed item"))?
    {
        return Err("The destination does not name the item that was approved.".into());
    }
    let actual = descriptor_path(&moved).map_err(failure("Resolve renamed item"))?;
    if actual.parent()
        != Some(
            descriptor_path(&to.parent)
                .map_err(failure("Resolve renamed item's parent"))?
                .as_path(),
        )
    {
        return Err("The moved item's parent changed.".into());
    }
    let relative = actual
        .strip_prefix(to.root)
        .ok()
        .and_then(Path::to_str)
        .ok_or("The renamed item is outside the admitted root.")?;
    parts(relative)?;
    Ok(relative.to_owned())
}

fn trash_item(
    from: &Location<'_>,
    file: &File,
    trash: impl FnOnce(&Path) -> CommandResult<String>,
) -> CommandResult<Outcome> {
    let name = drafts::unique(".iron-go-trash-");
    let parent_path = descriptor_path(&from.parent).map_err(failure("Resolve item parent"))?;
    let staged = parent_path.join(&name).join(from.leaf());
    make_directory(&from.parent, &name, 0o700).map_err(failure("Prepare private Trash stage"))?;
    let cleanup = || {
        let _ = drafts::unlink(&from.parent, &name, libc::AT_REMOVEDIR);
    };
    let directory = match open_at(&from.parent, name.as_bytes(), libc::O_DIRECTORY) {
        Ok(directory) => directory,
        Err(error) => {
            cleanup();
            return Err(failure("Open private Trash stage")(error));
        }
    };
    if let Err(error) = rename_exclusive(&from.parent, from.leaf(), &directory, from.leaf()) {
        cleanup();
        return Err(failure("Stage item for Trash")(error));
    }
    let verify_stage = || -> CommandResult<()> {
        from.verify()?;
        let current = open_at(&from.parent, name.as_bytes(), libc::O_DIRECTORY)
            .map_err(failure("Recheck Trash stage"))?;
        let item = open_at(&current, from.leaf().as_bytes(), libc::O_NONBLOCK)
            .map_err(failure("Recheck staged item"))?;
        let same = |first: &File, second: &File| {
            identity(first)
                .ok()
                .is_some_and(|before| identity(second).ok() == Some(before))
        };
        if !same(&current, &directory)
            || !same(&item, file)
            || descriptor_path(&item).ok().as_deref() != Some(&staged)
        {
            return Err("The private Trash stage was replaced.".into());
        }
        Ok(())
    };
    match verify_stage().and_then(|()| trash(&staged)) {
        Ok(path) => {
            cleanup();
            Ok(Outcome::Trashed { path })
        }
        Err(error) => {
            if verify_stage()
                .and_then(|()| {
                    rename_exclusive(&directory, from.leaf(), &from.parent, from.leaf())
                        .map_err(failure("Restore the original name"))
                })
                .is_ok()
            {
                cleanup();
                Err(format!(
                    "Move to Trash failed; the item was restored: {error}"
                ))
            } else {
                let path = descriptor_path(file)
                    .unwrap_or(staged)
                    .to_string_lossy()
                    .into_owned();
                Ok(Outcome::Stranded { path, error })
            }
        }
    }
}

fn platform_trash(path: &Path) -> CommandResult<String> {
    autoreleasepool(|_| {
        let source = NSURL::fileURLWithPath(&NSString::from_str(
            path.to_str().ok_or("The staged path is not UTF-8.")?,
        ));
        let manager = NSFileManager::defaultManager();
        #[cfg(feature = "e2e")]
        let isolated = {
            use objc2_foundation::{NSSearchPathDirectory, NSSearchPathDomainMask};
            let expected = std::env::var_os("IRON_GO_E2E_TRASH_ROOT")
                .map(PathBuf::from)
                .ok_or("Native acceptance requires a disposable Trash volume.")?;
            let url = manager
                .URLForDirectory_inDomain_appropriateForURL_create_error(
                    NSSearchPathDirectory::TrashDirectory,
                    NSSearchPathDomainMask::UserDomainMask,
                    Some(&source),
                    false,
                )
                .map_err(|error| error.to_string())?;
            let actual = url.path().ok_or("The isolated Trash URL is unavailable.")?;
            let actual = PathBuf::from(actual.to_string())
                .canonicalize()
                .map_err(failure("Verify disposable Trash"))?;
            if actual
                != expected
                    .canonicalize()
                    .map_err(failure("Verify expected Trash"))?
            {
                return Err("Foundation resolved Trash outside the disposable volume.".into());
            }
            actual
        };
        let mut result = None;
        manager
            .trashItemAtURL_resultingItemURL_error(&source, Some(&mut result))
            .map_err(|error| error.to_string())?;
        let trashed = result
            .and_then(|url| url.path())
            .map(|path| path.to_string())
            .unwrap_or_default();
        #[cfg(feature = "e2e")]
        if !Path::new(&trashed).starts_with(&isolated) {
            return Err("Foundation reported Trash outside the disposable volume.".into());
        }
        Ok(trashed)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn refuses_profile_ancestors_and_profile_aliases_by_directory_identity() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        fs::create_dir_all(root.join("parent/profile")).unwrap();
        let anchor = RootAnchor::new(&root).unwrap();
        let mut profile = ProfileBoundary::new(root.join("parent/profile")).unwrap();
        let parent = Location::new(&root, &anchor, "parent").unwrap();
        assert!(parent
            .protect(&profile, Some(&parent.open().unwrap()))
            .is_err());
        // The displayed route differs, but these held directory identities
        // still belong to the profile and its descendants.
        profile.path = root.join("different-spelling/profile");
        let alias = Location::new(&root, &anchor, "parent/profile").unwrap();
        assert!(alias
            .protect(&profile, Some(&alias.open().unwrap()))
            .is_err());
        let descendant = Location::new(&root, &anchor, "parent/profile/new-folder").unwrap();
        assert!(descendant.protect(&profile, None).is_err());
    }

    #[test]
    fn renamed_destination_must_name_the_confirmed_inode() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        fs::write(root.join("source.txt"), "same bytes").unwrap();
        fs::write(root.join("destination.txt"), "same bytes").unwrap();
        let anchor = RootAnchor::new(&root).unwrap();
        let location = Location::new(&root, &anchor, "destination.txt").unwrap();
        let source = File::open(root.join("source.txt")).unwrap();
        assert!(confirm_move_destination(&location, &source).is_err());
    }

    #[test]
    fn finder_failure_rolls_back_without_overwriting_a_later_replacement() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let original = root.join("original.txt");
        fs::write(&original, "old bytes").unwrap();
        let anchor = RootAnchor::new(&root).unwrap();
        let source = Location::new(&root, &anchor, "original.txt").unwrap();
        let file = source.open().unwrap();
        assert!(
            trash_item(&source, &file, |_| Err("simulated Finder failure".into()))
                .unwrap_err()
                .contains("restored")
        );
        assert_eq!(fs::read_to_string(&original).unwrap(), "old bytes");
        let result = trash_item(&source, &file, |_| {
            fs::write(&original, "old bytes").unwrap();
            Err("simulated Finder failure after another process creates the original name".into())
        })
        .unwrap();
        let Outcome::Stranded { path, .. } = result else {
            panic!("the original item was not reported as stranded");
        };
        assert_eq!(fs::read_to_string(path).unwrap(), "old bytes");
        assert_eq!(fs::read_to_string(&original).unwrap(), "old bytes");
        assert_ne!(
            identity(&file).unwrap(),
            identity(&File::open(original).unwrap()).unwrap()
        );
    }
}
