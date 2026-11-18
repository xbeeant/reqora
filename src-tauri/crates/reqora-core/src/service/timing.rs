//! Per-request phase timing and raw wire-message reconstruction.
//!
//! reqwest does not expose wire-level checkpoints, so we instrument the two
//! extension points it *does* provide:
//!
//! * `ClientBuilder::dns_resolver` — measures the real DNS lookup. reqwest only
//!   calls the resolver when it needs a new connection, so pooled connections
//!   and literal-IP targets naturally report zero (and set `reused`).
//! * `ClientBuilder::connector_layer` — measures how long establishing the
//!   connection took: the TCP handshake, plus the TLS handshake for https.
//!
//! `service::http` adds two more checkpoints: response headers (TTFB) and the
//! end of the body. Every number in `ResponseTimings` is a real measurement.
//! TLS is deliberately **not** reported as a fabricated split: reqwest's
//! connector performs the TCP and TLS handshakes in a single call, so for https
//! the combined value lives in `tcpMs` and `tlsMerged` tells the UI to label it
//! "TCP + TLS". Splitting it would require replacing reqwest's connector.

use crate::models::ResponseHeader;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::header::{HeaderMap, HOST};
use reqwest::Url;
use serde::Serialize;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Instant;
use tower_layer::Layer;
use tower_service::Service;

/// Phase breakdown returned to the UI. All durations are milliseconds.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseTimings {
    /// DNS resolution. 0 when no lookup happened (pooled / literal IP / proxy).
    pub dns_ms: u64,
    /// Connection establishment: TCP, plus TLS handshake on https targets.
    pub tcp_ms: u64,
    /// Always 0 — kept so the UI can render a stable five-row breakdown.
    pub tls_ms: u64,
    /// True when `tlsMs` is included in `tcpMs` (https, non-reused connection).
    pub tls_merged: bool,
    /// TTFB minus local connection work: server processing + network round trip.
    pub server_ms: u64,
    /// Reading the response body after headers arrived.
    pub transfer_ms: u64,
    /// Wall-clock total, from just before `send()` to the end of the body.
    pub total_ms: u64,
    /// No new DNS lookup and no new connection (keep-alive / literal IP).
    pub reused: bool,
    /// Negotiated protocol, e.g. `HTTP/1.1` or `HTTP/2.0`.
    pub protocol: String,
}

#[derive(Debug, Default)]
struct State {
    dns_ms: u64,
    dns_calls: u32,
    connect_ms: u64,
    connect_calls: u32,
}

/// Cheap, cloneable handle shared by the resolver, the connector layer and the
/// request itself. A single `Client` is built per request, so there is no
/// cross-request leakage.
#[derive(Debug, Clone, Default)]
pub struct TimingRecorder {
    state: Arc<Mutex<State>>,
}

impl TimingRecorder {
    pub fn new() -> Self {
        Self::default()
    }

    fn record_dns(&self, ms: u64) {
        if let Ok(mut state) = self.state.lock() {
            state.dns_ms = state.dns_ms.saturating_add(ms);
            state.dns_calls = state.dns_calls.saturating_add(1);
        }
    }

    fn record_connect(&self, ms: u64) {
        if let Ok(mut state) = self.state.lock() {
            state.connect_ms = state.connect_ms.saturating_add(ms);
            state.connect_calls = state.connect_calls.saturating_add(1);
        }
    }

    /// Assemble the final breakdown once headers and body are both accounted for.
    pub fn finish(
        &self,
        total_ms: u64,
        ttfb_ms: u64,
        protocol: &str,
        https: bool,
    ) -> ResponseTimings {
        let (dns_ms, connect_ms, reused) = self
            .state
            .lock()
            .map(|state| {
                (
                    state.dns_ms,
                    state.connect_ms,
                    state.dns_calls == 0 && state.connect_calls == 0,
                )
            })
            .unwrap_or((0, 0, false));
        let local = dns_ms.saturating_add(connect_ms);
        ResponseTimings {
            dns_ms,
            tcp_ms: connect_ms,
            tls_ms: 0,
            tls_merged: https && connect_ms > 0,
            server_ms: ttfb_ms.saturating_sub(local),
            transfer_ms: total_ms.saturating_sub(ttfb_ms),
            total_ms,
            reused,
            protocol: protocol.to_string(),
        }
    }
}

/// DNS resolver that times `lookup_host`. Port 0 is intentional: reqwest
/// replaces it with the scheme's conventional port (or the URL's explicit one).
#[derive(Clone)]
pub struct TimedResolver {
    recorder: TimingRecorder,
}

impl TimedResolver {
    pub fn new(recorder: TimingRecorder) -> Self {
        Self { recorder }
    }
}

