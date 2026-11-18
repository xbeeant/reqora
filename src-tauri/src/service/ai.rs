//! AI assistant backend: one function, one OpenAI-compatible
//! `POST {base}/chat/completions` call. Works with any compatible provider
//! (OpenAI, DeepSeek, Moonshot, Ollama, LM Studio, one-api gateways...).
//!
//! Stateless on purpose: credentials live in workspace settings and are passed
//! per call; nothing is cached or logged beyond target metadata.

use reqora_core::error::AppError;
use serde_json::{Value, json};
use std::time::Duration;

/// Connection settings for an OpenAI-compatible provider.
#[derive(Debug, Clone, Default)]
pub struct AiSettings {
    /// e.g. `https://api.openai.com/v1` — `/chat/completions` is appended.
    pub base_url: String,
    /// Bearer token; empty means the endpoint needs no auth (local models).
    pub api_key: String,
    pub model: String,
}

/// Total time budget for one completion (LLM latency is legitimately long).
const AI_TIMEOUT: Duration = Duration::from_secs(120);

pub async fn chat_completion(
    settings: &AiSettings,
    system: &str,
    user: &str,
) -> Result<String, AppError> {
    if settings.base_url.trim().is_empty() {
        return Err(AppError::InvalidInput("AI Base URL 不能为空".into()));
    }
    if settings.model.trim().is_empty() {
        return Err(AppError::InvalidInput("AI 模型名不能为空".into()));
    }
    let url = format!(
        "{}/chat/completions",
        settings.base_url.trim().trim_end_matches('/')
    );
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(AI_TIMEOUT)
        .build()
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let payload = json!({
        "model": settings.model.trim(),
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        // Low temperature: the assistant is used for structured generation.
        "temperature": 0.2,
    })
    .to_string();

    let mut request = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(payload);
    if !settings.api_key.trim().is_empty() {
        request = request.bearer_auth(settings.api_key.trim());
    }

    let response = request.send().await.map_err(|e| AppError::Network(e.to_string()))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| AppError::Network(e.to_string()))?;
    if !status.is_success() {
        return Err(AppError::Network(format!("AI 服务返回 HTTP {status}")));
    }

    let value: Value = serde_json::from_str(&body)
        .map_err(|_| AppError::Internal("AI 响应不是合法 JSON".into()))?;
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        return Err(AppError::Network(format!("AI 服务报错：{message}")));
    }
    value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| AppError::Internal("AI 响应缺少 choices[0].message.content".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_empty_settings() {
        let error = chat_completion(
            &AiSettings::default(),
            "sys",
            "user",
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::InvalidInput(_)));

        let settings = AiSettings {
            base_url: "http://localhost".into(),
            api_key: String::new(),
            model: String::new(),
        };
        let error = chat_completion(&settings, "sys", "user").await.unwrap_err();
        assert!(matches!(error, AppError::InvalidInput(_)));
    }

    /// Full round trip against a local OpenAI-compatible fake.
    #[tokio::test]
    async fn chat_completion_roundtrip() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut buf = vec![0u8; 16384];
            let mut received = Vec::new();
            let mut body_start: Option<usize> = None;
            // Read until the whole JSON body (per Content-Length) has arrived.
            loop {
                let n = socket.read(&mut buf).await.expect("read");
                if n == 0 {
                    return;
                }
                received.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&received).to_string();
                if let Some(pos) = text.find("\r\n\r\n") {
                    if body_start.is_none() {
                        body_start = Some(pos + 4);
                    }
                    let start = body_start.unwrap();
                    let length = text.lines().find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                    });
                    if let Some(length) = length
                        && received.len() >= start + length
                    {
                        break;
                    }
                }
            }
            let raw = String::from_utf8_lossy(&received).to_string();
            // Sanity: the request must carry the bearer token and the system prompt.
            // hyper serialises header names in lowercase on the wire.
            assert!(raw.to_lowercase().contains("authorization: bearer test-key"));
            assert!(raw.contains("you are a helpful assistant"));
            let body = json!({
                "choices": [{"message": {"role": "assistant", "content": "{\"method\":\"GET\"}"}}]
            }).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
        });

        let settings = AiSettings {
            base_url: format!("http://{address}/v1"),
            api_key: "test-key".into(),
            model: "fake-model".into(),
        };
        let content = chat_completion(&settings, "you are a helpful assistant", "hi")
            .await
            .expect("completion should succeed");
        assert_eq!(content, "{\"method\":\"GET\"}");
        server.abort();
    }

    #[tokio::test]
    async fn surfaces_provider_errors() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut buf = vec![0u8; 8192];
            let _ = socket.read(&mut buf).await;
            let body = json!({"error": {"message": "insufficient quota"}}).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
        });

        let settings = AiSettings {
            base_url: format!("http://{address}/v1"),
            api_key: "k".into(),
            model: "m".into(),
        };
        let error = chat_completion(&settings, "s", "u").await.unwrap_err();
        let text = error.to_string();
        assert!(text.contains("insufficient quota"), "got {text}");
        server.abort();
    }
}
