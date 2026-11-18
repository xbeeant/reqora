//! Raw TCP socket debugging: connect, send a text or hex payload, collect
//! whatever the server answers until a silence window closes, then report the
//! bytes as both hex and lossy UTF-8.
//!
//! One-shot by design (connect → send → read → close): long-lived raw TCP
//! conversations have no standard framing, so a session model like WebSocket
//! would invent semantics the target server does not share. The silence-window
//! read makes request/response and "server greets first" flows both work.

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Payload and receive caps: raw TCP has no framing, so these bound memory.
const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;
const MAX_RECEIVE_BYTES: usize = 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS: u64 = 10_000;
/// Silence window after the last received byte before we stop reading.
const DEFAULT_READ_TIMEOUT_MS: u64 = 2_000;
const MIN_TIMEOUT_MS: u64 = 100;
const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TcpDebugSpec {
    /// `host:port`; prefix `tls://` (or `https://`) for TLS, `http://` for plaintext.
    pub address: String,
    /// `text` (UTF-8) or `hex` (hex-encoded bytes, spaces ignored).
    pub encoding: String,
    /// What to send. `{{var}}` templates are resolved with `variables`.
    pub payload: String,
    /// Appended to the payload: `none` / `lf` / `crlf`.
    pub newline: String,
    pub connect_timeout_ms: u64,
    /// Silence window: reading stops after this long without new bytes.
    pub read_timeout_ms: u64,
    #[serde(skip)]
    pub variables: reqora_core::models::Variables,
}

impl Default for TcpDebugSpec {
    fn default() -> Self {
        Self {
            address: String::new(),
            encoding: "text".into(),
            payload: String::new(),
            newline: "lf".into(),
            connect_timeout_ms: DEFAULT_CONNECT_TIMEOUT_MS,
            read_timeout_ms: DEFAULT_READ_TIMEOUT_MS,
            variables: Default::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpDebugResult {
    pub sent_bytes: usize,
    pub received_bytes: usize,
    /// Lowercase hex of everything received, for byte-level inspection.
    pub data_hex: String,
    /// Lossy UTF-8 rendering of the received bytes.
    pub data_text: String,
    pub elapsed_ms: u64,
    /// True when the server closed the connection before the silence window.
    pub closed_by_server: bool,
    pub truncated: bool,
    /// Non-fatal notes (e.g. trailing half-byte in hex input was dropped).
    pub warnings: Vec<String>,
}

impl TcpDebugSpec {
    fn connect_timeout(&self) -> Duration {
        Duration::from_millis(self.connect_timeout_ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS))
    }

    fn read_timeout(&self) -> Duration {
        Duration::from_millis(self.read_timeout_ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS))
    }
}

/// Run one raw TCP round trip.
pub async fn debug(spec: &TcpDebugSpec) -> Result<TcpDebugResult, String> {
    use reqora_core::service::template::resolve;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut warnings: Vec<String> = Vec::new();
    let address = resolve(spec.address.trim(), &spec.variables).value;
    let address = address.trim().to_string();
    if address.is_empty() {
        return Err("地址不能为空".into());
    }
    // `tls://` is the TCP-world spelling of `https://`; parse_address knows the latter.
    let normalized = if let Some(rest) = address
        .strip_prefix("tls://")
        .or_else(|| address.strip_prefix("TLS://"))
    {
        format!("https://{rest}")
    } else {
        address
    };

    // ---- build the payload ----
    let resolved_payload = resolve(&spec.payload, &spec.variables).value;
    let mut payload: Vec<u8> = match spec.encoding.trim().to_ascii_lowercase().as_str() {
        "hex" => {
            let cleaned: String = resolved_payload.chars().filter(|c| !c.is_whitespace()).collect();
            if cleaned.len() % 2 != 0 {
                warnings.push("hex 内容长度为奇数，末尾半个字节已丢弃".into());
            }
            hex::decode(&cleaned).map_err(|error| format!("hex 解码失败：{error}"))?
        }
        _ => resolved_payload.into_bytes(),
    };
    match spec.newline.trim().to_ascii_lowercase().as_str() {
        "crlf" => payload.extend_from_slice(b"\r\n"),
        "none" => {}
        _ => payload.extend_from_slice(b"\n"),
    }
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(format!("发送内容超过上限（{MAX_PAYLOAD_BYTES} 字节）"));
    }

    // ---- connect ----
    let started = std::time::Instant::now();
    // Shared connection stack; raw TCP keeps full verification and, crucially,
    // an EMPTY ALPN list — advertising h2 here (which grpc needs) breaks
    // standard non-HTTP TLS servers. See `service::net`.
    let tls = crate::service::tls::TlsOptions::default();
    let connect = crate::service::net::connect_io(&normalized, &tls, Vec::new());
    let mut stream: Box<dyn crate::service::net::AsyncIo> =
        tokio::time::timeout(spec.connect_timeout(), connect)
            .await
            .map_err(|_| format!("连接超时（{} ms）", spec.connect_timeout().as_millis()))??;

    // ---- send ----
    stream
        .write_all(&payload)
        .await
        .map_err(|error| format!("发送失败：{error}"))?;
    stream
        .flush()
        .await
        .map_err(|error| format!("发送失败：{error}"))?;
    let sent_bytes = payload.len();

