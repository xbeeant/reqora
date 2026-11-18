//! Repository layer: one SQLite database per project (`workspace.db` inside
//! the project data directory), stored as rows that mirror the collaboration
//! backend's Flyway row schema and the sync row model
//! (src/lib/workspaceRows.ts): 项目 → 文件夹(集合) → 接口 as first-class
//! entity rows, plus local-only tables (history / trash / request revisions).
//!
//! Why rows instead of one JSON blob? A single blob caps every edit at a full
//! opaque rewrite, hides the structure from queries, and matches neither the
//! backend nor the sync protocol. Rows keep the same shape on all three tiers
//! (desktop SQLite, backend MySQL, sync payload), make scalar fields
//! (method / url / name / position) queryable, and let future syncs diff
//! per row. Legacy split-JSON and single-file workspaces are imported once on
//! first open; the original files are kept untouched for manual inspection.

use reqora_core::config::{Config, MAX_WORKSPACE_BYTES, MIN_WORKSPACE_BYTES};
use reqora_core::error::AppError;
use crate::service::vault::Vault;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

const DB_FILE: &str = "workspace.db";
const LEGACY_FILE: &str = "workspace.json";
const MANIFEST_FILE: &str = "manifest.json";
const BACKUPS_DIR: &str = "backups";
const MAX_BACKUPS: usize = 10;
/// meta key that marks "legacy JSON files were already imported".
const LEGACY_IMPORTED_KEY: &str = "legacyImported";

const MAX_COLLECTIONS: usize = 500;
const MAX_ENVIRONMENTS: usize = 100;
const MAX_HISTORY: usize = 200;
const MAX_CASES: usize = 2_000;
const MAX_SCENARIOS: usize = 500;
const MAX_TRASH: usize = 200;
const MAX_MCP_SERVERS: usize = 20;

/// 单行 `data` 载荷上限（行级保存的防失控门禁；整份保存另有总体积门禁）。
/// 8 MiB 远大于任何合法接口定义（含文档、示例、脚本），只用来拦截失控写入。
const MAX_ROW_DATA_BYTES: usize = 8 * 1024 * 1024;

const KIND_FOLDER: &str = "folder";
const KIND_REQUEST: &str = "request";
const KIND_ENVIRONMENT: &str = "environment";
const KIND_CASE: &str = "case";
const KIND_SCENARIO: &str = "scenario";
const KIND_SUITE: &str = "suite";
const KIND_ARTIFACT: &str = "artifact";
const KIND_DB_CONNECTION: &str = "dbConnection";
const KIND_MCP_SERVER: &str = "mcpServer";

/// Older MCP bundles copied the transient `__collection` auth cache into
/// `case.request`. It embeds the entire collection (and every request in it),
/// so a few KiB of case data used to expand into tens of MiB. Strip it on read
/// so neither the WebView nor a subsequent save can reintroduce it.
fn strip_request_runtime_cache(item: &mut serde_json::Map<String, Value>) {
    if let Some(Value::Object(request)) = item.get_mut("request") {
        request.remove("__collection");
    }
}

pub struct WorkspaceStore {
    inner: Mutex<StoreInner>,
    /// Runtime-adjustable snapshot ceiling: the settings page can raise it
    /// without restarting the app. An atomic avoids taking `inner` (which also
    /// guards the SQLite connection) just to read a number on every save.
    max_bytes: AtomicUsize,
    /// Machine-local key used to seal credentials at the SQLite boundary.
    vault: Vault,
}

struct StoreInner {
    /// The project data directory. Switched at runtime by the project registry.
    dir: PathBuf,
    /// Lazily opened connection; taken and re-opened when the directory changes.
    conn: Option<Connection>,
}

impl WorkspaceStore {
    pub fn new(config: &Config, dir: PathBuf, vault: Vault) -> Result<Self, AppError> {
        fs::create_dir_all(&dir)
            .map_err(|error| AppError::Storage(format!("创建项目数据目录失败: {error}")))?;
        Ok(Self {
            inner: Mutex::new(StoreInner { dir, conn: None }),
            max_bytes: AtomicUsize::new(config.max_workspace_bytes),
            vault,
        })
    }

    /// Apply the "snapshot storage limit" setting at runtime. Values outside
    /// the shared config bounds are rejected instead of silently truncating
    /// future saves. Returns the effective limit in bytes.
    pub fn set_max_bytes(&self, limit: u64) -> Result<usize, AppError> {
        if limit < MIN_WORKSPACE_BYTES || limit > MAX_WORKSPACE_BYTES {
            return Err(AppError::InvalidInput(format!(
                "快照存储上限必须在 {} 字节到 {} MiB 之间",
                MIN_WORKSPACE_BYTES,
                MAX_WORKSPACE_BYTES / (1024 * 1024),
            )));
        }
        let bytes = limit as usize;
        self.max_bytes.store(bytes, Ordering::Relaxed);
        Ok(bytes)
    }

    /// Ceiling currently in force (for diagnostics / runtime info).
    pub fn max_bytes(&self) -> usize {
        self.max_bytes.load(Ordering::Relaxed)
    }

    /// Absolute path of the active project's data directory.
    pub fn dir(&self) -> PathBuf {
        self.lock_inner().map(|inner| inner.dir.clone()).unwrap_or_default()
    }

    pub fn set_dir(&self, dir: PathBuf) -> Result<(), AppError> {
        fs::create_dir_all(&dir)
            .map_err(|error| AppError::Storage(format!("创建项目数据目录失败: {error}")))?;
        let mut inner = self.lock_inner()?;
        // Dropping the old connection closes it; the next call re-opens lazily.
        inner.conn = None;
        inner.dir = dir;
        Ok(())
    }

    pub fn default_snapshot() -> Value {
        json!({
            "version": 1,
            "seeded": false,
            "collections": [],
            "environments": [],
            "activeEnvironmentId": null,
            "history": [],
            "cases": [],
            "scenarios": [],
            "trash": [],
            "settings": {
                "timeoutSecs": 30,
                "followRedirects": true,
                "verifyTls": true
            }
        })
    }

    /// Merge the rows back into the single object the WebView expects.
    /// Envelopes written by `save()` are opened here, so the WebView only ever
    /// sees plaintext credentials; a decryption failure is surfaced instead of
    /// leaking ciphertext into the UI.
    pub fn load(&self) -> Result<Value, AppError> {
        let vault = &self.vault;
        let snapshot = self
            .with_conn(|conn| {
                import_legacy_json_if_needed(conn, vault)?;
                rebuild_snapshot(conn)
            })
            .map(|(_, snapshot)| snapshot)?;
        let opened = vault.open(&snapshot)?;
        validate_snapshot(&opened)?;
        Ok(opened)
    }

    /// Replace every row of the active project inside one transaction.
    /// Credential-shaped strings are sealed before any row is written; the
    /// caller's snapshot is never mutated. Unchecked (used by legacy callers
    /// such as project import / forced overwrite).
    pub fn save(&self, snapshot: &Value) -> Result<(), AppError> {
        self.save_impl(snapshot, None, false).map(|_| ())
    }

    /// Same as `save`, but reports how many **live** rows were actually
    /// inserted/updated/deleted. Staging-table writes are excluded, so this
    /// number is a direct measure of how incremental the save was.
    /// Used by the delta tests to assert saves are incremental.
    #[cfg(test)]
    fn save_with_write_count(&self, snapshot: &Value) -> Result<u64, AppError> {
        match self.save_impl(snapshot, None, false)? {
            StoreOutcome::Saved { writes, .. } => Ok(writes),
            // No expected revision was supplied, so a conflict is impossible.
            StoreOutcome::Conflict(_) => Ok(0),
        }
    }

    /// Optimistic-lock save used by the WebView auto-save loop. When
    /// `expected_rev` is stale the transaction writes nothing at all; `force`
    /// is the explicit "back up and overwrite" escape hatch.
    pub fn save_checked(
        &self,
        snapshot: &Value,
        expected_rev: Option<i64>,
        force: bool,
    ) -> Result<SaveResult, AppError> {
        Ok(match self.save_impl(snapshot, expected_rev, force)? {
            StoreOutcome::Saved { rev, .. } => SaveResult::Saved(rev),
            StoreOutcome::Conflict(rev) => SaveResult::Conflict(rev),
        })
    }

    /// Current on-disk revision, read without taking a write lock.
    pub fn workspace_rev(&self) -> Result<WorkspaceRev, AppError> {
        self.with_conn(|conn| read_workspace_rev(conn))
            .map(|(_, rev)| rev)
    }

    fn save_impl(
        &self,
        snapshot: &Value,
        expected_rev: Option<i64>,
        force: bool,
    ) -> Result<StoreOutcome, AppError> {
        validate_snapshot(snapshot)?;
        let sealed = self.vault.seal(snapshot)?;
        let object = sealed
            .as_object()
            .ok_or_else(|| AppError::Storage("工作区快照必须是 JSON 对象".into()))?;
        let total = serde_json::to_vec(&sealed)
            .map_err(|error| AppError::Storage(format!("序列化快照失败: {error}")))?;
        let max_bytes = self.max_bytes();
        if total.len() > max_bytes {
            // This is NOT a filesystem permission problem. Historically the
            // generic STORAGE_ERROR envelope hid the real reason, so users saw
            // "无权限" while the actual cause was a 5 MiB cap that a real
            // project outgrew. Name the numbers and the exact remedy.
            return Err(AppError::Storage(format!(
                "工作区快照 {} MiB 超过当前上限 {} MiB，本次保存已跳过；请在「设置 → 引擎与存储」调高「快照存储上限」（最高 {} MiB），或清理历史记录 / 用例",
                total.len() / (1024 * 1024),
                max_bytes / (1024 * 1024),
                MAX_WORKSPACE_BYTES / (1024 * 1024),
            )));
        }
        self.with_conn(|conn| store_snapshot(conn, object, expected_rev, force))
            .map(|(_, outcome)| outcome)
    }

    // ------------------------------------------------- row-level delta ----
    //
    // The WebView auto-save used to carry the entire snapshot (~25 MiB for a
    // real project) across the IPC boundary on every debounced edit, then seal
    // and re-serialize all of it in Rust even though `apply_staged_changes`
    // only wrote a handful of rows. The row-level delta path keeps the same
    // transactional semantics (CAS inside the write transaction, identical
    // `IS NOT` column-diff upserts, single shared revision counter) while
    // making the payload proportional to the edit instead of the workspace.

    /// Optimistic-lock row-level save used by the WebView auto-save loop.
    /// `delta` is the `WorkspaceDeltaPayload` produced by the frontend's
    /// pending-row queue: changed/deleted entity rows plus history / trash /
    /// revision rows and optional meta keys.
    pub fn save_rows_checked(
        &self,
        delta: &Value,
        expected_rev: Option<i64>,
    ) -> Result<SaveResult, AppError> {
        Ok(match self.save_rows_impl(delta, expected_rev)? {
            StoreOutcome::Saved { rev, .. } => SaveResult::Saved(rev),
            StoreOutcome::Conflict(current) => SaveResult::Conflict(current),
        })
    }

    fn save_rows_impl(
        &self,
        delta: &Value,
        expected_rev: Option<i64>,
    ) -> Result<StoreOutcome, AppError> {
        let object = delta
            .as_object()
            .ok_or_else(|| AppError::Storage("行级保存载荷必须是 JSON 对象".into()))?;
        let empty_map = Map::new();
        let rows = object.get("rows").and_then(Value::as_object).unwrap_or(&empty_map);

        // Seal every row BEFORE opening the write transaction: field-level
        // AES-GCM is CPU work we do not need to hold the write lock for. The
        // row objects carry the same key names as the corresponding snapshot
        // entities, so `vault.seal` encrypts exactly the paths the full-save
        // path encrypts and `vault.open` decrypts them unchanged.
        let mut staged: Vec<StagedEntityRow> = Vec::new();
        for (domain, items) in rows {
            let (kind, domain_sub_kind) = delta_domain_kind(domain)
                .ok_or_else(|| AppError::Storage(format!("未知的行域: {domain}")))?;
            let items = items
                .as_array()
                .ok_or_else(|| AppError::Storage(format!("行域 {domain} 必须是数组")))?;
            for (position, row) in items.iter().enumerate() {
                let row = row
                    .as_object()
                    .ok_or_else(|| AppError::Storage(format!("行域 {domain} 的行必须是对象")))?;
                let id = str_field(row, "id");
                if id.is_empty() {
                    return Err(AppError::Storage(format!("行域 {domain} 存在缺少 id 的行")));
                }
                // artifacts 是行模型统一后的共享域：四种构件共用一张表，子类型
                // 由每行的 `kind` 字段决定（前端 artifactToRow 输出），不能再像
                // 旧版那样按域名固定 sub_kind。其余域仍用域级映射。
                let sub_kind: Option<&'static str> = if domain == "artifacts" {
                    let row_kind = str_field(row, "kind");
                    Some(artifact_sub_kind(&row_kind).ok_or_else(|| {
                        AppError::Storage(format!(
                            "行域 artifacts 存在未知 kind: {row_kind}"
                        ))
                    })?)
                } else {
                    domain_sub_kind
                };
                let sealed = self.vault.seal(&Value::Object(row.clone()))?;
                let sealed_row = sealed
                    .as_object()
                    .ok_or_else(|| AppError::Storage(format!("行 {domain}:{id} 密封后不是对象")))?;
                let data_value = sealed_row.get("data").cloned().unwrap_or_else(|| json!({}));
                let data = serde_json::to_string(&data_value)
                    .map_err(|error| AppError::Storage(format!("序列化行数据失败 ({id}): {error}")))?;
                if data.len() > MAX_ROW_DATA_BYTES {
                    return Err(AppError::Storage(format!(
                        "行 {domain}:{id} 的数据 {} MiB 超过单行上限 {} MiB",
                        data.len() / (1024 * 1024),
                        MAX_ROW_DATA_BYTES / (1024 * 1024),
                    )));
                }
                let auth = match sealed_row.get("auth") {
                    Some(Value::Null) | None => None,
                    Some(value) => Some(
                        serde_json::to_string(value)
                            .map_err(|error| AppError::Storage(format!("序列化鉴权失败 ({id}): {error}")))?,
                    ),
                };
                staged.push(StagedEntityRow {
                    id,
                    kind,
                    sub_kind: sub_kind.map(str::to_string),
                    parent_id: parent_id_of(domain, row),
                    folder_path: str_field(row, "folderPath"),
                    name: str_field(row, "name"),
                    method: opt_str_field(row, "method"),
                    url: opt_str_field(row, "url"),
                    protocol: opt_str_field(row, "protocol"),
                    auth,
                    // 行自带的 position 是权威顺序（前端按集合内下标 / 域内下标
                    // 生成）；数组下标只作为旧载荷缺字段时的兜底。忽略它会把这
                    // 一行写成 0，导致重开项目后接口/集合顺序错乱。
                    position: row
                        .get("position")
                        .and_then(Value::as_i64)
                        .unwrap_or(position as i64),
                    enabled: bool_field_or(row, "enabled", true),
                    case_group: opt_str_field(row, "caseGroup"),
                    updated_at: row_updated_at(row.get("updatedAt")),
                    deleted: row.get("deleted").and_then(Value::as_bool).unwrap_or(false),
                    data,
                });
            }
        }

