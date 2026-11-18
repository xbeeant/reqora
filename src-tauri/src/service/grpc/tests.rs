use super::*;
use crate::service::net::parse_address;
use futures_util::future::poll_fn;

/// One proto file, one service with all four method shapes.
const HELLO_PROTO: &str = r#"
    syntax = "proto3";
    package demo.v1;
    message PingRequest { string text = 1; }
    message PingResponse { string text = 1; }
    message CountRequest { int32 from = 1; }
    message CountItem { int32 value = 1; }
    service Demo {
      rpc Ping(PingRequest) returns (PingResponse);
      rpc Stream(CountRequest) returns (stream CountItem);
      rpc Upload(stream PingRequest) returns (PingResponse);
      rpc Chat(stream PingRequest) returns (stream CountItem);
    }
"#;

fn manager_with_proto() -> (GrpcManager, String) {
    // Parallel tests can start in the same millisecond and then both write
    // the same demo.proto (PermissionDenied on Windows). Make the temp dir
    // process- and invocation-unique.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "reqora-grpc-test-{}-{}-{}",
        std::process::id(),
        crate::logging::now_millis(),
        seq,
    ));
    std::fs::create_dir_all(&dir).expect("mkdir");
    let path = dir.join("demo.proto");
    std::fs::write(&path, HELLO_PROTO).expect("write proto");
    let manager = GrpcManager::default();
    let schema = manager
        .compile(&[GrpcFileRef {
            name: "demo.proto".into(),
            path: path.display().to_string(),
            content: HELLO_PROTO.into(),
        }])
        .expect("compile");
    (manager, schema.descriptor_id)
}

#[test]
fn compile_lists_services_and_method_shapes() {
    let (manager, descriptor_id) = manager_with_proto();
    assert!(descriptor_id.len() > 8);
    let pools = manager.pools.lock().unwrap();
    assert_eq!(pools.len(), 1);
    let pool = pools.values().next().unwrap();
    let service = pool.get_service_by_name("demo.v1.Demo").expect("service");
    let methods: Vec<_> = service.methods().collect();
    assert_eq!(methods.len(), 4);
    assert!(!methods[0].is_server_streaming());
    assert!(methods[1].is_server_streaming());
    assert!(methods[2].is_client_streaming());
    assert!(methods[3].is_client_streaming() && methods[3].is_server_streaming());
}

#[test]
fn compile_rejects_empty_files_bad_proto_and_duplicates() {
    let manager = GrpcManager::default();
    assert!(manager.compile(&[]).is_err());

    let dir = std::env::temp_dir().join("reqora-grpc-bad");
    std::fs::create_dir_all(&dir).expect("mkdir");
    let path = dir.join("bad.proto");
    std::fs::write(&path, "this is not proto").expect("write");
    let error = manager
        .compile(&[GrpcFileRef {
            name: "bad.proto".into(),
            path: path.display().to_string(),
            content: String::new(),
        }])
        .unwrap_err();
    assert!(error.contains("proto 编译失败"), "got {error}");
}

#[test]
fn parse_address_variants() {
    assert_eq!(
        parse_address("127.0.0.1:50051").unwrap(),
        ("127.0.0.1".into(), 50051, false)
    );
    assert_eq!(
        parse_address("http://localhost:8080").unwrap(),
        ("localhost".into(), 8080, false)
    );
    assert_eq!(
        parse_address("https://api.example.com").unwrap(),
        ("api.example.com".into(), 443, true)
    );
    assert_eq!(
        parse_address("[::1]:9090").unwrap(),
        ("[::1]".into(), 9090, false)
    );
    assert!(parse_address("").is_err());
    assert!(parse_address("https://").is_err());
}

#[test]
fn code_names_match_grpc_codes_proto() {
    assert_eq!(code_name(0), "OK");
    assert_eq!(code_name(14), "UNAVAILABLE");
    assert_eq!(code_name(16), "UNAUTHENTICATED");
    assert_eq!(code_name(99), "UNKNOWN");
}

