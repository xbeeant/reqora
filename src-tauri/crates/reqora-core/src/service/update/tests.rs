use super::*;
use ring::signature::{Ed25519KeyPair, KeyPair};

/// Fixed 32-byte seed, so the test public key is stable.
const TEST_SEED: [u8; 32] = [7u8; 32];

fn test_keypair() -> Ed25519KeyPair {
    Ed25519KeyPair::from_seed_unchecked(&TEST_SEED).unwrap()
}

fn signed_envelope(key: &Ed25519KeyPair, payload: &str) -> SignedEnvelope {
    SignedEnvelope {
        payload: payload.to_string(),
        signature: BASE64.encode(key.sign(payload.as_bytes()).as_ref()),
        key_id: None,
    }
}

fn far_future() -> String {
    "2099-12-31".to_string()
}

fn manifest(version: &str, url: Option<&str>, platforms: &[(&str, &str)]) -> UpdateManifest {
    UpdateManifest {
        version: version.to_string(),
        expires_at: far_future(),
        notes: None,
        pub_date: None,
        url: url.map(|url| url.to_string()),
        platforms: platforms
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect(),
    }
}

#[test]
fn parse_versions() {
    assert_eq!(
        parse_version("1.2.3"),
        Some(ParsedVersion {
            parts: vec![1, 2, 3],
            pre_release: None,
        })
    );
    assert_eq!(
        parse_version(" v2.10.0-beta.1 "),
        Some(ParsedVersion {
            parts: vec![2, 10, 0],
            pre_release: Some("beta.1".to_string()),
        })
    );
    assert_eq!(
        parse_version("1.2.3+build.7"),
        Some(ParsedVersion {
            parts: vec![1, 2, 3],
            pre_release: None,
        })
    );
    assert_eq!(parse_version(""), None);
    assert_eq!(parse_version("not.a.version"), None);
    assert_eq!(parse_version("1.x.3"), None);
}

#[test]
fn newer_detection() {
    assert!(is_newer("0.2.0", "0.1.0"));
    assert!(is_newer("1.0", "0.9.9"));
    assert!(is_newer("1.0.0.1", "1.0.0"));
    assert!(is_newer("1.0.0", "1.0.0-rc.1"));
    assert!(is_newer("1.0.0-beta.2", "1.0.0-beta.1"));
    assert!(!is_newer("0.1.0", "0.2.0"));
    assert!(!is_newer("1.0.0", "1.0.0"));
    assert!(!is_newer("v1.0.0", "1.0.0"));
    assert!(!is_newer("1.0.0-rc.1", "1.0.0"));
    assert!(!is_newer("1.0.0-beta.1", "1.0.0-beta.2"));
    assert!(!is_newer("garbage", "1.0.0"));
    assert!(!is_newer("1.0.0", "garbage"));
}

#[test]
fn platform_specific_download_wins() {
    // Use the actual host OS: a hardcoded "Windows" key only matches when
    // the test happens to run on Windows.
    let os = std::env::consts::OS;
    let m = manifest(
        "0.2.0",
        Some("https://example.com/generic.zip"),
        &[(os, "https://example.com/setup.exe")],
    );
    assert_eq!(
        pick_download_url(&m),
        Some("https://example.com/setup.exe".to_string())
    );
}

#[test]
fn falls_back_to_top_level_url() {
    let m = manifest("0.2.0", Some("https://example.com/generic.zip"), &[]);
    assert_eq!(
        pick_download_url(&m),
        Some("https://example.com/generic.zip".to_string())
    );
    let empty = manifest("0.2.0", Some("  "), &[("macos", "")]);
    assert_eq!(pick_download_url(&empty), None);
}

#[test]
fn build_result_flags_updates_and_cleans_notes() {
    let result = build_result(manifest("0.2.0", Some("https://example.com/setup.exe"), &[]));
    assert!(result.has_update);
    assert!(result.signature_verified);
    assert_eq!(result.current_version, CURRENT_VERSION);

    let same = build_result(manifest(CURRENT_VERSION, None, &[]));
    assert!(!same.has_update);
    assert_eq!(same.download_url, None);

    let mut m = manifest("0.2.0", None, &[]);
    m.notes = Some("   ".to_string());
    assert_eq!(build_result(m).notes, None);
}

