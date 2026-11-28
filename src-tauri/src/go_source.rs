use std::{
    io,
    os::fd::AsRawFd,
    path::{Component, Path, PathBuf},
    sync::LazyLock,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    blocking,
    tools::{command, short_output_limited},
    workspace::{observation_root, MAX_FILE_BYTES},
    workspace_disk::{DiskObservation, RootAnchor},
    CommandResult, Core,
};

#[derive(Deserialize)]
struct GoEnvironment {
    #[serde(rename = "GOROOT")]
    go_root: PathBuf,
    #[serde(rename = "GOMODCACHE")]
    module_cache: PathBuf,
}

#[derive(Serialize)]
pub struct GoSource {
    path: String,
    text: String,
}

struct SourceRoot {
    configured: PathBuf,
    path: PathBuf,
    anchor: RootAnchor,
}

impl SourceRoot {
    fn open(configured: PathBuf) -> CommandResult<Self> {
        if !configured.is_absolute() {
            return Err("The Go source root is not absolute.".into());
        }
        let path = configured
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let anchor = RootAnchor::new(&path).map_err(|error| error.to_string())?;
        Ok(Self {
            configured,
            path,
            anchor,
        })
    }

    fn relative<'a>(&self, target: &'a Path) -> Option<&'a Path> {
        target
            .strip_prefix(&self.configured)
            .or_else(|_| target.strip_prefix(&self.path))
            .ok()
    }

    fn inspect(&self, parts: &[&str], limit: u64) -> DiskObservation {
        self.anchor.inspect(&self.path, parts, limit)
    }

    fn read(&self, relative: &Path, parts: &[&str]) -> CommandResult<GoSource> {
        match self.inspect(parts, MAX_FILE_BYTES) {
            DiskObservation::Text { text, .. } => Ok(GoSource { path: self.path.join(relative).to_string_lossy().into_owned(), text }),
            _ => Err("The Go source is missing, changed, or is not a regular UTF-8 file within the size limit.".into()),
        }
    }
}

fn parts(relative: &Path) -> CommandResult<Vec<&str>> {
    let mut parts = Vec::new();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("Invalid Go source path.".into());
        };
        let name = name.to_str().ok_or("The Go source path is not UTF-8.")?;
        if name.contains(['\\', '\0']) || parts.len() >= 64 {
            return Err("Invalid Go source path.".into());
        }
        parts.push(name);
    }
    if parts.last().is_none_or(|name| !name.ends_with(".go")) {
        return Err("Only Go source files are available in the source viewer.".into());
    }
    Ok(parts)
}

fn cache_metadata<'a>(parts: &[&'a str]) -> CommandResult<(Vec<&'a str>, &'a str)> {
    static VERSION: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
            .unwrap()
    });
    let (index, module, version) = parts
        .iter()
        .enumerate()
        .find_map(|(index, part)| {
            let (module, version) = part.split_once('@')?;
            Some((index, module, version))
        })
        .ok_or("The path is not inside a versioned Go dependency.")?;
    if module.is_empty()
        || !VERSION.is_match(version)
        || index + 1 >= parts.len()
        || parts[0] == "cache"
    {
        return Err("The path is not inside a versioned Go dependency.".into());
    }
    if index == 1 && parts[0] == "golang.org" && module == "toolchain" {
        return Err(
            "This source belongs to a different Go toolchain than the workspace uses.".into(),
        );
    }
    let mut metadata = vec!["cache", "download"];
    metadata.extend_from_slice(&parts[..index]);
    metadata.extend([module, "@v"]);
    Ok((metadata, version))
}

