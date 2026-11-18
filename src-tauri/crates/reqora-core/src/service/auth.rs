//! 请求认证服务层：OAuth 2.0 / AWS SigV4 / mTLS。
//!
//! 本模块只产出「需要附加到请求上的数据」（`AuthOutcome`），不直接发起业务请求，
//! 也不改动 `RequestSpec`。所有密钥、token 原文都不会出现在任何错误或日志中。

use crate::error::AppError;
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use hmac::{Hmac, Mac};
use http::{HeaderMap, HeaderName, HeaderValue};
use http::header::AUTHORIZATION;
use reqwest::Url;
use ring::rand::{SecureRandom, SystemRandom};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const ALGORITHM: &str = "AWS4-HMAC-SHA256";
const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";

// ---------------------------------------------------------------------------
// 公开数据结构
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct OAuth2Config {
    pub grant: String,
    pub token_url: Option<String>,
    pub auth_url: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub scope: Option<String>,
    pub audience: Option<String>,
    pub redirect_uri: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub code: Option<String>,
    pub code_verifier: Option<String>,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub token_type: Option<String>,
    pub expires_at: Option<i64>,
    pub token_prefix: Option<String>,
    pub client_auth: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SigV4Config {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
    pub region: String,
    pub service: String,
    pub sign_query: bool,
    pub expires_in: Option<u64>,
    pub unsigned_payload: bool,
}

#[derive(Debug, Clone, Default)]
pub struct MtlsConfig {
    pub cert_pem: Option<String>,
    pub key_pem: Option<String>,
    pub ca_pem: Option<String>,
    pub p12_base64: Option<String>,
    pub passphrase: Option<String>,
    pub min_tls_version: Option<String>,
    pub server_name: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct AuthOutcome {
    /// 需要追加/覆盖到请求上的头（如 `Authorization`、`x-amz-date`）。
    pub headers: Vec<(String, String)>,
    /// 预签名时需要追加到 URL 上的查询参数（原始 key/value，由调用方负责编码）。
    pub query: Vec<(String, String)>,
    /// `key_pem + cert_pem` 拼接后的 PEM，供 `reqwest::Identity::from_pem`。
    pub identity_pem: Option<Vec<u8>>,
    /// 独立的 CA 证书 PEM，供 `Certificate::from_pem_bundle`。
    pub ca_pem: Option<Vec<u8>>,
    pub min_tls_12: bool,
    pub oauth2: Option<OAuth2TokenState>,
}

#[derive(Debug, Clone)]
pub struct OAuth2TokenState {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// 响应里的 token_type，默认 `Bearer`。
    pub token_type: String,
    /// 毫秒时间戳；`None` 表示不过期。
    pub expires_at: Option<i64>,
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// 生成 PKCE 对：`(verifier, base64url_no_pad(Sha256(verifier)))`。
/// verifier 由 32 字节随机数 base64url 编码而来，长度 43，符合 RFC 7636。
pub fn pkce_pair() -> (String, String) {
    let rng = SystemRandom::new();
    let mut buf = [0u8; 32];
    rng.fill(&mut buf).expect("系统随机数生成失败");
    let verifier = URL_SAFE_NO_PAD.encode(buf);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

/// 返回 `(amz_date "YYYYMMDDTHHMMSSZ", short_date "YYYYMMDD", now_ms)`。
/// 纯手写 civil-from-days 转换，不依赖 chrono。
pub fn utc_now_parts() -> (String, String, i64) {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs() as i64;
    let now_ms = dur.as_millis() as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;
    let short_date = format!("{year:04}{month:02}{day:02}");
    let amz_date = format!("{year:04}{month:02}{day:02}T{hour:02}{minute:02}{second:02}Z");
    (amz_date, short_date, now_ms)
}

/// Howard Hinnant 的 civil_from_days：把自 1970-01-01 起的天数转成公历日期。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    (year, month as u32, day as u32)
}

const HEX_UPPER: &[u8; 16] = b"0123456789ABCDEF";

fn is_hex(b: u8) -> bool {
    b.is_ascii_hexdigit()
}

/// RFC 3986 组件编码：仅保留 `A-Za-z0-9-_.~`，斜杠也编码（用于 query 的 key/value）。
fn uri_encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => {
                out.push('%');
                out.push(HEX_UPPER[(b >> 4) as usize] as char);
                out.push(HEX_UPPER[(b & 0x0f) as usize] as char);
            }
        }
    }
    out
}

