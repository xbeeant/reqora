//! Local-only, encrypted execution history for interfaces / cases / scenarios.
//!
//! This is a **separate** SQLite database (`~/.reqora/history.db`), deliberately
//! outside the per-project `workspace.db`:
//! - the workspace snapshot is the synced, shared domain. Execution history
//!   (full response bodies, headers, tokens echoed by a server, script logs)
//!   must never enter a snapshot, a cloud payload or a git mirror;
//! - a single machine-local file keeps the history of every project together,
//!   while `project_id` on each row lets the UI scope it to the active project.
//!
//! Three tables:
//! - `history_meta`  — schema version + master-key fingerprint.
//! - `history_runs`  — one row per execution. Only non-sensitive scalar
//!   *index* columns are plaintext (id / kind / project id / time / counters)
//!   so filtering stays cheap. Everything descriptive lives in `payload`.
//! - `history_steps` — one row per scenario step (or per captured response),
//!   again with an encrypted payload, cascading on run deletion.
//!
//! Every `payload` is a whole JSON document sealed with the existing
//! `reqora.enc.v1` AES-256-GCM envelope (`Vault::seal_text`), so a raw database
//! dump contains no readable URL, header, body, token or script log. The master
//! key is the same machine-local key as the workspace vault: OS keychain first,
//! `REQORA_VAULT_KEY`, or the 0600 fallback file — never stored in the DB.
//!
//! This is record-level encryption, not SQLCipher-style whole-file encryption:
//! the SQLite page headers and the index columns stay readable, which is what
//! makes the history list searchable. Everything that carries user data is
//! ciphertext.

use crate::service::vault::Vault;
use reqora_core::error::AppError;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const DB_FILE: &str = "history.db";
/// v2 adds a small encrypted `summary_payload` column so list pages never have
/// to decrypt the full response-bearing payload.
const SCHEMA_VERSION: i64 = 2;

/// Retention: keep the newest N executions. Old rows (and their steps) are
/// removed inside the same transaction as the insert, so the file cannot grow
/// without bound on a heavily used workspace.
const MAX_RUNS: usize = 500;
/// Hard ceiling on the number of step/response rows recorded for one run.
const MAX_STEPS_PER_RUN: usize = 500;
/// Upper bound on rows inspected for one page. Only the tiny summary envelope
/// is opened, so scanning a few hundred rows is cheap; the full response
/// payload is never touched by a list call.
const MAX_SCAN: usize = 500;
/// Keyset page size. The UI asks for one page at a time as the list scrolls.
const DEFAULT_PAGE_SIZE: usize = 30;
const MAX_PAGE_SIZE: usize = 100;
/// Upper bound for the legacy whole-list helper (also the retention ceiling).
/// Consumed by `list()`, a public helper currently exercised from tests but
/// kept available for non-UI callers (CLI / future commands).
#[allow(dead_code)]
const DEFAULT_LIST_LIMIT: usize = MAX_SCAN;
#[allow(dead_code)]
const MAX_LIST_LIMIT: usize = MAX_SCAN;

/// Bound the WebView input at the Rust boundary. Response bodies are already
/// truncated on the frontend, but a malformed/older caller must not be able to
/// push an unbounded document into the local database.
const MAX_RECORD_BYTES: usize = 2 * 1024 * 1024;
const MAX_STEP_BYTES: usize = 512 * 1024;
const MAX_TEXT_FIELD: usize = 512;
const MAX_ID_FIELD: usize = 128;

const KEY_SCHEMA: &str = "schemaVersion";
const KEY_KEY_ID: &str = "keyId";
const KEY_CREATED_AT: &str = "createdAt";

/// Opaque keyset cursor: the last row examined by the previous page. Ordering
/// is `(at DESC, id DESC)`, so "older than" is stable even when several runs
/// share the same millisecond — unlike OFFSET, which both re-reads skipped rows
/// and misbehaves when new runs are appended while scrolling.
#[derive(Clone, Debug)]
pub struct HistoryCursor {
    pub at: i64,
    pub id: String,
}

pub struct ListQuery {
    /// "project" (default) filters on `project_id`; "all" scans every project.
    pub scope: String,
    pub project_id: Option<String>,
    pub kind: Option<String>,
    pub search: Option<String>,
    pub limit: usize,
    pub cursor: Option<HistoryCursor>,
}

