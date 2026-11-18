//! Local mock server built directly on `tokio::net::TcpListener` with a
//! hand-rolled, minimal HTTP/1.1 request parse (request line + headers +
//! Content-Length body). Deliberately no axum/hyper: this only ever serves
//! canned responses for debugging, never a real application.
//!
//! Routing: rules are matched by method + path. `{param}` segments are
//! template parameters (e.g. `/users/{id}/posts/{postId}`). Rules carrying
//! request conditions (query/header/body) are tried first, then plain rules
//! with exact paths winning over templates; within each pass the first rule
//! in list order wins. Responses always carry permissive CORS headers so the
//! mock can be exercised from a browser too.
//!
//! Smart rules (`smart: true`) render `@token` placeholders in the body —
//! a Mock.js-flavoured subset (@cname/@email/@integer(...)/@date/…) — using
//! a dependency-free xorshift PRNG.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

/// Access log ring buffer size.
pub const MAX_LOG_ENTRIES: usize = 200;
const MAX_HEADER_BYTES: usize = 32 * 1024;
const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;
const MAX_DELAY_MS: u64 = 60_000;
const SUPPORTED_METHODS: [&str; 7] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/// One request-matching condition: every condition of a rule must pass for
/// the rule to win over condition-less rules. `source` is one of
/// `query` / `header` / `body`, `op` one of `eq` / `ne` / `exists` / `contains`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MockCondition {
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub op: String,
    #[serde(default)]
    pub value: String,
}

