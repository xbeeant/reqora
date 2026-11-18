//! Command group: data.

use super::*;



#[tauri::command]
pub fn history_append(
    state: State<'_, AppState>,
    record: Value,
) -> Result<Value, ErrorPayload> {
    let request_id = new_request_id();
    state
        .history
        .append(&record)
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub fn history_list(
    state: State<'_, AppState>,
    scope: Option<String>,
    project_id: Option<String>,
    kind: Option<String>,
    search: Option<String>,
    limit: Option<usize>,
    cursor: Option<Value>,
) -> Result<Value, ErrorPayload> {
    let request_id = new_request_id();
    // A cursor is opaque to the WebView: only (at, id) of the last examined
    // row. Malformed values are ignored rather than trusted as SQL input.
    let cursor = cursor.and_then(|value| {
        let at = value.get("at")?.as_i64()?;
        let id = value.get("id")?.as_str()?.to_string();
        (at > 0 && !id.is_empty() && id.len() <= 128)
            .then_some(HistoryCursor { at, id })
    });
    let query = ListQuery {
        scope: scope.unwrap_or_else(|| "project".to_string()),
        project_id,
        kind,
        search,
        limit: limit.unwrap_or(0),
        cursor,
    };
    state
        .history
        .page(&query)
        .map(|page| page.to_value())
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub fn history_get(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<Value, ErrorPayload> {
    let request_id = new_request_id();
    state
        .history
        .get(&run_id)
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub fn history_delete(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<(), ErrorPayload> {
    let request_id = new_request_id();
    state
        .history
        .delete(&run_id)
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub fn history_clear(
    state: State<'_, AppState>,
    scope: Option<String>,
    project_id: Option<String>,
) -> Result<u64, ErrorPayload> {
    let request_id = new_request_id();
    let scope = scope.unwrap_or_else(|| "project".to_string());
    state
        .history
        .clear(&scope, project_id.as_deref())
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub fn history_stats(state: State<'_, AppState>) -> Result<Value, ErrorPayload> {
    let request_id = new_request_id();
    state
        .history
        .stats()
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub fn git_sync_read_files(dir: String) -> Result<std::collections::BTreeMap<String, String>, ErrorPayload> {
    let request_id = new_request_id();
    git_sync::read_files(&dir).map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub fn git_sync_write_files(
    dir: String,
    files: std::collections::BTreeMap<String, String>,
) -> Result<Vec<String>, ErrorPayload> {
    let request_id = new_request_id();
    git_sync::write_files(&dir, &files).map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub fn git_sync_status(dir: String) -> Result<GitSyncStatus, ErrorPayload> {
    let request_id = new_request_id();
    git_sync::status(&dir).map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub fn git_sync_run(
    dir: String,
    action: String,
    message: Option<String>,
) -> Result<GitSyncActionResult, ErrorPayload> {
    let request_id = new_request_id();
    git_sync::run(&dir, &action, message.as_deref())
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}
