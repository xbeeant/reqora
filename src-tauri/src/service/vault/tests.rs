use super::*;
use serde_json::json;

#[test]
fn seal_open_roundtrip() {
    let vault = Vault::for_tests();
    let snapshot = json!({
        "version": 1,
        "collections": [{
            "id": "c1",
            "auth": { "type": "apiKey", "key": "X-Key", "value": "plain-api-key" },
            "items": [{
                "id": "r1",
                "url": "https://example.com/api",
                "headers": [
                    { "id": "h1", "key": "Content-Type", "value": "application/json", "enabled": true },
                    { "id": "h2", "key": "Authorization", "value": "Bearer abc.def", "enabled": true }
                ],
                "auth": { "type": "bearer", "token": "bearer-secret" }
            }]
        }],
        "environments": [{
            "id": "e1",
            "name": "本地",
            "variables": [
                { "id": "v1", "key": "baseUrl", "value": "https://example.com", "enabled": true },
                { "id": "v2", "key": "password", "value": "s3cr3t", "enabled": true, "secret": true },
                { "id": "v3", "key": "alias", "value": "local-only", "enabled": true, "secret": true }
            ]
        }],
        "settings": { "timeoutSecs": 30, "aiApiKey": "sk-test" },
        "history": []
    });
    let sealed = vault.seal(&snapshot).unwrap();
    assert_eq!(vault.open(&sealed).unwrap(), snapshot, "往返必须逐字段一致");

    // No plaintext credential remains anywhere in the sealed document.
    let text = serde_json::to_string(&sealed).unwrap();
    for secret in ["plain-api-key", "Bearer abc.def", "bearer-secret", "s3cr3t", "local-only", "sk-test"] {
        assert!(!text.contains(secret), "密文不得包含 {secret}");
    }
    // Non-sensitive structure is preserved.
    assert!(text.contains("https://example.com/api"));
    assert!(text.contains("application/json"));
    assert!(text.contains("Content-Type"));
}

#[test]
fn sealing_is_idempotent_and_open_ignores_legacy_plaintext() {
    let vault = Vault::for_tests();
    let legacy = json!({ "auth": { "type": "bearer", "token": "still-plain" }, "name": "ok" });
    assert_eq!(vault.open(&legacy).unwrap(), legacy);

    let once = vault.seal(&legacy).unwrap();
    let twice = vault.seal(&once).unwrap();
    assert_eq!(once, twice, "已经加密的值不应被二次加密");
    assert_eq!(vault.open(&twice).unwrap(), legacy);
}

#[test]
fn wrong_key_fails_closed() {
    let vault = Vault::for_tests();
    let other = Vault::from_bytes(&[43u8; KEY_LEN]).unwrap();
    assert_ne!(vault.key_id, other.key_id);
    let sealed = vault.seal(&json!({ "token": "value" })).unwrap();
    assert!(other.open(&sealed).is_err(), "换密钥必须明确报错，不能把密文当明文");
}

#[test]
fn tampering_is_detected() {
    let vault = Vault::for_tests();
    let sealed = vault.seal(&json!({ "password": "hunter2" })).unwrap();
    let mut broken = sealed.clone();
    let text = broken["password"].as_str().unwrap();
    let mut chars: Vec<char> = text.chars().collect();
    let last = chars.len() - 1;
    chars[last] = if chars[last] == 'A' { 'B' } else { 'A' };
    broken["password"] = Value::String(chars.into_iter().collect());
    assert!(vault.open(&broken).is_err());
}

#[test]
fn sensitive_key_detection() {
    assert!(is_sensitive_key("Authorization"));
    assert!(is_sensitive_key("X-API-Key"));
    assert!(is_sensitive_key("client_secret"));
    assert!(is_sensitive_key("accessToken"));
    assert!(is_sensitive_key("DB_PASSWORD"));
    assert!(!is_sensitive_key("Content-Type"));
    assert!(!is_sensitive_key("baseUrl"));
    assert!(!is_sensitive_key("id"));
}

#[test]
fn decrypts_an_envelope_produced_by_the_node_vault() {
    // Built by `bin/vault.mjs#encryptTextWith` with key [42;32] and a fixed
    // nonce. Confirms both implementations agree on the AAD, nonce layout,
    // tag placement and key-id derivation — otherwise CLI/MCP could not
    // read a database written by the desktop app.
    let vault = Vault::for_tests();
    let envelope = "reqora.enc.v1.544e62ce.AQIDBAUGBwgJCgsMlxF2Jfu7B6tuYl7NijKNiJPCP52aYX3CxUZVCDuI";
    assert_eq!(vault.decrypt(envelope).unwrap(), "cross-language");
    assert_eq!(vault.open(&json!({ "token": envelope })).unwrap()["token"], "cross-language");
}

#[test]
fn key_file_is_created_with_restricted_permissions() {
    let dir = std::env::temp_dir().join(format!("reqora-vault-{}", crate::logging::now_millis()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("vault.key");
    let first = Vault::open_or_create(&path).unwrap();
    let second = Vault::open_or_create(&path).unwrap();
    assert_eq!(first.key_id, second.key_id, "重启后必须复用同一把密钥");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    let _ = std::fs::remove_dir_all(&dir);
}
