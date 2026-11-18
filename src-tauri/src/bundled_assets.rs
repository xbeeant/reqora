//! Install the assets bundled inside the desktop installer into `~/.reqora`.
//!
//! The release pipeline stages MCP server + skills (+ optional engine sidecar)
//! into `src-tauri/bundle-assets/`, which Tauri copies into every installer via
//! `bundle.resources`. On first launch — and on every version change — this
//! module copies that directory into the machine-local data dir:
//!
//! ```text
//! $RESOURCE/bundle-assets/manifest.json      -> (read only)
//! $RESOURCE/bundle-assets/mcp/mcp.mjs        -> ~/.reqora/mcp/mcp.mjs
//! $RESOURCE/bundle-assets/skills/*/SKILL.md  -> ~/.reqora/skills/*/SKILL.md
//! $RESOURCE/bundle-assets/bin/reqora-send*   -> ~/.reqora/bin/reqora-send*
//! ```
//!
//! Design rules (same spirit as the rest of the shell):
//! - **Idempotent + versioned**: a marker file records the installed version;
//!   unchanged versions with intact files skip all writes. A partial/corrupt
//!   install is repaired on the next launch (sha256 is checked per file).
//! - **Never touch user data**: only the explicit manifest targets are written.
//!   Projects, config, vault, history and logs are never read or overwritten.
//! - **Best-effort**: a missing bundle (plain `cargo tauri dev` without staging)
//!   or a failing copy is logged, not fatal — the desktop app still starts.
//! - **Runtime paths in generated config**: `~/.reqora/mcp/CONFIG.md` is rendered
//!   from the *installing* user's home, never the build machine's.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::logging::{log, new_request_id};
use crate::paths::app_data_dir;
use reqora_core::config::LogLevel;

/// Folder inside Tauri's `$RESOURCE` dir (matches `bundle.resources`).
pub const RESOURCE_FOLDER: &str = "bundle-assets";
/// Marker file under `~/.reqora` recording which version was installed.
pub const VERSION_MARKER: &str = ".bundled-assets-version";
/// Name of the version+checksum manifest inside the staged folder.
const MANIFEST_FILE: &str = "manifest.json";

#[derive(Debug, Clone, Deserialize)]
struct ManifestFile {
    /// Relative path inside the staged folder (also the target under ~/.reqora).
    target: String,
    /// Lowercase hex sha256 of the file bytes.
    sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
struct Manifest {
    version: String,
    files: Vec<ManifestFile>,
}

/// Outcome of one install pass — returned so callers can log a concise summary.
#[derive(Debug, PartialEq, Eq)]
pub enum InstallOutcome {
    /// No staged bundle found (e.g. dev build) — nothing to do.
    NoBundle,
    /// Marker + all checksums matched; nothing written.
    UpToDate,
    /// Files were copied (first install or version change / repair).
    Installed { version: String, files: usize },
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex::encode(digest)
}

/// Reject absolute paths and `..` segments so a tampered manifest can never
/// write outside `~/.reqora`. Targets use forward slashes from the JS stage.
fn safe_target(rel: &str) -> Option<PathBuf> {
    if rel.is_empty() || rel.starts_with('/') || rel.contains('\\') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in rel.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
        out.push(part);
    }
    Some(out)
}

/// Content of the ready-to-paste MCP config, rendered with the real home path.
pub fn config_markdown(home: &Path, exe_name: &str) -> String {
    let mcp_entry = home.join("mcp").join("mcp.mjs");
    let engine_bin = home.join("bin").join(exe_name);
    let mcp_display = mcp_entry.display().to_string();
    let server = json!({ "command": "node", "args": [mcp_display] });
    let pretty = |value: &serde_json::Value| serde_json::to_string_pretty(value).unwrap_or_default();
    let claude_code = format!("claude mcp add reqora -- node \"{mcp_display}\"");

    format!(
        "# Reqora MCP 客户端配置（安装版）\n\n\
桌面安装包已把 MCP 服务、SKILL、请求引擎装到本机数据目录。下面路径按当前机器的 \
`~/.reqora` 展开，复制即可用；写入工具需给 args 追加 `--allow-write`。\n\n\
- MCP 入口：`{mcp_display}`\n\
- 请求引擎：`{}`（缺失时自动降级为 Node fetch 诊断模式）\n\n\
## Claude Code（终端执行一次）\n\n\
```bash\n{claude_code}\n```\n\n\
## Claude Desktop / Cursor\n\n\
```json\n{}\n```\n\n\
## VS Code\n\n\
```json\n{}\n```\n\n\
省略 `--workspace` 时使用桌面端当前激活项目。工具目录与安全边界见 \
`skills/reqora-mcp/SKILL.md`。\n",
        engine_bin.display(),
        pretty(&json!({ "mcpServers": { "reqora": server } })),
        pretty(&json!({ "servers": { "reqora": { "type": "stdio", "command": server["command"], "args": server["args"] } } })),
    )
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建目录 {} 失败：{error}", parent.display()))?;
    }
    let tmp = path.with_extension(format!("tmp-{}", new_request_id()));
    fs::write(&tmp, bytes).map_err(|error| format!("写入 {} 失败：{error}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|error| {
        let _ = fs::remove_file(&tmp);
        format!("覆盖 {} 失败：{error}", path.display())
    })
}

