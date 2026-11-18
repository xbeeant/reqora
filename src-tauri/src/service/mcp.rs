//! MCP (Model Context Protocol) client — lets Reqora talk to MCP servers
//! and invoke their tools.
//!
//! Two transports are supported:
//! - `stdio`: the server is spawned as a child process; JSON-RPC messages are
//!   exchanged as newline-delimited JSON over stdin/stdout.
//! - `http`: Streamable HTTP — each request is a POST carrying one JSON-RPC
//!   message; the response body is either plain JSON or an SSE stream whose
//!   `data:` lines carry the reply. The optional `Mcp-Session-Id` response
//!   header is captured and replayed on subsequent calls.
//!
//! The manager keeps live connections per user-chosen server name; tools are
//! discovered via `tools/list` right after connect and invoked via `tools/call`.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

/// Protocol version advertised during the `initialize` handshake.
pub const PROTOCOL_VERSION: &str = "2024-11-05";
/// How long the whole connect handshake may take (spawn + init + tools/list).
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Tool calls can legitimately run long (scrapers, LLM-backed tools...).
pub const CALL_TIMEOUT: Duration = Duration::from_secs(120);

/// Connection settings for one MCP server (persisted in the workspace).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct McpServerConfig {
    pub name: String,
    /// "stdio" or "http".
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

/// One tool advertised by the server.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectResult {
    pub server_info: String,
    pub tools: Vec<McpTool>,
}

/// One content block of a tool result (text blocks carry their text; other
/// block kinds get a placeholder so nothing silently disappears).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpContent {
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallOutcome {
    pub is_error: bool,
    pub content: Vec<McpContent>,
    /// Concatenated text of all blocks; what the UI shows by default.
    pub text: String,
}

enum McpClient {
    Stdio(Box<StdioClient>),
    Http(Box<HttpClient>),
}

impl McpClient {
    async fn open(config: &McpServerConfig) -> Result<Self, String> {
        match config.transport.as_str() {
            "stdio" => Ok(Self::Stdio(Box::new(StdioClient::spawn(config).await?))),
            "http" => Ok(Self::Http(Box::new(HttpClient::new(config)?))),
            other => Err(format!("不支持的传输类型：{other}")),
        }
    }

    async fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        match self {
            Self::Stdio(inner) => inner.request(method, params, timeout).await,
            Self::Http(inner) => inner.request(method, params, timeout).await,
        }
    }

    async fn notify(&mut self, method: &str) -> Result<(), String> {
        match self {
            Self::Stdio(inner) => inner.notify(method).await,
            Self::Http(inner) => inner.notify(method).await,
        }
    }

    async fn shutdown(&mut self) {
        if let Self::Stdio(inner) = self {
            let _ = inner.child.kill().await;
        }
    }
}

/// A live stdio connection. stdin/stdout are taken out of the child so they can
/// be used independently; the child is kept around so disconnect can kill it.
struct StdioClient {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
    next_id: u64,
}

