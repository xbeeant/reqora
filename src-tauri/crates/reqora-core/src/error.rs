//! Typed internal errors + the sanitised error envelope exposed to the WebView.
//!
//! Network-facing details (reqwest messages, hostnames, URL-embedded secrets)
//! are only written to structured logs. Local storage errors are the exception:
//! a generic "请检查目录权限" hid the actual size cap / SQLite lock and left
//! users with a misleading, unfixable toast, so their detail is surfaced in the
//! message and lands in `~/.reqora/logs/errors.log`.

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("request timeout")]
    Timeout,
    #[error("network error: {0}")]
    Network(String),
    #[error("storage error: {0}")]
    Storage(String),
    #[error("websocket session not found")]
    WsSessionNotFound,
    #[error("mock port {0} is already in use")]
    MockPortBusy(u16),
    #[error("file dialog cancelled")]
    FileCancelled,
    #[error("mcp error: {0}")]
    Mcp(String),
    #[error("grpc error: {0}")]
    Grpc(String),
    #[error("tcp error: {0}")]
    Tcp(String),
    #[error("database error: {0}")]
    Db(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidInput(_) => "INVALID_INPUT",
            Self::Timeout => "TIMEOUT",
            Self::Network(_) => "NETWORK_ERROR",
            Self::Storage(_) => "STORAGE_ERROR",
            Self::WsSessionNotFound => "WS_SESSION_NOT_FOUND",
            Self::MockPortBusy(_) => "MOCK_PORT_IN_USE",
            Self::FileCancelled => "FILE_CANCELLED",
            Self::Mcp(_) => "MCP_ERROR",
            Self::Grpc(_) => "GRPC_ERROR",
            Self::Tcp(_) => "TCP_ERROR",
            Self::Db(_) => "DB_ERROR",
            Self::Internal(_) => "INTERNAL_ERROR",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub code: &'static str,
    pub message: String,
    pub request_id: String,
    /// Frontend only auto-retries idempotent methods, and only when this is true.
    pub retryable: bool,
}

impl ErrorPayload {
    pub fn new(error: &AppError, request_id: &str) -> Self {
        let message = match error {
            AppError::InvalidInput(detail) => format!("请求参数不合法：{detail}"),
            AppError::Timeout => "请求超时，可提高超时时间后重试".to_string(),
            AppError::Network(_) => "无法连接目标服务器，请检查 URL、代理与网络后重试".to_string(),
            // A storage failure can mean a full-size cap, a read-only file, a
            // locked SQLite database or an actual permission denial. Collapsing
            // all of them into one sentence made the reported "无权限"
            // impossible to diagnose; keep the concrete backend reason.
            AppError::Storage(detail) => format!("本地数据读写失败：{detail}"),
            AppError::WsSessionNotFound => {
                "WebSocket 会话不存在或已关闭，请重新连接".to_string()
            }
            AppError::MockPortBusy(port) => format!("端口 {port} 已被占用，请更换端口后重试"),
            AppError::FileCancelled => "已取消文件选择".to_string(),
            AppError::Mcp(detail) => format!("MCP 调用失败：{detail}"),
            AppError::Grpc(detail) => format!("gRPC 调用失败：{detail}"),
            AppError::Tcp(detail) => format!("TCP 调试失败：{detail}"),
            AppError::Db(detail) => format!("数据库操作失败：{detail}"),
            AppError::Internal(_) => "发生内部错误，请重试或查看应用日志".to_string(),
        };

        Self {
            code: error.code(),
            message,
            request_id: request_id.to_string(),
            retryable: matches!(error, AppError::Timeout | AppError::Network(_)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_leaks_internal_details() {
        let error = AppError::Network("dns error: secret-internal-host:443".to_string());
        let payload = ErrorPayload::new(&error, "rid-1");
        assert_eq!(payload.code, "NETWORK_ERROR");
        assert!(!payload.message.contains("secret-internal-host"));
        assert!(payload.retryable);
        assert_eq!(payload.request_id, "rid-1");
    }

    #[test]
    fn invalid_input_is_not_retryable() {
        let payload = ErrorPayload::new(&AppError::InvalidInput("URL".into()), "rid-2");
        assert_eq!(payload.code, "INVALID_INPUT");
        assert!(!payload.retryable);
        assert!(payload.message.contains("URL"));
    }

    #[test]
    fn storage_error_exposes_the_real_cause() {
        let payload = ErrorPayload::new(
            &AppError::Storage("工作区快照 25 MiB 超过当前上限 5 MiB".into()),
            "rid-3",
        );
        assert_eq!(payload.code, "STORAGE_ERROR");
        assert!(payload.message.contains("超过当前上限"));
        assert!(!payload.message.contains("无权限"));
    }
}
