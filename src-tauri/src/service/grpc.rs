//! gRPC debugging without codegen.
//!
//! Pipeline: user picks `.proto` files → [protox] compiles them to a
//! `FileDescriptorSet` (pure Rust, no protoc) → [prost-reflect] builds a
//! `DescriptorPool` for reflection + dynamic messages → the call itself runs
//! over a hand-rolled HTTP/2 client ([h2], rustls for TLS) speaking the gRPC
//! wire protocol directly.
//!
//! Why not tonic? The client stack wraps the connection in tower `Buffer`,
//! whose call contract conflicts with how `Grpc::streaming` invokes it, and it
//! forces `Decode: Default` on dynamic messages that always carry their
//! descriptor. The gRPC wire protocol is small — POST + 5-byte framed protobuf
//! + a status trailer — so owning those ~150 lines keeps behaviour debuggable
//! and dependency-light, in line with the self-managed cookie jar / mock server.

use base64::Engine as _;
use prost::Message as _;
use prost_reflect::{
    prost_types::{FileDescriptorProto, FileDescriptorSet},
    DescriptorPool, DynamicMessage, MessageDescriptor,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use bytes::Bytes;
use tauri::ipc::Channel;
use tokio::sync::mpsc;

/// Upper bound on collected stream messages; gRPC streams can be endless.
const MAX_STREAM_MESSAGES: usize = 100;
/// One-off gRPC calls are long by nature; 60s default unless overridden.
const DEFAULT_TIMEOUT_MS: u64 = 60_000;
/// Streaming sessions have no whole-call hard deadline; the local timer is a
/// per-message idle timeout (reset on every inbound/outbound message).
const DEFAULT_IDLE_TIMEOUT_MS: u64 = 300_000;
/// Safety guard for an endless stream: emit an Error and end the session.
const MAX_STREAM_SESSION_MESSAGES: usize = 1000;
// Shared connection stack (address parsing, unified IO trait, TLS connector)
// lives in `service::net`, reused by raw TCP so an h2 ALPN can never leak into
// non-HTTP protocols. Re-export `parse_address` so the unit tests below keep
// resolving it through `use super::*`.
use crate::service::net::{AsyncIo as H2Io, connect_io};

/// A picked `.proto` file (name for display, absolute path for compilation).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcFileRef {
    pub name: String,
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcMethod {
    pub name: String,
    /// Full path used on the wire: `/package.Service/Method`.
    pub path: String,
    pub input_type: String,
    pub output_type: String,
    pub client_streaming: bool,
    pub server_streaming: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcService {
    /// Fully qualified: `package.ServiceName`.
    pub name: String,
    pub methods: Vec<GrpcMethod>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcSchema {
    /// Opaque handle for later `grpc_invoke` calls.
    pub descriptor_id: String,
    /// The files that were compiled (echoed so the UI can show them).
    pub files: Vec<String>,
    pub services: Vec<GrpcService>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GrpcInvokeSpec {
    pub descriptor_id: String,
    /// `host:port`, optionally prefixed with `https://` (TLS). Bare addresses
    /// and `http://` are plaintext.
    pub address: String,
    /// Fully qualified service name: `package.ServiceName`.
    pub service: String,
    /// Method name inside the service.
    pub method: String,
    /// Request message as proto3 JSON.
    pub message_json: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    pub timeout_ms: Option<u64>,
    /// `false` skips server certificate verification (self-signed debug servers).
    /// Missing / null means "verify" — the secure default. Ignored on plaintext.
    #[serde(default)]
    pub verify_tls: Option<bool>,
    /// PEM bundle appended to the webpki roots before verification.
    #[serde(default)]
    pub ca_pem: Option<String>,
}

impl GrpcInvokeSpec {
    fn tls_options(&self) -> crate::service::tls::TlsOptions {
        crate::service::tls::TlsOptions::new(self.verify_tls, self.ca_pem.clone())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcInvokeResult {
    /// gRPC status code name ("OK", "Unavailable", ...).
    pub status: String,
    pub message: String,
    /// Response message(s) as proto3 JSON — one for unary, N for streams.
    pub responses: Vec<Value>,
    pub elapsed_ms: u64,
    /// When true the stream was cut off at MAX_STREAM_MESSAGES.
    pub truncated: bool,
}

pub struct GrpcManager {
    pools: Mutex<HashMap<String, Arc<DescriptorPool>>>,
}

impl Default for GrpcManager {
    fn default() -> Self {
        Self {
            pools: Mutex::new(HashMap::new()),
        }
    }
}

impl GrpcManager {
    /// Compile the picked `.proto` files and cache the resulting pool.
    ///
    /// Every file's parent directory joins the include path so sibling
    /// `import` statements resolve without extra configuration.
    pub fn compile(&self, files: &[GrpcFileRef]) -> Result<GrpcSchema, String> {
        if files.is_empty() {
            return Err("请至少选择一个 .proto 文件".into());
        }
        let mut include_dirs: Vec<std::path::PathBuf> = Vec::new();
        let mut roots: Vec<String> = Vec::new();
        for file in files {
            let path = std::path::Path::new(&file.path);
            let parent = path
                .parent()
                .ok_or_else(|| format!("无法解析文件目录：{}", file.path))?;
            if !include_dirs.iter().any(|dir| dir.as_path() == parent) {
                include_dirs.push(parent.to_path_buf());
            }
            let base = path
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| format!("无法解析文件名：{}", file.path))?
                .to_string();
            if roots.contains(&base) {
                return Err(format!("存在同名 .proto 文件，无法消除歧义：{base}"));
            }
            roots.push(base);
        }

        let descriptor_set = protox::compile(&roots, &include_dirs)
            .map_err(|error| format!("proto 编译失败：{error}"))?;
        let pool = DescriptorPool::from_file_descriptor_set(descriptor_set)
            .map_err(|error| format!("构建反射池失败：{error}"))?;

        let services = services_from_pool(&pool);
        if services.is_empty() {
            return Err("编译成功，但文件中没有声明任何 service".into());
        }

        let descriptor_id = crate::logging::new_request_id();
        let schema = GrpcSchema {
            descriptor_id: descriptor_id.clone(),
            files: files.iter().map(|f| f.name.clone()).collect(),
            services,
        };
        self.cache_pool(&descriptor_id, Arc::new(pool));
        Ok(schema)
    }

    pub async fn invoke(&self, spec: GrpcInvokeSpec) -> Result<GrpcInvokeResult, String> {
        let pool = self
            .pools
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&spec.descriptor_id)
            .cloned()
            .ok_or_else(|| "proto 描述符不存在或已被回收，请重新编译".to_string())?;

        let service = pool
            .get_service_by_name(&spec.service)
            .ok_or_else(|| format!("service 不存在：{}", spec.service))?;
        let method = service
            .methods()
            .find(|m| m.name() == spec.method)
            .ok_or_else(|| format!("method 不存在：{}#{}", spec.service, spec.method))?;
        if method.is_client_streaming() {
            return Err(
                "暂不支持客户端 / 双向流式方法（需要持续上传多条消息）".to_string(),
            );
        }

        let parsed: Value = serde_json::from_str(spec.message_json.trim())
            .map_err(|error| format!("请求消息不是合法 JSON：{error}"))?;
        let request_message = DynamicMessage::deserialize(method.input(), parsed)
            .map_err(|error| format!("请求消息与 proto 类型不匹配：{error}"))?;
        let payload = encode_request(&request_message)?;

        let started = std::time::Instant::now();
        let timeout = Duration::from_millis(spec.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
        let server_streaming = method.is_server_streaming();
        let output = method.output();
        let method_path = format!("/{}/{}", service.full_name(), method.name());

        let tls = spec.tls_options();
        let run = rpc_call(
            &spec.address,
            &method_path,
            &spec.headers,
            payload,
            server_streaming,
            timeout,
            &tls,
        );
        let (frames, truncated) = match tokio::time::timeout(timeout, run).await {
            Ok(result) => result?,
            Err(_) => {
                return Err(format!("调用超时（{} ms）", timeout.as_millis()));
            }
        };
        let mut responses = Vec::with_capacity(frames.len());
        for frame in frames {
            let message = DynamicMessage::decode(output.clone(), frame.as_slice())
                .map_err(|error| format!("响应解码失败：{error}"))?;
            let value =
                serde_json::to_value(&message).map_err(|error| format!("响应序列化失败：{error}"))?;
            responses.push(value);
        }
        Ok(GrpcInvokeResult {
            status: "OK".to_string(),
            message: String::new(),
            responses,
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            truncated,
        })
    }

    /// Discover services via gRPC server reflection (grpc.reflection.v1alpha).
    ///
    /// Two kinds of reflection round trips, each a single-request / single-response
    /// call on the bidi `ServerReflectionInfo` stream (one frame + EOS, then read):
    /// `ListServices` for service names, then `FileContainingSymbol` per service to
    /// fetch serialized `FileDescriptorProto`s. The collected descriptors build a
    /// real `DescriptorPool`, cached exactly like a local compile — so the returned
    /// schema feeds `grpc_invoke` with no .proto files on disk.
    pub async fn reflect(
        &self,
        address: &str,
        headers: &BTreeMap<String, String>,
        timeout_ms: Option<u64>,
        tls: &crate::service::tls::TlsOptions,
    ) -> Result<GrpcSchema, String> {
        let reflection = reflection_pool()?;
        let request_type = reflection
            .get_message_by_name(REQUEST_MESSAGE)
            .ok_or_else(|| "内嵌 reflection proto 缺少请求消息定义".to_string())?;
        let response_type = reflection
            .get_message_by_name(RESPONSE_MESSAGE)
            .ok_or_else(|| "内嵌 reflection proto 缺少响应消息定义".to_string())?;
        let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));

        // 1. ListServices → fully qualified service names.
        let mut request = DynamicMessage::new(request_type.clone());
        request.set_field_by_name("list_services", prost_reflect::Value::String("b".into()));
        let (frames, _) = rpc_call(
            address,
            REFLECTION_PATH,
            headers,
            encode_request(&request)?,
            true,
            timeout,
            tls,
        )
        .await?;
        let mut names: Vec<String> = Vec::new();
        for frame in &frames {
            let response = DynamicMessage::decode(response_type.clone(), frame.as_slice())
                .map_err(|error| format!("reflection 响应解码失败：{error}"))?;
            let json = serde_json::to_value(&response)
                .map_err(|error| format!("reflection 响应序列化失败：{error}"))?;
            if let Some(list) = json
                .pointer("/listServicesResponse/service")
                .and_then(Value::as_array)
            {
                for entry in list {
                    if let Some(name) = entry.pointer("/name").and_then(Value::as_str) {
                        names.push(name.to_string());
                    }
                }
            }
        }
        if names.is_empty() {
            return Err(
                "服务器未通过 reflection 返回任何 service（可能未开启 reflection 服务）".into(),
            );
        }

        // 2. FileContainingSymbol per service → serialized FileDescriptorProto bytes.
        let mut unique: Vec<(String, Vec<u8>)> = Vec::new(); // (file name, raw bytes)
        for name in &names {
            let mut request = DynamicMessage::new(request_type.clone());
            request.set_field_by_name(
                "file_containing_symbol",
                prost_reflect::Value::String(name.clone()),
            );
            let (frames, _) = rpc_call(
                address,
                REFLECTION_PATH,
                headers,
                encode_request(&request)?,
                true,
                timeout,
                tls,
            )
            .await?;
            for frame in &frames {
                let response = DynamicMessage::decode(response_type.clone(), frame.as_slice())
                    .map_err(|error| format!("reflection 响应解码失败：{error}"))?;
                let json = serde_json::to_value(&response)
                    .map_err(|error| format!("reflection 响应序列化失败：{error}"))?;
                let Some(entries) = json
                    .pointer("/fileDescriptorResponse/fileDescriptorProto")
                    .and_then(Value::as_array)
                else {
                    continue;
                };
                for entry in entries {
                    let encoded = entry
                        .as_str()
                        .ok_or_else(|| "reflection 返回的文件描述符格式不正确".to_string())?;
                    let raw = base64::engine::general_purpose::STANDARD
                        .decode(encoded)
                        .map_err(|error| format!("文件描述符 base64 解码失败：{error}"))?;
                    let descriptor = FileDescriptorProto::decode(raw.as_slice())
                        .map_err(|error| format!("文件描述符解析失败：{error}"))?;
                    let file_name = descriptor.name.clone().unwrap_or_default();
                    if file_name.is_empty()
                        || unique.iter().any(|(seen, _)| seen == &file_name)
                    {
                        continue;
                    }
                    unique.push((file_name, raw));
                }
            }
        }
        if unique.is_empty() {
            return Err("服务器未返回任何文件描述符，无法构建方法定义".into());
        }

        // 3. Build a real pool so dynamic invocation works identically to local compile.
        let set = FileDescriptorSet {
            file: unique
                .iter()
                .map(|(_, raw)| FileDescriptorProto::decode(raw.as_slice()))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("文件描述符解析失败：{error}"))?,
        };
        let pool = DescriptorPool::from_file_descriptor_set(set)
            .map_err(|error| format!("构建 reflection 描述池失败：{error}"))?;
        let services = services_from_pool(&pool);
        if services.is_empty() {
            return Err("reflection 成功，但没有可调用的 service".into());
        }

        let descriptor_id = crate::logging::new_request_id();
        let schema = GrpcSchema {
            descriptor_id: descriptor_id.clone(),
            files: unique.into_iter().map(|(name, _)| name).collect(),
            services,
        };
        self.cache_pool(&descriptor_id, Arc::new(pool));
        Ok(schema)
    }

    /// Insert a pool under `descriptor_id`, evicting the oldest beyond the cap.
    fn cache_pool(&self, descriptor_id: &str, pool: Arc<DescriptorPool>) {
        let mut pools = self.pools.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(previous) = pools.remove(descriptor_id) {
            drop(previous);
        }
        while pools.len() >= 8 {
            let oldest = pools
                .keys()
                .next()
                .cloned()
                .expect("len > 0 guaranteed by while");
            pools.remove(&oldest);
        }
        pools.insert(descriptor_id.to_string(), pool);
    }
}

/// Execute one gRPC call over HTTP/2 and collect the raw response frames.
///
/// Preconditions enforced by the caller: unary or server-streaming only, the
/// request message is already protobuf-encoded, headers validated. Returns
/// 5-byte-header-stripped message payloads, or a human-readable error that
/// includes the gRPC status name when the server answered with one. Decoding
/// into a concrete descriptor is the caller's business (`invoke` knows the
/// method output type; `reflect` decodes reflection responses).
async fn rpc_call(
    address: &str,
    method_path: &str,
    headers: &BTreeMap<String, String>,
    payload: Vec<u8>,
    server_streaming: bool,
    timeout: Duration,
    tls: &crate::service::tls::TlsOptions,
) -> Result<(Vec<Vec<u8>>, bool), String> {
    let io: Box<dyn H2Io> = connect_io(address, tls, vec![b"h2".to_vec()]).await?;

    let (mut sender, connection) =
        h2::client::handshake(io).await.map_err(|error| format!("HTTP/2 握手失败：{error}"))?;
    tokio::spawn(async move {
        // Drive the connection; it ends when the request/response do.
        let _ = connection.await;
    });

    let mut builder = http::Request::builder()
        .method(http::Method::POST)
        .uri(method_path)
        .header("content-type", "application/grpc")
        .header("te", "trailers")
        .header("grpc-timeout", format!("{}m", timeout.as_millis().min(99_999_999)));
    for (key, value) in headers {
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        builder = builder.header(key, value);
    }
    let request = builder
        .body(())
        .map_err(|error| format!("构造请求失败：{error}"))?;

    let (response, mut send_stream) = sender
        .send_request(request, false)
        .map_err(|error| format!("发送请求失败：{error}"))?;

    let mut frame = Vec::with_capacity(5 + payload.len());
    frame.push(0); // uncompressed flag
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    send_stream
        .send_data(bytes::Bytes::from(frame), true)
        .map_err(|error| format!("发送消息失败：{error}"))?;

    let response = response
        .await
        .map_err(|error| format!("等待响应失败：{error}"))?;

    let headers = response.headers();
    let header_status = header_value(headers, "grpc-status");
    let header_message = header_value(headers, "grpc-message");
    if !response.status().is_success() {
        // gRPC-over-HTTP/2 requires :status 200; anything else is a transport failure.
        return Err(format!(
            "gRPC 响应 HTTP {}{}",
            response.status().as_u16(),
            header_message
                .as_deref()
                .map(|m| format!("：{m}"))
                .unwrap_or_default()
        ));
    }
    if let Some(status) = header_status.as_deref()
        && status.trim() != "0"
    {
        return Err(grpc_error_text(status, header_message.as_deref()));
    }

    // ---- read the body: buffered gRPC framing over HTTP/2 DATA frames ----
    let mut body = response.into_body();
    let mut buffer: Vec<u8> = Vec::new();
    let mut frames: Vec<Vec<u8>> = Vec::new();
    let mut truncated = false;
    loop {
        match body.data().await {
            Some(chunk) => {
                let chunk = chunk.map_err(|error| format!("读取响应失败：{error}"))?;
                let _ = body.flow_control().release_capacity(chunk.len());
                buffer.extend_from_slice(&chunk);
                loop {
                    if buffer.len() < 5 {
                        break;
                    }
                    let length = u32::from_be_bytes([buffer[1], buffer[2], buffer[3], buffer[4]])
                        as usize;
                    if buffer.len() < 5 + length {
                        break;
                    }
                    if buffer[0] != 0 {
                        return Err("收到压缩的 gRPC 消息（未支持压缩编码）".into());
                    }
                    frames.push(buffer[5..5 + length].to_vec());
                    buffer.drain(..5 + length);
                    if frames.len() >= MAX_STREAM_MESSAGES {
                        truncated = true;
                        break;
                    }
                }
                if truncated || (!server_streaming && !frames.is_empty()) {
                    // Unary: one message is the whole answer; stop reading early.
                    break;
                }
            }
            None => break, // stream ended
        }
    }

    let trailers = body
        .trailers()
        .await
        .map_err(|error| format!("读取 trailers 失败：{error}"))?;
    let final_status = trailers
        .as_ref()
        .and_then(|t| header_value(t, "grpc-status"))
        .or(header_status);
    let final_message = trailers
        .as_ref()
        .and_then(|t| header_value(t, "grpc-message"))
        .or(header_message);

    if let Some(status) = final_status
        && status.trim() != "0"
    {
        return Err(grpc_error_text(&status, final_message.as_deref()));
    }
    Ok((frames, truncated))
}

/// Convert a pool's services into the serializable service/method list.
fn services_from_pool(pool: &DescriptorPool) -> Vec<GrpcService> {
    pool.services()
        .map(|service| {
            let service_name = service.full_name().to_string();
            let methods = service
                .methods()
                .map(|method| GrpcMethod {
                    name: method.name().to_string(),
                    path: format!("/{service_name}/{}", method.name()),
                    input_type: method.input().full_name().to_string(),
                    output_type: method.output().full_name().to_string(),
                    client_streaming: method.is_client_streaming(),
                    server_streaming: method.is_server_streaming(),
                })
                .collect();
            GrpcService {
                name: service_name,
                methods,
            }
        })
        .collect()
}

/// Encode a request `DynamicMessage` to protobuf bytes.
fn encode_request(message: &DynamicMessage) -> Result<Vec<u8>, String> {
    let mut payload = Vec::new();
    message
        .encode(&mut payload)
        .map_err(|error| format!("请求编码失败：{error}"))?;
    Ok(payload)
}

/// Fully qualified path of the bidi reflection stream.
const REFLECTION_PATH: &str = "/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo";
const REQUEST_MESSAGE: &str = "grpc.reflection.v1alpha.ServerReflectionRequest";
const RESPONSE_MESSAGE: &str = "grpc.reflection.v1alpha.ServerReflectionResponse";

/// Vendored grpc.reflection.v1alpha schema (self-contained, no imports).
const REFLECTION_PROTO: &str = r#"
    syntax = "proto3";
    package grpc.reflection.v1alpha;
    service ServerReflection {
      rpc ServerReflectionInfo(stream ServerReflectionRequest)
          returns (stream ServerReflectionResponse);
    }
    message ServerReflectionRequest {
      string host = 1;
      oneof message_request {
        string file_by_filename = 3;
        string file_containing_symbol = 4;
        ExtensionRequest file_containing_extension = 5;
        string all_extension_numbers_of_type = 6;
        string list_services = 7;
      }
    }
    message ExtensionRequest {
      string containing_type = 1;
      int32 extension_number = 2;
    }
    message ServerReflectionResponse {
      string valid_host = 1;
      ServerReflectionRequest original_request = 2;
      oneof message_response {
        FileDescriptorResponse file_descriptor_response = 4;
        ExtensionNumberResponse all_extension_numbers_response = 5;
        ListServiceResponse list_services_response = 6;
        ExtensionNumberResponse extension_number_response = 7;
      }
    }
    message FileDescriptorResponse {
      repeated bytes file_descriptor_proto = 1;
    }
    message ExtensionNumberResponse {
      string base_type_name = 1;
      repeated int32 extension_number = 2;
    }
    message ListServiceResponse {
      repeated ServiceResponse service = 1;
    }
    message ServiceResponse {
      string name = 1;
    }
"#;

/// Lazily compiled pool for the vendored reflection schema (compiled once).
fn reflection_pool() -> Result<&'static DescriptorPool, String> {
    static POOL: OnceLock<Result<DescriptorPool, String>> = OnceLock::new();
    POOL.get_or_init(|| {
        let dir = std::env::temp_dir().join("reqora-grpc-reflection");
        std::fs::create_dir_all(&dir).map_err(|error| format!("创建临时目录失败：{error}"))?;
        let path = dir.join("grpc_reflection.proto");
        std::fs::write(&path, REFLECTION_PROTO)
            .map_err(|error| format!("写入内嵌 reflection proto 失败：{error}"))?;
        let set = protox::compile(["grpc_reflection.proto"], [&dir])
            .map_err(|error| format!("内嵌 reflection proto 编译失败：{error}"))?;
        DescriptorPool::from_file_descriptor_set(set)
            .map_err(|error| format!("内嵌 reflection proto 构建池失败：{error}"))
    })
    .as_ref()
    .map_err(Clone::clone)
}

fn header_value(headers: &http::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

fn grpc_error_text(status: &str, message: Option<&str>) -> String {
    let code = status.trim().parse::<i32>().unwrap_or(2);
    let name = code_name(code);
    match message {
        Some(message) if !message.is_empty() => format!("gRPC 状态 {name}({status})：{message}"),
        _ => format!("gRPC 状态 {name}({status})"),
    }
}

/// Standard gRPC status code names (grpc/codes.proto).
fn code_name(code: i32) -> &'static str {
    match code {
        0 => "OK",
        1 => "CANCELLED",
        2 => "UNKNOWN",
        3 => "INVALID_ARGUMENT",
        4 => "DEADLINE_EXCEEDED",
        5 => "NOT_FOUND",
        6 => "ALREADY_EXISTS",
        7 => "PERMISSION_DENIED",
        8 => "RESOURCE_EXHAUSTED",
        9 => "FAILED_PRECONDITION",
        10 => "ABORTED",
        11 => "OUT_OF_RANGE",
        12 => "UNIMPLEMENTED",
        13 => "INTERNAL",
        14 => "UNAVAILABLE",
        15 => "DATA_LOSS",
        16 => "UNAUTHENTICATED",
        _ => "UNKNOWN",
    }
}

// ---- Client / bidirectional streaming sessions --------------------------------
//
// `rpc_call` above is a one-shot request (one frame + immediate EOS) that
// buffers every response frame before returning. Streaming needs the opposite:
// the request stream stays open, commands arrive over a channel, and each
// inbound frame is pushed to the UI as soon as it is decoded. One spawned task
// (driven by `tokio::select!`) owns the lifecycle; the manager only keeps a
// command sender per session id.

/// Launch parameters for a streaming gRPC session.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcStreamSpec {
    pub descriptor_id: String,
    pub address: String,
    pub service: String,
    pub method: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// Per-message idle timeout override; defaults to 5 minutes (no 60s cap).
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// JSON strings sent in order right after Open (never auto-EOS).
    #[serde(default)]
    pub initial_messages: Vec<String>,
    /// Same TLS knobs as `GrpcInvokeSpec`; missing `verifyTls` means verify.
    #[serde(default)]
    pub verify_tls: Option<bool>,
    #[serde(default)]
    pub ca_pem: Option<String>,
}

