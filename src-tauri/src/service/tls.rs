//! Shared rustls client setup for the socket-based protocols (gRPC / TCP / MQTT).
//!
//! One trust model for every TLS connection: `webpki_roots` + an optional custom
//! CA bundle, full certificate verification by default, and an explicit opt-out
//! for debugging internal servers with self-signed certificates. The opt-out
//! verifier is only installed when `verify_tls` is `false` — a missing flag can
//! never silently downgrade verification.

use base64::Engine as _;
use rustls::client::danger::{
    HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
};
use rustls::crypto::CryptoProvider;
use std::sync::Arc;

/// TLS knobs exposed on the wire by socket protocols. Secure by default.
#[derive(Debug, Clone)]
pub(crate) struct TlsOptions {
    /// `false` accepts self-signed / hostname-mismatched server certificates.
    pub verify_tls: bool,
    /// PEM bundle appended to the webpki roots before verification.
    pub ca_pem: Option<String>,
}

impl Default for TlsOptions {
    fn default() -> Self {
        Self {
            verify_tls: true,
            ca_pem: None,
        }
    }
}

impl TlsOptions {
    /// Build from the IPC-friendly `Option<bool>`: a missing flag means verify.
    pub(crate) fn new(verify_tls: Option<bool>, ca_pem: Option<String>) -> Self {
        Self {
            verify_tls: verify_tls.unwrap_or(true),
            ca_pem,
        }
    }
}

/// Verifier installed only when the user explicitly disables verification.
#[derive(Debug)]
pub(crate) struct NoCertVerify {
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for NoCertVerify {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Extract DER certificates from a PEM bundle (no rustls-pemfile dependency).
pub(crate) fn parse_pem_certs(pem: &str) -> Vec<Vec<u8>> {
    let lines: Vec<&str> = pem.lines().map(str::trim).collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        if lines[i] == "-----BEGIN CERTIFICATE-----" {
            let start = i + 1;
            let mut end = start;
            while end < lines.len() && lines[end] != "-----END CERTIFICATE-----" {
                end += 1;
            }
            let b64: String = lines[start..end].concat();
            if let Ok(der) = base64::engine::general_purpose::STANDARD.decode(b64.as_bytes()) {
                out.push(der);
            }
            i = if end < lines.len() { end + 1 } else { lines.len() };
        } else {
            i += 1;
        }
    }
    out
}

/// Build a rustls client config with the shared trust model.
///
/// `alpn` is protocol-specific: gRPC needs `h2`; MQTT / raw TCP keep it empty
/// (setting `h2` on a non-HTTP port breaks standard servers).
pub(crate) fn client_config(
    options: &TlsOptions,
    alpn: Vec<Vec<u8>>,
) -> Result<rustls::ClientConfig, String> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    if let Some(pem) = options
        .ca_pem
        .as_deref()
        .filter(|pem| !pem.trim().is_empty())
    {
        let certs = parse_pem_certs(pem);
        if certs.is_empty() {
            return Err("自定义 CA 证书不是合法的 PEM 格式".into());
        }
        for der in certs {
            roots
                .add(rustls::pki_types::CertificateDer::from(der))
                .map_err(|e| format!("自定义 CA 证书无效：{e}"))?;
        }
    }

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS 初始化失败：{e}"))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = alpn;
    if !options.verify_tls {
        config
            .dangerous()
            .set_certificate_verifier(Arc::new(NoCertVerify { provider }));
    }
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use std::time::Duration;

    #[test]
    fn verification_is_on_by_default() {
        assert!(TlsOptions::default().verify_tls);
        assert!(TlsOptions::new(None, None).verify_tls);
        assert!(!TlsOptions::new(Some(false), None).verify_tls);
        assert!(TlsOptions::new(Some(true), None).verify_tls);
    }

    #[test]
    fn alpn_is_protocol_specific_and_bad_ca_is_rejected() {
        let h2 = vec![b"h2".to_vec()];
        let config = client_config(&TlsOptions::default(), h2.clone()).expect("config");
        assert_eq!(config.alpn_protocols, h2);
        assert!(client_config(&TlsOptions::default(), Vec::new())
            .expect("config")
            .alpn_protocols
            .is_empty());

        let error = client_config(
            &TlsOptions {
                verify_tls: true,
                ca_pem: Some("not a certificate".into()),
            },
            h2.clone(),
        )
        .unwrap_err();
        assert!(error.contains("PEM"), "got {error}");

        // Disabling verification must not change ALPN or fail to build.
        let insecure = client_config(
            &TlsOptions {
                verify_tls: false,
                ca_pem: None,
            },
            h2.clone(),
        )
        .expect("insecure config");
        assert_eq!(insecure.alpn_protocols, h2);
    }

    #[test]
    fn no_cert_verify_accepts_an_arbitrary_certificate() {
        let verifier = NoCertVerify {
            provider: Arc::new(rustls::crypto::ring::default_provider()),
        };
        let cert = CertificateDer::from(vec![1u8, 2, 3]);
        let server = ServerName::try_from("localhost".to_string()).expect("server name");
        assert!(verifier
            .verify_server_cert(
                &cert,
                &[],
                &server,
                &[],
                UnixTime::since_unix_epoch(Duration::from_secs(0)),
            )
            .is_ok());
        assert!(!verifier.supported_verify_schemes().is_empty());
    }
}
