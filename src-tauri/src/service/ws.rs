//! WebSocket debugging service: connect to ws:// or wss:// endpoints, keep a
//! per-session sink for sending, and pump incoming frames to the WebView over
//! a Tauri Channel (same lifecycle pattern as the SSE streaming command).
//!
//! The variable substitution (`{{var}}`) deliberately reuses `template.rs` the
//! same way `http.rs` does, so a request spec resolves identically in both.

use reqora_core::config::Config;
use reqora_core::error::AppError;
use reqora_core::models::{ApiKeyLocation, AuthSpec, RequestSpec, ResponseHeader, Variables};
use reqora_core::service::template::resolve;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue, Request, Uri};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

const MAX_TIMEOUT_SECS: u64 = 300;

pub type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;
pub type WsSink = futures_util::stream::SplitSink<WsStream, Message>;

/// One live WebSocket connection. The read half is owned by the background
/// pump task; the sink stays here so `ws_send` / `ws_close` can use it.
pub struct WsSession {
    pub sink: WsSink,
    pub started_at: Instant,
}

/// Sessions keyed by id. Each session sits behind its own mutex so sending on
/// one connection never holds the map lock across an `await` (which would
/// block every other session's send/close).
pub type WsSessions = Arc<Mutex<HashMap<String, Arc<Mutex<WsSession>>>>>;

/// Messages pushed to the frontend for one WS session, tagged by `kind`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum WsClientMessage {
    /// Handshake succeeded. `status` is 101 for a WebSocket upgrade.
    Open {
        session_id: String,
        url: String,
        status: u16,
        headers: Vec<ResponseHeader>,
    },
    /// A received text frame, or a binary frame base64-encoded with a
    /// `base64:` prefix (`binary` marks which). `at_ms` is relative to the
    /// moment the connection was established.
    Message { data: String, at_ms: u64, binary: bool },
    /// The server closed the connection.
    Closed {
        code: Option<u16>,
        reason: Option<String>,
    },
    /// The read loop died unexpectedly.
    Error { code: String, message: String },
}

/// Open a WebSocket connection, register the session and start the read pump.
pub async fn connect(
    sessions: &WsSessions,
    spec: RequestSpec,
    session_id: String,
    channel: Channel<WsClientMessage>,
    config: &Config,
) -> Result<(), AppError> {
    let (url, headers) = prepare(&spec)?;

    let uri: Uri = url
        .parse()
        .map_err(|_| AppError::InvalidInput(format!("URL 格式不合法: {url}")))?;

    let mut builder = Request::builder().method("GET").uri(uri.clone());
    for (key, value) in &headers {
        builder = builder.header(key.as_str(), value.as_str());
    }
    // The handshake requires a Host header; supply it from the URI unless the
    // user set one explicitly.
    if !headers.iter().any(|(key, _)| key.eq_ignore_ascii_case("host")) {
        if let Some(authority) = uri.authority() {
            builder = builder.header("host", authority.as_str());
        }
    }
    let request = builder
        .body(())
        .map_err(|_| AppError::InvalidInput("WebSocket 请求构造失败".into()))?;

    let timeout_secs = spec
        .timeout_secs
        .unwrap_or(config.request_timeout_secs)
        .clamp(1, MAX_TIMEOUT_SECS);
    let handshake = tokio::time::timeout(
        Duration::from_secs(timeout_secs),
        connect_async(request),
    )
    .await;
    let (stream, response) = match handshake {
        Ok(Ok(pair)) => pair,
        Ok(Err(_)) => return Err(AppError::Network("WebSocket handshake failed".into())),
        Err(_) => return Err(AppError::Timeout),
    };

    let status = response.status().as_u16();
    let mut response_headers: Vec<ResponseHeader> = response
        .headers()
        .iter()
        .map(|(name, value)| ResponseHeader {
            name: name.to_string(),
            value: value.to_str().unwrap_or("<binary>").to_string(),
        })
        .collect();
    response_headers.sort_by(|left, right| left.name.cmp(&right.name));

    let started = Instant::now();
    let _ = channel.send(WsClientMessage::Open {
        session_id: session_id.clone(),
        url: url.clone(),
        status,
        headers: response_headers,
    });

    let (sink, read) = stream.split();
    // Reject a duplicate id before inserting so an existing session's pump is
    // not orphaned by an overwrite.
    {
        let mut guard = sessions.lock().await;
        if guard.contains_key(&session_id) {
            return Err(AppError::InvalidInput(format!("会话已存在：{session_id}")));
        }
        guard.insert(
            session_id.clone(),
            Arc::new(Mutex::new(WsSession {
                sink,
                started_at: started,
            })),
        );
    }

    let pump_sessions = Arc::clone(sessions);
    tokio::spawn(read_pump(read, session_id, pump_sessions, channel, started));
    Ok(())
}

