use super::*;

fn mock_ctx(query: &[(&str, &str)], headers: &[(&str, &str)], body: &str) -> RequestContext {
    RequestContext {
        query: query
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        headers: headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        body: body.to_string(),
    }
}

#[test]
fn context_body_substitutes_method_path_query_header_body() {
    let ctx = mock_ctx(
        &[("userId", "101")],
        &[("x-trace", "abc")],
        r#"{"user":{"name":"Alice"},"items":[7,8]}"#,
    );
    let rendered = render_context_body(
        r#"{"echo":{"m":"{{request.method}}","p":"{{request.path}}","u":"{{request.query.userId}}","t":"{{request.header.X-Trace}}","n":"{{request.body.user.name}}","i":"{{request.body.items.1}}","ghost":"{{request.query.missing}}"}}"#,
        "POST",
        "/api/echo",
        &ctx,
    );
    assert!(rendered.contains(r#""m":"POST""#));
    assert!(rendered.contains(r#""p":"/api/echo""#));
    assert!(rendered.contains(r#""u":"101""#));
    assert!(rendered.contains(r#""t":"abc""#));
    assert!(rendered.contains(r#""n":"Alice""#));
    assert!(rendered.contains(r#""i":"8""#));
    assert!(rendered.contains(r#""ghost":""#));
}

#[test]
fn context_body_fast_path_and_unterminated_placeholder() {
    let ctx = mock_ctx(&[], &[], "{}");
    // 无占位符：原样返回
    assert_eq!(render_context_body("plain", "GET", "/", &ctx), "plain");
    // 未闭合占位符：不 panic，保留原文
    assert_eq!(
        render_context_body("a {{request.query.x", "GET", "/", &ctx),
        "a {{request.query.x"
    );
    // 未知 request 键 → 空串；普通 {{var}} 不受影响
    let rendered = render_context_body(
        "{{request.unknown}} and {{var}}",
        "GET",
        "/",
        &ctx,
    );
    assert_eq!(rendered, " and {{var}}");
}

fn rule(id: &str, method: &str, path: &str, status: u16) -> MockRule {
    MockRule {
        id: id.into(),
        method: method.into(),
        path: path.into(),
        status,
        content_type: "application/json".into(),
        body: format!("body-of-{id}"),
        delay_ms: 0,
        smart: false,
        conditions: Vec::new(),
    }
}

fn condition(source: &str, key: &str, op: &str, value: &str) -> MockCondition {
    MockCondition {
        source: source.into(),
        key: key.into(),
        op: op.into(),
        value: value.into(),
    }
}

fn context(query: &[(&str, &str)], headers: &[(&str, &str)], body: &str) -> RequestContext {
    RequestContext {
        query: query
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        headers: headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        body: body.to_string(),
    }
}

#[test]
fn conditions_match_query_header_and_body() {
    let ctx = context(
        &[("type", "admin"), ("page", "2")],
        &[("x-token", "abc123")],
        r#"{"user": {"name": "阿明", "tags": ["vip"]}, "count": 5}"#,
    );

    // query eq
    let rules = [condition("query", "type", "eq", "admin")];
    assert!(conditions_match(&rules, &ctx));
    let rules = [condition("query", "type", "eq", "guest")];
    assert!(!conditions_match(&rules, &ctx));
    // missing query key: eq fails, ne passes, exists fails
    let rules = [condition("query", "missing", "eq", "x")];
    assert!(!conditions_match(&rules, &ctx));
    let rules = [condition("query", "missing", "ne", "x")];
    assert!(conditions_match(&rules, &ctx));
    let rules = [condition("query", "missing", "exists", "")];
    assert!(!conditions_match(&rules, &ctx));

    // header is case-insensitive on the name, contains on the value
    let rules = [condition("header", "X-Token", "contains", "bc12")];
    assert!(conditions_match(&rules, &ctx));

    // body dotted path
    let rules = [condition("body", "$.user.name", "eq", "阿明")];
    assert!(conditions_match(&rules, &ctx));
    let rules = [condition("body", "count", "eq", "5")];
    assert!(conditions_match(&rules, &ctx));
    let rules = [condition("body", "user.tags", "exists", "")];
    assert!(conditions_match(&rules, &ctx));
    let rules = [condition("body", "user.name", "ne", "小红")];
    assert!(conditions_match(&rules, &ctx));
    let rules = [condition("body", "user.missing", "eq", "x")];
    assert!(!conditions_match(&rules, &ctx));
    // non-JSON body never matches body conditions (except via ne/exists=false)
    let empty = context(&[], &[], "not json");
    let rules = [condition("body", "user", "exists", "")];
    assert!(!conditions_match(&rules, &empty));
}

#[test]
fn conditional_rules_win_over_plain_ones() {
    let mut conditional = rule("cond", "GET", "/api/list", 200);
    conditional.conditions = vec![condition("query", "type", "eq", "admin")];
    let rules = vec![conditional, rule("plain", "GET", "/api/list", 200)];

    let admin_ctx = context(&[("type", "admin")], &[], "");
    let guest_ctx = context(&[("type", "guest")], &[], "");
    assert_eq!(
        find_rule_ctx(&rules, "GET", "/api/list", &admin_ctx).unwrap().id,
        "cond"
    );
    assert_eq!(
        find_rule_ctx(&rules, "GET", "/api/list", &guest_ctx).unwrap().id,
        "plain"
    );
}

#[test]
fn smart_body_renders_typed_and_inline_tokens() {
    let mut prng = Prng::from_time();

    // Whole-string token becomes a bare JSON number.
    let rendered = render_smart_body(r#"{"age": "@integer(18,60)"}"#, &mut prng);
    let parsed: serde_json::Value = serde_json::from_str(&rendered).unwrap();
    let age = parsed["age"].as_i64().unwrap();
    assert!((18..=60).contains(&age), "got: {rendered}");

    // Float token with two decimal places.
    let rendered = render_smart_body(r#"{"price": "@float(0,100)"}"#, &mut prng);
    let parsed: serde_json::Value = serde_json::from_str(&rendered).unwrap();
    let price = parsed["price"].as_f64().unwrap();
    assert!((0.0..=100.0).contains(&price), "got: {rendered}");

    // Boolean token becomes a bare literal.
    let rendered = render_smart_body(r#"{"vip": "@boolean"}"#, &mut prng);
    let parsed: serde_json::Value = serde_json::from_str(&rendered).unwrap();
    assert!(parsed["vip"].is_boolean(), "got: {rendered}");

    // String tokens stay quoted; mixed text keeps the surrounding content.
    let rendered = render_smart_body(
        r#"{"greeting": "你好，@cname，欢迎回来！", "mail": "user@example.com"}"#,
        &mut prng,
    );
    let parsed: serde_json::Value = serde_json::from_str(&rendered).unwrap();
    let greeting = parsed["greeting"].as_str().unwrap();
    assert!(greeting.starts_with("你好，") && greeting.ends_with("，欢迎回来！"), "got: {rendered}");
    assert!(!greeting.contains("@cname"), "got: {rendered}");
    // Unknown tokens (the @example inside a literal email) survive.
    assert_eq!(parsed["mail"].as_str().unwrap(), "user@example.com");

    // Plain-text (non-JSON) bodies get inline substitution too.
    let rendered = render_smart_body("hello @name", &mut prng);
    assert!(!rendered.contains("@name"), "got: {rendered}");
    assert!(rendered.starts_with("hello "), "got: {rendered}");

    // Structure with nested arrays/objects is preserved.
    let rendered = render_smart_body(
        r#"{"list": [{"id": "@integer(1,9)"}, {"id": "@integer(1,9)"}], "ip": "@ip"}"#,
        &mut prng,
    );
    let parsed: serde_json::Value = serde_json::from_str(&rendered).unwrap();
    assert!(parsed["list"][0]["id"].as_i64().unwrap() >= 1);
    assert!(parsed["ip"].as_str().unwrap().contains('.'));
}

#[tokio::test]
async fn serves_conditional_and_smart_rules_end_to_end() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut conditional = rule("admin", "GET", "/users", 200);
    conditional.conditions = vec![condition("query", "role", "eq", "admin")];
    conditional.body = r#"{"kind": "admin-list"}"#.into();
    let mut fallback = rule("guest", "GET", "/users", 200);
    fallback.smart = true;
    fallback.body = r#"{"name": "@cname", "level": "@integer(1,3)"}"#.into();
    let rules = Arc::new(vec![conditional, fallback]);
    let log: SharedLog = Arc::new(Mutex::new(VecDeque::new()));
    let counter = Arc::new(AtomicU64::new(0));
    let shutdown = Arc::new(Notify::new());
    let server = tokio::spawn(accept_loop(
        listener,
        Arc::clone(&rules),
        Arc::clone(&log),
        Arc::clone(&counter),
        Arc::clone(&shutdown),
    ));

    // Query condition hits the conditional rule.
    let response = request(address, b"GET /users?role=admin HTTP/1.1\r\nHost: t\r\n\r\n").await;
    assert!(response.contains(r#""kind": "admin-list""#), "got: {response}");

    // Otherwise the smart fallback renders generated values.
    let response = request(address, b"GET /users HTTP/1.1\r\nHost: t\r\n\r\n").await;
    assert!(!response.contains("@cname"), "token not rendered: {response}");
    let body_start = response.find("\r\n\r\n").unwrap() + 4;
    let body = &response[body_start..];
    let parsed: serde_json::Value = serde_json::from_str(body).unwrap();
    assert!(parsed["level"].as_i64().unwrap() >= 1);
    assert!(!parsed["name"].as_str().unwrap().is_empty());

    shutdown.notify_one();
    server.await.unwrap();
}

#[test]
fn path_matches_handles_exact_and_templates() {
    assert!(path_matches("/users/1", "/users/1"));
    assert!(path_matches("/users/{id}", "/users/42"));
    assert!(path_matches("/users/{id}/posts/{postId}", "/users/1/posts/9"));
    // Leading/trailing slash and empty-segment normalisation.
    assert!(path_matches("users/{id}", "/users/1/"));
    // Root matches root.
    assert!(path_matches("/", "/"));
    // Mismatches.
    assert!(!path_matches("/users/{id}", "/users/1/posts"));
    assert!(!path_matches("/users/{id}", "/users"));
    assert!(!path_matches("/users/1", "/users/2"));
    // "{x}" is only a parameter when non-empty braces.
    assert!(!path_matches("/a/{}", "/a/b"));
}

#[test]
fn exact_rules_beat_templates_regardless_of_order() {
    let rules = vec![
        rule("tpl", "GET", "/users/{id}", 200),
        rule("exact", "GET", "/users/me", 200),
    ];
    let matched = find_rule(&rules, "GET", "/users/me").unwrap();
    assert_eq!(matched.id, "exact");
    let matched = find_rule(&rules, "GET", "/users/7").unwrap();
    assert_eq!(matched.id, "tpl");
}

#[test]
fn template_rules_pick_first_in_list_order() {
    let rules = vec![
        rule("first", "GET", "/a/{x}", 200),
        rule("second", "GET", "/a/{y}", 200),
    ];
    let matched = find_rule(&rules, "GET", "/a/1").unwrap();
    assert_eq!(matched.id, "first");
}

#[test]
fn rules_match_method_case_insensitively_and_no_match_returns_none() {
    let rules = vec![rule("get-only", "get", "/ping", 200)];
    assert!(find_rule(&rules, "GET", "/ping").is_some());
    assert!(find_rule(&rules, "POST", "/ping").is_none());
    assert!(find_rule(&rules, "GET", "/pong").is_none());
}

#[tokio::test]
async fn serves_matched_rules_and_errors_end_to_end() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let rules = Arc::new(vec![
        rule("exact", "GET", "/ping", 200),
        rule("tpl", "GET", "/users/{id}", 201),
    ]);
    let log: SharedLog = Arc::new(Mutex::new(VecDeque::new()));
    let counter = Arc::new(AtomicU64::new(0));
    let shutdown = Arc::new(Notify::new());
    let server = tokio::spawn(accept_loop(
        listener,
        Arc::clone(&rules),
        Arc::clone(&log),
        Arc::clone(&counter),
        Arc::clone(&shutdown),
    ));

    let response = request(address, b"GET /ping HTTP/1.1\r\nHost: t\r\n\r\n").await;
    assert!(response.starts_with("HTTP/1.1 200"), "got: {response}");
    assert!(response.contains("body-of-exact"));
    assert!(response.contains("Access-Control-Allow-Origin: *"));

    let response = request(address, b"GET /users/42 HTTP/1.1\r\nHost: t\r\n\r\n").await;
    assert!(response.starts_with("HTTP/1.1 201"), "got: {response}");
    assert!(response.contains("body-of-tpl"));

    // No rule matches -> 404 with the structured JSON body.
    let response = request(address, b"GET /nope HTTP/1.1\r\nHost: t\r\n\r\n").await;
    assert!(response.starts_with("HTTP/1.1 404"), "got: {response}");
    assert!(response.contains(r#""code":"MOCK_NOT_FOUND""#));
    assert!(response.contains(r#""path":"/nope""#));

    // Unsupported method -> 405.
    let response = request(address, b"TRACE /ping HTTP/1.1\r\nHost: t\r\n\r\n").await;
    assert!(response.starts_with("HTTP/1.1 405"), "got: {response}");

    shutdown.notify_one();
    server.await.unwrap();
    assert_eq!(counter.load(Ordering::Relaxed), 4);
    let log = log.lock().unwrap();
    assert_eq!(log.len(), 4);
    assert_eq!(log[0].matched_id.as_deref(), Some("exact"));
    assert_eq!(log[2].status, 404);
}

/// Fire one request against the mock and read the whole response.
async fn request(address: std::net::SocketAddr, raw: &[u8]) -> String {
    use tokio::io::AsyncWriteExt;
    let mut connection = TcpStream::connect(address).await.unwrap();
    connection.write_all(raw).await.unwrap();
    let mut response = Vec::new();
    connection.read_to_end(&mut response).await.unwrap();
    String::from_utf8_lossy(&response).into_owned()
}
