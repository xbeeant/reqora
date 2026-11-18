//! Command group: session.

use super::*;



#[tauri::command]
pub async fn ws_connect(
    state: State<'_, AppState>,
    spec: RequestSpec,
    session_id: String,
    channel: Channel<WsClientMessage>,
) -> Result<(), ErrorPayload> {
    let request_id = new_request_id();
    if session_id.trim().is_empty() {
        return Err(ErrorPayload::new(
            &AppError::InvalidInput("sessionId 不能为空".into()),
            &request_id,
        ));
    }

    log(
        LogLevel::Info,
        "ws.connect",
        &request_id,
        json!({ "session_id": session_id, "target": safe_target(&spec.url) }),
        state.config.log_level,
    );

    match ws::connect(&state.ws_sessions, spec, session_id, channel, &state.config).await {
        Ok(()) => Ok(()),
        Err(error) => {
            log(
                LogLevel::Warn,
                "ws.connect.failed",
                &request_id,
                json!({ "code": error.code(), "detail": error.to_string() }),
                state.config.log_level,
            );
            Err(ErrorPayload::new(&error, &request_id))
        }
    }
}

#[tauri::command]
pub async fn ws_send(
    state: State<'_, AppState>,
    session_id: String,
    message: String,
) -> Result<u64, ErrorPayload> {
    let request_id = new_request_id();
    ws::send_text(&state.ws_sessions, &session_id, message)
        .await
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub async fn ws_close(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), ErrorPayload> {
    let request_id = new_request_id();
    ws::close(&state.ws_sessions, &session_id)
        .await
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub async fn mock_start(
    state: State<'_, AppState>,
    port: u16,
    rules: Vec<MockRule>,
) -> Result<MockStartInfo, ErrorPayload> {
    let request_id = new_request_id();
    log(
        LogLevel::Info,
        "mock.start",
        &request_id,
        json!({ "port": port, "rules": rules.len() }),
        state.config.log_level,
    );
    match mock::start(&state.mock, port, rules).await {
        Ok(info) => Ok(info),
        Err(error) => {
            log(
                LogLevel::Warn,
                "mock.start.failed",
                &request_id,
                json!({ "code": error.code(), "detail": error.to_string() }),
                state.config.log_level,
            );
            Err(ErrorPayload::new(&error, &request_id))
        }
    }
}

#[tauri::command]
pub async fn mock_stop(state: State<'_, AppState>) -> Result<(), ErrorPayload> {
    mock::stop(&state.mock).await;
    Ok(())
}

#[tauri::command]
pub fn mock_status(state: State<'_, AppState>) -> MockStatus {
    mock::status(&state.mock)
}

/// 并发压测：与单次发送共用同一条执行路径，聚合延迟分位数报告。
#[tauri::command]
pub async fn benchmark_run(
    state: State<'_, AppState>,
    spec: RequestSpec,
    total: usize,
    concurrency: usize,
) -> Result<crate::service::bench::BenchmarkReport, ErrorPayload> {
    let report = crate::service::bench::run(&state.http, &spec, total, concurrency).await;
    log(
        LogLevel::Info,
        "benchmark.finish",
        "bench",
        serde_json::json!({
            "total": report.total,
            "failed": report.failed,
            "rps": report.rps,
        }),
        state.config.log_level,
    );
    Ok(report)
}

/// Current contents of the shared cookie jar (every domain the app touched).
#[tauri::command]
pub fn cookie_list(state: State<'_, AppState>) -> Vec<StoredCookie> {
    state
        .http
        .cookies
        .lock()
        .map(|store| store.list())
        .unwrap_or_default()
}

/// Drop every stored cookie.
#[tauri::command]
pub fn cookie_clear(state: State<'_, AppState>) {
    if let Ok(mut store) = state.http.cookies.lock() {
        store.clear_all();
    }
}