fn complete_module(cache: &SourceRoot, parts: &[&str]) -> CommandResult<()> {
    let (mut metadata, version) = cache_metadata(parts)?;
    let marker = format!("{version}.partial");
    let manifest = format!("{version}.mod");
    let hash = format!("{version}.ziphash");
    metadata.push(&marker);
    let partial = cache.inspect(&metadata, 256);
    metadata.pop();
    metadata.push(&manifest);
    let module = cache.inspect(&metadata, MAX_FILE_BYTES);
    metadata.pop();
    metadata.push(&hash);
    if !matches!(partial, DiskObservation::Missing)
        || !matches!(module, DiskObservation::Text { .. })
        || !matches!(cache.inspect(&metadata, 256), DiskObservation::Text { text, .. } if text.starts_with("h1:"))
    {
        return Err(
            "The Go dependency is not completely available in the local module cache.".into(),
        );
    }
    Ok(())
}

fn read_source(environment: GoEnvironment, target: PathBuf) -> CommandResult<GoSource> {
    if !target.is_absolute()
        || target
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("Invalid absolute Go source path.".into());
    }
    if let Ok(root) = SourceRoot::open(environment.go_root) {
        if let Some(relative) = root
            .relative(&target)
            .filter(|path| path.starts_with("src"))
        {
            return root.read(relative, &parts(relative)?);
        }
    }
    let cache = SourceRoot::open(environment.module_cache)
        .map_err(|_| "The local Go module cache is unavailable.")?;
    let relative = cache
        .relative(&target)
        .ok_or("This file is outside the active Go toolchain and local module cache.")?;
    let parts = parts(relative)?;
    complete_module(&cache, &parts)?;
    let source = cache.read(relative, &parts)?;
    complete_module(&cache, &parts)?;
    Ok(source)
}

#[tauri::command]
pub async fn read_go_source(
    state: State<'_, Core>,
    id: u64,
    path: String,
) -> CommandResult<GoSource> {
    let (root, anchor) = observation_root(&state, id)?;
    let mut go = offline_environment(&root, &anchor)?;
    let output = short_output_limited(
        &state,
        &mut go,
        None,
        Duration::from_secs(5),
        "Go source discovery",
        32 * 1024,
    )
    .await?;
    if !output.status.success() {
        return Err(
            "Could not resolve the workspace's Go toolchain without network access.".into(),
        );
    }
    let environment = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Go did not report valid source roots.")?;
    state.0.lock().unwrap().root(id)?;
    anchor.verify(&root)?;
    let result = blocking(move || read_source(environment, PathBuf::from(path))).await?;
    state.0.lock().unwrap().root(id)?;
    anchor.verify(&root)?;
    Ok(result)
}

