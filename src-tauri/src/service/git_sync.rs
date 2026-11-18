//! Git-native sync directory IO + a tiny, whitelisted `git` CLI surface.
//!
//! The WebView never gets filesystem or shell permissions: it passes a path
//! chosen with the native folder dialog plus an explicit file map. This module
//! validates every file name, writes atomically (temp + rename) and only ever
//! runs a fixed set of `git` subcommands with `arg()` (never a shell string).
//!
//! Credentials are never handled here — `git pull/push` uses the user's own git
//! configuration. `GIT_TERMINAL_PROMPT=0` keeps a missing credential from
//! hanging the desktop process; the resulting git error is surfaced verbatim.

use reqora_core::error::AppError;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Per-file cap. Git sync files are deterministic YAML; anything larger is a
/// corrupt/hand-crafted file and must not be pulled into the WebView at once.
const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncStatus {
    /// `git` executable could be launched.
    pub available: bool,
    pub repo: bool,
    pub branch: String,
    pub dirty: bool,
    pub changed_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncActionResult {
    pub ok: bool,
    pub action: String,
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// Only `reqora.*.yaml` and the MANIFEST live in a sync directory.
pub fn is_allowed_file(name: &str) -> bool {
    if name.is_empty()
        || name.len() > 96
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.contains('\0')
    {
        return false;
    }
    if name == "reqora.MANIFEST.md" {
        return true;
    }
    let Some(rest) = name.strip_prefix("reqora.") else {
        return false;
    };
    let Some(stem) = rest.strip_suffix(".yaml") else {
        return false;
    };
    !stem.is_empty()
        && stem
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn dir_path(dir: &str) -> Result<PathBuf, AppError> {
    if dir.trim().is_empty() {
        return Err(AppError::InvalidInput("Git 同步目录不能为空".into()));
    }
    Ok(PathBuf::from(dir))
}

fn validate_files(files: &BTreeMap<String, String>) -> Result<(), AppError> {
    for (name, text) in files {
        if !is_allowed_file(name) {
            return Err(AppError::InvalidInput(format!("不允许的同步文件名：{name}")));
        }
        if text.len() > MAX_FILE_BYTES {
            return Err(AppError::InvalidInput(format!("同步文件过大：{name}")));
        }
    }
    Ok(())
}

/// Read every allow-listed Reqora sync file in `dir` as UTF-8 text.
/// Unrelated files (source code, `.git`, secrets) are never touched.
pub fn read_files(dir: &str) -> Result<BTreeMap<String, String>, AppError> {
    let root = dir_path(dir)?;
    if !root.is_dir() {
        return Err(AppError::Storage("Git 同步目录不存在".into()));
    }
    let mut out = BTreeMap::new();
    let entries = std::fs::read_dir(&root)
        .map_err(|error| AppError::Storage(error.to_string()))?;
    for entry in entries {
        let entry = entry.map_err(|error| AppError::Storage(error.to_string()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_allowed_file(&name) || !entry.path().is_file() {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|error| AppError::Storage(error.to_string()))?;
        if metadata.len() > MAX_FILE_BYTES as u64 {
            return Err(AppError::InvalidInput(format!("同步文件过大：{name}")));
        }
        let text = std::fs::read_to_string(entry.path())
            .map_err(|_| AppError::Storage(format!("无法以 UTF-8 读取：{name}")))?;
        out.insert(name, text);
    }
    Ok(out)
}

/// Atomically write the given sync files. A crash mid-write can never leave a
/// half-written YAML file in the Git working tree.
pub fn write_files(dir: &str, files: &BTreeMap<String, String>) -> Result<Vec<String>, AppError> {
    validate_files(files)?;
    let root = dir_path(dir)?;
    std::fs::create_dir_all(&root).map_err(|error| AppError::Storage(error.to_string()))?;
    let mut written = Vec::with_capacity(files.len());
    for (name, text) in files {
        let target = root.join(name);
        let tmp = root.join(format!(".{name}.reqora-tmp"));
        std::fs::write(&tmp, text).map_err(|error| AppError::Storage(error.to_string()))?;
        std::fs::rename(&tmp, &target).map_err(|error| {
            let _ = std::fs::remove_file(&tmp);
            AppError::Storage(error.to_string())
        })?;
        written.push(name.clone());
    }
    Ok(written)
}

fn git(root: &Path, args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new("git")
        .current_dir(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
}

fn text_of(output: &std::process::Output) -> (String, String) {
    let clip = |bytes: &[u8]| String::from_utf8_lossy(bytes).chars().take(8192).collect::<String>();
    (clip(&output.stdout), clip(&output.stderr))
}

fn result(action: &str, output: &std::process::Output) -> GitSyncActionResult {
    let (stdout, stderr) = text_of(output);
    GitSyncActionResult {
        ok: output.status.success(),
        action: action.to_string(),
        stdout,
        stderr,
        code: output.status.code().unwrap_or(-1),
    }
}

fn inside_repo(root: &Path) -> Result<bool, AppError> {
    let output = git(root, &["rev-parse", "--is-inside-work-tree"])
        .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true")
}

pub fn status(dir: &str) -> Result<GitSyncStatus, AppError> {
    let root = dir_path(dir)?;
    let mut state = GitSyncStatus {
        available: false,
        repo: false,
        branch: String::new(),
        dirty: false,
        changed_files: Vec::new(),
    };
    let Ok(output) = git(&root, &["--version"]) else {
        return Ok(state);
    };
    state.available = output.status.success();
    if !state.available || !root.is_dir() {
        return Ok(state);
    }
    state.repo = inside_repo(&root)?;
    if !state.repo {
        return Ok(state);
    }
    if let Ok(branch) = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        state.branch = String::from_utf8_lossy(&branch.stdout).trim().to_string();
    }
    if let Ok(porcelain) = git(&root, &["status", "--porcelain", "--", "reqora.*.yaml", "reqora.MANIFEST.md"]) {
        let text = String::from_utf8_lossy(&porcelain.stdout);
        state.changed_files = text
            .lines()
            .filter_map(|line| line.get(3..).map(str::trim))
            .filter(|name| is_allowed_file(name))
            .map(str::to_string)
            .collect();
        state.dirty = !state.changed_files.is_empty();
    }
    Ok(state)
}

/// Run one explicitly whitelisted git action. Never builds a shell command.
pub fn run(dir: &str, action: &str, message: Option<&str>) -> Result<GitSyncActionResult, AppError> {
    let root = dir_path(dir)?;
    if !root.is_dir() {
        return Err(AppError::Storage("Git 同步目录不存在".into()));
    }
    match action {
        "init" => {
            if inside_repo(&root)? {
                return Ok(GitSyncActionResult {
                    ok: true,
                    action: action.into(),
                    stdout: "已是 Git 仓库".into(),
                    stderr: String::new(),
                    code: 0,
                });
            }
            let output = git(&root, &["init"])
                .map_err(|error| AppError::Internal(error.to_string()))?;
            Ok(result(action, &output))
        }
        "pull" => {
            if !inside_repo(&root)? {
                return Err(AppError::InvalidInput("当前目录不是 Git 仓库，无法拉取".into()));
            }
            let output = git(&root, &["pull", "--ff-only"])
                .map_err(|error| AppError::Internal(error.to_string()))?;
            Ok(result(action, &output))
        }
        "push" => {
            if !inside_repo(&root)? {
                return Err(AppError::InvalidInput("当前目录不是 Git 仓库，无法推送".into()));
            }
            let output = git(&root, &["push"])
                .map_err(|error| AppError::Internal(error.to_string()))?;
            Ok(result(action, &output))
        }
        "commit" => {
            if !inside_repo(&root)? {
                return Err(AppError::InvalidInput("当前目录不是 Git 仓库，无法提交".into()));
            }
            // Only ever stage Reqora's own files: never `git add -A` in a
            // directory the user may share with an existing code repository.
            let names: Vec<String> = read_files(dir)?
                .keys()
                .cloned()
                .filter(|name| is_allowed_file(name))
                .collect();
            if names.is_empty() {
                return Ok(GitSyncActionResult {
                    ok: true,
                    action: action.into(),
                    stdout: "目录里没有同步文件".into(),
                    stderr: String::new(),
                    code: 0,
                });
            }
            let mut add = vec!["add", "--"];
            add.extend(names.iter().map(String::as_str));
            let staged = git(&root, &add)
                .map_err(|error| AppError::Internal(error.to_string()))?;
            if !staged.status.success() {
                return Ok(result(action, &staged));
            }
            let quiet = git(&root, &["diff", "--cached", "--quiet"])
                .map_err(|error| AppError::Internal(error.to_string()))?;
            if quiet.status.success() {
                return Ok(GitSyncActionResult {
                    ok: true,
                    action: action.into(),
                    stdout: "没有需要提交的变更".into(),
                    stderr: String::new(),
                    code: 0,
                });
            }
            let text = message
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("chore(reqora): sync workspace");
            // A commit message is passed as a separate argument, never as shell.
            let output = git(&root, &["commit", "-m", text])
                .map_err(|error| AppError::Internal(error.to_string()))?;
            Ok(result(action, &output))
        }
        _ => Err(AppError::InvalidInput(format!("不支持的 git 操作：{action}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_allowlist_rejects_traversal_and_unrelated_files() {
        assert!(is_allowed_file("reqora.requests.yaml"));
        assert!(is_allowed_file("reqora.MANIFEST.md"));
        assert!(!is_allowed_file("../../evil.yaml"));
        assert!(!is_allowed_file("sub/reqora.requests.yaml"));
        assert!(!is_allowed_file("reqora.requests.yaml.exe"));
        assert!(!is_allowed_file(".env"));
        assert!(!is_allowed_file(""));
    }

    #[test]
    fn writes_and_reads_back_atomically() {
        let base = std::env::temp_dir().join(format!(
            "reqora-git-sync-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let dir = base.to_string_lossy().into_owned();
        std::fs::write(base.join(".env"), "SECRET=do-not-read").unwrap();
        let mut files = BTreeMap::new();
        files.insert("reqora.requests.yaml".to_string(), "schema: \"test\"\n".to_string());
        let written = write_files(&dir, &files).unwrap();
        assert_eq!(written, vec!["reqora.requests.yaml".to_string()]);
        let read = read_files(&dir).unwrap();
        assert_eq!(read.get("reqora.requests.yaml"), files.get("reqora.requests.yaml"));
        assert!(!read.contains_key(".env"));
        assert!(!base.join(".reqora.requests.yaml.reqora-tmp").exists());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn rejects_illegal_names_before_touching_disk() {
        let dir = std::env::temp_dir().to_string_lossy().into_owned();
        let mut files = BTreeMap::new();
        files.insert("../escape.yaml".to_string(), "x".into());
        assert!(write_files(&dir, &files).is_err());
    }
}