/// 规范化 URI 路径：逐段保留 unreserved，`/` 作为分隔符，并保留已有合法的 `%XX`
/// （避免把 `url.path()` 已编码的内容二次编码成 `%25XX`）。
fn uri_encode_path(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = String::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            b'%' if i + 2 < bytes.len() && is_hex(bytes[i + 1]) && is_hex(bytes[i + 2]) => {
                out.push('%');
                out.push(bytes[i + 1].to_ascii_uppercase() as char);
                out.push(bytes[i + 2].to_ascii_uppercase() as char);
                i += 2;
            }
            _ => {
                out.push('%');
                out.push(HEX_UPPER[(b >> 4) as usize] as char);
                out.push(HEX_UPPER[(b & 0x0f) as usize] as char);
            }
        }
        i += 1;
    }
    out
}

fn canonical_uri(url: &Url) -> String {
    let path = url.path();
    if path.is_empty() {
        "/".to_string()
    } else {
        uri_encode_path(path)
    }
}

/// 规范化查询串：按键、再按值（编码后）排序，并以 `&` 连接。
fn canonical_query(url: &Url) -> String {
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (uri_encode_component(k.as_ref()), uri_encode_component(v.as_ref())))
        .collect();
    pairs.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    pairs
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

fn host_from_url(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let default_port = match url.scheme() {
        "https" => Some(443),
        "http" => Some(80),
        _ => None,
    };
    match (url.port(), default_port) {
        (Some(port), Some(default)) if port == default => Some(host),
        (Some(port), _) => Some(format!("{host}:{port}")),
        (None, _) => Some(host),
    }
}

/// 这些头在 SigV4 里不签：要么是 hop-by-hop，要么由客户端库自动生成、
/// 要么会被签名逻辑本身覆盖（authorization）。
fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name,
        "connection"
            | "proxy-connection"
            | "keep-alive"
            | "transfer-encoding"
            | "upgrade"
            | "te"
            | "trailer"
            | "accept-encoding"
            | "user-agent"
            | "content-length"
            | "expect"
            | "x-amzn-trace-id"
            | "authorization"
            | "proxy-authorization"
            | "proxy-authenticate"
    )
}

/// 严格按 SigV4 规范生成 canonical request。
///
/// 返回 `(canonical_request, signed_headers)`。
/// - `signed_query = false`（header 签名）：签所有非 hop-by-hop 头，payload 用 `payload_hash`。
/// - `signed_query = true`（预签名）：只签 `host`，日期等 `X-Amz-*` 参数已在 URL query 中，
///   payload 强制 `UNSIGNED-PAYLOAD`。
pub fn canonical_request(
    method: &str,
    url: &Url,
    headers: &HeaderMap,
    payload_hash: &str,
    signed_query: bool,
) -> (String, String) {
    let method = method.trim().to_ascii_uppercase();
    let uri = canonical_uri(url);
    let query = canonical_query(url);

    // 头名小写、值 trim 且把内部连续空白压缩为单个空格；同名多值用逗号合并。
    let mut signed: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (name, value) in headers.iter() {
        let lower = name.as_str().to_ascii_lowercase();
        if is_hop_by_hop(&lower) {
            continue;
        }
        if signed_query && lower != "host" {
            continue;
        }
        let raw = String::from_utf8_lossy(value.as_bytes());
        let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        signed.entry(lower).or_default().push(collapsed);
    }
    // 无论 header 还是预签名模式，host 始终以 URL 为准，确保与服务端计算一致。
    signed.insert(
        "host".to_string(),
        vec![host_from_url(url).unwrap_or_default()],
    );

    let signed_headers = signed.keys().cloned().collect::<Vec<_>>().join(";");
    let canonical_headers = signed
        .iter()
        .map(|(k, values)| format!("{}:{}\n", k, values.join(",")))
        .collect::<String>();
    let payload = if signed_query {
        UNSIGNED_PAYLOAD
    } else {
        payload_hash
    };

    let canonical_request = format!(
        "{method}\n{uri}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload}"
    );
    (canonical_request, signed_headers)
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key)
        .expect("HMAC-SHA256 支持任意长度密钥");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// kDate → kRegion → kService → kSigning 派生链。
fn signing_key(secret: &str, short_date: &str, region: &str, service: &str) -> Vec<u8> {
    let k_date = hmac_sha256(format!("AWS4{secret}").as_bytes(), short_date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, service.as_bytes());
    hmac_sha256(&k_service, b"aws4_request")
}