/// Regression: the TLS skip flag must be opt-in on all three gRPC entry
/// points (invoke / reflect / stream) and never default to insecure.
#[test]
fn tls_options_default_to_secure_and_flow_through_specs() {
    let base = r#""descriptorId":"d","address":"https://localhost:443","service":"S","method":"M","messageJson":"{}""#;
    let plain: GrpcInvokeSpec =
        serde_json::from_str(&format!("{{{base}}}")).expect("invoke spec");
    assert!(plain.tls_options().verify_tls);
    assert!(plain.tls_options().ca_pem.is_none());

    let nullish: GrpcInvokeSpec =
        serde_json::from_str(&format!("{{{base},\"verifyTls\":null}}"))
            .expect("invoke spec with null flag");
    assert!(nullish.tls_options().verify_tls);

    let off: GrpcInvokeSpec = serde_json::from_str(&format!(
        "{{{base},\"verifyTls\":false,\"caPem\":\"-----BEGIN CERTIFICATE-----\\nAA==\\n-----END CERTIFICATE-----\"}}"
    ))
    .expect("invoke spec with verification disabled");
    assert!(!off.tls_options().verify_tls);
    assert!(off.tls_options().ca_pem.is_some());

    let stream: GrpcStreamSpec = serde_json::from_str(
        r#"{"descriptorId":"d","address":"https://localhost:443","service":"S","method":"M","verifyTls":false}"#,
    )
    .expect("stream spec");
    assert!(!stream.tls_options().verify_tls);
    let stream_default: GrpcStreamSpec = serde_json::from_str(
        r#"{"descriptorId":"d","address":"localhost:1","service":"S","method":"M"}"#,
    )
    .expect("stream spec without TLS flags");
    assert!(stream_default.tls_options().verify_tls);

    let reflect_tls = crate::service::tls::TlsOptions::new(Some(false), None);
    assert!(!reflect_tls.verify_tls);
}

#[tokio::test]
async fn invoke_rejects_unknown_pool_service_method_and_client_streaming() {
    use futures_util::FutureExt;
    let (manager, descriptor_id) = manager_with_proto();
    let spec = |service: &str, method: &str| GrpcInvokeSpec {
        descriptor_id: descriptor_id.clone(),
        address: "127.0.0.1:1".into(),
        service: service.into(),
        method: method.into(),
        message_json: "{}".into(),
        headers: BTreeMap::new(),
        timeout_ms: Some(500),
        verify_tls: None,
        ca_pem: None,
    };
    let error = manager
        .invoke(spec("demo.v1.Nope", "Ping"))
        .now_or_never()
        .expect("service lookup is sync-fast")
        .unwrap_err();
    assert!(error.contains("service 不存在"), "got {error}");

    let error = manager
        .invoke(spec("demo.v1.Demo", "Nope"))
        .now_or_never()
        .unwrap()
        .unwrap_err();
    assert!(error.contains("method 不存在"), "got {error}");

    let error = manager
        .invoke(spec("demo.v1.Demo", "Upload"))
        .now_or_never()
        .unwrap()
        .unwrap_err();
    assert!(error.contains("客户端"), "got {error}");
}

#[tokio::test]
async fn invoke_fails_to_connect_and_reports_timeout() {
    let (manager, descriptor_id) = manager_with_proto();
    let spec = GrpcInvokeSpec {
        descriptor_id,
        address: "127.0.0.1:1".into(),
        service: "demo.v1.Demo".into(),
        method: "Ping".into(),
        message_json: r#"{"text": "hi"}"#.into(),
        headers: BTreeMap::new(),
        timeout_ms: Some(800),
        verify_tls: None,
        ca_pem: None,
    };
    let error = manager.invoke(spec).await.unwrap_err();
    assert!(
        error.contains("连接失败") || error.contains("超时"),
        "got {error}"
    );
}

