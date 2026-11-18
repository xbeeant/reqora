//! On-disk spool for decoded response bodies.
//!
//! The HTTP path streams a response once, tee-ing every decoded chunk into a
//! SQLite database so the UI can later page through arbitrary byte ranges and
//! line ranges without keeping the whole body in memory. The database is global
//! (it lives in `~/.reqora`), not per-project, and keeps only the most recent
//! bodies.

use crate::error::AppError;
use crate::models::BodyInfo;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

/// Fixed size of every `response_chunk` row except the final one.
pub const CHUNK_BYTES: usize = 64 * 1024;
/// Number of newline offsets packed into one `response_line` row.
pub const LINE_OFFSETS_PER_ROW: usize = 4096;
/// Only the most recent bodies are kept; older ones are pruned on `begin`.
const MAX_BODIES: usize = 12;

type DbResult<T> = Result<T, AppError>;

fn db_err(context: &str, error: rusqlite::Error) -> AppError {
    AppError::Storage(format!("响应体落盘 {context} 失败: {error}"))
}

/// Cloneable handle to a single SQLite connection guarded by a mutex.
#[derive(Clone)]
pub struct BodyStore {
    conn: Arc<Mutex<Connection>>,
}

fn now_ms() -> i64 {
    crate::time::now_millis() as i64
}

