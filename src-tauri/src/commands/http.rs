//! Command group: http.

use super::*;



#[tauri::command]
pub async fn send_request(
    state: State<'_, AppState>,
    spec: RequestSpec,
) -> Result<ResponsePayload, ErrorPayload> {
    let request_id = new_request_id();

    log(
        LogLevel::Info,
        "http.request.start",
        &request_id,
        json!({
            "method": spec.method.clone(),
            // Only the origin is logged; query strings may contain credentials.
            "target": safe_target(&spec.url),
        }),
        state.config.log_level,
    );

    let body_id = new_request_id();
    let result = match state.http.open(spec).await {
        Ok(opened) => {
            reqora_core::service::response_body::collect(
                &opened.meta,
                opened.response,
                &state.config,
                &request_id,
                &body_id,
                &state.bodies,
            )
            .await
        }
        Err(error) => Err(error),
    };

    match result {
        Ok(response) => {
            log(
                LogLevel::Info,
                "http.request.finish",
                &request_id,
                json!({
                    "status": response.status,
                    "time_ms": response.time_ms,
                    "bytes": response.size,
                    "unresolved_variables": response.missing_variables.len(),
                }),
                state.config.log_level,
            );
            Ok(response)
        }
        Err(error) => {
            log(
                LogLevel::Warn,
                "http.request.failed",
                &request_id,
                json!({
                    "code": error.code(),
                    // Internal detail is logged for diagnosis, never returned to the UI.
                    "detail": error.to_string(),
                }),
                state.config.log_level,
            );
            Err(ErrorPayload::new(&error, &request_id))
        }
    }
}

/// Open a request and stream its body back over a per-request Channel.
///
/// The response headers decide the mode: `text/event-stream` is parsed into
/// frames as chunks arrive (so the UI can merge text before the stream ends),
/// anything else is buffered and returned as a normal `ResponsePayload` on the
/// same channel — no second request, no duplicated validation logic.
///
/// Errors are reported on the channel rather than as a rejected invoke, so the
/// frontend has exactly one place to handle stream lifecycle.
#[tauri::command]
pub async fn stream_request(
    state: State<'_, AppState>,
    spec: RequestSpec,
    request_id: String,
    channel: Channel<SseMessage>,
) -> Result<(), ErrorPayload> {
    let request_id = if request_id.trim().is_empty() {
        new_request_id()
    } else {
        request_id
    };
    state
        .cancelled_streams
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&request_id);

    log(
        LogLevel::Info,
        "http.stream.start",
        &request_id,
        json!({ "method": spec.method.clone(), "target": safe_target(&spec.url) }),
        state.config.log_level,
    );

    let opened = match state.http.open_stream(spec).await {
        Ok(opened) => opened,
        Err(error) => {
            state
                .cancelled_streams
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&request_id);
            let payload = ErrorPayload::new(&error, &request_id);
            log(
                LogLevel::Warn,
                "http.stream.failed",
                &request_id,
                json!({ "code": payload.code, "detail": error.to_string() }),
                state.config.log_level,
            );
            let _ = channel.send(SseMessage::Error {
                code: payload.code.to_string(),
                message: payload.message,
            });
            return Ok(());
        }
    };

    let meta = opened.meta;
    let mut response = opened.response;
    let is_event_stream = meta.is_event_stream();
    let _ = channel.send(SseMessage::Meta {
        meta: SseMeta {
            status: meta.status,
            status_text: meta.status_text.clone(),
            ok: meta.ok,
            url: meta.url.clone(),
            resolved_url: meta.resolved_url.clone(),
            headers: meta.headers.clone(),
            content_type: meta.content_type.clone(),
            missing_variables: meta.missing_variables.clone(),
            timings: meta.timings.finish(
                meta.ttfb_ms,
                meta.ttfb_ms,
                &meta.protocol,
                meta.https,
            ),
            raw_request: meta.raw_request.clone(),
        },
    });

    if !is_event_stream {
        let body_id = new_request_id();
        match reqora_core::service::response_body::collect(
            &meta,
            response,
            &state.config,
            &request_id,
            &body_id,
            &state.bodies,
        )
        .await
        {
            Ok(payload) => {
                let _ = channel.send(SseMessage::NonSse { response: payload });
            }
            Err(error) => {
                let _ = channel.send(SseMessage::Error {
                    code: error.code().to_string(),
                    message: "读取响应体失败，请检查网络后重试".into(),
                });
                log(
                    LogLevel::Warn,
                    "http.stream.failed",
                    &request_id,
                    json!({ "detail": error.to_string() }),
                    state.config.log_level,
                );
            }
        }
        state
            .cancelled_streams
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&request_id);
        return Ok(());
    }

    // NDJSON (application/x-ndjson, .jsonl) streams frame per line; SSE keeps
    // its field/blank-line protocol. Both share the same read loop below.
    let mut parser = if reqora_core::service::sse::is_ndjson_content_type(&meta.content_type) {
        SseParser::new_ndjson()
    } else {
        SseParser::new()
    };
    let mut frames: u64 = 0;
    let mut bytes: u64 = 0;
    let mut truncated = false;
    let mut cancelled = false;
    let mut idle_secs: u64 = 0;
    let byte_limit = state.config.max_response_bytes as u64;
    // Verbatim wire bytes for the raw-message inspector. Bounded by the same
    // byte_limit as the stream itself, so an endless LLM stream cannot grow it.
    let mut raw_chunks: Vec<u8> = Vec::new();

    loop {
        let is_cancelled = state
            .cancelled_streams
            .lock()
            .map(|set| set.contains(&request_id))
            .unwrap_or(false);
        if is_cancelled {
            cancelled = true;
            break;
        }
        if bytes >= byte_limit || frames >= MAX_FRAMES {
            truncated = true;
            break;
        }

        // A short timeout keeps the cancel button responsive even when the
        // server is silent; repeated timeouts add up to the idle ceiling.
        let chunk_result = tokio::time::timeout(STREAM_POLL_INTERVAL, response.chunk()).await;
        match chunk_result {
            Err(_) => {
                idle_secs += STREAM_POLL_INTERVAL.as_secs();
                if idle_secs >= STREAM_IDLE_TIMEOUT.as_secs() {
                    truncated = true;
                    let _ = channel.send(SseMessage::Error {
                        code: "STREAM_IDLE".into(),
                        message: "连接长时间没有新数据，已停止接收并保留此前收到的内容".into(),
                    });
                    break;
                }
                continue;
            }
            Ok(Ok(Some(chunk))) => {
                idle_secs = 0;
                bytes += chunk.len() as u64;
                if (raw_chunks.len() as u64) < byte_limit {
                    raw_chunks.extend_from_slice(&chunk);
                }
                let at_ms = meta.started.elapsed().as_millis() as u64;
                for frame in parser.push(&chunk, at_ms) {
                    frames += 1;
                    if frames > MAX_FRAMES {
                        truncated = true;
                        break;
                    }
                    let _ = channel.send(SseMessage::Frame { frame });
                }
                if truncated {
                    break;
                }
            }
            Ok(Ok(None)) => break,
            Ok(Err(error)) => {
                log(
                    LogLevel::Warn,
                    "http.stream.failed",
                    &request_id,
                    json!({ "detail": error.to_string() }),
                    state.config.log_level,
                );
                let _ = channel.send(SseMessage::Error {
                    code: "NETWORK_ERROR".into(),
                    message: "流式连接中断，已显示此前收到的内容".into(),
                });
                break;
            }
        }
    }

    if let Some(frame) = parser.finish(meta.started.elapsed().as_millis() as u64) {
        frames += 1;
        let _ = channel.send(SseMessage::Frame { frame });
    }
    truncated |= parser.truncated;

    let elapsed_ms = meta.started.elapsed().as_millis() as u64;
    let _ = channel.send(SseMessage::Done {
        frames,
        bytes,
        elapsed_ms,
        truncated,
        cancelled,
        timings: meta.timings.finish(elapsed_ms, meta.ttfb_ms, &meta.protocol, meta.https),
        raw_response: wire_response(
            &meta.protocol,
            meta.status,
            &meta.status_text,
            &meta.headers,
            &raw_chunks,
            false,
            truncated,
        ),
    });
    state
        .cancelled_streams
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&request_id);
    log(
        LogLevel::Info,
        "http.stream.finish",
        &request_id,
        json!({ "frames": frames, "bytes": bytes, "time_ms": elapsed_ms, "cancelled": cancelled }),
        state.config.log_level,
    );
    Ok(())
}