pub const CONDITION_SOURCES: [&str; 3] = ["query", "header", "body"];
pub const CONDITION_OPS: [&str; 4] = ["eq", "ne", "exists", "contains"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MockRule {
    #[serde(default)]
    pub id: String,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub status: u16,
    #[serde(default = "default_content_type")]
    pub content_type: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub delay_ms: u64,
    /// Render `@token` placeholders in the body before responding.
    #[serde(default)]
    pub smart: bool,
    /// Request conditions; a rule with conditions only matches when all pass.
    #[serde(default)]
    pub conditions: Vec<MockCondition>,
}

fn default_content_type() -> String {
    "application/json".into()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MockStartInfo {
    pub port: u16,
    pub started_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MockAccessLogEntry {
    pub at: u64,
    pub method: String,
    pub path: String,
    pub matched_id: Option<String>,
    pub status: u16,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MockStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub started_at: Option<u64>,
    pub requests_served: u64,
    pub log: Vec<MockAccessLogEntry>,
}

/// Everything the running server needs. Lives behind `AppState.mock`.
pub struct MockRuntime {
    pub running: bool,
    pub port: Option<u16>,
    pub started_at: Option<u64>,
    pub rules: Arc<Vec<MockRule>>,
    pub log: SharedLog,
    pub counter: Arc<AtomicU64>,
    pub shutdown: Option<Arc<Notify>>,
    pub handle: Option<JoinHandle<()>>,
}

impl Default for MockRuntime {
    fn default() -> Self {
        Self {
            running: false,
            port: None,
            started_at: None,
            rules: Arc::new(Vec::new()),
            log: Arc::new(Mutex::new(VecDeque::new())),
            counter: Arc::new(AtomicU64::new(0)),
            shutdown: None,
            handle: None,
        }
    }
}

pub type MockHandle = Arc<Mutex<MockRuntime>>;
pub type SharedLog = Arc<Mutex<VecDeque<MockAccessLogEntry>>>;

/// Start the server. Stops a previous instance first (one mock at a time).
pub async fn start(
    runtime: &MockHandle,
    port: u16,
    rules: Vec<MockRule>,
) -> Result<MockStartInfo, AppError> {
    for rule in &rules {
        if rule.method.trim().is_empty() || rule.path.trim().is_empty() {
            return Err(AppError::InvalidInput(
                "Mock 规则的 method 和 path 不能为空".into(),
            ));
        }
        if !(100..=599).contains(&rule.status) {
            return Err(AppError::InvalidInput(format!(
                "Mock 规则 {} 的 status 不合法: {}",
                rule.id, rule.status
            )));
        }
        for condition in &rule.conditions {
            if !CONDITION_SOURCES.contains(&condition.source.as_str()) {
                return Err(AppError::InvalidInput(format!(
                    "Mock 规则 {} 的条件 source 不合法: {}",
                    rule.id, condition.source
                )));
            }
            if !CONDITION_OPS.contains(&condition.op.as_str()) {
                return Err(AppError::InvalidInput(format!(
                    "Mock 规则 {} 的条件 op 不合法: {}",
                    rule.id, condition.op
                )));
            }
        }
    }

    stop(runtime).await;

    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|_| AppError::MockPortBusy(port))?;
    let bound_port = listener
        .local_addr()
        .map_err(|error| AppError::Internal(error.to_string()))?
        .port();

    let rules = Arc::new(rules);
    let log: SharedLog = Arc::new(Mutex::new(VecDeque::new()));
    let counter = Arc::new(AtomicU64::new(0));
    let shutdown = Arc::new(Notify::new());
    let handle = tokio::spawn(accept_loop(
        listener,
        Arc::clone(&rules),
        Arc::clone(&log),
        Arc::clone(&counter),
        Arc::clone(&shutdown),
    ));

    let started_at = now_ms();
    {
        let mut guard = runtime.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.running = true;
        guard.port = Some(bound_port);
        guard.started_at = Some(started_at);
        guard.rules = rules;
        guard.log = log;
        guard.counter = counter;
        guard.shutdown = Some(shutdown);
        guard.handle = Some(handle);
    }

    Ok(MockStartInfo {
        port: bound_port,
        started_at,
    })
}

/// Stop the server and clear all runtime state. Idempotent.
pub async fn stop(runtime: &MockHandle) {
    let shutdown_and_handle = {
        let mut guard = runtime.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        (guard.shutdown.take(), guard.handle.take())
    };
    if let Some(shutdown) = shutdown_and_handle.0 {
        shutdown.notify_one();
    }
    if let Some(handle) = shutdown_and_handle.1 {
        let _ = handle.await;
    }
    {
        let mut guard = runtime.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.running = false;
        guard.port = None;
        guard.started_at = None;
        *guard = MockRuntime::default();
    }
}

/// Snapshot the current status (no waiting, safe from a sync command).
pub fn status(runtime: &MockHandle) -> MockStatus {
    let guard = runtime.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    MockStatus {
        running: guard.running,
        port: guard.port,
        started_at: guard.started_at,
        requests_served: guard.counter.load(Ordering::Relaxed),
        log: guard
            .log
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .cloned()
            .collect(),
    }
}

async fn accept_loop(
    listener: TcpListener,
    rules: Arc<Vec<MockRule>>,
    log: SharedLog,
    counter: Arc<AtomicU64>,
    shutdown: Arc<Notify>,
) {
    loop {
        tokio::select! {
            _ = shutdown.notified() => break,
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        tokio::spawn(handle_connection(
                            stream,
                            Arc::clone(&rules),
                            Arc::clone(&log),
                            Arc::clone(&counter),
                        ));
                    }
                    Err(_) => break,
                }
            }
        }
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    rules: Arc<Vec<MockRule>>,
    log: SharedLog,
    counter: Arc<AtomicU64>,
) {
    let started = Instant::now();
    let (method, path, matched_id, status) = serve_one(&mut stream, &rules).await;

    counter.fetch_add(1, Ordering::Relaxed);
    let entry = MockAccessLogEntry {
        at: now_ms(),
        method,
        path,
        matched_id,
        status,
        duration_ms: started.elapsed().as_millis() as u64,
    };
    let mut log = log.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    log.push_back(entry);
    while log.len() > MAX_LOG_ENTRIES {
        log.pop_front();
    }
}

/// Request context kept around for condition matching: parsed query pairs,
/// lower-cased header pairs, and the raw body text.
pub(crate) struct RequestContext {
    query: Vec<(String, String)>,
    headers: Vec<(String, String)>,
    body: String,
}