impl BodyStore {
    pub fn new(path: &Path) -> DbResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AppError::Storage(format!("创建响应体数据目录失败: {error}"))
            })?;
        }
        let conn = Connection::open(path)
            .map_err(|error| AppError::Storage(format!("打开响应体数据库失败: {error}")))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| db_err("设置 WAL", e))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| db_err("设置 synchronous", e))?;
        conn.pragma_update(None, "busy_timeout", 5000)
            .map_err(|e| db_err("设置 busy_timeout", e))?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS response_body (
              id TEXT PRIMARY KEY, size INTEGER NOT NULL, total_lines INTEGER NOT NULL,
              body_kind TEXT NOT NULL, content_encoding TEXT NOT NULL, chunk_bytes INTEGER NOT NULL,
              created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS response_chunk (body_id TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(body_id, seq));
            CREATE TABLE IF NOT EXISTS response_line  (body_id TEXT NOT NULL, seq INTEGER NOT NULL, offsets BLOB NOT NULL, PRIMARY KEY(body_id, seq));
            "#,
        )
        .map_err(|e| db_err("建表", e))?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Start a fresh body: drop any stale rows for `id`, insert a placeholder
    /// row and prune the store down to the most recent `MAX_BODIES` bodies.
    pub fn begin(&self, id: &str) -> DbResult<()> {
        let conn = self.lock();
        conn.execute("DELETE FROM response_chunk WHERE body_id = ?1", params![id])
            .map_err(|e| db_err("清理旧 chunk", e))?;
        conn.execute("DELETE FROM response_line WHERE body_id = ?1", params![id])
            .map_err(|e| db_err("清理旧行索引", e))?;
        conn.execute("DELETE FROM response_body WHERE id = ?1", params![id])
            .map_err(|e| db_err("清理旧记录", e))?;
        conn.execute(
            "INSERT INTO response_body (id, size, total_lines, body_kind, content_encoding, chunk_bytes, created_at)
             VALUES (?1, 0, 1, '', '', ?2, ?3)",
            params![id, CHUNK_BYTES as i64, now_ms()],
        )
        .map_err(|e| db_err("插入初始记录", e))?;
        conn.execute(
            "DELETE FROM response_body WHERE id NOT IN (
                SELECT id FROM response_body ORDER BY created_at DESC, rowid DESC LIMIT ?1
             )",
            params![MAX_BODIES as i64],
        )
        .map_err(|e| db_err("裁剪旧 body", e))?;
        conn.execute(
            "DELETE FROM response_chunk WHERE body_id NOT IN (SELECT id FROM response_body)",
            [],
        )
        .map_err(|e| db_err("清理孤儿 chunk", e))?;
        conn.execute(
            "DELETE FROM response_line WHERE body_id NOT IN (SELECT id FROM response_body)",
            [],
        )
        .map_err(|e| db_err("清理孤儿行索引", e))?;
        Ok(())
    }

    pub fn append_chunk(&self, id: &str, seq: u64, data: &[u8]) -> DbResult<()> {
        let conn = self.lock();
        conn.execute(
            "INSERT OR REPLACE INTO response_chunk (body_id, seq, data) VALUES (?1, ?2, ?3)",
            params![id, seq as i64, data],
        )
        .map_err(|e| db_err("写入 chunk", e))?;
        Ok(())
    }

    /// Persist newline offsets (little-endian u64 absolute byte positions) in
    /// a packed BLOB, one row per `LINE_OFFSETS_PER_ROW` offsets.
    pub fn append_line_offsets(&self, id: &str, seq: u64, offsets: &[u64]) -> DbResult<()> {
        let mut blob = Vec::with_capacity(offsets.len() * 8);
        for &offset in offsets {
            blob.extend_from_slice(&offset.to_le_bytes());
        }
        let conn = self.lock();
        conn.execute(
            "INSERT OR REPLACE INTO response_line (body_id, seq, offsets) VALUES (?1, ?2, ?3)",
            params![id, seq as i64, blob],
        )
        .map_err(|e| db_err("写入行索引", e))?;
        Ok(())
    }

    pub fn finish(
        &self,
        id: &str,
        size: u64,
        total_lines: u64,
        body_kind: &str,
        content_encoding: &str,
    ) -> DbResult<()> {
        let conn = self.lock();
        conn.execute(
            "UPDATE response_body SET size = ?2, total_lines = ?3, body_kind = ?4, content_encoding = ?5 WHERE id = ?1",
            params![id, size as i64, total_lines as i64, body_kind, content_encoding],
        )
        .map_err(|e| db_err("更新记录", e))?;
        Ok(())
    }

    fn meta(&self, conn: &Connection, id: &str) -> DbResult<Option<(u64, u64, String)>> {
        conn.query_row(
            "SELECT size, total_lines, body_kind FROM response_body WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)? as u64,
                    row.get::<_, i64>(1)? as u64,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|e| db_err("读取元信息", e))
    }

    fn read_range_with(
        &self,
        conn: &Connection,
        id: &str,
        offset: u64,
        length: u64,
    ) -> DbResult<Vec<u8>> {
        let size = self.meta(conn, id)?.map(|meta| meta.0).unwrap_or(0);
        let offset = offset.min(size);
        let length = length.min(size - offset);
        if length == 0 {
            return Ok(Vec::new());
        }
        let start_seq = offset / CHUNK_BYTES as u64;
        let end_seq = (offset + length - 1) / CHUNK_BYTES as u64;
        let mut stmt = conn
            .prepare(
                "SELECT seq, data FROM response_chunk WHERE body_id = ?1 AND seq >= ?2 AND seq <= ?3 ORDER BY seq",
            )
            .map_err(|e| db_err("准备 chunk 查询", e))?;
        let rows = stmt
            .query_map(params![id, start_seq as i64, end_seq as i64], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
            })
            .map_err(|e| db_err("查询 chunk", e))?;
        let mut out = Vec::with_capacity(length as usize);
        for row in rows {
            let (seq, data) = row.map_err(|e| db_err("读取 chunk 行", e))?;
            let chunk_abs = seq as u64 * CHUNK_BYTES as u64;
            let chunk_end = chunk_abs + data.len() as u64;
            let from = offset.max(chunk_abs);
            let to = (offset + length).min(chunk_end);
            if from < to {
                out.extend_from_slice(
                    &data[(from - chunk_abs) as usize..(to - chunk_abs) as usize],
                );
            }
        }
        Ok(out)
    }

    pub fn read_range(&self, id: &str, offset: u64, length: u64) -> DbResult<Vec<u8>> {
        let conn = self.lock();
        self.read_range_with(&conn, id, offset, length)
    }

    /// Return decoded lines (without their `\n`) by locating byte ranges via
    /// the persisted newline offsets and reusing `read_range_with`.
    pub fn line_range(&self, id: &str, start_line: u64, count: u64) -> DbResult<Vec<Vec<u8>>> {
        let (newlines, size, total_lines) = {
            let conn = self.lock();
            let (size, total_lines, _) = match self.meta(&conn, id)? {
                Some(meta) => meta,
                None => return Ok(Vec::new()),
            };
            let mut stmt = conn
                .prepare("SELECT offsets FROM response_line WHERE body_id = ?1 ORDER BY seq")
                .map_err(|e| db_err("准备行索引查询", e))?;
            let rows = stmt
                .query_map(params![id], |row| row.get::<_, Vec<u8>>(0))
                .map_err(|e| db_err("查询行索引", e))?;
            let mut newlines: Vec<u64> = Vec::new();
            for row in rows {
                let blob = row.map_err(|e| db_err("读取行索引行", e))?;
                for bytes in blob.chunks_exact(8) {
                    let mut arr = [0u8; 8];
                    arr.copy_from_slice(bytes);
                    newlines.push(u64::from_le_bytes(arr));
                }
            }
            (newlines, size, total_lines)
        };
        let start = start_line.min(total_lines);
        let end = start.saturating_add(count).min(total_lines);
        let mut out = Vec::with_capacity((end - start) as usize);
        let conn = self.lock();
        for line in start..end {
            let line_start = if line == 0 {
                0
            } else {
                newlines
                    .get(line as usize - 1)
                    .map(|offset| offset + 1)
                    .unwrap_or(size)
            };
            let line_end = newlines.get(line as usize).copied().unwrap_or(size);
            let length = line_end.saturating_sub(line_start);
            out.push(self.read_range_with(&conn, id, line_start, length)?);
        }
        Ok(out)
    }

    pub fn info(&self, id: &str) -> DbResult<Option<BodyInfo>> {
        let conn = self.lock();
        conn.query_row(
            "SELECT size, total_lines, body_kind, content_encoding FROM response_body WHERE id = ?1",
            params![id],
            |row| {
                Ok(BodyInfo {
                    body_id: id.to_string(),
                    size: row.get::<_, i64>(0)? as u64,
                    total_lines: row.get::<_, i64>(1)? as u64,
                    body_kind: row.get::<_, String>(2)?,
                    content_encoding: row.get::<_, String>(3)?,
                })
            },
        )
        .optional()
        .map_err(|e| db_err("读取 body 信息", e))
    }

    pub fn remove(&self, id: &str) -> DbResult<()> {
        let conn = self.lock();
        conn.execute("DELETE FROM response_chunk WHERE body_id = ?1", params![id])
            .map_err(|e| db_err("删除 chunk", e))?;
        conn.execute("DELETE FROM response_line WHERE body_id = ?1", params![id])
            .map_err(|e| db_err("删除行索引", e))?;
        conn.execute("DELETE FROM response_body WHERE id = ?1", params![id])
            .map_err(|e| db_err("删除记录", e))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_store() -> (BodyStore, PathBuf) {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "reqora-bodystore-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let store = BodyStore::new(&dir.join("response-bodies.db")).unwrap();
        (store, dir)
    }

    /// Mirror of the collect() tee, writing fixed-size chunks plus a newline
    /// index so the store can be exercised independently of the HTTP path.
    fn write_all(store: &BodyStore, id: &str, data: &[u8]) {
        store.begin(id).unwrap();
        for (seq, chunk) in data.chunks(CHUNK_BYTES).enumerate() {
            store.append_chunk(id, seq as u64, chunk).unwrap();
        }
        let offsets: Vec<u64> = data
            .iter()
            .enumerate()
            .filter(|(_, byte)| **byte == b'\n')
            .map(|(index, _)| index as u64)
            .collect();
        for (seq, batch) in offsets.chunks(LINE_OFFSETS_PER_ROW).enumerate() {
            store.append_line_offsets(id, seq as u64, batch).unwrap();
        }
        store
            .finish(id, data.len() as u64, offsets.len() as u64 + 1, "text", "")
            .unwrap();
    }

    #[test]
    fn read_range_is_exact_across_chunk_boundaries() {
        let (store, dir) = temp_store();
        let mut data = vec![b'A'; CHUNK_BYTES];
        data.extend_from_slice(b"0123456789\n");
        data.extend_from_slice(&vec![b'B'; CHUNK_BYTES]);
        data.extend_from_slice(b"tail\nend");
        write_all(&store, "body-1", &data);

        let info = store.info("body-1").unwrap().unwrap();
        assert_eq!(info.size, data.len() as u64);
        assert_eq!(info.total_lines, 3);

        // A window straddling the first/second chunk boundary.
        let start = CHUNK_BYTES as u64 - 5;
        assert_eq!(
            store.read_range("body-1", start, 24).unwrap(),
            data[start as usize..start as usize + 24].to_vec()
        );
        // Whole body round-trips exactly.
        assert_eq!(
            store.read_range("body-1", 0, data.len() as u64).unwrap(),
            data
        );
        drop(store); // Windows: the open SQLite handle must be released first
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn line_range_matches_split_and_pages() {
        let (store, dir) = temp_store();
        // Newlines deliberately placed across the 64KiB chunk boundary.
        let mut data = vec![b'x'; CHUNK_BYTES - 3];
        data.extend_from_slice(b"aa\n"); // '\n' is the last byte of chunk 0
        data.extend_from_slice(b"bb\ncc\n");
        data.extend_from_slice(b"end");
        write_all(&store, "body-1", &data);

        let expected: Vec<Vec<u8>> = data
            .split(|byte| *byte == b'\n')
            .map(|line| line.to_vec())
            .collect();
        assert_eq!(
            store.info("body-1").unwrap().unwrap().total_lines,
            expected.len() as u64
        );
        assert_eq!(store.line_range("body-1", 0, 100).unwrap(), expected);
        assert_eq!(
            store.line_range("body-1", 1, 2).unwrap(),
            expected[1..3].to_vec()
        );
        drop(store); // Windows: the open SQLite handle must be released first
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ranges_clamp_out_of_bounds() {
        let (store, dir) = temp_store();
        let data = b"hello\nworld".to_vec();
        write_all(&store, "body-1", &data);
        assert_eq!(store.read_range("body-1", 3, 2).unwrap(), b"lo".to_vec());
        assert_eq!(store.read_range("body-1", 0, 1000).unwrap(), data);
        assert!(store.read_range("body-1", 999, 10).unwrap().is_empty());
        assert!(store.line_range("body-1", 999, 10).unwrap().is_empty());
        assert!(store.read_range("missing", 0, 10).unwrap().is_empty());
        assert!(store.info("missing").unwrap().is_none());
        drop(store); // Windows: the open SQLite handle must be released first
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn begin_prunes_oldest_body() {
        let (store, dir) = temp_store();
        for index in 0..MAX_BODIES + 1 {
            let id = format!("body-{index}");
            let data = format!("payload-{index}\n").into_bytes();
            write_all(&store, &id, &data);
        }
        assert!(
            store.info("body-0").unwrap().is_none(),
            "the oldest body must be pruned"
        );
        assert!(store.info("body-1").unwrap().is_some());
        assert!(store.info(&format!("body-{MAX_BODIES}")).unwrap().is_some());
        assert!(store.read_range("body-0", 0, 100).unwrap().is_empty());
        drop(store); // Windows: the open SQLite handle must be released first
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
