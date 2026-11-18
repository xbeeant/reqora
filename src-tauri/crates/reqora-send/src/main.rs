//! `reqora-send` — a headless NDJSON sidecar for `reqora-core`.
//!
//! The Node CLI and the MCP server cannot link a Rust rlib, but they *can*
//! spawn one process and speak length-delimited JSON over stdio. That is the
//! whole trick behind "CLI and desktop share one sending chain": both call
//! `HttpService` from reqora-core, only the envelope differs (Tauri IPC vs.
//! NDJSON). Proxy handling, TLS verification, redirect policy, the cookie jar,
//! variable resolution, auth, compression decoding, timings and the raw wire
//! are therefore identical by construction.
//!
//! Protocol (one JSON object per line, stdin -> stdout):
//!
//! ```text
//! {"id":"1","method":"hello"}
//! {"id":"1","ok":true,"engine":"reqora-core","version":"0.0.1","protocol":1}
//!
//! {"id":"2","method":"send","spec":{ ...RequestSpec... },"maxBodyBytes":16777216}
//! {"id":"2","ok":true,"response":{ ...ResponsePayload... }}
//! {"id":"3","method":"send","spec":{...}}
//! {"id":"3","ok":false,"error":{"code":"INVALID_INPUT","message":"...","requestId":"..."}}
//!
//! {"id":"9","method":"shutdown"}
//! ```
//!
//! stdout carries **only** protocol lines. Anything diagnostic goes to stderr.
//! One process keeps a single `CookieStore` alive across requests, matching the
//! desktop's cross-request cookie jar.

use reqora_core::config::Config;
use reqora_core::error::{AppError, ErrorPayload};
use reqora_core::models::RequestSpec;
use reqora_core::service::cookies::CookieStore;
use reqora_core::service::http::HttpService;
use reqora_core::{ENGINE_ID, ENGINE_VERSION};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const PROTOCOL_VERSION: u32 = 1;
/// CLI assertions/scripts need the full body, not the desktop's 256 KiB
/// preview. Override with `REQORA_SEND_MAX_BODY_BYTES` (clamped below).
const DEFAULT_MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const MIN_BODY_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 128 * 1024 * 1024;

fn max_body_from_env() -> usize {
    std::env::var("REQORA_SEND_MAX_BODY_BYTES")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .unwrap_or(DEFAULT_MAX_BODY_BYTES)
        .clamp(MIN_BODY_BYTES, MAX_BODY_BYTES)
}

fn new_service(default_max: usize) -> HttpService {
    let mut config = Config::defaults();
    // `execute()` inlines min(max_response_bytes, inline_body_bytes) bytes.
    // Set both to the CLI ceiling so assertions see the complete response.
    config.max_response_bytes = default_max;
    config.inline_body_bytes = default_max;
    HttpService {
        config,
        cookies: Arc::new(Mutex::new(CookieStore::default())),
    }
}

/// Same cookie jar, different body cap — used when a caller overrides the cap
/// for one request without resetting session state.
fn with_body_cap(base: &HttpService, max: usize) -> HttpService {
    let mut config = base.config.clone();
    config.max_response_bytes = max;
    config.inline_body_bytes = max;
    HttpService {
        config,
        cookies: Arc::clone(&base.cookies),
    }
}

fn error_envelope(id: Value, error: &AppError, request_id: &str) -> Value {
    json!({ "id": id, "ok": false, "error": ErrorPayload::new(error, request_id) })
}

async fn handle(service: &HttpService, line: &str, default_max: usize) -> (Value, bool) {
    let raw: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(err) => {
            return (
                error_envelope(
                    Value::Null,
                    &AppError::InvalidInput(format!("协议行不是合法 JSON: {err}")),
                    "sidecar",
                ),
                false,
            );
        }
    };
    let id = raw.get("id").cloned().unwrap_or(Value::Null);
    let method = raw.get("method").and_then(Value::as_str).unwrap_or("send");

    match method {
        "hello" => (
            json!({
                "id": id,
                "ok": true,
                "engine": ENGINE_ID,
                "version": ENGINE_VERSION,
                "protocol": PROTOCOL_VERSION,
                "features": [
                    "http", "cookies", "proxy", "tlsVerify", "redirects",
                    "timings", "rawWire", "compression", "graphql", "multipart"
                ],
            }),
            false,
        ),
        "shutdown" => (json!({ "id": id, "ok": true, "shutdown": true }), true),
        "send" => {
            let request_id = raw
                .get("requestId")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    let label = id.as_str().map(str::to_owned).unwrap_or_else(|| id.to_string());
                    format!("sidecar-{label}")
                });
            let spec_value = raw.get("spec").cloned().unwrap_or(Value::Null);
            let spec: RequestSpec = match serde_json::from_value(spec_value) {
                Ok(spec) => spec,
                Err(err) => {
                    return (
                        error_envelope(
                            id,
                            &AppError::InvalidInput(format!("RequestSpec 反序列化失败: {err}")),
                            &request_id,
                        ),
                        false,
                    );
                }
            };
            let max = raw
                .get("maxBodyBytes")
                .and_then(Value::as_u64)
                .map(|value| (value as usize).clamp(MIN_BODY_BYTES, MAX_BODY_BYTES))
                .unwrap_or(default_max);
            let engine = if max == service.config.max_response_bytes {
                // Borrow the shared instance; no need to build a second one.
                None
            } else {
                Some(with_body_cap(service, max))
            };
            let active = engine.as_ref().unwrap_or(service);
            match active.execute(spec, &request_id).await {
                Ok(payload) => (json!({ "id": id, "ok": true, "response": payload }), false),
                Err(err) => (error_envelope(id, &err, &request_id), false),
            }
        }
        other => (
            error_envelope(
                id,
                &AppError::InvalidInput(format!("未知方法: {other}")),
                "sidecar",
            ),
            false,
        ),
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let default_max = max_body_from_env();
    let service = new_service(default_max);

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let (response, shutdown) = handle(&service, &line, default_max).await;
        let mut out = serde_json::to_string(&response)?;
        out.push('\n');
        stdout.write_all(out.as_bytes()).await?;
        stdout.flush().await?;
        if shutdown {
            break;
        }
    }
    Ok(())
}
