//! Command group: integration.

use super::*;



#[tauri::command]
pub async fn pick_and_read_text(state: State<'_, AppState>) -> Result<PickedFile, ErrorPayload> {
    let request_id = new_request_id();
    match files::pick_and_read_text().await {
        Ok(file) => {
            log(
                LogLevel::Debug,
                "file.pick",
                &request_id,
                json!({ "name": file.name }),
                state.config.log_level,
            );
            Ok(file)
        }
        Err(error) => Err(ErrorPayload::new(&error, &request_id)),
    }
}

#[tauri::command]
pub async fn save_text_file(
    state: State<'_, AppState>,
    file_name: String,
    contents: String,
) -> Result<String, ErrorPayload> {
    let request_id = new_request_id();
    match files::save_text(file_name, contents).await {
        Ok(path) => {
            log(
                LogLevel::Debug,
                "file.save",
                &request_id,
                json!({ "ok": true }),
                state.config.log_level,
            );
            Ok(path)
        }
        Err(error) => Err(ErrorPayload::new(&error, &request_id)),
    }
}

/// Save a spooled response body to a file chosen by the user. Used by the
/// "send and download" action, whose response is deliberately kept out of
/// the execution history. `body_id` is a BodyStore id, never a free path.
#[tauri::command]
pub async fn save_response_body(
    state: State<'_, AppState>,
    body_id: String,
    file_name: String,
) -> Result<files::SavedBodyFile, ErrorPayload> {
    let request_id = new_request_id();
    match files::save_response_body(&state.bodies, &body_id, &file_name).await {
        Ok(saved) => {
            log(
                LogLevel::Info,
                "file.response_saved",
                &request_id,
                json!({ "bytes": saved.size }),
                state.config.log_level,
            );
            Ok(saved)
        }
        Err(error) => Err(ErrorPayload::new(&error, &request_id)),
    }
}

#[tauri::command]
pub async fn mcp_connect(
    state: State<'_, AppState>,
    config: McpServerConfig,
) -> Result<McpConnectResult, ErrorPayload> {
    let request_id = new_request_id();
    log(
        LogLevel::Info,
        "mcp.connect",
        &request_id,
        json!({
            "name": config.name,
            "transport": config.transport,
            // Never log command args or headers: they may carry tokens.
            "target": safe_target(&config.url),
        }),
        state.config.log_level,
    );
    state
        .mcp
        .connect(&config)
        .await
        .map_err(|message| ErrorPayload::new(&AppError::Mcp(message), &request_id))
}

#[tauri::command]
pub async fn mcp_disconnect(state: State<'_, AppState>, name: String) -> Result<bool, ErrorPayload> {
    let request_id = new_request_id();
    log(
        LogLevel::Info,
        "mcp.disconnect",
        &request_id,
        json!({ "name": name }),
        state.config.log_level,
    );
    Ok(state.mcp.disconnect(&name).await)
}

#[tauri::command]
pub async fn mcp_call(
    state: State<'_, AppState>,
    name: String,
    tool: String,
    arguments: Value,
) -> Result<McpCallOutcome, ErrorPayload> {
    let request_id = new_request_id();
    log(
        LogLevel::Info,
        "mcp.call",
        &request_id,
        json!({ "name": name, "tool": tool }),
        state.config.log_level,
    );
    state
        .mcp
        .call(&name, &tool, arguments)
        .await
        .map_err(|message| ErrorPayload::new(&AppError::Mcp(message), &request_id))
}

/// One OpenAI-compatible chat completion. Stateless: credentials arrive per
/// call from workspace settings and are never logged.
#[tauri::command]
pub async fn ai_chat(
    state: State<'_, AppState>,
    base_url: String,
    api_key: String,
    model: String,
    system: String,
    user: String,
) -> Result<String, ErrorPayload> {
    let request_id = new_request_id();
    log(
        LogLevel::Debug,
        "ai.chat",
        &request_id,
        json!({ "target": safe_target(&base_url), "model": model }),
        state.config.log_level,
    );
    let settings = AiSettings {
        base_url,
        api_key,
        model,
    };
    match ai::chat_completion(&settings, &system, &user).await {
        Ok(content) => Ok(content),
        Err(error) => {
            log(
                LogLevel::Warn,
                "ai.chat.failed",
                &request_id,
                json!({ "code": error.code(), "detail": error.to_string() }),
                state.config.log_level,
            );
            Err(ErrorPayload::new(&error, &request_id))
        }
    }
}

#[tauri::command]
pub async fn grpc_compile(
    state: State<'_, AppState>,
    files: Vec<crate::service::grpc::GrpcFileRef>,
) -> Result<crate::service::grpc::GrpcSchema, ErrorPayload> {
    let request_id = new_request_id();
    log(
        LogLevel::Info,
        "grpc.compile",
        &request_id,
        json!({ "count": files.len() }),
        state.config.log_level,
    );
    // protox compilation is CPU-bound; keep it off the async reactor.
    let manager = state.grpc.clone();
    let result = match tokio::task::spawn_blocking(move || manager.compile(&files)).await {
        Ok(inner) => inner,
        Err(join_error) => Err(format!("编译任务失败：{join_error}")),
    };
    result.map_err(|message| ErrorPayload::new(&AppError::Grpc(message), &request_id))
}