/// Send one text frame; returns the timestamp (ms since the connection was
/// established) so the UI can order it against received messages.
pub async fn send_text(
    sessions: &WsSessions,
    session_id: &str,
    message: String,
) -> Result<u64, AppError> {
    // Clone the per-session handle under the map lock, then drop the map lock
    // before awaiting the sink — other sessions stay responsive meanwhile.
    let session = {
        let guard = sessions.lock().await;
        guard.get(session_id).cloned().ok_or(AppError::WsSessionNotFound)?
    };
    let mut session = session.lock().await;
    let at_ms = session.started_at.elapsed().as_millis() as u64;
    if session.sink.send(Message::Text(message.into())).await.is_err() {
        sessions.lock().await.remove(session_id);
        return Err(AppError::Network("WebSocket send failed".into()));
    }
    Ok(at_ms)
}

/// Gracefully close: remove the session first (so no further sends are
/// possible), then send a Close frame. The read pump observes the close
/// handshake, emits `Closed` and finishes.
pub async fn close(sessions: &WsSessions, session_id: &str) -> Result<(), AppError> {
    // Remove first (no further sends), release the map lock, then send Close.
    let session = sessions.lock().await.remove(session_id).ok_or(AppError::WsSessionNotFound)?;
    let mut session = session.lock().await;
    let _ = session.sink.send(Message::Close(None)).await;
    Ok(())
}

/// Background read loop: forwards every incoming frame to the channel and
/// cleans the session up when the connection ends.
async fn read_pump(
    mut read: futures_util::stream::SplitStream<WsStream>,
    session_id: String,
    sessions: WsSessions,
    channel: Channel<WsClientMessage>,
    started: Instant,
) {
    let mut closed_sent = false;
    while let Some(item) = read.next().await {
        let at_ms = started.elapsed().as_millis() as u64;
        match item {
            Ok(Message::Text(text)) => {
                let _ = channel.send(WsClientMessage::Message {
                    data: text.to_string(),
                    at_ms,
                    binary: false,
                });
            }
            Ok(Message::Binary(bytes)) => {
                let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                let _ = channel.send(WsClientMessage::Message {
                    data: format!("base64:{encoded}"),
                    at_ms,
                    binary: true,
                });
            }
            Ok(Message::Close(frame)) => {
                let (code, reason) = match frame {
                    Some(frame) => (Some(u16::from(frame.code)), Some(frame.reason.to_string())),
                    None => (None, None),
                };
                let _ = channel.send(WsClientMessage::Closed { code, reason });
                closed_sent = true;
                break;
            }
            // Ping/Pong frames are handled by tungstenite itself.
            Ok(_) => {}
            Err(_) => {
                let _ = channel.send(WsClientMessage::Error {
                    code: "WS_ERROR".into(),
                    message: "连接读取失败，已断开".into(),
                });
                break;
            }
        }
    }
    if !closed_sent {
        let _ = channel.send(WsClientMessage::Closed {
            code: None,
            reason: None,
        });
    }
    sessions.lock().await.remove(&session_id);
}