#[test]
fn signature_is_verified_against_the_exact_payload_bytes() {
    let key = test_keypair();
    let public = key.public_key().as_ref().to_vec();
    let payload = r#"{"version":"0.2.0","expiresAt":"2099-12-31"}"#;
    let envelope = signed_envelope(&key, payload);
    assert!(verify_envelope(&public, &envelope).is_ok());

    // Any change to the payload — even whitespace — invalidates the signature.
    let tampered = SignedEnvelope {
        payload: format!("{payload} "),
        ..envelope.clone()
    };
    assert!(verify_envelope(&public, &tampered).is_err());

    // A different key must not verify.
    let other = Ed25519KeyPair::from_seed_unchecked(&[9u8; 32]).unwrap();
    assert!(verify_envelope(other.public_key().as_ref(), &envelope).is_err());

    // Parsing through the public JSON helper yields the inner document.
    let value = serde_json::json!({
        "payload": envelope.payload,
        "signature": envelope.signature,
    });
    let parsed = verify_envelope_json(&public, &value).unwrap();
    assert_eq!(parsed["version"], "0.2.0");
}

#[test]
fn unsigned_or_plaintext_manifest_cannot_be_parsed_as_an_envelope() {
    assert!(serde_json::from_str::<SignedEnvelope>(r#"{"version":"9.9.9"}"#).is_err());
    assert!(serde_json::from_str::<UpdateManifest>(
        r#"{"version":"9.9.9"}"#
    )
    .is_err(), "expiry is required");
}

#[test]
fn only_plain_https_download_urls_are_allowed() {
    assert!(sanitize_download_url("https://example.com/a.dmg").is_some());
    assert!(sanitize_download_url("http://example.com/a.dmg").is_none());
    assert!(sanitize_download_url("file:///etc/passwd").is_none());
    assert!(sanitize_download_url("javascript:alert(1)").is_none());
    assert!(sanitize_download_url("https://user:pass@example.com/a").is_none());
    assert!(sanitize_download_url("not-a-url").is_none());

    let m = manifest(
        "0.2.0",
        None,
        &[("macos", "file:///tmp/evil.dmg"), ("linux", "http://example.com/x")],
    );
    assert_eq!(pick_download_url(&m), None);
}

#[test]
fn expiry_bounds_replay() {
    assert!(!manifest_expired("2099-12-31"));
    assert!(manifest_expired("2000-01-01"));
    assert!(manifest_expired("not-a-date"));
    assert_eq!(parse_iso_date("1970-01-01"), Some(0));
    assert_eq!(parse_iso_date("1970-01-02"), Some(1));
}

#[test]
fn only_https_or_loopback_manifest_endpoints_are_allowed() {
    assert!(manifest_url_allowed(&reqwest::Url::parse("https://example.com/u.json").unwrap()));
    assert!(manifest_url_allowed(&reqwest::Url::parse("http://127.0.0.1:8080/u.json").unwrap()));
    assert!(!manifest_url_allowed(&reqwest::Url::parse("http://example.com/u.json").unwrap()));
    assert!(!manifest_url_allowed(&reqwest::Url::parse("file:///tmp/u.json").unwrap()));
}

#[test]
fn verifies_an_envelope_produced_by_the_node_signer() {
    // Generated by `scripts/sign-update-manifest.mjs --sign` with the fixed
    // TEST_SEED above, NOT with the release key: rotating the release trust
    // root (bun run release / release:sync-key) must not break this
    // cross-language byte-handling regression test.
    let key = test_keypair();
    let public_key = key.public_key().as_ref().to_vec();
    let envelope = serde_json::json!({
        "payload": "{\"version\":\"0.2.0\",\"expiresAt\":\"2099-12-31\",\"url\":\"https://example.com/a.dmg\"}",
        "signature": "PDdomKJvXAIhrzSGfvuflVm13cyCLWoP9lv6qyjT1fbnUcJE4I5N+HKX9khRewcwXFboCbC2XGObg4vstfmsBg==",
        "keyId": "ea4a6c63e29c520a"
    });
    let parsed = verify_envelope_json(&public_key, &envelope).unwrap();
    assert_eq!(parsed["version"], "0.2.0");
    assert_eq!(parsed["expiresAt"], "2099-12-31");

    let mut tampered = envelope;
    tampered["payload"] = serde_json::json!(
        "{\"version\":\"9.9.9\",\"expiresAt\":\"2099-12-31\",\"url\":\"https://evil.example/a.dmg\"}"
    );
    assert!(verify_envelope_json(&public_key, &tampered).is_err());
}

#[test]
fn manifest_client_builds_in_both_tls_trust_modes() {
    // The trust switch is a process-level config knob; both modes must be
    // constructible. Signature verification stays mandatory either way.
    assert!(manifest_client(true).is_ok());
    assert!(manifest_client(false).is_ok());
}

#[test]
fn public_key_decoding_accepts_hex_and_base64() {
    let hex = DEFAULT_UPDATE_PUBLIC_KEY_HEX;
    assert_eq!(decode_public_key(hex).unwrap().len(), 32);
    let b64 = BASE64.encode(decode_public_key(hex).unwrap());
    assert_eq!(decode_public_key(&b64).unwrap(), decode_public_key(hex).unwrap());
    assert!(decode_public_key("too-short").is_err());
}
