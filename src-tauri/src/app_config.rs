//! Unified, machine-local application configuration file.
//!
//! Everything in here is **non-secret** and intended to live outside the
//! workspace snapshot: the collaboration server address, the doc-site base
//! URL, the MCP-expose options and a few UI preferences. The frontend owns
//! the JSON shape and reads/writes the whole document through these two
//! commands; Rust only validates and persists it.
//!
//! Secrets (token pairs, local-vault values) are deliberately NOT stored here.
//! They remain encrypted at rest in the WebView's storage under separate keys,
//! exactly as before this consolidation.

use serde_json::Value;
use std::path::PathBuf;

/// Mirrors `src-tauri/src/lib.rs`: the collaboration/engine data directory is
/// `$HOME/.reqora` (or `%USERPROFILE%\.reqora` on Windows). The config file
/// sits alongside `vault.key` and `response-bodies.db` so it can be backed up
/// or migrated together with the rest of the machine-local state.
fn app_config_path() -> Result<PathBuf, String> {
    Ok(crate::paths::app_data_dir()?.join("config.json"))
}

/// Returns the raw config document, or `None` when the file does not exist yet
/// (first launch). Any read error surfaces as a string so the frontend can
/// fall back to its localStorage mirror without crashing startup.
#[tauri::command]
pub async fn load_app_config() -> Result<Option<String>, String> {
    let path = app_config_path()?;
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取应用配置失败: {error}")),
    }
}

/// Persists the full config document. The JSON is validated fail-closed before
/// any byte touches disk, so a malformed frontend payload cannot corrupt the
/// file. The parent directory is created on demand.
#[tauri::command]
pub async fn save_app_config(json: String) -> Result<(), String> {
    if serde_json::from_str::<Value>(&json).is_err() {
        return Err("应用配置不是合法的 JSON".into());
    }
    let path = app_config_path()?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("创建配置目录失败: {error}"))?;
    }
    tokio::fs::write(&path, json.as_bytes())
        .await
        .map_err(|error| format!("写入应用配置失败: {error}"))?;
    Ok(())
}