        // 辅助行（history / trash / revisions）与 meta：同样先密封。
        let mut staged_history: Vec<(String, i64, String)> = Vec::new();
        for entry in delta_array(object, "history") {
            let entry = entry
                .as_object()
                .ok_or_else(|| AppError::Storage("history 行必须是对象".into()))?;
            let id = str_field(entry, "id");
            let sealed = self.vault.seal(&Value::Object(entry.clone()))?;
            staged_history.push((
                id,
                entry.get("at").and_then(Value::as_i64).unwrap_or(0),
                serde_json::to_string(&sealed)
                    .map_err(|error| AppError::Storage(format!("序列化历史失败: {error}")))?,
            ));
        }
        let mut staged_trash: Vec<(String, i64, String)> = Vec::new();
        for entry in delta_array(object, "trash") {
            let entry = entry
                .as_object()
                .ok_or_else(|| AppError::Storage("trash 行必须是对象".into()))?;
            let id = str_field(entry, "id");
            let sealed = self.vault.seal(&Value::Object(entry.clone()))?;
            staged_trash.push((
                id,
                entry.get("deletedAt").and_then(Value::as_i64).unwrap_or(0),
                serde_json::to_string(&sealed)
                    .map_err(|error| AppError::Storage(format!("序列化回收站失败: {error}")))?,
            ));
        }
        let mut staged_revisions: Vec<(String, String, i64, String)> = Vec::new();
        for entry in delta_array(object, "revisions") {
            let entry = entry
                .as_object()
                .ok_or_else(|| AppError::Storage("revision 行必须是对象".into()))?;
            let id = str_field(entry, "id");
            let request_id = str_field(entry, "requestId");
            let sealed = self.vault.seal(&Value::Object(entry.clone()))?;
            staged_revisions.push((
                request_id,
                id,
                entry.get("at").and_then(Value::as_i64).unwrap_or(0),
                serde_json::to_string(&sealed)
                    .map_err(|error| AppError::Storage(format!("序列化修订失败: {error}")))?,
            ));
        }
        let mut staged_meta: Vec<(String, String)> = Vec::new();
        if let Some(meta) = object.get("meta").and_then(Value::as_object) {
            for (key, value) in meta {
                // 与整份保存一致：meta 值同样经过凭据密封。
                let sealed = self.vault.seal(value)?;
                staged_meta.push((
                    key.clone(),
                    serde_json::to_string(&sealed)
                        .map_err(|error| AppError::Storage(format!("序列化 meta 失败: {error}")))?,
                ));
            }
        }

        let history_deletes = string_list(object, "historyDeletes");
        let trash_deletes = string_list(object, "trashDeletes");
        let revision_deletes = object
            .get("revisionDeletes")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let request_id = item.get("requestId").and_then(Value::as_str)?;
                        let id = item.get("id").and_then(Value::as_str)?;
                        Some((request_id.to_string(), id.to_string()))
                    })
                    .collect::<Vec<(String, String)>>()
            })
            .unwrap_or_default();

        let max_bytes = self.max_bytes();
        self.with_conn(|conn| {
            save_rows_transaction(
                conn,
                &staged,
                &staged_history,
                &staged_trash,
                &staged_revisions,
                &staged_meta,
                &history_deletes,
                &trash_deletes,
                &revision_deletes,
                expected_rev,
                max_bytes,
            )
        })
        .map(|(_, outcome)| outcome)
    }

    // ------------------------------------------------- external delta ----

    /// 外部增量刷新（WebView 变更轮询用）：返回自 `from_rev` 以来变化的全部
    /// 实体（已装配、已解密）。`reset: true` 表示调用方的版本号领先于数据库
    /// （例如项目库被整体替换），此时只能整份重载。
    pub fn workspace_delta(&self, from_rev: i64) -> Result<Value, AppError> {
        let vault = &self.vault;
        self.with_conn(|conn| {
            let current = read_workspace_rev(conn)?;
            if from_rev > current.rev {
                return Ok(json!({
                    "reset": true,
                    "rev": current.rev,
                    "writer": current.writer,
                }));
            }
            read_changed_entities(conn, vault, from_rev, &current)
        })
        .map(|(_, payload)| payload)
    }

    /// 单实体详情读取（阶段 2 的按需详情入口）：只查一行、只解密这一行，
    /// 装配规则与整份读取 / 增量读取一致。
    pub fn get_entity(&self, kind: &str, id: &str) -> Result<Value, AppError> {
        let vault = &self.vault;
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT id, kind, parent_id, folder_path, name, method, url, protocol, auth,
                            enabled, case_group, sub_kind, updated_at, deleted, data
                     FROM entity WHERE id = ?1",
                )
                .map_err(|error| AppError::Storage(format!("读取实体失败: {error}")))?;
            let record = statement
                .query_row([id], |row| {
                    Ok(RowRecord {
                        id: row.get(0)?,
                        kind: row.get(1)?,
                        parent_id: row.get(2)?,
                        folder_path: row.get(3)?,
                        name: row.get(4)?,
                        method: row.get(5)?,
                        url: row.get(6)?,
                        protocol: row.get(7)?,
                        auth: row.get(8)?,
                        enabled: row.get(9)?,
                        case_group: row.get(10)?,
                        sub_kind: row.get(11)?,
                        updated_at: row.get(12)?,
                        deleted: row.get::<_, i64>(13)? != 0,
                        data: row.get(14)?,
                    })
                })
                .optional()
                .map_err(|error| AppError::Storage(format!("读取实体失败: {error}")))?
                .ok_or_else(|| AppError::Storage(format!("实体不存在: {kind}/{id}")))?;

            if record.deleted {
                return Ok(json!({
                    "kind": tombstone_kind(&record.kind, record.sub_kind.as_deref()),
                    "id": record.id,
                    "updatedAt": record.updated_at,
                    "deleted": true,
                }));
            }
            if domain_of_row(&record.kind, record.sub_kind.as_deref()).is_none() {
                return Err(AppError::Storage(format!("实体类型不受支持: {}", record.kind)));
            }

            let mut item = match parse_data(&record.data)? {
                Value::Object(map) => map,
                _ => Map::new(),
            };
            item.insert("id".into(), json!(record.id));
            item.insert("name".into(), json!(record.name));
            item.insert("updatedAt".into(), json!(record.updated_at));
            match record.kind.as_str() {
                KIND_FOLDER => {
                    if let Some(auth) = record.auth {
                        item.insert("auth".into(), serde_json::from_str(&auth).unwrap_or(Value::Null));
                    }
                    item.entry("items".to_string()).or_insert_with(|| json!([]));
                }
                KIND_REQUEST => {
                    item.insert("folder".into(), json!(record.folder_path));
                    item.insert("method".into(), json!(record.method.unwrap_or_else(|| "GET".into())));
                    item.insert("url".into(), json!(record.url.unwrap_or_default()));
                    item.insert("protocol".into(), json!(record.protocol.unwrap_or_else(|| "http".into())));
                }
                KIND_CASE => {
                    strip_request_runtime_cache(&mut item);
                    item.insert("requestId".into(), json!(record.parent_id.unwrap_or_default()));
                    item.insert("group".into(), json!(record.case_group.unwrap_or_else(|| "其他".into())));
                    item.insert("enabled".into(), json!(record.enabled));
                }
                KIND_ARTIFACT if record.sub_kind.as_deref() == Some("docPage") => {
                    item.insert("title".into(), json!(record.name));
                }
                _ => {}
            }
            vault.open(&Value::Object(item))
        })
        .map(|(_, value)| value)
    }

    // ------------------------------------------------- sync baseline ----
    //
    // The three-way-merge ancestor used to live in the WebView's
    // localStorage: clearing browser data (or shipping a new WebView data
    // directory) silently lost it and downgraded the next merge to plain LWW.
    // Keeping it in the project database means it follows the same backup,
    // project switch and data-root migration paths as the workspace itself.

    pub fn load_sync_baseline(&self, key: &str) -> Result<Option<Value>, AppError> {
        self.with_conn(|conn| {
            let raw = conn
                .query_row(
                    "SELECT payload FROM sync_baseline WHERE project_key = ?1",
                    rusqlite::params![key],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| AppError::Storage(format!("读取同步基线失败: {error}")))?;
            match raw {
                None => Ok(None),
                Some(text) => serde_json::from_str::<Value>(&text)
                    .map(Some)
                    .map_err(|error| AppError::Storage(format!("解析同步基线失败: {error}"))),
            }
        })
        .map(|(_, value)| value)
    }

    pub fn save_sync_baseline(&self, key: &str, payload: &Value) -> Result<(), AppError> {
        let text = serde_json::to_string(payload)
            .map_err(|error| AppError::Storage(format!("序列化同步基线失败: {error}")))?;
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO sync_baseline (project_key, payload, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(project_key) DO UPDATE SET
                     payload = excluded.payload, updated_at = excluded.updated_at",
                rusqlite::params![key, text, crate::logging::now_millis() as i64],
            )
            .map_err(|error| AppError::Storage(format!("保存同步基线失败: {error}")))?;
            Ok(())
        })
        .map(|_| ())
    }

    pub fn clear_sync_baseline(&self, key: &str) -> Result<(), AppError> {
        self.with_conn(|conn| {
            conn.execute(
                "DELETE FROM sync_baseline WHERE project_key = ?1",
                rusqlite::params![key],
            )
            .map_err(|error| AppError::Storage(format!("清除同步基线失败: {error}")))?;
            Ok(())
        })
        .map(|_| ())
    }

    /// Wipe baselines across every known project directory (used when the
    /// cloud server / account changes). Directories are supplied by the
    /// project registry; stale databases without the table are tolerated.
    pub fn clear_all_sync_baselines(&self, dirs: &[PathBuf]) -> Result<(), AppError> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM sync_baseline", [])
                .map_err(|error| AppError::Storage(format!("清除同步基线失败: {error}")))?;
            Ok(())
        })
        .map(|_| ())?;
        for dir in dirs {
            let db = dir.join(DB_FILE);
            if !db.exists() {
                continue;
            }
            let conn = Connection::open(&db)
                .map_err(|error| AppError::Storage(format!("打开项目数据库失败: {error}")))?;
            conn.execute_batch(SYNC_BASELINE_DDL)
                .map_err(|error| AppError::Storage(format!("初始化同步基线表失败: {error}")))?;
            conn.execute("DELETE FROM sync_baseline", [])
                .map_err(|error| AppError::Storage(format!("清除同步基线失败: {error}")))?;
        }
        Ok(())
    }

    /// Copy the database file into a timestamped backup directory. Returns the
    /// directory path so the UI can show where the data went.
    pub fn backup(&self, reason: &str) -> Result<PathBuf, AppError> {
        let dir = self.with_conn(|conn| {
            let rows: i64 = conn
                .query_row(
                    "SELECT (SELECT COUNT(*) FROM entity) + (SELECT COUNT(*) FROM history)\
                     + (SELECT COUNT(*) FROM trash) + (SELECT COUNT(*) FROM request_revision)",
                    [],
                    |row| row.get(0),
                )
                .map_err(|error| AppError::Storage(format!("检查数据库失败: {error}")))?;
            if rows == 0 {
                return Err(AppError::Storage("当前没有可备份的工作区数据".into()));
            }
            // Fold the WAL back into the main file so a plain copy is complete.
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
                .map_err(|error| AppError::Storage(format!("checkpoint 失败: {error}")))?;
            Ok(())
        })
        .map(|(dir, ())| dir)?;
        if !dir.join(DB_FILE).exists() {
            return Err(AppError::Storage("当前没有可备份的工作区数据".into()));
        }
        let backups_dir = dir.join(BACKUPS_DIR);
        fs::create_dir_all(&backups_dir)
            .map_err(|error| AppError::Storage(format!("创建备份目录失败: {error}")))?;

        let label: String = reason
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
            .take(32)
            .collect();
        let label = if label.is_empty() { "manual".to_string() } else { label };
        let target = backups_dir.join(format!(
            "workspace-{}-{}",
            crate::logging::now_millis(),
            label
        ));
        fs::create_dir_all(&target)
            .map_err(|error| AppError::Storage(format!("创建备份目录失败: {error}")))?;
        fs::copy(dir.join(DB_FILE), target.join(DB_FILE))
            .map_err(|error| AppError::Storage(format!("写入备份失败: {error}")))?;

        let mut folders: Vec<PathBuf> = fs::read_dir(&backups_dir)
            .map_err(|error| AppError::Storage(format!("读取备份目录失败: {error}")))?
            .filter_map(|entry| entry.ok().map(|item| item.path()))
            .filter(|path| path.is_dir())
            .collect();
        folders.sort();
        while folders.len() > MAX_BACKUPS {
            let oldest = folders.remove(0);
            let _ = fs::remove_dir_all(oldest);
        }
        Ok(target)
    }

    /// Copy the active workspace into `target` while the app keeps running.
    ///
    /// A raw file copy of a WAL database can capture a torn snapshot (the main
    /// file plus sidecars are not atomic together). This folds the WAL back
    /// into the main file under the same mutex every save takes, copies the
    /// data files, then opens the copy and runs `PRAGMA integrity_check` before
    /// the caller repoints the project registry.
    pub fn copy_to(&self, target: &Path) -> Result<(), AppError> {
        fs::create_dir_all(target)
            .map_err(|error| AppError::Storage(format!("创建目标数据目录失败: {error}")))?;
        let mut inner = self.lock_inner()?;
        if inner.conn.is_none() {
            inner.conn = Some(open_db(&inner.dir)?);
        }
        let source = inner.dir.clone();
        {
            let conn = inner
                .conn
                .as_ref()
                .ok_or_else(|| AppError::Internal("数据库连接不可用".into()))?;
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
                .map_err(|error| AppError::Storage(format!("复制前 checkpoint 失败: {error}")))?;
        }

        // Still holding the lock: no save can append new WAL frames mid-copy.
        for entry in fs::read_dir(&source)
            .map_err(|error| AppError::Storage(format!("读取原数据目录失败: {error}")))?
        {
            let entry =
                entry.map_err(|error| AppError::Storage(format!("读取原数据目录失败: {error}")))?;
            let path = entry.path();
            let name = entry.file_name();
            if !path.is_file() {
                continue;
            }
            // WAL was just truncated; copying its sidecars could reintroduce
            // frames that do not match the main file.
            let is_data_file = path.extension().and_then(|ext| ext.to_str()) == Some("json")
                || name == DB_FILE;
            if !is_data_file {
                continue;
            }
            fs::copy(&path, target.join(&name))
                .map_err(|error| AppError::Storage(format!("复制现有数据到新目录失败: {error}")))?;
        }
        // Remove stale sidecars from an earlier interrupted copy.
        let _ = fs::remove_file(target.join("workspace.db-wal"));
        let _ = fs::remove_file(target.join("workspace.db-shm"));

        let copied = Connection::open(target.join(DB_FILE))
            .map_err(|error| AppError::Storage(format!("打开复制后的数据库失败: {error}")))?;
        let integrity: String = copied
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(|error| AppError::Storage(format!("校验复制后的数据库失败: {error}")))?;
        if integrity != "ok" {
            return Err(AppError::Storage(format!(
                "复制后的数据库校验失败：{integrity}"
            )));
        }
        Ok(())
    }

    /// Archive the damaged database (and any legacy JSON) instead of destroying it.
    pub fn reset(&self) -> Result<Value, AppError> {        let dir = self.dir();
        if dir.exists() {
            let archive = dir.join(format!("corrupt-{}", crate::logging::now_millis()));
            fs::create_dir_all(&archive)
                .map_err(|error| AppError::Storage(format!("创建归档目录失败: {error}")))?;
            let entries: Vec<_> = fs::read_dir(&dir)
                .map_err(|error| AppError::Storage(format!("读取项目目录失败: {error}")))?
                .filter_map(|entry| entry.ok())
                .collect();
            for entry in entries {
                let path = entry.path();
                if path.is_file()
                    && (path.extension().and_then(|ext| ext.to_str()) == Some("db")
                        || path.extension().and_then(|ext| ext.to_str()) == Some("json")
                        || path.extension().and_then(|ext| ext.to_str()) == Some("db-wal")
                        || path.extension().and_then(|ext| ext.to_str()) == Some("db-shm"))
                {
                    fs::rename(&path, archive.join(entry.file_name()))
                        .map_err(|error| AppError::Storage(error.to_string()))?;
                }
            }
        }
        let mut inner = self.lock_inner()?;
        inner.conn = None; // re-open a fresh, empty database
        drop(inner);
        let snapshot = Self::default_snapshot();
        self.save(&snapshot)?;
        Ok(snapshot)
    }
}

