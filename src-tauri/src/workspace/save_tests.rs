use super::*;
use std::{
    ffi::CString,
    io::{BufRead, BufReader},
    os::unix::{ffi::OsStrExt, fs::FileTypeExt},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    thread,
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(8);

struct Fixture {
    dir: tempfile::TempDir,
    root: PathBuf,
    profile: PathBuf,
    target: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        let profile = dir.path().join("profile");
        let target = root.join("file.txt");
        fs::create_dir(&root).unwrap();
        fs::write(&target, "original").unwrap();
        Self {
            dir,
            root,
            profile,
            target,
        }
    }

    fn staged(&self, hook: impl FnOnce()) -> CommandResult<()> {
        let mut hook = Some(hook);
        persist_text_impl(
            &self.root,
            &self.profile,
            "file.txt",
            "original",
            "editor",
            None,
            &mut |point| {
                if point == SavePoint::Staged {
                    hook.take().unwrap()();
                }
                Ok(())
            },
        )
    }

    fn only_target(&self) {
        assert_eq!(
            fs::read_dir(&self.root).unwrap().count(),
            1,
            "staging file must be cleaned up"
        );
    }
}

#[test]
fn refuses_to_replace_the_profile_lock_from_an_enclosing_workspace() {
    let fixture = Fixture::new();
    persist_text(
        &fixture.root,
        &fixture.profile,
        "file.txt",
        "original",
        "first",
    )
    .unwrap();
    let lock = fixture.profile.join(SAVE_LOCK);
    let identity = file_identity(&fs::metadata(&lock).unwrap());
    fs::hard_link(&lock, fixture.dir.path().join("alias")).unwrap();
    let mut candidates = vec!["profile/save.lock", "alias"];
    if fixture.profile.join("SAVE.LOCK").exists() {
        candidates.push("profile/SAVE.LOCK");
    }
    for candidate in candidates {
        let result = persist_text(fixture.dir.path(), &fixture.profile, candidate, "", "bad");
        assert_eq!(
            result.unwrap_err(),
            "The app profile's save lock is reserved."
        );
        assert_eq!(file_identity(&fs::metadata(&lock).unwrap()), identity);
        assert_eq!(fs::read(&lock).unwrap(), b"");
    }
}

#[test]
fn cooperating_save_cannot_replace_the_staged_path() {
    let fixture = Fixture::new();
    // Missing pre-lock rejection would deadlock this recursive save. The
    // parent's deadline ensures that regression fails without hanging Cargo.
    let mut worker = Worker::spawn(&fixture, "nested");
    worker.expect("nested committed");
    worker.finish();
    assert_eq!(
        fs::read_to_string(&fixture.target).unwrap(),
        "nested",
        "successful save must commit its own bytes"
    );
    fixture.only_target();
}

#[test]
fn refuses_to_commit_or_remove_a_replaced_staging_path() {
    for destination_also_changed in [false, true] {
        let fixture = Fixture::new();
        let replacement = fixture.dir.path().join("replacement");
        fs::write(&replacement, "other owner").unwrap();
        let replacement_id = file_identity(&fs::metadata(&replacement).unwrap());
        let mut staged = PathBuf::new();
        let result = fixture.staged(|| {
            staged = fs::read_dir(&fixture.root)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| path != &fixture.target)
                .unwrap();
            fs::rename(&replacement, &staged).unwrap();
            if destination_also_changed {
                fs::write(&fixture.target, "changed").unwrap();
            }
        });
        assert!(
            result.is_err(),
            "must not commit a staging file owned by another writer"
        );
        let expected = if destination_also_changed {
            "changed"
        } else {
            "original"
        };
        assert_eq!(fs::read_to_string(&fixture.target).unwrap(), expected);
        assert_eq!(
            file_identity(&fs::metadata(&staged).unwrap()),
            replacement_id
        );
        assert_eq!(fs::read_to_string(&staged).unwrap(), "other owner");
    }
}

