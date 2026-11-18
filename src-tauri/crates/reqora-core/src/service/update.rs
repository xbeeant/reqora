//! Update check against a configurable, **signed** manifest endpoint.
//!
//! The endpoint serves a small signed envelope. `payload` is the exact UTF-8
//! text of the manifest JSON document and `signature` is a base64 Ed25519
//! signature over those bytes. Signing the literal bytes avoids any JSON
//! canonicalisation ambiguity (key order, whitespace, number formatting).
//!
//! ```json
//! {
//!   "payload": "{\"version\":\"0.2.0\",\"expiresAt\":\"2027-11-12\", ... }",
//!   "signature": "<base64 Ed25519 signature over payload bytes>",
//!   "keyId": "optional fingerprint, informational only"
//! }
//! ```
//!
//! The inner manifest (the `payload` document) is:
//!
//! ```json
//! {
//!   "version": "0.2.0",
//!   "expiresAt": "2027-11-12",
//!   "notes": "修复……",
//!   "pubDate": "2026-11-11",
//!   "url": "https://example.com/downloads/Reqora-0.2.0-setup.exe",
//!   "platforms": {
//!     "windows": "https://example.com/downloads/Reqora-0.2.0-setup.exe",
//!     "macos": "https://example.com/downloads/Reqora-0.2.0.dmg",
//!     "linux": "https://example.com/downloads/reqora-0.2.0.AppImage"
//!   }
//! }
//! ```
//!
//! `version` and `expiresAt` are required. `expiresAt` bounds replay: an old
//! but legitimately signed manifest cannot be served forever. Download
//! addresses are restricted to plain `https` URLs without userinfo.
//!
//! The endpoint URL comes from `REQORA_UPDATE_MANIFEST_URL` (see config.rs)
//! and may be overridden per call. The verifying public key is compiled in and
//! can be replaced with `REQORA_UPDATE_PUBLIC_KEY` when self-hosting.
//! Certificate trust for the HTTPS request is a global, process-level decision
//! (`REQORA_UPDATE_VERIFY_TLS`, see config.rs): verification stays on unless a
//! self-hosted deployment with a private CA explicitly opts out. It never
//! relaxes the signature check above.
//! Generate a matching envelope with `scripts/sign-update-manifest.mjs`.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use std::error::Error as _;
use ring::signature::{ED25519, UnparsedPublicKey};
use serde::Deserialize;
use serde_json::Value;

/// Current application version. Alias of the crate-level engine version so
/// there is exactly one `CARGO_PKG_VERSION` definition (sidecar handshake and
/// update checks can never drift).
pub use crate::ENGINE_VERSION as CURRENT_VERSION;
/// Trust-root rules (public key decoding, manifest URL policy) live in the
/// dependency-free `crate::trust` module so `config` does not have to depend on
/// this service. Re-exported here to keep `service::update::*` paths stable for
/// existing callers.
pub use crate::trust::{
    DEFAULT_UPDATE_PUBLIC_KEY_HEX, decode_public_key, default_public_key, manifest_url_allowed,
};

const HTTP_TIMEOUT_SECS: u64 = 10;
/// A manifest is a few hundred bytes; cap the response so a hostile endpoint
/// cannot make the WebView allocate unbounded memory.
const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_NOTES_CHARS: usize = 20_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignedEnvelope {
    /// Exact manifest JSON text. The signature covers `payload.as_bytes()`.
    payload: String,
    /// base64 of a 64-byte Ed25519 signature.
    signature: String,
    /// Informational only; the compiled public key is the trust root.
    #[serde(default)]
    #[allow(dead_code)]
    key_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateManifest {
    #[serde(alias = "latest_version")]
    version: String,
    /// ISO `YYYY-MM-DD`. Required: bounds how long a signed manifest may be replayed.
    #[serde(alias = "expires_at")]
    expires_at: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default, alias = "pub_date")]
    pub_date: Option<String>,
    #[serde(default, alias = "download_url")]
    url: Option<String>,
    /// OS name -> download address. Keys are matched case-insensitively
    /// against `windows` / `macos` / `linux` (values of `std::env::consts::OS`).
    #[serde(default)]
    platforms: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub download_url: Option<String>,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
    /// Always true for a result derived from a remote manifest; false for the
    /// synthetic "no endpoint configured" answer. Never trust an unverified
    /// manifest, so there is no "false + remote data" state.
    pub signature_verified: bool,
}