pub struct ListPage {
    pub items: Vec<Value>,
    pub next_cursor: Option<HistoryCursor>,
}

impl ListPage {
    pub fn to_value(&self) -> Value {
        json!({
            "items": self.items,
            "nextCursor": self
                .next_cursor
                .as_ref()
                .map(|cursor| json!({ "at": cursor.at, "id": cursor.id })),
        })
    }
}

pub struct HistoryStore {
    conn: Mutex<Connection>,
    vault: Vault,
    path: PathBuf,
    /// The database was written with a different master key. Reads fail with a
    /// precise message instead of showing ciphertext or silently losing data.
    key_mismatch: bool,
}

impl HistoryStore {
    pub fn new(dir: &Path, vault: Vault) -> Result<Self, AppError> {
        fs::create_dir_all(dir)
            .map_err(|error| AppError::Storage(format!("创建历史数据目录失败: {error}")))?;
        let path = dir.join(DB_FILE);
        let conn = Connection::open(&path)
            .map_err(|error| AppError::Storage(format!("打开历史数据库失败: {error}")))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| AppError::Storage(format!("设置历史库 WAL 失败: {error}")))?;
        conn.pragma_update(None, "foreign_keys", true)
            .map_err(|error| AppError::Storage(format!("开启历史库外键约束失败: {error}")))?;
        conn.pragma_update(None, "busy_timeout", 5_000)
            .map_err(|error| AppError::Storage(format!("设置历史库超时失败: {error}")))?;
        let key_mismatch = ensure_schema(&conn, &vault)?;
        Ok(Self { conn: Mutex::new(conn), vault, path, key_mismatch })
    }

    /// Location of the on-disk history DB (diagnostics / tests). No production
    /// caller yet; kept as part of the store's public inspection surface.
    #[allow(dead_code)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, AppError> {
        self.conn
            .lock()
            .map_err(|_| AppError::Storage("历史数据库锁已失效，请重启应用".into()))
    }

    fn check_key(&self) -> Result<(), AppError> {
        if self.key_mismatch {
            return Err(AppError::Storage(
                "历史记录的主密钥已更换，无法解密旧记录。请恢复原来的 ~/.reqora/vault.key（或 REQORA_VAULT_KEY），或删除 ~/.reqora/history.db 后重新开始记录。".into(),
            ));
        }
        Ok(())
    }

    /// Persist one execution. Returns the plaintext summary the list UI needs.
    pub fn append(&self, record: &Value) -> Result<Value, AppError> {
        self.check_key()?;
        let index = validate_record(record)?;
        let steps = record.get("steps").and_then(Value::as_array).cloned().unwrap_or_default();
        if steps.len() > MAX_STEPS_PER_RUN {
            return Err(AppError::Storage(format!(
                "单次执行的步骤明细超过上限 {MAX_STEPS_PER_RUN}"
            )));
        }

        // Steps live in their own rows; keep the run payload small and avoid
        // encrypting the same response twice.
        let mut run_payload = index.object.clone();
        let object = run_payload
            .as_object_mut()
            .ok_or_else(|| AppError::Storage("历史记录必须是 JSON 对象".into()))?;
        object.remove("steps");
        object.insert("stepCount".into(), json!(steps.len()));
        let run_json = serde_json::to_string(&run_payload)
            .map_err(|error| AppError::Storage(format!("序列化历史记录失败: {error}")))?;
        if run_json.len() > MAX_RECORD_BYTES {
            return Err(AppError::Storage("单条历史记录超过 2 MiB 上限".into()));
        }
        let run_sealed = self.vault.seal_text(&run_json)?;

        let mut sealed_steps: Vec<(i64, Option<i64>, i64, String)> = Vec::with_capacity(steps.len());
        for (position, step) in steps.iter().enumerate() {
            if !step.is_object() {
                return Err(AppError::Storage("步骤明细必须是 JSON 对象".into()));
            }
            let step_json = serde_json::to_string(step)
                .map_err(|error| AppError::Storage(format!("序列化步骤明细失败: {error}")))?;
            if step_json.len() > MAX_STEP_BYTES {
                return Err(AppError::Storage("单条步骤明细超过 512 KiB 上限".into()));
            }
            sealed_steps.push((
                position as i64,
                optional_number_of(step, "status").unwrap_or(None),
                if step.get("ok").and_then(Value::as_bool).unwrap_or(false) { 1 } else { 0 },
                self.vault.seal_text(&step_json)?,
            ));
        }

        // A second, much smaller envelope holds *only* the fields the list
        // needs. Reading a page decrypts a few hundred bytes per row instead of
        // a whole 2 MiB record with response bodies, headers and script logs.
        let summary_value = summary_object(&index.object, sealed_steps.len());
        let summary_json = serde_json::to_string(&summary_value)
            .map_err(|error| AppError::Storage(format!("序列化历史摘要失败: {error}")))?;
        let summary_sealed = self.vault.seal_text(&summary_json)?;

        let mut conn = self.lock()?;
        let tx = conn
            .transaction()
            .map_err(|error| AppError::Storage(format!("开启历史写入事务失败: {error}")))?;
        // Re-appending the same id (a retried write) replaces the run and its
        // step rows instead of colliding with the composite primary key.
        tx.execute("DELETE FROM history_runs WHERE id = ?1", params![index.id])
            .map_err(|error| AppError::Storage(format!("替换历史记录失败: {error}")))?;
        tx.execute(
            "INSERT INTO history_runs
             (id, kind, subject_id, project_id, at, ok, status, time_ms, size,
              total, passed, failed, skipped, payload, summary_payload)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                index.id,
                index.kind,
                index.subject_id,
                index.project_id,
                index.at,
                index.ok,
                index.status,
                index.time_ms,
                index.size,
                index.total,
                index.passed,
                index.failed,
                index.skipped,
                run_sealed,
                summary_sealed,
            ],
        )
        .map_err(|error| AppError::Storage(format!("写入历史记录失败: {error}")))?;
        let step_count = sealed_steps.len();
        for (seq, status, ok, payload) in sealed_steps {
            tx.execute(
                "INSERT INTO history_steps (run_id, seq, status, ok, payload)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![index.id, seq, status, ok, payload],
            )
            .map_err(|error| AppError::Storage(format!("写入步骤明细失败: {error}")))?;
        }
        // Retention is part of the same transaction; FK cascade removes steps.
        tx.execute(
            "DELETE FROM history_runs WHERE id IN (
                 SELECT id FROM history_runs ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?1
             )",
            params![MAX_RUNS as i64],
        )
        .map_err(|error| AppError::Storage(format!("清理过期历史失败: {error}")))?;
        tx.commit()
            .map_err(|error| AppError::Storage(format!("提交历史记录失败: {error}")))?;

        Ok(summary(&index, &summary_value, step_count))
    }

    /// Legacy whole-list helper (kept for non-UI callers and tests). It walks
    /// pages until the cursor is exhausted, still bounded by `MAX_LIST_LIMIT`.
    #[allow(dead_code)]
    pub fn list(&self, query: &ListQuery) -> Result<Vec<Value>, AppError> {
        let wanted = if query.limit == 0 {
            DEFAULT_LIST_LIMIT
        } else {
            query.limit.min(MAX_LIST_LIMIT)
        };
        let mut out = Vec::new();
        let mut cursor = query.cursor.clone();
        while out.len() < wanted {
            let page = self.page(&ListQuery {
                scope: query.scope.clone(),
                project_id: query.project_id.clone(),
                kind: query.kind.clone(),
                search: query.search.clone(),
                limit: (wanted - out.len()).min(MAX_PAGE_SIZE),
                cursor: cursor.clone(),
            })?;
            let exhausted = page.next_cursor.is_none();
            out.extend(page.items);
            cursor = page.next_cursor;
            if exhausted || cursor.is_none() {
                break;
            }
        }
        out.truncate(wanted);
        Ok(out)
    }

    /// One keyset page. SQL narrows by project / kind / cursor before any
    /// decryption, and only the rows in this page have their small summary
    /// envelopes opened. Composite indexes cover the `(at DESC, id DESC)`
    /// ordering used by the cursor.
    pub fn page(&self, query: &ListQuery) -> Result<ListPage, AppError> {
        self.check_key()?;
        let scope_project = if query.scope == "all" { None } else { query.project_id.clone() };
        let kind = query.kind.as_ref().filter(|value| !value.is_empty() && *value != "all").cloned();
        let needle = query
            .search
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_lowercase());
        let wanted = if query.limit == 0 {
            DEFAULT_PAGE_SIZE
        } else {
            query.limit.min(MAX_PAGE_SIZE)
        };
        // With a search term, SQL cannot match encrypted text, so we widen the
        // window and filter decrypted summaries. Without one, one extra row is
        // enough to know whether another page exists.
        let scan_limit = if needle.is_some() {
            MAX_SCAN.min(wanted.saturating_mul(6).max(120))
        } else {
            wanted + 1
        };
        let cursor_at = query.cursor.as_ref().map(|cursor| cursor.at);
        let cursor_id = query.cursor.as_ref().map(|cursor| cursor.id.clone());

        let conn = self.lock()?;
        // Deliberately does NOT select `payload`: SQLite can then skip the
        // overflow pages holding response bodies entirely.
        let rows: Vec<RawRow> = {
            let mut stmt = conn
                .prepare(
                    "SELECT r.id, r.kind, r.subject_id, r.project_id, r.at, r.ok,
                            r.status, r.time_ms, r.size, r.total, r.passed, r.failed,
                            r.skipped, r.summary_payload
                     FROM history_runs r
                     WHERE (?1 IS NULL OR r.kind = ?1)
                       AND (?2 IS NULL OR r.project_id = ?2)
                       AND (?3 IS NULL OR r.at < ?3 OR (r.at = ?3 AND r.id < ?4))
                     ORDER BY r.at DESC, r.id DESC
                     LIMIT ?5",
                )
                .map_err(|error| AppError::Storage(format!("查询历史记录失败: {error}")))?;
            let mapped = stmt
                .query_map(
                    params![kind, scope_project, cursor_at, cursor_id, scan_limit as i64],
                    |row| {
                        Ok(RawRow {
                            id: row.get(0)?,
                            kind: row.get(1)?,
                            subject_id: row.get(2)?,
                            project_id: row.get(3)?,
                            at: row.get(4)?,
                            ok: row.get::<_, i64>(5)? != 0,
                            status: row.get(6)?,
                            time_ms: row.get(7)?,
                            size: row.get(8)?,
                            total: row.get(9)?,
                            passed: row.get(10)?,
                            failed: row.get(11)?,
                            skipped: row.get(12)?,
                            summary_payload: row.get(13)?,
                        })
                    },
                )
                .map_err(|error| AppError::Storage(format!("查询历史记录失败: {error}")))?;
            mapped
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| AppError::Storage(format!("读取历史记录失败: {error}")))?
        };

        let mut out = Vec::new();
        let mut examined: Option<HistoryCursor> = None;
        let mut examined_rows = 0usize;
        let mut backfills: Vec<(String, String)> = Vec::new();
        for row in &rows {
            examined_rows += 1;
            examined = Some(HistoryCursor { at: row.at, id: row.id.clone() });
            let summary_value = match &row.summary_payload {
                Some(sealed) => open_payload(&self.vault, sealed)?,
                None => {
                    // v1 rows (written before the summary column existed) are
                    // still readable, and are upgraded lazily so repeated list
                    // calls never pay the full-decrypt cost again.
                    let sealed: String = conn
                        .query_row(
                            "SELECT payload FROM history_runs WHERE id = ?1",
                            params![row.id],
                            |row| row.get(0),
                        )
                        .map_err(|error| {
                            AppError::Storage(format!("读取旧版历史记录失败: {error}"))
                        })?;
                    let full = open_payload(&self.vault, &sealed)?;
                    let value = summary_object(&full, step_count_of(&full));
                    let json = serde_json::to_string(&value).map_err(|error| {
                        AppError::Storage(format!("序列化历史摘要失败: {error}"))
                    })?;
                    backfills.push((row.id.clone(), self.vault.seal_text(&json)?));
                    value
                }
            };
            if let Some(ref needle) = needle {
                if !summary_matches(&summary_value, needle) {
                    continue;
                }
            }
            let index = RunIndex {
                id: row.id.clone(),
                kind: row.kind.clone(),
                subject_id: row.subject_id.clone(),
                project_id: row.project_id.clone(),
                at: row.at,
                ok: row.ok,
                status: row.status,
                time_ms: row.time_ms,
                size: row.size,
                total: row.total,
                passed: row.passed,
                failed: row.failed,
                skipped: row.skipped,
                object: Value::Null,
            };
            out.push(summary(&index, &summary_value, 0));
            if out.len() >= wanted {
                break;
            }
        }
        if !backfills.is_empty() {
            for (id, sealed) in backfills {
                conn.execute(
                    "UPDATE history_runs SET summary_payload = ?1 WHERE id = ?2",
                    params![sealed, id],
                )
                .map_err(|error| AppError::Storage(format!("回填历史摘要失败: {error}")))?;
            }
        }

        // The cursor points at the last *examined* row, not the last match, so
        // skipped rows are never revisited and never lost. Stopping early to
        // fill a page also means unexamined rows remain -> another page exists.
        let has_more = if examined_rows < rows.len() {
            true
        } else if needle.is_some() {
            rows.len() == scan_limit
        } else {
            rows.len() > wanted
        };
        Ok(ListPage {
            items: out,
            next_cursor: if has_more { examined } else { None },
        })
    }

    /// Full decrypted detail: request snapshot, response, script outcome,
    /// summary and every step's own response. Never sent anywhere but the
    /// local WebView over Tauri IPC.
    pub fn get(&self, id: &str) -> Result<Value, AppError> {
        self.check_key()?;
        if id.len() > MAX_ID_FIELD {
            return Err(AppError::Storage("历史记录 id 不合法".into()));
        }
        let conn = self.lock()?;
        let sealed: String = conn
            .query_row(
                "SELECT payload FROM history_runs WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| AppError::Storage(format!("读取历史详情失败: {error}")))?
            .ok_or_else(|| AppError::Storage("历史记录不存在或已被清理".into()))?;
        let mut detail = open_payload(&self.vault, &sealed)?;

        let mut stmt = conn
            .prepare("SELECT payload FROM history_steps WHERE run_id = ?1 ORDER BY seq")
            .map_err(|error| AppError::Storage(format!("查询步骤明细失败: {error}")))?;
        let rows = stmt
            .query_map(params![id], |row| row.get::<_, String>(0))
            .map_err(|error| AppError::Storage(format!("查询步骤明细失败: {error}")))?;
        let mut steps = Vec::new();
        for row in rows {
            let sealed_step =
                row.map_err(|error| AppError::Storage(format!("读取步骤明细失败: {error}")))?;
            steps.push(open_payload(&self.vault, &sealed_step)?);
        }
        if let Some(object) = detail.as_object_mut() {
            object.insert("steps".into(), Value::Array(steps.clone()));
            object.insert("stepCount".into(), json!(steps.len()));
        }
        Ok(detail)
    }

    pub fn delete(&self, id: &str) -> Result<(), AppError> {
        // Destructive ops must honour the key mismatch: with a rotated master
        // key the old rows are undecryptable, and silently deleting them would
        // destroy data the user might still recover by restoring the key.
        self.check_key()?;
        if id.len() > MAX_ID_FIELD {
            return Err(AppError::Storage("历史记录 id 不合法".into()));
        }
        let conn = self.lock()?;
        conn.execute("DELETE FROM history_runs WHERE id = ?1", params![id])
            .map_err(|error| AppError::Storage(format!("删除历史记录失败: {error}")))?;
        Ok(())
    }

    /// Clear the active project's history, or every project's when scope=all.
    pub fn clear(&self, scope: &str, project_id: Option<&str>) -> Result<u64, AppError> {
        self.check_key()?;
        let conn = self.lock()?;
        let removed = if scope == "all" {
            conn.execute("DELETE FROM history_runs", [])
        } else {
            conn.execute(
                "DELETE FROM history_runs WHERE project_id = ?1",
                params![project_id.unwrap_or("")],
            )
        }
        .map_err(|error| AppError::Storage(format!("清空历史记录失败: {error}")))?;
        Ok(removed as u64)
    }

    /// Diagnostic summary. Deliberately does NOT call `check_key()`: the
    /// `keyMismatch` flag below is the UI's signal that the master key rotated
    /// and that append/get/delete are refused. Guarding this read would hide
    /// the very warning the user needs (and break `a_changed_master_key_is_reported_not_silently_ignored`).
    pub fn stats(&self) -> Result<Value, AppError> {
        let conn = self.lock()?;
        let runs: i64 = conn
            .query_row("SELECT COUNT(*) FROM history_runs", [], |row| row.get(0))
            .unwrap_or(0);
        let steps: i64 = conn
            .query_row("SELECT COUNT(*) FROM history_steps", [], |row| row.get(0))
            .unwrap_or(0);
        let bytes = fs::metadata(&self.path).map(|meta| meta.len()).unwrap_or(0);
        Ok(json!({
            "runs": runs,
            "steps": steps,
            "bytes": bytes,
            "encrypted": true,
            "keyId": self.vault.key_id(),
            "keyMismatch": self.key_mismatch,
            "schemaVersion": SCHEMA_VERSION,
            "path": self.path.display().to_string(),
        }))
    }
}