/// Full unary + server-streaming round trip against a hand-rolled h2
/// gRPC server that also uses prost-reflect dynamic messages.
#[tokio::test]
async fn unary_and_streaming_roundtrip() {
    use tokio::net::TcpListener;

    let (manager, descriptor_id) = manager_with_proto();
    let pool = Arc::new(demo_pool());

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("addr");
    let server_task = tokio::spawn(serve_demo(listener, pool));

    // Unary.
    let unary = GrpcInvokeSpec {
        descriptor_id: descriptor_id.clone(),
        address: format!("{address}"),
        service: "demo.v1.Demo".into(),
        method: "Ping".into(),
        message_json: r#"{"text": "e2e"}"#.into(),
        headers: BTreeMap::new(),
        timeout_ms: Some(5000),
        verify_tls: None,
        ca_pem: None,
    };
    let result = manager.invoke(unary).await.expect("unary invoke");
    assert_eq!(result.status, "OK");
    assert_eq!(result.responses.len(), 1);
    assert_eq!(
        result.responses[0].pointer("/text"),
        Some(&Value::from("pong:e2e"))
    );

    // Server streaming.
    let stream = GrpcInvokeSpec {
        descriptor_id: descriptor_id.clone(),
        address: format!("{address}"),
        service: "demo.v1.Demo".into(),
        method: "Stream".into(),
        message_json: r#"{"from": 5}"#.into(),
        headers: BTreeMap::new(),
        timeout_ms: Some(5000),
        verify_tls: None,
        ca_pem: None,
    };
    let result = manager.invoke(stream).await.expect("streaming invoke");
    assert_eq!(result.status, "OK");
    assert_eq!(result.responses.len(), 2);
    assert_eq!(result.responses[0].pointer("/value"), Some(&Value::from(1)));
    assert_eq!(result.responses[1].pointer("/value"), Some(&Value::from(2)));
    server_task.abort();
}