/// Build the manifest HTTP client. `verify_tls` comes from the process-level
/// config (together with the endpoint and the public key): the default is to
/// validate certificates, and only an explicitly configured self-hosted
/// deployment with a private CA / self-signed cert may turn it off. The
/// Ed25519 signature check is independent and always enforced.
///
/// Kept as a separate pure function so both trust modes can be unit-tested
/// without a live endpoint.
pub fn manifest_client(verify_tls: bool) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
        .danger_accept_invalid_certs(!verify_tls)
        .build()
        .map_err(|error| format!("无法创建 HTTP 客户端: {error}"))
}

/// reqwest's `Display` stops at "error sending request for url (...)" and
/// hides the cause, which is precisely what tells a bad certificate apart
/// from a proxy or timeout failure. Walk the source chain instead.
fn describe_error(error: &reqwest::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = error.source();
    while let Some(cause) = source {
        let message = cause.to_string();
        if !parts.iter().any(|seen| seen == &message) {
            parts.push(message);
        }
        source = cause.source();
    }
    parts.join(" <- ")
}

/// Fetch, verify and parse the manifest. Any verification failure is a hard
/// error: no version, notes or download address reaches the UI.
pub async fn check_update(
    manifest_url: &str,
    public_key: &[u8],
    verify_tls: bool,
) -> Result<UpdateCheckResult, String> {
    let url = reqwest::Url::parse(manifest_url)
        .map_err(|_| "更新清单地址不合法，必须是完整的 http(s) URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("更新清单地址必须是 http(s) URL".to_string());
    }
    if !manifest_url_allowed(&url) {
        return Err("更新清单地址必须使用 HTTPS（仅本机回环地址允许 HTTP）".to_string());
    }
    if public_key.len() != 32 {
        return Err("更新验签公钥长度不正确（需要 32 字节 Ed25519 公钥）".to_string());
    }

    let client = manifest_client(verify_tls)?;

    let response = client
        .get(url)
        .header("Accept", "application/json")
        .header("User-Agent", format!("Reqora/{CURRENT_VERSION}"))
        .send()
        .await
        .map_err(|error| format!("连接更新服务器失败: {}", describe_error(&error)))?;

    if !response.status().is_success() {
        return Err(format!(
            "更新服务器返回异常状态: {}",
            response.status().as_u16()
        ));
    }
    if response.content_length().is_some_and(|len| len as usize > MAX_MANIFEST_BYTES) {
        return Err("更新清单体积超过上限".to_string());
    }

    // reqwest is built without the `json` feature on purpose; read the body
    // as text and parse with serde_json instead of pulling it back in.
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取更新清单失败: {error}"))?;
    if body.len() > MAX_MANIFEST_BYTES {
        return Err("更新清单体积超过上限".to_string());
    }

    let envelope: SignedEnvelope = serde_json::from_str(&body)
        .map_err(|_| "更新清单不是合法的签名信封（需要 payload 与 signature）".to_string())?;
    verify_envelope(public_key, &envelope)?;

    let manifest: UpdateManifest = serde_json::from_str(&envelope.payload)
        .map_err(|error| format!("更新清单 payload 不是合法的 manifest：{error}"))?;
    if manifest_expired(&manifest.expires_at) {
        return Err("更新清单已过期，请检查发布流程是否重新签名".to_string());
    }

    Ok(build_result(manifest))
}

/// Pure verification step, separated from I/O so tests cover it directly.
pub(crate) fn verify_envelope(public_key: &[u8], envelope: &SignedEnvelope) -> Result<(), String> {
    let signature = BASE64
        .decode(envelope.signature.trim())
        .map_err(|_| "更新清单签名不是合法的 base64".to_string())?;
    if signature.len() != 64 {
        return Err("更新清单签名长度不正确（需要 64 字节 Ed25519 签名）".to_string());
    }
    UnparsedPublicKey::new(&ED25519, public_key)
        .verify(envelope.payload.as_bytes(), &signature)
        .map_err(|_| "更新清单签名验证失败：内容被篡改、签名不匹配或公钥不正确".to_string())
}

/// Verify an envelope supplied as a JSON value (used by tests and tools).
pub fn verify_envelope_json(public_key: &[u8], value: &Value) -> Result<Value, String> {
    let envelope: SignedEnvelope = serde_json::from_value(value.clone())
        .map_err(|error| format!("签名信封格式不合法: {error}"))?;
    verify_envelope(public_key, &envelope)?;
    serde_json::from_str(&envelope.payload)
        .map_err(|error| format!("payload 不是合法 JSON: {error}"))
}

