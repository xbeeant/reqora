//! Minimal structured JSON logger. One JSON object per line on stderr.
//!
//! NEVER log: header values, request/response bodies, tokens, passwords or full
//! URLs (query strings frequently carry credentials). Only method, host, status,
//! byte counts, durations and error codes are recorded.

use reqora_core::config::LogLevel;
use serde_json::{Value, json};
use uuid::Uuid;

/// Wall-clock millis — single implementation lives in `reqora-core::time`.
pub use reqora_core::time::now_millis;

pub fn new_request_id() -> String {
    Uuid::new_v4().simple().to_string()[..12].to_string()
}

pub fn log(level: LogLevel, event: &str, request_id: &str, fields: Value, min_level: LogLevel) {
    if !min_level.enabled(level) {
        return;
    }

    let mut record = json!({
        "ts": now_millis(),
        "level": level.label(),
        "event": event,
        "request_id": request_id,
    });

    if let (Some(destination), Some(source)) = (record.as_object_mut(), fields.as_object()) {
        for (key, value) in source {
            destination.insert(key.clone(), value.clone());
        }
    }

    eprintln!("{record}");
}

/// Strips everything but the origin from a URL so it is safe to log.
pub fn safe_target(raw_url: &str) -> String {
    match reqwest::Url::parse(raw_url) {
        Ok(url) => {
            let host = url.host_str().unwrap_or("<no-host>");
            match url.port() {
                Some(port) => format!("{}://{host}:{port}", url.scheme()),
                None => format!("{}://{host}", url.scheme()),
            }
        }
        Err(_) => "<unparseable-url>".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_target_removes_query_and_path() {
        assert_eq!(
            safe_target("https://api.example.com/v1/users?token=SECRET#frag"),
            "https://api.example.com"
        );
        assert_eq!(
            safe_target("http://127.0.0.1:8080/echo"),
            "http://127.0.0.1:8080"
        );
    }

    #[test]
    fn request_ids_are_unique() {
        assert_ne!(new_request_id(), new_request_id());
    }
}