// ------------------------------------------------------------ plumbing ----

impl WorkspaceStore {
    fn lock_inner(&self) -> Result<std::sync::MutexGuard<'_, StoreInner>, AppError> {
        self.inner
            .lock()
            .map_err(|_| AppError::Internal("工作区存储锁不可用".into()))
    }

    /// Run `work` with an open connection, opening one lazily on first use.
    fn with_conn<T>(
        &self,
        work: impl FnOnce(&mut Connection) -> Result<T, AppError>,
    ) -> Result<(PathBuf, T), AppError> {
        let mut inner = self.lock_inner()?;
        if inner.conn.is_none() {
            let conn = open_db(&inner.dir)?;
            inner.conn = Some(conn);
        }
        let dir = inner.dir.clone();
        let conn = inner
            .conn
            .as_mut()
            .ok_or_else(|| AppError::Internal("数据库连接不可用".into()))?;
        let result = work(conn)?;
        Ok((dir, result))
    }
}

fn open_db(dir: &Path) -> Result<Connection, AppError> {
    fs::create_dir_all(dir)
        .map_err(|error| AppError::Storage(format!("创建项目数据目录失败: {error}")))?;
    let conn = Connection::open(dir.join(DB_FILE))
        .map_err(|error| AppError::Storage(format!("打开工作区数据库失败: {error}")))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| AppError::Storage(format!("设置 WAL 失败: {error}")))?;
    conn.pragma_update(None, "busy_timeout", 5_000)
        .map_err(|error| AppError::Storage(format!("设置 busy_timeout 失败: {error}")))?;
    ensure_schema(&conn)?;
    Ok(conn)
}

/// Same row model as the backend's `ws_entity` schema, minus the
/// project dimension (one database per project), plus local-only tables.
/// The three-way-merge ancestor is a separate table, never `meta`: saving a
/// workspace snapshot replaces every `meta` row that the staged set does not
/// contain (`apply_staged_changes`), which would silently wipe a baseline.
const SYNC_BASELINE_DDL: &str = r#"
        CREATE TABLE IF NOT EXISTS sync_baseline (
            project_key TEXT PRIMARY KEY,
            payload     TEXT NOT NULL,
            updated_at  INTEGER NOT NULL
        );
        "#;

/// Optimistic-lock counter for the whole project database.
///
/// The desktop keeps the entire snapshot in WebView memory and rewrites rows
/// on auto-save, while the MCP server / CLI write individual rows into the
/// same SQLite file. Without a shared revision, a desktop save silently
/// overwrites out-of-process writes. Both writers bump this single counter in
/// the same transaction as their row changes; the desktop passes the revision
/// it loaded (`expectedRev`) and refuses to write when it is stale.
///
/// Deliberately NOT a `meta` row: `apply_staged_changes` deletes every meta
/// key that is not part of the staged snapshot.
const WORKSPACE_REV_DDL: &str = r#"
        CREATE TABLE IF NOT EXISTS workspace_rev (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            rev         INTEGER NOT NULL DEFAULT 0,
            writer      TEXT NOT NULL DEFAULT 'init',
            updated_at  INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO workspace_rev (id, rev, writer, updated_at)
            VALUES (1, 0, 'init', 0);
        "#;

/// Public projection of the revision counter (camelCase for the WebView).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRev {
    pub rev: i64,
    pub writer: String,
    pub updated_at: i64,
}

/// Result of a checked save. `Conflict` carries the revision that is actually
/// on disk, so the UI can name the last writer and offer reload / rollback.
#[derive(Debug)]
pub enum SaveResult {
    Saved(WorkspaceRev),
    Conflict(WorkspaceRev),
}

/// Internal outcome: also carries the incremental write count used by tests.
enum StoreOutcome {
    Saved {
        /// Incremental write count; asserted by delta tests via
        /// `save_with_write_count`. Written in all builds, read in tests only.
        #[allow(dead_code)]
        writes: u64,
        rev: WorkspaceRev,
    },
    Conflict(WorkspaceRev),
}

