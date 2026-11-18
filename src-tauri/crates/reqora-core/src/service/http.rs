//! Service layer: validate, resolve variables, then perform the real HTTP call.
//!
//! This lives in Rust rather than the WebView on purpose: a browser fetch would
//! be blocked by CORS, cannot skip TLS verification, and cannot control proxies.
//! The service layer knows nothing about Tauri IPC types.

use crate::config::Config;
use crate::error::AppError;
use crate::models::{
    ApiKeyLocation, AuthSpec, BodySpec, FormPart, KeyValue, RequestSpec, ResponseHeader,
    ResponsePayload, Variables,
};
use crate::service::cookies::CookieStore;
use crate::service::template::resolve;
use crate::service::timing::{
    wire_request, wire_response, TimedResolver, TimingLayer, TimingRecorder,
};
use base64::Engine;
use reqwest::header::{
    ACCEPT_ENCODING, AUTHORIZATION, CONTENT_TYPE, COOKIE, HOST, HeaderMap, HeaderName,
    HeaderValue, SET_COOKIE,
};
use reqwest::multipart::{Form, Part};
use reqwest::redirect::Policy;
use reqwest::{Client, Method, Url};
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// ---- Extended auth + HTTP version wiring ----
//
// Bearer / Basic / API Key still go through `apply_auth`. The three new
// schemes need more context than a `&mut HeaderMap`:
//   * OAuth 2.0  -> async token acquisition / refresh before the client is built
//   * AWS SigV4  -> a signature over the FINAL method, URL, headers and body
//   * mTLS       -> client identity + custom CA on the ClientBuilder itself
// Request-level `httpVersion` selects HTTP/1.1, HTTP/2 prior knowledge or
// HTTP/3 (QUIC) prior knowledge; `auto` leaves ALPN / Alt-Svc to reqwest.

#[derive(Default)]
struct AuthEffects {
    headers: Vec<(String, String)>,
    identity_pem: Option<Vec<u8>>,
    ca_pem: Option<Vec<u8>>,
    min_tls_12: bool,
    sigv4: Option<crate::service::auth::SigV4Config>,
}

fn auth_json(auth: &AuthSpec) -> serde_json::Value {
    serde_json::to_value(auth).unwrap_or(serde_json::Value::Null)
}

fn auth_str(auth: &AuthSpec, key: &str) -> Option<String> {
    auth_json(auth)
        .get(key)
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
}

