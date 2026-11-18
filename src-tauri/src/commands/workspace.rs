//! Command group: workspace.

use super::*;



#[tauri::command]
pub fn load_workspace(state: State<'_, AppState>) -> Result<Value, ErrorPayload> {
    let request_id = new_request_id();
    match state.store.load() {
        Ok(snapshot) => {
            log(
                LogLevel::Info,
                "workspace.load",
                &request_id,
                json!({ "ok": true }),
                state.config.log_level,
            );
            Ok(snapshot)
        }
        Err(error) => workspace_error(&state, &request_id, "workspace.load", error),
    }
}

/// Current on-disk revision counter, read by the WebView when it loads (or
/// reloads) a project so subsequent auto-saves can pass `expectedRev`.
#[tauri::command]
pub fn load_workspace_rev(state: State<'_, AppState>) -> Result<Value, ErrorPayload> {
    let request_id = new_request_id();
    match state.store.workspace_rev() {
        Ok(rev) => Ok(json!(rev)),
        Err(error) => workspace_error(&state, &request_id, "workspace.rev", error),
    }
}

/// 外部增量刷新：返回自 `fromRev` 以来被 MCP / CLI 改动的实体（已装配、已
/// 解密）。响应里 `reset: true` 表示调用方版本领先于磁盘，前端须整份重载。
#[tauri::command]
pub fn load_workspace_delta(
    state: State<'_, AppState>,
    from_rev: i64,
) -> Result<Value, ErrorPayload> {
    let request_id = new_request_id();
    match state.store.workspace_delta(from_rev) {
        Ok(delta) => Ok(delta),
        Err(error) => workspace_error(&state, &request_id, "workspace.delta", error),
    }
}

/// 按需详情读取：只查询并解密指定实体的一行（阶段 2 懒加载入口）。
#[tauri::command]
pub fn get_entity(
    state: State<'_, AppState>,
    kind: String,
    id: String,
) -> Result<Value, ErrorPayload> {
    let request_id = new_request_id();
    match state.store.get_entity(&kind, &id) {
        Ok(entity) => Ok(entity),
        Err(error) => workspace_error(&state, &request_id, "workspace.getEntity", error),
    }
}

/// Runtime counterpart of the settings page's "快照存储上限". Previously the
/// frontend called this command but neither the command nor its registration
/// existed, so raising the limit in the UI had no effect and auto-save kept
/// failing against the process's startup value (historically 5 MiB).
#[tauri::command]
pub fn set_workspace_limit(
    state: State<'_, AppState>,
    limit: u64,
) -> Result<Value, ErrorPayload> {
    let request_id = new_request_id();
    match state.store.set_max_bytes(limit) {
        Ok(bytes) => {
            log(
                LogLevel::Info,
                "workspace.limit",
                &request_id,
                json!({ "maxWorkspaceBytes": bytes }),
                state.config.log_level,
            );
            Ok(json!({ "maxWorkspaceBytes": bytes }))
        }
        Err(error) => workspace_error(&state, &request_id, "workspace.limit", error),
    }
}

/// Auto-save entry point with optimistic locking. When a different writer
/// (MCP / CLI) committed since the WebView loaded its snapshot, we return a
/// dedicated `WORKSPACE_CONFLICT` envelope and write nothing — the UI can then
/// offer "reload (keep external changes)" or "back up and overwrite".
/// Omitting `expectedRev` keeps the legacy unchecked behaviour for import,
/// project switching and other internal callers.
#[tauri::command]
pub fn save_workspace(
    state: State<'_, AppState>,
    snapshot: Value,
    expected_rev: Option<i64>,
    force: Option<bool>,
) -> Result<Value, ErrorPayload> {
    let request_id = new_request_id();
    match state
        .store
        .save_checked(&snapshot, expected_rev, force.unwrap_or(false))
    {
        Ok(crate::storage::SaveResult::Saved(rev)) => {
            log(
                LogLevel::Debug,
                "workspace.save",
                &request_id,
                json!({ "ok": true, "rev": rev.rev }),
                state.config.log_level,
            );
            Ok(json!(rev))
        }
        Ok(crate::storage::SaveResult::Conflict(current)) => {
            log(
                LogLevel::Warn,
                "workspace.save",
                &request_id,
                json!({ "conflict": true, "rev": current.rev, "writer": current.writer }),
                state.config.log_level,
            );
            Err(ErrorPayload {
                code: "WORKSPACE_CONFLICT",
                message: format!(
                    "工作区已被外部写入修改（当前版本 {}，最后写入者 {}）。为避免覆盖，本次自动保存已暂停。",
                    current.rev, current.writer
                ),
                request_id,
                retryable: false,
            })
        }
        Err(error) => workspace_error(&state, &request_id, "workspace.save", error),
    }
}

