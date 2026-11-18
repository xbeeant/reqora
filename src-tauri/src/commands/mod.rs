//! Controller layer: parse IPC input, delegate to services, shape the response.
//! No business rules live here. Every failure becomes a sanitised ErrorPayload.

use reqora_core::config::{Config, LogLevel};
use reqora_core::error::{AppError, ErrorPayload};
use crate::logging::{log, new_request_id, safe_target};
use reqora_core::models::{BodyInfo, BodyLines, BodySlice, RequestSpec, ResponsePayload, RuntimeInfo};
use crate::projects::{ProjectRegistry, ProjectsState};
use crate::service::ai::{self, AiSettings};
use reqora_core::service::body_store::BodyStore;
use reqora_core::service::cookies::StoredCookie;
use crate::service::files::{self, PickedFile};
use crate::service::git_sync::{self, GitSyncActionResult, GitSyncStatus};
use crate::service::history::{HistoryCursor, HistoryStore, ListQuery};
use reqora_core::service::http::HttpService;
use crate::service::mcp::{McpCallOutcome, McpConnectResult, McpManager, McpServerConfig};
use reqora_core::service::mock::{self, MockHandle, MockRule, MockStartInfo, MockStatus};
use reqora_core::service::sse::{MAX_FRAMES, SseMessage, SseMeta, SseParser};
use reqora_core::service::timing::wire_response;
use crate::service::ws::{self, WsClientMessage, WsSessions};
use crate::storage::WorkspaceStore;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;
use tauri::ipc::Channel;

/// How often a blocked read is interrupted so the cancel flag can be checked.
const STREAM_POLL_INTERVAL: Duration = Duration::from_secs(1);
/// Max total silence before a half-open connection is abandoned. Normal SSE
/// keep-alive comments arrive far more often than this.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(90);

// Command groups; all command items remain reachable as commands::* via re-export.

mod project;
mod http;
mod workspace;
mod system;
mod session;
mod integration;
mod update;
mod transport;
mod data;

pub use project::*;
pub use http::*;
pub use workspace::*;
pub use system::*;
pub use session::*;
pub use integration::*;
pub use update::*;
pub use transport::*;
pub use data::*;

pub struct AppState {
    pub config: Config,
    pub http: HttpService,
    pub store: WorkspaceStore,
    /// Global on-disk spool for decoded response bodies.
    pub bodies: BodyStore,
    /// Local projects and the directory each one stores its data in.
    pub registry: ProjectRegistry,
    /// Machine-local, encrypted execution history. Never part of the
    /// synced workspace snapshot; see service/history.rs.
    pub history: HistoryStore,
    /// Ids of streams the user asked to stop. The loop checks between chunks;
    /// dropping the response is enough to close the underlying connection.
    pub cancelled_streams: Arc<Mutex<HashSet<String>>>,
    /// Live WebSocket debugging sessions (session id -> sink + metadata).
    pub ws_sessions: WsSessions,
    /// Local mock server runtime (listener task, rules, access log).
    pub mock: MockHandle,
    /// Live MCP (Model Context Protocol) connections.
    pub mcp: McpManager,
    /// Compiled gRPC descriptor pools (protox → prost-reflect).
    pub grpc: std::sync::Arc<crate::service::grpc::GrpcManager>,
    /// Live MQTT 3.1.1 / 5.0 sessions (session id -> command sink).
    pub mqtt_sessions: crate::service::mqtt::MqttSessions,
    /// Live gRPC client/bidi streaming sessions.
    pub grpc_streams: std::sync::Arc<crate::service::grpc::GrpcStreamManager>,
}
