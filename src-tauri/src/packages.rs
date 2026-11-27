use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::State;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    sync::oneshot,
};

use crate::{
    process_owner::{OwnedChild, ProcessGroup},
    tools::command,
    CommandResult, Core,
};

const MAX_METADATA: usize = 2 * 1024 * 1024;
type Processes = Arc<Mutex<ProcessSlot>>;

#[derive(Default)]
struct ProcessSlot {
    cancelled: bool,
    group: Option<Arc<ProcessGroup>>,
}

pub struct Discovery {
    id: u64,
    processes: Processes,
    _cancel: oneshot::Sender<()>,
}

impl Drop for Discovery {
    fn drop(&mut self) {
        let mut slot = self.processes.lock().unwrap();
        slot.cancelled = true;
        if let Some(group) = slot.group.take() {
            group.kill();
        }
    }
}

#[derive(Deserialize)]
struct Module {
    #[serde(rename = "Main", default)]
    main: bool,
    #[serde(rename = "Dir")]
    dir: Option<PathBuf>,
}

#[derive(Deserialize)]
struct Package {
    #[serde(rename = "Dir")]
    dir: Option<PathBuf>,
    #[serde(rename = "ImportPath", default)]
    import_path: String,
    #[serde(rename = "Name", default)]
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTarget {
    package: String,
    import_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoPackages {
    targets: Vec<RunTarget>,
    all_scopes: Vec<String>,
}

fn package_path(root: &Path, dir: &Path) -> Option<String> {
    let relative = dir.strip_prefix(root).ok()?.to_str()?;
    if relative.is_empty() {
        Some(".".into())
    } else {
        Some(format!("./{relative}"))
    }
}

async fn bounded(reader: impl AsyncRead + Unpin, limit: usize) -> CommandResult<Vec<u8>> {
    let mut buffer = vec![];
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut buffer)
        .await
        .map_err(|error| error.to_string())?;
    if buffer.len() > limit {
        return Err("The Go package listing exceeded its size limit.".into());
    }
    Ok(buffer)
}

async fn list<T: DeserializeOwned>(
    root: &Path,
    processes: &Processes,
    args: &[&str],
) -> CommandResult<Vec<T>> {
    let mut child = {
        let mut slot = processes.lock().unwrap();
        if slot.cancelled {
            return Err("Package discovery stopped.".into());
        }
        let child = command("go")?
            .args(args)
            .current_dir(root)
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Start go list: {error}"))?;
        let child = OwnedChild::new(child);
        slot.group = Some(child.group.clone());
        child
    };
    let stdout = child.child.stdout.take().unwrap();
    let stderr = child.child.stderr.take().unwrap();
    let (stdout, stderr, status) = tokio::time::timeout(Duration::from_secs(8), async {
        tokio::try_join!(
            bounded(stdout, MAX_METADATA),
            bounded(stderr, 64 * 1024),
            async { child.wait().await.map_err(|error| error.to_string()) }
        )
    })
    .await
    .map_err(|_| "Go package discovery timed out.".to_owned())??;
    if !status.success() {
        return Err(format!(
            "go list: {}",
            String::from_utf8_lossy(&stderr)
                .trim()
                .chars()
                .take(400)
                .collect::<String>()
        ));
    }
    serde_json::Deserializer::from_slice(&stdout)
        .into_iter::<T>()
        .collect::<Result<_, _>>()
        .map_err(|error| format!("Read go list metadata: {error}"))
}

async fn discover(root: &Path, processes: &Processes) -> CommandResult<GoPackages> {
    let modules = list::<Module>(root, processes, &["list", "-m", "-json"]).await?;
    let mut scopes = BTreeSet::new();
    for module in modules.into_iter().filter(|module| module.main) {
        let Some(dir) = module.dir.and_then(|dir| dir.canonicalize().ok()) else {
            continue;
        };
        if root.starts_with(&dir) {
            scopes.insert("./...".to_owned());
        } else if let Some(package) = package_path(root, &dir) {
            scopes.insert(format!("{package}/..."));
        }
    }
    if scopes.is_empty() {
        return Err("No Go module found in this workspace.".into());
    }
    if scopes.len() > 128 {
        return Err("Open a workspace with at most 128 local Go modules.".into());
    }
    let mut args = vec!["list", "-e", "-find", "-json=Dir,Name,ImportPath"];
    args.extend(scopes.iter().map(String::as_str));
    let packages = list::<Package>(root, processes, &args).await?;
    let mut targets = BTreeMap::new();
    for item in packages.into_iter().filter(|item| item.name == "main") {
        let Some(dir) = item.dir.and_then(|dir| dir.canonicalize().ok()) else {
            continue;
        };
        if let Some(package) = package_path(root, &dir) {
            targets.insert(
                package.clone(),
                RunTarget {
                    package,
                    import_path: item.import_path,
                },
            );
        }
    }
    Ok(GoPackages {
        targets: targets.into_values().collect(),
        all_scopes: scopes.into_iter().collect(),
    })
}

#[tauri::command]
pub async fn discover_packages(state: State<'_, Core>, id: u64) -> CommandResult<GoPackages> {
    let (root, owner, processes, cancelled) = {
        let mut session = state.0.lock().unwrap();
        let root = session.root(id)?.to_path_buf();
        let owner = session.next_id();
        let processes = Processes::default();
        let (cancel, cancelled) = oneshot::channel();
        session.discovery = Some(Discovery {
            id: owner,
            processes: processes.clone(),
            _cancel: cancel,
        });
        (root, owner, processes, cancelled)
    };
    let result = tokio::select! {
        biased;
        _ = cancelled => Err("Package discovery stopped.".into()),
        result = discover(&root, &processes) => result,
    };
    let mut session = state.0.lock().unwrap();
    if session
        .discovery
        .as_ref()
        .is_some_and(|job| job.id == owner)
    {
        session.discovery.take();
    }
    session.root(id)?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_app(root: &Path, folder: &str, filename: &str) {
        let dir = root.join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(filename), "package main\nfunc main() {}\n").unwrap();
    }

