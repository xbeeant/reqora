//! Command group: project.

use super::*;



/// Desktop equivalent of a health/readiness probe.
#[tauri::command]
pub fn get_runtime_info(state: State<'_, AppState>) -> RuntimeInfo {
    RuntimeInfo {
        status: "ready",
        version: env!("CARGO_PKG_VERSION"),
        timeout_secs: state.config.request_timeout_secs,
        max_response_bytes: state.config.max_response_bytes,
        log_level: state.config.log_level.label(),
        workspace_path: state.store.dir().display().to_string(),
    }
}

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> Result<ProjectsState, ErrorPayload> {
    let request_id = new_request_id();
    state
        .registry
        .info()
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub fn create_project(state: State<'_, AppState>, name: String) -> Result<ProjectsState, ErrorPayload> {
    let request_id = new_request_id();
    let path = state
        .registry
        .create_project(name)
        .map_err(|error| ErrorPayload::new(&error, &request_id))?;
    state
        .store
        .set_dir(path)
        .map_err(|error| ErrorPayload::new(&error, &request_id))?;
    state
        .registry
        .info()
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub fn switch_project(
    state: State<'_, AppState>,
    id: String,
) -> Result<ProjectsState, ErrorPayload> {
    let request_id = new_request_id();
    let path = state
        .registry
        .switch_project(id)
        .map_err(|error| ErrorPayload::new(&error, &request_id))?;
    state
        .store
        .set_dir(path)
        .map_err(|error| ErrorPayload::new(&error, &request_id))?;
    state
        .registry
        .info()
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

/// Rename a local project in the registry.
#[tauri::command]
pub fn rename_project(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<ProjectsState, ErrorPayload> {
    let request_id = new_request_id();
    state
        .registry
        .rename_project(id, name)
        .map_err(|error| ErrorPayload::new(&error, &request_id))?;
    state
        .registry
        .info()
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

/// Switch the global data root (all projects live under one root).
#[tauri::command]
pub fn set_data_root(
    state: State<'_, AppState>,
    root: Option<String>,
) -> Result<ProjectsState, ErrorPayload> {
    let request_id = new_request_id();
    let path = state
        .registry
        .set_data_root(root, |target| state.store.copy_to(target))
        .map_err(|error| ErrorPayload::new(&error, &request_id))?;
    state
        .store
        .set_dir(path)
        .map_err(|error| ErrorPayload::new(&error, &request_id))?;
    state
        .registry
        .info()
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

/// Returns `None` when the user cancels the folder dialog.
#[tauri::command]
pub async fn pick_directory() -> Result<Option<String>, ErrorPayload> {
    let picked = tokio::task::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
        .await
        .map_err(|error| {
            ErrorPayload::new(&AppError::Internal(error.to_string()), "pick_directory")
        })?;
    Ok(picked.map(|path| path.to_string_lossy().into_owned()))
}
