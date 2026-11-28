use std::{
    env, fs, io,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Output, Stdio},
    time::Duration,
};

use serde::Serialize;
use tokio::{
    io::{self as async_io, AsyncReadExt, AsyncWriteExt},
    process::Command,
};

use crate::{process_owner::OwnedChild, workspace::MAX_FILE_BYTES, CommandResult, Core};

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

pub(crate) async fn short_output(
    core: &Core,
    command: &mut Command,
    input: Option<String>,
    deadline: Duration,
    tool: &str,
) -> CommandResult<Output> {
    short_output_limited(core, command, input, deadline, tool, usize::MAX).await
}

pub(crate) async fn short_output_limited(
    _core: &Core,
    command: &mut Command,
    input: Option<String>,
    deadline: Duration,
    tool: &str,
    limit: usize,
) -> CommandResult<Output> {
    #[cfg(feature = "e2e")]
    let mut lease = crate::acceptance::ShortTool::admit(_core)?;
    let child = command
        .process_group(0)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Start {tool}: {error}"))?;
    let mut child = OwnedChild::new(child);
    #[cfg(feature = "e2e")]
    lease.require_proof();
    let stdin = child.child.stdin.take();
    let mut stdout = child.child.stdout.take().unwrap();
    let mut stderr = child.child.stderr.take().unwrap();
    let mut out = Vec::new();
    let mut err = Vec::new();
    let read_limit = (limit as u64).saturating_add(1);
    let result = tokio::time::timeout(deadline, async {
        let (written, read_out, read_err) = tokio::join!(
            async move {
                if let (Some(mut pipe), Some(text)) = (stdin, input) {
                    pipe.write_all(text.as_bytes()).await?;
                }
                Ok::<_, io::Error>(())
            },
            async { (&mut stdout).take(read_limit).read_to_end(&mut out).await },
            async { (&mut stderr).take(read_limit).read_to_end(&mut err).await },
        );
        read_out.and(read_err)?;
        if out.len() > limit || err.len() > limit {
            return Err(io::Error::other(format!(
                "{tool} exceeded its output limit."
            )));
        }
        // Keep the leader unreaped until EOF on both pipes. On a timeout
        // an inherited pipe can still belong to a live member of this group.
        Ok::<_, io::Error>((written, child.wait().await?))
    })
    .await;
    match result {
        Ok(Ok((written, status))) => {
            #[cfg(feature = "e2e")]
            lease.confirm_cleanup();
            if status.success() {
                written.map_err(|error| error.to_string())?;
            }
            Ok(Output {
                status,
                stdout: out,
                stderr: err,
            })
        }
        failure => {
            child.group.kill();
            let cleanup = tokio::time::timeout(Duration::from_secs(1), async {
                let mut out_sink = async_io::sink();
                let mut err_sink = async_io::sink();
                tokio::try_join!(
                    child.wait(),
                    async_io::copy(&mut stdout, &mut out_sink),
                    async_io::copy(&mut stderr, &mut err_sink)
                )
            })
            .await;
            match cleanup {
                Ok(Ok(_)) => {
                    #[cfg(feature = "e2e")]
                    lease.confirm_cleanup();
                }
                _ => return Err(format!("Could not verify {tool} cleanup.")),
            }
            Err(match failure {
                Ok(Err(error)) => error.to_string(),
                _ => format!("{tool} timed out."),
            })
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoTools {
    go_version: Option<String>,
    gofmt: bool,
    gopls: bool,
    delve: bool,
}

#[tauri::command]
pub async fn go_tools(_state: tauri::State<'_, crate::Core>) -> CommandResult<GoTools> {
    #[cfg(feature = "e2e")]
    _state.0.lock().unwrap().acceptance.check()?;
    let go_version = if let Ok(mut go) = command("go") {
        go.env("GOTOOLCHAIN", "local").arg("version");
        short_output(&_state, &mut go, None, Duration::from_secs(3), "go version")
            .await
            .ok()
            .filter(|out| out.status.success())
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .and_then(|text| text.split_whitespace().nth(2).map(str::to_owned))
    } else {
        None
    };
    Ok(GoTools {
        go_version,
        gofmt: command("gofmt").is_ok(),
        gopls: command("gopls").is_ok(),
        delve: command("dlv").is_ok(),
    })
}

#[tauri::command]
pub async fn format_go(state: tauri::State<'_, Core>, text: String) -> CommandResult<String> {
    format_text(&state, text).await
}

async fn format_text(core: &Core, text: String) -> CommandResult<String> {
    if text.len() as u64 > MAX_FILE_BYTES {
        return Err("The buffer is too large to format.".into());
    }
    let output = short_output(
        core,
        &mut command("gofmt")?,
        Some(text),
        Duration::from_secs(8),
        "gofmt",
    )
    .await?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    String::from_utf8(output.stdout).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn formats_buffers_and_reports_syntax_errors() {
        if super::command("gofmt").is_err() {
            return;
        }
        let core = crate::Core::default();
        assert_eq!(
            super::format_text(&core, "package main\nfunc main(){ }".into())
                .await
                .unwrap(),
            "package main\n\nfunc main() {}\n"
        );
        assert!(super::format_text(&core, "package main\nfunc {".into())
            .await
            .is_err());
    }
}