#[test]
fn refuses_a_same_byte_replacement_after_staging() {
    let fixture = Fixture::new();
    let replacement = fixture.dir.path().join("replacement");
    fs::write(&replacement, "original").unwrap();
    let identity = file_identity(&fs::metadata(&replacement).unwrap());
    let result = fixture.staged(|| fs::rename(&replacement, &fixture.target).unwrap());
    assert_eq!(result.unwrap_err(), SAVE_CONFLICT);
    assert_eq!(
        file_identity(&fs::metadata(&fixture.target).unwrap()),
        identity
    );
    assert_eq!(fs::read_to_string(&fixture.target).unwrap(), "original");
    fixture.only_target();
}

#[test]
fn reviewed_save_rechecks_identity_and_metadata_under_the_lock() {
    use std::os::unix::fs::PermissionsExt;
    for move_parent in [false, true] {
        let fixture = Fixture::new();
        fs::create_dir(fixture.root.join("nested")).unwrap();
        let target = fixture.root.join("nested/file.txt");
        fs::write(&target, "original").unwrap();
        let workspace = Workspace::open(&fixture.root).unwrap();
        let version = review_version(&target.metadata().unwrap());
        let retired = fixture.root.join("retired");
        let result = persist_text_impl(
            &workspace.root,
            &fixture.profile,
            "nested/file.txt",
            "original",
            "editor",
            Some((&workspace.anchor, Some(&version))),
            &mut |point| {
                if move_parent && point == SavePoint::BeforeStage {
                    fs::rename(fixture.root.join("nested"), &retired).unwrap();
                    fs::create_dir(fixture.root.join("nested")).unwrap();
                    fs::hard_link(retired.join("file.txt"), &target).unwrap();
                }
                if !move_parent && point == SavePoint::Staged {
                    let mut permissions = target.metadata().unwrap().permissions();
                    permissions.set_mode(permissions.mode() ^ 0o100);
                    fs::set_permissions(&target, permissions).unwrap();
                }
                Ok(())
            },
        );
        let error = result.unwrap_err();
        assert!(
            error.contains(if move_parent {
                "directory has been replaced"
            } else {
                "Compare again"
            }),
            "{error}"
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "original");
        assert_eq!(
            fs::read_dir(fixture.root.join("nested")).unwrap().count(),
            1
        );
    }
}

#[test]
fn staging_identity_does_not_depend_on_read_permissions() {
    use std::os::unix::fs::PermissionsExt;
    for conflicting in [false, true] {
        let fixture = Fixture::new();
        let result = fixture.staged(|| {
            let stage = fs::read_dir(&fixture.root)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| path != &fixture.target)
                .unwrap();
            fs::set_permissions(stage, fs::Permissions::from_mode(0)).unwrap();
            if conflicting {
                fs::write(&fixture.target, "external").unwrap();
            }
        });
        if conflicting {
            assert_eq!(result.unwrap_err(), SAVE_CONFLICT);
            assert_eq!(fs::read_to_string(&fixture.target).unwrap(), "external");
        } else {
            result.unwrap();
            fs::set_permissions(&fixture.target, fs::Permissions::from_mode(0o600)).unwrap();
            assert_eq!(fs::read_to_string(&fixture.target).unwrap(), "editor");
        }
        fixture.only_target();
    }
}

#[test]
fn new_path_never_replaces_a_destination_created_after_staging() {
    let fixture = Fixture::new();
    let project = Workspace::open(&fixture.root).unwrap();
    let destination = fixture.root.join("recovered.txt");
    let result = persist_new_text(
        &project.root,
        &project.anchor,
        &fixture.profile,
        "recovered.txt",
        "editor",
        || {
            fs::write(&destination, "other writer").unwrap();
        },
    );
    assert!(result.is_err());
    assert_eq!(fs::read_to_string(destination).unwrap(), "other writer");
    assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 2);
}

