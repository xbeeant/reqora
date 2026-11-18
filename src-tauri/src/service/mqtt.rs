//! MQTT 3.1.1 / 5.0 客户端与会话管理。
//!
//! 手写 MQTT 报文编解码，不引入 rumqttc 等新 crate。每个会话由一个后台 tokio
//! task 持有 `Box<dyn AsyncRead + AsyncWrite + Unpin + Send>`（TCP 或 rustls TLS），
//! 通过 `mpsc::UnboundedReceiver<MqttCommand>` 接收上层命令，并在 `tokio::select!`
//! 中同时驱动 socket 读取与 keepalive 定时 PINGREQ。
//!
//! 凭据（用户名 / 密码）只出现在内存与报文中，绝不写入日志或错误信息。

use reqora_core::error::AppError;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};

// ---------------------------------------------------------------------------
// 公共契约类型（主会话按此接线，签名严格保持一致）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttConnectSpec {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub use_tls: bool,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub version: String, // "3.1.1" | "5"
    #[serde(default)]
    pub keep_alive_secs: Option<u16>,
    #[serde(default)]
    pub clean_session: Option<bool>,
    #[serde(default)]
    pub verify_tls: Option<bool>,
    #[serde(default)]
    pub ca_pem: Option<String>,
    #[serde(default)]
    pub path: Option<String>, // 预留：WebSocket 路径，当前直连 TCP/TLS 不使用
}

/// 订阅项：对应前端 `Array<{ topic: string; qos: number }>` 的 IPC 契约。
/// service 层公共 API 直接使用该结构，内部 MQTT 报文编码再集中转成元组。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttSubscription {
    pub topic: String,
    pub qos: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum MqttClientMessage {
    Open {
        session_id: String,
        protocol: String,
        at_ms: u64,
    },
    Subscribed {
        topics: Vec<String>,
        at_ms: u64,
    },
    Message {
        topic: String,
        payload: String,
        qos: u8,
        retain: bool,
        at_ms: u64,
    },
    Published {
        topic: String,
        qos: u8,
        retain: bool,
        at_ms: u64,
    },
    Unsubscribed {
        topics: Vec<String>,
        at_ms: u64,
    },
    Closed {
        reason: String,
        at_ms: u64,
    },
    Reconnecting {
        attempt: u32,
        at_ms: u64,
    },
    Error {
        code: String,
        message: String,
    },
}

pub type MqttSessions = Arc<Mutex<HashMap<String, MqttSession>>>;

pub struct MqttSession {
    cmd_tx: mpsc::UnboundedSender<MqttCommand>,
    // task handle 通过共享槽位回填：先插入会话表再 spawn，避免关闭竞态。
    #[allow(dead_code)]
    handle: Arc<StdMutex<Option<tokio::task::JoinHandle<()>>>>,
}

pub fn new_sessions() -> MqttSessions {
    Arc::new(Mutex::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// 内部类型
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProtocolVersion {
    V311,
    V5,
}

impl ProtocolVersion {
    fn v5(self) -> bool {
        matches!(self, ProtocolVersion::V5)
    }

    fn label(self) -> &'static str {
        match self {
            ProtocolVersion::V311 => "MQTT 3.1.1",
            ProtocolVersion::V5 => "MQTT 5.0",
        }
    }
}

struct TlsOptions {
    host: String,
    port: u16,
    use_tls: bool,
    verify_tls: bool,
    ca_pem: Option<String>,
}

struct ConnectConfig {
    version: ProtocolVersion,
    client_id: String,
    username: Option<String>,
    password: Option<String>,
    keep_alive: u16,
    clean_start: bool,
}

struct SessionShared {
    channel: Channel<MqttClientMessage>,
    session_id: String,
    tls: TlsOptions,
    cfg: ConnectConfig,
    started: Instant,
}

enum MqttCommand {
    Publish {
        topic: String,
        payload: Vec<u8>,
        qos: u8,
        retain: bool,
    },
    Subscribe {
        topics: Vec<(String, u8)>,
    },
    Unsubscribe {
        topics: Vec<String>,
    },
    Disconnect,
}

/// Rust 的 trait object 只允许一个非 auto trait，故用一个组合 trait 把
/// AsyncRead/AsyncWrite 聚合起来，再配 Unpin/Send 两个 auto trait。
trait MqttIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> MqttIo for T {}
type MqttStream = Box<dyn MqttIo>;

const MAX_RECONNECT: u32 = 5;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// 纯函数：变长整数 / UTF-8 / 报文编解码（可单测）
// ---------------------------------------------------------------------------

/// MQTT remaining length / variable byte integer 编码。
fn encode_remaining_length(mut len: usize) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let mut digit = (len % 128) as u8;
        len /= 128;
        if len > 0 {
            digit |= 0x80;
        }
        out.push(digit);
        if len == 0 {
            break;
        }
    }
    out
}

