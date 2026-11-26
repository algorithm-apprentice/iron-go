use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use regex::RegexBuilder;
use serde::Serialize;
use tauri::State;

use crate::{blocking, CommandResult, Core};

pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ENTRIES: usize = 6_000;
const MAX_DEPTH: usize = 40;
const MAX_RESULTS: usize = 200;
const MAX_SEARCH_BYTES: usize = 32 * 1024 * 1024;
const HIDDEN: &[&str] = &[".git", ".DS_Store", "node_modules"];

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
        Ok(Self {
            info: WorkspaceInfo { id: 0, name, path },
            root,
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
    let info = fs::metadata(&path).map_err(fail("Read file"))?;
    if !info.is_file() || info.len() > limit {
        return Err("Open a regular text file smaller than the size limit (2 MB).".into());
    }
    File::open(path)
        .map_err(fail("Open file"))?
        .take(limit + 1)
        .read_to_string(&mut text)
        .map_err(fail("Read UTF-8 text"))?;
    if text.as_bytes().contains(&0) || text.len() as u64 > limit {
        return Err("Binary or oversized files cannot be opened in the editor.".into());
    }
    Ok(text)
}

fn persist_text(root: &Path, relative: &str, expected: &str, text: &str) -> CommandResult<()> {
    if text.len() as u64 > MAX_FILE_BYTES || text.as_bytes().contains(&0) {
        return Err("Save a UTF-8 text file smaller than 2 MB.".into());
    }
    let path = direct_path(root, &components(relative)?)?;
    if read_text(root, relative, MAX_FILE_BYTES)? != expected {
        return Err("The file changed on disk. Reload the tab before saving.".into());
    }
    let permissions = fs::metadata(&path)
        .map_err(fail("Read permissions"))?
        .permissions();
    let mut temp =
        tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(fail("Prepare save"))?;
    temp.write_all(text.as_bytes())
        .map_err(fail("Write file"))?;
    temp.as_file()
        .set_permissions(permissions)
        .map_err(fail("Set file permissions"))?;
    temp.persist(&path)
        .map_err(|error| fail("Save file")(error.error))?;
    Ok(())
}

fn new_file(root: &Path, relative: &str) -> CommandResult<()> {
    let parts = components(relative)?;
    if parts.iter().any(|part| HIDDEN.contains(part)) {
        return Err("This path is excluded from the workspace tree.".into());
    }
    let (name, directories) = parts.split_last().unwrap();
    let mut path = root.to_path_buf();
    for directory in directories {
        path.push(directory);
        match fs::create_dir(&path) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(fail("Create directory")(error)),
        }
        if !fs::symlink_metadata(&path)
            .map_err(fail("Read directory"))?
            .is_dir()
        {
            return Err(
                "A parent segment is not a directory (symbolic links are excluded).".into(),
            );
        }
    }
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path.join(name))
        .map_err(fail("Create file"))?;
    Ok(())
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
            if HIDDEN.contains(&name) || name.contains('\\') {
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
    })
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
    let root = state.0.lock().unwrap().root(id)?.to_path_buf();
    blocking(move || collect(&root)).await
}

#[tauri::command]
pub async fn read_file(state: State<'_, Core>, id: u64, path: String) -> CommandResult<String> {
    let root = state.0.lock().unwrap().root(id)?.to_path_buf();
    blocking(move || read_text(&root, &path, MAX_FILE_BYTES)).await
}

#[tauri::command]
pub async fn save_file(
    state: State<'_, Core>,
    id: u64,
    path: String,
    expected: String,
    text: String,
) -> CommandResult<()> {
    let root = state.0.lock().unwrap().root(id)?.to_path_buf();
    blocking(move || persist_text(&root, &path, &expected, &text)).await
}

#[tauri::command]
pub async fn create_file(state: State<'_, Core>, id: u64, path: String) -> CommandResult<()> {
    let root = state.0.lock().unwrap().root(id)?.to_path_buf();
    blocking(move || new_file(&root, &path)).await
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
        new_file(&project.root, "sub/file.go").unwrap();
        assert!(new_file(&project.root, "sub/file.go").is_err());
        persist_text(&project.root, "sub/file.go", "", "package sub\n").unwrap();
        assert!(persist_text(&project.root, "sub/file.go", "", "oops").is_err());
        assert_eq!(
            read_text(&project.root, "sub/file.go", 1024).unwrap(),
            "package sub\n"
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
        assert!(new_file(&root, "escape/other.txt").is_err());
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
