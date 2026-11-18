//! Update trust-root material: the Ed25519 verifying key and manifest URL
//! policy.
//!
//! These rules are a *configuration* concern, not a sending-chain service:
//! `config` needs them to validate `REQORA_UPDATE_*` env vars at startup, and
//! `service::update` needs them at check time. Keeping them here breaks the
//! old `config -> service::update` back-edge, so `config` no longer drags the
//! whole update service (reqwest client, signature verification) into its
//! dependency closure. That is what makes an optional `update` Cargo feature
//! possible later.
//!
//! Both consumers still see the symbols at their old paths: `service::update`
//! re-exports everything below, so no external caller breaks.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;

/// Raw 32-byte Ed25519 public key used to verify official Reqora manifests.
/// Self-hosters can override it with `REQORA_UPDATE_PUBLIC_KEY` (hex or
/// base64). The matching private key is never shipped with the application.
pub const DEFAULT_UPDATE_PUBLIC_KEY_HEX: &str =
    "590cc2136bff7ae4a67d29be0179d8a5dbeecf0d27c383b091cbc328b75cd1f4";

/// Decode a 64-char hex or base64 Ed25519 public key.
pub fn decode_public_key(raw: &str) -> Result<Vec<u8>, String> {
    let trimmed = raw.trim();
    let bytes = if trimmed.len() == 64 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        decode_hex(trimmed).ok_or_else(|| "公钥 hex 格式不合法".to_string())?
    } else {
        BASE64
            .decode(trimmed)
            .map_err(|_| "REQORA_UPDATE_PUBLIC_KEY 必须是 32 字节公钥的 hex 或 base64".to_string())?
    };
    if bytes.len() != 32 {
        return Err(format!(
            "REQORA_UPDATE_PUBLIC_KEY 必须是 32 字节，实际 {} 字节",
            bytes.len()
        ));
    }
    Ok(bytes)
}

fn decode_hex(raw: &str) -> Option<Vec<u8>> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}

pub fn default_public_key() -> Vec<u8> {
    decode_public_key(DEFAULT_UPDATE_PUBLIC_KEY_HEX)
        .expect("embedded update public key must be valid hex")
}

/// Only https endpoints, or plain http on loopback (local dev servers), are
/// allowed for the update manifest. A hostile http endpoint could otherwise
/// serve a downgraded manifest over the network.
pub fn manifest_url_allowed(url: &reqwest::Url) -> bool {
    if url.scheme() == "https" {
        return true;
    }
    url.scheme() == "http" && is_loopback(url.host_str())
}

fn is_loopback(host: Option<&str>) -> bool {
    matches!(host, Some("localhost" | "127.0.0.1" | "::1" | "[::1]"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_url_policy_allows_https_and_loopback_only() {
        assert!(manifest_url_allowed(&reqwest::Url::parse("https://example.com/u.json").unwrap()));
        assert!(manifest_url_allowed(&reqwest::Url::parse("http://127.0.0.1:8080/u.json").unwrap()));
        assert!(manifest_url_allowed(&reqwest::Url::parse("http://localhost/u.json").unwrap()));
        assert!(!manifest_url_allowed(&reqwest::Url::parse("http://example.com/u.json").unwrap()));
        assert!(!manifest_url_allowed(&reqwest::Url::parse("file:///tmp/u.json").unwrap()));
    }

    #[test]
    fn public_key_decodes_hex_and_base64_and_rejects_bad_length() {
        let hex = DEFAULT_UPDATE_PUBLIC_KEY_HEX;
        let decoded = decode_public_key(hex).unwrap();
        assert_eq!(decoded.len(), 32);
        let b64 = BASE64.encode(&decoded);
        assert_eq!(decode_public_key(&b64).unwrap(), decoded);
        assert_eq!(default_public_key(), decoded);
        assert!(decode_public_key("too-short").is_err());
    }
}