/// 返回 `(值, 占用字节数)`；数据不足或超过 4 字节返回 `None`。
fn decode_remaining_length(buf: &[u8]) -> Option<(usize, usize)> {
    let mut value: usize = 0;
    let mut multiplier: usize = 1;
    for (i, &b) in buf.iter().take(4).enumerate() {
        value += ((b & 0x7F) as usize) * multiplier;
        if b & 0x80 == 0 {
            return Some((value, i + 1));
        }
        multiplier = multiplier.saturating_mul(128);
    }
    None
}

/// MQTT 5.0 的 Property Length 与 remaining length 采用同一套变长整数编码。
fn encode_varint(len: usize) -> Vec<u8> {
    encode_remaining_length(len)
}

fn decode_varint_at(buf: &[u8], pos: &mut usize) -> Result<usize, String> {
    let (value, used) = decode_remaining_length(&buf[*pos..])
        .ok_or_else(|| "MQTT 变长整数无效".to_string())?;
    *pos += used;
    Ok(value)
}

/// 2 字节长度前缀 + UTF-8 字节。
fn encode_utf8(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(2 + bytes.len());
    out.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
    out.extend_from_slice(bytes);
    out
}

/// 用固定头 + remaining length + body 组装完整报文。
fn packet(header: u8, body: Vec<u8>) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + 4 + body.len());
    out.push(header);
    out.extend_from_slice(&encode_remaining_length(body.len()));
    out.extend_from_slice(&body);
    out
}

fn packet_type(header: u8) -> u8 {
    header >> 4
}

/// packet id 在 1..=65535 之间循环递增。
fn next_packet_id(prev: u16) -> u16 {
    if prev >= 65535 {
        1
    } else {
        prev + 1
    }
}

fn encode_connect(cfg: &ConnectConfig) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&encode_utf8("MQTT"));
    body.push(match cfg.version {
        ProtocolVersion::V311 => 4,
        ProtocolVersion::V5 => 5,
    });
    let mut flags = 0u8;
    if cfg.clean_start {
        flags |= 0x02;
    }
    if cfg.username.is_some() {
        flags |= 0x80;
    }
    if cfg.password.is_some() {
        flags |= 0x40;
    }
    body.push(flags);
    body.extend_from_slice(&cfg.keep_alive.to_be_bytes());
    if cfg.version.v5() {
        // 5.0 CONNECT 必须带 Property Length（此处为空 properties -> 0）。
        body.extend_from_slice(&encode_varint(0));
    }
    body.extend_from_slice(&encode_utf8(&cfg.client_id));
    // 不实现 Will，故无 Will Topic / Will Message / Will Properties。
    if let Some(u) = &cfg.username {
        body.extend_from_slice(&encode_utf8(u));
    }
    if let Some(p) = &cfg.password {
        let bytes = p.as_bytes();
        body.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
        body.extend_from_slice(bytes);
    }
    packet(0x10, body)
}

#[derive(Debug, Clone, Copy)]
struct ConnAck {
    #[allow(dead_code)]
    session_present: bool,
    code: u8,
}

fn connack3_text(code: u8) -> &'static str {
    match code {
        1 => "协议版本不受支持",
        2 => "客户端标识符被拒绝",
        3 => "服务器不可用",
        4 => "用户名或密码错误",
        5 => "未授权",
        _ => "未知错误",
    }
}

fn decode_connack(remaining: &[u8]) -> Result<ConnAck, String> {
    if remaining.len() < 2 {
        return Err("CONNACK 报文过短".into());
    }
    Ok(ConnAck {
        session_present: remaining[0] & 0x01 != 0,
        code: remaining[1],
    })
}

fn validate_connack(frame: &MqttFrame, version: ProtocolVersion) -> Result<ConnAck, String> {
    if packet_type(frame.header) != 2 {
        return Err("期望 CONNACK，却收到其它报文".into());
    }
    let ack = decode_connack(&frame.remaining)?;
    if version.v5() {
        if ack.code >= 0x80 {
            return Err(format!("MQTT 5.0 连接被拒绝（原因码 0x{:02X}）", ack.code));
        }
    } else if ack.code != 0 {
        return Err(format!(
            "MQTT 3.1.1 连接被拒绝（返回码 {}：{}）",
            ack.code,
            connack3_text(ack.code)
        ));
    }
    Ok(ack)
}

#[derive(Debug, Clone)]
struct DecodedPublish {
    topic: String,
    payload: Vec<u8>,
    qos: u8,
    retain: bool,
    #[allow(dead_code)]
    dup: bool,
    packet_id: Option<u16>,
}

fn encode_publish(
    topic: &str,
    payload: &[u8],
    qos: u8,
    retain: bool,
    dup: bool,
    packet_id: Option<u16>,
    version: ProtocolVersion,
) -> Vec<u8> {
    let mut header = 0x30u8 | ((qos & 0x03) << 1);
    if dup {
        header |= 0x08;
    }
    if retain {
        header |= 0x01;
    }
    let mut body = Vec::new();
    body.extend_from_slice(&encode_utf8(topic));
    if qos > 0 {
        body.extend_from_slice(&packet_id.unwrap_or(1).to_be_bytes());
    }
    if version.v5() {
        body.extend_from_slice(&encode_varint(0));
    }
    body.extend_from_slice(payload);
    packet(header, body)
}

