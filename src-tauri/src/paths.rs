//! Machine-local data paths shared by the shell's side-car files.
//!
//! `HOME` on Unix, `USERPROFILE` on Windows. One resolver so the engine data
//! directory (`~/.reqora`) can never drift between app config, error logs and
//! application setup.

use std::path::PathBuf;

/// Resolve the user's home directory.
pub fn reqora_home() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .map_err(|error| format!("无法获取用户主目录: {error}"))
}

/// The machine-local engine data directory: `~/.reqora`.
pub fn app_data_dir() -> Result<PathBuf, String> {
    Ok(reqora_home()?.join(".reqora"))
}