/// Hand-rolled h2 gRPC demo server: unary/streaming methods plus a
/// minimal grpc.reflection.v1alpha implementation (ListServices +
/// FileContainingSymbol) so `reflect` round-trips end to end.
async fn serve_demo(listener: tokio::net::TcpListener, pool: Arc<DescriptorPool>) {
    loop {
        let (socket, _) = listener.accept().await.expect("accept");
        let pool = pool.clone();
        tokio::spawn(async move {
            let mut connection = h2::server::handshake(socket).await.expect("h2 handshake");
            while let Some(request) = connection.accept().await {
                let (request, mut respond) = request.expect("request");
                let pool = pool.clone();
                tokio::spawn(async move {
                    let path = request.uri().path().to_string();
                    let (_, mut body) = request.into_parts();
                    let mut received = Vec::new();
                    while let Some(chunk) = body.data().await {
                        let chunk = chunk.expect("chunk");
                        received.extend_from_slice(&chunk);
                        let _ = body.flow_control().release_capacity(chunk.len());
                        if body.is_end_stream() {
                            break;
                        }
                    }

                    if path.ends_with("ServerReflectionInfo") {
                        let reflection = reflection_pool().expect("reflection pool");
                        let request_type = reflection
                            .get_message_by_name(REQUEST_MESSAGE)
                            .expect("request message");
                        let response_type = reflection
                            .get_message_by_name(RESPONSE_MESSAGE)
                            .expect("response message");
                        // Strip the 5-byte gRPC frame header, decode the payload.
                        let payload = received.get(5..).unwrap_or(&[]);
                        let request = DynamicMessage::decode(
                            request_type.clone(),
                            bytes::Bytes::copy_from_slice(payload),
                        )
                        .expect("decode reflection request");
                        let mut reply = DynamicMessage::new(response_type.clone());
                        if request.has_field(
                            &request_type.get_field_by_name("list_services").unwrap(),
                        ) {
                            let service_type = reflection
                                .get_message_by_name("grpc.reflection.v1alpha.ServiceResponse")
                                .expect("ServiceResponse");
                            let list_type = reflection
                                .get_message_by_name(
                                    "grpc.reflection.v1alpha.ListServiceResponse",
                                )
                                .expect("ListServiceResponse");
                            let mut service = DynamicMessage::new(service_type.clone());
                            service.set_field_by_name(
                                "name",
                                prost_reflect::Value::String("demo.v1.Demo".into()),
                            );
                            let mut list = DynamicMessage::new(list_type.clone());
                            list.set_field_by_name(
                                "service",
                                prost_reflect::Value::List(vec![prost_reflect::Value::Message(
                                    service,
                                )]),
                            );
                            reply.set_field_by_name(
                                "list_services_response",
                                prost_reflect::Value::Message(list),
                            );
                        } else {
                            let fd_type = reflection
                                .get_message_by_name(
                                    "grpc.reflection.v1alpha.FileDescriptorResponse",
                                )
                                .expect("FileDescriptorResponse");
                            let file_bytes = bytes::Bytes::from(
                                pool.get_file_by_name("demo.proto")
                                    .expect("file descriptor")
                                    .encode_to_vec(),
                            );
                            let mut fd = DynamicMessage::new(fd_type.clone());
                            fd.set_field_by_name(
                                "file_descriptor_proto",
                                prost_reflect::Value::Bytes(file_bytes),
                            );
                            reply.set_field_by_name(
                                "file_descriptor_response",
                                prost_reflect::Value::Message(fd),
                            );
                        }
                        let response = http::Response::builder()
                            .status(200)
                            .header("content-type", "application/grpc")
                            .body(())
                            .unwrap();
                        let mut send =
                            respond.send_response(response, false).expect("send");
                        send_frame(&mut send, &encode_message(&reply), false).await;
                        let mut trailers = http::HeaderMap::new();
                        trailers.insert("grpc-status", "0".parse().unwrap());
                        send.send_trailers(trailers).expect("trailers");
                        return;
                    }

                    let service = pool.get_service_by_name("demo.v1.Demo").unwrap();
                    let method = if path.ends_with("Ping") {
                        service.methods().find(|m| m.name() == "Ping").unwrap()
                    } else {
                        service.methods().find(|m| m.name() == "Stream").unwrap()
                    };
                    // Strip the 5-byte gRPC frame header, decode the payload.
                    let payload = received.get(5..).unwrap_or(&[]);
                    let message = DynamicMessage::decode(
                        method.input(),
                        bytes::Bytes::copy_from_slice(payload),
                    )
                    .expect("decode request message");
                    let text = message
                        .get_field_by_name("text")
                        .and_then(|v| v.as_str().map(str::to_string))
                        .unwrap_or_default();

                    let is_unary = path.ends_with("Ping");
                    // Both shapes end via trailers (standard gRPC): data frame
                    // without EOS, then a trailers frame carrying grpc-status.
                    let response = http::Response::builder()
                        .status(200)
                        .header("content-type", "application/grpc")
                        .body(())
                        .unwrap();
                    let mut send = respond.send_response(response, false).expect("send");
                    if is_unary {
                        let mut reply = DynamicMessage::new(method.output());
                        reply.set_field_by_name(
                            "text",
                            prost_reflect::Value::String(format!("pong:{text}")),
                        );
                        send_frame(&mut send, &encode_message(&reply), false).await;
                    } else {
                        for value in 1..=2i32 {
                            let mut reply = DynamicMessage::new(method.output());
                            reply.set_field_by_name("value", prost_reflect::Value::I32(value));
                            send_frame(&mut send, &encode_message(&reply), false).await;
                        }
                    }
                    let mut trailers = http::HeaderMap::new();
                    trailers.insert("grpc-status", "0".parse().unwrap());
                    send.send_trailers(trailers).expect("trailers");
                });
            }
        });
    }
}

