//! # reqora-core — the Tauri-free request engine
//!
//! This crate owns the *whole* HTTP sending chain: the wire contract
//! (`RequestSpec` / `ResponsePayload`), variable resolution, auth, cookies,
//! proxy / TLS / redirect policy, connection timing, raw wire reconstruction and
//! response-body decoding. It has no `tauri` dependency and no WebView/IPC
//! types, so three different shells can share exactly one implementation:
//!
//! | Consumer | How it uses this crate |
//! | --- | --- |
//! | Desktop (Tauri) | links the rlib and wraps it in `#[tauri::command]` |
//! | CLI / MCP (`bin/requester.mjs`) | talks to the `reqora-send` NDJSON sidecar built from this crate |
//! | Future headless runners / tests | link the rlib directly |
//!
//! The module layout deliberately mirrors the old `src-tauri/src/` layout, so
//! all the internal `crate::config`, `crate::models`, `crate::service::*`
//! references in the migrated files keep resolving unchanged. Moving code here
//! did **not** fork it: the desktop crate re-exports these modules, so there is
//! exactly one copy of every rule.

pub mod config;
pub mod error;
pub mod models;
pub mod service;
pub mod time;
pub mod trust;

/// Stable identifier reported by the sidecar handshake. The JS client uses it
/// to make sure it is not talking to a stale / unrelated binary.
pub const ENGINE_ID: &str = "reqora-core";
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
