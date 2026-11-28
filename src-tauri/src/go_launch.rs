use std::{
    fs::File,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

use tokio::process::Command;

use crate::{
    process_owner::bind_child_directory,
    tasks::{literal_package_selector, verify_executable, RunLaunch},
    tools::command,
    workspace::{package_dir, run_directory, Workspace},
    CommandResult,
};

pub(crate) struct PreparedBinary {
    pub directory: tempfile::TempDir,
    pub binary: PathBuf,
    pub working: File,
}

pub(crate) fn prepare_build(
    workspace: &Workspace,
    package: &str,
    launch: &RunLaunch,
    make_directory: impl FnOnce() -> CommandResult<tempfile::TempDir>,
    binary_name: &str,
    flags: &[&str],
) -> CommandResult<(PreparedBinary, Command)> {
    if package.len() > 512 || !literal_package_selector(package) {
        return Err("Choose one local executable Go package.".into());
    }
    launch.validate()?;
    package_dir(&workspace.root, package)?;
    let working = run_directory(workspace, &launch.directory)?;
    let directory = make_directory()?;
    let binary = directory.path().join(binary_name);
    let mut go = command("go")?;
    bind_child_directory(&mut go, run_directory(workspace, ".")?);
    go.arg("build")
        .args(flags)
        .arg("-o")
        .arg(&binary)
        .arg(package);
    Ok((
        PreparedBinary {
            directory,
            binary,
            working,
        },
        go,
    ))
}

pub(crate) fn verify_handoff(
    workspace: &Workspace,
    directory: &str,
    working: &File,
    binary: &Path,
) -> CommandResult<()> {
    verify_working_directory(workspace, directory, working)?;
    verify_executable(binary)
}

fn verify_working_directory(
    workspace: &Workspace,
    directory: &str,
    working: &File,
) -> CommandResult<()> {
    let identity = |file: &File| {
        file.metadata()
            .map(|info| (info.dev(), info.ino()))
            .map_err(|error| error.to_string())
    };
    if identity(&run_directory(workspace, directory)?)? != identity(working)? {
        return Err("The configured working directory was replaced during the build.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink};

    #[test]
    fn a_handoff_requires_the_captured_working_directory_identity() {
        let fixture = tempfile::tempdir().unwrap();
        let current = fixture.path().join("runtime");
        let previous = fixture.path().join("original");
        fs::create_dir(&current).unwrap();
        let workspace = Workspace::open(fixture.path()).unwrap();
        let captured = run_directory(&workspace, "runtime").unwrap();
        assert!(verify_working_directory(&workspace, "runtime", &captured).is_ok());
        fs::rename(&current, &previous).unwrap();
        fs::create_dir(&current).unwrap();
        assert!(verify_working_directory(&workspace, "runtime", &captured)
            .unwrap_err()
            .contains("was replaced"));
        fs::remove_dir(&current).unwrap();
        symlink(&previous, &current).unwrap();
        assert!(verify_working_directory(&workspace, "runtime", &captured).is_err());
    }
}