/// Reflection end to end: ListServices → FileContainingSymbol → invoke
/// through the reflected descriptor pool, no local .proto involved.
#[tokio::test]
async fn reflection_roundtrip_and_invoke() {
    use tokio::net::TcpListener;

    let manager = GrpcManager::default();
    let pool = Arc::new(demo_pool());
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("addr");
    let server_task = tokio::spawn(serve_demo(listener, pool));

    let schema = manager
        .reflect(
            &format!("{address}"),
            &BTreeMap::new(),
            Some(5000),
            &crate::service::tls::TlsOptions::default(),
        )
        .await
        .expect("reflect");
    assert_eq!(schema.services.len(), 1);
    let service = &schema.services[0];
    assert_eq!(service.name, "demo.v1.Demo");
    assert_eq!(service.methods.len(), 4);
    assert!(schema.files.iter().any(|f| f.contains("demo.proto")));
    // Reflected method paths feed the UI directly.
    assert!(service.methods[0].path == "/demo.v1.Demo/Ping");

    // The reflected descriptor_id works for real invocation.
    let invoke = GrpcInvokeSpec {
        descriptor_id: schema.descriptor_id,
        address: format!("{address}"),
        service: "demo.v1.Demo".into(),
        method: "Ping".into(),
        message_json: r#"{"text": "ref"}"#.into(),
        headers: BTreeMap::new(),
        timeout_ms: Some(5000),
        verify_tls: None,
        ca_pem: None,
    };
    let result = manager.invoke(invoke).await.expect("invoke");
    assert_eq!(result.status, "OK");
    assert_eq!(
        result.responses[0].pointer("/text"),
        Some(&Value::from("pong:ref"))
    );
    server_task.abort();
}

#[test]
fn reflection_pool_embeds_server_reflection_schema() {
    let pool = reflection_pool().expect("reflection pool");
    let service = pool
        .get_service_by_name("grpc.reflection.v1alpha.ServerReflection")
        .expect("reflection service");
    assert_eq!(service.methods().count(), 1);
    assert!(pool.get_message_by_name(REQUEST_MESSAGE).is_some());
    assert!(pool.get_message_by_name(RESPONSE_MESSAGE).is_some());
    // Repeated reflection_pool calls return the same compiled instance.
    assert!(std::ptr::eq(reflection_pool().unwrap(), pool));
}

fn demo_pool() -> DescriptorPool {
    let dir = std::env::temp_dir().join("reqora-grpc-demo-pool");
    std::fs::create_dir_all(&dir).expect("mkdir");
    std::fs::write(dir.join("demo.proto"), HELLO_PROTO).expect("write");
    let set = protox::compile(["demo.proto"], [&dir]).expect("compile");
    DescriptorPool::from_file_descriptor_set(set).expect("pool")
}

fn encode_message(message: &DynamicMessage) -> Vec<u8> {
    use prost::Message as _;
    let mut buf = Vec::new();
    message.encode(&mut buf).expect("encode");
    buf
}

/// Send one gRPC frame over an h2 stream, respecting flow control
/// (reserve_capacity → poll_capacity → send_data).
async fn send_frame(send: &mut h2::SendStream<bytes::Bytes>, data: &[u8], eos: bool) {
    let mut framed = Vec::with_capacity(5 + data.len());
    framed.push(0);
    framed.extend_from_slice(&(data.len() as u32).to_be_bytes());
    framed.extend_from_slice(data);

    let mut sent = 0usize;
    loop {
        if sent == framed.len() {
            return;
        }
        send.reserve_capacity(framed.len() - sent);
        match poll_fn(|cx| send.poll_capacity(cx)).await {
            Some(Ok(0)) => continue,
            Some(Ok(available)) => {
                let end = sent + available.min(framed.len() - sent);
                let last = eos && end == framed.len();
                send.send_data(bytes::Bytes::copy_from_slice(&framed[sent..end]), last)
                    .expect("send_data");
                sent = end;
                if last {
                    return;
                }
            }
            Some(Err(error)) => panic!("capacity error: {error}"),
            None => panic!("stream reset while sending"),
        }
    }
}

