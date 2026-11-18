use super::*;
use crate::service::sse::SseParser;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread::{self, JoinHandle};

/// A server that sends SSE headers immediately and the events later, in
/// separate chunks. Proves headers are observable before the body ends and
/// that a short buffered timeout does not abort an open stream.
fn chunked_sse_server(gap: Duration) -> (String, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buffer = [0u8; 8192];
        let _ = stream.read(&mut buffer);
        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\n\
                    Cache-Control: no-cache\r\nTransfer-Encoding: chunked\r\n\
                    Connection: close\r\n\r\n";
        stream.write_all(head.as_bytes()).unwrap();
        let _ = stream.flush();
        for (index, data) in ["data: 春\n\n", "data: 天\n\n"].iter().enumerate() {
            if index == 1 {
                thread::sleep(gap);
            }
            let chunk = format!("{:x}\r\n{data}\r\n", data.len());
            let _ = stream.write_all(chunk.as_bytes());
            let _ = stream.flush();
        }
        let _ = stream.write_all(b"0\r\n\r\n");
    });
    (format!("http://{address}"), handle)
}

fn test_server(status_line: &'static str, body: &'static str) -> (String, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let handle = thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buffer = [0u8; 8192];
            let _ = stream.read(&mut buffer);
            let response = format!(
                "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    (format!("http://{address}"), handle)
}

fn spec(url: String) -> RequestSpec {
    RequestSpec {
        id: "test".into(),
        name: "test".into(),
        method: "GET".into(),
        url,
        headers: vec![],
        query: vec![],
        body: BodySpec::None,
        auth: AuthSpec::None,
        variables: BTreeMap::new(),
        timeout_secs: Some(5),
        follow_redirects: Some(false),
        verify_tls: Some(true),
        proxy_url: None,
        use_cookies: Some(false),
        http_version: None,
    }
}

fn service() -> HttpService {
    HttpService {
        config: Config::defaults(),
        cookies: Arc::new(Mutex::new(crate::service::cookies::CookieStore::default())),
    }
}

#[tokio::test]
async fn executes_request_and_parses_response() {
    let (base, server) = test_server("200 OK", r#"{"ok":true}"#);
    let response = service()
        .execute(spec(format!("{base}/v1/ping")), "rid-1")
        .await
        .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.status_text, "OK");
    assert!(response.ok);
    assert_eq!(response.body, r#"{"ok":true}"#);
    assert_eq!(response.body_kind, "json");
    assert!(response.headers.iter().any(|h| h.name == "content-type"));
    assert_eq!(response.request_id, "rid-1");
    server.join().unwrap();
}

#[tokio::test]
async fn substitutes_variables_and_merges_query_params() {
    let (base, server) = test_server("201 Created", "saved");
    let mut request = spec("{{baseUrl}}/v1/items?existing=1".into());
    request.variables.insert("baseUrl".into(), base);
    request.method = "POST".into();
    request.query = vec![KeyValue {
        id: "q1".into(),
        key: "page".into(),
        value: "{{page}}".into(),
        enabled: true,
    }];
    request.variables.insert("page".into(), "2".into());
    request.auth = AuthSpec::Bearer {
        token: "{{token}}".into(),
    };
    request.variables.insert("token".into(), "abc".into());

    let response = service().execute(request, "rid-2").await.unwrap();
    assert!(response.resolved_url.contains("existing=1"));
    assert!(response.resolved_url.contains("page=2"));
    assert!(response.resolved_url.contains("v1/items"));
    assert_eq!(response.status, 201);
    assert_eq!(response.missing_variables.len(), 0);
    server.join().unwrap();
}

#[tokio::test]
async fn reports_unresolved_variables() {
    let (base, server) = test_server("200 OK", "ok");
    let mut request = spec(format!("{base}/x"));
    request.headers = vec![KeyValue {
        id: "h1".into(),
        key: "X-Token".into(),
        value: "{{undefinedToken}}".into(),
        enabled: true,
    }];
    let response = service().execute(request, "rid-3").await.unwrap();
    assert_eq!(response.missing_variables, vec!["undefinedToken"]);
    server.join().unwrap();
}

#[tokio::test]
async fn non_2xx_is_a_successful_call_with_ok_false() {
    let (base, server) = test_server("404 Not Found", r#"{"error":"missing"}"#);
    let response = service()
        .execute(spec(format!("{base}/nope")), "rid-4")
        .await
        .unwrap();
    assert_eq!(response.status, 404);
    assert!(!response.ok);
    assert_eq!(response.status_text, "Not Found");
    server.join().unwrap();
}

#[tokio::test]
async fn rejects_unsupported_scheme_and_method() {
    let mut file_url = spec("file:///etc/passwd".into());
    file_url.url = "file:///etc/passwd".into();
    assert!(matches!(
        service().execute(file_url, "rid-5").await,
        Err(AppError::InvalidInput(_))
    ));

    let mut bad_method = spec("https://example.com".into());
    bad_method.method = "TRACE".into();
    assert!(matches!(
        service().execute(bad_method, "rid-6").await,
        Err(AppError::InvalidInput(_))
    ));
}

#[tokio::test]
async fn rejects_oversized_body_without_sending() {
    let mut request = spec("https://example.com".into());
    request.body = BodySpec::Json {
        content: "x".repeat(6 * 1024 * 1024),
    };
    assert!(matches!(
        service().execute(request, "rid-7").await,
        Err(AppError::InvalidInput(_))
    ));
}

/// A minimal HTTP/1.1 server that echoes the request body (base64) and the
/// Content-Type back as a JSON response, so tests can assert on what was
/// actually sent without any external service.
fn echo_server() -> (String, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let handle = thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut header_buf = Vec::new();
            let mut byte = [0u8; 1];
            loop {
                if stream.read(&mut byte).unwrap_or(0) == 0 {
                    break;
                }
                header_buf.push(byte[0]);
                if header_buf.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let header_str = String::from_utf8_lossy(&header_buf);
            let content_length = header_str.lines().find_map(|line| {
                if line.to_ascii_lowercase().starts_with("content-length:") {
                    line.splitn(2, ':').nth(1)?.trim().parse::<usize>().ok()
                } else {
                    None
                }
            });
            let mut body = Vec::new();
            if let Some(len) = content_length {
                let mut remaining = len;
                let mut chunk = [0u8; 4096];
                while remaining > 0 {
                    let n = stream.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    let take = n.min(remaining);
                    body.extend_from_slice(&chunk[..take]);
                    remaining -= take;
                }
            }
            let content_type = header_str
                .lines()
                .find(|line| line.to_ascii_lowercase().starts_with("content-type:"))
                .map(|line| {
                    line.splitn(2, ':')
                        .nth(1)
                        .unwrap_or("")
                        .trim()
                        .to_string()
                })
                .unwrap_or_default();
            let body_b64 = base64::engine::general_purpose::STANDARD.encode(&body);
            let escaped_ct = content_type.replace('\\', "\\\\").replace('"', "\\\"");
            let response_body =
                format!("{{\"contentType\":\"{escaped_ct}\",\"bodyB64\":\"{body_b64}\"}}");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    (format!("http://{address}"), handle)
}

fn echo_body(response: &ResponsePayload) -> (String, Vec<u8>) {
    let echoed: serde_json::Value =
        serde_json::from_str(&response.body).expect("echo server returns JSON");
    let content_type = echoed["contentType"].as_str().unwrap().to_string();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(echoed["bodyB64"].as_str().unwrap())
        .unwrap();
    (content_type, decoded)
}

#[tokio::test]
async fn sends_form_data_as_multipart() {
    let (base, server) = echo_server();
    let mut request = spec(format!("{base}/upload"));
    request.method = "POST".into();
    request.body = BodySpec::FormData {
        items: vec![
            FormPart {
                id: "1".into(),
                key: "title".into(),
                value: "hello".into(),
                enabled: true,
                file: false,
                file_name: String::new(),
                content_type: String::new(),
            },
            FormPart {
                id: "2".into(),
                key: "doc".into(),
                value: base64::engine::general_purpose::STANDARD.encode("file-bytes"),
                enabled: true,
                file: true,
                file_name: "doc.txt".into(),
                content_type: "text/plain".into(),
            },
        ],
    };
    let response = service().execute(request, "rid-fd").await.unwrap();
    assert_eq!(response.status, 200);
    let (content_type, body) = echo_body(&response);
    assert!(
        content_type.starts_with("multipart/form-data"),
        "content_type={content_type}"
    );
    let body_str = String::from_utf8_lossy(&body);
    assert!(body_str.contains("name=\"title\""), "body={body_str}");
    assert!(body_str.contains("hello"), "body={body_str}");
    assert!(body_str.contains("name=\"doc\""), "body={body_str}");
    assert!(body_str.contains("filename=\"doc.txt\""), "body={body_str}");
    assert!(body_str.contains("file-bytes"), "body={body_str}");
    server.join().unwrap();
}

/// Regression: a user-supplied `Content-Type` header must not strip the
/// boundary reqwest generated for multipart bodies. Without the boundary a
/// server cannot parse the parts, so form fields arrive as "missing".
#[tokio::test]
async fn form_data_keeps_generated_multipart_boundary_with_content_type_header() {
    let (base, server) = echo_server();
    let mut request = spec(format!("{base}/upload"));
    request.method = "POST".into();
    // Common user setup: the header is added before the body is switched
    // to form-data, so it still says application/json or a bare
    // multipart/form-data without a boundary.
    request.headers = vec![KeyValue {
        id: "h1".into(),
        key: "Content-Type".into(),
        value: "multipart/form-data".into(),
        enabled: true,
    }];
    request.body = BodySpec::FormData {
        items: vec![FormPart {
            id: "1".into(),
            key: "doc".into(),
            value: base64::engine::general_purpose::STANDARD.encode("file-bytes"),
            enabled: true,
            file: true,
            file_name: "doc.txt".into(),
            content_type: "text/plain".into(),
        }],
    };
    let response = service().execute(request, "rid-fd-ct").await.unwrap();
    let (content_type, body) = echo_body(&response);
    assert!(
        content_type.starts_with("multipart/form-data"),
        "content_type={content_type}"
    );
    assert!(
        content_type.contains("boundary="),
        "boundary lost, server cannot parse parts: content_type={content_type}"
    );
    let body_str = String::from_utf8_lossy(&body);
    assert!(body_str.contains("name=\"doc\""), "body={body_str}");
    assert!(body_str.contains("file-bytes"), "body={body_str}");
    server.join().unwrap();
}

#[tokio::test]
async fn sends_binary_body() {
    let (base, server) = echo_server();
    let mut request = spec(format!("{base}/bin"));
    request.method = "POST".into();
    let raw: &[u8] = b"raw-binary\x00data";
    request.body = BodySpec::Binary {
        data: base64::engine::general_purpose::STANDARD.encode(raw),
        file_name: "x.bin".into(),
        content_type: "application/octet-stream".into(),
    };
    let response = service().execute(request, "rid-bin").await.unwrap();
    let (content_type, body) = echo_body(&response);
    assert_eq!(content_type, "application/octet-stream");
    assert_eq!(body, raw);
    server.join().unwrap();
}

#[tokio::test]
async fn sends_graphql_payload() {
    let (base, server) = echo_server();
    let mut request = spec(format!("{base}/graphql"));
    request.method = "POST".into();
    request.body = BodySpec::GraphQL {
        query: "{ me }".into(),
        variables: "{\"id\":1}".into(),
    };
    let response = service().execute(request, "rid-gql").await.unwrap();
    let (content_type, body) = echo_body(&response);
    assert_eq!(content_type, "application/json; charset=utf-8");
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(parsed["query"], "{ me }");
    assert_eq!(parsed["variables"]["id"], 1);
    server.join().unwrap();
}

#[tokio::test]
async fn rejects_invalid_graphql_variables() {
    let mut request = spec("https://example.com".into());
    request.method = "POST".into();
    request.body = BodySpec::GraphQL {
        query: "{ me }".into(),
        variables: "not json".into(),
    };
    // Rejected during preparation (variables JSON parse) before any network.
    assert!(matches!(
        service().execute(request, "rid-bad-gql").await,
        Err(AppError::InvalidInput(_))
    ));
}

#[tokio::test]
async fn open_stream_exposes_headers_before_the_body_ends() {
    let (base, server) = chunked_sse_server(Duration::from_millis(20));
    let mut request = spec(format!("{base}/stream"));
    request.timeout_secs = Some(1);
    let opened = service().open_stream(request).await.unwrap();

    assert!(opened.meta.is_event_stream(), "content type must be detected");
    assert_eq!(opened.meta.status, 200);
    assert_eq!(opened.meta.content_type, "text/event-stream; charset=utf-8");

    let mut response = opened.response;
    let mut parser = SseParser::new();
    let mut frames = Vec::new();
    while let Some(chunk) = response.chunk().await.unwrap() {
        frames.extend(parser.push(&chunk, 1));
    }
    if let Some(tail) = parser.finish(2) {
        frames.push(tail);
    }
    assert_eq!(frames.len(), 2, "both events should arrive");
    assert_eq!(frames[0].data, "春");
    assert_eq!(frames[1].data, "天");
    server.join().unwrap();
}

#[tokio::test]
async fn streaming_survives_a_short_buffered_timeout() {
    // 1.4 s gap exceeds the request's 1 s timeout. The buffered path would
    // fail; the streaming path must still receive the second event.
    let (base, server) = chunked_sse_server(Duration::from_millis(1400));
    let mut request = spec(format!("{base}/slow-stream"));
    request.timeout_secs = Some(1);
    let opened = service().open_stream(request).await.unwrap();
    assert!(opened.meta.is_event_stream());

    let mut response = opened.response;
    let mut parser = SseParser::new();
    let mut frames = Vec::new();
    while let Some(chunk) = response.chunk().await.unwrap() {
        frames.extend(parser.push(&chunk, 1));
    }
    if let Some(tail) = parser.finish(2) {
        frames.push(tail);
    }
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[1].data, "天");
    server.join().unwrap();
}

#[tokio::test]
async fn rejects_corrupt_binary_base64() {
    let mut request = spec("https://example.com".into());
    request.method = "POST".into();
    request.body = BodySpec::Binary {
        data: "!!!not base64!!!".into(),
        file_name: "x".into(),
        content_type: "application/octet-stream".into(),
    };
    // Rejected during preparation (base64 decode) before any network.
    assert!(matches!(
        service().execute(request, "rid-bad-b64").await,
        Err(AppError::InvalidInput(_))
    ));
}

/// Two-request cookie roundtrip against a real socket: the first response
/// sets a cookie, the second request must carry it in the `Cookie` header.
/// The server handles both connections sequentially and reports what it saw.
#[tokio::test]
async fn cookie_jar_captures_and_replays_across_requests() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let seen_cookie_header = Arc::new(Mutex::new(String::new()));
    let seen_clone = Arc::clone(&seen_cookie_header);
    let connections = Arc::new(AtomicUsize::new(0));
    let connections_clone = Arc::clone(&connections);

    let server = thread::spawn(move || {
        for _ in 0..2 {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0u8; 8192];
                let _ = stream.read(&mut buffer);
                let head = String::from_utf8_lossy(&buffer);
                let cookie_header = head
                    .lines()
                    .find(|line| line.to_ascii_lowercase().starts_with("cookie:"))
                    .unwrap_or("")
                    .to_string();
                *seen_clone.lock().unwrap() = cookie_header;
                connections_clone.fetch_add(1, Ordering::Relaxed);
                let (response, close) = if connections_clone.load(Ordering::Relaxed) == 1 {
                    (
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                         Set-Cookie: sid=xyz789; Path=/\r\nContent-Length: 2\r\n\
                         Connection: keep-alive\r\n\r\n{}",
                        false,
                    )
                } else {
                    (
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                         Content-Length: 2\r\nConnection: close\r\n\r\n{}",
                        true,
                    )
                };
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
                if close {
                    break;
                }
                // First connection stays open until the client drops it.
            }
        }
    });

    let http = service();
    let mut first = spec(format!("http://{address}/login"));
    first.use_cookies = Some(true);
    http.execute(first, "rid-c1").await.unwrap();

    {
        let store = http.cookies.lock().unwrap();
        assert_eq!(store.list().len(), 1, "Set-Cookie must be captured");
        assert_eq!(store.list()[0].name, "sid");
    }

    let mut second = spec(format!("http://{address}/me"));
    second.use_cookies = Some(true);
    http.execute(second, "rid-c2").await.unwrap();
    server.join().unwrap();

    let header = seen_cookie_header.lock().unwrap().clone();
    assert!(header.to_ascii_lowercase().contains("cookie:"), "second request must carry Cookie: {header}");
    assert!(header.contains("sid=xyz789"), "cookie value must match: {header}");
}

#[tokio::test]
async fn use_cookies_false_skips_the_jar() {
    let (base, server) = test_server("200 OK", "{}");
    let http = service();
    let mut request = spec(format!("{base}/x"));
    request.use_cookies = Some(false);
    http.execute(request, "rid-c3").await.unwrap();
    assert!(http.cookies.lock().unwrap().list().is_empty());
    server.join().unwrap();
}