/// Serve exactly one request, then let the connection close.
/// Returns `(method, path, matched_rule_id, status)` for the access log.
async fn serve_one(
    stream: &mut TcpStream,
    rules: &[MockRule],
) -> (String, String, Option<String>, u16) {
    let (method, target, content_length, headers) = match read_request_head(stream).await {
        Ok(parts) => parts,
        Err(()) => {
            let _ = write_response(stream, 400, "Bad Request", "text/plain", "无法解析请求").await;
            return ("-".into(), "-".into(), None, 400);
        }
    };

    let (clean_path, query) = split_query(&target);

    // Read (then discard) the body, bounded by MAX_BODY_BYTES. The text is
    // kept for body-condition matching.
    let mut body_bytes = Vec::with_capacity(content_length.min(MAX_BODY_BYTES));
    let mut remaining = content_length.min(MAX_BODY_BYTES);
    let mut buffer = [0u8; 8192];
    while remaining > 0 {
        match stream.read(&mut buffer).await {
            Ok(0) => break,
            Ok(n) => {
                body_bytes.extend_from_slice(&buffer[..n.min(remaining)]);
                remaining -= n.min(remaining);
            }
            Err(_) => break,
        }
    }
    let context = RequestContext {
        query,
        headers,
        body: String::from_utf8_lossy(&body_bytes).into_owned(),
    };

    let method_upper = method.to_ascii_uppercase();

    if !SUPPORTED_METHODS.contains(&method_upper.as_str()) {
        let _ = write_response(
            stream,
            405,
            "Method Not Allowed",
            "text/plain",
            "不支持的 HTTP 方法",
        )
        .await;
        return (method_upper, clean_path, None, 405);
    }

    match find_rule_ctx(rules, &method_upper, &clean_path, &context) {
        Some(rule) => {
            if rule.delay_ms > 0 {
                let delay = Duration::from_millis(rule.delay_ms.min(MAX_DELAY_MS));
                tokio::time::sleep(delay).await;
            }
            let mut body = rule.body.clone();
            // P0-5：先把请求上下文（method/path/query/header/body）注入
            // `{{request.*}}` 模板，再做 @token 智能渲染。
            body = render_context_body(&body, &method_upper, &clean_path, &context);
            if rule.smart {
                let mut prng = Prng::from_time();
                body = render_smart_body(&body, &mut prng);
            }
            let rendered = if method_upper == "HEAD" {
                String::new()
            } else {
                body
            };
            let _ = write_response(
                stream,
                rule.status,
                reason_phrase(rule.status),
                &rule.content_type,
                &rendered,
            )
            .await;
            (method_upper, clean_path, Some(rule.id.clone()), rule.status)
        }
        None => {
            let payload =
                serde_json::json!({ "code": "MOCK_NOT_FOUND", "path": clean_path }).to_string();
            let body = if method_upper == "HEAD" { "" } else { payload.as_str() };
            let _ = write_response(stream, 404, "Not Found", "application/json", body).await;
            (method_upper, clean_path, None, 404)
        }
    }
}

type RequestHead = (String, String, usize, Vec<(String, String)>);

async fn read_request_head(stream: &mut TcpStream) -> Result<RequestHead, ()> {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        if buffer.ends_with(b"\r\n\r\n") {
            break;
        }
        if buffer.len() > MAX_HEADER_BYTES {
            return Err(());
        }
        let n = stream.read(&mut chunk).await.map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        buffer.extend_from_slice(&chunk[..n]);
    }

    let head = String::from_utf8_lossy(&buffer);
    let request_line = head.lines().next().ok_or(())?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or(())?.to_string();
    let target = parts.next().ok_or(())?.to_string();

    // Keep the full request target; the query is split out later for
    // condition matching, not stripped here.
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in head.lines().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
    }

    let content_length = head
        .lines()
        .find_map(|line| {
            if line.to_ascii_lowercase().starts_with("content-length:") {
                line[15..].trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);

    Ok((method, target, content_length, headers))
}

/// Split `"/path?x=1&y=2"` into `("/path", [("x","1"),("y","2")])`.
/// Values are percent-decoded; malformed pairs are kept as-is.
fn split_query(target: &str) -> (String, Vec<(String, String)>) {
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path.to_string(), query),
        None => return (target.to_string(), Vec::new()),
    };
    let pairs = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((key, value)) => (percent_decode(key), percent_decode(value)),
            None => (percent_decode(pair), String::new()),
        })
        .collect();
    (path, pairs)
}

/// Minimal percent-decoding (`%XX` and `+` as space) for query matching.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' => {
                let hex = bytes.get(index + 1..index + 3);
                match hex.and_then(|hex| {
                    u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()
                }) {
                    Some(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    None => {
                        out.push(b'%');
                        index += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn write_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    body: &str,
) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS\r\n\
         Access-Control-Allow-Headers: *\r\n\
         Connection: close\r\n\
         \r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    if !body.is_empty() {
        stream.write_all(body.as_bytes()).await?;
    }
    stream.flush().await
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        418 => "I'm a teapot",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "",
    }
}