/// Resolve `{{var}}` placeholders in url/headers/auth, apply auth headers and
/// validate the target scheme. Fails when any variable is unresolved so the
/// user cannot silently connect to a URL containing `{{...}}`.
fn prepare(spec: &RequestSpec) -> Result<(String, Vec<(String, String)>), AppError> {
    let mut missing = BTreeSet::new();
    let mut url = sub(&spec.url, &spec.variables, &mut missing);

    let mut headers: Vec<(String, String)> = Vec::new();
    for item in spec
        .headers
        .iter()
        .filter(|item| item.enabled && !item.key.trim().is_empty())
    {
        let key = sub(&item.key, &spec.variables, &mut missing);
        let value = sub(&item.value, &spec.variables, &mut missing);
        HeaderName::from_bytes(key.as_bytes())
            .map_err(|_| AppError::InvalidInput(format!("Header 名称不合法: {key}")))?;
        HeaderValue::from_str(&value)
            .map_err(|_| AppError::InvalidInput(format!("Header 值含非法字符: {key}")))?;
        headers.push((key, value));
    }

    match &spec.auth {
        // Extended auth schemes are resolved by the HTTP engine. WebSocket
        // handshakes still honour a persisted OAuth 2.0 access token; SigV4
        // and mTLS need the request/transport context and are desktop-only.
        AuthSpec::OAuth2 { .. } => {
            let token = serde_json::to_value(&spec.auth)
                .ok()
                .and_then(|value| {
                    value
                        .get("accessToken")
                        .and_then(|item| item.as_str())
                        .map(ToOwned::to_owned)
                })
                .unwrap_or_default();
            if !token.trim().is_empty() {
                headers.push(("Authorization".into(), format!("Bearer {token}")));
            }
        }
        AuthSpec::AwsSigV4 { .. } | AuthSpec::Mtls { .. } => {}
        AuthSpec::None => {}
        AuthSpec::Bearer { token } => {
            let token = sub(token, &spec.variables, &mut missing);
            headers.push(("Authorization".into(), format!("Bearer {token}")));
        }
        AuthSpec::Basic { username, password } => {
            let username = sub(username, &spec.variables, &mut missing);
            let password = sub(password, &spec.variables, &mut missing);
            let encoded = base64::engine::general_purpose::STANDARD
                .encode(format!("{username}:{password}"));
            headers.push(("Authorization".into(), format!("Basic {encoded}")));
        }
        AuthSpec::ApiKey {
            key,
            value,
            location,
        } => {
            let key = sub(key, &spec.variables, &mut missing);
            let value = sub(value, &spec.variables, &mut missing);
            if !key.trim().is_empty() {
                match location {
                    ApiKeyLocation::Header => headers.push((key, value)),
                    ApiKeyLocation::Query => {
                        let separator = if url.contains('?') { '&' } else { '?' };
                        url.push(separator);
                        url.push_str(&key);
                        url.push('=');
                        url.push_str(&value);
                    }
                }
            }
        }
    }

    if !missing.is_empty() {
        let names = missing.into_iter().collect::<Vec<_>>().join(", ");
        return Err(AppError::InvalidInput(format!("未定义的变量: {names}")));
    }

    let lowered = url.to_ascii_lowercase();
    if !(lowered.starts_with("ws://") || lowered.starts_with("wss://")) {
        return Err(AppError::InvalidInput(
            "仅支持 ws:// 或 wss:// 地址".into(),
        ));
    }

    Ok((url, headers))
}

fn sub(input: &str, variables: &Variables, missing: &mut BTreeSet<String>) -> String {
    let result = resolve(input, variables);
    missing.extend(result.missing);
    result.value
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(url: &str) -> RequestSpec {
        RequestSpec {
            id: "test".into(),
            name: "test".into(),
            method: "GET".into(),
            url: url.into(),
            headers: vec![],
            query: vec![],
            body: Default::default(),
            auth: Default::default(),
            variables: BTreeMap::new(),
            timeout_secs: None,
            follow_redirects: None,
            verify_tls: None,
            proxy_url: None,
            use_cookies: None,
            http_version: None,
        }
    }

    use reqora_core::models::BodySpec;
    use std::collections::BTreeMap;

    #[test]
    fn resolves_variables_and_auth_headers() {
        let mut request = spec("ws://{{host}}:9000/chat");
        request.variables.insert("host".into(), "127.0.0.1".into());
        request.auth = AuthSpec::Bearer {
            token: "{{token}}".into(),
        };
        request.variables.insert("token".into(), "abc".into());
        request.headers = vec![reqora_core::models::KeyValue {
            id: "h1".into(),
            key: "X-Trace".into(),
            value: "{{trace}}".into(),
            enabled: true,
        }];
        request.variables.insert("trace".into(), "t1".into());

        let (url, headers) = prepare(&request).unwrap();
        assert_eq!(url, "ws://127.0.0.1:9000/chat");
        assert!(headers.contains(&("Authorization".into(), "Bearer abc".into())));
        assert!(headers.contains(&("X-Trace".into(), "t1".into())));
    }

    #[test]
    fn rejects_http_and_unresolved_variables() {
        let http = spec("http://example.com/ws");
        assert!(matches!(prepare(&http), Err(AppError::InvalidInput(_))));

        let unresolved = spec("ws://{{missing}}/ws");
        match prepare(&unresolved) {
            Err(AppError::InvalidInput(message)) => {
                assert!(message.contains("missing"), "message={message}");
            }
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn basic_auth_is_base64_encoded() {
        let mut request = spec("wss://example.com/ws");
        request.auth = AuthSpec::Basic {
            username: "user".into(),
            password: "pass".into(),
        };
        let (_, headers) = prepare(&request).unwrap();
        let expected = base64::engine::general_purpose::STANDARD.encode("user:pass");
        assert!(headers.contains(&("Authorization".into(), format!("Basic {expected}"))));
    }

    #[test]
    fn body_is_ignored_but_accepted() {
        let mut request = spec("ws://example.com/ws");
        request.body = BodySpec::Json {
            content: "ignored".into(),
        };
        assert!(prepare(&request).is_ok());
    }
}