fn decode_publish(
    header: u8,
    remaining: &[u8],
    version: ProtocolVersion,
) -> Result<DecodedPublish, String> {
    let qos = (header >> 1) & 0x03;
    if qos == 3 {
        return Err("PUBLISH 的 QoS=3 非法".into());
    }
    let retain = header & 0x01 != 0;
    let dup = (header >> 3) & 0x01 != 0;
    if remaining.len() < 2 {
        return Err("PUBLISH 缺少 topic 长度".into());
    }
    let topic_len = u16::from_be_bytes([remaining[0], remaining[1]]) as usize;
    let mut pos = 2usize;
    if pos + topic_len > remaining.len() {
        return Err("PUBLISH topic 越界".into());
    }
    let topic = String::from_utf8_lossy(&remaining[pos..pos + topic_len]).into_owned();
    pos += topic_len;
    let packet_id = if qos > 0 {
        if pos + 2 > remaining.len() {
            return Err("PUBLISH 缺少 packet id".into());
        }
        let pid = u16::from_be_bytes([remaining[pos], remaining[pos + 1]]);
        pos += 2;
        Some(pid)
    } else {
        None
    };
    if version.v5() {
        let plen = decode_varint_at(remaining, &mut pos)?;
        if pos + plen > remaining.len() {
            return Err("PUBLISH properties 越界".into());
        }
        pos += plen;
    }
    Ok(DecodedPublish {
        topic,
        payload: remaining[pos..].to_vec(),
        qos,
        retain,
        dup,
        packet_id,
    })
}

fn encode_subscribe(
    packet_id: u16,
    topics: &[(String, u8)],
    version: ProtocolVersion,
) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&packet_id.to_be_bytes());
    if version.v5() {
        body.extend_from_slice(&encode_varint(0));
    }
    for (topic, qos) in topics {
        body.extend_from_slice(&encode_utf8(topic));
        body.push(qos & 0x03);
    }
    packet(0x82, body)
}

fn decode_suback(remaining: &[u8], version: ProtocolVersion) -> Result<(u16, Vec<u8>), String> {
    if remaining.len() < 2 {
        return Err("SUBACK 报文过短".into());
    }
    let pid = u16::from_be_bytes([remaining[0], remaining[1]]);
    let mut pos = 2usize;
    if version.v5() {
        let plen = decode_varint_at(remaining, &mut pos)?;
        if pos + plen > remaining.len() {
            return Err("SUBACK properties 越界".into());
        }
        pos += plen;
    }
    Ok((pid, remaining[pos..].to_vec()))
}

fn encode_unsubscribe(packet_id: u16, topics: &[String], version: ProtocolVersion) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&packet_id.to_be_bytes());
    if version.v5() {
        body.extend_from_slice(&encode_varint(0));
    }
    for topic in topics {
        body.extend_from_slice(&encode_utf8(topic));
    }
    packet(0xA2, body)
}

fn decode_unsuback(remaining: &[u8]) -> Result<u16, String> {
    if remaining.len() < 2 {
        return Err("UNSUBACK 报文过短".into());
    }
    Ok(u16::from_be_bytes([remaining[0], remaining[1]]))
}

/// 5.0 的 PUBACK/PUBREC/PUBREL/PUBCOMP：reason code(0x00) + properties 长度(0)。
fn encode_ack(header: u8, packet_id: u16, version: ProtocolVersion) -> Vec<u8> {
    let mut body = packet_id.to_be_bytes().to_vec();
    if version.v5() {
        body.push(0x00);
        body.extend_from_slice(&encode_varint(0));
    }
    packet(header, body)
}

fn encode_puback(pid: u16, v: ProtocolVersion) -> Vec<u8> {
    encode_ack(0x40, pid, v)
}
fn encode_pubrec(pid: u16, v: ProtocolVersion) -> Vec<u8> {
    encode_ack(0x50, pid, v)
}
fn encode_pubrel(pid: u16, v: ProtocolVersion) -> Vec<u8> {
    encode_ack(0x62, pid, v)
}
fn encode_pubcomp(pid: u16, v: ProtocolVersion) -> Vec<u8> {
    encode_ack(0x70, pid, v)
}
fn encode_disconnect(v: ProtocolVersion) -> Vec<u8> {
    let mut body = Vec::new();
    if v.v5() {
        body.push(0x00); // reason code = Normal disconnection
        body.extend_from_slice(&encode_varint(0));
    }
    packet(0xE0, body)
}
fn encode_pingreq() -> Vec<u8> {
    vec![0xC0, 0x00]
}