/// `reqora.run.v1` run archive (P0 evidence chain, T1.5).
///
/// This is a *derived index*, not a second source of truth: the full evidence
/// documents stay as JSON files on disk and are referenced by `evidence_path`.
/// `CREATE TABLE IF NOT EXISTS` is the whole migration — an older workspace
/// gets the table on its next open, with no rewrite and no data loss.
const RUN_HISTORY_DDL: &str = r#"
        CREATE TABLE IF NOT EXISTS run_history (
            run_id       TEXT PRIMARY KEY,
            subject_kind TEXT NOT NULL,
            subject_id   TEXT NOT NULL,
            subject_name TEXT NOT NULL,
            started_at   INTEGER NOT NULL,
            ok           INTEGER NOT NULL,
            total        INTEGER NOT NULL,
            passed       INTEGER NOT NULL,
            failed       INTEGER NOT NULL,
            skipped      INTEGER NOT NULL,
            evidence_path TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_run_history_subject
            ON run_history (subject_id, started_at DESC);
        "#;

fn ensure_schema(conn: &Connection) -> Result<(), AppError> {
    // Kept as a separate literal: the entity table contains `DEFAULT '{}'`,
    // which would be parsed as a format placeholder if inlined in format!.
    const BASE_SCHEMA: &str = r#"
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS entity (
            id         TEXT PRIMARY KEY,
            kind       TEXT NOT NULL,
            parent_id  TEXT,
            folder_path TEXT NOT NULL DEFAULT '',
            name       TEXT NOT NULL,
            method     TEXT,
            url        TEXT,
            protocol   TEXT,
            auth       TEXT,
            position   INTEGER NOT NULL DEFAULT 0,
            enabled    INTEGER NOT NULL DEFAULT 1,
            case_group TEXT,
            sub_kind   TEXT,
            updated_at INTEGER NOT NULL DEFAULT 0,
            deleted    INTEGER NOT NULL DEFAULT 0,
            data       TEXT NOT NULL DEFAULT '{}',
            rev        INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_entity_kind ON entity (kind, deleted, position);
        CREATE INDEX IF NOT EXISTS idx_entity_parent ON entity (kind, parent_id);
        CREATE TABLE IF NOT EXISTS history (
            id   TEXT PRIMARY KEY,
            at   INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS trash (
            id         TEXT PRIMARY KEY,
            deleted_at INTEGER NOT NULL,
            data       TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS request_revision (
            request_id TEXT NOT NULL,
            id         TEXT NOT NULL,
            at         INTEGER NOT NULL,
            data       TEXT NOT NULL,
            PRIMARY KEY (request_id, id)
        );
        -- 辅助表（history / trash / request_revision / meta）没有行级 rev，
        -- 这里按表记录"最后一次写它的工作区版本号"。增量读取据此告诉前端：
        -- 本次变化包含无法按实体行合并的辅助数据，需要整份重载。
        CREATE TABLE IF NOT EXISTS aux_rev (
            name TEXT PRIMARY KEY,
            rev  INTEGER NOT NULL DEFAULT 0
        );
        "#;
    let ddl = format!(
        "{BASE_SCHEMA}\n{SYNC_BASELINE_DDL}\n{RUN_HISTORY_DDL}\n{WORKSPACE_REV_DDL}"
    );
    conn.execute_batch(&ddl)
        .map_err(|error| AppError::Storage(format!("初始化工作区数据库失败: {error}")))?;
    ensure_entity_rev_column(conn)
}

/// `entity.rev` 是外部增量刷新（`load_workspace_delta`）的行级水位：所有写入方
/// （桌面 delta / 整份保存 / MCP·CLI）都会把自己触碰的行标成
/// `workspace_rev + 1`，因此"自版本 R 以来变了哪些行"就是一条索引查询。
/// 旧库在此补列并回填到当前共享版本号 —— 升级后的第一次增量读取是空操作。
fn ensure_entity_rev_column(conn: &Connection) -> Result<(), AppError> {
    let has_rev: bool = {
        let mut statement = conn
            .prepare("PRAGMA table_info(entity)")
            .map_err(|error| AppError::Storage(format!("检查 entity 表结构失败: {error}")))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| AppError::Storage(format!("检查 entity 表结构失败: {error}")))?;
        let mut found = false;
        for name in rows {
            let name = name
                .map_err(|error| AppError::Storage(format!("检查 entity 表结构失败: {error}")))?;
            if name == "rev" {
                found = true;
            }
        }
        found
    };
    if !has_rev {
        conn.execute_batch(
            "ALTER TABLE entity ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
             UPDATE entity SET rev = COALESCE((SELECT rev FROM workspace_rev WHERE id = 1), 0);",
        )
        .map_err(|error| AppError::Storage(format!("迁移 entity.rev 列失败: {error}")))?;
    }
    // 索引必须在补列之后创建：旧库的 CREATE TABLE IF NOT EXISTS 不会加列。
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_entity_rev ON entity (rev);")
        .map_err(|error| AppError::Storage(format!("创建行版本索引失败: {error}")))?;
    Ok(())
}

// ------------------------------------------------- snapshot → rows ----

fn row_updated_at(value: Option<&Value>) -> i64 {
    match value.and_then(Value::as_i64) {
        Some(millis) if millis > 0 => millis,
        // No fallback to "now": a fabricated timestamp would make a row with
        // unknown age win or lose LWW by accident. The frontend stamps every
        // edit before persisting; 0 simply means "unknown / oldest".
        _ => 0,
    }
}

fn data_json(value: Option<&Value>) -> Result<String, AppError> {
    serde_json::to_string(value.unwrap_or(&json!({})))
        .map_err(|error| AppError::Storage(format!("序列化行数据失败: {error}")))
}

fn insert_entity(
    conn: &Connection,
    kind: &str,
    id: &str,
    name: &str,
    updated_at: i64,
    parent_id: Option<&str>,
    folder_path: &str,
    method: Option<&str>,
    url: Option<&str>,
    protocol: Option<&str>,
    auth: Option<&str>,
    position: i64,
    enabled: bool,
    case_group: Option<&str>,
    sub_kind: Option<&str>,
    data: &str,
    deleted: bool,
) -> Result<(), AppError> {
    // Rows are staged first; `apply_staged_changes` later diffs them against
    // the live tables so an unchanged row never produces a write.
    conn.execute(
        r#"INSERT INTO stage_entity
           (id, kind, parent_id, folder_path, name, method, url, protocol, auth,
            position, enabled, case_group, sub_kind, updated_at, deleted, data)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)"#,
        rusqlite::params![
            id,
            kind,
            parent_id,
            folder_path,
            name,
            method,
            url,
            protocol,
            auth,
            position,
            enabled as i64,
            case_group,
            sub_kind,
            updated_at,
            deleted as i64,
            data,
        ],
    )
    .map_err(|error| AppError::Storage(format!("写入行失败 ({kind}:{id}): {error}")))?;
    Ok(())
}

/// Read the shared revision counter, self-healing on legacy / hand-built
/// databases that predate the `workspace_rev` table. Safe on read-only
/// connections when the table already exists (plain SELECT only).
fn read_workspace_rev(conn: &Connection) -> Result<WorkspaceRev, AppError> {
    let row = conn.query_row(
        "SELECT rev, writer, updated_at FROM workspace_rev WHERE id = 1",
        [],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    );
    match row {
        Ok((rev, writer, updated_at)) => Ok(WorkspaceRev { rev, writer, updated_at }),
        Err(error) => {
            // `optional()` cannot absorb "no such table": that is a prepare
            // error, not an empty result set. Recreate just this table so old
            // project databases and test fixtures keep working.
            conn.execute_batch(WORKSPACE_REV_DDL)
                .map_err(|e| AppError::Storage(format!("初始化工作区版本号失败: {e}")))?;
            if !error.to_string().contains("no such table") {
                return Err(AppError::Storage(format!("读取工作区版本号失败: {error}")));
            }
            Ok(WorkspaceRev { rev: 0, writer: "init".into(), updated_at: 0 })
        }
    }
}

fn store_snapshot(
    conn: &mut Connection,
    object: &Map<String, Value>,
    expected_rev: Option<i64>,
    force: bool,
) -> Result<StoreOutcome, AppError> {
    let tx = conn
        .transaction()
        .map_err(|error| AppError::Storage(format!("开启事务失败: {error}")))?;

    // CAS happens INSIDE the write transaction, after the SQLite write lock is
    // held: an MCP writer that committed between the WebView's initial read
    // and this save is therefore always visible here.
    let current = read_workspace_rev(&tx)?;
    if !force {
        if let Some(expected) = expected_rev {
            if expected != current.rev {
                // Returning Ok (not Err) keeps the transaction clean: no staged
                // table, no row write, no revision bump.
                return Ok(StoreOutcome::Conflict(current));
            }
        }
    }

    create_stage_tables(&tx)?;

    // 项目 → 文件夹(集合) → 接口：真正的层级行。
    if let Some(collections) = object.get("collections").and_then(Value::as_array) {
        for (collection_index, collection) in collections.iter().enumerate() {
            let collection_id = collection.get("id").and_then(Value::as_str).unwrap_or("");
            let collection_name = collection.get("name").and_then(Value::as_str).unwrap_or("");
            let auth_json = data_json(collection.get("auth"))?;
            // 显式登记的空文件夹（Collection.folders）作为集合行的 data payload 持久化。
            let folders_data = match collection.get("folders").and_then(Value::as_array) {
                Some(list) if !list.is_empty() => serde_json::to_string(&json!({ "folders": list }))
                    .map_err(|error| AppError::Storage(format!("序列化集合失败: {error}")))?,
                _ => "{}".to_string(),
            };
            insert_entity(
                &tx,
                KIND_FOLDER,
                collection_id,
                collection_name,
                row_updated_at(collection.get("updatedAt")),
                None,
                "",
                None,
                None,
                None,
                if collection.get("auth").is_some() { Some(auth_json.as_str()) } else { None },
                collection_index as i64,
                true,
                None,
                None,
                folders_data.as_str(),
                false,
            )?;
            if let Some(items) = collection.get("items").and_then(Value::as_array) {
                for (item_index, item) in items.iter().enumerate() {
                    let item_id = item.get("id").and_then(Value::as_str).unwrap_or("");
                    let rest = omit_keys(
                        item,
                        &["id", "folder", "name", "method", "url", "protocol", "updatedAt"],
                    );
                    insert_entity(
                        &tx,
                        KIND_REQUEST,
                        item_id,
                        item.get("name").and_then(Value::as_str).unwrap_or(""),
                        row_updated_at(item.get("updatedAt")),
                        Some(collection_id),
                        item.get("folder").and_then(Value::as_str).unwrap_or(""),
                        Some(item.get("method").and_then(Value::as_str).unwrap_or("GET")),
                        Some(item.get("url").and_then(Value::as_str).unwrap_or("")),
                        Some(item.get("protocol").and_then(Value::as_str).unwrap_or("http")),
                        None,
                        item_index as i64,
                        true,
                        None,
                        None,
                        &serde_json::to_string(&rest)
                            .map_err(|error| AppError::Storage(format!("序列化接口失败: {error}")))?,
                        false,
                    )?;
                }
            }
        }
    }

    let insert_domain =
        |kind: &str,
         key: &str,
         name_key: &str,
         sub_kind: Option<&str>,
         tx: &rusqlite::Transaction| -> Result<(), AppError> {
            if let Some(items) = object.get(key).and_then(Value::as_array) {
                for (index, item) in items.iter().enumerate() {
                    let id = item.get("id").and_then(Value::as_str).unwrap_or("");
                    let name = item.get(name_key).and_then(Value::as_str).unwrap_or("");
                    let rest = omit_keys(item, &["id", name_key]);
                    insert_entity(
                        tx,
                        kind,
                        id,
                        name,
                        row_updated_at(item.get("updatedAt")),
                        None,
                        "",
                        None,
                        None,
                        None,
                        None,
                        index as i64,
                        true,
                        None,
                        sub_kind,
                        &serde_json::to_string(&rest)
                            .map_err(|error| AppError::Storage(format!("序列化 {kind} 失败: {error}")))?,
                        false,
                    )?;
                }
            }
            Ok(())
        };
    insert_domain(KIND_ENVIRONMENT, "environments", "name", None, &tx)?;
    insert_domain(KIND_SCENARIO, "scenarios", "name", None, &tx)?;
    insert_domain(KIND_SUITE, "suites", "name", None, &tx)?;
    insert_domain(KIND_DB_CONNECTION, "dbConnections", "name", None, &tx)?;
    insert_domain(KIND_MCP_SERVER, "mcpServers", "name", None, &tx)?;
    insert_domain(KIND_ARTIFACT, "docPages", "title", Some("docPage"), &tx)?;
    insert_domain(KIND_ARTIFACT, "dataModels", "name", Some("dataModel"), &tx)?;
    insert_domain(KIND_ARTIFACT, "scriptLibrary", "name", Some("scriptSnippet"), &tx)?;
    insert_domain(KIND_ARTIFACT, "codeTemplates", "name", Some("codeTemplate"), &tx)?;

    // 用例带 requestId / group / enabled 列。
    if let Some(cases) = object.get("cases").and_then(Value::as_array) {
        for case in cases {
            let rest = omit_keys(case, &["id", "requestId", "group", "name", "enabled", "updatedAt"]);
            insert_entity(
                &tx,
                KIND_CASE,
                case.get("id").and_then(Value::as_str).unwrap_or(""),
                case.get("name").and_then(Value::as_str).unwrap_or(""),
                row_updated_at(case.get("updatedAt")),
                Some(case.get("requestId").and_then(Value::as_str).unwrap_or("")),
                "",
                None,
                None,
                None,
                None,
                0,
                case.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                Some(case.get("group").and_then(Value::as_str).unwrap_or("其他")),
                None,
                &serde_json::to_string(&rest)
                    .map_err(|error| AppError::Storage(format!("序列化用例失败: {error}")))?,
                false,
            )?;
        }
    }

    // 删除墓碑：写成 deleted=1 的行，下一次 rebuild 时读回 tombstones。
    // 同一 id 若仍有活行（不一致的旧快照），活行优先，跳过墓碑。
    if let Some(tombstones) = object.get("tombstones").and_then(Value::as_array) {
        for tombstone in tombstones {
            let id = tombstone.get("id").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() {
                continue;
            }
            let kind = tombstone.get("kind").and_then(Value::as_str).unwrap_or("");
            let (entity_kind, sub_kind) = match kind {
                "folder" => (KIND_FOLDER, None),
                "request" => (KIND_REQUEST, None),
                "environment" => (KIND_ENVIRONMENT, None),
                "case" => (KIND_CASE, None),
                "scenario" => (KIND_SCENARIO, None),
                "suite" => (KIND_SUITE, None),
                "docPage" => (KIND_ARTIFACT, Some("docPage")),
                "dataModel" => (KIND_ARTIFACT, Some("dataModel")),
                "scriptSnippet" => (KIND_ARTIFACT, Some("scriptSnippet")),
                "codeTemplate" => (KIND_ARTIFACT, Some("codeTemplate")),
                _ => continue,
            };
            let already: bool = tx
                .query_row(
                    "SELECT 1 FROM stage_entity WHERE id = ?1",
                    rusqlite::params![id],
                    |_| Ok(true),
                )
                .optional()
                .map_err(|error| AppError::Storage(format!("检查墓碑冲突失败: {error}")))?
                .unwrap_or(false);
            if already {
                continue;
            }
            insert_entity(
                &tx,
                entity_kind,
                id,
                "",
                tombstone.get("updatedAt").and_then(Value::as_i64).unwrap_or(0),
                None,
                "",
                None,
                None,
                None,
                None,
                0,
                false,
                None,
                sub_kind,
                "{}",
                true,
            )?;
        }
    }

    // 本机域：历史 / 回收站 / 接口修订历史。
    if let Some(entries) = object.get("history").and_then(Value::as_array) {
        for entry in entries {
            tx.execute(
                "INSERT INTO stage_history (id, at, data) VALUES (?1, ?2, ?3)",
                rusqlite::params![
                    entry.get("id").and_then(Value::as_str).unwrap_or(""),
                    entry.get("at").and_then(Value::as_i64).unwrap_or(0),
                    serde_json::to_string(entry)
                        .map_err(|error| AppError::Storage(format!("序列化历史失败: {error}")))?,
                ],
            )
            .map_err(|error| AppError::Storage(format!("写入历史失败: {error}")))?;
        }
    }
    if let Some(entries) = object.get("trash").and_then(Value::as_array) {
        for entry in entries {
            tx.execute(
                "INSERT INTO stage_trash (id, deleted_at, data) VALUES (?1, ?2, ?3)",
                rusqlite::params![
                    entry.get("id").and_then(Value::as_str).unwrap_or(""),
                    entry.get("deletedAt").and_then(Value::as_i64).unwrap_or(0),
                    serde_json::to_string(entry)
                        .map_err(|error| AppError::Storage(format!("序列化回收站失败: {error}")))?,
                ],
            )
            .map_err(|error| AppError::Storage(format!("写入回收站失败: {error}")))?;
        }
    }
    if let Some(by_request) = object.get("revisions").and_then(Value::as_object) {
        for (request_id, revisions) in by_request {
            if let Some(revisions) = revisions.as_array() {
                for revision in revisions {
                    tx.execute(
                        "INSERT INTO stage_request_revision (request_id, id, at, data) VALUES (?1, ?2, ?3, ?4)",
                        rusqlite::params![
                            request_id,
                            revision.get("id").and_then(Value::as_str).unwrap_or(""),
                            revision.get("at").and_then(Value::as_i64).unwrap_or(0),
                            serde_json::to_string(revision)
                                .map_err(|error| AppError::Storage(format!("序列化修订失败: {error}")))?,
                        ],
                    )
                    .map_err(|error| AppError::Storage(format!("写入修订失败: {error}")))?;
                }
            }
        }
    }

    // meta：seeded / activeEnvironmentId / theme / settings。导入标记不在
    // 快照里，由 apply_staged_changes 的清理条件显式保留。
    let mut meta: Vec<(&str, String)> = Vec::new();
    for (key, value) in [
        ("seeded", object.get("seeded").cloned().unwrap_or(json!(false))),
        ("activeEnvironmentId", object.get("activeEnvironmentId").cloned().unwrap_or(Value::Null)),
        ("theme", object.get("theme").cloned().unwrap_or(Value::Null)),
    ] {
        meta.push((key, serde_json::to_string(&value)
            .map_err(|error| AppError::Storage(format!("序列化 meta 失败: {error}")))?));
    }
    if let Some(settings) = object.get("settings") {
        meta.push(("settings", serde_json::to_string(settings)
            .map_err(|error| AppError::Storage(format!("序列化 settings 失败: {error}")))?));
    }
    for (key, value) in meta {
        tx.execute(
            "INSERT INTO stage_meta (key, value) VALUES (?1, ?2)",
            rusqlite::params![key, value],
        )
        .map_err(|error| AppError::Storage(format!("写入 meta 失败: {error}")))?;
    }

    // 行级水位：本次整份保存触碰的行（新增/变化）都标成新版本号，外部增量
    // 刷新据此可见。未变化的行不会命中 IS NOT diff，保留旧水位。
    tx.execute(
        "UPDATE temp.stage_entity SET rev = ?1",
        rusqlite::params![current.rev + 1],
    )
    .map_err(|error| AppError::Storage(format!("标记行版本失败: {error}")))?;

    let covered = covered_entity_domains(object);
    // `collections` 是整份快照的必备域（validate_snapshot 强制要求），出现它
    // 就说明这次是"整份保存"：辅助表与墓碑按旧语义整体对齐；否则是局部载荷，
    // 只重写它显式提供的域。
    let whole_snapshot = object.contains_key("collections");
    let before_diff = tx.total_changes();
    apply_staged_changes(
        &tx,
        &covered,
        whole_snapshot || object.contains_key("history"),
        whole_snapshot || object.contains_key("trash"),
        whole_snapshot || object.contains_key("revisions"),
        whole_snapshot,
    )?;
    // Count only live row changes; the aux watermark and the revision bump below
    // must not inflate the incremental-write metric asserted by the storage tests.
    let live_writes = tx.total_changes() - before_diff;
    // 辅助表水位：整份保存会重写载荷提供的辅助域（meta 总是重写），
    // 增量读取据此让前端整份重载，而不是只合并实体行。
    let mut aux_changed: Vec<&str> = Vec::new();
    if object.contains_key("history") {
        aux_changed.push("history");
    }
    if object.contains_key("trash") {
        aux_changed.push("trash");
    }
    if object.contains_key("revisions") {
        aux_changed.push("revisions");
    }
    aux_changed.push("meta");
    mark_aux_changed(&tx, &aux_changed, current.rev + 1)?;
    tx.execute(
        "UPDATE workspace_rev SET rev = rev + 1, writer = 'desktop', updated_at = ?1 WHERE id = 1",
        rusqlite::params![crate::logging::now_millis() as i64],
    )
    .map_err(|error| AppError::Storage(format!("更新工作区版本号失败: {error}")))?;
    let rev = read_workspace_rev(&tx)?;
    tx.commit()
        .map_err(|error| AppError::Storage(format!("提交事务失败: {error}")))?;
    Ok(StoreOutcome::Saved { writes: live_writes, rev })
}

/// Build fresh TEMP staging tables with the exact live-table column order so
/// `INSERT INTO <live> SELECT * FROM <stage>` stays valid. TEMP tables are
/// connection-local and are dropped/recreated on every save.
fn create_stage_tables(tx: &Connection) -> Result<(), AppError> {
    tx.execute_batch(
        r#"
        DROP TABLE IF EXISTS temp.stage_entity;
        DROP TABLE IF EXISTS temp.stage_history;
        DROP TABLE IF EXISTS temp.stage_trash;
        DROP TABLE IF EXISTS temp.stage_request_revision;
        DROP TABLE IF EXISTS temp.stage_meta;
        CREATE TEMP TABLE stage_entity (
            id          TEXT PRIMARY KEY,
            kind        TEXT NOT NULL,
            parent_id   TEXT,
            folder_path TEXT NOT NULL,
            name        TEXT NOT NULL,
            method      TEXT,
            url         TEXT,
            protocol    TEXT,
            auth        TEXT,
            position    INTEGER NOT NULL,
            enabled     INTEGER NOT NULL,
            case_group  TEXT,
            sub_kind    TEXT,
            updated_at  INTEGER NOT NULL,
            deleted     INTEGER NOT NULL,
            data        TEXT NOT NULL,
            rev         INTEGER NOT NULL DEFAULT 0
        );
        CREATE TEMP TABLE stage_history (
            id   TEXT PRIMARY KEY,
            at   INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE TEMP TABLE stage_trash (
            id         TEXT PRIMARY KEY,
            deleted_at INTEGER NOT NULL,
            data       TEXT NOT NULL
        );
        CREATE TEMP TABLE stage_request_revision (
            request_id TEXT NOT NULL,
            id         TEXT NOT NULL,
            at         INTEGER NOT NULL,
            data       TEXT NOT NULL,
            PRIMARY KEY (request_id, id)
        );
        CREATE TEMP TABLE stage_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )
    .map_err(|error| AppError::Storage(format!("创建暂存表失败: {error}")))
}

/// 整份快照实际覆盖的实体域（kind, sub_kind）。只有载荷里显式出现的域才允许
/// "库里存在但快照没提到 → 删除"。缺域的局部快照（云同步只带部分集合、旧快照
/// 没有 suites / docPages 等）不能把库里同域的现有行抹掉；墓碑行仍逐条写
/// `deleted = 1`，不依赖这条隐式删除。
fn covered_entity_domains(
    object: &Map<String, Value>,
) -> Vec<(&'static str, Option<&'static str>)> {
    let mut covered = Vec::new();
    if object.contains_key("collections") {
        covered.push((KIND_FOLDER, None));
        covered.push((KIND_REQUEST, None));
    }
    if object.contains_key("environments") {
        covered.push((KIND_ENVIRONMENT, None));
    }
    if object.contains_key("cases") {
        covered.push((KIND_CASE, None));
    }
    if object.contains_key("scenarios") {
        covered.push((KIND_SCENARIO, None));
    }
    if object.contains_key("suites") {
        covered.push((KIND_SUITE, None));
    }
    if object.contains_key("dbConnections") {
        covered.push((KIND_DB_CONNECTION, None));
    }
    if object.contains_key("mcpServers") {
        covered.push((KIND_MCP_SERVER, None));
    }
    for (key, sub_kind) in [
        ("docPages", "docPage"),
        ("dataModels", "dataModel"),
        ("scriptLibrary", "scriptSnippet"),
        ("codeTemplates", "codeTemplate"),
    ] {
        if object.contains_key(key) {
            covered.push((KIND_ARTIFACT, Some(sub_kind)));
        }
    }
    covered
}

/// Apply the staged rows as a set diff instead of a full rewrite:
///  - rows that changed (or are new) get one upsert;
///  - rows present in the database but absent from the snapshot are deleted,
///    but only inside the domains the snapshot actually contains;
///  - identical rows produce **no SQL write at all**, which keeps repeated
///    auto-saves cheap and avoids rewriting `updated_at` on untouched data.
///
/// `IS NOT` is used deliberately: it treats NULL = NULL as equal, unlike `!=`.
fn apply_staged_changes(
    tx: &Connection,
    covered: &[(&'static str, Option<&'static str>)],
    cover_history: bool,
    cover_trash: bool,
    cover_revisions: bool,
    purge_tombstones: bool,
) -> Result<(), AppError> {
    let mut entity_deletes = String::new();
    for (kind, sub_kind) in covered {
        match sub_kind {
            Some(sub_kind) => entity_deletes.push_str(&format!(
                "DELETE FROM entity WHERE kind = '{kind}' AND sub_kind = '{sub_kind}'
                  AND id NOT IN (SELECT id FROM temp.stage_entity);\n"
            )),
            None => entity_deletes.push_str(&format!(
                "DELETE FROM entity WHERE kind = '{kind}'
                  AND id NOT IN (SELECT id FROM temp.stage_entity);\n"
            )),
        }
    }
    // 墓碑行（deleted=1）不参与"缺域保留"：整份快照没有列出它们，就说明前端
    // 已经清理过墓碑，旧实现的行为必须保持，否则墓碑会永久留在库里。
    let tombstone_delete = if purge_tombstones {
        "DELETE FROM entity WHERE deleted = 1
           AND id NOT IN (SELECT id FROM temp.stage_entity);\n"
    } else {
        ""
    };
    let history_delete = if cover_history {
        "DELETE FROM history WHERE id NOT IN (SELECT id FROM temp.stage_history);"
    } else {
        ""
    };
    let trash_delete = if cover_trash {
        "DELETE FROM trash WHERE id NOT IN (SELECT id FROM temp.stage_trash);"
    } else {
        ""
    };
    let revision_delete = if cover_revisions {
        "DELETE FROM request_revision
         WHERE (request_id || char(0) || id) NOT IN
               (SELECT request_id || char(0) || id FROM temp.stage_request_revision);"
    } else {
        ""
    };
    tx.execute_batch(
        format!(
            r#"
        INSERT INTO entity SELECT * FROM temp.stage_entity WHERE true
        ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            parent_id = excluded.parent_id,
            folder_path = excluded.folder_path,
            name = excluded.name,
            method = excluded.method,
            url = excluded.url,
            protocol = excluded.protocol,
            auth = excluded.auth,
            position = excluded.position,
            enabled = excluded.enabled,
            case_group = excluded.case_group,
            sub_kind = excluded.sub_kind,
            updated_at = excluded.updated_at,
            deleted = excluded.deleted,
            data = excluded.data,
            rev = excluded.rev
        WHERE entity.kind IS NOT excluded.kind
           OR entity.parent_id IS NOT excluded.parent_id
           OR entity.folder_path IS NOT excluded.folder_path
           OR entity.name IS NOT excluded.name
           OR entity.method IS NOT excluded.method
           OR entity.url IS NOT excluded.url
           OR entity.protocol IS NOT excluded.protocol
           OR entity.auth IS NOT excluded.auth
           OR entity.position IS NOT excluded.position
           OR entity.enabled IS NOT excluded.enabled
           OR entity.case_group IS NOT excluded.case_group
           OR entity.sub_kind IS NOT excluded.sub_kind
           OR entity.updated_at IS NOT excluded.updated_at
           OR entity.deleted IS NOT excluded.deleted
           OR entity.data IS NOT excluded.data;
        {entity_deletes}
        {tombstone_delete}

        INSERT INTO history SELECT * FROM temp.stage_history WHERE true
        ON CONFLICT(id) DO UPDATE SET at = excluded.at, data = excluded.data
        WHERE history.at IS NOT excluded.at OR history.data IS NOT excluded.data;
        {history_delete}

        INSERT INTO trash SELECT * FROM temp.stage_trash WHERE true
        ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at, data = excluded.data
        WHERE trash.deleted_at IS NOT excluded.deleted_at OR trash.data IS NOT excluded.data;
        {trash_delete}

        INSERT INTO request_revision SELECT * FROM temp.stage_request_revision WHERE true
        ON CONFLICT(request_id, id) DO UPDATE SET at = excluded.at, data = excluded.data
        WHERE request_revision.at IS NOT excluded.at
           OR request_revision.data IS NOT excluded.data;
        {revision_delete}

        INSERT INTO meta SELECT * FROM temp.stage_meta WHERE true
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        WHERE meta.value IS NOT excluded.value;
        DELETE FROM meta
        WHERE key NOT IN (SELECT key FROM temp.stage_meta)
          AND key != '{LEGACY_IMPORTED_KEY}';
        "#
        )
        .as_str(),
    )
    .map_err(|error| AppError::Storage(format!("应用增量变更失败: {error}")))
}

// --------------------------------------------- row-level delta (WebView) ----

/// 行级保存载荷里已密封、待写入 `entity` 表的一行。
struct StagedEntityRow {
    id: String,
    kind: &'static str,
    sub_kind: Option<String>,
    parent_id: Option<String>,
    folder_path: String,
    name: String,
    method: Option<String>,
    url: Option<String>,
    protocol: Option<String>,
    auth: Option<String>,
    position: i64,
    enabled: bool,
    case_group: Option<String>,
    updated_at: i64,
    deleted: bool,
    data: String,
}

/// 行级载荷的域 → `entity.kind` / `sub_kind`（与 store_snapshot 的落库映射一致）。
fn delta_domain_kind(domain: &str) -> Option<(&'static str, Option<&'static str>)> {
    match domain {
        "folders" => Some((KIND_FOLDER, None)),
        "requests" => Some((KIND_REQUEST, None)),
        "environments" => Some((KIND_ENVIRONMENT, None)),
        "cases" => Some((KIND_CASE, None)),
        "scenarios" => Some((KIND_SCENARIO, None)),
        "suites" => Some((KIND_SUITE, None)),
        // 行模型统一域：四种共享构件合并为一个 artifacts 数组，sub_kind 由
        // 每行自带的 `kind` 决定（见 artifact_sub_kind）。旧的四个独立域名
        // 仍保留，兼容尚未迁移的调用方。
        "artifacts" => Some((KIND_ARTIFACT, None)),
        "docPages" => Some((KIND_ARTIFACT, Some("docPage"))),
        "dataModels" => Some((KIND_ARTIFACT, Some("dataModel"))),
        "scriptLibrary" => Some((KIND_ARTIFACT, Some("scriptSnippet"))),
        "codeTemplates" => Some((KIND_ARTIFACT, Some("codeTemplate"))),
        "dbConnections" => Some((KIND_DB_CONNECTION, None)),
        "mcpServers" => Some((KIND_MCP_SERVER, None)),
        _ => None,
    }
}

/// artifacts 行内 `kind` → `entity.sub_kind`，与前端 ArtifactRow["kind"] 及
/// store_snapshot / domain_of_row 的子类型字面量保持一致。
fn artifact_sub_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "docPage" => Some("docPage"),
        "dataModel" => Some("dataModel"),
        "scriptSnippet" => Some("scriptSnippet"),
        "codeTemplate" => Some("codeTemplate"),
        _ => None,
    }
}

fn delta_array<'a>(object: &'a Map<String, Value>, key: &str) -> Vec<&'a Value> {
    object
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