fn sign_string(
    secret: &str,
    short_date: &str,
    amz_date: &str,
    region: &str,
    service: &str,
    canonical_request: &str,
) -> String {
    let scope = format!("{short_date}/{region}/{service}/aws4_request");
    let string_to_sign = format!(
        "{ALGORITHM}\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let key = signing_key(secret, short_date, region, service);
    hex::encode(hmac_sha256(&key, string_to_sign.as_bytes()))
}

fn insert_header(map: &mut HeaderMap, name: &str, value: &str) -> Result<(), AppError> {
    let header_name = HeaderName::from_bytes(name.as_bytes())
        .map_err(|_| AppError::InvalidInput("请求头名称不合法".into()))?;
    let header_value = HeaderValue::from_str(value)
        .map_err(|_| AppError::InvalidInput("请求头值含非法字符".into()))?;
    map.insert(header_name, header_value);
    Ok(())
}

// ---------------------------------------------------------------------------
// OAuth 2.0
// ---------------------------------------------------------------------------

/// 构造授权页 URL（授权码 / implicit 模式）。
pub fn authorize_url(
    cfg: &OAuth2Config,
    state: &str,
    challenge: Option<&str>,
) -> Result<String, AppError> {
    let auth_url = cfg
        .auth_url
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| AppError::InvalidInput("缺少 auth_url，无法生成 OAuth2 授权链接".into()))?;
    let mut url = Url::parse(auth_url)
        .map_err(|_| AppError::InvalidInput("auth_url 不是合法的 URL".into()))?;

    let response_type = if cfg.grant.eq_ignore_ascii_case("implicit") {
        "token"
    } else {
        "code"
    };
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", response_type);
        q.append_pair("state", state);
        if let Some(v) = non_empty(cfg.client_id.as_deref()) {
            q.append_pair("client_id", v);
        }
        if let Some(v) = non_empty(cfg.redirect_uri.as_deref()) {
            q.append_pair("redirect_uri", v);
        }
        if let Some(v) = non_empty(cfg.scope.as_deref()) {
            q.append_pair("scope", v);
        }
        if let Some(v) = non_empty(cfg.audience.as_deref()) {
            q.append_pair("audience", v);
        }
        if let Some(c) = non_empty(challenge) {
            q.append_pair("code_challenge", c);
            q.append_pair("code_challenge_method", "S256");
        }
    }
    Ok(url.to_string())
}

fn non_empty(v: Option<&str>) -> Option<&str> {
    v.filter(|s| !s.is_empty())
}

fn bearer_header(cfg: &OAuth2Config, state: &OAuth2TokenState) -> String {
    let prefix = cfg.token_prefix.clone().unwrap_or_else(|| {
        if state.token_type.trim().is_empty() {
            "Bearer".to_string()
        } else {
            state.token_type.clone()
        }
    });
    if prefix.trim().is_empty() {
        state.access_token.clone()
    } else {
        format!("{} {}", prefix.trim(), state.access_token)
    }
}

fn outcome_from_state(cfg: &OAuth2Config, state: OAuth2TokenState) -> AuthOutcome {
    AuthOutcome {
        headers: vec![("Authorization".to_string(), bearer_header(cfg, &state))],
        oauth2: Some(state),
        ..Default::default()
    }
}

/// token 在 `expires_at - 60s` 之后视为过期；`None` 表示永不过期。
fn token_valid(expires_at: Option<i64>, now_ms: i64) -> bool {
    match expires_at {
        None => true,
        Some(exp) => exp.saturating_sub(60_000) > now_ms,
    }
}

struct CachedToken {
    state: OAuth2TokenState,
}

fn token_cache() -> &'static Mutex<HashMap<String, CachedToken>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedToken>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(cfg: &OAuth2Config) -> String {
    format!(
        "{}|{}|{}|{}",
        cfg.token_url.as_deref().unwrap_or(""),
        cfg.client_id.as_deref().unwrap_or(""),
        cfg.grant,
        cfg.scope.as_deref().unwrap_or("")
    )
}

fn cache_get(key: &str, now_ms: i64) -> Option<OAuth2TokenState> {
    let guard = token_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard
        .get(key)
        .filter(|cached| token_valid(cached.state.expires_at, now_ms))
        .map(|cached| cached.state.clone())
}

fn cache_put(key: &str, state: OAuth2TokenState) {
    let mut guard = token_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.insert(key.to_string(), CachedToken { state });
}