impl StdioClient {
    async fn spawn(config: &McpServerConfig) -> Result<Self, String> {
        if config.command.trim().is_empty() {
            return Err("stdio 服务器必须填写启动命令".into());
        }
        let mut cmd = tokio::process::Command::new(config.command.trim());
        cmd.args(&config.args)
            .envs(&config.env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            // Server-side logs go to /dev/null; they are not surfaced anywhere.
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| format!("启动命令失败：{e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法取得子进程 stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法取得子进程 stdout".to_string())?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 0,
        })
    }

    /// Send one request and wait for the reply with the matching id.
    /// Lines without a matching id (notifications, stray logs) are skipped; the
    /// whole read is bounded by `timeout`.
    async fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let line = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let payload = format!("{line}\n");
        self.stdin
            .write_all(payload.as_bytes())
            .await
            .map_err(|e| format!("写入 stdin 失败：{e}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("写入 stdin 失败：{e}"))?;

        let mut buf = String::new();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            buf.clear();
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(format!("{method} 响应超时"));
            }
            let n = tokio::time::timeout(remaining, self.stdout.read_line(&mut buf))
                .await
                .map_err(|_| format!("{method} 响应超时"))?
                .map_err(|e| format!("读取 stdout 失败：{e}"))?;
            if n == 0 {
                return Err(format!("{method}：服务器已退出"));
            }
            let trimmed = buf.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
                continue; // Not JSON (stray server log) — skip.
            };
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            return decode_reply(&message, method);
        }
    }

    async fn notify(&mut self, method: &str) -> Result<(), String> {
        let line = json!({"jsonrpc": "2.0", "method": method});
        let payload = format!("{line}\n");
        self.stdin
            .write_all(payload.as_bytes())
            .await
            .map_err(|e| format!("写入 stdin 失败：{e}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("写入 stdin 失败：{e}"))?;
        Ok(())
    }
}

/// A Streamable HTTP connection (base URL + optional session id).
struct HttpClient {
    url: String,
    headers: BTreeMap<String, String>,
    session_id: Option<String>,
    next_id: u64,
    client: reqwest::Client,
}

impl HttpClient {
    fn new(config: &McpServerConfig) -> Result<Self, String> {
        if config.url.trim().is_empty() {
            return Err("HTTP 服务器必须填写 URL".into());
        }
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;
        Ok(Self {
            url: config.url.trim().to_string(),
            headers: config.headers.clone(),
            session_id: None,
            next_id: 0,
            client,
        })
    }

    async fn post(&self, body: &Value) -> Result<reqwest::Response, String> {
        let mut request = self
            .client
            .post(&self.url)
            .header("Content-Type", "application/json")
            // Streamable HTTP servers may answer either way; ask for both.
            .header("Accept", "application/json, text/event-stream");
        if let Some(session) = &self.session_id {
            request = request.header("Mcp-Session-Id", session);
        }
        for (key, value) in &self.headers {
            request = request.header(key, value);
        }
        let body_text = serde_json::to_string(body).map_err(|e| format!("序列化请求失败：{e}"))?;
        request.body(body_text).send().await.map_err(|e| format!("请求失败：{e}"))
    }

    async fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let body = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let response = tokio::time::timeout(timeout, self.post(&body))
            .await
            .map_err(|_| format!("{method} 响应超时"))??;
        if let Some(session) = response.headers().get("mcp-session-id") {
            if let Ok(value) = session.to_str() {
                self.session_id = Some(value.to_string());
            }
        }
        let status = response.status();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let text = response
            .text()
            .await
            .map_err(|e| format!("读取响应失败：{e}"))?;
        if !status.is_success() {
            return Err(format!("{method}：HTTP {status}"));
        }
        if content_type.contains("text/event-stream") {
            let value = extract_sse_json_response(&text, id)
                .ok_or_else(|| format!("{method}：SSE 流中没有匹配的响应"))?;
            return decode_reply(&value, method);
        }
        let Ok(message) = serde_json::from_str::<Value>(&text) else {
            return Err(format!("{method}：响应不是合法 JSON"));
        };
        decode_reply(&message, method)
    }

    async fn notify(&self, method: &str) -> Result<(), String> {
        let body = json!({"jsonrpc": "2.0", "method": method});
        // Notifications get no reply; accept any 2xx (202 included).
        let response = self.post(&body).await?;
        if !response.status().is_success() {
            return Err(format!("{method}：HTTP {}", response.status()));
        }
        Ok(())
    }
}

/// Pull the `result` (or fail on `error`) out of a JSON-RPC reply.
fn decode_reply(message: &Value, method: &str) -> Result<Value, String> {
    if let Some(error) = message.get("error") {
        let text = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        return Err(format!("{method}：{text}"));
    }
    message
        .get("result")
        .cloned()
        .ok_or_else(|| format!("{method}：响应缺少 result"))
}