/// MQTT 主题过滤器匹配，支持单层 `+` 与多层 `#` 通配符。
#[allow(dead_code)]
fn topic_matches(filter: &str, topic: &str) -> bool {
    // 以通配符开头的订阅不能匹配以 $ 开头的系统主题。
    if topic.starts_with('$') && (filter.starts_with('#') || filter.starts_with('+')) {
        return false;
    }
    let f: Vec<&str> = filter.split('/').collect();
    let t: Vec<&str> = topic.split('/').collect();
    let mut ti = 0usize;
    for (i, &seg) in f.iter().enumerate() {
        match seg {
            "#" => {
                // '#' 必须是最后一层，匹配剩余任意层（含 0 层 / 父级）。
                return i + 1 == f.len();
            }
            "+" => {
                if ti >= t.len() {
                    return false;
                }
                ti += 1;
            }
            _ => {
                if ti >= t.len() || seg != t[ti] {
                    return false;
                }
                ti += 1;
            }
        }
    }
    ti == t.len()
}

// ---------------------------------------------------------------------------
// 增量分帧：固定头 + 变长 remaining length + body
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct MqttFrame {
    header: u8,
    remaining: Vec<u8>,
}

struct FrameAccumulator {
    buf: Vec<u8>,
    ready: VecDeque<MqttFrame>,
}

impl FrameAccumulator {
    fn new() -> Self {
        Self {
            buf: Vec::new(),
            ready: VecDeque::new(),
        }
    }

    /// 喂入任意分片的字节流，内部解析出所有完整帧。
    fn push(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
        loop {
            if self.buf.len() < 2 {
                break;
            }
            let (value, used) = match decode_remaining_length(&self.buf[1..]) {
                Some(v) => v,
                None => {
                    if self.buf.len() - 1 >= 4 {
                        // 非法报文头，丢弃一字节后重新同步。
                        self.buf.remove(0);
                        continue;
                    }
                    break;
                }
            };
            let total = 1 + used + value;
            if self.buf.len() < total {
                break;
            }
            let header = self.buf[0];
            let remaining = self.buf[1 + used..total].to_vec();
            self.ready.push_back(MqttFrame { header, remaining });
            self.buf.drain(0..total);
        }
    }

    fn pop(&mut self) -> Option<MqttFrame> {
        self.ready.pop_front()
    }
}

fn read_packet_id(remaining: &[u8]) -> Option<u16> {
    if remaining.len() < 2 {
        return None;
    }
    Some(u16::from_be_bytes([remaining[0], remaining[1]]))
}

// ---------------------------------------------------------------------------
// TLS（rustls + webpki roots）
// ---------------------------------------------------------------------------

/// TLS 配置统一复用 `service::tls`（与 gRPC / raw TCP 同一套信任模型）。
async fn build_tls_stream(
    tls: &TlsOptions,
    tcp: TcpStream,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, AppError> {
    // MQTT over TLS 不使用 HTTP/2 的 ALPN。保持 ALPN 为空以兼容标准 8883 端口；
    // 若后续要接入 443 端口的 ALPN 协商，可改为 vec![b"mqtt".to_vec()]，但绝不设 h2。
    let config = crate::service::tls::client_config(
        &crate::service::tls::TlsOptions {
            verify_tls: tls.verify_tls,
            ca_pem: tls.ca_pem.clone(),
        },
        Vec::new(),
    )
    .map_err(AppError::Network)?;
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    let domain = rustls::pki_types::ServerName::try_from(tls.host.clone())
        .map_err(|e| AppError::InvalidInput(format!("TLS 主机名不合法：{e}")))?;
    connector
        .connect(domain, tcp)
        .await
        .map_err(|e| AppError::Network(format!("TLS 握手失败：{e}")))
}

// ---------------------------------------------------------------------------
// 连接建立 / 读写辅助
// ---------------------------------------------------------------------------

async fn write_packet(stream: &mut MqttStream, bytes: &[u8]) -> Result<(), AppError> {
    stream
        .write_all(bytes)
        .await
        .map_err(|e| AppError::Network(format!("发送 MQTT 报文失败：{e}")))?;
    stream
        .flush()
        .await
        .map_err(|e| AppError::Network(format!("发送 MQTT 报文失败：{e}")))?;
    Ok(())
}

async fn read_frame(
    stream: &mut MqttStream,
    acc: &mut FrameAccumulator,
    buf: &mut [u8],
) -> Result<MqttFrame, AppError> {
    loop {
        if let Some(frame) = acc.pop() {
            return Ok(frame);
        }
        let n = stream
            .read(buf)
            .await
            .map_err(|e| AppError::Network(format!("读取 MQTT 数据失败：{e}")))?;
        if n == 0 {
            return Err(AppError::Network("MQTT 连接已断开".into()));
        }
        acc.push(&buf[..n]);
    }
}

/// 建立 TCP/TLS、发送 CONNECT、读取并校验 CONNACK。connect 与重连共用。
async fn open_connection(tls: &TlsOptions, cfg: &ConnectConfig) -> Result<MqttStream, AppError> {
    let addr = format!("{}:{}", tls.host, tls.port);
    let tcp = tokio::time::timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((tls.host.as_str(), tls.port)),
    )
    .await
    .map_err(|_| AppError::Network("连接 MQTT 服务器超时".into()))?
    .map_err(|e| AppError::Network(format!("无法连接 MQTT 服务器 {addr}：{e}")))?;
    let _ = tcp.set_nodelay(true);

    let mut stream: MqttStream = if tls.use_tls {
        Box::new(build_tls_stream(tls, tcp).await?)
    } else {
        Box::new(tcp)
    };

    write_packet(&mut stream, &encode_connect(cfg)).await?;

    let mut acc = FrameAccumulator::new();
    let mut buf = vec![0u8; 4096];
    let frame = tokio::time::timeout(
        CONNECT_TIMEOUT,
        read_frame(&mut stream, &mut acc, &mut buf),
    )
    .await
    .map_err(|_| AppError::Network("等待 MQTT CONNACK 超时".into()))??;
    validate_connack(&frame, cfg.version).map_err(AppError::Network)?;
    Ok(stream)
}