fn string_list(object: &Map<String, Value>, key: &str) -> Vec<String> {
    object
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn str_field(row: &Map<String, Value>, key: &str) -> String {
    row.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn opt_str_field(row: &Map<String, Value>, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_string)
}

fn bool_field_or(row: &Map<String, Value>, key: &str, default: bool) -> bool {
    row.get(key).and_then(Value::as_bool).unwrap_or(default)
}

/// request 行的父集合列；其他域一律 None（用例的 parent_id 是 requestId，
/// 由 `caseToRow` 的 requestId 字段承担，domain 判断在此统一处理）。
fn parent_id_of(domain: &str, row: &Map<String, Value>) -> Option<String> {
    match domain {
        "requests" => Some(str_field(row, "folderId")),
        "cases" => Some(str_field(row, "requestId")),
        _ => None,
    }
}

/// 行级 upsert：与 apply_staged_changes 相同的 `IS NOT` 列级 diff 语义，
/// 只是不建 stage 表、也不删除未提及的行 —— delta 无权触碰载荷之外的行。
/// `rev` 是本次保存的行级水位（当前版本号 + 1）；未变化的行被 WHERE 挡住，
/// 保留旧水位，变化的行拿到新水位。
fn upsert_entity_row(tx: &Connection, row: &StagedEntityRow, rev: i64) -> Result<(), AppError> {
    tx.execute(
        r#"INSERT INTO entity
           (id, kind, parent_id, folder_path, name, method, url, protocol, auth,
            position, enabled, case_group, sub_kind, updated_at, deleted, data, rev)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
           ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            parent_id = excluded.parent_id,
            folder_path = excluded.folder_path,
            name = excluded.name,
            method = excluded.method,
            url = excluded.url,
            protocol = excluded.protocol,
            auth = excluded.auth,
            position = excluded.position,
            enabled = excluded.enabled,
            case_group = excluded.case_group,
            sub_kind = excluded.sub_kind,
            updated_at = excluded.updated_at,
            deleted = excluded.deleted,
            data = excluded.data,
            rev = excluded.rev
           WHERE entity.kind IS NOT excluded.kind
           OR entity.parent_id IS NOT excluded.parent_id
           OR entity.folder_path IS NOT excluded.folder_path
           OR entity.name IS NOT excluded.name
           OR entity.method IS NOT excluded.method
           OR entity.url IS NOT excluded.url
           OR entity.protocol IS NOT excluded.protocol
           OR entity.auth IS NOT excluded.auth
           OR entity.position IS NOT excluded.position
           OR entity.enabled IS NOT excluded.enabled
           OR entity.case_group IS NOT excluded.case_group
           OR entity.sub_kind IS NOT excluded.sub_kind
           OR entity.updated_at IS NOT excluded.updated_at
           OR entity.deleted IS NOT excluded.deleted
           OR entity.data IS NOT excluded.data"#,
        rusqlite::params![
            row.id,
            row.kind,
            row.parent_id,
            row.folder_path,
            row.name,
            row.method,
            row.url,
            row.protocol,
            row.auth,
            row.position,
            row.enabled as i64,
            row.case_group,
            row.sub_kind,
            row.updated_at,
            row.deleted as i64,
            row.data,
            rev,
        ],
    )
    .map_err(|error| AppError::Storage(format!("写入行失败 ({}:{}): {error}", row.kind, row.id)))?;
    Ok(())
}

/// 单域数量上限（与 validate_snapshot 保持一致；墓碑行不计入）。
fn delta_kind_cap(kind: &str) -> Option<usize> {
    match kind {
        KIND_FOLDER => Some(MAX_COLLECTIONS),
        KIND_ENVIRONMENT => Some(MAX_ENVIRONMENTS),
        KIND_CASE => Some(MAX_CASES),
        KIND_SCENARIO => Some(MAX_SCENARIOS),
        KIND_MCP_SERVER => Some(MAX_MCP_SERVERS),
        _ => None,
    }
}

#[allow(clippy::too_many_arguments)]
fn save_rows_transaction(
    conn: &mut Connection,
    staged: &[StagedEntityRow],
    staged_history: &[(String, i64, String)],
    staged_trash: &[(String, i64, String)],
    staged_revisions: &[(String, String, i64, String)],
    staged_meta: &[(String, String)],
    history_deletes: &[String],
    trash_deletes: &[String],
    revision_deletes: &[(String, String)],
    expected_rev: Option<i64>,
    // 行级保存沿用整份保存的"工作区上限"，避免绕过设置里的存储上限无限增长。
    max_bytes: usize,
) -> Result<StoreOutcome, AppError> {
    let tx = conn
        .transaction()
        .map_err(|error| AppError::Storage(format!("开启事务失败: {error}")))?;

    // CAS 与整份保存一致：在写事务内、持有 SQLite 写锁后校验，任何在读取
    // 基线之后提交的外部写入都会被识别为 Conflict 且一行不写。
    let current = read_workspace_rev(&tx)?;
    if let Some(expected) = expected_rev {
        if expected != current.rev {
            return Ok(StoreOutcome::Conflict(current));
        }
    }

    // 数量上限：只在插入新行时校验（墓碑行不计入活行数）。
    for row in staged {
        if let Some(cap) = delta_kind_cap(row.kind) {
            if row.deleted {
                continue;
            }
            let exists: bool = tx
                .query_row(
                    "SELECT 1 FROM entity WHERE id = ?1 AND deleted = 0",
                    rusqlite::params![row.id],
                    |_| Ok(true),
                )
                .optional()
                .map_err(|error| AppError::Storage(format!("检查行存在性失败: {error}")))?
                .unwrap_or(false);
            if exists {
                continue;
            }
            let count: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM entity WHERE kind = ?1 AND deleted = 0",
                    rusqlite::params![row.kind],
                    |row| row.get(0),
                )
                .map_err(|error| AppError::Storage(format!("统计行数失败: {error}")))?;
            if count as usize >= cap {
                return Err(AppError::Storage(format!(
                    "{} 类型的实体数已达上限 {cap}，本次保存已跳过；请先清理数据",
                    row.kind
                )));
            }
        }
    }

    // 行级水位：本次 delta 触碰的行都标成新版本号（CAS 通过后的 current+1）。
    let new_rev = current.rev + 1;
    // 记下写入前的物理占用：容量门禁只拦"继续变大"，已超限的库仍能删除数据。
    let size_before = live_storage_bytes(&tx)?;
    let before = tx.total_changes();
    for row in staged {
        upsert_entity_row(&tx, row, new_rev)?;
    }

    for (id, at, data) in staged_history {
        tx.execute(
            "INSERT INTO history (id, at, data) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET at = excluded.at, data = excluded.data
             WHERE history.at IS NOT excluded.at OR history.data IS NOT excluded.data",
            rusqlite::params![id, at, data],
        )
        .map_err(|error| AppError::Storage(format!("写入历史失败 ({id}): {error}")))?;
    }
    for id in history_deletes {
        tx.execute("DELETE FROM history WHERE id = ?1", rusqlite::params![id])
            .map_err(|error| AppError::Storage(format!("删除历史失败 ({id}): {error}")))?;
    }

    for (id, deleted_at, data) in staged_trash {
        tx.execute(
            "INSERT INTO trash (id, deleted_at, data) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at, data = excluded.data
             WHERE trash.deleted_at IS NOT excluded.deleted_at OR trash.data IS NOT excluded.data",
            rusqlite::params![id, deleted_at, data],
        )
        .map_err(|error| AppError::Storage(format!("写入回收站失败 ({id}): {error}")))?;
    }
    for id in trash_deletes {
        tx.execute("DELETE FROM trash WHERE id = ?1", rusqlite::params![id])
            .map_err(|error| AppError::Storage(format!("删除回收站行失败 ({id}): {error}")))?;
    }

    for (request_id, id, at, data) in staged_revisions {
        tx.execute(
            "INSERT INTO request_revision (request_id, id, at, data) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(request_id, id) DO UPDATE SET at = excluded.at, data = excluded.data
             WHERE request_revision.at IS NOT excluded.at
                OR request_revision.data IS NOT excluded.data",
            rusqlite::params![request_id, id, at, data],
        )
        .map_err(|error| AppError::Storage(format!("写入修订失败 ({request_id}/{id}): {error}")))?;
    }
    for (request_id, id) in revision_deletes {
        tx.execute(
            "DELETE FROM request_revision WHERE request_id = ?1 AND id = ?2",
            rusqlite::params![request_id, id],
        )
        .map_err(|error| AppError::Storage(format!("删除修订失败 ({request_id}/{id}): {error}")))?;
    }

    // meta：只 upsert 载荷显式提供的键，绝不删除其他键（delta 不负责 meta 生命周期）。
    for (key, value) in staged_meta {
        tx.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value
             WHERE meta.value IS NOT excluded.value",
            rusqlite::params![key, value],
        )
        .map_err(|error| AppError::Storage(format!("写入 meta 失败 ({key}): {error}")))?;
    }

    // 辅助表的水位：增量读取只回实体行，命中这些表时前端必须整份重载，
    // 否则 MCP / CLI 对历史、回收站、修订、meta 的写入会被静默漏掉。
    // 先统计有效写入，水位记录属于事务内部簿记，不算一次数据写入。
    let live_writes = tx.total_changes() - before;
    let mut aux_changed: Vec<&str> = Vec::new();
    if !staged_history.is_empty() || !history_deletes.is_empty() {
        aux_changed.push("history");
    }
    if !staged_trash.is_empty() || !trash_deletes.is_empty() {
        aux_changed.push("trash");
    }
    if !staged_revisions.is_empty() || !revision_deletes.is_empty() {
        aux_changed.push("revisions");
    }
    if !staged_meta.is_empty() {
        aux_changed.push("meta");
    }
    mark_aux_changed(&tx, &aux_changed, new_rev)?;

    // 行级保存也要执行总容量门禁（整份保存检查的是序列化后的快照大小）。
    // 用页数估算物理占用：O(1)，不扫描行内容；事务回滚即等于本次保存未发生。
    ensure_within_workspace_limit(&tx, max_bytes, size_before)?;

    tx.execute(
        "UPDATE workspace_rev SET rev = rev + 1, writer = 'desktop', updated_at = ?1 WHERE id = 1",
        rusqlite::params![crate::logging::now_millis() as i64],
    )
    .map_err(|error| AppError::Storage(format!("更新工作区版本号失败: {error}")))?;
    let rev = read_workspace_rev(&tx)?;
    tx.commit()
        .map_err(|error| AppError::Storage(format!("提交事务失败: {error}")))?;
    Ok(StoreOutcome::Saved { writes: live_writes, rev })
}