#[tauri::command]
pub async fn grpc_invoke(
    state: State<'_, AppState>,
    spec: crate::service::grpc::GrpcInvokeSpec,
) -> Result<crate::service::grpc::GrpcInvokeResult, ErrorPayload> {
    let request_id = new_request_id();
    log(
        LogLevel::Info,
        "grpc.invoke",
        &request_id,
        json!({
            "service": spec.service,
            "method": spec.method,
            "target": safe_target(&spec.address),
        }),
        state.config.log_level,
    );
    let manager = state.grpc.clone();
    match manager.invoke(spec).await {
        Ok(result) => Ok(result),
        Err(message) => Err(ErrorPayload::new(&AppError::Grpc(message), &request_id)),
    }
}

#[tauri::command]
pub async fn grpc_reflect(
    state: State<'_, AppState>,
    address: String,
    headers: std::collections::BTreeMap<String, String>,
    timeout_ms: Option<u64>,
    verify_tls: Option<bool>,
    ca_pem: Option<String>,
) -> Result<crate::service::grpc::GrpcSchema, ErrorPayload> {
    let request_id = new_request_id();
    log(
        LogLevel::Info,
        "grpc.reflect",
        &request_id,
        json!({ "target": safe_target(&address) }),
        state.config.log_level,
    );
    let manager = state.grpc.clone();
    let tls = crate::service::tls::TlsOptions::new(verify_tls, ca_pem);
    let result = manager
        .reflect(&address, &headers, timeout_ms, &tls)
        .await
        .map(|schema| {
            log(
                LogLevel::Info,
                "grpc.reflect.done",
                &request_id,
                json!({ "services": schema.services.len() }),
                state.config.log_level,
            );
            schema
        });
    result.map_err(|message| ErrorPayload::new(&AppError::Grpc(message), &request_id))
}

#[tauri::command]
pub async fn tcp_debug(
    state: State<'_, AppState>,
    spec: crate::service::tcp::TcpDebugSpec,
) -> Result<crate::service::tcp::TcpDebugResult, ErrorPayload> {
    let request_id = new_request_id();
    log(
        LogLevel::Info,
        "tcp.debug",
        &request_id,
        json!({
            "target": safe_target(&spec.address),
            "encoding": spec.encoding,
            "payload_bytes": spec.payload.len(),
        }),
        state.config.log_level,
    );
    match crate::service::tcp::debug(&spec).await {
        Ok(result) => {
            log(
                LogLevel::Info,
                "tcp.debug.done",
                &request_id,
                json!({
                    "sent": result.sent_bytes,
                    "received": result.received_bytes,
                    "time_ms": result.elapsed_ms,
                }),
                state.config.log_level,
            );
            Ok(result)
        }
        Err(message) => Err(ErrorPayload::new(&AppError::Tcp(message), &request_id)),
    }
}

#[tauri::command]
pub async fn pick_proto_files(state: State<'_, AppState>) -> Result<Vec<crate::service::grpc::GrpcFileRef>, ErrorPayload> {
    let request_id = new_request_id();
    match files::pick_proto_files().await {
        Ok(list) => {
            log(
                LogLevel::Debug,
                "file.pick_proto",
                &request_id,
                json!({ "count": list.len() }),
                state.config.log_level,
            );
            Ok(list)
        }
        Err(error) => Err(ErrorPayload::new(&error, &request_id)),
    }
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), ErrorPayload> {
    // `open::that` hands the string to the OS default handler. Never allow
    // non-web schemes (file:, javascript:, custom protocol handlers) through
    // an IPC boundary that any script in the WebView can call.
    let parsed = reqwest::Url::parse(&url)
        .map_err(|_| ErrorPayload::new(&AppError::Internal("外部链接不是合法的 URL".into()), "open_url"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(ErrorPayload::new(
            &AppError::Internal("只允许打开 http(s) 外部链接".into()),
            "open_url",
        ));
    }
    open::that(parsed.as_str()).map_err(|error| {
        AppError::Internal(format!("打开外部链接失败: {error}"))
    })
    .map_err(|error| ErrorPayload::new(&error, "open_url"))
}

#[tauri::command]
pub async fn db_query(
    state: State<'_, AppState>,
    spec: crate::service::db::DbQuerySpec,
) -> Result<crate::service::db::DbQueryResult, ErrorPayload> {
    let request_id = new_request_id();
    log(
        LogLevel::Info,
        "db.query",
        &request_id,
        json!({ "mode": spec.mode, "sqlLength": spec.sql.len() }),
        state.config.log_level,
    );
    crate::service::db::db_query(spec)
        .await
        .map_err(|message| ErrorPayload::new(&AppError::Db(message), &request_id))
}