/// Scan an SSE body and return the JSON-RPC reply whose `id` matches.
/// Falls back to the first `data:` line carrying a `result`, so servers that
/// answer with a bare push notification still work.
fn extract_sse_json_response(body: &str, id: u64) -> Option<Value> {
    let mut fallback = None;
    for line in body.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        match message.get("id").and_then(Value::as_u64) {
            Some(matched) if matched == id => return Some(message),
            _ => {
                if message.get("result").is_some() && fallback.is_none() {
                    fallback = Some(message);
                }
            }
        }
    }
    fallback
}

/// Turn an MCP `tools/call` result into the shape the UI renders.
fn decode_call_result(result: &Value) -> McpCallOutcome {
    let is_error = result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut content = Vec::new();
    let mut text = String::new();
    if let Some(blocks) = result.get("content").and_then(Value::as_array) {
        for block in blocks {
            let kind = block
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let block_text = match block.get("text").and_then(Value::as_str) {
                Some(text) => text.to_string(),
                None => format!("[不支持的内容类型：{kind}]"),
            };
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&block_text);
            content.push(McpContent { kind, text: block_text });
        }
    }
    McpCallOutcome { is_error, content, text }
}

/// Run the standard handshake over any transport:
/// initialize → notifications/initialized → tools/list.
async fn handshake(client: &mut McpClient) -> Result<McpConnectResult, String> {
    let init = client
        .request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "Reqora", "version": env!("CARGO_PKG_VERSION")},
            }),
            CONNECT_TIMEOUT,
        )
        .await?;
    let server_info = init
        .pointer("/serverInfo/name")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    client.notify("notifications/initialized").await?;
    let tools_reply = client
        .request("tools/list", json!({"limit": 200}), CONNECT_TIMEOUT)
        .await?;
    let mut tools = Vec::new();
    if let Some(entries) = tools_reply.get("tools").and_then(Value::as_array) {
        for entry in entries {
            let Some(name) = entry.get("name").and_then(Value::as_str) else {
                continue;
            };
            tools.push(McpTool {
                name: name.to_string(),
                description: entry
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                input_schema: entry.get("inputSchema").cloned().unwrap_or(Value::Null),
            });
        }
    }
    Ok(McpConnectResult { server_info, tools })
}

/// Live connections keyed by user-chosen server name.
///
/// Each client sits behind its own `Arc<Mutex<_>>`. The map lock is only held
/// for lookup/insert; a `tools/call` can block for up to [`CALL_TIMEOUT`], so
/// holding the map lock across that `await` would stall every *other* server
/// (head-of-line blocking). Per-connection locks let unrelated servers run
/// concurrently while still serialising calls on the same stdio child.
#[derive(Default)]
pub struct McpManager {
    clients: Mutex<HashMap<String, Arc<Mutex<McpClient>>>>,
}

impl McpManager {
    /// Open a connection, run the handshake, and keep it under `config.name`.
    /// A connection with the same name is replaced. On handshake failure the
    /// dead transport is dropped so the next attempt starts clean.
    pub async fn connect(&self, config: &McpServerConfig) -> Result<McpConnectResult, String> {
        let name = config.name.trim().to_string();
        if name.is_empty() {
            return Err("服务器名称不能为空".into());
        }
        // No map lock during spawn/handshake — those awaits can be slow.
        let mut client = McpClient::open(config).await?;
        let result = handshake(&mut client).await;
        let previous = {
            let mut clients = self.clients.lock().await;
            match result {
                Ok(_) => clients.insert(name.clone(), Arc::new(Mutex::new(client))),
                Err(_) => None,
            }
        };
        // Shut the replaced connection down after releasing the map lock.
        if let Some(previous) = previous {
            previous.lock().await.shutdown().await;
        }
        result
    }