fn parse_token_response(
    cfg: &OAuth2Config,
    json: &serde_json::Value,
    now_ms: i64,
) -> Result<OAuth2TokenState, AppError> {
    let access_token = json
        .get("access_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Network("OAuth2 token 响应缺少 access_token".into()))?
        .to_string();
    let refresh_token = json
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| cfg.refresh_token.clone());
    let token_type = json
        .get("token_type")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Bearer")
        .to_string();
    let expires_at = json
        .get("expires_in")
        .and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
        })
        .map(|secs| now_ms.saturating_add(secs.saturating_mul(1000)));
    Ok(OAuth2TokenState {
        access_token,
        refresh_token,
        token_type,
        expires_at,
    })
}

async fn fetch_token(cfg: &OAuth2Config, now_ms: i64) -> Result<OAuth2TokenState, AppError> {
    let token_url = cfg
        .token_url
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| AppError::InvalidInput("缺少 token_url，无法获取 OAuth2 token".into()))?;
    let client_id = cfg.client_id.clone().unwrap_or_default();
    let client_secret = cfg.client_secret.clone().unwrap_or_default();

    let mut form: Vec<(String, String)> = Vec::new();
    if let Some(refresh) = non_empty(cfg.refresh_token.as_deref()) {
        form.push(("grant_type".into(), "refresh_token".into()));
        form.push(("refresh_token".into(), refresh.to_string()));
    } else {
        let grant = cfg.grant.to_ascii_lowercase().replace(['_', '-'], "");
        match grant.as_str() {
            "clientcredentials" => {
                form.push(("grant_type".into(), "client_credentials".into()));
            }
            "password" => {
                form.push(("grant_type".into(), "password".into()));
                let username = non_empty(cfg.username.as_deref())
                    .ok_or_else(|| AppError::InvalidInput("password 模式缺少 username".into()))?;
                let password = cfg
                    .password
                    .as_deref()
                    .ok_or_else(|| AppError::InvalidInput("password 模式缺少 password".into()))?;
                form.push(("username".into(), username.to_string()));
                form.push(("password".into(), password.to_string()));
            }
            "authorizationcode" => {
                form.push(("grant_type".into(), "authorization_code".into()));
                let code = non_empty(cfg.code.as_deref())
                    .ok_or_else(|| AppError::InvalidInput("authorizationCode 模式缺少 code".into()))?;
                form.push(("code".into(), code.to_string()));
                if let Some(v) = non_empty(cfg.code_verifier.as_deref()) {
                    form.push(("code_verifier".into(), v.to_string()));
                }
                if let Some(v) = non_empty(cfg.redirect_uri.as_deref()) {
                    form.push(("redirect_uri".into(), v.to_string()));
                }
            }
            "implicit" => {
                return Err(AppError::InvalidInput(
                    "implicit 模式请先完成浏览器授权并填入 access_token".into(),
                ));
            }
            "" => {
                return Err(AppError::InvalidInput("未配置 OAuth2 grant 类型".into()));
            }
            _ => {
                return Err(AppError::InvalidInput(format!(
                    "不支持的 OAuth2 grant 类型: {}",
                    cfg.grant
                )));
            }
        }
        if let Some(v) = non_empty(cfg.scope.as_deref()) {
            form.push(("scope".into(), v.to_string()));
        }
        if let Some(v) = non_empty(cfg.audience.as_deref()) {
            form.push(("audience".into(), v.to_string()));
        }
    }

    // client_auth="basic" 用 Basic Authorization，否则凭据放表单 body。
    let basic = cfg
        .client_auth
        .as_deref()
        .map(|s| s.eq_ignore_ascii_case("basic"))
        .unwrap_or(false);
    let basic_header = if basic {
        Some(format!(
            "Basic {}",
            STANDARD.encode(format!("{client_id}:{client_secret}").as_bytes())
        ))
    } else {
        if !client_id.is_empty() {
            form.push(("client_id".into(), client_id.clone()));
        }
        if !client_secret.is_empty() {
            form.push(("client_secret".into(), client_secret.clone()));
        }
        None
    };

    let client = reqwest::Client::new();
    let mut request = client.post(token_url).form(&form);
    if let Some(value) = basic_header {
        request = request.header("Authorization", value);
    }
    let response = request
        .send()
        .await
        .map_err(|_| AppError::Network("OAuth2 token 端点请求失败".into()))?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::Network(format!(
            "OAuth2 token 端点返回 HTTP {}",
            status.as_u16()
        )));
    }
    // 不用 Response::json（reqwest 的 json feature 未启用），改为 text + serde_json。
    let body = response
        .text()
        .await
        .map_err(|_| AppError::Network("OAuth2 token 响应读取失败".into()))?;
    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| AppError::Network("OAuth2 token 响应不是合法 JSON".into()))?;
    parse_token_response(cfg, &json, now_ms)
}

