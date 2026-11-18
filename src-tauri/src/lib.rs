mod app_config;
mod bundled_assets;
mod commands;
mod error_log;
mod logging;
mod paths;
mod projects;
mod service;
mod storage;

// Wire contract + error types live in the Tauri-free reqora-core crate and are
// referenced as reqora_core::{config, error, models} directly.

use crate::commands::AppState;
use crate::logging::log;
use crate::paths::app_data_dir;
use crate::projects::ProjectRegistry;
use crate::storage::WorkspaceStore;
use reqora_core::config::{Config, LogLevel};
use reqora_core::service::body_store::BodyStore;
use crate::service::grpc::GrpcManager;
use reqora_core::service::http::HttpService;
use crate::service::mcp::McpManager;
use reqora_core::service::mock::MockRuntime;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Fail fast: all configuration is read and validated exactly once, before
    // any window is created.
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(message) => {
            eprintln!(
                "{}",
                json!({
                    "level": "error",
                    "event": "config.invalid",
                    "request_id": "startup",
                    "detail": message,
                })
            );
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .setup(move |app| {
            let app_data_dir = app_data_dir()
                .map_err(reqora_core::error::AppError::Storage)?;

            // Install the mcp / skills / engine assets that were baked into
            // this installer. Best-effort: dev builds without staged assets
            // simply skip it, and a bad bundle never blocks app startup.
            bundled_assets::install_from_app(app.handle(), config.log_level);

            let bodies = BodyStore::new(&app_data_dir.join("response-bodies.db"))?;
            let registry = ProjectRegistry::new(app_data_dir.clone())?;
            let project_dir = registry.project_dir()?;
            // The master key is machine-local and must stay outside the
            // project directory: switching / copying a project must never
            // carry the key along with the encrypted data.
            let vault = crate::service::vault::Vault::open_or_create(
                &app_data_dir.join("vault.key"),
            )?;
            // Execution history gets its own machine-local SQLite file, not a
            // table in the (synced, per-project) workspace.db. It shares the
            // master key but keeps every response payload encrypted.
            let history = crate::service::history::HistoryStore::new(&app_data_dir, vault.clone())?;
            let store = WorkspaceStore::new(&config, project_dir.clone(), vault)?;
            log(
                LogLevel::Info,
                "app.startup",
                "startup",
                json!({
                    "version": env!("CARGO_PKG_VERSION"),
                    "data_directory": project_dir.display().to_string(),
                    "update_manifest_url": config.update_manifest_url,
                    "update_verify_tls": config.update_verify_tls,
                }),
                config.log_level,
            );
            app.manage(AppState {
                config: config.clone(),
                http: HttpService {
                    config: config.clone(),
                    cookies: Arc::new(Mutex::new(reqora_core::service::cookies::CookieStore::default())),
                },
                store,
                bodies,
                registry,
                history,
                cancelled_streams: Arc::new(Mutex::new(HashSet::new())),
                ws_sessions: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
                mock: Arc::new(Mutex::new(MockRuntime::default())),
                mcp: McpManager::default(),
                grpc: Arc::new(GrpcManager::default()),
                mqtt_sessions: crate::service::mqtt::new_sessions(),
                grpc_streams: Arc::new(crate::service::grpc::GrpcStreamManager::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_runtime_info,
            commands::list_projects,
            commands::create_project,
            commands::switch_project,
            commands::rename_project,
            commands::set_data_root,
            commands::pick_directory,
            commands::send_request,
            commands::stream_request,
            commands::read_response_body,
            commands::read_response_lines,
            commands::response_body_info,
            commands::release_response_body,
            commands::cancel_stream,
            commands::load_workspace,
            commands::load_workspace_rev,
            commands::load_workspace_delta,
            commands::get_entity,
            commands::set_workspace_limit,
            app_config::load_app_config,
            app_config::save_app_config,
            commands::append_error_log,
            commands::error_log_path,
            commands::read_error_log,
            commands::save_workspace,
            commands::save_workspace_rows,
            commands::backup_workspace,
            commands::reset_workspace,
            commands::load_sync_baseline,
            commands::save_sync_baseline,
            commands::clear_sync_baseline,
            commands::clear_all_sync_baselines,
            commands::ws_connect,
            commands::ws_send,
            commands::ws_close,
            commands::mock_start,
            commands::mock_stop,
            commands::mock_status,
            commands::cookie_list,
            commands::cookie_clear,
            commands::benchmark_run,
            commands::pick_and_read_text,
            commands::save_text_file,
            commands::save_response_body,
            commands::git_sync_read_files,
            commands::git_sync_write_files,
            commands::git_sync_status,
            commands::git_sync_run,
            commands::mcp_connect,
            commands::mcp_disconnect,
            commands::mcp_call,
            commands::ai_chat,
            commands::pick_proto_files,
            commands::grpc_compile,
            commands::grpc_invoke,
            commands::grpc_reflect,
            commands::tcp_debug,
            commands::db_query,
            commands::open_url,
            commands::check_update,
            commands::oauth2_authorize,
            commands::mqtt_connect,
            commands::mqtt_subscribe,
            commands::mqtt_unsubscribe,
            commands::mqtt_publish,
            commands::mqtt_disconnect,
            commands::grpc_stream_start,
            commands::grpc_stream_send,
            commands::grpc_stream_close,
            commands::grpc_stream_cancel,
            commands::history_append,
            commands::history_list,
            commands::history_get,
            commands::history_delete,
            commands::history_clear,
            commands::history_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