fn auth_bool(auth: &AuthSpec, key: &str) -> bool {
    auth_json(auth)
        .get(key)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn auth_u64(auth: &AuthSpec, key: &str) -> Option<u64> {
    auth_json(auth)
        .get(key)
        .and_then(|value| value.as_u64())
}

fn auth_i64(auth: &AuthSpec, key: &str) -> Option<i64> {
    auth_json(auth)
        .get(key)
        .and_then(|value| value.as_i64())
}

fn oauth2_config(auth: &AuthSpec) -> crate::service::auth::OAuth2Config {
    crate::service::auth::OAuth2Config {
        grant: auth_str(auth, "grant").unwrap_or_default(),
        token_url: auth_str(auth, "tokenUrl"),
        auth_url: auth_str(auth, "authUrl"),
        client_id: auth_str(auth, "clientId"),
        client_secret: auth_str(auth, "clientSecret"),
        scope: auth_str(auth, "scope"),
        audience: auth_str(auth, "audience"),
        redirect_uri: auth_str(auth, "redirectUri"),
        username: auth_str(auth, "username"),
        password: auth_str(auth, "password"),
        code: auth_str(auth, "code"),
        code_verifier: auth_str(auth, "codeVerifier"),
        access_token: auth_str(auth, "accessToken"),
        refresh_token: auth_str(auth, "refreshToken"),
        token_type: auth_str(auth, "tokenType"),
        expires_at: auth_i64(auth, "expiresAt"),
        token_prefix: auth_str(auth, "tokenPrefix"),
        client_auth: auth_str(auth, "clientAuth"),
    }
}

fn sigv4_config(auth: &AuthSpec) -> crate::service::auth::SigV4Config {
    crate::service::auth::SigV4Config {
        access_key_id: auth_str(auth, "accessKeyId").unwrap_or_default(),
        secret_access_key: auth_str(auth, "secretAccessKey").unwrap_or_default(),
        session_token: auth_str(auth, "sessionToken"),
        region: auth_str(auth, "region").unwrap_or_else(|| "us-east-1".into()),
        service: auth_str(auth, "service").unwrap_or_else(|| "execute-api".into()),
        sign_query: auth_bool(auth, "signQuery"),
        expires_in: auth_u64(auth, "expiresIn"),
        unsigned_payload: auth_bool(auth, "unsignedPayload"),
    }
}

fn mtls_config(auth: &AuthSpec) -> crate::service::auth::MtlsConfig {
    crate::service::auth::MtlsConfig {
        cert_pem: auth_str(auth, "certPem"),
        key_pem: auth_str(auth, "keyPem"),
        ca_pem: auth_str(auth, "caPem"),
        p12_base64: auth_str(auth, "p12Base64"),
        passphrase: auth_str(auth, "passphrase"),
        min_tls_version: auth_str(auth, "minTlsVersion"),
        server_name: auth_str(auth, "serverName"),
    }
}

fn is_extended_auth(auth: &AuthSpec) -> bool {
    matches!(
        auth,
        AuthSpec::OAuth2 { .. } | AuthSpec::AwsSigV4 { .. } | AuthSpec::Mtls { .. }
    )
}

/// Resolve `{{var}}` inside the new auth variants. `prepare()` only knows how
/// to walk the four legacy variants, so do a JSON round-trip here: the wire
/// shape is the single source of truth and no field list can fall out of sync.
fn resolve_auth_variables(
    auth: &AuthSpec,
    variables: &Variables,
    missing: &mut Vec<String>,
) -> Option<AuthSpec> {
    if !is_extended_auth(auth) {
        return None;
    }
    let mut value = serde_json::to_value(auth).ok()?;
    walk_auth_strings(&mut value, variables, missing);
    serde_json::from_value(value).ok()
}

fn walk_auth_strings(value: &mut serde_json::Value, variables: &Variables, missing: &mut Vec<String>) {
    match value {
        serde_json::Value::String(text) => {
            let resolved = resolve(text, variables);
            for item in resolved.missing {
                if !missing.contains(&item) {
                    missing.push(item);
                }
            }
            *text = resolved.value;
        }
        serde_json::Value::Object(map) => {
            for (_, child) in map.iter_mut() {
                walk_auth_strings(child, variables, missing);
            }
        }
        _ => {}
    }
}

/// Token acquisition / refresh is async, so it happens before the client is
/// built. SigV4 is deferred until every header (including Content-Type and
/// Cookie) is final; mTLS only produces builder inputs here.
async fn resolve_auth_effects(auth: &AuthSpec) -> Result<AuthEffects, AppError> {
    let mut effects = AuthEffects::default();
    match auth {
        AuthSpec::OAuth2 { .. } => {
            let outcome = crate::service::auth::oauth2_outcome(&oauth2_config(auth)).await?;
            effects.headers.extend(outcome.headers);
        }
        AuthSpec::AwsSigV4 { .. } => effects.sigv4 = Some(sigv4_config(auth)),
        AuthSpec::Mtls { .. } => {
            let outcome = crate::service::auth::mtls_outcome(&mtls_config(auth))?;
            effects.headers.extend(outcome.headers);
            effects.identity_pem = outcome.identity_pem;
            effects.ca_pem = outcome.ca_pem;
            effects.min_tls_12 = outcome.min_tls_12;
        }
        _ => {}
    }
    Ok(effects)
}

fn insert_effect_headers(effects: &AuthEffects, headers: &mut HeaderMap) -> Result<(), AppError> {
    for (key, value) in &effects.headers {
        let name = HeaderName::from_bytes(key.as_bytes())
            .map_err(|_| AppError::InvalidInput("认证头名称不合法".into()))?;
        let parsed = HeaderValue::from_str(value)
            .map_err(|_| AppError::InvalidInput("认证头含非法字符".into()))?;
        headers.insert(name, parsed);
    }
    Ok(())
}

const MAX_HEADERS: usize = 200;
const MAX_QUERY_PARAMS: usize = 200;
const MAX_TIMEOUT_SECS: u64 = 300;

// Hop-by-hop / transport-managed headers must be owned by reqwest.
const BLOCKED_HEADERS: [&str; 6] = [
    "host",
    "content-length",
    "connection",
    "transfer-encoding",
    "proxy-authorization",
    "proxy-connection",
];

pub struct HttpService {
    pub config: Config,
    /// Cross-request cookie jar. Shared by every buffered and streaming
    /// request; commands expose it to the UI for listing / clearing.
    pub cookies: Arc<Mutex<CookieStore>>,
}

struct Prepared {
    method: Method,
    url: Url,
    resolved_url: String,
    headers: Vec<(String, String)>,
    body: BodySpec,
    auth: AuthSpec,
    timeout: Duration,
    follow_redirects: bool,
    verify_tls: bool,
    /// HTTP(S) proxy override from settings; None = system default.
    proxy_url: Option<String>,
    missing: Vec<String>,
    /// Streaming responses must not be cut off by the buffered path's total
    /// request timeout; see `build_client`.
    streaming: bool,
}

/// Metadata known as soon as the response headers arrive — the body is still
/// unread at this point. Keeping it separate from `reqwest::Response` lets the
/// streaming command clone/send it while the connection stays open.
#[derive(Debug, Clone)]
pub struct ResponseMeta {
    pub status: u16,
    pub status_text: String,
    pub ok: bool,
    pub url: String,
    pub resolved_url: String,
    pub missing_variables: Vec<String>,
    pub headers: Vec<ResponseHeader>,
    pub content_type: String,
    pub started: Instant,
    /// Milliseconds from just before `send()` to response headers (TTFB).
    pub ttfb_ms: u64,
    /// Negotiated HTTP version, used by the raw response status line.
    pub protocol: String,
    /// Whether the target used TLS (TCP and TLS share one connect checkpoint).
    pub https: bool,
    /// Shared checkpoint recorder; `finish()` is called once the body is read.
    pub timings: TimingRecorder,
    /// Request line + headers + body, reconstructed before the request is sent.
    pub raw_request: String,
}

impl ResponseMeta {
    pub fn is_event_stream(&self) -> bool {
        self.content_type.contains("text/event-stream")
    }
}

pub struct OpenedResponse {
    pub meta: ResponseMeta,
    pub response: reqwest::Response,
}

impl HttpService {
    /// Buffered fallback kept for the unit tests: bounded streamed read that
    /// never buffers the whole body with `bytes().await`. The real IPC path
    /// uses `service::response_body::collect` instead.
    pub async fn execute(
        &self,
        spec: RequestSpec,
        request_id: &str,
    ) -> Result<ResponsePayload, AppError> {
        let opened = self.open(spec).await?;
        let mut response = opened.response;
        let cap = self
            .config
            .max_response_bytes
            .min(self.config.inline_body_bytes);
        let hard_cap = self.config.max_response_bytes as u64;
        let mut buffer: Vec<u8> = Vec::new();
        let mut total: u64 = 0;
        while let Some(chunk) = response.chunk().await.map_err(classify)? {
            total += chunk.len() as u64;
            if buffer.len() < cap {
                let room = cap - buffer.len();
                let take = room.min(chunk.len());
                buffer.extend_from_slice(&chunk[..take]);
            }
            // Keep consuming to EOF (or the hard ceiling) so the connection
            // closes cleanly, but never retain more than `cap` bytes.
            if total >= hard_cap {
                break;
            }
        }
        Ok(self.payload(&opened.meta, &buffer, request_id))
    }

    /// Buffered request: keep the normal total timeout.
    pub async fn open(&self, spec: RequestSpec) -> Result<OpenedResponse, AppError> {
        self.open_with_mode(spec, false).await
    }

    /// Streaming request: headers must arrive within the normal timeout but the
    /// body may legitimately stay open for minutes (LLM token streams). The
    /// frame/byte caps and the user's cancel button bound it instead.
    pub async fn open_stream(&self, spec: RequestSpec) -> Result<OpenedResponse, AppError> {
        self.open_with_mode(spec, true).await
    }

    /// Prepare + send, returning the still-open response. Both the buffered and
    /// the SSE streaming path go through here, so validation, variable
    /// substitution, auth and body encoding can never diverge.
    async fn open_with_mode(
        &self,
        spec: RequestSpec,
        streaming: bool,
    ) -> Result<OpenedResponse, AppError> {
        let mut prepared = prepare(&spec, &self.config)?;
        prepared.streaming = streaming;
        if let Some(auth) = resolve_auth_variables(
            &prepared.auth,
            &spec.variables,
            &mut prepared.missing,
        ) {
            prepared.auth = auth;
        }
        // OAuth 2.0 may perform a network round-trip (token / refresh).
        let effects = resolve_auth_effects(&prepared.auth).await?;
        let recorder = TimingRecorder::new();
        let client = build_client(
            &prepared,
            &recorder,
            spec.http_version.as_deref().unwrap_or("auto"),
            &effects,
        )?;

        let mut header_map = HeaderMap::new();
        for (key, value) in &prepared.headers {
            let name = HeaderName::from_bytes(key.as_bytes())
                .map_err(|_| AppError::InvalidInput(format!("Header 名称不合法: {key}")))?;
            let parsed = HeaderValue::from_str(value)
                .map_err(|_| AppError::InvalidInput(format!("Header 值含非法字符: {key}")))?;
            header_map.append(name, parsed);
        }

        apply_auth(&prepared.auth, &mut header_map)?;
        insert_effect_headers(&effects, &mut header_map)?;

        // Explicitly advertise the encodings our decoder chain supports, but
        // never override a user-supplied Accept-Encoding header.
        if !header_map.contains_key(ACCEPT_ENCODING) {
            header_map.insert(
                ACCEPT_ENCODING,
                HeaderValue::from_static("gzip, deflate, br, zstd"),
            );
        }

        // Cookie jar: attach matching cookies unless the request opts out or
        // the user set an explicit Cookie header (their value wins).
        if spec.use_cookies.unwrap_or(true) {
            if let Some(value) = self
                .cookies
                .lock()
                .ok()
                .and_then(|store| store.cookie_header(prepared.url.as_str()))
            {
                if !header_map.contains_key(COOKIE) {
                    if let Ok(parsed) = HeaderValue::from_str(&value) {
                        header_map.insert(COOKIE, parsed);
                    }
                }
            }
        }

        let mut request = client.request(prepared.method.clone(), prepared.url.clone());
        match &prepared.body {
            BodySpec::None => {}
            BodySpec::Json { content } => {
                if !header_map.contains_key(CONTENT_TYPE) {
                    header_map.insert(
                        CONTENT_TYPE,
                        HeaderValue::from_static("application/json; charset=utf-8"),
                    );
                }
                request = request.body(content.clone());
            }
            BodySpec::Raw {
                content,
                content_type,
            } => {
                if !content_type.trim().is_empty() && !header_map.contains_key(CONTENT_TYPE) {
                    let value = HeaderValue::from_str(content_type)
                        .map_err(|_| AppError::InvalidInput("Content-Type 不合法".into()))?;
                    header_map.insert(CONTENT_TYPE, value);
                }
                request = request.body(content.clone());
            }
            BodySpec::FormUrlEncoded { items } => {
                let pairs: Vec<(String, String)> = items
                    .iter()
                    .filter(|item| item.enabled && !item.key.trim().is_empty())
                    .map(|item| (item.key.clone(), item.value.clone()))
                    .collect();
                request = request.form(&pairs);
            }
            BodySpec::FormData { items } => {
                // multipart 的 boundary 由 reqwest 生成；用户手写的 Content-Type
                // （如不带 boundary 的 multipart/form-data，或从 JSON 请求遗留的
                // application/json）若覆盖它，服务端会解析不到任何 part，表现为
                // “请求参数接收不到”。这里让 reqwest 生成的类型与 boundary 生效。
                header_map.remove(CONTENT_TYPE);
                let mut form = Form::new();
                for part in items
                    .iter()
                    .filter(|item| item.enabled && !item.key.trim().is_empty())
                {
                    if part.file {
                        let bytes = decode_base64(&part.value)?;
                        let mut part_builder = Part::bytes(bytes);
                        if !part.file_name.trim().is_empty() {
                            part_builder = part_builder.file_name(part.file_name.trim().to_string());
                        }
                        if !part.content_type.trim().is_empty() {
                            part_builder = part_builder.mime_str(part.content_type.trim()).map_err(
                                |_| AppError::InvalidInput("文件 Part 的 Content-Type 不合法".into()),
                            )?;
                        }
                        form = form.part(part.key.trim().to_string(), part_builder);
                    } else {
                        form = form.text(part.key.trim().to_string(), part.value.clone());
                    }
                }
                // reqwest sets the multipart boundary Content-Type automatically.
                request = request.multipart(form);
            }
            BodySpec::Binary { data, content_type, .. } => {
                let bytes = decode_base64(data)?;
                if !content_type.trim().is_empty() && !header_map.contains_key(CONTENT_TYPE) {
                    let value = HeaderValue::from_str(content_type.trim())
                        .map_err(|_| AppError::InvalidInput("Content-Type 不合法".into()))?;
                    header_map.insert(CONTENT_TYPE, value);
                }
                request = request.body(bytes);
            }
            BodySpec::GraphQL { query, variables } => {
                let payload = graphql_payload(query, variables)?;
                if !header_map.contains_key(CONTENT_TYPE) {
                    header_map
                        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
                }
                request = request.body(payload);
            }
        }
        // AWS SigV4 must be the LAST auth step: the signature covers the final
        // header set (Content-Type / Cookie / Accept-Encoding included) and
        // the body hash. Query presigning is appended through RequestBuilder.
        if let Some(cfg) = &effects.sigv4 {
            if !header_map.contains_key(HOST) {
                if let Some(host) = prepared.url.host_str() {
                    let host_value = match prepared.url.port() {
                        Some(port) => format!("{host}:{port}"),
                        None => host.to_string(),
                    };
                    if let Ok(parsed) = HeaderValue::from_str(&host_value) {
                        header_map.insert(HOST, parsed);
                    }
                }
            }
            let body_bytes = fallback_body(&prepared.body).unwrap_or_default();
            let payload_hash = if cfg.unsigned_payload {
                "UNSIGNED-PAYLOAD".to_string()
            } else {
                crate::service::auth::sha256_hex(&body_bytes)
            };
            let outcome = crate::service::auth::sigv4_outcome(
                cfg,
                prepared.method.as_str(),
                &prepared.url,
                &header_map,
                &payload_hash,
            )?;
            for (key, value) in &outcome.headers {
                let name = HeaderName::from_bytes(key.as_bytes())
                    .map_err(|_| AppError::InvalidInput("SigV4 头名称不合法".into()))?;
                let parsed = HeaderValue::from_str(value)
                    .map_err(|_| AppError::InvalidInput("SigV4 头含非法字符".into()))?;
                header_map.insert(name, parsed);
            }
            if !outcome.query.is_empty() {
                let pairs: Vec<(String, String)> = outcome.query.clone();
                request = request.query(&pairs);
            }
        }
        request = request.headers(header_map.clone());

        // Capture the request before `send()` consumes the builder. `try_clone`
        // is None for streaming bodies (multipart); in that case we fall back to
        // the header map we just built and note the omitted body explicitly.
        let raw_request = {
            let built = request.try_clone().and_then(|item| item.build().ok());
            let headers = built.as_ref().map(|item| item.headers()).unwrap_or(&header_map);
            let body = built
                .as_ref()
                .and_then(|item| item.body())
                .and_then(|item| item.as_bytes())
                .map(|bytes| bytes.to_vec())
                .or_else(|| fallback_body(&prepared.body));
            let mut text = wire_request(
                prepared.method.as_str(),
                &prepared.url,
                headers,
                &format!("Reqora/{}", env!("CARGO_PKG_VERSION")),
                "gzip, deflate, br, zstd",
                body.as_deref(),
            );
            if matches!(prepared.body, BodySpec::FormData { .. }) && body.is_none() {
                text.push_str("\r\n<<multipart body generated by reqwest; boundary omitted>>\r\n");
            }
            text
        };

        let started = Instant::now();
        let response = request.send().await.map_err(classify)?;
        let ttfb_ms = started.elapsed().as_millis() as u64;
        let protocol = protocol_label(response.version());
        let https = prepared.url.scheme() == "https";

        // Capture Set-Cookie from the final response (after redirects) so the
        // jar reflects what the answering host actually set. Failures here are
        // silently ignored: cookies must never break the request itself.
        if spec.use_cookies.unwrap_or(true) {
            let set_cookies: Vec<String> = response
                .headers()
                .get_all(SET_COOKIE)
                .iter()
                .filter_map(|value| value.to_str().ok().map(|s| s.to_string()))
                .collect();
            if !set_cookies.is_empty() {
                if let Ok(mut store) = self.cookies.lock() {
                    store.capture(response.url().as_str(), &set_cookies);
                }
            }
        }

        let status = response.status();
        let status_text = status.canonical_reason().unwrap_or("").to_string();
        let final_url = response.url().to_string();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mut response_headers: Vec<ResponseHeader> = response
            .headers()
            .iter()
            .map(|(name, value)| ResponseHeader {
                name: name.to_string(),
                value: value.to_str().unwrap_or("<binary>").to_string(),
            })
            .collect();
        response_headers.sort_by(|left, right| left.name.cmp(&right.name));

        Ok(OpenedResponse {
            meta: ResponseMeta {
                status: status.as_u16(),
                status_text,
                ok: status.is_success(),
                url: final_url,
                resolved_url: prepared.resolved_url,
                missing_variables: prepared.missing,
                headers: response_headers,
                content_type,
                started,
                ttfb_ms,
                protocol,
                https,
                timings: recorder,
                raw_request,
            },
            response,
        })
    }

    /// Encode an already-buffered body using the same limits and kind detection
    /// as the non-streaming path.
    pub fn payload(
        &self,
        meta: &ResponseMeta,
        bytes: &[u8],
        request_id: &str,
    ) -> ResponsePayload {
        let time_ms = meta.started.elapsed().as_millis() as u64;
        let size = bytes.len();
        let limit = self.config.max_response_bytes;
        let truncated = size > limit;
        let slice = &bytes[..size.min(limit)];

        let body_kind = if slice.is_empty() {
            "empty"
        } else if slice.contains(&0) || std::str::from_utf8(slice).is_err() {
            "binary"
        } else if meta.content_type.contains("json")
            || serde_json::from_slice::<serde_json::Value>(slice).is_ok()
        {
            "json"
        } else {
            "text"
        };

        let body = if body_kind == "binary" {
            base64::engine::general_purpose::STANDARD.encode(slice)
        } else {
            String::from_utf8_lossy(slice).into_owned()
        };

        let timings = meta.timings.finish(time_ms, meta.ttfb_ms, &meta.protocol, meta.https);
        let raw_response = wire_response(
            &meta.protocol,
            meta.status,
            &meta.status_text,
            &meta.headers,
            slice,
            body_kind == "binary",
            truncated,
        );

        ResponsePayload {
            request_id: request_id.to_string(),
            status: meta.status,
            status_text: meta.status_text.clone(),
            ok: meta.ok,
            time_ms,
            size,
            url: meta.url.clone(),
            resolved_url: meta.resolved_url.clone(),
            missing_variables: meta.missing_variables.clone(),
            headers: meta.headers.clone(),
            body,
            body_kind: body_kind.to_string(),
            truncated,
            timings,
            raw_request: meta.raw_request.clone(),
            raw_response,
            // `payload` is the buffered fallback: it never spools, so the
            // on-demand body reference and decoding chain stay empty.
            body_ref: None,
            content_encoding: None,
            total_lines: slice.split(|byte| *byte == b'\n').count() as u64,
            inline_bytes: slice.len() as u64,
        }
    }
}

fn prepare(spec: &RequestSpec, config: &Config) -> Result<Prepared, AppError> {
    // Untrusted metadata crosses the IPC boundary too — bound it as well.
    if spec.id.len() > 128 || spec.name.len() > 200 {
        return Err(AppError::InvalidInput("请求 ID 或名称过长".into()));
    }
    if spec.headers.len() > MAX_HEADERS || spec.query.len() > MAX_QUERY_PARAMS {
        return Err(AppError::InvalidInput(format!(
            "Header / Query 条目数不能超过 {MAX_HEADERS} / {MAX_QUERY_PARAMS}"
        )));
    }

    let method = match spec.method.trim().to_ascii_uppercase().as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        "PUT" => Method::PUT,
        "PATCH" => Method::PATCH,
        "DELETE" => Method::DELETE,
        "HEAD" => Method::HEAD,
        "OPTIONS" => Method::OPTIONS,
        other => {
            return Err(AppError::InvalidInput(format!(
                "不支持的 HTTP 方法: {other}"
            )));
        }
    };

    let mut missing = BTreeSet::new();
    let resolved_url = sub(&spec.url, &spec.variables, &mut missing);
    let mut url = Url::parse(&resolved_url).map_err(|_| {
        let hint = if missing.is_empty() {
            String::new()
        } else {
            format!("；未定义的变量: {}", missing.iter().cloned().collect::<Vec<_>>().join(", "))
        };
        AppError::InvalidInput(format!("URL 格式不合法（需完整 http/https 地址）{hint}"))
    })?;

    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(AppError::InvalidInput(format!(
                "仅支持 http/https 协议，当前为: {other}"
            )));
        }
    }
    if url.host_str().is_none() {
        return Err(AppError::InvalidInput("URL 缺少主机名".into()));
    }

    let auth = match &spec.auth {
        AuthSpec::OAuth2 { .. } | AuthSpec::AwsSigV4 { .. } | AuthSpec::Mtls { .. } => {
            serde_json::from_value(
                serde_json::to_value(&spec.auth).unwrap_or(serde_json::Value::Null),
            )
            .unwrap_or(AuthSpec::None)
        }

        AuthSpec::None => AuthSpec::None,
        AuthSpec::Bearer { token } => AuthSpec::Bearer {
            token: sub(token, &spec.variables, &mut missing),
        },
        AuthSpec::Basic { username, password } => AuthSpec::Basic {
            username: sub(username, &spec.variables, &mut missing),
            password: sub(password, &spec.variables, &mut missing),
        },
        AuthSpec::ApiKey {
            key,
            value,
            location,
        } => AuthSpec::ApiKey {
            key: sub(key, &spec.variables, &mut missing),
            value: sub(value, &spec.variables, &mut missing),
            location: location.clone(),
        },
    };

    let mut query_pairs: Vec<(String, String)> = spec
        .query
        .iter()
        .filter(|item| item.enabled && !item.key.trim().is_empty())
        .map(|item| {
            (
                sub(&item.key, &spec.variables, &mut missing),
                sub(&item.value, &spec.variables, &mut missing),
            )
        })
        .collect();

    if let AuthSpec::ApiKey {
        key,
        value,
        location: ApiKeyLocation::Query,
    } = &auth
    {
        if !key.trim().is_empty() {
            query_pairs.push((key.clone(), value.clone()));
        }
    }

    // `Url::query_pairs_mut()` unconditionally installs a `?` even when no
    // pair is appended. Guard it so a request without query rows keeps its
    // exact URL — otherwise a strict server sees `/hello?` instead of
    // `/hello`. This is a shared-engine fix: desktop and CLI both get it.
    if !query_pairs.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in &query_pairs {
            pairs.append_pair(key, value);
        }
    }

    let headers = resolve_headers(&spec.headers, &spec.variables, &mut missing)?;

    let body = match &spec.body {
        BodySpec::None => BodySpec::None,
        BodySpec::Json { content } => BodySpec::Json {
            content: sub(content, &spec.variables, &mut missing),
        },
        BodySpec::Raw {
            content,
            content_type,
        } => BodySpec::Raw {
            content: sub(content, &spec.variables, &mut missing),
            content_type: content_type.clone(),
        },
        BodySpec::FormUrlEncoded { items } => BodySpec::FormUrlEncoded {
            items: items
                .iter()
                .map(|item| KeyValue {
                    id: item.id.clone(),
                    key: sub(&item.key, &spec.variables, &mut missing),
                    value: sub(&item.value, &spec.variables, &mut missing),
                    enabled: item.enabled,
                })
                .collect(),
        },
        BodySpec::FormData { items } => BodySpec::FormData {
            items: items
                .iter()
                .map(|item| FormPart {
                    id: item.id.clone(),
                    key: sub(&item.key, &spec.variables, &mut missing),
                    // File bytes are binary; never run variable substitution on them.
                    value: if item.file {
                        item.value.clone()
                    } else {
                        sub(&item.value, &spec.variables, &mut missing)
                    },
                    enabled: item.enabled,
                    file: item.file,
                    file_name: item.file_name.clone(),
                    content_type: item.content_type.clone(),
                })
                .collect(),
        },
        BodySpec::Binary { data, file_name, content_type } => BodySpec::Binary {
            data: data.clone(),
            file_name: file_name.clone(),
            content_type: content_type.clone(),
        },
        BodySpec::GraphQL { query, variables } => BodySpec::GraphQL {
            query: sub(query, &spec.variables, &mut missing),
            variables: sub(variables, &spec.variables, &mut missing),
        },
    };

    let mut body_size: usize = 0;
    match &body {
        BodySpec::None => {}
        BodySpec::Json { content } | BodySpec::Raw { content, .. } => body_size = content.len(),
        BodySpec::FormUrlEncoded { items } => {
            body_size = items
                .iter()
                .map(|item| item.key.len() + item.value.len() + 2)
                .sum();
        }
        BodySpec::FormData { items } => {
            for part in items
                .iter()
                .filter(|item| item.enabled && !item.key.trim().is_empty())
            {
                if part.file {
                    body_size += decode_base64(&part.value)?.len();
                } else {
                    body_size += part.key.len() + part.value.len() + 2;
                }
            }
        }
        BodySpec::Binary { data, .. } => body_size = decode_base64(data)?.len(),
        BodySpec::GraphQL { query, variables } => {
            body_size = graphql_payload(query, variables)?.len()
        }
    }
    if body_size > config.max_request_body_bytes {
        return Err(AppError::InvalidInput(format!(
            "请求体超过上限 {} 字节",
            config.max_request_body_bytes
        )));
    }

    let timeout_secs = spec
        .timeout_secs
        .unwrap_or(config.request_timeout_secs)
        .clamp(1, MAX_TIMEOUT_SECS);

    Ok(Prepared {
        method,
        resolved_url: url.to_string(),
        url,
        headers,
        body,
        auth,
        timeout: Duration::from_secs(timeout_secs),
        follow_redirects: spec.follow_redirects.unwrap_or(true),
        verify_tls: spec.verify_tls.unwrap_or(true),
        proxy_url: spec
            .proxy_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        missing: missing.into_iter().collect(),
        streaming: false,
    })
}