    // ---- read until silence / EOF / cap ----
    let mut received: Vec<u8> = Vec::new();
    let mut closed_by_server = false;
    let mut truncated = false;
    let mut buffer = [0u8; 8192];
    loop {
        if received.len() >= MAX_RECEIVE_BYTES {
            truncated = true;
            break;
        }
        match tokio::time::timeout(spec.read_timeout(), stream.read(&mut buffer)).await {
            Err(_) => break, // silence window elapsed — normal stop
            Ok(Err(error)) => {
                if received.is_empty() {
                    return Err(format!("读取失败：{error}"));
                }
                warnings.push(format!("读取中断：{error}"));
                break;
            }
            Ok(Ok(0)) => {
                closed_by_server = true;
                break;
            }
            Ok(Ok(count)) => received.extend_from_slice(&buffer[..count]),
        }
    }

    Ok(TcpDebugResult {
        sent_bytes,
        received_bytes: received.len(),
        data_hex: hex::encode(&received),
        data_text: String::from_utf8_lossy(&received).into_owned(),
        elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        closed_by_server,
        truncated,
        warnings,
    })
}

/// Minimal hex helpers (lowercase output, whitespace tolerant input).
mod hex {
    pub fn decode(input: &str) -> Result<Vec<u8>, String> {
        let mut nibbles: Vec<u8> = Vec::with_capacity(input.len());
        for character in input.chars() {
            if character.is_whitespace() {
                continue;
            }
            let digit = character
                .to_digit(16)
                .ok_or_else(|| "包含非 hex 字符".to_string())? as u8;
            nibbles.push(digit);
        }
        // Odd nibble count: drop the trailing half-byte (caller adds a warning).
        if nibbles.len() % 2 != 0 {
            nibbles.pop();
        }
        Ok(nibbles
            .chunks_exact(2)
            .map(|pair| pair[0] * 16 + pair[1])
            .collect())
    }

    pub fn encode(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_roundtrip_and_odd_input() {
        assert_eq!(hex::decode("48 65 6C6c 6f"), Ok(b"Hello".to_vec()));
        assert_eq!(hex::decode("0a0d"), Ok(vec![0x0a, 0x0d]));
        assert!(hex::decode("zz").is_err());
        // Odd nibble count decodes the complete pairs; caller adds a warning.
        assert_eq!(hex::decode("486"), Ok(vec![0x48]));
        assert_eq!(hex::encode(b"AB"), "4142");
    }

    #[test]
    fn spec_defaults_are_sane() {
        let spec = TcpDebugSpec::default();
        assert_eq!(spec.encoding, "text");
        assert_eq!(spec.newline, "lf");
        assert!(spec.connect_timeout().as_millis() >= 100);
        assert!(spec.read_timeout().as_millis() >= 100);
    }

    #[tokio::test]
    async fn text_roundtrip_against_local_echo() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut buffer = [0u8; 1024];
            let count = socket.read(&mut buffer).await.expect("read");
            socket
                .write_all(&buffer[..count])
                .await
                .expect("echo");
            socket.flush().await.expect("flush");
            // Half-close so the client sees EOF instead of waiting for silence.
            socket.shutdown().await.expect("shutdown");
        });

        let mut spec = TcpDebugSpec::default();
        spec.address = format!("{address}");
        spec.payload = "PING".into();
        spec.newline = "lf".into();
        spec.read_timeout_ms = 2000;
        let result = debug(&spec).await.expect("debug");
        assert_eq!(result.sent_bytes, 5); // PING + \n
        assert_eq!(result.data_text, "PING\n");
        assert_eq!(result.data_hex, "50494e470a");
        assert_eq!(result.received_bytes, 5);
        assert!(result.closed_by_server);
        assert!(result.warnings.is_empty());
        server.await.expect("server task");
    }

    #[tokio::test]
    async fn hex_payload_and_silence_window_stop() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut buffer = [0u8; 64];
            let count = socket.read(&mut buffer).await.expect("read");
            assert_eq!(&buffer[..count], &[0x01, 0x02, 0x0a]);
            // Answer two bytes, then stay silent: the client must stop on the
            // silence window, not wait for EOF.
            socket.write_all(&[0xfe, 0xdc]).await.expect("write");
            socket.flush().await.expect("flush");
            tokio::time::sleep(Duration::from_millis(1500)).await;
        });

        let mut spec = TcpDebugSpec::default();
        spec.address = format!("{address}");
        spec.encoding = "hex".into();
        spec.payload = "01 02".into();
        spec.newline = "lf".into();
        spec.read_timeout_ms = 400;
        let result = debug(&spec).await.expect("debug");
        assert_eq!(result.sent_bytes, 3);
        assert_eq!(result.data_hex, "fedc");
        assert_eq!(result.received_bytes, 2);
        assert!(!result.closed_by_server);
        assert!(!result.truncated);
        server.abort();
    }

    #[tokio::test]
    async fn connect_failure_and_bad_hex_are_reported() {
        let mut spec = TcpDebugSpec::default();
        spec.address = "127.0.0.1:1".into();
        let error = debug(&spec).await.unwrap_err();
        assert!(error.contains("连接失败") || error.contains("超时"), "got {error}");

        spec.address = "127.0.0.1:1".into();
        spec.encoding = "hex".into();
        spec.payload = "xyz".into();
        let error = debug(&spec).await.unwrap_err();
        assert!(error.contains("hex 解码失败"), "got {error}");

        spec.encoding = "text".into();
        spec.payload = "hi".into();
        spec.address = String::new();
        let error = debug(&spec).await.unwrap_err();
        assert!(error.contains("地址不能为空"), "got {error}");
    }
}