fn offline_environment(root: &Path, anchor: &RootAnchor) -> CommandResult<tokio::process::Command> {
    anchor.verify(root)?;
    let directory = anchor
        .open_directory(&[])
        .map_err(|error| error.to_string())?;
    let mut go = command("go")?;
    // Keep the admitted directory open through exec; the child only calls fchdir.
    unsafe {
        go.pre_exec(move || {
            if libc::fchdir(directory.as_raw_fd()) == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });
    }
    go.env_remove("PWD")
        .args(["env", "-json", "GOROOT", "GOMODCACHE"])
        .env("GOPROXY", "off")
        .env("GONOPROXY", "none")
        .env("GOSUMDB", "off");
    Ok(go)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink};

    #[test]
    fn canonicalizes_toolchain_root_alias_but_not_source_links() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let actual = root.join("actual");
        fs::create_dir_all(actual.join("src/fmt")).unwrap();
        fs::write(actual.join("src/fmt/print.go"), "package fmt\n").unwrap();
        let alias = root.join("alias");
        symlink(&actual, &alias).unwrap();
        let environment = || GoEnvironment {
            go_root: alias.clone(),
            module_cache: root.join("missing-cache"),
        };
        let source = read_source(environment(), alias.join("src/fmt/print.go")).unwrap();
        assert_eq!(source.text, "package fmt\n");
        assert!(Path::new(&source.path).ends_with("actual/src/fmt/print.go"));
        symlink(
            actual.join("src/fmt/print.go"),
            actual.join("src/fmt/other.go"),
        )
        .unwrap();
        assert!(read_source(environment(), alias.join("src/fmt/other.go")).is_err());
        let oversized = fs::File::create(actual.join("src/fmt/large.go")).unwrap();
        oversized.set_len(MAX_FILE_BYTES + 1).unwrap();
        assert!(read_source(environment(), alias.join("src/fmt/large.go")).is_err());
        assert!(read_source(environment(), root.join("print.go")).is_err());
        let moved = root.join("moved-src");
        fs::rename(actual.join("src"), &moved).unwrap();
        symlink(moved, actual.join("src")).unwrap();
        assert!(read_source(environment(), alias.join("src/fmt/print.go")).is_err());
    }

    #[test]
    fn refuses_discovery_from_a_replacement_workspace() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap().join("project");
        fs::create_dir(&root).unwrap();
        let anchor = RootAnchor::new(&root).unwrap();
        fs::rename(&root, root.with_extension("moved")).unwrap();
        fs::create_dir(&root).unwrap();
        assert!(offline_environment(&root, &anchor)
            .unwrap_err()
            .contains("replaced"));
    }

    #[test]
    fn requires_a_completed_versioned_dependency_and_rejects_nonselected_sdks() {
        let fixture = tempfile::tempdir().unwrap();
        let cache = fixture.path().join("modcache");
        let target = cache.join("example.test/reader@v1.0.0/source.go");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, "package reader\n").unwrap();
        let env = || GoEnvironment {
            go_root: fixture.path().join("absent"),
            module_cache: cache.clone(),
        };
        assert!(read_source(env(), target.clone()).is_err());
        let metadata = cache.join("cache/download/example.test/reader/@v");
        fs::create_dir_all(&metadata).unwrap();
        fs::write(metadata.join("v1.0.0.mod"), "module example.test/reader\n").unwrap();
        fs::write(metadata.join("v1.0.0.ziphash"), "h1:fixture\n").unwrap();
        assert_eq!(
            read_source(env(), target.clone()).unwrap().text,
            "package reader\n"
        );
        fs::write(metadata.join("v1.0.0.partial"), "").unwrap();
        assert!(read_source(env(), target).is_err());
        assert!(cache_metadata(&["example.test", "reader", "source.go"]).is_err());
        assert!(cache_metadata(&[
            "golang.org",
            "toolchain@v0.0.1-go1.99.0.darwin-arm64",
            "src",
            "source.go"
        ])
        .is_err());
    }

    #[tokio::test]
    async fn discovery_is_bounded_and_fails_offline_for_an_unavailable_toolchain() {
        let fixture = tempfile::tempdir().unwrap();
        let core = Core::default();
        let mut echo = tokio::process::Command::new("/bin/echo");
        echo.arg("x".repeat(4096));
        assert!(short_output_limited(
            &core,
            &mut echo,
            None,
            Duration::from_secs(2),
            "fixture",
            1024
        )
        .await
        .unwrap_err()
        .contains("output limit"));
        let root = fixture.path().canonicalize().unwrap();
        let anchor = RootAnchor::new(&root).unwrap();
        let Ok(mut go) = offline_environment(&root, &anchor) else {
            return;
        };
        fs::write(
            fixture.path().join("go.mod"),
            "module example.test/offline\n\ngo 1.99.0\n",
        )
        .unwrap();
        go.env("GOENV", "off")
            .env("GOTOOLCHAIN", "auto")
            .env("GOWORK", "off")
            .env("GOMODCACHE", fixture.path().join("modcache"));
        assert!(go
            .as_std()
            .get_envs()
            .any(|(key, value)| { key == "GOPROXY" && value.is_some_and(|value| value == "off") }));
        let output = short_output_limited(
            &core,
            &mut go,
            None,
            Duration::from_secs(5),
            "Go source discovery",
            32 * 1024,
        )
        .await
        .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success());
        assert!(
            stderr.contains("go1.99.0") && stderr.contains("not available"),
            "{stderr}"
        );
    }
}