fn resolve_headers(
    items: &[KeyValue],
    variables: &Variables,
    missing: &mut BTreeSet<String>,
) -> Result<Vec<(String, String)>, AppError> {
    let mut resolved = Vec::new();
    for item in items
        .iter()
        .filter(|item| item.enabled && !item.key.trim().is_empty())
    {
        let key = sub(&item.key, variables, missing);
        let value = sub(&item.value, variables, missing);
        if BLOCKED_HEADERS.contains(&key.to_ascii_lowercase().as_str()) {
            continue;
        }
        HeaderName::from_bytes(key.as_bytes())
            .map_err(|_| AppError::InvalidInput(format!("Header 名称不合法: {key}")))?;
        HeaderValue::from_str(&value)
            .map_err(|_| AppError::InvalidInput(format!("Header 值含非法字符: {key}")))?;
        resolved.push((key, value));
    }
    Ok(resolved)
}

fn sub(input: &str, variables: &Variables, missing: &mut BTreeSet<String>) -> String {
    let result = resolve(input, variables);
    missing.extend(result.missing);
    result.value
}

/// Decode a base64 string from a file part / binary body. File bytes travel as
/// base64 across the IPC boundary because WebView file handles cannot.
fn decode_base64(input: &str) -> Result<Vec<u8>, AppError> {
    base64::engine::general_purpose::STANDARD
        .decode(input.trim())
        .map_err(|_| AppError::InvalidInput("文件数据 base64 解码失败".into()))
}