fn emit(channel: &Channel<MqttClientMessage>, message: MqttClientMessage) {
    let _ = channel.send(message);
}

fn at_ms(started: &Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

fn emit_error(shared: &SessionShared, error: &AppError) {
    let message = match error {
        AppError::Network(detail)
        | AppError::Internal(detail)
        | AppError::InvalidInput(detail) => detail.clone(),
        other => other.to_string(),
    };
    emit(
        &shared.channel,
        MqttClientMessage::Error {
            code: error.code().to_string(),
            message,
        },
    );
}

fn session_not_found() -> AppError {
    AppError::InvalidInput("MQTT 会话不存在或已关闭".into())
}

// ---------------------------------------------------------------------------
// 会话循环状态
// ---------------------------------------------------------------------------

struct InboundQos2 {
    topic: String,
    payload: Vec<u8>,
    qos: u8,
    retain: bool,
}

struct LoopState {
    next_pid: u16,
    pending_subs: HashMap<u16, Vec<String>>,
    pending_unsubs: HashMap<u16, Vec<String>>,
    qos2_in: HashMap<u16, InboundQos2>,
    subscriptions: Vec<(String, u8)>,
}

impl LoopState {
    fn new() -> Self {
        Self {
            next_pid: 0,
            pending_subs: HashMap::new(),
            pending_unsubs: HashMap::new(),
            qos2_in: HashMap::new(),
            subscriptions: Vec::new(),
        }
    }

    fn alloc_pid(&mut self) -> u16 {
        self.next_pid = next_packet_id(self.next_pid);
        self.next_pid
    }

    fn reset_inflight(&mut self) {
        self.pending_subs.clear();
        self.pending_unsubs.clear();
        self.qos2_in.clear();
    }
}

enum DriveEnd {
    Graceful,
    Fatal(AppError),
    Dropped(String),
}

enum Event {
    Cmd(Option<MqttCommand>),
    Read(usize), // 读到的字节数，数据仍在 drive 的 buf[..n] 中
    Eof,
    IoError(std::io::Error),
    Ping,
}

enum InboundOutcome {
    Continue,
    ServerClosed,
}

async fn write_subscribe(
    stream: &mut MqttStream,
    shared: &SessionShared,
    state: &mut LoopState,
    topics: &[(String, u8)],
) -> Result<(), AppError> {
    let pid = state.alloc_pid();
    let names: Vec<String> = topics.iter().map(|(t, _)| t.clone()).collect();
    state.pending_subs.insert(pid, names);
    write_packet(stream, &encode_subscribe(pid, topics, shared.cfg.version)).await
}

fn deliver_inbound(
    shared: &SessionShared,
    topic: &str,
    payload: &[u8],
    qos: u8,
    retain: bool,
) {
    emit(
        &shared.channel,
        MqttClientMessage::Message {
            topic: topic.to_string(),
            payload: String::from_utf8_lossy(payload).into_owned(),
            qos,
            retain,
            at_ms: at_ms(&shared.started),
        },
    );
}

fn deliver_message(shared: &SessionShared, msg: &DecodedPublish) {
    deliver_inbound(shared, &msg.topic, &msg.payload, msg.qos, msg.retain);
}

async fn handle_command(
    stream: &mut MqttStream,
    command: MqttCommand,
    shared: &SessionShared,
    state: &mut LoopState,
) -> Result<Option<DriveEnd>, AppError> {
    match command {
        MqttCommand::Publish {
            topic,
            payload,
            qos,
            retain,
        } => {
            let pid = if qos > 0 { Some(state.alloc_pid()) } else { None };
            let pkt = encode_publish(
                &topic,
                &payload,
                qos,
                retain,
                false,
                pid,
                shared.cfg.version,
            );
            write_packet(stream, &pkt).await?;
            emit(
                &shared.channel,
                MqttClientMessage::Published {
                    topic,
                    qos,
                    retain,
                    at_ms: at_ms(&shared.started),
                },
            );
            Ok(None)
        }
        MqttCommand::Subscribe { topics } => {
            for (topic, qos) in &topics {
                state.subscriptions.retain(|(existing, _)| existing != topic);
                state.subscriptions.push((topic.clone(), *qos));
            }
            write_subscribe(stream, shared, state, &topics).await?;
            Ok(None)
        }
        MqttCommand::Unsubscribe { topics } => {
            state.subscriptions.retain(|(t, _)| !topics.contains(t));
            let pid = state.alloc_pid();
            state.pending_unsubs.insert(pid, topics.clone());
            write_packet(stream, &encode_unsubscribe(pid, &topics, shared.cfg.version)).await?;
            Ok(None)
        }
        MqttCommand::Disconnect => {
            // 先发 DISCONNECT 再关闭。
            write_packet(stream, &encode_disconnect(shared.cfg.version)).await?;
            Ok(Some(DriveEnd::Graceful))
        }
    }
}

async fn handle_inbound(
    stream: &mut MqttStream,
    frame: MqttFrame,
    shared: &SessionShared,
    state: &mut LoopState,
) -> Result<InboundOutcome, AppError> {
    let version = shared.cfg.version;
    let remaining = &frame.remaining;
    match packet_type(frame.header) {
        2 => Ok(InboundOutcome::Continue), // CONNACK（迟到），忽略
        3 => {
            let msg = decode_publish(frame.header, remaining, version).map_err(AppError::Network)?;
            match msg.qos {
                0 => deliver_message(shared, &msg),
                1 => {
                    deliver_message(shared, &msg);
                    if let Some(pid) = msg.packet_id {
                        write_packet(stream, &encode_puback(pid, version)).await?;
                    }
                }
                2 => {
                    if let Some(pid) = msg.packet_id {
                        state.qos2_in.insert(
                            pid,
                            InboundQos2 {
                                topic: msg.topic,
                                payload: msg.payload,
                                qos: msg.qos,
                                retain: msg.retain,
                            },
                        );
                        write_packet(stream, &encode_pubrec(pid, version)).await?;
                    }
                }
                _ => return Err(AppError::Network("PUBLISH QoS 非法".into())),
            }
            Ok(InboundOutcome::Continue)
        }
        4 => Ok(InboundOutcome::Continue), // PUBACK：出站 QoS1 已确认
        5 => {
            // PUBREC：出站 QoS2 第一步，回应 PUBREL。
            if let Some(pid) = read_packet_id(remaining) {
                write_packet(stream, &encode_pubrel(pid, version)).await?;
            }
            Ok(InboundOutcome::Continue)
        }
        6 => {
            // PUBREL：入站 QoS2 第二步，投递消息并回应 PUBCOMP。
            if let Some(pid) = read_packet_id(remaining) {
                if let Some(msg) = state.qos2_in.remove(&pid) {
                    deliver_inbound(shared, &msg.topic, &msg.payload, msg.qos, msg.retain);
                }
                write_packet(stream, &encode_pubcomp(pid, version)).await?;
            }
            Ok(InboundOutcome::Continue)
        }
        7 => Ok(InboundOutcome::Continue), // PUBCOMP：出站 QoS2 完成
        9 => {
            let (pid, codes) = decode_suback(remaining, version).map_err(AppError::Network)?;
            if let Some(topics) = state.pending_subs.remove(&pid) {
                if codes.iter().any(|c| *c >= 0x80) {
                    emit(
                        &shared.channel,
                        MqttClientMessage::Error {
                            code: "SUBACK_FAILED".into(),
                            message: "MQTT 订阅被服务器拒绝".into(),
                        },
                    );
                }
                emit(
                    &shared.channel,
                    MqttClientMessage::Subscribed {
                        topics,
                        at_ms: at_ms(&shared.started),
                    },
                );
            }
            Ok(InboundOutcome::Continue)
        }
        11 => {
            let pid = decode_unsuback(remaining).map_err(AppError::Network)?;
            if let Some(topics) = state.pending_unsubs.remove(&pid) {
                emit(
                    &shared.channel,
                    MqttClientMessage::Unsubscribed {
                        topics,
                        at_ms: at_ms(&shared.started),
                    },
                );
            }
            Ok(InboundOutcome::Continue)
        }
        13 => Ok(InboundOutcome::Continue), // PINGRESP
        14 => Ok(InboundOutcome::ServerClosed), // 5.0 服务器主动 DISCONNECT
        _ => Ok(InboundOutcome::Continue),
    }
}

/// 驱动单条已建立连接的读 / 命令 / keepalive，返回结束原因。
async fn drive(
    stream: &mut MqttStream,
    rx: &mut mpsc::UnboundedReceiver<MqttCommand>,
    shared: &SessionShared,
    state: &mut LoopState,
) -> DriveEnd {
    let mut acc = FrameAccumulator::new();
    let mut buf = vec![0u8; 8192];
    let ping_period = if shared.cfg.keep_alive == 0 {
        Duration::from_secs(24 * 3600)
    } else {
        Duration::from_secs(((shared.cfg.keep_alive as u64) * 3 / 4).max(1))
    };

    loop {
        // 每次循环重建 sleep：任一分支先完成都会取消 sleep，等价于「空闲满一个周期才 PING」。
        let event = tokio::select! {
            cmd = rx.recv() => Event::Cmd(cmd),
            result = stream.read(&mut buf) => match result {
                Ok(0) => Event::Eof,
                Ok(n) => Event::Read(n),
                Err(e) => Event::IoError(e),
            },
            _ = tokio::time::sleep(ping_period) => Event::Ping,
        };

        match event {
            Event::Cmd(None) => return DriveEnd::Graceful,
            Event::Cmd(Some(command)) => {
                match handle_command(stream, command, shared, state).await {
                    Ok(None) => {}
                    Ok(Some(end)) => return end,
                    Err(e) => return DriveEnd::Fatal(e),
                }
            }
            Event::Read(n) => {
                acc.push(&buf[..n]);
                while let Some(frame) = acc.pop() {
                    match handle_inbound(stream, frame, shared, state).await {
                        Ok(InboundOutcome::Continue) => {}
                        Ok(InboundOutcome::ServerClosed) => return DriveEnd::Graceful,
                        Err(e) => return DriveEnd::Fatal(e),
                    }
                }
            }
            Event::Eof => return DriveEnd::Dropped("MQTT 连接已被服务器关闭".into()),
            Event::IoError(e) => {
                return DriveEnd::Dropped(format!("读取 MQTT 数据失败：{e}"));
            }
            Event::Ping => {
                if let Err(e) = write_packet(stream, &encode_pingreq()).await {
                    return DriveEnd::Dropped(format!("发送 PINGREQ 失败：{e}"));
                }
            }
        }
    }
}

/// 断线后有限次重连（带退避），每轮发出 Reconnecting。
async fn reconnect(shared: &SessionShared, attempt: &mut u32) -> Option<MqttStream> {
    while *attempt < MAX_RECONNECT {
        *attempt += 1;
        emit(
            &shared.channel,
            MqttClientMessage::Reconnecting {
                attempt: *attempt,
                at_ms: at_ms(&shared.started),
            },
        );
        let backoff_ms = (250u64 << (*attempt).min(4)).min(4000);
        tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
        if let Ok(stream) = open_connection(&shared.tls, &shared.cfg).await {
            return Some(stream);
        }
    }
    None
}

/// 会话主 task：驱动读循环，处理重连，结束时发出 Error/Closed 并移除会话。
async fn session_loop(
    mut stream: MqttStream,
    mut rx: mpsc::UnboundedReceiver<MqttCommand>,
    shared: SessionShared,
    sessions: MqttSessions,
) {
    let session_id = shared.session_id.clone();
    let mut state = LoopState::new();
    let mut attempt: u32 = 0;

    loop {
        let end = drive(&mut stream, &mut rx, &shared, &mut state).await;
        match end {
            DriveEnd::Graceful => {
                emit(
                    &shared.channel,
                    MqttClientMessage::Closed {
                        reason: "连接已关闭".into(),
                        at_ms: at_ms(&shared.started),
                    },
                );
                break;
            }
            DriveEnd::Fatal(e) => {
                emit_error(&shared, &e);
                emit(
                    &shared.channel,
                    MqttClientMessage::Closed {
                        reason: "连接异常关闭".into(),
                        at_ms: at_ms(&shared.started),
                    },
                );
                break;
            }
            DriveEnd::Dropped(reason) => match reconnect(&shared, &mut attempt).await {
                Some(new_stream) => {
                    stream = new_stream;
                    state.reset_inflight();
                    emit(
                        &shared.channel,
                        MqttClientMessage::Open {
                            session_id: session_id.clone(),
                            protocol: shared.cfg.version.label().to_string(),
                            at_ms: at_ms(&shared.started),
                        },
                    );
                    let subs = state.subscriptions.clone();
                    if !subs.is_empty() {
                        let _ = write_subscribe(&mut stream, &shared, &mut state, &subs).await;
                    }
                }
                None => {
                    emit(
                        &shared.channel,
                        MqttClientMessage::Error {
                            code: "NETWORK_ERROR".into(),
                            message: reason,
                        },
                    );
                    emit(
                        &shared.channel,
                        MqttClientMessage::Closed {
                            reason: "重连失败，连接已关闭".into(),
                            at_ms: at_ms(&shared.started),
                        },
                    );
                    break;
                }
            },
        }
    }

    let _ = sessions.lock().await.remove(&session_id);
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

pub async fn connect(
    sessions: &MqttSessions,
    spec: MqttConnectSpec,
    session_id: String,
    channel: Channel<MqttClientMessage>,
) -> Result<(), AppError> {
    if session_id.trim().is_empty() {
        return Err(AppError::InvalidInput("sessionId 不能为空".into()));
    }
    if spec.host.trim().is_empty() {
        return Err(AppError::InvalidInput("MQTT 主机地址不能为空".into()));
    }
    if spec.port == 0 {
        return Err(AppError::InvalidInput("MQTT 端口不合法".into()));
    }

    let version = match spec.version.trim() {
        "5" | "5.0" => ProtocolVersion::V5,
        _ => ProtocolVersion::V311,
    };
    let client_id = match spec.client_id.filter(|s| !s.trim().is_empty()) {
        Some(id) => id,
        None => format!("reqora-{}", uuid::Uuid::new_v4()),
    };
    let cfg = ConnectConfig {
        version,
        client_id,
        username: spec.username.filter(|s| !s.is_empty()),
        password: spec.password.filter(|s| !s.is_empty()),
        keep_alive: spec.keep_alive_secs.unwrap_or(60),
        clean_start: spec.clean_session.unwrap_or(true),
    };
    let tls = TlsOptions {
        host: spec.host.trim().to_string(),
        port: spec.port,
        use_tls: spec.use_tls,
        verify_tls: spec.verify_tls.unwrap_or(true),
        ca_pem: spec.ca_pem,
    };
    // WebSocket 路径当前不支持，保留字段以免破坏前端契约。
    let _ = &spec.path;

    let started = Instant::now();
    let stream = open_connection(&tls, &cfg).await?;

    emit(
        &channel,
        MqttClientMessage::Open {
            session_id: session_id.clone(),
            protocol: version.label().to_string(),
            at_ms: at_ms(&started),
        },
    );

    let (cmd_tx, rx) = mpsc::unbounded_channel();
    let handle_slot: Arc<StdMutex<Option<tokio::task::JoinHandle<()>>>> =
        Arc::new(StdMutex::new(None));

    let shared = SessionShared {
        channel,
        session_id: session_id.clone(),
        tls,
        cfg,
        started,
    };

    // 先插入会话表再 spawn，保证 task 结束时一定能从表中移除自己（无竞态）。
    sessions.lock().await.insert(
        session_id.clone(),
        MqttSession {
            cmd_tx,
            handle: handle_slot.clone(),
        },
    );

    let pump_sessions = Arc::clone(sessions);
    let handle = tokio::spawn(session_loop(stream, rx, shared, pump_sessions));
    *handle_slot
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(handle);

    Ok(())
}

pub async fn subscribe(
    sessions: &MqttSessions,
    session_id: &str,
    topics: Vec<MqttSubscription>,
) -> Result<(), AppError> {
    if topics.is_empty() {
        return Err(AppError::InvalidInput("订阅主题列表不能为空".into()));
    }
    for sub in &topics {
        if sub.topic.is_empty() {
            return Err(AppError::InvalidInput("订阅主题不能为空".into()));
        }
        if sub.qos > 2 {
            return Err(AppError::InvalidInput("订阅 QoS 只能是 0、1 或 2".into()));
        }
    }
    // 内部协议编码仍使用 (topic, qos) 元组，边界处集中转换一次。
    let tuple_topics: Vec<(String, u8)> = topics
        .into_iter()
        .map(|sub| (sub.topic, sub.qos))
        .collect();
    let map = sessions.lock().await;
    let session = map.get(session_id).ok_or_else(session_not_found)?;
    session
        .cmd_tx
        .send(MqttCommand::Subscribe { topics: tuple_topics })
        .map_err(|_| AppError::Internal("MQTT 会话已关闭".into()))?;
    Ok(())
}

pub async fn unsubscribe(
    sessions: &MqttSessions,
    session_id: &str,
    topics: Vec<String>,
) -> Result<(), AppError> {
    if topics.is_empty() || topics.iter().any(|t| t.is_empty()) {
        return Err(AppError::InvalidInput("取消订阅的主题不能为空".into()));
    }
    let map = sessions.lock().await;
    let session = map.get(session_id).ok_or_else(session_not_found)?;
    session
        .cmd_tx
        .send(MqttCommand::Unsubscribe { topics })
        .map_err(|_| AppError::Internal("MQTT 会话已关闭".into()))?;
    Ok(())
}

pub async fn publish(
    sessions: &MqttSessions,
    session_id: &str,
    topic: String,
    payload: String,
    qos: u8,
    retain: bool,
) -> Result<(), AppError> {
    if topic.is_empty() {
        return Err(AppError::InvalidInput("发布主题不能为空".into()));
    }
    if topic.contains('+') || topic.contains('#') {
        return Err(AppError::InvalidInput("发布主题不能包含通配符 + 或 #".into()));
    }
    if qos > 2 {
        return Err(AppError::InvalidInput("发布 QoS 只能是 0、1 或 2".into()));
    }
    let map = sessions.lock().await;
    let session = map.get(session_id).ok_or_else(session_not_found)?;
    session
        .cmd_tx
        .send(MqttCommand::Publish {
            topic,
            payload: payload.into_bytes(),
            qos,
            retain,
        })
        .map_err(|_| AppError::Internal("MQTT 会话已关闭".into()))?;
    Ok(())
}

pub async fn disconnect(sessions: &MqttSessions, session_id: &str) -> Result<(), AppError> {
    let session = sessions
        .lock()
        .await
        .remove(session_id)
        .ok_or_else(session_not_found)?;
    // 发送 Disconnect 命令，由后台 task 完成 DISCONNECT 报文与 Closed 事件；
    // 丢弃 handle（detach），不 abort，保证优雅关闭。
    let _ = session.cmd_tx.send(MqttCommand::Disconnect);
    Ok(())
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "mqtt/tests.rs"]
mod tests;
