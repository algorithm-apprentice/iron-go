use std::{
    env, fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicI32, Ordering},
        Arc,
    },
    time::Duration,
};

use serde::Serialize;
use tokio::{io::AsyncWriteExt, process::Command};

use crate::{workspace::MAX_FILE_BYTES, CommandResult};

pub fn command(tool: &str) -> CommandResult<Command> {
    let mut paths = env::split_paths(&env::var_os("PATH").unwrap_or_default())
        .filter(|path| path.is_absolute())
        .collect::<Vec<_>>();
    if let Some(bin) = env::var_os("GOBIN") {
        paths.push(PathBuf::from(bin));
    }
    if let Some(gopath) = env::var_os("GOPATH") {
        paths.extend(env::split_paths(&gopath).map(|path| path.join("bin")));
    }
    if let Some(home) = env::var_os("HOME") {
        paths.push(PathBuf::from(home).join("go/bin"));
    }
    paths.extend(
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/local/go/bin",
            "/usr/bin",
            "/bin",
        ]
        .map(PathBuf::from),
    );
    paths.retain(|path| path.is_absolute());
    let executable = paths
        .iter()
        .map(|path| path.join(tool))
        .find(|path| {
            fs::metadata(path)
                .is_ok_and(|info| info.is_file() && info.permissions().mode() & 0o111 != 0)
        })
        .ok_or_else(|| format!("{tool} not found. Install it and add its folder to PATH."))?;
    let mut command = Command::new(executable);
    command.env(
        "PATH",
        env::join_paths(paths).map_err(|error| error.to_string())?,
    );
    command.kill_on_drop(true);
    Ok(command)
}

// Go Run starts a compiled program underneath the toolchain process. Stop the
// whole group, not just `go`, and allow workspace switch/quit to kill it even
// when the async runtime is about to shut down.
pub struct ProcessGroup(AtomicI32);

impl ProcessGroup {
    pub fn from_pid(pid: u32) -> Arc<Self> {
        Arc::new(Self(AtomicI32::new(pid as i32)))
    }

    pub fn kill(&self) {
        let pid = self.0.swap(0, Ordering::AcqRel);
        if pid > 0 {
            // SAFETY: a positive child pid, negated to address its process group.
            unsafe { libc::kill(-pid, libc::SIGKILL) };
        }
    }

    pub fn disarm(&self) {
        self.0.store(0, Ordering::Release);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoTools {
    go_version: Option<String>,
    gofmt: bool,
    gopls: bool,
}

#[tauri::command]
pub async fn go_tools() -> GoTools {
    let go_version = if let Ok(mut go) = command("go") {
        tokio::time::timeout(
            Duration::from_secs(3),
            go.env("GOTOOLCHAIN", "local").arg("version").output(),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .and_then(|text| text.split_whitespace().nth(2).map(str::to_owned))
    } else {
        None
    };
    GoTools {
        go_version,
        gofmt: command("gofmt").is_ok(),
        gopls: command("gopls").is_ok(),
    }
}

#[tauri::command]
pub async fn format_go(text: String) -> CommandResult<String> {
    if text.len() as u64 > MAX_FILE_BYTES {
        return Err("The buffer is too large to format.".into());
    }
    let mut child = command("gofmt")?
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Start gofmt: {error}"))?;
    let mut stdin = child.stdin.take().unwrap();
    let output = tokio::time::timeout(Duration::from_secs(8), async {
        let (written, output) = tokio::join!(
            async move { stdin.write_all(text.as_bytes()).await },
            child.wait_with_output(),
        );
        let output = output.map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
        }
        written.map_err(|error| error.to_string())?;
        String::from_utf8(output.stdout).map_err(|error| error.to_string())
    });
    output.await.map_err(|_| "gofmt timed out.".to_owned())?
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn formats_buffers_and_reports_syntax_errors() {
        if super::command("gofmt").is_err() {
            return;
        }
        assert_eq!(
            super::format_go("package main\nfunc main(){ }".into())
                .await
                .unwrap(),
            "package main\n\nfunc main() {}\n"
        );
        assert!(super::format_go("package main\nfunc {".into())
            .await
            .is_err());
    }
}