/// Build the JSON document a GraphQL request sends: `{ query, variables }`.
/// `variables` must be a valid JSON value when non-empty.
fn graphql_payload(query: &str, variables: &str) -> Result<String, AppError> {
    let variables_value: serde_json::Value = if variables.trim().is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(variables.trim()).map_err(|_| {
            AppError::InvalidInput("GraphQL variables 不是合法 JSON".into())
        })?
    };
    Ok(serde_json::json!({ "query": query, "variables": variables_value }).to_string())
}

fn apply_auth(auth: &AuthSpec, headers: &mut HeaderMap) -> Result<(), AppError> {
    match auth {
        AuthSpec::OAuth2 { .. } | AuthSpec::AwsSigV4 { .. } | AuthSpec::Mtls { .. } => {}

        AuthSpec::None => {}
        AuthSpec::Bearer { token } => {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {token}"))
                    .map_err(|_| AppError::InvalidInput("Bearer token 含非法字符".into()))?,
            );
        }
        AuthSpec::Basic { username, password } => {
            let encoded =
                base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"));
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Basic {encoded}"))
                    .map_err(|_| AppError::InvalidInput("Basic 凭据含非法字符".into()))?,
            );
        }
        AuthSpec::ApiKey {
            key,
            value,
            location,
        } => match location {
            // Already merged into the URL during `prepare()`.
            ApiKeyLocation::Query => {}
            ApiKeyLocation::Header => {
                let name = HeaderName::from_bytes(key.as_bytes())
                    .map_err(|_| AppError::InvalidInput("API Key 名称不合法".into()))?;
                let parsed = HeaderValue::from_str(value)
                    .map_err(|_| AppError::InvalidInput("API Key 值含非法字符".into()))?;
                headers.insert(name, parsed);
            }
        },
    }
    Ok(())
}