/// `/users/{id}/posts/{postId}` style matching: same number of segments, and
/// every non-parameter segment must be equal. Leading/trailing slashes and
/// empty segments are normalised away, so `/users/1` == `users/1`.
pub fn path_matches(pattern: &str, path: &str) -> bool {
    let pattern_segments: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    let path_segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if pattern_segments.len() != path_segments.len() {
        return false;
    }
    pattern_segments
        .iter()
        .zip(path_segments)
        .all(|(pattern, segment)| {
            (pattern.starts_with('{')
                && pattern.ends_with('}')
                && pattern.len() > 2)
                || *pattern == segment
        })
}

/// Exact rules first, then templates, each in list order. Rules carrying
/// request conditions are excluded — they are only matched by
/// [`find_rule_ctx`] when their conditions pass.
pub fn find_rule<'a>(rules: &'a [MockRule], method: &str, path: &str) -> Option<&'a MockRule> {
    rules
        .iter()
        .find(|rule| {
            rule.conditions.is_empty()
                && rule.method.eq_ignore_ascii_case(method)
                && !rule.path.contains('{')
                && path_matches(&rule.path, path)
        })
        .or_else(|| {
            rules.iter().find(|rule| {
                rule.conditions.is_empty()
                    && rule.method.eq_ignore_ascii_case(method)
                    && rule.path.contains('{')
                    && path_matches(&rule.path, path)
            })
        })
}

/// Rules with request conditions are tried first (all conditions must pass,
/// list order), then plain rules via the exact-then-template [`find_rule`].
pub(crate) fn find_rule_ctx<'a>(
    rules: &'a [MockRule],
    method: &str,
    path: &str,
    context: &RequestContext,
) -> Option<&'a MockRule> {
    rules
        .iter()
        .find(|rule| {
            !rule.conditions.is_empty()
                && rule.method.eq_ignore_ascii_case(method)
                && path_matches(&rule.path, path)
                && conditions_match(&rule.conditions, context)
        })
        .or_else(|| find_rule(rules, method, path))
}

/// Every condition must pass. `query`/`header` look up `key` directly;
/// `body` navigates the request body as JSON via a dotted path
/// (`user.name`, optional leading `$.`). Missing values fail `eq`/`contains`
/// and pass `ne` (a missing value is trivially "not equal").
pub(crate) fn conditions_match(conditions: &[MockCondition], context: &RequestContext) -> bool {
    conditions.iter().all(|condition| {
        let actual = lookup_value(condition, context);
        match condition.op.as_str() {
            "exists" => actual.is_some(),
            "ne" => actual.as_deref() != Some(condition.value.as_str()),
            "eq" => actual.as_deref() == Some(condition.value.as_str()),
            "contains" => actual
                .as_deref()
                .map(|value| value.contains(&condition.value))
                .unwrap_or(false),
            _ => false,
        }
    })
}

fn lookup_value(condition: &MockCondition, context: &RequestContext) -> Option<String> {
    match condition.source.as_str() {
        "query" => context
            .query
            .iter()
            .find(|(key, _)| *key == condition.key)
            .map(|(_, value)| value.clone()),
        "header" => context
            .headers
            .iter()
            .find(|(name, _)| name == &condition.key.to_ascii_lowercase())
            .map(|(_, value)| value.clone()),
        "body" => body_path_lookup(&context.body, &condition.key),
        _ => None,
    }
}

/// Navigate JSON text by a dotted path. Objects are indexed by key; array
/// indices via `items.0.name` style numeric segments. Returns the value's
/// string form (scalars verbatim, structures as JSON text).
fn body_path_lookup(body: &str, key: &str) -> Option<String> {
    let trimmed = key.trim();
    let trimmed = trimmed.strip_prefix("$.").unwrap_or(trimmed);
    if trimmed.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let mut current = &value;
    for segment in trimmed.split('.') {
        current = match current {
            serde_json::Value::Object(map) => map.get(segment)?,
            serde_json::Value::Array(items) => {
                let index: usize = segment.parse().ok()?;
                items.get(index)?
            }
            _ => return None,
        };
    }
    Some(match current {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Null => "null".to_string(),
        other => other.to_string(),
    })
}

fn now_ms() -> u64 {
    crate::time::now_millis()
}

// ----------------------------------------------------- Smart rendering ----