impl GrpcStreamSpec {
    fn tls_options(&self) -> crate::service::tls::TlsOptions {
        crate::service::tls::TlsOptions::new(self.verify_tls, self.ca_pem.clone())
    }
}

/// Timeline events pushed to the frontend over a Tauri `Channel`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GrpcStreamMessage {
    Open {
        session_id: String,
        method_path: String,
        client_streaming: bool,
        server_streaming: bool,
        at_ms: u64,
    },
    Message {
        direction: String,
        json: Value,
        at_ms: u64,
    },
    Done {
        status: i64,
        message: String,
        at_ms: u64,
    },
    Error {
        code: String,
        message: String,
    },
}

/// Out-of-band commands for a live session, from `send` / `close` / `cancel`.
enum StreamCommand {
    Send(String),
    Close,
    Cancel,
}

struct GrpcStreamHandle {
    commands: mpsc::UnboundedSender<StreamCommand>,
}

/// Owns the live streaming sessions. `Arc<tokio::sync::Mutex<...>>` keeps the
/// manager `Send + Sync` and lets each task remove itself on completion.
pub struct GrpcStreamManager {
    sessions: Arc<tokio::sync::Mutex<HashMap<String, GrpcStreamHandle>>>,
}

impl Default for GrpcStreamManager {
    fn default() -> Self {
        Self::new()
    }
}