impl Resolve for TimedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        let recorder = self.recorder.clone();
        Box::pin(async move {
            let started = Instant::now();
            let outcome = tokio::net::lookup_host((host, 0)).await;
            recorder.record_dns(started.elapsed().as_millis() as u64);
            match outcome {
                Ok(addrs) => Ok(Box::new(addrs) as Addrs),
                Err(error) => {
                    Err(Box::new(error) as Box<dyn std::error::Error + Send + Sync>)
                }
            }
        })
    }
}

/// Tower layer that times `Service::call` on reqwest's connector. The bound is
/// fully generic so we never have to name reqwest's private `Unnameable`/`Conn`
/// types — the compiler checks them at the `connector_layer` call site.
#[derive(Clone)]
pub struct TimingLayer {
    recorder: TimingRecorder,
}

impl TimingLayer {
    pub fn new(recorder: TimingRecorder) -> Self {
        Self { recorder }
    }
}

#[derive(Clone)]
pub struct TimedConnector<S> {
    inner: S,
    recorder: TimingRecorder,
}

impl<S> Layer<S> for TimingLayer {
    type Service = TimedConnector<S>;

    fn layer(&self, inner: S) -> Self::Service {
        TimedConnector {
            inner,
            recorder: self.recorder.clone(),
        }
    }
}

impl<S, Req, R, E, F> Service<Req> for TimedConnector<S>
where
    S: Service<Req, Response = R, Error = E, Future = F>,
    F: Future<Output = Result<R, E>> + Send + 'static,
    R: Send + 'static,
    E: Send + 'static,
{
    type Response = R;
    type Error = E;
    type Future = Pin<Box<dyn Future<Output = Result<R, E>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Req) -> Self::Future {
        let started = Instant::now();
        let recorder = self.recorder.clone();
        let future = self.inner.call(req);
        Box::pin(async move {
            let result = future.await;
            if result.is_ok() {
                recorder.record_connect(started.elapsed().as_millis() as u64);
            }
            result
        })
    }
}

// ---------------------------------------------------------------------------
// Raw wire messages
// ---------------------------------------------------------------------------

const CRLF: &str = "\r\n";

/// Origin-form target, exactly what an HTTP/1.1 request line carries.
fn request_target(url: &Url) -> String {
    let mut target = url.path().to_string();
    if target.is_empty() {
        target.push('/');
    }
    if let Some(query) = url.query() {
        target.push('?');
        target.push_str(query);
    }
    target
}

/// Rebuild the request that was actually handed to reqwest, in HTTP/1.1 form.
///
/// reqwest injects `Host`, `User-Agent`, `Accept-Encoding` and `Content-Length`
/// at send time, so they are added here when the user did not set them. This is
/// a faithful reconstruction rather than captured wire bytes — HTTP/2 and
/// transparent decompression mean byte-identical capture is not possible from
/// the `Client` API. The UI labels it accordingly.
pub fn wire_request(
    method: &str,
    url: &Url,
    headers: &HeaderMap,
    user_agent: &str,
    accept_encoding: &str,
    body: Option<&[u8]>,
) -> String {
    let mut out = format!("{} {} HTTP/1.1{CRLF}", method, request_target(url));
    let mut has_host = false;
    let mut has_user_agent = false;
    let mut has_accept_encoding = false;
    let mut has_content_length = false;
    for (name, value) in headers.iter() {
        match name.as_str() {
            "host" => has_host = true,
            "user-agent" => has_user_agent = true,
            "accept-encoding" => has_accept_encoding = true,
            "content-length" => has_content_length = true,
            _ => {}
        }
        out.push_str(name.as_str());
        out.push_str(": ");
        out.push_str(&String::from_utf8_lossy(value.as_bytes()));
        out.push_str(CRLF);
    }
    if !has_host {
        if let Some(host) = url.host_str() {
            let default_port = match url.scheme() {
                "https" => Some(443),
                "http" => Some(80),
                _ => None,
            };
            let port = url.port().filter(|port| Some(*port) != default_port);
            out.push_str(HOST.as_str());
            out.push_str(": ");
            out.push_str(host);
            if let Some(port) = port {
                out.push(':');
                out.push_str(&port.to_string());
            }
            out.push_str(CRLF);
        }
    }
    if !has_user_agent && !user_agent.is_empty() {
        out.push_str("user-agent: ");
        out.push_str(user_agent);
        out.push_str(CRLF);
    }
    if !has_accept_encoding && !accept_encoding.is_empty() {
        out.push_str("accept-encoding: ");
        out.push_str(accept_encoding);
        out.push_str(CRLF);
    }
    if !has_content_length {
        if let Some(bytes) = body {
            out.push_str("content-length: ");
            out.push_str(&bytes.len().to_string());
            out.push_str(CRLF);
        }
    }
    out.push_str(CRLF);
    if let Some(bytes) = body {
        if bytes.contains(&0) || std::str::from_utf8(bytes).is_err() {
            out.push_str(&format!(
                "<<{} bytes of binary request body — base64 below>>{CRLF}",
                bytes.len()
            ));
            out.push_str(&base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                bytes,
            ));
            out.push_str(CRLF);
        } else {
            out.push_str(&String::from_utf8_lossy(bytes));
        }
    }
    out
}