pub async fn oauth2_outcome(cfg: &OAuth2Config) -> Result<AuthOutcome, AppError> {
    let now_ms = utc_now_parts().2;

    // 1) 用户显式填入且未过期的 access_token 直接复用。
    if let Some(token) = non_empty(cfg.access_token.as_deref()) {
        if token_valid(cfg.expires_at, now_ms) {
            return Ok(outcome_from_state(
                cfg,
                OAuth2TokenState {
                    access_token: token.to_string(),
                    refresh_token: cfg.refresh_token.clone(),
                    token_type: cfg
                        .token_type
                        .clone()
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| "Bearer".into()),
                    expires_at: cfg.expires_at,
                },
            ));
        }
    }

    // 2) 进程内缓存命中且未过期，避免每次请求都取 token。
    let key = cache_key(cfg);
    if let Some(state) = cache_get(&key, now_ms) {
        return Ok(outcome_from_state(cfg, state));
    }

    // 3) refresh_token 或按 grant 类型向 token 端点换取新 token。
    let state = fetch_token(cfg, now_ms).await?;
    cache_put(&key, state.clone());
    Ok(outcome_from_state(cfg, state))
}

/// 供本地回调服务器把授权码换成 token；不走缓存（授权码一次性）。
pub async fn exchange_code(
    cfg: &OAuth2Config,
    code: &str,
    verifier: Option<&str>,
) -> Result<OAuth2TokenState, AppError> {
    let mut cfg = cfg.clone();
    cfg.grant = "authorizationCode".into();
    cfg.code = Some(code.to_string());
    cfg.code_verifier = verifier.map(str::to_string);
    cfg.access_token = None;
    cfg.refresh_token = None;
    cfg.expires_at = None;
    fetch_token(&cfg, utc_now_parts().2).await
}

// ---------------------------------------------------------------------------
// AWS SigV4
// ---------------------------------------------------------------------------

pub fn sigv4_outcome(
    cfg: &SigV4Config,
    method: &str,
    url: &Url,
    headers: &HeaderMap,
    payload_hash: &str,
) -> Result<AuthOutcome, AppError> {
    if cfg.access_key_id.trim().is_empty() {
        return Err(AppError::InvalidInput("SigV4 缺少 access_key_id".into()));
    }
    if cfg.secret_access_key.is_empty() {
        return Err(AppError::InvalidInput("SigV4 缺少 secret_access_key".into()));
    }
    if cfg.region.trim().is_empty() {
        return Err(AppError::InvalidInput("SigV4 缺少 region".into()));
    }
    if cfg.service.trim().is_empty() {
        return Err(AppError::InvalidInput("SigV4 缺少 service".into()));
    }

    let (amz_date, short_date, _) = utc_now_parts();
    let scope = format!("{short_date}/{}/{}/aws4_request", cfg.region, cfg.service);
    let secret = &cfg.secret_access_key;

    if cfg.sign_query {
        // ---- 预签名 URL ----
        let expires = cfg.expires_in.unwrap_or(3600);
        let credential = format!("{}/{}", cfg.access_key_id, scope);
        let mut params: Vec<(String, String)> = vec![
            ("X-Amz-Algorithm".into(), ALGORITHM.to_string()),
            ("X-Amz-Credential".into(), credential),
            ("X-Amz-Date".into(), amz_date.clone()),
            ("X-Amz-Expires".into(), expires.to_string()),
            ("X-Amz-SignedHeaders".into(), "host".to_string()),
        ];
        if let Some(token) = non_empty(cfg.session_token.as_deref()) {
            params.push(("X-Amz-Security-Token".into(), token.to_string()));
        }

        let mut signed_url = url.clone();
        {
            let mut q = signed_url.query_pairs_mut();
            for (k, v) in &params {
                q.append_pair(k, v);
            }
        }
        // 预签名只签 host，canonical_request 会兜底注入 host 并强制 UNSIGNED-PAYLOAD。
        let (canonical, signed_headers) =
            canonical_request(method, &signed_url, &HeaderMap::new(), UNSIGNED_PAYLOAD, true);
        let signature = sign_string(
            secret,
            &short_date,
            &amz_date,
            &cfg.region,
            &cfg.service,
            &canonical,
        );
        // X-Amz-SignedHeaders 必须与 canonical request 里一致。
        params.retain(|(k, _)| k.as_str() != "X-Amz-SignedHeaders");
        params.push(("X-Amz-SignedHeaders".into(), signed_headers));
        params.push(("X-Amz-Signature".into(), signature));
        Ok(AuthOutcome {
            query: params,
            ..Default::default()
        })
    } else {
        // ---- Header 签名 ----
        let payload_value = if cfg.unsigned_payload {
            UNSIGNED_PAYLOAD.to_string()
        } else {
            payload_hash.to_string()
        };
        let mut signing_headers = headers.clone();
        signing_headers.remove(AUTHORIZATION);
        insert_header(
            &mut signing_headers,
            "host",
            &host_from_url(url).unwrap_or_default(),
        )?;
        insert_header(&mut signing_headers, "x-amz-date", &amz_date)?;
        insert_header(&mut signing_headers, "x-amz-content-sha256", &payload_value)?;
        if let Some(token) = non_empty(cfg.session_token.as_deref()) {
            insert_header(&mut signing_headers, "x-amz-security-token", token)?;
        }

        let (canonical, signed_headers) =
            canonical_request(method, url, &signing_headers, &payload_value, false);
        let signature = sign_string(
            secret,
            &short_date,
            &amz_date,
            &cfg.region,
            &cfg.service,
            &canonical,
        );
        let credential = format!("{}/{}", cfg.access_key_id, scope);
        let authorization = format!(
            "{ALGORITHM} Credential={credential}, SignedHeaders={signed_headers}, Signature={signature}"
        );

        let mut out_headers = vec![
            ("Authorization".to_string(), authorization),
            ("x-amz-date".to_string(), amz_date),
            ("x-amz-content-sha256".to_string(), payload_value),
        ];
        if let Some(token) = non_empty(cfg.session_token.as_deref()) {
            out_headers.push(("x-amz-security-token".to_string(), token.to_string()));
        }
        Ok(AuthOutcome {
            headers: out_headers,
            ..Default::default()
        })
    }
}