/// `RequestBuilder::try_clone` returns None for streaming (multipart) bodies.
/// Fall back to the body forms we can serialise ourselves.
fn fallback_body(body: &BodySpec) -> Option<Vec<u8>> {
    match body {
        BodySpec::None | BodySpec::FormData { .. } | BodySpec::FormUrlEncoded { .. } => None,
        BodySpec::Json { content } | BodySpec::Raw { content, .. } => {
            Some(content.as_bytes().to_vec())
        }
        BodySpec::GraphQL { query, variables } => {
            graphql_payload(query, variables).ok().map(String::into_bytes)
        }
        BodySpec::Binary { data, .. } => decode_base64(data).ok(),
    }
}

fn protocol_label(version: http::Version) -> String {
    match version {
        http::Version::HTTP_09 => "HTTP/0.9",
        http::Version::HTTP_10 => "HTTP/1.0",
        http::Version::HTTP_11 => "HTTP/1.1",
        http::Version::HTTP_2 => "HTTP/2.0",
        http::Version::HTTP_3 => "HTTP/3.0",
        _ => "HTTP/1.1",
    }
    .to_string()
}

/// Ceiling for a single stream. `reqwest::Client::timeout` covers the whole
/// body, so using the buffered 30 s default would kill an LLM response that is
/// still emitting tokens. Frames, bytes, idle time and the cancel button are the
/// real limits; this only prevents a server from holding a socket forever.
const STREAM_MAX_SECS: u64 = 30 * 60;