/// Rebuild the response as status line + headers + body. `body` is the exact
/// slice shown in the Body tab (already truncated to `max_response_bytes`).
pub fn wire_response(
    protocol: &str,
    status: u16,
    reason: &str,
    headers: &[ResponseHeader],
    body: &[u8],
    body_is_base64: bool,
    truncated: bool,
) -> String {
    let mut out = format!("{protocol} {status} {reason}{CRLF}");
    for header in headers {
        out.push_str(&header.name);
        out.push_str(": ");
        out.push_str(&header.value);
        out.push_str(CRLF);
    }
    out.push_str(CRLF);
    if body_is_base64 && !body.is_empty() {
        out.push_str(&format!(
            "<<binary body — base64 encoding of the {} bytes received>>{CRLF}",
            body.len()
        ));
        out.push_str(&base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            body,
        ));
        out.push_str(CRLF);
    } else if !body.is_empty() {
        out.push_str(&String::from_utf8_lossy(body));
    }
    if truncated {
        out.push_str(&format!("{CRLF}<<response truncated by max_response_bytes>>{CRLF}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderValue, CONTENT_TYPE};

    #[test]
    fn finish_splits_total_by_real_checkpoints() {
        let recorder = TimingRecorder::new();
        recorder.record_dns(3);
        recorder.record_connect(12);
        let timings = recorder.finish(100, 40, "HTTP/1.1", false);
        assert_eq!(timings.dns_ms, 3);
        assert_eq!(timings.tcp_ms, 12);
        assert_eq!(timings.server_ms, 25);
        assert_eq!(timings.transfer_ms, 60);
        assert_eq!(timings.total_ms, 100);
        assert!(!timings.reused);
        assert!(!timings.tls_merged);
    }

    #[test]
    fn https_connection_marks_tls_as_merged() {
        let recorder = TimingRecorder::new();
        recorder.record_connect(20);
        let timings = recorder.finish(50, 30, "HTTP/2.0", true);
        assert!(timings.tls_merged);
        assert_eq!(timings.tls_ms, 0, "never fabricate a TLS split");
        assert_eq!(timings.protocol, "HTTP/2.0");
    }

    #[test]
    fn pooled_connection_is_reported_as_reused() {
        let timings = TimingRecorder::new().finish(9, 8, "HTTP/1.1", false);
        assert!(timings.reused);
        assert_eq!(timings.dns_ms, 0);
        assert_eq!(timings.tcp_ms, 0);
        assert_eq!(timings.server_ms, 8);
    }

    #[test]
    fn wire_request_includes_transport_headers_and_body() {
        let url = Url::parse("https://example.com/v1/items?q=2").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let raw = wire_request(
            "POST",
            &url,
            &headers,
            "Reqora/0.0.1",
            "gzip, br, deflate",
            Some(br#"{"a":1}"#),
        );
        assert!(raw.starts_with("POST /v1/items?q=2 HTTP/1.1\r\n"));
        assert!(raw.contains("host: example.com\r\n"));
        assert!(raw.contains("user-agent: Reqora/0.0.1\r\n"));
        assert!(raw.contains("accept-encoding: gzip, br, deflate\r\n"));
        assert!(raw.contains("content-length: 7\r\n"));
        assert!(raw.ends_with("\r\n\r\n{\"a\":1}"));
    }

    #[test]
    fn wire_request_keeps_explicit_user_headers() {
        let url = Url::parse("http://localhost:18080/ping").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("user-agent", HeaderValue::from_static("custom/1"));
        let raw = wire_request("GET", &url, &headers, "Reqora/0.0.1", "", None);
        assert!(raw.contains("user-agent: custom/1\r\n"));
        assert!(!raw.contains("user-agent: Reqora"));
        assert!(raw.contains("host: localhost:18080\r\n"));
        assert!(raw.ends_with("\r\n\r\n"));
    }

    #[test]
    fn wire_response_renders_status_line_headers_and_body() {
        let raw = wire_response(
            "HTTP/1.1",
            200,
            "OK",
            &[ResponseHeader {
                name: "content-type".into(),
                value: "application/json".into(),
            }],
            br#"{"ok":true}"#,
            false,
            false,
        );
        assert!(raw.starts_with("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n"));
        assert!(raw.ends_with("{\"ok\":true}"));
    }
}