/// Renders `{{request.*}}` context placeholders in a rule body (P0-5).
/// Supported keys: `request.method`, `request.path`, `request.query.<name>`,
/// `request.header.<name>`, `request.body.<dotted.json.path>`. Unknown keys
/// render as empty strings; everything else is left untouched (so `{{var}}`
/// template syntax used elsewhere keeps working after this pass).
fn render_context_body(
    body: &str,
    method: &str,
    path: &str,
    context: &RequestContext,
) -> String {
    if !body.contains("{{request.") {
        return body.to_string();
    }
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(start) = rest.find("{{request.") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end) => {
                let key = after[..end].trim();
                out.push_str(&lookup_request_key(key, method, path, context));
                rest = &after[end + 2..];
            }
            None => {
                out.push_str("{{");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn lookup_request_key(
    key: &str,
    method: &str,
    path: &str,
    context: &RequestContext,
) -> String {
    let tail = match key.strip_prefix("request.") {
        Some(tail) => tail,
        None => return String::new(),
    };
    if tail == "method" {
        return method.to_string();
    }
    if tail == "path" {
        return path.to_string();
    }
    if let Some(name) = tail.strip_prefix("query.") {
        if !name.is_empty() {
            return context
                .query
                .iter()
                .find(|(candidate, _)| candidate.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.clone())
                .unwrap_or_default();
        }
        return String::new();
    }
    if let Some(name) = tail.strip_prefix("header.") {
        if !name.is_empty() {
            return context
                .headers
                .iter()
                .find(|(candidate, _)| candidate.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.clone())
                .unwrap_or_default();
        }
        return String::new();
    }
    if let Some(json_path) = tail.strip_prefix("body.") {
        if !json_path.is_empty() {
            return body_path_lookup(&context.body, json_path).unwrap_or_default();
        }
    }
    String::new()
}

/// Global sequence source for `@increment` — persists across requests so the
/// generated values behave like a monotonic id sequence.
static INCREMENT: AtomicU64 = AtomicU64::new(0);

/// Dependency-free xorshift* PRNG seeded from wall-clock nanoseconds.
/// Good enough for mock data; nothing security-sensitive relies on it.
pub(crate) struct Prng {
    state: u64,
}

impl Prng {
    pub(crate) fn from_time() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.subsec_nanos() as u64 ^ duration.as_secs())
            .unwrap_or(0x9E3779B97F4A7C15);
        Self {
            state: nanos | 1, // never zero: xorshift collapses to 0
        }
    }

    fn next_u64(&mut self) -> u64 {
        let mut state = self.state;
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        self.state = state;
        state
    }

    /// Inclusive integer in `[min, max]`.
    pub(crate) fn range(&mut self, min: i64, max: i64) -> i64 {
        if max <= min {
            return min;
        }
        let span = (max - min + 1) as u64;
        min + (self.next_u64() % span) as i64
    }

    pub(crate) fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        let index = self.range(0, items.len() as i64 - 1) as usize;
        &items[index]
    }

    pub(crate) fn digits(&mut self, count: usize) -> String {
        (0..count)
            .map(|_| char::from(b'0' + self.range(0, 9) as u8))
            .collect()
    }
}

/// A generated token value, typed so a whole-string token can replace the
/// quoted JSON string with a bare number/boolean literal.
pub(crate) enum SmartVal {
    S(String),
    N(i64, u32), // (value, decimal places)
    B(bool),
}

impl SmartVal {
    /// JSON literal representation (used when the token spans a whole value).
    fn json_literal(&self) -> String {
        match self {
            SmartVal::S(text) => format!("\"{}\"", json_escape(text)),
            SmartVal::N(value, places) => {
                if *places == 0 {
                    value.to_string()
                } else {
                    format!("{:.width$}", *value as f64 / 10f64.powi(*places as i32), width = *places as usize)
                }
            }
            SmartVal::B(flag) => flag.to_string(),
        }
    }

    /// Plain-text representation (used for tokens inside larger strings).
    pub(crate) fn text(&self) -> String {
        match self {
            SmartVal::S(text) => text.clone(),
            SmartVal::N(value, places) => {
                if *places == 0 {
                    value.to_string()
                } else {
                    format!("{:.width$}", *value as f64 / 10f64.powi(*places as i32), width = *places as usize)
                }
            }
            SmartVal::B(flag) => flag.to_string(),
        }
    }
}

fn json_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => out.push(other),
        }
    }
    out
}