// ---------------------------------------------------------------------------
// mTLS
// ---------------------------------------------------------------------------

pub fn mtls_outcome(cfg: &MtlsConfig) -> Result<AuthOutcome, AppError> {
    let has_p12 = cfg
        .p12_base64
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let cert = non_empty(cfg.cert_pem.as_deref()).map(str::trim);
    let key = non_empty(cfg.key_pem.as_deref()).map(str::trim);
    let ca = non_empty(cfg.ca_pem.as_deref()).map(str::trim);

    if has_p12 && cert.is_none() && key.is_none() {
        return Err(AppError::InvalidInput(
            "PKCS#12 请先转换为 PEM 证书 + PKCS#8 私钥".into(),
        ));
    }

    let mut outcome = AuthOutcome::default();

    if cert.is_some() || key.is_some() {
        let cert = cert
            .ok_or_else(|| AppError::InvalidInput("mTLS 缺少 cert_pem（客户端证书）".into()))?;
        let key = key.ok_or_else(|| AppError::InvalidInput("mTLS 缺少 key_pem（客户端私钥）".into()))?;
        if !cert.contains("-----BEGIN CERTIFICATE-----") {
            return Err(AppError::InvalidInput(
                "cert_pem 不是合法的 PEM 证书（缺少 BEGIN CERTIFICATE）".into(),
            ));
        }
        if !key.contains("PRIVATE KEY-----") {
            return Err(AppError::InvalidInput(
                "key_pem 不是合法的 PEM 私钥（缺少 PRIVATE KEY）".into(),
            ));
        }
        outcome.identity_pem = Some(format!("{key}\n{cert}\n").into_bytes());
    }

    if let Some(ca) = ca {
        if !ca.contains("-----BEGIN CERTIFICATE-----") {
            return Err(AppError::InvalidInput(
                "ca_pem 不是合法的 PEM 证书（缺少 BEGIN CERTIFICATE）".into(),
            ));
        }
        outcome.ca_pem = Some(format!("{ca}\n").into_bytes());
    }

    let min = cfg
        .min_tls_version
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    outcome.min_tls_12 = min.contains("1.2") || min.contains("1.3");

    Ok(outcome)
}

// ---------------------------------------------------------------------------
// 测试（全部离线，不联网）
// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "auth/tests.rs"]
mod tests;