/// Row-level incremental auto-save. The WebView's pending-row queue sends only
/// the rows an edit actually touched (plus history / trash / revision rows and
/// optional meta keys), so a single-field edit no longer serializes the whole
/// 25 MiB snapshot across the IPC boundary and through `vault.seal`.
/// Concurrency semantics are identical to `save_workspace`: CAS inside the
/// write transaction, `WORKSPACE_CONFLICT` envelope on an external write.
#[tauri::command]
pub fn save_workspace_rows(
    state: State<'_, AppState>,
    delta: Value,
    expected_rev: Option<i64>,
) -> Result<Value, ErrorPayload> {
    let request_id = new_request_id();
    match state.store.save_rows_checked(&delta, expected_rev) {
        Ok(crate::storage::SaveResult::Saved(rev)) => {
            log(
                LogLevel::Debug,
                "workspace.saveRows",
                &request_id,
                json!({ "ok": true, "rev": rev.rev }),
                state.config.log_level,
            );
            Ok(json!(rev))
        }
        Ok(crate::storage::SaveResult::Conflict(current)) => {
            log(
                LogLevel::Warn,
                "workspace.saveRows",
                &request_id,
                json!({ "conflict": true, "rev": current.rev, "writer": current.writer }),
                state.config.log_level,
            );
            Err(ErrorPayload {
                code: "WORKSPACE_CONFLICT",
                message: format!(
                    "工作区已被外部写入修改（当前版本 {}，最后写入者 {}）。为避免覆盖，本次自动保存已暂停。",
                    current.rev, current.writer
                ),
                request_id,
                retryable: false,
            })
        }
        Err(error) => workspace_error(&state, &request_id, "workspace.saveRows", error),
    }
}

/// Snapshot the on-disk workspace before a destructive cloud operation.
/// Returns the absolute backup path; the caller decides what to do with it.
#[tauri::command]
pub fn backup_workspace(
    state: State<'_, AppState>,
    reason: Option<String>,
) -> Result<String, ErrorPayload> {
    let request_id = new_request_id();
    let label = reason.unwrap_or_else(|| "manual".to_string());
    match state.store.backup(&label) {
        Ok(path) => {
            log(
                LogLevel::Info,
                "workspace.backup",
                &request_id,
                json!({ "ok": true, "reason": label }),
                state.config.log_level,
            );
            Ok(path.to_string_lossy().into_owned())
        }
        Err(error) => workspace_error(&state, &request_id, "workspace.backup", error),
    }
}

#[tauri::command]
pub fn reset_workspace(state: State<'_, AppState>) -> Result<Value, ErrorPayload> {
    let request_id = new_request_id();
    match state.store.reset() {
        Ok(snapshot) => {
            log(
                LogLevel::Warn,
                "workspace.reset",
                &request_id,
                json!({ "ok": true }),
                state.config.log_level,
            );
            Ok(snapshot)
        }
        Err(error) => workspace_error(&state, &request_id, "workspace.reset", error),
    }
}

#[tauri::command]
pub fn load_sync_baseline(
    state: State<'_, AppState>,
    project_key: String,
) -> Result<Option<Value>, ErrorPayload> {
    let request_id = new_request_id();
    state
        .store
        .load_sync_baseline(&project_key)
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub fn save_sync_baseline(
    state: State<'_, AppState>,
    project_key: String,
    payload: Value,
) -> Result<(), ErrorPayload> {
    let request_id = new_request_id();
    state
        .store
        .save_sync_baseline(&project_key, &payload)
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub fn clear_sync_baseline(
    state: State<'_, AppState>,
    project_key: String,
) -> Result<(), ErrorPayload> {
    let request_id = new_request_id();
    state
        .store
        .clear_sync_baseline(&project_key)
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

/// Switching servers invalidates baselines for *every* local project, not
/// just the active one, so sweep all registered project directories.
#[tauri::command]
pub fn clear_all_sync_baselines(state: State<'_, AppState>) -> Result<(), ErrorPayload> {
    let request_id = new_request_id();
    let dirs: Vec<std::path::PathBuf> = state
        .registry
        .info()
        .map_err(|error| ErrorPayload::new(&error, &request_id))?
        .projects
        .iter()
        .map(|project| std::path::PathBuf::from(&project.data_directory))
        .collect();
    state
        .store
        .clear_all_sync_baselines(&dirs)
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

fn workspace_error<T>(
    state: &State<'_, AppState>,
    request_id: &str,
    event: &str,
    error: reqora_core::error::AppError,
) -> Result<T, ErrorPayload> {
    log(
        LogLevel::Error,
        event,
        request_id,
        json!({ "code": error.code(), "detail": error.to_string() }),
        state.config.log_level,
    );
    Err(ErrorPayload::new(&error, request_id))
}