struct RawRow {
    id: String,
    kind: String,
    subject_id: String,
    project_id: String,
    at: i64,
    ok: bool,
    status: Option<i64>,
    time_ms: i64,
    size: i64,
    total: i64,
    passed: i64,
    failed: i64,
    skipped: i64,
    /// NULL on v1 rows; upgraded lazily on first read.
    summary_payload: Option<String>,
}

struct RunIndex {
    id: String,
    kind: String,
    subject_id: String,
    project_id: String,
    at: i64,
    ok: bool,
    status: Option<i64>,
    time_ms: i64,
    size: i64,
    total: i64,
    passed: i64,
    failed: i64,
    skipped: i64,
    /// The full (plaintext) record, used for the descriptive list fields.
    object: Value,
}

fn ensure_schema(conn: &Connection, vault: &Vault) -> Result<bool, AppError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS history_meta (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS history_runs (
             id          TEXT PRIMARY KEY,
             kind        TEXT NOT NULL,
             subject_id  TEXT NOT NULL,
             project_id  TEXT NOT NULL,
             at          INTEGER NOT NULL,
             ok          INTEGER NOT NULL,
             status      INTEGER,
             time_ms     INTEGER NOT NULL,
             size        INTEGER NOT NULL,
             total       INTEGER NOT NULL DEFAULT 0,
             passed      INTEGER NOT NULL DEFAULT 0,
             failed      INTEGER NOT NULL DEFAULT 0,
             skipped     INTEGER NOT NULL DEFAULT 0,
             payload     TEXT NOT NULL,
             summary_payload TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_history_runs_at
             ON history_runs (at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_history_runs_project
             ON history_runs (project_id, at DESC);
         CREATE INDEX IF NOT EXISTS idx_history_runs_kind
             ON history_runs (kind, at DESC);
         /* Cover the exact keyset predicates the UI uses, including cursor. */
         CREATE INDEX IF NOT EXISTS idx_history_runs_project_cursor
             ON history_runs (project_id, at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_history_runs_project_kind_cursor
             ON history_runs (project_id, kind, at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_history_runs_kind_cursor
             ON history_runs (kind, at DESC, id DESC);
         CREATE TABLE IF NOT EXISTS history_steps (
             run_id  TEXT NOT NULL REFERENCES history_runs(id) ON DELETE CASCADE,
             seq     INTEGER NOT NULL,
             status  INTEGER,
             ok      INTEGER NOT NULL,
             payload TEXT NOT NULL,
             PRIMARY KEY (run_id, seq)
         );",
    )
    .map_err(|error| AppError::Storage(format!("创建历史表失败: {error}")))?;

    // v1 databases predate the summary column. Add it in place; old rows keep
    // NULL and are backfilled lazily the first time they appear in a page.
    let has_summary_column = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(history_runs)")
            .map_err(|error| AppError::Storage(format!("检查历史表结构失败: {error}")))?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| AppError::Storage(format!("检查历史表结构失败: {error}")))?;
        names
            .filter_map(Result::ok)
            .any(|name| name == "summary_payload")
    };
    if !has_summary_column {
        conn.execute_batch("ALTER TABLE history_runs ADD COLUMN summary_payload TEXT;")
            .map_err(|error| AppError::Storage(format!("升级历史表结构失败: {error}")))?;
    }

    conn.execute(
        "INSERT OR REPLACE INTO history_meta (key, value) VALUES (?1, ?2)",
        params![KEY_SCHEMA, SCHEMA_VERSION.to_string()],
    )
    .map_err(|error| AppError::Storage(format!("写入历史元信息失败: {error}")))?;
    conn.execute(
        "INSERT OR IGNORE INTO history_meta (key, value) VALUES (?1, ?2)",
        params![KEY_CREATED_AT, now_ms().to_string()],
    )
    .map_err(|error| AppError::Storage(format!("写入历史元信息失败: {error}")))?;

    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM history_meta WHERE key = ?1",
            params![KEY_KEY_ID],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| AppError::Storage(format!("读取历史密钥指纹失败: {error}")))?;
    match stored {
        // Keep the original fingerprint: restoring the old key must make the
        // database readable again without rewriting any metadata.
        Some(key_id) => Ok(key_id != vault.key_id()),
        None => {
            conn.execute(
                "INSERT OR IGNORE INTO history_meta (key, value) VALUES (?1, ?2)",
                params![KEY_KEY_ID, vault.key_id()],
            )
            .map_err(|error| AppError::Storage(format!("写入历史密钥指纹失败: {error}")))?;
            Ok(false)
        }
    }
}