/// 记录辅助表最后一次被写入的工作区版本号（`aux_rev` 表）。增量读取用它判断
/// "这次变化里有没有无法按实体行合并的辅助数据"。
fn mark_aux_changed(tx: &Connection, names: &[&str], rev: i64) -> Result<(), AppError> {
    for name in names {
        tx.execute(
            "INSERT INTO aux_rev (name, rev) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET rev = excluded.rev",
            rusqlite::params![name, rev],
        )
        .map_err(|error| AppError::Storage(format!("记录辅助表版本失败 ({name}): {error}")))?;
    }
    Ok(())
}

/// 物理占用（已用页 × 页大小，扣除 freelist 空闲页）。页数是 O(1) 读取，
/// 不会像 `SUM(LENGTH(data))` 那样在每次自动保存时扫描全部历史/回收站数据。
fn live_storage_bytes(tx: &Connection) -> Result<u64, AppError> {
    let read = |pragma: &str| -> Result<i64, AppError> {
        tx.query_row(pragma, [], |row| row.get(0))
            .map_err(|error| AppError::Storage(format!("读取 {pragma} 失败: {error}")))
    };
    let page_size = read("PRAGMA page_size")?;
    let page_count = read("PRAGMA page_count")?;
    let freelist = read("PRAGMA freelist_count")?;
    Ok((page_count - freelist).max(0) as u64 * page_size.max(0) as u64)
}