#[test]
fn new_path_cannot_create_the_stable_profile_lock_as_a_side_effect() {
    let fixture = Fixture::new();
    fs::create_dir(&fixture.profile).unwrap();
    let workspace = Workspace::open(fixture.dir.path()).unwrap();
    let result = persist_new_text(
        &workspace.root,
        &workspace.anchor,
        &fixture.profile,
        "profile/SAVE.LOCK",
        "does not belong in the profile",
        || {},
    );
    assert!(result
        .unwrap_err()
        .contains("profile directory is reserved"));
    assert_eq!(fs::read_dir(fixture.profile).unwrap().count(), 0);
}

#[test]
fn new_path_cannot_provision_the_requested_destination_as_an_app_directory() {
    let fixture = Fixture::new();
    let workspace = Workspace::open(fixture.dir.path()).unwrap();
    let result = persist_new_text(
        &workspace.root,
        &workspace.anchor,
        &fixture.profile,
        "PROFILE",
        "file contents",
        || {},
    );
    assert!(result
        .unwrap_err()
        .contains("profile directory is reserved"));
    assert!(!fixture.profile.exists());
    assert!(!workspace.root.join("PROFILE").exists());
}

#[test]
fn lock_and_replace_errors_leave_original_bytes() {
    let fixture = Fixture::new();
    // A non-directory in place of the profile makes lock creation fail.
    fs::write(&fixture.profile, "not a directory").unwrap();
    assert!(fixture
        .staged(|| panic!("a lock-open failure must not stage"))
        .unwrap_err()
        .starts_with("Prepare save lock directory:"));
    fs::remove_file(&fixture.profile).unwrap();
    let result = persist_text_impl(
        &fixture.root,
        &fixture.profile,
        "file.txt",
        "original",
        "editor",
        None,
        &mut |point| {
            if point == SavePoint::Validated {
                let staged = fs::read_dir(&fixture.root)
                    .unwrap()
                    .map(|entry| entry.unwrap().path())
                    .find(|path| path != &fixture.target)
                    .unwrap();
                fs::remove_file(staged).unwrap();
            }
            Ok(())
        },
    );
    assert!(result.unwrap_err().starts_with("Save file:"));
    assert_eq!(fs::read_to_string(&fixture.target).unwrap(), "original");
    fixture.only_target();
}

#[test]
fn staging_failure_does_not_change_the_destination() {
    let fixture = Fixture::new();
    let moved = fixture.dir.path().join("moved-project");
    let result = persist_text_impl(
        &fixture.root,
        &fixture.profile,
        "file.txt",
        "original",
        "editor",
        None,
        &mut |point| {
            if point == SavePoint::BeforeStage {
                fs::rename(&fixture.root, &moved).unwrap();
            }
            Ok(())
        },
    );
    assert!(result.unwrap_err().starts_with("Prepare save:"));
    assert_eq!(
        fs::read_to_string(moved.join("file.txt")).unwrap(),
        "original"
    );
    assert_eq!(fs::read_dir(moved).unwrap().count(), 1);
}

#[test]
fn concurrent_processes_share_the_lock_through_commit() {
    let fixture = Fixture::new();
    let mut a = Worker::spawn(&fixture, "first");
    a.expect("first validated");
    let mut b = Worker::spawn(&fixture, "second");
    // This marker is emitted only after the actual OS lock attempt returns
    // WouldBlock on the production lockfile while A is parked with its lock.
    b.expect("second contended");
    a.release();
    a.expect("first committed");
    b.expect("second conflicted");
    a.finish();
    b.finish();
    assert_eq!(fs::read_to_string(&fixture.target).unwrap(), "first");
    fixture.only_target();
}

#[test]
fn fifo_swap_fails_without_holding_the_profile_lock() {
    let fixture = Fixture::new();
    let mut worker = Worker::spawn(&fixture, "fifo");
    worker.expect("fifo refused");
    worker.expect("fifo retry committed");
    worker.finish();
    assert_eq!(fs::read_to_string(&fixture.target).unwrap(), "retry");
    fixture.only_target();
}

struct Worker {
    child: Child,
    input: ChildStdin,
    events: Receiver<String>,
}