fn now_ms() -> i64 {
    reqora_core::time::now_millis() as i64
}

fn str_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn number_of(value: &Value, key: &str, fallback: i64) -> Result<i64, AppError> {
    match value.get(key) {
        Some(Value::Number(number)) => Ok(number.as_i64().unwrap_or(fallback)),
        None | Some(Value::Null) => Ok(fallback),
        _ => Err(AppError::Storage(format!("历史字段 {key} 必须是数字"))),
    }
}

fn optional_number_of(value: &Value, key: &str) -> Result<Option<i64>, AppError> {
    match value.get(key) {
        Some(Value::Number(number)) => Ok(number.as_i64()),
        None | Some(Value::Null) => Ok(None),
        _ => Err(AppError::Storage(format!("历史字段 {key} 必须是数字或 null"))),
    }
}

fn required_text(value: &Value, key: &str, max: usize) -> Result<String, AppError> {
    let text = value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Storage(format!("历史字段 {key} 缺失或类型不合法")))?
        .trim()
        .to_string();
    if text.is_empty() || text.len() > max {
        return Err(AppError::Storage(format!("历史字段 {key} 长度不合法")));
    }
    Ok(text)
}

fn optional_text(value: &Value, key: &str, max: usize) -> Result<String, AppError> {
    match value.get(key) {
        Some(Value::String(text)) if text.len() <= max => Ok(text.clone()),
        Some(Value::String(_)) => Err(AppError::Storage(format!("历史字段 {key} 过长"))),
        None | Some(Value::Null) => Ok(String::new()),
        _ => Err(AppError::Storage(format!("历史字段 {key} 类型不合法"))),
    }
}