impl GrpcStreamManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }

    /// Open a streaming call. Client-streaming / bidi methods are allowed here
    /// (unlike `GrpcManager::invoke`, whose unary rejection is left untouched).
    pub async fn start(
        &self,
        pools: &GrpcManager,
        session_id: String,
        spec: GrpcStreamSpec,
        channel: Channel<GrpcStreamMessage>,
    ) -> Result<(), String> {
        let pool = pools
            .pools
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&spec.descriptor_id)
            .cloned()
            .ok_or_else(|| "proto 描述符不存在或已被回收，请重新编译".to_string())?;
        let resolved = resolve_stream_method(&pool, &spec.service, &spec.method)?;
        let StreamMethod {
            method_path,
            input,
            output,
            client_streaming,
            server_streaming,
        } = resolved;

        // Reuse the exact connection stack from `rpc_call`.
        let tls = spec.tls_options();
        let io: Box<dyn H2Io> = connect_io(&spec.address, &tls, vec![b"h2".to_vec()]).await?;
        let (mut sender, connection) = h2::client::handshake(io)
            .await
            .map_err(|error| format!("HTTP/2 握手失败：{error}"))?;
        tokio::spawn(async move {
            let _ = connection.await;
        });

        let idle = Duration::from_millis(spec.timeout_ms.unwrap_or(DEFAULT_IDLE_TIMEOUT_MS));
        let mut builder = http::Request::builder()
            .method(http::Method::POST)
            .uri(method_path.as_str())
            .header("content-type", "application/grpc")
            .header("te", "trailers")
            .header("grpc-timeout", format!("{}m", idle.as_millis().min(99_999_999)));
        for (key, value) in &spec.headers {
            let key = key.trim();
            if key.is_empty() {
                continue;
            }
            builder = builder.header(key, value);
        }
        let request = builder
            .body(())
            .map_err(|error| format!("构造请求失败：{error}"))?;

        // `false` keeps the request stream open for later `send` / `close`.
        let (response, send_stream) = sender
            .send_request(request, false)
            .map_err(|error| format!("发送请求失败：{error}"))?;

        emit_stream(
            &channel,
            GrpcStreamMessage::Open {
                session_id: session_id.clone(),
                method_path: method_path.clone(),
                client_streaming,
                server_streaming,
                at_ms: crate::logging::now_millis(),
            },
        );

        let (command_tx, command_rx) = mpsc::unbounded_channel::<StreamCommand>();
        // Queue initial messages after Open; never auto-EOS (user closes).
        for json in &spec.initial_messages {
            let _ = command_tx.send(StreamCommand::Send(json.clone()));
        }

        let sessions = self.sessions.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            // Keep a SendRequest handle alive so the h2 connection is not
            // dropped out from under the still-running stream.
            let _send_request_guard = sender;
            run_stream_session(response, send_stream, command_rx, input, output, channel, idle)
                .await;
            sessions.lock().await.remove(&sid);
        });

        // Atomic check-and-insert under a single lock hold. The previous
        // check-then-insert spanned two scopes with `await`s in between, so two
        // concurrent starts with the same id could both pass the check.
        {
            let mut sessions = self.sessions.lock().await;
            if let std::collections::hash_map::Entry::Occupied(_) = sessions.entry(session_id.clone()) {
                return Err(format!("会话已存在：{session_id}"));
            }
            sessions.insert(session_id, GrpcStreamHandle { commands: command_tx });
        }
        Ok(())
    }

    pub async fn send(&self, session_id: &str, message_json: &str) -> Result<(), String> {
        let commands = self
            .sessions
            .lock()
            .await
            .get(session_id)
            .map(|handle| handle.commands.clone())
            .ok_or_else(|| format!("会话不存在或已结束：{session_id}"))?;
        commands
            .send(StreamCommand::Send(message_json.to_string()))
            .map_err(|_| "会话已关闭，无法发送消息".to_string())
    }

    /// Half-close: queued messages are sent first, then EOS (END_STREAM).
    pub async fn close(&self, session_id: &str) -> Result<(), String> {
        let commands = self
            .sessions
            .lock()
            .await
            .get(session_id)
            .map(|handle| handle.commands.clone())
            .ok_or_else(|| format!("会话不存在或已结束：{session_id}"))?;
        commands
            .send(StreamCommand::Close)
            .map_err(|_| "会话已关闭，无法结束发送".to_string())
    }

    /// Interrupt immediately: RST_STREAM via a Cancel command, drop the handle
    /// (idempotent — a finished session simply returns Ok).
    pub async fn cancel(&self, session_id: &str) -> Result<(), String> {
        let handle = self.sessions.lock().await.remove(session_id);
        if let Some(handle) = handle {
            let _ = handle.commands.send(StreamCommand::Cancel);
        }
        Ok(())
    }
}