#[test]
fn grpc_frame_and_take_frames_handle_partial_and_compressed() {
    // Single frame: 1 flag byte, 4-byte big-endian length, then payload.
    let frame = grpc_frame(&[1, 2, 3]);
    assert_eq!(frame[0], 0);
    assert_eq!(u32::from_be_bytes([frame[1], frame[2], frame[3], frame[4]]), 3);
    assert_eq!(frame[5..].to_vec(), vec![1, 2, 3]);

    // Two frames arriving split across arbitrary DATA chunk boundaries.
    let mut wire = grpc_frame(b"ab");
    wire.extend_from_slice(&grpc_frame(b"cde"));
    let mut buffer: Vec<u8> = Vec::new();
    let mut all: Vec<Vec<u8>> = Vec::new();
    for chunk in [&wire[..3], &wire[3..8], &wire[8..]] {
        buffer.extend_from_slice(chunk);
        all.extend(take_frames(&mut buffer).expect("frames"));
    }
    assert!(buffer.is_empty());
    assert_eq!(all, vec![b"ab".to_vec(), b"cde".to_vec()]);

    // A compressed frame (flag != 0) is rejected with a Chinese error.
    let mut compressed = grpc_frame(b"x");
    compressed[0] = 1;
    assert!(take_frames(&mut compressed).unwrap_err().contains("压缩"));
}

#[test]
fn stream_method_resolution_allows_client_streaming() {
    let pool = demo_pool();
    // Unary still resolves with both flags false (invoke path unchanged).
    let ping = resolve_stream_method(&pool, "demo.v1.Demo", "Ping").expect("Ping");
    assert_eq!(ping.method_path, "/demo.v1.Demo/Ping");
    assert!(!ping.client_streaming && !ping.server_streaming);

    // Unlike GrpcManager::invoke, client-streaming methods are NOT rejected.
    let upload = resolve_stream_method(&pool, "demo.v1.Demo", "Upload").expect("Upload");
    assert!(upload.client_streaming && !upload.server_streaming);

    let chat = resolve_stream_method(&pool, "demo.v1.Demo", "Chat").expect("Chat");
    assert!(chat.client_streaming && chat.server_streaming);

    assert!(resolve_stream_method(&pool, "demo.v1.Nope", "Ping")
        .err()
        .unwrap()
        .contains("service 不存在"));
    assert!(resolve_stream_method(&pool, "demo.v1.Demo", "Nope")
        .err()
        .unwrap()
        .contains("method 不存在"));
}