fn validate_record(record: &Value) -> Result<RunIndex, AppError> {
    let object = record
        .as_object()
        .ok_or_else(|| AppError::Storage("历史记录必须是 JSON 对象".into()))?;
    let id = required_text(record, "id", MAX_ID_FIELD)?;
    let kind = required_text(record, "kind", 16)?;
    if !matches!(kind.as_str(), "api" | "case" | "scenario" | "benchmark") {
        return Err(AppError::Storage(
            "历史记录类型必须是 api / case / scenario / benchmark".into(),
        ));
    }
    let project_id = required_text(record, "projectId", MAX_ID_FIELD)?;
    let subject_id = optional_text(record, "subjectId", MAX_ID_FIELD)?;
    // Descriptive fields live inside the sealed payload; they only need a
    // generous sanity bound (the whole record is capped at 2 MiB below).
    let _ = optional_text(record, "name", MAX_TEXT_FIELD)?;
    let _ = optional_text(record, "url", 64 * 1024)?;
    let _ = optional_text(record, "error", 64 * 1024)?;
    let at = number_of(record, "at", 0)?;
    if at <= 0 {
        return Err(AppError::Storage("历史记录时间不合法".into()));
    }
    let ok = record
        .get("ok")
        .and_then(Value::as_bool)
        .ok_or_else(|| AppError::Storage("历史字段 ok 缺失或类型不合法".into()))?;
    let status = optional_number_of(record, "status")?;
    let clamp = |value: i64| value.clamp(0, i64::MAX);
    Ok(RunIndex {
        id,
        kind,
        subject_id,
        project_id,
        at,
        ok,
        status,
        time_ms: clamp(number_of(record, "timeMs", 0)?),
        size: clamp(number_of(record, "size", 0)?),
        total: clamp(number_of(record, "total", 0)?),
        passed: clamp(number_of(record, "passed", 0)?),
        failed: clamp(number_of(record, "failed", 0)?),
        skipped: clamp(number_of(record, "skipped", 0)?),
        object: Value::Object(object.clone()),
    })
}

