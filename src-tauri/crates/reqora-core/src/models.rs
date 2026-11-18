//! Data transfer objects shared across the IPC boundary.
//! Frontend sends camelCase JSON; serde does the translation.

use crate::service::timing::ResponseTimings;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type Variables = BTreeMap<String, String>;

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValue {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub value: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormPart {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub key: String,
    /// Text value, or base64-encoded file bytes when `file` is true.
    #[serde(default)]
    pub value: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub file: bool,
    #[serde(default)]
    pub file_name: String,
    #[serde(default)]
    pub content_type: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BodySpec {
    None,
    Json {
        #[serde(default)]
        content: String,
    },
    Raw {
        #[serde(default)]
        content: String,
        // T3.2: serde's container-level `rename_all` renames enum *variants*,
        // NOT the fields inside struct variants (serde-rs/serde#1615). Without
        // the explicit rename the frontend's `contentType` is silently dropped
        // and the wire name falls back to snake_case `content_type`.
        #[serde(default, rename = "contentType")]
        content_type: String,
    },
    FormUrlEncoded {
        #[serde(default)]
        items: Vec<KeyValue>,
    },
    FormData {
        #[serde(default)]
        items: Vec<FormPart>,
    },
    Binary {
        /// base64-encoded file bytes.
        #[serde(default)]
        data: String,
        // T3.2: explicit renames for the same reason as Raw above.
        #[serde(default, rename = "fileName")]
        file_name: String,
        #[serde(default, rename = "contentType")]
        content_type: String,
    },
    #[serde(rename = "graphql")]
    GraphQL {
        #[serde(default)]
        query: String,
        /// Optional variables as a raw JSON string; validated before sending.
        #[serde(default)]
        variables: String,
    },
}

impl Default for BodySpec {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApiKeyLocation {
    #[default]
    Header,
    Query,
}

// Serialize too: the SigV4 / OAuth2 signing path hashes the resolved auth
// spec with serde_json::to_value before applying it to the wire request.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AuthSpec {
    None,
    Bearer {
        #[serde(default)]
        token: String,
    },
    Basic {
        #[serde(default)]
        username: String,
        #[serde(default)]
        password: String,
    },
    ApiKey {
        #[serde(default)]
        key: String,
        #[serde(default)]
        value: String,
        #[serde(default)]
        location: ApiKeyLocation,
    },

    /// OAuth 2.0 (authorization code + PKCE S256, client credentials,
    /// password, implicit). Tokens are persisted in the workspace auth spec;
    /// the desktop encrypts them at rest and strips them before any upload.
    /// Every field is optional at the wire boundary so older snapshots and
    /// partial edits keep deserialising.
    #[serde(rename = "oauth2")]
    OAuth2 {
        #[serde(default)] grant: String,
        #[serde(default, rename = "authUrl")] auth_url: Option<String>,
        #[serde(default, rename = "tokenUrl")] token_url: Option<String>,
        #[serde(default, rename = "clientId")] client_id: Option<String>,
        #[serde(default, rename = "clientSecret")] client_secret: Option<String>,
        #[serde(default)] scope: Option<String>,
        #[serde(default)] audience: Option<String>,
        #[serde(default, rename = "redirectUri")] redirect_uri: Option<String>,
        #[serde(default)] state: Option<String>,
        #[serde(default)] username: Option<String>,
        #[serde(default)] password: Option<String>,
        #[serde(default)] pkce: bool,
        #[serde(default, rename = "codeVerifier")] code_verifier: Option<String>,
        #[serde(default)] code: Option<String>,
        #[serde(default, rename = "accessToken")] access_token: Option<String>,
        #[serde(default, rename = "refreshToken")] refresh_token: Option<String>,
        #[serde(default, rename = "tokenType")] token_type: Option<String>,
        #[serde(default, rename = "expiresAt")] expires_at: Option<i64>,
        #[serde(default, rename = "tokenPrefix")] token_prefix: Option<String>,
        #[serde(default, rename = "clientAuth")] client_auth: Option<String>,
    },
    /// AWS Signature Version 4. The signature is computed over the final
    /// method / URI / query / header set / body hash right before sending.
    #[serde(rename = "awsSigV4")]
    AwsSigV4 {
        #[serde(default, rename = "accessKeyId")] access_key_id: String,
        #[serde(default, rename = "secretAccessKey")] secret_access_key: String,
        #[serde(default, rename = "sessionToken")] session_token: Option<String>,
        #[serde(default)] region: String,
        #[serde(default)] service: String,
        #[serde(default, rename = "signQuery")] sign_query: bool,
        #[serde(default, rename = "expiresIn")] expires_in: Option<u64>,
        #[serde(default, rename = "unsignedPayload")] unsigned_payload: bool,
    },
    /// Mutual TLS: client certificate + private key (PEM) and optional custom
    /// CA. PKCS#12 blobs are accepted at the wire boundary and rejected with a
    /// clear conversion hint until a pure-Rust PKCS#12 decoder is available.
    #[serde(rename = "mtls")]
    Mtls {
        #[serde(default, rename = "certPem")] cert_pem: Option<String>,
        #[serde(default, rename = "keyPem")] key_pem: Option<String>,
        #[serde(default, rename = "caPem")] ca_pem: Option<String>,
        #[serde(default, rename = "p12Base64")] p12_base64: Option<String>,
        #[serde(default)] passphrase: Option<String>,
        #[serde(default, rename = "minTlsVersion")] min_tls_version: Option<String>,
        #[serde(default, rename = "serverName")] server_name: Option<String>,
    },
}

impl Default for AuthSpec {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSpec {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<KeyValue>,
    #[serde(default)]
    pub query: Vec<KeyValue>,
    #[serde(default)]
    pub body: BodySpec,
    #[serde(default)]
    pub auth: AuthSpec,
    /// Resolved environment variables supplied by the frontend.
    #[serde(default)]
    pub variables: Variables,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    #[serde(default)]
    pub follow_redirects: Option<bool>,
    #[serde(default)]
    pub verify_tls: Option<bool>,
    /// HTTP(S) proxy override (P2-14). Empty / None = system default.
    #[serde(default)]
    pub proxy_url: Option<String>,
    /// `None` / `Some(true)` = participate in the shared cookie jar: matching
    /// cookies are attached and `Set-Cookie` responses are captured.
    #[serde(default)]
    pub use_cookies: Option<bool>,

    /// Force an HTTP version: "auto" | "http1" | "http2" | "http3".
    /// `http3` uses QUIC prior knowledge; `auto` lets reqwest negotiate via
    /// ALPN / Alt-Svc. Absent on older snapshots -> auto.
    #[serde(default, rename = "httpVersion")]
    pub http_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponsePayload {
    pub request_id: String,
    pub status: u16,
    pub status_text: String,
    pub ok: bool,
    pub time_ms: u64,
    pub size: usize,
    /// Final URL after redirects.
    pub url: String,
    /// URL after variable substitution and query merging (before redirects).
    pub resolved_url: String,
    pub missing_variables: Vec<String>,
    pub headers: Vec<ResponseHeader>,
    /// JSON/text as UTF-8, binary as base64 when `bodyKind == "binary"`.
    pub body: String,
    /// "json" | "text" | "binary" | "empty"
    pub body_kind: String,
    pub truncated: bool,
    /// DNS / connect / TTFB / transfer checkpoints (all real measurements).
    pub timings: ResponseTimings,
    /// Request line + headers + body, as handed to reqwest.
    pub raw_request: String,
    /// Status line + headers + body, as received.
    pub raw_response: String,
    /// Opaque id of the on-disk body spool; present whenever `collect` stored
    /// the decoded body so the UI can page through it on demand.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_ref: Option<String>,
    /// The decoding chain actually applied, e.g. "gzip, br". `None` when no
    /// decoder was applied (no Content-Encoding or an unknown encoding).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_encoding: Option<String>,
    /// Exact line count of the decoded body split on `\n` (always >= 1).
    pub total_lines: u64,
    /// Decoded bytes covered by `body` (binary bodies are base64 there).
    pub inline_bytes: u64,
}

/// A byte window into a spooled response body, returned by `read_response_body`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodySlice {
    pub body_id: String,
    pub offset: u64,
    pub length: u64,
    pub total: u64,
    /// "utf8" for text bodies, "base64" for binary bodies.
    pub encoding: String,
    pub data: String,
}

/// A page of decoded lines, returned by `read_response_lines`. Lines carry no
/// newline characters; binary bodies return each line's bytes as base64.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyLines {
    pub body_id: String,
    pub start_line: u64,
    pub line_count: u64,
    pub total_lines: u64,
    pub lines: Vec<String>,
}

/// Metadata about a spooled response body, returned by `response_body_info`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyInfo {
    pub body_id: String,
    pub size: u64,
    pub total_lines: u64,
    pub body_kind: String,
    pub content_encoding: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub status: &'static str,
    pub version: &'static str,
    pub timeout_secs: u64,
    pub max_response_bytes: usize,
    pub log_level: &'static str,
    pub workspace_path: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialises_camel_case_request_spec() {
        let raw = r#"{
          "id": "r1", "name": "ping", "method": "POST",
          "url": "https://example.com/echo",
          "headers": [{"id":"h1","key":"X-Test","value":"1","enabled":true}],
          "query": [], "body": {"type":"json","content":"{\"a\":1}"},
          "auth": {"type":"bearer","token":"t"},
          "variables": {"baseUrl": "https://example.com"},
          "timeoutSecs": 12, "verifyTls": false
        }"#;
        let spec: RequestSpec = serde_json::from_str(raw).unwrap();
        assert_eq!(spec.method, "POST");
        assert_eq!(spec.headers[0].key, "X-Test");
        assert!(matches!(spec.body, BodySpec::Json { .. }));
        assert!(matches!(spec.auth, AuthSpec::Bearer { .. }));
        assert_eq!(spec.variables.get("baseUrl").unwrap(), "https://example.com");
        assert_eq!(spec.timeout_secs, Some(12));
        assert_eq!(spec.verify_tls, Some(false));
    }

    #[test]
    fn missing_optional_fields_use_defaults() {
        let spec: RequestSpec =
            serde_json::from_str(r#"{"method":"GET","url":"https://example.com"}"#).unwrap();
        assert!(spec.headers.is_empty());
        assert!(matches!(spec.body, BodySpec::None));
        assert!(matches!(spec.auth, AuthSpec::None));
    }

    /// T3.2 contract guard: struct-variant fields need explicit renames —
    /// the container-level `rename_all` only renames variants (serde#1615).
    #[test]
    fn raw_and_binary_variant_fields_use_camel_case_on_the_wire() {
        let raw: BodySpec = serde_json::from_str(
            r#"{"type":"raw","content":"<x/>","contentType":"text/xml"}"#,
        )
        .unwrap();
        match &raw {
            BodySpec::Raw { content, content_type } => {
                assert_eq!(content, "<x/>");
                assert_eq!(content_type, "text/xml");
            }
            other => panic!("expected Raw, got {other:?}"),
        }

        let binary: BodySpec = serde_json::from_str(
            r#"{"type":"binary","data":"YQ==","fileName":"a.bin","contentType":"application/octet-stream"}"#,
        )
        .unwrap();
        match &binary {
            BodySpec::Binary { file_name, content_type, .. } => {
                assert_eq!(file_name, "a.bin");
                assert_eq!(content_type, "application/octet-stream");
            }
            other => panic!("expected Binary, got {other:?}"),
        }

        // camelCase keys bind; the legacy snake_case keys must NOT silently
        // bind any more (with `rename` they are rejected / defaulted to "").
        let snake_case_keys: BodySpec = serde_json::from_str(
            r#"{"type":"binary","data":"YQ==","file_name":"old.bin","content_type":"text/plain"}"#,
        )
        .unwrap();
        match &snake_case_keys {
            BodySpec::Binary { file_name, content_type, .. } => {
                assert_eq!(file_name, "");
                assert_eq!(content_type, "");
            }
            other => panic!("expected Binary, got {other:?}"),
        }
    }

    #[test]
    fn deserialises_new_body_types() {
        let raw = r#"{
          "method":"POST","url":"https://example.com",
          "body": {"type":"formData","items":[
            {"key":"title","value":"hi","enabled":true,"file":false},
            {"key":"doc","value":"Zm9v","enabled":true,"file":true,"fileName":"a.txt","contentType":"text/plain"}
          ]}
        }"#;
        let spec: RequestSpec = serde_json::from_str(raw).unwrap();
        match &spec.body {
            BodySpec::FormData { items } => {
                assert_eq!(items.len(), 2);
                assert!(!items[0].file);
                assert!(items[1].file);
                assert_eq!(items[1].file_name, "a.txt");
            }
            other => panic!("expected FormData, got {other:?}"),
        }

        let binary: RequestSpec = serde_json::from_str(
            r#"{"method":"POST","url":"https://example.com","body":{"type":"binary","data":"YQ==","fileName":"a.bin","contentType":"application/octet-stream"}}"#,
        )
        .unwrap();
        assert!(matches!(binary.body, BodySpec::Binary { .. }));

        let graphql: RequestSpec = serde_json::from_str(
            r#"{"method":"POST","url":"https://example.com","body":{"type":"graphql","query":"{ me }","variables":"{\"id\":1}"}}"#,
        )
        .unwrap();
        assert!(matches!(graphql.body, BodySpec::GraphQL { .. }));
    }
}