    #[tokio::test]
    async fn uses_go_metadata_not_source_filenames_for_runnable_packages() {
        if command("go").is_err() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        fs::write(
            root.join("go.mod"),
            "module example.com/test-fixture\n\ngo 1.22\n",
        )
        .unwrap();
        write_app(&root, "cmd/odd", "entry.go");
        fs::write(root.join("main.go"), "package library\n").unwrap();
        let result = discover(&root, &Processes::default()).await.unwrap();
        assert_eq!(result.all_scopes, ["./..."]);
        assert_eq!(result.targets.len(), 1);
        assert_eq!(result.targets[0].package, "./cmd/odd");
    }

    #[tokio::test]
    async fn discovers_only_local_modules_under_go_work() {
        if command("go").is_err() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().canonicalize().unwrap();
        let root = parent.join("work");
        for (dir, name) in [
            (root.join("one"), "one"),
            (root.join("two"), "two"),
            (parent.join("outside"), "outside"),
        ] {
            write_app(&dir, "", "program.go");
            fs::write(
                dir.join("go.mod"),
                format!("module example.com/{name}\n\ngo 1.22\n"),
            )
            .unwrap();
        }
        fs::write(
            root.join("go.work"),
            "go 1.22\n\nuse (\n ./one\n ./two\n ../outside\n)\n",
        )
        .unwrap();
        let result = discover(&root, &Processes::default()).await.unwrap();
        assert_eq!(result.all_scopes, ["./one/...", "./two/..."]);
        assert_eq!(
            result
                .targets
                .into_iter()
                .map(|target| target.package)
                .collect::<Vec<_>>(),
            ["./one", "./two"]
        );
    }
}