/// Pure install pass. `resource_dir` is Tauri's `$RESOURCE`; `home` is `~/.reqora`.
/// Both are parameters so tests can use throwaway directories.
pub fn install_from_dirs(resource_dir: &Path, home: &Path) -> Result<InstallOutcome, String> {
    let staged = resource_dir.join(RESOURCE_FOLDER);
    let manifest_path = staged.join(MANIFEST_FILE);
    if !manifest_path.is_file() {
        return Ok(InstallOutcome::NoBundle);
    }

    let raw = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("读取 {} 失败：{error}", manifest_path.display()))?;
    let manifest: Manifest = serde_json::from_str(&raw)
        .map_err(|error| format!("解析 {} 失败：{error}", manifest_path.display()))?;

    // Validate every target before writing anything — a tampered manifest must
    // fail atomically rather than leaving a half-installed tree.
    let mut targets = BTreeSet::new();
    let mut planned = Vec::new();
    for entry in &manifest.files {
        let rel = safe_target(&entry.target)
            .ok_or_else(|| format!("非法的安装目标路径：{}", entry.target))?;
        if !targets.insert(rel.clone()) {
            return Err(format!("重复的安装目标路径：{}", entry.target));
        }
        planned.push((staged.join(&rel), home.join(rel), entry.sha256.clone()));
    }

    let marker_path = home.join(VERSION_MARKER);
    let installed_version = fs::read_to_string(&marker_path).ok();
    let mut needs_write = installed_version.as_deref() != Some(manifest.version.as_str());

    if !needs_write {
        // Fast path: marker matches, but verify every file still has the right
        // bytes (a user may have deleted / edited a bundled file).
        for (_, target, expected) in &planned {
            let intact = fs::read(target)
                .map(|bytes| sha256_hex(&bytes) == *expected)
                .unwrap_or(false);
            if !intact {
                needs_write = true;
                break;
            }
        }
    }
    if !needs_write {
        return Ok(InstallOutcome::UpToDate);
    }

    for (source, target, expected) in &planned {
        let bytes = fs::read(source)
            .map_err(|error| format!("读取内置资源 {} 失败：{error}", source.display()))?;
        let actual = sha256_hex(&bytes);
        if actual != *expected {
            return Err(format!(
                "内置资源 {} 校验失败（期望 {expected}，实际 {actual}）",
                source.display()
            ));
        }
        write_atomic(target, &bytes)?;
    }

    let exe_name = if cfg!(windows) { "reqora-send.exe" } else { "reqora-send" };
    write_atomic(
        &home.join("mcp").join("CONFIG.md"),
        config_markdown(home, exe_name).as_bytes(),
    )?;
    write_atomic(&marker_path, manifest.version.as_bytes())?;

    Ok(InstallOutcome::Installed {
        version: manifest.version,
        files: planned.len(),
    })
}

/// Called once from Tauri setup. Missing/failed bundles are non-fatal.
pub fn install_from_app(app: &tauri::AppHandle, log_level: LogLevel) {
    let request_id = new_request_id();
    let home = match app_data_dir() {
        Ok(path) => path,
        Err(error) => {
            log(
                LogLevel::Warn,
                "assets.install.skipped",
                &request_id,
                json!({ "reason": "no_home", "detail": error }),
                log_level,
            );
            return;
        }
    };
    let resource_dir = match app.path().resource_dir() {
        Ok(path) => path,
        Err(error) => {
            log(
                LogLevel::Warn,
                "assets.install.skipped",
                &request_id,
                json!({ "reason": "no_resource_dir", "detail": error.to_string() }),
                log_level,
            );
            return;
        }
    };

    match install_from_dirs(&resource_dir, &home) {
        Ok(InstallOutcome::NoBundle) => log(
            LogLevel::Debug,
            "assets.install.skipped",
            &request_id,
            json!({ "reason": "no_bundle" }),
            log_level,
        ),
        Ok(InstallOutcome::UpToDate) => log(
            LogLevel::Debug,
            "assets.install.up_to_date",
            &request_id,
            json!({ "path": home.display().to_string() }),
            log_level,
        ),
        Ok(InstallOutcome::Installed { version, files }) => log(
            LogLevel::Info,
            "assets.installed",
            &request_id,
            json!({ "version": version, "files": files, "path": home.display().to_string() }),
            log_level,
        ),
        Err(error) => log(
            LogLevel::Warn,
            "assets.install.failed",
            &request_id,
            json!({ "detail": error }),
            log_level,
        ),
    }
}

#[cfg(test)]
mod tests;