/// 行级保存的总容量门禁。超限返回错误 → 事务未提交，与整份保存"本次保存已跳过"
/// 的语义一致；错误文案直接给出占用/上限与调高路径，避免再退化成"权限失败"。
/// `size_before` 是本次写入前的物理占用：已经超限的库仍然允许"不再变大"的写入
/// （删除 / 清理 / 调低数据量），否则用户会被锁死在无法保存也无法清理的状态。
fn ensure_within_workspace_limit(
    tx: &Connection,
    max_bytes: usize,
    size_before: u64,
) -> Result<(), AppError> {
    let used = live_storage_bytes(tx)?;
    let limit = max_bytes as u64;
    if used <= limit || used <= size_before {
        return Ok(());
    }
    const MIB: u64 = 1024 * 1024;
    let used_mib = used.div_ceil(MIB);
    let limit_mib = limit.div_ceil(MIB);
    Err(AppError::Storage(format!(
        "工作区已占用 {used_mib} MiB，超过当前上限 {limit_mib} MiB，本次保存已回滚；请在「设置 → 引擎与存储」调高「快照存储上限」（最高 {} MiB），或清理历史记录 / 用例",
        MAX_WORKSPACE_BYTES / MIB,
    )))
}

fn omit_keys(value: &Value, keys: &[&str]) -> Value {
    match value {
        Value::Object(map) => {
            let rest: Map<String, Value> = map
                .iter()
                .filter(|(key, _)| !keys.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            Value::Object(rest)
        }
        other => other.clone(),
    }
}

// ------------------------------------------------- rows → snapshot ----

fn meta_value(conn: &Connection, key: &str) -> Result<Option<Value>, AppError> {
    let mut statement = conn
        .prepare("SELECT value FROM meta WHERE key = ?1")
        .map_err(|error| AppError::Storage(format!("读取 meta 失败: {error}")))?;
    let mut rows = statement
        .query(rusqlite::params![key])
        .map_err(|error| AppError::Storage(format!("读取 meta 失败: {error}")))?;
    if let Some(row) = rows
        .next()
        .map_err(|error| AppError::Storage(format!("读取 meta 失败: {error}")))? {
        let raw: String = row
            .get(0)
            .map_err(|error| AppError::Storage(format!("读取 meta 失败: {error}")))?;
        Ok(serde_json::from_str(&raw).ok())
    } else {
        Ok(None)
    }
}

fn parse_data(raw: &str) -> Result<Value, AppError> {
    serde_json::from_str(raw).map_err(|error| AppError::Storage(format!("行数据损坏: {error}")))
}

/// Map a stored row back to the tombstone kind used by the sync protocol.
fn tombstone_kind<'a>(kind: &str, sub_kind: Option<&'a str>) -> Option<&'a str> {
    match kind {
        KIND_FOLDER => Some("folder"),
        KIND_REQUEST => Some("request"),
        KIND_ENVIRONMENT => Some("environment"),
        KIND_CASE => Some("case"),
        KIND_SCENARIO => Some("scenario"),
        KIND_SUITE => Some("suite"),
        KIND_ARTIFACT => sub_kind,
        _ => None,
    }
}

fn rebuild_snapshot(conn: &Connection) -> Result<Value, AppError> {
    let mut statement = conn
        .prepare("SELECT id, kind, parent_id, folder_path, name, method, url, protocol, auth, enabled, case_group, sub_kind, updated_at, deleted, data FROM entity ORDER BY kind, position, id")
        .map_err(|error| AppError::Storage(format!("读取行失败: {error}")))?;
    let rows = statement
        .query_map([], |row| {
            Ok(RowRecord {
                id: row.get(0)?,
                kind: row.get(1)?,
                parent_id: row.get(2)?,
                folder_path: row.get(3)?,
                name: row.get(4)?,
                method: row.get(5)?,
                url: row.get(6)?,
                protocol: row.get(7)?,
                auth: row.get(8)?,
                enabled: row.get(9)?,
                case_group: row.get(10)?,
                sub_kind: row.get(11)?,
                updated_at: row.get(12)?,
                deleted: row.get::<_, i64>(13)? != 0,
                data: row.get(14)?,
            })
        })
        .map_err(|error| AppError::Storage(format!("读取行失败: {error}")))?;

    let mut folders: Vec<(String, Value)> = Vec::new();
    let mut items_by_folder: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    let mut environments: Vec<Value> = Vec::new();
    let mut cases: Vec<Value> = Vec::new();
    let mut scenarios: Vec<Value> = Vec::new();
    let mut suites: Vec<Value> = Vec::new();
    let mut doc_pages: Vec<Value> = Vec::new();
    let mut data_models: Vec<Value> = Vec::new();
    let mut script_library: Vec<Value> = Vec::new();
    let mut code_templates: Vec<Value> = Vec::new();
    let mut db_connections: Vec<Value> = Vec::new();
    let mut mcp_servers: Vec<Value> = Vec::new();
    let mut tombstones: Vec<Value> = Vec::new();

    for record in rows {
        let record = record.map_err(|error| AppError::Storage(format!("读取行失败: {error}")))?;
        if record.deleted {
            if let Some(kind) = tombstone_kind(&record.kind, record.sub_kind.as_deref()) {
                tombstones.push(json!({
                    "kind": kind,
                    "id": record.id,
                    "updatedAt": record.updated_at,
                }));
            }
            continue; // tombstones never reach the live snapshot objects
        }
        let data = parse_data(&record.data)?;
        let mut item = match data {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        item.insert("id".into(), json!(record.id));
        item.insert("name".into(), json!(record.name));
        item.insert("updatedAt".into(), json!(record.updated_at));
        match record.kind.as_str() {
            KIND_FOLDER => {
                let mut folder = Map::new();
                folder.insert("id".into(), json!(record.id));
                folder.insert("name".into(), json!(record.name));
                folder.insert("updatedAt".into(), json!(record.updated_at));
                if let Some(auth) = record.auth {
                    folder.insert("auth".into(), serde_json::from_str(&auth).unwrap_or(Value::Null));
                }
                // 显式登记的空文件夹列表（Collection.folders）从 data payload 读回。
                if let Some(list) = item.get("folders").cloned() {
                    if list.is_array() {
                        folder.insert("folders".into(), list);
                    }
                }
                folder.insert("items".into(), json!([]));
                folders.push((record.id.clone(), Value::Object(folder)));
            }
            KIND_REQUEST => {
                item.insert("folder".into(), json!(record.folder_path));
                item.insert("method".into(), json!(record.method.clone().unwrap_or_else(|| "GET".into())));
                item.insert("url".into(), json!(record.url.clone().unwrap_or_default()));
                item.insert(
                    "protocol".into(),
                    json!(record.protocol.clone().unwrap_or_else(|| "http".into())),
                );
                if let Some(parent) = record.parent_id.clone() {
                    items_by_folder.entry(parent).or_default().push(Value::Object(item));
                }
            }
            KIND_ENVIRONMENT => environments.push(Value::Object(item)),
            KIND_CASE => {
                strip_request_runtime_cache(&mut item);
                item.insert("requestId".into(), json!(record.parent_id.clone().unwrap_or_default()));
                item.insert("group".into(), json!(record.case_group.clone().unwrap_or_else(|| "其他".into())));
                item.insert("enabled".into(), json!(record.enabled));
                cases.push(Value::Object(item));
            }
            KIND_SCENARIO => scenarios.push(Value::Object(item)),
            KIND_SUITE => suites.push(Value::Object(item)),
            KIND_DB_CONNECTION => db_connections.push(Value::Object(item)),
            KIND_MCP_SERVER => mcp_servers.push(Value::Object(item)),
            KIND_ARTIFACT => match record.sub_kind.as_deref() {
                Some("docPage") => {
                    let title = record.name.clone();
                    item.insert("title".into(), json!(title));
                    doc_pages.push(Value::Object(item));
                }
                Some("dataModel") => data_models.push(Value::Object(item)),
                Some("scriptSnippet") => script_library.push(Value::Object(item)),
                Some("codeTemplate") => code_templates.push(Value::Object(item)),
                _ => {}
            },
            _ => {}
        }
    }

    // 把接口行挂回所属集合（保持保存时的顺序）。
    let collections: Vec<Value> = folders
        .into_iter()
        .map(|(folder_id, mut folder)| {
            if let Some(items) = items_by_folder.remove(&folder_id) {
                folder["items"] = Value::Array(items);
            }
            folder
        })
        .collect();

    let mut snapshot = Map::new();
    snapshot.insert("version".into(), json!(1));
    snapshot.insert(
        "seeded".into(),
        meta_value(conn, "seeded")?.unwrap_or(json!(false)),
    );
    snapshot.insert("collections".into(), Value::Array(collections));
    snapshot.insert("environments".into(), Value::Array(environments));
    snapshot.insert(
        "activeEnvironmentId".into(),
        meta_value(conn, "activeEnvironmentId")?.unwrap_or(Value::Null),
    );
    snapshot.insert("history".into(), read_simple_rows(conn, "history", "at")?);
    snapshot.insert("cases".into(), Value::Array(cases));
    snapshot.insert("scenarios".into(), Value::Array(scenarios));
    snapshot.insert("trash".into(), read_simple_rows(conn, "trash", "deleted_at")?);
    snapshot.insert(
        "settings".into(),
        meta_value(conn, "settings")?.unwrap_or(json!({
            "timeoutSecs": 30,
            "followRedirects": true,
            "verifyTls": true
        })),
    );
    if let Some(theme) = meta_value(conn, "theme")? {
        if !theme.is_null() {
            snapshot.insert("theme".into(), theme);
        }
    }
    if !suites.is_empty() {
        snapshot.insert("suites".into(), Value::Array(suites));
    }
    if !doc_pages.is_empty() {
        snapshot.insert("docPages".into(), Value::Array(doc_pages));
    }
    if !data_models.is_empty() {
        snapshot.insert("dataModels".into(), Value::Array(data_models));
    }
    if !script_library.is_empty() {
        snapshot.insert("scriptLibrary".into(), Value::Array(script_library));
    }
    if !code_templates.is_empty() {
        snapshot.insert("codeTemplates".into(), Value::Array(code_templates));
    }
    if !db_connections.is_empty() {
        snapshot.insert("dbConnections".into(), Value::Array(db_connections));
    }
    if !mcp_servers.is_empty() {
        snapshot.insert("mcpServers".into(), Value::Array(mcp_servers));
    }
    if !tombstones.is_empty() {
        snapshot.insert("tombstones".into(), Value::Array(tombstones));
    }
    let revisions = read_revisions(conn)?;
    if !revisions.is_null() {
        snapshot.insert("revisions".into(), revisions);
    }
    Ok(Value::Object(snapshot))
}

// --------------------------------------------- external delta read ----

/// 增量载荷里的一条装配好的实体（item 仍是密封值，由调用方 vault 解密）。
struct DeltaEntity {
    domain: &'static str,
    position: i64,
    parent_id: Option<String>,
    item: Value,
}

/// 增量载荷里的一条墓碑（domain 指明前端应从哪个域移除活实体）。
struct DeltaTombstone {
    domain: &'static str,
    tombstone: Value,
}

/// 存储行 → 前端快照域。与 snapshot → rows 转换互为镜像，增量载荷因此可以
/// 直接合并进内存快照。
fn domain_of_row(kind: &str, sub_kind: Option<&str>) -> Option<&'static str> {
    match kind {
        KIND_FOLDER => Some("collections"),
        KIND_REQUEST => Some("requests"),
        KIND_ENVIRONMENT => Some("environments"),
        KIND_CASE => Some("cases"),
        KIND_SCENARIO => Some("scenarios"),
        KIND_SUITE => Some("suites"),
        KIND_ARTIFACT => match sub_kind {
            Some("docPage") => Some("docPages"),
            Some("dataModel") => Some("dataModels"),
            Some("scriptSnippet") => Some("scriptLibrary"),
            Some("codeTemplate") => Some("codeTemplates"),
            _ => None,
        },
        KIND_DB_CONNECTION => Some("dbConnections"),
        KIND_MCP_SERVER => Some("mcpServers"),
        _ => None,
    }
}

/// 自 `from_rev` 以来被写过的辅助表（history / trash / revisions / meta）。
/// 这些表没有实体行可以增量合并，前端拿到非空列表时直接整份重载。
fn read_changed_aux(conn: &Connection, from_rev: i64) -> Result<Vec<String>, AppError> {
    let mut statement = conn
        .prepare("SELECT name FROM aux_rev WHERE rev > ?1 ORDER BY name")
        .map_err(|error| AppError::Storage(format!("读取辅助表增量失败: {error}")))?;
    let rows = statement
        .query_map(rusqlite::params![from_rev], |row| row.get::<_, String>(0))
        .map_err(|error| AppError::Storage(format!("读取辅助表增量失败: {error}")))?;
    let mut names = Vec::new();
    for row in rows {
        names.push(row.map_err(|error| AppError::Storage(format!("读取辅助表增量失败: {error}")))?);
    }
    Ok(names)
}