/// Bytes are shown as UTF-8 for text bodies and base64 for binary bodies.
fn encode_body_bytes(bytes: &[u8], binary: bool) -> String {
    if binary {
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[tauri::command]
pub fn read_response_body(
    state: State<'_, AppState>,
    body_id: String,
    offset: u64,
    length: u64,
) -> Result<BodySlice, ErrorPayload> {
    let request_id = new_request_id();
    let length = length.min(2 * 1024 * 1024);
    let info = state
        .bodies
        .info(&body_id)
        .map_err(|error| ErrorPayload::new(&error, &request_id))?;
    let (size, body_kind) = match info {
        Some(info) => (info.size, info.body_kind),
        None => (0, "text".to_string()),
    };
    let binary = body_kind == "binary";
    let offset = offset.min(size);
    let bytes = state
        .bodies
        .read_range(&body_id, offset, length)
        .map_err(|error| ErrorPayload::new(&error, &request_id))?;
    Ok(BodySlice {
        body_id,
        offset,
        length: bytes.len() as u64,
        total: size,
        encoding: if binary { "base64" } else { "utf8" }.to_string(),
        data: encode_body_bytes(&bytes, binary),
    })
}

#[tauri::command]
pub fn read_response_lines(
    state: State<'_, AppState>,
    body_id: String,
    start_line: u64,
    line_count: u64,
) -> Result<BodyLines, ErrorPayload> {
    let request_id = new_request_id();
    let line_count = line_count.min(2000);
    let info = state
        .bodies
        .info(&body_id)
        .map_err(|error| ErrorPayload::new(&error, &request_id))?;
    let (total_lines, body_kind) = match info {
        Some(info) => (info.total_lines, info.body_kind),
        None => (0, "text".to_string()),
    };
    let binary = body_kind == "binary";
    let start_line = start_line.min(total_lines);
    let raw_lines = state
        .bodies
        .line_range(&body_id, start_line, line_count)
        .map_err(|error| ErrorPayload::new(&error, &request_id))?;
    let lines: Vec<String> = raw_lines
        .iter()
        .map(|line| encode_body_bytes(line, binary))
        .collect();
    Ok(BodyLines {
        body_id,
        start_line,
        line_count: lines.len() as u64,
        total_lines,
        lines,
    })
}

#[tauri::command]
pub fn response_body_info(
    state: State<'_, AppState>,
    body_id: String,
) -> Result<Option<BodyInfo>, ErrorPayload> {
    let request_id = new_request_id();
    state
        .bodies
        .info(&body_id)
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub fn release_response_body(
    state: State<'_, AppState>,
    body_id: String,
) -> Result<(), ErrorPayload> {
    let request_id = new_request_id();
    state
        .bodies
        .remove(&body_id)
        .map_err(|error| ErrorPayload::new(&error, &request_id))
}

#[tauri::command]
pub fn cancel_stream(state: State<'_, AppState>, request_id: String) {
    state
        .cancelled_streams
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(request_id);
}