fn build_client(
    prepared: &Prepared,
    recorder: &TimingRecorder,
    http_version: &str,
    effects: &AuthEffects,
) -> Result<Client, AppError> {
    let connect_secs = 10u64.min(prepared.timeout.as_secs());
    let total = if prepared.streaming {
        Duration::from_secs(STREAM_MAX_SECS.max(prepared.timeout.as_secs()))
    } else {
        prepared.timeout
    };
    let mut builder = Client::builder()
        .timeout(total)
        .connect_timeout(Duration::from_secs(connect_secs))
        .user_agent(format!("Reqora/{}", env!("CARGO_PKG_VERSION")))
        // The streaming pipeline decodes Content-Encoding itself and needs the
        // header + raw bytes intact, so disable reqwest auto-decompression.
        .gzip(false)
        .brotli(false)
        .deflate(false)
        .zstd(false)
        .danger_accept_invalid_certs(!prepared.verify_tls)
        .redirect(if prepared.follow_redirects {
            Policy::limited(10)
        } else {
            Policy::none()
        })
        // Real per-phase checkpoints: DNS happens inside the resolver, the TCP
        // (and TLS) handshake inside the connector. Both are recorded by the
        // per-request TimingRecorder and surfaced in the response payload.
        .dns_resolver(Arc::new(TimedResolver::new(recorder.clone())))
        .connector_layer(TimingLayer::new(recorder.clone()));

    // Explicit proxy override (settings → RequestSpec.proxyUrl). Invalid proxy
    // URLs fail fast here instead of silently bypassing the proxy.
    if let Some(proxy) = &prepared.proxy_url {
        let proxy_url = reqwest::Url::parse(proxy)
            .map_err(|_| AppError::InvalidInput(format!("代理地址不合法：{proxy}")))?;
        builder = builder.proxy(reqwest::Proxy::all(proxy_url).map_err(|error| {
            AppError::InvalidInput(format!("代理配置失败：{error}"))
        })?);
    }

    // Loopback targets should never be routed through a system proxy.
    if matches!(
        prepared.url.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("::1") | Some("[::1]")
    ) {
        builder = builder.no_proxy();
    }

    // mTLS: client certificate + private key (PEM) and an optional custom CA.
    if let Some(pem) = &effects.identity_pem {
        let identity = reqwest::Identity::from_pem(pem)
            .map_err(|error| AppError::InvalidInput(format!("客户端证书加载失败：{error}")))?;
        builder = builder.identity(identity);
    }
    if let Some(ca) = &effects.ca_pem {
        let certs = reqwest::Certificate::from_pem_bundle(ca.as_slice())
            .map_err(|error| AppError::InvalidInput(format!("自定义 CA 加载失败：{error}")))?;
        for cert in certs {
            builder = builder.add_root_certificate(cert);
        }
    }
    if effects.min_tls_12 {
        builder = builder.min_tls_version(reqwest::tls::Version::TLS_1_2);
    }

    // Request-level HTTP version. `auto` keeps ALPN / Alt-Svc negotiation;
    // HTTP/3 uses QUIC prior knowledge (reqwest `http3` feature).
    builder = match http_version {
        "http1" => builder.http1_only(),
        "http2" => builder.http2_prior_knowledge(),
        "http3" => builder.http3_prior_knowledge(),
        _ => builder,
    };

    builder
        .build()
        .map_err(|error| AppError::Internal(error.to_string()))
}

fn classify(error: reqwest::Error) -> AppError {
    if error.is_timeout() {
        AppError::Timeout
    } else if error.is_builder() {
        AppError::InvalidInput("请求构造失败".into())
    } else {
        AppError::Network(error.to_string())
    }
}

#[cfg(test)]
#[path = "http/tests.rs"]
mod tests;