/// Client/bidi streaming end to end: open, send two messages, half-close,
/// receive two echoed frames and a grpc-status=0 Done event.
#[tokio::test]
async fn stream_session_bidi_roundtrip() {
    use tauri::ipc::InvokeResponseBody;
    use tokio::net::TcpListener;

    let (manager, descriptor_id) = manager_with_proto();
    let pool = Arc::new(demo_pool());

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("addr");
    let server_task = tokio::spawn(serve_bidi(listener, pool));

    // Record every event emitted over the Channel as a JSON value.
    let events: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let channel: Channel<GrpcStreamMessage> = Channel::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            if let Ok(value) = serde_json::from_str::<Value>(&json) {
                sink.lock().unwrap().push(value);
            }
        }
        Ok::<(), tauri::Error>(())
    });

    let streams = GrpcStreamManager::new();
    let spec = GrpcStreamSpec {
        descriptor_id,
        address: format!("{address}"),
        service: "demo.v1.Demo".into(),
        method: "Chat".into(), // client_streaming + server_streaming
        headers: BTreeMap::new(),
        timeout_ms: Some(8000),
        initial_messages: vec![],
        verify_tls: None,
        ca_pem: None,
    };
    streams
        .start(&manager, "s1".into(), spec, channel)
        .await
        .expect("start");

    streams
        .send("s1", r#"{"text":"one"}"#)
        .await
        .expect("send1");
    streams
        .send("s1", r#"{"text":"two"}"#)
        .await
        .expect("send2");
    streams.close("s1").await.expect("close");

    // Wait for a terminal event (Done or Error) before asserting.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(6);
    loop {
        let done = events.lock().unwrap().iter().any(|e| {
            matches!(
                e.get("kind").and_then(|v| v.as_str()),
                Some("done") | Some("error")
            )
        });
        if done || tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    server_task.abort();

    fn kind(e: &Value) -> Option<&str> {
        e.get("kind").and_then(|v| v.as_str())
    }
    let snapshot = events.lock().unwrap().clone();
    let count_kind =
        |name: &str| snapshot.iter().filter(|e| kind(*e) == Some(name)).count();
    assert_eq!(count_kind("open"), 1, "expected one Open: {snapshot:?}");
    let open = snapshot.iter().find(|e| kind(*e) == Some("open")).unwrap();
    assert_eq!(
        open.get("clientStreaming").and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        open.get("serverStreaming").and_then(|v| v.as_bool()),
        Some(true)
    );

    let out = snapshot
        .iter()
        .filter(|e| {
            kind(e) == Some("message")
                && e.get("direction").and_then(|v| v.as_str()) == Some("out")
        })
        .count();
    let inb = snapshot
        .iter()
        .filter(|e| {
            kind(e) == Some("message")
                && e.get("direction").and_then(|v| v.as_str()) == Some("in")
        })
        .count();
    assert_eq!(out, 2, "expected 2 outgoing messages: {snapshot:?}");
    assert!(inb >= 2, "expected >=2 incoming messages: {snapshot:?}");

    let done = snapshot
        .iter()
        .find(|e| kind(*e) == Some("done"))
        .expect("Done event");
    assert_eq!(done.get("status").and_then(|v| v.as_i64()), Some(0));
}

/// Hand-rolled h2 gRPC server for a bidi method: sends response HEADERS
/// immediately, echoes one response frame per complete request frame, and
/// finishes with a grpc-status trailer once the client half-closes.
async fn serve_bidi(listener: tokio::net::TcpListener, pool: Arc<DescriptorPool>) {
    loop {
        let (socket, _) = listener.accept().await.expect("accept");
        let pool = pool.clone();
        tokio::spawn(async move {
            let mut connection = h2::server::handshake(socket).await.expect("h2 handshake");
            while let Some(request) = connection.accept().await {
                let (request, mut respond) = request.expect("request");
                let pool = pool.clone();
                tokio::spawn(async move {
                    let (_, mut body) = request.into_parts();
                    let service = pool.get_service_by_name("demo.v1.Demo").unwrap();
                    let method = service.methods().find(|m| m.name() == "Chat").unwrap();
                    let input_desc = method.input();
                    let output_desc = method.output();

                    let response = http::Response::builder()
                        .status(200)
                        .header("content-type", "application/grpc")
                        .body(())
                        .unwrap();
                    let mut send = respond
                        .send_response(response, false)
                        .expect("send_response");

                    let mut buffer: Vec<u8> = Vec::new();
                    let mut value = 1i32;
                    loop {
                        match body.data().await {
                            Some(Ok(chunk)) => {
                                let _ = body.flow_control().release_capacity(chunk.len());
                                buffer.extend_from_slice(&chunk);
                                loop {
                                    if buffer.len() < 5 {
                                        break;
                                    }
                                    let len = u32::from_be_bytes([
                                        buffer[1], buffer[2], buffer[3], buffer[4],
                                    ]) as usize;
                                    if buffer.len() < 5 + len {
                                        break;
                                    }
                                    let payload = buffer[5..5 + len].to_vec();
                                    buffer.drain(..5 + len);
                                    let _request = DynamicMessage::decode(
                                        input_desc.clone(),
                                        bytes::Bytes::from(payload),
                                    )
                                    .expect("decode request");
                                    let mut reply = DynamicMessage::new(output_desc.clone());
                                    reply.set_field_by_name(
                                        "value",
                                        prost_reflect::Value::I32(value),
                                    );
                                    value += 1;
                                    send_frame(&mut send, &encode_message(&reply), false).await;
                                }
                            }
                            Some(Err(_)) | None => break,
                        }
                    }
                    let mut trailers = http::HeaderMap::new();
                    trailers.insert("grpc-status", "0".parse().unwrap());
                    send.send_trailers(trailers).expect("trailers");
                });
            }
        });
    }
}