/// Render `@token` placeholders in a rule body.
///
/// 1. Pass over quoted JSON strings: a string that is exactly one token
///    (`"@integer(1,5)"`) becomes a typed JSON literal (number/boolean
///    unquoted); strings containing tokens inline get substring replacement.
/// 2. A final pass replaces tokens in unquoted text (plain-text bodies).
/// Unknown tokens are left untouched, so literal emails like
/// `user@example.com` survive.
pub(crate) fn render_smart_body(body: &str, prng: &mut Prng) -> String {
    let characters: Vec<char> = body.chars().collect();
    let mut out = String::with_capacity(body.len() + 64);
    let mut index = 0;
    while index < characters.len() {
        if characters[index] == '"' {
            let mut cursor = index + 1;
            let mut inner = String::new();
            let mut closed = false;
            while cursor < characters.len() {
                if characters[cursor] == '\\' && cursor + 1 < characters.len() {
                    inner.push(characters[cursor]);
                    inner.push(characters[cursor + 1]);
                    cursor += 2;
                    continue;
                }
                if characters[cursor] == '"' {
                    closed = true;
                    break;
                }
                inner.push(characters[cursor]);
                cursor += 1;
            }
            if !closed {
                out.push('"');
                index += 1;
                continue;
            }
            match single_token(&inner, prng) {
                Some(value) => out.push_str(&value.json_literal()),
                None => {
                    out.push('"');
                    out.push_str(&substitute_tokens(&inner, prng));
                    out.push('"');
                }
            }
            index = cursor + 1;
        } else {
            out.push(characters[index]);
            index += 1;
        }
    }
    substitute_tokens(&out, prng)
}

/// If `text` is exactly one token (`@name` or `@name(args)`), evaluate it.
fn single_token(text: &str, prng: &mut Prng) -> Option<SmartVal> {
    let trimmed = text.trim();
    let (name, args) = parse_token(trimmed)?;
    // Ensure nothing trails after the token (`@cname 张三` is not single).
    let consumed = name.len() + args.as_ref().map(|a| a.len() + 2).unwrap_or(0);
    if trimmed.len() != 1 + consumed {
        return None;
    }
    eval_token(&name, args.as_deref(), prng)
}

/// Split `"@name(args)"` into `("name", Some("args"))`. `None` when the text
/// does not start with a token-shaped prefix.
fn parse_token(text: &str) -> Option<(String, Option<String>)> {
    let rest = text.strip_prefix('@')?;
    let name_len = rest.chars().take_while(|c| c.is_ascii_alphabetic()).count();
    if name_len == 0 {
        return None;
    }
    let name = rest[..name_len].to_string();
    let after = &rest[name_len..];
    if let Some(args_text) = after.strip_prefix('(') {
        let end = args_text.find(')')?;
        Some((name, Some(args_text[..end].to_string())))
    } else {
        Some((name, None))
    }
}

/// Replace every known `@token` inside `text` with generated data.
fn substitute_tokens(text: &str, prng: &mut Prng) -> String {
    if !text.contains('@') {
        return text.to_string();
    }
    let characters: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 32);
    let mut index = 0;
    while index < characters.len() {
        if characters[index] == '@' {
            // Keep the '@' in the slice: parse_token strips it itself.
            let rest: String = characters[index..].iter().collect();
            if let Some((name, args)) = parse_token(&rest) {
                if let Some(value) = eval_token(&name, args.as_deref(), prng) {
                    out.push_str(&value.text());
                    let consumed = 1 + name.len() + args.map(|a| a.len() + 2).unwrap_or(0);
                    index += consumed;
                    continue;
                }
            }
            out.push('@');
            index += 1;
        } else {
            out.push(characters[index]);
            index += 1;
        }
    }
    out
}

fn arg_numbers(args: Option<&str>) -> Vec<i64> {
    args.unwrap_or_default()
        .split(',')
        .filter_map(|part| part.trim().parse::<i64>().ok())
        .collect()
}

