//! Command group: system.

use super::*;



/// Append one formatted JSON line; returns the absolute log file path.
#[tauri::command]
pub fn append_error_log(entry: String) -> Result<String, ErrorPayload> {
    match crate::error_log::append(&entry) {
        Ok(path) => Ok(path.display().to_string()),
        Err(message) => Err(ErrorPayload {
            code: "ERROR_LOG_FAILED".into(),
            message,
            request_id: new_request_id(),
            retryable: false,
        }),
    }
}

/// Absolute path even when the file does not exist yet, so the UI can always
/// tell the user where to look.
#[tauri::command]
pub fn error_log_path() -> Result<String, ErrorPayload> {
    crate::error_log::log_path()
        .map(|path| path.display().to_string())
        .map_err(|message| ErrorPayload {
            code: "ERROR_LOG_FAILED".into(),
            message,
            request_id: new_request_id(),
            retryable: false,
        })
}

/// Newest `limit` lines (default 100, capped at 500).
#[tauri::command]
pub fn read_error_log(limit: Option<usize>) -> Result<Value, ErrorPayload> {
    let path = error_log_path()?;
    let lines = crate::error_log::tail(limit.unwrap_or(100).clamp(1, 500)).map_err(
        |message| ErrorPayload {
            code: "ERROR_LOG_FAILED".into(),
            message,
            request_id: new_request_id(),
            retryable: false,
        },
    )?;
    Ok(json!({ "path": path, "lines": lines }))
}