fn open_payload(vault: &Vault, sealed: &str) -> Result<Value, AppError> {
    let plain = vault.open_text(sealed)?;
    serde_json::from_str(&plain)
        .map_err(|error| AppError::Storage(format!("历史记录内容不是合法 JSON: {error}")))
}

/// The tiny encrypted document stored in `summary_payload`. It carries only
/// what the list renders or searches — never response bodies, headers, tokens
/// or script logs. Keeping it separate is what makes paging cheap.
fn summary_object(record: &Value, step_count: usize) -> Value {
    let mut out = Map::new();
    for key in [
        "name",
        "subjectName",
        "projectName",
        "method",
        "url",
        "error",
    ] {
        out.insert(key.into(), json!(str_field(record, key)));
    }
    out.insert("stepCount".into(), json!(step_count));
    if let Some(report) = record
        .get("benchmark")
        .and_then(|value| value.get("report"))
        .filter(|value| value.is_object())
    {
        out.insert(
            "rps".into(),
            json!(report.get("rps").and_then(Value::as_f64).unwrap_or(0.0)),
        );
        out.insert(
            "p95Ms".into(),
            json!(report
                .get("latency")
                .and_then(|value| value.get("p95Ms"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0)),
        );
    }
    Value::Object(out)
}

fn step_count_of(record: &Value) -> usize {
    record
        .get("stepCount")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize
}

fn summary_matches(summary: &Value, needle: &str) -> bool {
    [
        "name",
        "subjectName",
        "projectName",
        "method",
        "url",
        "error",
    ]
    .iter()
    .any(|key| str_field(summary, key).to_lowercase().contains(needle))
}

/// Plaintext summary returned to the WebView for one list row. Descriptive
/// fields come from the decrypted *small* envelope, never from a plaintext
/// column and never from the full response payload.
fn summary(index: &RunIndex, small: &Value, step_count: usize) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), json!(index.id));
    out.insert("kind".into(), json!(index.kind));
    out.insert("subjectId".into(), json!(index.subject_id));
    out.insert("projectId".into(), json!(index.project_id));
    out.insert("at".into(), json!(index.at));
    out.insert("ok".into(), json!(index.ok));
    out.insert("status".into(), json!(index.status));
    out.insert("timeMs".into(), json!(index.time_ms));
    out.insert("size".into(), json!(index.size));
    out.insert("total".into(), json!(index.total));
    out.insert("passed".into(), json!(index.passed));
    out.insert("failed".into(), json!(index.failed));
    out.insert("skipped".into(), json!(index.skipped));
    out.insert(
        "stepCount".into(),
        json!(step_count_of(small).max(step_count)),
    );
    for key in [
        "name",
        "subjectName",
        "projectName",
        "method",
        "url",
        "error",
    ] {
        out.insert(key.into(), json!(str_field(small, key)));
    }
    if let Some(rps) = small.get("rps").and_then(Value::as_f64) {
        out.insert("rps".into(), json!(rps));
    }
    if let Some(p95) = small.get("p95Ms").and_then(Value::as_f64) {
        out.insert("p95Ms".into(), json!(p95));
    }
    Value::Object(out)
}

#[cfg(test)]
#[path = "history/tests.rs"]
mod tests;