/// Evaluate one Mock.js-subset token. `None` = unknown token, keep as-is.
/// Shared with `service::dynamic` for `{{$token}}` request variables.
pub(crate) fn eval_token(name: &str, args: Option<&str>, prng: &mut Prng) -> Option<SmartVal> {
    let numbers = || arg_numbers(args);
    Some(match name {
        "cname" => SmartVal::S(format!(
            "{}{}",
            prng.pick(SURNAMES),
            prng.pick(GIVEN_NAMES)
        )),
        "name" => SmartVal::S(format!(
            "{} {}",
            prng.pick(EN_FIRST_NAMES),
            prng.pick(EN_LAST_NAMES)
        )),
        "email" => SmartVal::S(format!(
            "{}{}@{}",
            prng.pick(EN_FIRST_NAMES).to_ascii_lowercase(),
            prng.pick(EN_LAST_NAMES).to_ascii_lowercase(),
            prng.pick(EMAIL_DOMAINS)
        )),
        "phone" => SmartVal::S(format!(
            "1{}{}",
            prng.pick(PHONE_PREFIXES),
            prng.digits(9)
        )),
        "idcard" => SmartVal::S(generate_idcard(prng)),
        "integer" => {
            let numbers = numbers();
            let (min, max) = match numbers.as_slice() {
                [min] => (*min, *min),
                [min, max, ..] => (*min, *max),
                _ => (0, 100),
            };
            SmartVal::N(prng.range(min, max), 0)
        }
        "float" => {
            let numbers = numbers();
            let (min, max) = match numbers.as_slice() {
                [min] => (*min, *min),
                [min, max, ..] => (*min, *max),
                _ => (0, 100),
            };
            // Two decimal places: scale the range so @float(0,100) spans 0.00–100.00.
            let span = (max - min).max(0) * 100;
            SmartVal::N(min * 100 + prng.range(0, span), 2)
        }
        "boolean" => SmartVal::B(prng.range(0, 1) == 1),
        "guid" => SmartVal::S(generate_guid(prng)),
        "url" => SmartVal::S(format!(
            "https://{}.{}.{}/{}",
            prng.pick(URL_SUBDOMAINS),
            prng.pick(EN_LAST_NAMES).to_ascii_lowercase(),
            prng.pick(URL_TLDS),
            prng.pick(URL_PATHS)
        )),
        "ip" => SmartVal::S(format!(
            "{}.{}.{}.{}",
            prng.range(1, 255),
            prng.range(0, 255),
            prng.range(0, 255),
            prng.range(1, 254)
        )),
        "date" => SmartVal::S(format_date(random_date(prng), '-')),
        "datetime" => SmartVal::S(format!(
            "{} {}",
            format_date(random_date(prng), '-'),
            format_time(prng)
        )),
        "time" => SmartVal::S(format_time(prng)),
        "province" => SmartVal::S((*prng.pick(PROVINCES)).to_string()),
        "city" => SmartVal::S((*prng.pick(CITIES)).to_string()),
        "ctitle" => {
            let count = match numbers().as_slice() {
                [min, max, ..] => prng.range(*min, *max).clamp(1, 8) as usize,
                [exact] => (*exact).clamp(1, 8) as usize,
                _ => prng.range(2, 4) as usize,
            };
            let mut title = String::new();
            for _ in 0..count {
                let word = prng.pick(C_WORDS);
                title.push_str(word);
            }
            SmartVal::S(title)
        }
        "cparagraph" => {
            let count = match numbers().as_slice() {
                [min, max, ..] => prng.range(*min, *max).clamp(1, 6) as usize,
                [exact] => (*exact).clamp(1, 6) as usize,
                _ => prng.range(1, 3) as usize,
            };
            let sentences: Vec<&str> = (0..count)
                .map(|_| {
                    let sentence = prng.pick(C_SENTENCES);
                    sentence.trim_end_matches('。')
                })
                .collect();
            SmartVal::S(format!("{}。", sentences.join("。")))
        }
        "string" => {
            let count = numbers().first().copied().unwrap_or(8).clamp(1, 64) as usize;
            let letters: Vec<char> = ('a'..='z').chain('A'..='Z').collect();
            let generated: String = (0..count)
                .map(|_| letters[prng.range(0, letters.len() as i64 - 1) as usize])
                .collect();
            SmartVal::S(generated)
        }
        "increment" => {
            let step = numbers().first().copied().unwrap_or(1).max(1) as u64;
            SmartVal::N(INCREMENT.fetch_add(step, Ordering::Relaxed) as i64, 0)
        }
        // Postman-style tokens live in their own module; keeping them here
        // would bury the request-variable catalogue in the mock server code.
        other => return super::postman::eval(other, args, prng),
    })
}

fn random_date(prng: &mut Prng) -> i64 {
    let today = (now_ms() / 86_400_000) as i64;
    today + prng.range(-365, 365)
}

/// Days-since-epoch → `y{sep}m{sep}d` (Howard Hinnant's civil_from_days).
pub(crate) fn format_date(days: i64, separator: char) -> String {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{:04}{}{:02}{}{:02}",
        year, separator, month, separator, day
    )
}