impl Worker {
    fn spawn(fixture: &Fixture, role: &str) -> Self {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "workspace::save_tests::save_worker",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("IRON_TEST_SAVE_ROLE", role)
            .env("IRON_TEST_SAVE_FIXTURE", fixture.dir.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (send, events) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(output).lines().map_while(Result::ok) {
                if let Some((_, event)) = line.split_once("IRON_SAVE_EVENT ") {
                    if send.send(event.to_owned()).is_err() {
                        break;
                    }
                }
            }
        });
        Self {
            child,
            input,
            events,
        }
    }

    fn expect(&self, event: &str) {
        assert_eq!(self.events.recv_timeout(TIMEOUT), Ok(event.to_owned()));
    }

    fn release(&mut self) {
        writeln!(self.input, "commit").unwrap();
    }

    fn finish(&mut self) {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success(), "save worker exited with {status}");
                return;
            }
            assert!(Instant::now() < deadline, "save worker did not exit");
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
#[ignore = "spawned with a disposable fixture by the save regression tests"]
fn save_worker() {
    let role = std::env::var("IRON_TEST_SAVE_ROLE").unwrap();
    let dir = PathBuf::from(std::env::var_os("IRON_TEST_SAVE_FIXTURE").unwrap());
    let root = dir.join("project");
    let profile = dir.join("profile");
    let result = persist_text_impl(
        &root,
        &profile,
        "file.txt",
        "original",
        &role,
        None,
        &mut |point| {
            match (role.as_str(), point) {
                ("first", SavePoint::Validated) => {
                    println!("IRON_SAVE_EVENT first validated");
                    let mut release = String::new();
                    io::stdin().read_line(&mut release).unwrap();
                    assert_eq!(release.trim(), "commit");
                }
                ("second", SavePoint::Contended) => println!("IRON_SAVE_EVENT second contended"),
                ("second", SavePoint::Validated) => {
                    panic!("second writer reached commit with the old baseline")
                }
                ("nested", SavePoint::Staged) => {
                    let stage = fs::read_dir(&root)
                        .unwrap()
                        .map(|entry| entry.unwrap().file_name())
                        .find(|name| name != "file.txt")
                        .unwrap();
                    let name = stage.to_str().unwrap();
                    assert!(
                        !collect(&root)
                            .unwrap()
                            .entries
                            .iter()
                            .any(|entry| entry.path == name),
                        "workspace scans must not expose temporary names"
                    );
                    assert!(persist_text(&root, &profile, name, "nested", "wrong bytes")
                        .unwrap_err()
                        .contains("reserved for temporary saves"));
                }
                ("fifo", SavePoint::Staged) => {
                    let path = root.join("file.txt");
                    fs::remove_file(&path).unwrap();
                    let native = CString::new(path.as_os_str().as_bytes()).unwrap();
                    // SAFETY: native is a NUL-terminated path in this test's
                    // disposable workspace, and mkfifo does not retain it.
                    assert_eq!(unsafe { libc::mkfifo(native.as_ptr(), 0o600) }, 0);
                }
                _ => (),
            }
            Ok(())
        },
    );
    match role.as_str() {
        "second" => {
            assert_eq!(result.unwrap_err(), SAVE_CONFLICT);
            println!("IRON_SAVE_EVENT second conflicted");
        }
        "fifo" => {
            assert!(result.unwrap_err().ends_with("expected a regular file."));
            let target = root.join("file.txt");
            assert!(fs::symlink_metadata(&target).unwrap().file_type().is_fifo());
            assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
            println!("IRON_SAVE_EVENT fifo refused");
            fs::remove_file(&target).unwrap();
            fs::write(target, "original").unwrap();
            // Same process: kernel cleanup on process exit cannot hide a
            // lock leaked by the rejected save.
            persist_text(&root, &profile, "file.txt", "original", "retry").unwrap();
            println!("IRON_SAVE_EVENT fifo retry committed");
        }
        "first" | "nested" => {
            result.unwrap();
            println!("IRON_SAVE_EVENT {role} committed");
        }
        _ => panic!("unexpected worker role"),
    }
}