/// Pure assembly step, separated from I/O so tests cover it directly.
pub fn build_result(manifest: UpdateManifest) -> UpdateCheckResult {
    let download_url = pick_download_url(&manifest);
    let notes = manifest
        .notes
        .map(|notes| notes.chars().take(MAX_NOTES_CHARS).collect::<String>())
        .filter(|notes| !notes.trim().is_empty());
    UpdateCheckResult {
        current_version: CURRENT_VERSION.to_string(),
        has_update: is_newer(&manifest.version, CURRENT_VERSION),
        latest_version: manifest.version,
        download_url,
        notes,
        pub_date: manifest.pub_date,
        signature_verified: true,
    }
}

/// Download addresses are attacker-controlled strings inside an otherwise
/// signed document. Only plain https URLs without embedded credentials may be
/// handed to `open::that`; everything else is dropped.
pub fn sanitize_download_url(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw.trim()).ok()?;
    if url.scheme() != "https" {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    url.host_str()?;
    Some(url.to_string())
}

/// Platform-aware download address: `platforms` wins over the top-level `url`.
pub fn pick_download_url(manifest: &UpdateManifest) -> Option<String> {
    let os = std::env::consts::OS;
    if let Some(found) = manifest
        .platforms
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(os))
        .map(|(_, value)| value)
    {
        if let Some(url) = sanitize_download_url(found) {
            return Some(url);
        }
    }
    manifest.url.as_ref().and_then(|url| sanitize_download_url(url))
}

/// Days since the Unix epoch for a `YYYY-MM-DD` string.
fn parse_iso_date(raw: &str) -> Option<i64> {
    let mut parts = raw.trim().split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let day: i64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

/// Howard Hinnant's civil-date → epoch-days conversion (no date dependency).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = month;
    let doy = (153 * (m + i64::from(m > 2) * -3 + i64::from(m <= 2) * 9) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// A manifest without a valid, future expiry is rejected. This bounds replay
/// of an old but correctly signed document.
pub fn manifest_expired(expires_at: &str) -> bool {
    let Some(expires) = parse_iso_date(expires_at) else {
        return true;
    };
    let today = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| (elapsed.as_secs() / 86_400) as i64)
        .unwrap_or(0);
    expires < today
}

/// Parsed semver-ish version: numeric core plus an optional pre-release tail.
#[derive(Debug, PartialEq, Eq)]
pub struct ParsedVersion {
    parts: Vec<u64>,
    pre_release: Option<String>,
}

/// `1.2.3` -> core [1,2,3]; `1.2.3-beta.1` -> core + pre-release "beta.1".
/// Non-numeric junk after the core (e.g. `1.2.3+build`, `v1.2.3`) is tolerated
/// the same way: leading `v`/whitespace is stripped, `+metadata` is ignored.
pub fn parse_version(raw: &str) -> Option<ParsedVersion> {
    let trimmed = raw.trim().trim_start_matches(['v', 'V']);
    if trimmed.is_empty() {
        return None;
    }
    // Split off build metadata and the pre-release tail.
    let core_and_pre = trimmed.split('+').next()?;
    let (core, pre_release) = match core_and_pre.split_once('-') {
        Some((core, pre)) => (core, Some(pre.trim().to_string())),
        None => (core_and_pre, None),
    };

    let mut parts = Vec::new();
    for segment in core.split('.') {
        if segment.is_empty() || !segment.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        parts.push(segment.parse::<u64>().ok()?);
    }
    if parts.is_empty() {
        return None;
    }
    Some(ParsedVersion {
        parts,
        pre_release,
    })
}

/// True when `candidate` is strictly newer than `current`.
///
/// Numeric cores compare segment by segment (missing segments are zero);
/// a release outranks any of its pre-releases, and pre-release identifiers
/// compare numerically when both are digits, lexically otherwise.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let (Some(candidate), Some(current)) = (parse_version(candidate), parse_version(current))
    else {
        return false;
    };

    let width = candidate.parts.len().max(current.parts.len());
    for index in 0..width {
        let left = candidate.parts.get(index).copied().unwrap_or(0);
        let right = current.parts.get(index).copied().unwrap_or(0);
        if left != right {
            return left > right;
        }
    }

    match (&candidate.pre_release, &current.pre_release) {
        (None, None) => false,
        (None, Some(_)) => true,
        (Some(_), None) => false,
        (Some(left), Some(right)) => compare_pre_release(left, right) == std::cmp::Ordering::Greater,
    }
}

use std::cmp::Ordering;

fn compare_pre_release(left: &str, right: &str) -> Ordering {
    let mut left_ids = left.split('.');
    let mut right_ids = right.split('.');
    loop {
        match (left_ids.next(), right_ids.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(a), Some(b)) => {
                let ordering = match (a.parse::<u64>(), b.parse::<u64>()) {
                    (Ok(a_num), Ok(b_num)) => a_num.cmp(&b_num),
                    _ => a.cmp(b),
                };
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "update/tests.rs"]
mod tests;