/// 读取 `rev > from_rev` 的全部实体行，按 rebuild_snapshot 的逐 kind 分支
/// 装配成前端可直接使用的实体，凭据信封经 vault 解密后返回。
/// 结果 = `{ rev, writer, entries: [...] }`；条目分两类：
///  - `{ domain, position, parentId, item }` —— 变化/新增的活实体；
///  - `{ domain, deleted: true, tombstone }` —— 新出现的墓碑行。
/// `auxChanged` 为真表示 history / trash / revisions / meta 也有变化，调用方
/// 不能只合并条目，必须整份重载才能看到这些辅助数据。
fn read_changed_entities(
    conn: &Connection,
    vault: &Vault,
    from_rev: i64,
    current: &WorkspaceRev,
) -> Result<Value, AppError> {
    let mut statement = conn
        .prepare(
            "SELECT id, kind, parent_id, folder_path, name, method, url, protocol, auth,
                    enabled, case_group, sub_kind, updated_at, deleted, data, position
             FROM entity WHERE rev > ?1 ORDER BY kind, position, id",
        )
        .map_err(|error| AppError::Storage(format!("读取增量行失败: {error}")))?;
    let rows = statement
        .query_map(rusqlite::params![from_rev], |row| {
            Ok((
                RowRecord {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    parent_id: row.get(2)?,
                    folder_path: row.get(3)?,
                    name: row.get(4)?,
                    method: row.get(5)?,
                    url: row.get(6)?,
                    protocol: row.get(7)?,
                    auth: row.get(8)?,
                    enabled: row.get(9)?,
                    case_group: row.get(10)?,
                    sub_kind: row.get(11)?,
                    updated_at: row.get(12)?,
                    deleted: row.get::<_, i64>(13)? != 0,
                    data: row.get(14)?,
                },
                row.get::<_, i64>(15)?,
            ))
        })
        .map_err(|error| AppError::Storage(format!("读取增量行失败: {error}")))?;

    let mut entities: Vec<DeltaEntity> = Vec::new();
    let mut tombstones: Vec<DeltaTombstone> = Vec::new();
    for row in rows {
        let (record, position) =
            row.map_err(|error| AppError::Storage(format!("读取增量行失败: {error}")))?;
        let domain = match domain_of_row(&record.kind, record.sub_kind.as_deref()) {
            Some(domain) => domain,
            // rebuild_snapshot 同样跳过无法路由的行（未知 sub_kind / 类型），
            // 增量路径保持一致：这类行本来就不进快照。
            None => continue,
        };
        if record.deleted {
            if let Some(kind) = tombstone_kind(&record.kind, record.sub_kind.as_deref()) {
                tombstones.push(DeltaTombstone {
                    domain,
                    tombstone: json!({
                        "kind": kind,
                        "id": record.id,
                        "updatedAt": record.updated_at,
                    }),
                });
            }
            continue;
        }
        let data = parse_data(&record.data)?;
        let mut item = match data {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        item.insert("id".into(), json!(record.id));
        item.insert("name".into(), json!(record.name));
        item.insert("updatedAt".into(), json!(record.updated_at));
        let parent_id = match record.kind.as_str() {
            KIND_FOLDER => {
                let mut folder = Map::new();
                folder.insert("id".into(), json!(record.id));
                folder.insert("name".into(), json!(record.name));
                folder.insert("updatedAt".into(), json!(record.updated_at));
                if let Some(auth) = record.auth {
                    folder.insert(
                        "auth".into(),
                        serde_json::from_str(&auth).unwrap_or(Value::Null),
                    );
                }
                // 显式登记的空文件夹列表（Collection.folders）从 data payload 读回。
                if let Some(list) = item.get("folders").cloned() {
                    if list.is_array() {
                        folder.insert("folders".into(), list);
                    }
                }
                folder.insert("items".into(), json!([]));
                entities.push(DeltaEntity {
                    domain,
                    position,
                    parent_id: None,
                    item: Value::Object(folder),
                });
                continue;
            }
            KIND_REQUEST => {
                item.insert("folder".into(), json!(record.folder_path));
                item.insert(
                    "method".into(),
                    json!(record.method.clone().unwrap_or_else(|| "GET".into())),
                );
                item.insert("url".into(), json!(record.url.clone().unwrap_or_default()));
                item.insert(
                    "protocol".into(),
                    json!(record.protocol.clone().unwrap_or_else(|| "http".into())),
                );
                record.parent_id.clone()
            }
            KIND_CASE => {
                strip_request_runtime_cache(&mut item);
                item.insert(
                    "requestId".into(),
                    json!(record.parent_id.clone().unwrap_or_default()),
                );
                item.insert(
                    "group".into(),
                    json!(record.case_group.clone().unwrap_or_else(|| "其他".into())),
                );
                item.insert("enabled".into(), json!(record.enabled));
                record.parent_id.clone()
            }
            KIND_ARTIFACT if record.sub_kind.as_deref() == Some("docPage") => {
                let title = record.name.clone();
                item.insert("title".into(), json!(title));
                None
            }
            _ => None,
        };
        entities.push(DeltaEntity { domain, position, parent_id, item: Value::Object(item) });
    }

    let mut entries = Vec::with_capacity(entities.len() + tombstones.len());
    for entity in entities {
        let opened = vault.open(&entity.item)?;
        entries.push(json!({
            "domain": entity.domain,
            "position": entity.position,
            "parentId": entity.parent_id,
            "item": opened,
        }));
    }
    for tombstone in tombstones {
        entries.push(json!({
            "domain": tombstone.domain,
            "deleted": true,
            "tombstone": tombstone.tombstone,
        }));
    }
    let aux_tables = read_changed_aux(conn, from_rev)?;
    Ok(json!({
        "rev": current.rev,
        "writer": current.writer,
        "entries": entries,
        "auxChanged": !aux_tables.is_empty(),
        "auxTables": aux_tables,
    }))
}

struct RowRecord {
    id: String,
    kind: String,
    parent_id: Option<String>,
    folder_path: String,
    name: String,
    method: Option<String>,
    url: Option<String>,
    protocol: Option<String>,
    auth: Option<String>,
    enabled: bool,
    case_group: Option<String>,
    sub_kind: Option<String>,
    updated_at: i64,
    deleted: bool,
    data: String,
}

fn read_simple_rows(conn: &Connection, table: &str, order_column: &str) -> Result<Value, AppError> {
    let mut statement = conn
        .prepare(&format!("SELECT data FROM {table} ORDER BY {order_column}, id"))
        .map_err(|error| AppError::Storage(format!("读取 {table} 失败: {error}")))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| AppError::Storage(format!("读取 {table} 失败: {error}")))?;
    let mut out = Vec::new();
    for row in rows {
        let raw = row.map_err(|error| AppError::Storage(format!("读取 {table} 失败: {error}")))?;
        out.push(parse_data(&raw)?);
    }
    Ok(Value::Array(out))
}

fn read_revisions(conn: &Connection) -> Result<Value, AppError> {
    let mut statement = conn
        .prepare("SELECT request_id, data FROM request_revision ORDER BY at DESC, id")
        .map_err(|error| AppError::Storage(format!("读取修订失败: {error}")))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| AppError::Storage(format!("读取修订失败: {error}")))?;
    let mut by_request: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    for row in rows {
        let (request_id, raw) =
            row.map_err(|error| AppError::Storage(format!("读取修订失败: {error}")))?;
        by_request.entry(request_id).or_default().push(parse_data(&raw)?);
    }
    if by_request.is_empty() {
        return Ok(Value::Null);
    }
    let map: Map<String, Value> = by_request
        .into_iter()
        .map(|(key, value)| (key, Value::Array(value)))
        .collect();
    Ok(Value::Object(map))
}

// ------------------------------------------------- legacy JSON import ----

/// One-time import of the pre-SQLite formats (split JSON files or the old
/// single workspace.json). The original files are KEPT so users can inspect
/// or revert; a meta flag prevents re-importing over a deliberately emptied
/// workspace.
fn import_legacy_json_if_needed(conn: &mut Connection, vault: &Vault) -> Result<(), AppError> {
    if let Some(flag) = meta_value(conn, LEGACY_IMPORTED_KEY)?
        && flag == json!(true)
    {
        return Ok(());
    }
    let already_has_rows = {
        let count: i64 = conn
            .query_row("SELECT (SELECT COUNT(*) FROM entity) + (SELECT COUNT(*) FROM history) + (SELECT COUNT(*) FROM trash)", [], |row| row.get(0))
            .map_err(|error| AppError::Storage(format!("检查数据库失败: {error}")))?;
        count > 0
    };
    if already_has_rows {
        return Ok(());
    }
    // The data directory is not available through the connection; the caller
    // (load) passes it via the store, so look for the sibling files relative
    // to the database path.
    let db_path = conn
        .path()
        .map(|path| PathBuf::from(path))
        .ok_or_else(|| AppError::Internal("数据库路径不可用".into()))?;
    let dir = db_path
        .parent()
        .map(|path| path.to_path_buf())
        .ok_or_else(|| AppError::Internal("数据库路径不可用".into()))?;

    let legacy_snapshot = read_legacy_snapshot(&dir)?;
    if let Some(snapshot) = legacy_snapshot {
        let sealed = vault.seal(&snapshot)?;
        let object = sealed
            .as_object()
            .cloned()
            .ok_or_else(|| AppError::Storage("旧版工作区数据必须是 JSON 对象".into()))?;
        // Legacy JSON files stay on disk untouched (by design), but their
        // credentials must not be copied into SQLite in plaintext.
        // Legacy import is an unchecked one-time migration: no WebView holds
        // a revision yet, so there is nothing to conflict with.
        let _ = store_snapshot(conn, &object, None, false)?;
    }
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
        rusqlite::params![LEGACY_IMPORTED_KEY, "true"],
    )
    .map_err(|error| AppError::Storage(format!("写入导入标记失败: {error}")))?;
    Ok(())
}

/// Read the legacy split files (manifest.json + `<key>.json`) or the older
/// single workspace.json. Returns None when neither exists.
fn read_legacy_snapshot(dir: &Path) -> Result<Option<Value>, AppError> {
    let manifest_path = dir.join(MANIFEST_FILE);
    if manifest_path.exists() {
        let raw = fs::read_to_string(&manifest_path)
            .map_err(|error| AppError::Storage(format!("读取 manifest 失败: {error}")))?;
        let manifest: Manifest = serde_json::from_str(&raw)
            .map_err(|_| AppError::Storage("manifest.json 损坏，无法解析".into()))?;
        let mut map = Map::new();
        for key in manifest.keys {
            if !is_safe_key(&key) {
                continue;
            }
            let file = dir.join(format!("{key}.json"));
            if !file.exists() {
                continue;
            }
            let raw = fs::read_to_string(&file)
                .map_err(|error| AppError::Storage(format!("读取 {key}.json 失败: {error}")))?;
            let value: Value = serde_json::from_str(&raw)
                .map_err(|_| AppError::Storage(format!("{key}.json 损坏，无法解析")))?;
            map.insert(key, value);
        }
        return Ok(Some(Value::Object(map)));
    }
    let legacy = dir.join(LEGACY_FILE);
    if legacy.exists() {
        let raw = fs::read_to_string(&legacy)
            .map_err(|error| AppError::Storage(error.to_string()))?;
        return Ok(Some(serde_json::from_str(&raw).map_err(|_| {
            AppError::Storage("工作区数据损坏，无法解析；可在界面中重置工作区".into())
        })?));
    }
    Ok(None)
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct Manifest {
    format: String,
    version: u8,
    keys: Vec<String>,
}

fn is_safe_key(key: &str) -> bool {
    !key.is_empty()
        && key != "manifest"
        && key.len() <= 64
        && key
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

// ------------------------------------------------------- validation ----

/// Validate untrusted data at the boundary before it ever touches disk.
fn validate_snapshot(value: &Value) -> Result<(), AppError> {
    let object = value
        .as_object()
        .ok_or_else(|| AppError::Storage("工作区快照必须是 JSON 对象".into()))?;

    if object.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(AppError::Storage("不支持的工作区快照版本".into()));
    }

    for (key, limit) in [
        ("collections", MAX_COLLECTIONS),
        ("environments", MAX_ENVIRONMENTS),
        ("history", MAX_HISTORY),
        ("cases", MAX_CASES),
        ("scenarios", MAX_SCENARIOS),
    ] {
        let items = object
            .get(key)
            .and_then(Value::as_array)
            .ok_or_else(|| AppError::Storage(format!("快照缺少数组字段 {key}")))?;
        if items.len() > limit {
            return Err(AppError::Storage(format!(
                "{key} 条目数超过上限 {limit}"
            )));
        }
    }

    // trash is newer than v1 snapshots: missing is fine, present must be valid.
    if let Some(trash) = object.get("trash") {
        let items = trash
            .as_array()
            .ok_or_else(|| AppError::Storage("trash 必须是数组".into()))?;
        if items.len() > MAX_TRASH {
            return Err(AppError::Storage(format!(
                "trash 条目数超过上限 {MAX_TRASH}"
            )));
        }
    }

    // mcpServers is likewise newer than v1: optional, but bounded.
    if let Some(servers) = object.get("mcpServers") {
        let items = servers
            .as_array()
            .ok_or_else(|| AppError::Storage("mcpServers 必须是数组".into()))?;
        if items.len() > MAX_MCP_SERVERS {
            return Err(AppError::Storage(format!(
                "mcpServers 条目数超过上限 {MAX_MCP_SERVERS}"
            )));
        }
    }

    if let Some(active) = object.get("activeEnvironmentId")
        && !(active.is_null() || active.is_string())
    {
        return Err(AppError::Storage("activeEnvironmentId 类型不合法".into()));
    }

    if let Some(settings) = object.get("settings")
        && !settings.is_object()
    {
        return Err(AppError::Storage("settings 必须是对象".into()));
    }

    Ok(())
}

#[cfg(test)]
#[path = "storage/tests.rs"]
mod tests;