fn format_time(prng: &mut Prng) -> String {
    format!(
        "{:02}:{:02}:{:02}",
        prng.range(0, 23),
        prng.range(0, 59),
        prng.range(0, 59)
    )
}

fn generate_guid(prng: &mut Prng) -> String {
    let hex = "0123456789abcdef";
    let mut guid = String::with_capacity(36);
    for position in 0..36 {
        match position {
            8 | 13 | 18 | 23 => guid.push('-'),
            14 => guid.push('4'), // version 4
            19 => guid.push(['8', '9', 'a', 'b'][prng.range(0, 3) as usize]), // variant
            _ => {
                let index = prng.range(0, 15) as usize;
                guid.push(hex[index..=index].chars().next().unwrap_or('0'));
            }
        }
    }
    guid
}

fn generate_idcard(prng: &mut Prng) -> String {
    let area = prng.pick(ID_AREAS);
    let year = prng.range(1960, 2005);
    let month = prng.range(1, 12);
    let day = prng.range(1, 28);
    let sequence = prng.digits(3);
    let base = format!("{area}{year:04}{month:02}{day:02}{sequence}");
    let weights = [7usize, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    let checksum_chars = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
    let sum: usize = base
        .chars()
        .zip(weights)
        .map(|(digit, weight)| digit.to_digit(10).unwrap_or(0) as usize * weight)
        .sum();
    format!("{base}{}", checksum_chars[sum % 11])
}

const SURNAMES: &[&str] = &[
    "赵", "钱", "孙", "李", "周", "吴", "郑", "王", "冯", "陈", "蒋", "沈", "韩", "杨", "朱", "秦",
    "许", "何", "张", "孔", "曹", "严", "刘", "关", "马", "林", "徐", "黄", "高", "谢", "宋", "唐",
    "罗", "梁", "魏", "郭",
];
const GIVEN_NAMES: &[&str] = &[
    "伟", "芳", "娜", "敏", "静", "磊", "军", "洋", "勇", "艳", "杰", "涛", "明", "超", "秀英",
    "建国", "桂花", "晓明", "志强", "美玲", "雪", "晨", "浩", "宇", "欣怡", "子轩", "雨桐", "梓豪",
    "一诺", "思远",
];
const EN_FIRST_NAMES: &[&str] = &[
    "James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda", "David",
    "Elizabeth", "William", "Susan", "Richard", "Jessica", "Thomas", "Sarah",
];
const EN_LAST_NAMES: &[&str] = &[
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Wilson",
    "Anderson", "Taylor", "Thomas", "Moore", "Martin", "Lee",
];
const EMAIL_DOMAINS: &[&str] = &[
    "example.com", "example.org", "test.com", "demo.cn", "mock.io", "mail.com",
];
const PHONE_PREFIXES: &[&str] = &["3", "4", "5", "6", "7", "8", "9"];
const ID_AREAS: &[&str] = &[
    "110101", "310104", "440305", "330102", "320105", "510107", "420106", "371002", "350203",
    "610103",
];
const URL_SUBDOMAINS: &[&str] = &["api", "www", "cdn", "app", "demo"];
const URL_TLDS: &[&str] = &["com", "cn", "org", "io", "net"];
const URL_PATHS: &[&str] = &[
    "users", "posts", "orders", "items", "api/v1/data", "profile", "articles", "search",
];
const PROVINCES: &[&str] = &[
    "北京市", "上海市", "广东省", "浙江省", "江苏省", "四川省", "湖北省", "湖南省", "山东省", "河南省",
    "福建省", "陕西省",
];
const CITIES: &[&str] = &[
    "北京市", "上海市", "广州市", "深圳市", "杭州市", "成都市", "武汉市", "南京市", "西安市", "重庆市",
    "苏州市", "厦门市", "长沙市", "青岛市", "郑州市",
];
const C_WORDS: &[&str] = &[
    "数据", "接口", "平台", "系统", "设计", "开发", "测试", "管理", "服务", "架构", "性能", "安全",
    "智能", "云端", "网络", "分析", "优化", "实践", "指南", "入门",
];
const C_SENTENCES: &[&str] = &[
    "这是一个用于测试的句子。",
    "接口返回了预期的数据结构。",
    "系统在高并发下依然保持稳定。",
    "我们使用自动化测试保障质量。",
    "这份文档描述了服务的核心能力。",
    "数据同步任务在凌晨按时完成。",
];

#[cfg(test)]
#[path = "mock/tests.rs"]
mod tests;