/// Resolved method metadata for a streaming session. Unlike `invoke`, this
/// does NOT reject client-streaming / bidi methods.
struct StreamMethod {
    method_path: String,
    input: MessageDescriptor,
    output: MessageDescriptor,
    client_streaming: bool,
    server_streaming: bool,
}

fn resolve_stream_method(
    pool: &DescriptorPool,
    service: &str,
    method: &str,
) -> Result<StreamMethod, String> {
    let svc = pool
        .get_service_by_name(service)
        .ok_or_else(|| format!("service 不存在：{service}"))?;
    let m = svc
        .methods()
        .find(|m| m.name() == method)
        .ok_or_else(|| format!("method 不存在：{service}#{method}"))?;
    Ok(StreamMethod {
        method_path: format!("/{}/{}", svc.full_name(), m.name()),
        input: m.input(),
        output: m.output(),
        client_streaming: m.is_client_streaming(),
        server_streaming: m.is_server_streaming(),
    })
}

/// Build one gRPC frame: 1 compression flag + 4-byte big-endian length + payload.
fn grpc_frame(payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(5 + payload.len());
    frame.push(0); // uncompressed
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

/// Drain every complete, uncompressed gRPC frame from `buffer`, leaving a
/// partial frame in place for the next DATA chunk.
fn take_frames(buffer: &mut Vec<u8>) -> Result<Vec<Vec<u8>>, String> {
    let mut frames = Vec::new();
    loop {
        if buffer.len() < 5 {
            break;
        }
        let length = u32::from_be_bytes([buffer[1], buffer[2], buffer[3], buffer[4]]) as usize;
        if buffer.len() < 5 + length {
            break;
        }
        if buffer[0] != 0 {
            return Err("收到压缩的 gRPC 消息（未支持压缩编码）".into());
        }
        frames.push(buffer[5..5 + length].to_vec());
        buffer.drain(..5 + length);
    }
    Ok(frames)
}

fn emit_stream(channel: &Channel<GrpcStreamMessage>, message: GrpcStreamMessage) {
    let _ = channel.send(message);
}

/// Send one request message frame, honouring HTTP/2 flow control, and keep the
/// stream open (`end_of_stream = false` on every DATA chunk).
async fn stream_send_message(
    send: &mut h2::SendStream<Bytes>,
    payload: &[u8],
) -> Result<(), String> {
    let framed = grpc_frame(payload);
    let mut sent = 0usize;
    while sent < framed.len() {
        send.reserve_capacity(framed.len() - sent);
        match std::future::poll_fn(|cx| send.poll_capacity(cx)).await {
            Some(Ok(0)) => continue,
            Some(Ok(available)) => {
                let end = sent + available.min(framed.len() - sent);
                send.send_data(Bytes::copy_from_slice(&framed[sent..end]), false)
                    .map_err(|error| format!("发送消息失败：{error}"))?;
                sent = end;
            }
            Some(Err(error)) => return Err(format!("发送消息失败：{error}")),
            None => return Err("连接已关闭，无法发送消息".into()),
        }
    }
    Ok(())
}

/// Handle one command. Returns `true` when the session should terminate.
async fn handle_stream_command(
    command: StreamCommand,
    send: &mut h2::SendStream<Bytes>,
    input: &MessageDescriptor,
    channel: &Channel<GrpcStreamMessage>,
) -> bool {
    match command {
        StreamCommand::Send(json) => {
            let parsed: Value = match serde_json::from_str(json.trim()) {
                Ok(value) => value,
                Err(error) => {
                    emit_stream(
                        channel,
                        GrpcStreamMessage::Error {
                            code: "request".into(),
                            message: format!("消息不是合法 JSON：{error}"),
                        },
                    );
                    return false;
                }
            };
            let message = match DynamicMessage::deserialize(input.clone(), parsed) {
                Ok(message) => message,
                Err(error) => {
                    emit_stream(
                        channel,
                        GrpcStreamMessage::Error {
                            code: "request".into(),
                            message: format!("消息与 proto 类型不匹配：{error}"),
                        },
                    );
                    return false;
                }
            };
            let payload = match encode_request(&message) {
                Ok(payload) => payload,
                Err(error) => {
                    emit_stream(
                        channel,
                        GrpcStreamMessage::Error {
                            code: "encode".into(),
                            message: error,
                        },
                    );
                    return false;
                }
            };
            if let Err(error) = stream_send_message(send, &payload).await {
                emit_stream(
                    channel,
                    GrpcStreamMessage::Error {
                        code: "send".into(),
                        message: error,
                    },
                );
                return true;
            }
            let value = serde_json::to_value(&message).unwrap_or(Value::Null);
            emit_stream(
                channel,
                GrpcStreamMessage::Message {
                    direction: "out".into(),
                    json: value,
                    at_ms: crate::logging::now_millis(),
                },
            );
            false
        }
        StreamCommand::Close => {
            // Half-close: emit EOS only, no extra (empty) gRPC message frame.
            let _ = send.send_data(Bytes::new(), true);
            false
        }
        StreamCommand::Cancel => {
            let _ = send.send_reset(h2::Reason::CANCEL);
            emit_stream(
                channel,
                GrpcStreamMessage::Error {
                    code: "cancelled".into(),
                    message: "会话已取消".into(),
                },
            );
            true
        }
    }
}

/// Drive one session: outbound commands, inbound frames, trailers, idle timer.
async fn run_stream_session(
    response: h2::client::ResponseFuture,
    mut send_stream: h2::SendStream<Bytes>,
    mut command_rx: mpsc::UnboundedReceiver<StreamCommand>,
    input: MessageDescriptor,
    output: MessageDescriptor,
    channel: Channel<GrpcStreamMessage>,
    idle: Duration,
) {
    // ---- Phase 1: wait for response HEADERS, still serving outbound commands ----
    // Some servers only send HEADERS after reading request DATA / EOS, so the
    // response future must NOT be awaited before commands can be processed.
    let mut response = Box::pin(response);
    let mut deadline = tokio::time::Instant::now() + idle;
    let response = loop {
        tokio::select! {
            biased;
            command = command_rx.recv() => {
                match command {
                    Some(command) => {
                        if handle_stream_command(command, &mut send_stream, &input, &channel).await {
                            return;
                        }
                    }
                    None => return,
                }
                deadline = tokio::time::Instant::now() + idle;
            }
            result = &mut response => break result,
            _ = tokio::time::sleep_until(deadline) => {
                emit_stream(&channel, GrpcStreamMessage::Error {
                    code: "timeout".into(),
                    message: "会话空闲超时，已结束".into(),
                });
                return;
            }
        }
    };

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            emit_stream(
                &channel,
                GrpcStreamMessage::Error {
                    code: "transport".into(),
                    message: format!("等待响应失败：{error}"),
                },
            );
            return;
        }
    };
    let header_status = header_value(response.headers(), "grpc-status");
    let header_message = header_value(response.headers(), "grpc-message");
    if !response.status().is_success() {
        emit_stream(
            &channel,
            GrpcStreamMessage::Error {
                code: "transport".into(),
                message: format!(
                    "gRPC 响应 HTTP {}{}",
                    response.status().as_u16(),
                    header_message
                        .as_deref()
                        .map(|m| format!("：{m}"))
                        .unwrap_or_default()
                ),
            },
        );
        return;
    }
    // Trailers-Only responses carry the final status in HEADERS.
    if let Some(status) = header_status.as_deref()
        && status.trim() != "0"
    {
        emit_stream(
            &channel,
            GrpcStreamMessage::Done {
                status: status.trim().parse::<i64>().unwrap_or(2),
                message: header_message.clone().unwrap_or_default(),
                at_ms: crate::logging::now_millis(),
            },
        );
        return;
    }

    // ---- Phase 2: interleave inbound frames, outbound commands, idle timer ----
    let mut body = response.into_body();
    let mut buffer: Vec<u8> = Vec::new();
    let mut received = 0usize;
    deadline = tokio::time::Instant::now() + idle;
    'session: loop {
        tokio::select! {
            chunk = body.data() => {
                match chunk {
                    Some(Ok(chunk)) => {
                        let _ = body.flow_control().release_capacity(chunk.len());
                        buffer.extend_from_slice(&chunk);
                        match take_frames(&mut buffer) {
                            Ok(frames) => {
                                for frame in frames {
                                    match DynamicMessage::decode(output.clone(), frame.as_slice()) {
                                        Ok(message) => {
                                            let json = serde_json::to_value(&message).unwrap_or(Value::Null);
                                            emit_stream(&channel, GrpcStreamMessage::Message {
                                                direction: "in".into(),
                                                json,
                                                at_ms: crate::logging::now_millis(),
                                            });
                                            received += 1;
                                            if received >= MAX_STREAM_SESSION_MESSAGES {
                                                emit_stream(&channel, GrpcStreamMessage::Error {
                                                    code: "limit".into(),
                                                    message: format!(
                                                        "响应消息超过上限（{} 条），已结束会话",
                                                        MAX_STREAM_SESSION_MESSAGES
                                                    ),
                                                });
                                                break 'session;
                                            }
                                        }
                                        Err(error) => {
                                            emit_stream(&channel, GrpcStreamMessage::Error {
                                                code: "decode".into(),
                                                message: format!("响应解码失败：{error}"),
                                            });
                                            break 'session;
                                        }
                                    }
                                }
                            }
                            Err(error) => {
                                emit_stream(&channel, GrpcStreamMessage::Error {
                                    code: "decode".into(),
                                    message: error,
                                });
                                break 'session;
                            }
                        }
                    }
                    Some(Err(error)) => {
                        emit_stream(&channel, GrpcStreamMessage::Error {
                            code: "transport".into(),
                            message: format!("读取响应失败：{error}"),
                        });
                        break 'session;
                    }
                    None => {
                        let trailers = body.trailers().await.ok().flatten();
                        let status = trailers
                            .as_ref()
                            .and_then(|t| header_value(t, "grpc-status"))
                            .or(header_status.clone());
                        let message = trailers
                            .as_ref()
                            .and_then(|t| header_value(t, "grpc-message"))
                            .or(header_message.clone())
                            .unwrap_or_default();
                        let code = status
                            .as_deref()
                            .and_then(|s| s.trim().parse::<i64>().ok())
                            .unwrap_or(0);
                        emit_stream(&channel, GrpcStreamMessage::Done {
                            status: code,
                            message,
                            at_ms: crate::logging::now_millis(),
                        });
                        break 'session;
                    }
                }
                deadline = tokio::time::Instant::now() + idle;
            }
            command = command_rx.recv() => {
                match command {
                    Some(command) => {
                        if handle_stream_command(command, &mut send_stream, &input, &channel).await {
                            break 'session;
                        }
                    }
                    None => break 'session,
                }
                deadline = tokio::time::Instant::now() + idle;
            }
            _ = tokio::time::sleep_until(deadline) => {
                emit_stream(&channel, GrpcStreamMessage::Error {
                    code: "timeout".into(),
                    message: "会话空闲超时，已结束".into(),
                });
                break 'session;
            }
        }
    }
}

#[cfg(test)]
#[path = "grpc/tests.rs"]
mod tests;
