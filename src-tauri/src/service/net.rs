//! Shared socket connection helpers for the socket-based debug protocols
//! (gRPC / raw TCP; MQTT reuses the trust model directly via `service::tls`).
//!
//! One place owns the `host:port` parser, the unified async IO trait, and the
//! TLS connector. ALPN is chosen by the caller: gRPC needs `h2`, while MQTT
//! and raw TCP must keep it empty (advertising `h2` on a non-HTTP TLS port can
//! make standard servers reject or mis-negotiate the handshake).

use std::sync::Arc;

/// Parsed authority: host, port, and whether TLS applies.
pub(crate) type Target = (String, u16, bool);

/// One concrete IO type unifies the plaintext and TLS branches across
/// protocols. Previously gRPC / TCP / MQTT each declared an identical local
/// trait (`H2Io` / `TcpIo` / `MqttIo`); this is the single definition.
pub(crate) trait AsyncIo: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> AsyncIo for T {}

/// `host:port` / `http://host:port` → plaintext; `https://host[:port]` → TLS.
pub(crate) fn parse_address(address: &str) -> Result<Target, String> {
    let trimmed = address.trim();
    if trimmed.is_empty() {
        return Err("地址不能为空".into());
    }
    let (rest, use_tls) = if let Some(rest) = trimmed.strip_prefix("https://") {
        (rest, true)
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        (rest, false)
    } else {
        (trimmed, false)
    };
    let rest = rest.trim_end_matches('/');
    if rest.is_empty() {
        return Err("地址不合法".into());
    }
    // IPv6 literals [::1]:50051 keep their brackets for connect.
    let (host, port) = match rest.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            (host.to_string(), port.parse::<u16>().unwrap_or(443))
        }
        _ => (rest.to_string(), if use_tls { 443 } else { 80 }),
    };
    if host.is_empty() {
        return Err("地址缺少主机名".into());
    }
    Ok((host, port, use_tls))
}

/// Wrap a TCP stream in TLS using the shared trust model, with ALPN supplied
/// by the caller. See [`connect_io`] for the common entry point.
pub(crate) async fn tls_stream(
    host: &str,
    tcp: tokio::net::TcpStream,
    options: &crate::service::tls::TlsOptions,
    alpn: Vec<Vec<u8>>,
) -> Result<tokio_rustls::client::TlsStream<tokio::net::TcpStream>, String> {
    let config = crate::service::tls::client_config(options, alpn)?;
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    let domain = rustls::pki_types::ServerName::try_from(host.to_string())
        .map_err(|error| format!("TLS 主机名不合法 {host}：{error}"))?;
    connector
        .connect(domain, tcp)
        .await
        .map_err(|error| format!("TLS 握手失败：{error}"))
}

/// Connect to `address` and return a unified IO stream, applying TLS with the
/// caller's ALPN when the address selects it.
pub(crate) async fn connect_io(
    address: &str,
    tls: &crate::service::tls::TlsOptions,
    alpn: Vec<Vec<u8>>,
) -> Result<Box<dyn AsyncIo>, String> {
    let (host, port, use_tls) = parse_address(address)?;
    let tcp = tokio::net::TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|error| format!("连接失败：{error}"))?;
    if use_tls {
        Ok(Box::new(tls_stream(&host, tcp, tls, alpn).await?))
    } else {
        Ok(Box::new(tcp))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_address_variants_from_shared_net() {
        assert_eq!(parse_address("127.0.0.1:50051").unwrap(), ("127.0.0.1".into(), 50051, false));
        assert_eq!(parse_address("http://localhost:8080").unwrap(), ("localhost".into(), 8080, false));
        assert_eq!(parse_address("https://api.example.com").unwrap(), ("api.example.com".into(), 443, true));
        assert_eq!(parse_address("[::1]:9090").unwrap(), ("[::1]".into(), 9090, false));
        assert!(parse_address("").is_err());
        assert!(parse_address("https://").is_err());
    }
}