    /// Kill and forget a connection. Returns true when one existed.
    pub async fn disconnect(&self, name: &str) -> bool {
        let previous = self.clients.lock().await.remove(name);
        if let Some(client) = previous {
            // Per-client lock, map lock already released.
            client.lock().await.shutdown().await;
            true
        } else {
            false
        }
    }

    pub async fn call(&self, name: &str, tool: &str, arguments: Value) -> Result<McpCallOutcome, String> {
        // Clone the Arc under the map lock, then release it before the (up to
        // 120s) request — other servers stay responsive meanwhile.
        let client = {
            let clients = self.clients.lock().await;
            clients
                .get(name)
                .cloned()
                .ok_or_else(|| format!("服务器 {name} 未连接"))?
        };
        let result = client
            .lock()
            .await
            .request(
                "tools/call",
                json!({"name": tool, "arguments": arguments}),
                CALL_TIMEOUT,
            )
            .await?;
        Ok(decode_call_result(&result))
    }

    /// Sorted names of live connections. No UI caller yet; useful for a future
    /// "list servers" command and for connection-lifecycle tests.
    #[allow(dead_code)]
    pub async fn connected_names(&self) -> Vec<String> {
        let clients = self.clients.lock().await;
        let mut names: Vec<String> = clients.keys().cloned().collect();
        names.sort();
        names
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_response_extraction_matches_id() {
        let body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"ok\":true}}\n\n";
        let message = extract_sse_json_response(body, 7).expect("should find reply");
        assert_eq!(message.pointer("/result/ok"), Some(&Value::Bool(true)));
        // No other reply exists — the single-result fallback still returns it.
        assert!(extract_sse_json_response(body, 8).is_some());
    }

    #[test]
    fn sse_response_extraction_falls_back_to_first_result() {
        let body = "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"error\":{\"code\":-1,\"message\":\"nope\"}}\n";
        // No id match, but a result-carrying line exists: the fallback returns it.
        let fallback = extract_sse_json_response(body, 9).expect("fallback returns first result");
        assert_eq!(fallback.pointer("/id"), Some(&Value::from(1)));
        let message = extract_sse_json_response(body, 2).expect("matches id 2");
        assert!(message.get("error").is_some());
    }

    #[test]
    fn sse_response_extraction_skips_noise() {
        let body = ": keep-alive comment\ndata: [DONE]\ndata: not json\ndata: {\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"n\":1}}\n";
        let message = extract_sse_json_response(body, 3).expect("skips noise lines");
        assert_eq!(message.pointer("/result/n"), Some(&Value::from(1)));
    }

    #[test]
    fn call_result_concatenates_text_blocks() {
        let result = json!({
            "isError": false,
            "content": [
                {"type": "text", "text": "hello"},
                {"type": "image", "data": "..."},
                {"type": "text", "text": "world"},
            ],
        });
        let outcome = decode_call_result(&result);
        assert!(!outcome.is_error);
        assert_eq!(outcome.text, "hello\n[不支持的内容类型：image]\nworld");
        assert_eq!(outcome.content.len(), 3);
    }

    #[test]
    fn call_result_marks_errors_and_empty_content() {
        let outcome = decode_call_result(&json!({"isError": true, "content": [{"type": "text", "text": "boom"}]}));
        assert!(outcome.is_error);
        assert_eq!(outcome.text, "boom");

        let outcome = decode_call_result(&json!({}));
        assert!(!outcome.is_error);
        assert!(outcome.text.is_empty());
    }

    #[test]
    fn decode_reply_maps_jsonrpc_errors() {
        let message = json!({"jsonrpc": "2.0", "id": 1, "error": {"code": -32601, "message": "method not found"}});
        let error = decode_reply(&message, "tools/call").unwrap_err();
        assert!(error.contains("method not found"));

        let message = json!({"jsonrpc": "2.0", "id": 1, "result": {"ok": 1}});
        assert_eq!(decode_reply(&message, "x").unwrap().pointer("/ok"), Some(&Value::from(1)));
    }

    #[test]
    fn server_config_survives_camel_case_roundtrip() {
        let config: McpServerConfig = serde_json::from_str(
            r#"{"name":"n","transport":"http","url":"http://x/mcp","args":["a"],"env":{"K":"V"},"headers":{"H":"h"}}"#,
        )
        .expect("deserialize");
        assert_eq!(config.transport, "http");
        assert_eq!(config.env["K"], "V");
        assert!(config.command.is_empty());
    }

    /// Real end-to-end over stdio: spawn a fake MCP server (a tiny Node script)
    /// and drive the full handshake + tool call through the manager.
    #[tokio::test]
    async fn stdio_handshake_and_tool_call() {
        let script = r#"
            const readline = require("readline");
            const rl = readline.createInterface({ input: process.stdin });
            rl.on("line", (line) => {
                let msg; try { msg = JSON.parse(line); } catch { return; }
                if (msg.id === undefined || msg.id === null) return;
                let result = {};
                if (msg.method === "initialize")
                    result = { serverInfo: { name: "fake-mcp", version: "0.0.1" }, tools: [] };
                else if (msg.method === "tools/list")
                    result = { tools: [{ name: "echo", description: "Echo back",
                        inputSchema: { type: "object", properties: { text: { type: "string" } } } }] };
                else if (msg.method === "tools/call")
                    result = { content: [{ type: "text", text: "pong:" + JSON.stringify(msg.params.arguments) }], isError: false };
                process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
            });
        "#;
        let config = McpServerConfig {
            name: "fake".into(),
            transport: "stdio".into(),
            command: "node".into(),
            args: vec!["-e".into(), script.trim().to_string()],
            ..Default::default()
        };
        let manager = McpManager::default();
        let connected = manager.connect(&config).await.expect("handshake should succeed");
        assert_eq!(connected.server_info, "fake-mcp");
        assert_eq!(connected.tools.len(), 1);
        assert_eq!(connected.tools[0].name, "echo");

        let outcome = manager
            .call("fake", "echo", json!({"text": "hi"}))
            .await
            .expect("tool call should succeed");
        assert!(!outcome.is_error);
        assert!(outcome.text.contains("pong:"), "got {}", outcome.text);

        assert!(manager.disconnect("fake").await);
        assert!(manager.call("fake", "echo", json!({})).await.is_err());
    }

    #[tokio::test]
    async fn connect_rejects_bad_transport_and_empty_command() {
        let manager = McpManager::default();
        let mut config = McpServerConfig {
            name: "bad".into(),
            transport: "carrier-pigeon".into(),
            ..Default::default()
        };
        assert!(manager.connect(&config).await.is_err());
        config.transport = "stdio".into();
        assert!(manager.connect(&config).await.is_err(), "empty command must fail");
    }

    /// Re-connecting with the same name replaces the previous live process.
    #[tokio::test]
    async fn connect_replaces_previous_connection() {
        let script = r#"
            const readline = require("readline");
            const rl = readline.createInterface({ input: process.stdin });
            rl.on("line", (line) => {
                let msg; try { msg = JSON.parse(line); } catch { return; }
                if (msg.id === undefined || msg.id === null) return;
                const result = msg.method === "initialize"
                    ? { serverInfo: { name: "fake-mcp" }, tools: [] }
                    : { tools: [] };
                process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
            });
        "#;
        let config = McpServerConfig {
            name: "dup".into(),
            transport: "stdio".into(),
            command: "node".into(),
            args: vec!["-e".into(), script.trim().to_string()],
            ..Default::default()
        };
        let manager = McpManager::default();
        manager.connect(&config).await.expect("first connect");
        manager.connect(&config).await.expect("second connect");
        let names = manager.connected_names().await;
        assert_eq!(names, vec!["dup".to_string()]);
        manager.disconnect("dup").await;
        assert!(manager.connected_names().await.is_empty());
    }
}
