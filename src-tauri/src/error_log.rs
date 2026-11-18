//! A plain-text, user-readable error log.
//!
//! The structured JSON logger used by IPC commands writes to the process
//! stdout / WebView console, which is invisible once the app is installed.
//! Users reporting "写数据失败" had no file to inspect, so every IPC failure is
//! also appended here as one JSON object per line. The file lives next to the
//! other machine-local state in `$HOME/.reqora/logs/errors.log`; the MCP
//! service writes its own `reqora-mcp.log` in the same directory so both sides
//! of a failed write can be found in one place.
//!
//! Deliberately dependency-free: `std::fs` only, no new crate, no global
//! logger改造. Failures are returned to the caller instead of panicking — a
//! broken log must never break a workspace save.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

const LOG_FILE_NAME: &str = "errors.log";
const MAX_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024;

/// Directory shared with the MCP service (`bin/mcpLogger.mjs`). Kept in sync
/// with `ProjectRegistry` / `app_config.rs`: HOME on Unix, USERPROFILE on
/// Windows.
pub fn log_dir() -> Result<PathBuf, String> {
    Ok(crate::paths::app_data_dir()?.join("logs"))
}

pub fn log_path() -> Result<PathBuf, String> {
    Ok(log_dir()?.join(LOG_FILE_NAME))
}

/// Keep the file bounded. A single rotation to `errors.log.1` is enough: the
/// newest errors are what users need, and a failed rotation must not block a
/// new entry.
fn rotate_if_needed(path: &PathBuf) {
    let size = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    if size < MAX_BYTES {
        return;
    }
    let backup = path.with_extension("log.1");
    let _ = fs::remove_file(&backup);
    let _ = fs::rename(path, backup);
}

/// Append one already-formatted line. Newlines inside the payload are escaped
/// so a crafted error message cannot forge log entries.
pub fn append(entry: &str) -> Result<PathBuf, String> {
    let dir = log_dir()?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("创建日志目录失败 {}: {error}", dir.display()))?;
    let path = dir.join(LOG_FILE_NAME);
    rotate_if_needed(&path);
    let line: String = entry
        .chars()
        .take(MAX_LINE_BYTES)
        .flat_map(|ch| match ch {
            '\n' => "\\n".chars().collect::<Vec<_>>(),
            '\r' => "\\r".chars().collect::<Vec<_>>(),
            other => vec![other],
        })
        .collect();
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("打开错误日志失败 {}: {error}", path.display()))?;
    writeln!(file, "{line}")
        .map_err(|error| format!("写入错误日志失败 {}: {error}", path.display()))?;
    Ok(path)
}

/// Newest `limit` lines, in file order (oldest first within the returned
/// slice). Missing file is not an error: a fresh install has no errors yet.
pub fn tail(limit: usize) -> Result<Vec<String>, String> {
    let path = log_path()?;
    let file: File = match File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(format!("读取错误日志失败 {}: {error}", path.display())),
    };
    let mut ring: Vec<String> = Vec::new();
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| format!("解析错误日志失败: {error}"))?;
        ring.push(line);
        if ring.len() > limit {
            ring.remove(0);
        }
    }
    Ok(ring)
}

// The `#[tauri::command]` wrappers (`append_error_log`, `error_log_path`,
// `read_error_log`) live in `commands.rs` and are registered from `lib.rs`.
// This module stays dependency-free and deliberately exposes only the file I/O
// helpers those commands call — adding a command here would collide with the
// generated macro names of the same functions in `commands.rs`.
