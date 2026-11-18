use super::*;

const EMPTY_SHA256: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const VANILLA_CR: &str = concat!(
    "GET\n",
    "/\n",
    "\n",
    "host:examplebucket.s3.amazonaws.com\n",
    "x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n",
    "x-amz-date:20130524T000000Z\n",
    "\n",
    "host;x-amz-content-sha256;x-amz-date\n",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
);

fn sample_sigv4() -> SigV4Config {
    SigV4Config {
        access_key_id: "AKIDEXAMPLE".into(),
        secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".into(),
        region: "us-east-1".into(),
        service: "s3".into(),
        ..Default::default()
    }
}

#[test]
fn sha256_hex_known_vectors() {
    assert_eq!(sha256_hex(b""), EMPTY_SHA256);
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn canonical_request_get_vanilla_hardcoded() {
    let url = Url::parse("https://examplebucket.s3.amazonaws.com/").unwrap();
    let mut headers = HeaderMap::new();
    headers.insert(
        "host",
        HeaderValue::from_static("examplebucket.s3.amazonaws.com"),
    );
    headers.insert(
        "x-amz-date",
        HeaderValue::from_static("20130524T000000Z"),
    );
    headers.insert("x-amz-content-sha256", HeaderValue::from_static(EMPTY_SHA256));
    // 传入小写方法，验证会被规范化为大写。
    let (canonical, signed) =
        canonical_request("get", &url, &headers, EMPTY_SHA256, false);
    assert_eq!(canonical, VANILLA_CR);
    assert_eq!(signed, "host;x-amz-content-sha256;x-amz-date");
}

#[test]
fn canonical_query_sorts_and_encodes() {
    let url = Url::parse(
        "https://example.com/path?z=last&a=hello%20world&a=early&m=a/b",
    )
    .unwrap();
    assert_eq!(canonical_query(&url), "a=early&a=hello%20world&m=a%2Fb&z=last");
}

#[test]
fn canonical_uri_no_double_encoding() {
    let url = Url::parse("https://example.com/a%20b/c~d").unwrap();
    assert_eq!(canonical_uri(&url), "/a%20b/c~d");
    // url crate 会把字面空格规范化成 %20，不应出现 %2520。
    let url2 = Url::parse("https://example.com/a b").unwrap();
    assert_eq!(canonical_uri(&url2), "/a%20b");
    let (canonical, _) =
        canonical_request("GET", &url, &HeaderMap::new(), EMPTY_SHA256, false);
    assert!(!canonical.contains("%2520"));
}

#[test]
fn hmac_chain_known_values() {
    // RFC 4231 test case 2，验证 HMAC-SHA256 基础实现。
    assert_eq!(
        hex::encode(hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
    );
    // AWS 官方密钥派生链（date=20130524, region=us-east-1, service=s3）的最终 kSigning。
    let key = signing_key(
        "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        "20130524",
        "us-east-1",
        "s3",
    );
    assert_eq!(
        hex::encode(key),
        "f117494eff5d09da21cbf7f0339559ea04fc9582d31299cb992be70a6b27c97a"
    );
}

#[test]
fn signature_known_and_stable() {
    let first = sign_string(
        "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        "20130524",
        "20130524T000000Z",
        "us-east-1",
        "s3",
        VANILLA_CR,
    );
    let second = sign_string(
        "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        "20130524",
        "20130524T000000Z",
        "us-east-1",
        "s3",
        VANILLA_CR,
    );
    assert_eq!(first, second);
    assert_eq!(first.len(), 64);
    assert_eq!(
        first,
        "59d704f75576980a08333a71d37c8c7a666713ef305e7b9a6ac767f3f05dcd6d"
    );
}

#[test]
fn pkce_s256_relation() {
    let (verifier, challenge) = pkce_pair();
    assert!(verifier.len() >= 43);
    assert!(!verifier.contains('=') && !challenge.contains('='));
    assert!(
        verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    );
    assert_eq!(
        challenge,
        URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
    );
}

#[test]
fn utc_now_parts_format() {
    let (amz_date, short_date, now_ms) = utc_now_parts();
    assert_eq!(amz_date.len(), 16);
    assert_eq!(short_date.len(), 8);
    assert_eq!(&amz_date[8..9], "T");
    assert!(amz_date.ends_with('Z'));
    assert_eq!(&amz_date[..8], short_date);
    assert!(short_date.bytes().all(|b| b.is_ascii_digit()));
    assert!(now_ms > 1_600_000_000_000);
    // 纯手写日期换算的已知锚点。
    assert_eq!(civil_from_days(0), (1970, 1, 1));
    assert_eq!(civil_from_days(1), (1970, 1, 2));
    assert_eq!(civil_from_days(18_262), (2020, 1, 1));
    assert_eq!(civil_from_days(20_000), (2024, 10, 4));
}

#[test]
fn authorize_url_params() {
    let cfg = OAuth2Config {
        grant: "authorizationCode".into(),
        auth_url: Some("https://idp.example.com/oauth/authorize".into()),
        client_id: Some("client-1".into()),
        redirect_uri: Some("http://127.0.0.1:8787/cb".into()),
        scope: Some("openid profile".into()),
        audience: Some("api://default".into()),
        ..Default::default()
    };
    let url = Url::parse(&authorize_url(&cfg, "state-xyz", Some("chal-abc")).unwrap()).unwrap();
    let params: HashMap<_, _> = url.query_pairs().collect();
    assert_eq!(params.get("response_type").map(|v| v.as_ref()), Some("code"));
    assert_eq!(params.get("client_id").map(|v| v.as_ref()), Some("client-1"));
    assert_eq!(params.get("state").map(|v| v.as_ref()), Some("state-xyz"));
    assert_eq!(params.get("scope").map(|v| v.as_ref()), Some("openid profile"));
    assert_eq!(params.get("audience").map(|v| v.as_ref()), Some("api://default"));
    assert_eq!(
        params.get("redirect_uri").map(|v| v.as_ref()),
        Some("http://127.0.0.1:8787/cb")
    );
    assert_eq!(params.get("code_challenge").map(|v| v.as_ref()), Some("chal-abc"));
    assert_eq!(
        params.get("code_challenge_method").map(|v| v.as_ref()),
        Some("S256")
    );
}

#[test]
fn sigv4_header_authorization() {
    let url = Url::parse("https://examplebucket.s3.amazonaws.com/test.txt").unwrap();
    let outcome = sigv4_outcome(
        &sample_sigv4(),
        "GET",
        &url,
        &HeaderMap::new(),
        EMPTY_SHA256,
    )
    .unwrap();
    let auth = outcome
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
        .map(|(_, v)| v.clone())
        .unwrap();
    assert!(auth.starts_with("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/"));
    assert!(auth.contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date"));
    assert!(auth.contains("Signature="));
    assert!(
        outcome
            .headers
            .iter()
            .any(|(k, _)| k.as_str() == "x-amz-date")
    );
    assert!(
        outcome
            .headers
            .iter()
            .any(|(k, _)| k.as_str() == "x-amz-content-sha256")
    );
    assert!(outcome.query.is_empty());
}

#[test]
fn sigv4_presign_query_complete() {
    let mut cfg = sample_sigv4();
    cfg.sign_query = true;
    cfg.expires_in = Some(900);
    cfg.session_token = Some("session-token".into());
    let url = Url::parse("https://examplebucket.s3.amazonaws.com/test.txt").unwrap();
    let outcome =
        sigv4_outcome(&cfg, "GET", &url, &HeaderMap::new(), UNSIGNED_PAYLOAD).unwrap();
    let keys: Vec<&str> = outcome.query.iter().map(|(k, _)| k.as_str()).collect();
    for expected in [
        "X-Amz-Algorithm",
        "X-Amz-Credential",
        "X-Amz-Date",
        "X-Amz-Expires",
        "X-Amz-SignedHeaders",
        "X-Amz-Security-Token",
        "X-Amz-Signature",
    ] {
        assert!(keys.contains(&expected), "缺少预签名参数 {expected}");
    }
    let get = |name: &str| {
        outcome
            .query
            .iter()
            .find(|(k, _)| k.as_str() == name)
            .map(|(_, v)| v.clone())
            .unwrap()
    };
    assert_eq!(get("X-Amz-Algorithm"), ALGORITHM);
    assert_eq!(get("X-Amz-Expires"), "900");
    assert_eq!(get("X-Amz-SignedHeaders"), "host");
    let signature = get("X-Amz-Signature");
    assert_eq!(signature.len(), 64);
    assert!(signature.bytes().all(|b| b.is_ascii_hexdigit()));
    assert!(outcome.headers.is_empty());
}

#[test]
fn mtls_pem_concat_and_p12_error() {
    let cert = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    let key = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----";
    let ca = "-----BEGIN CERTIFICATE-----\nROOT\n-----END CERTIFICATE-----";
    let cfg = MtlsConfig {
        cert_pem: Some(cert.into()),
        key_pem: Some(key.into()),
        ca_pem: Some(ca.into()),
        min_tls_version: Some("1.2".into()),
        ..Default::default()
    };
    let outcome = mtls_outcome(&cfg).unwrap();
    assert_eq!(
        String::from_utf8(outcome.identity_pem.clone().unwrap()).unwrap(),
        format!("{key}\n{cert}\n")
    );
    assert_eq!(
        String::from_utf8(outcome.ca_pem.clone().unwrap()).unwrap(),
        format!("{ca}\n")
    );
    assert!(outcome.min_tls_12);

    // 仅提供 PKCS#12 而无 PEM：给出明确的中文转换提示。
    let p12 = MtlsConfig {
        p12_base64: Some("MIIxxx".into()),
        ..Default::default()
    };
    let err = mtls_outcome(&p12).unwrap_err();
    match err {
        AppError::InvalidInput(msg) => assert!(
            msg.contains("PKCS#12 请先转换为 PEM 证书 + PKCS#8 私钥")
        ),
        other => panic!("期望 InvalidInput，实际 {other:?}"),
    }
}

#[test]
fn mtls_rejects_invalid_pem() {
    let cfg = MtlsConfig {
        cert_pem: Some("not-a-cert".into()),
        key_pem: Some("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----".into()),
        ..Default::default()
    };
    assert!(matches!(
        mtls_outcome(&cfg),
        Err(AppError::InvalidInput(_))
    ));
}

#[tokio::test]
async fn oauth2_direct_bearer_no_network() {
    let cfg = OAuth2Config {
        grant: "authorizationCode".into(),
        access_token: Some("abc123".into()),
        token_type: Some("Bearer".into()),
        ..Default::default()
    };
    let outcome = oauth2_outcome(&cfg).await.unwrap();
    assert_eq!(
        outcome.headers[0],
        ("Authorization".to_string(), "Bearer abc123".to_string())
    );
    assert_eq!(outcome.oauth2.unwrap().access_token, "abc123");

    // token_prefix 可覆盖前缀。
    let cfg2 = OAuth2Config {
        token_prefix: Some("Token".into()),
        ..cfg
    };
    let outcome2 = oauth2_outcome(&cfg2).await.unwrap();
    assert_eq!(outcome2.headers[0].1, "Token abc123");
}

#[tokio::test]
async fn oauth2_implicit_requires_prior_auth() {
    // grant=implicit 且无 access_token：在发起任何网络请求之前就应报参数错误。
    let cfg = OAuth2Config {
        grant: "implicit".into(),
        token_url: Some("http://127.0.0.1:1/token".into()),
        ..Default::default()
    };
    assert!(matches!(
        oauth2_outcome(&cfg).await,
        Err(AppError::InvalidInput(_))
    ));
}
