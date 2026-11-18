use super::*;

fn test_store(dir: &Path) -> WorkspaceStore {
    fs::create_dir_all(dir).unwrap();
    WorkspaceStore {
        inner: Mutex::new(StoreInner {
            dir: dir.to_path_buf(),
            conn: None,
        }),
        max_bytes: AtomicUsize::new(1024 * 1024),
        vault: Vault::for_tests(),
    }
}

#[test]
fn default_snapshot_passes_validation() {
    assert!(validate_snapshot(&WorkspaceStore::default_snapshot()).is_ok());
}

#[test]
fn workspace_limit_can_be_raised_at_runtime() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-storage-limit-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    assert_eq!(store.max_bytes(), 1024 * 1024);
    assert_eq!(store.set_max_bytes(64 * 1024 * 1024).unwrap(), 64 * 1024 * 1024);
    assert_eq!(store.max_bytes(), 64 * 1024 * 1024);
    // Out-of-range values are rejected without changing the live limit.
    assert!(store.set_max_bytes(0).is_err());
    assert!(store.set_max_bytes(u64::MAX).is_err());
    assert_eq!(store.max_bytes(), 64 * 1024 * 1024);
    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn size_cap_failure_names_the_cap_instead_of_blaming_permissions() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-storage-cap-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    let mut snapshot = WorkspaceStore::default_snapshot();
    snapshot["settings"]["padding"] = json!("x".repeat(1024 * 1024 + 128));
    let error = store.save(&snapshot).expect_err("over-cap snapshot must fail");
    let text = error.to_string();
    assert!(text.contains("超过当前上限"), "{text}");
    assert!(text.contains("调高"), "{text}");
    assert!(!text.contains("权限"), "{text}");
    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn run_history_table_is_created_idempotently_on_old_workspaces() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-storage-run-history-{}",
        crate::logging::now_millis()
    ));
    fs::create_dir_all(&directory).unwrap();
    let db = directory.join(DB_FILE);
    // Simulate a pre-T1.5 workspace: only a legacy table with real data.
    {
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO meta (key, value) VALUES ('legacy', 'keep-me');",
        )
        .unwrap();
    }
    {
        let conn = Connection::open(&db).unwrap();
        // Opening an old workspace must create the table and never rewrite it.
        ensure_schema(&conn).unwrap();
        ensure_schema(&conn).unwrap();
        let legacy: String = conn
            .query_row("SELECT value FROM meta WHERE key = 'legacy'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(legacy, "keep-me");
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'run_history'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(exists, 1);
        conn.execute(
            "INSERT INTO run_history
             (run_id, subject_kind, subject_id, subject_name, started_at, ok,
              total, passed, failed, skipped, evidence_path)
             VALUES ('r1', 'scenario', 's1', 'order-flow', 1, 0, 3, 2, 1, 0, 'artifacts/run.json')",
            [],
        )
        .unwrap();
        let failed: i64 = conn
            .query_row("SELECT failed FROM run_history WHERE run_id = 'r1'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(failed, 1);
    }
    fs::remove_dir_all(&directory).unwrap();
}

#[test]
fn rejects_wrong_version_and_missing_arrays() {
    let mut snapshot = WorkspaceStore::default_snapshot();
    snapshot["version"] = json!(99);
    assert!(validate_snapshot(&snapshot).is_err());

    let mut snapshot = WorkspaceStore::default_snapshot();
    snapshot
        .as_object_mut()
        .unwrap()
        .remove("collections");
    assert!(validate_snapshot(&snapshot).is_err());
}

#[test]
fn rejects_oversized_history() {
    let mut snapshot = WorkspaceStore::default_snapshot();
    snapshot["history"] = json!(vec![0; MAX_HISTORY + 1]);
    assert!(validate_snapshot(&snapshot).is_err());
}

#[test]
fn sync_baseline_survives_workspace_saves_and_can_be_cleared() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-storage-baseline-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    // Saving a snapshot replaces every `meta` row; the baseline must live
    // in its own table or that diff would silently wipe it.
    store.save(&WorkspaceStore::default_snapshot()).unwrap();
    let payload = json!({
        "cloudProjectId": 7,
        "savedAt": 1234,
        "cursor": 42,
        "rows": { "folders": [], "requests": [] }
    });
    assert_eq!(store.load_sync_baseline("p1").unwrap(), None);
    store.save_sync_baseline("p1", &payload).unwrap();
    store.save(&WorkspaceStore::default_snapshot()).unwrap();
    assert_eq!(store.load_sync_baseline("p1").unwrap(), Some(payload.clone()));
    assert_eq!(store.load_sync_baseline("p2").unwrap(), None);

    // Re-saving the same key is an upsert, never a duplicate-key failure.
    let newer = json!({ "cloudProjectId": 7, "savedAt": 5678, "cursor": 43, "rows": {} });
    store.save_sync_baseline("p1", &newer).unwrap();
    assert_eq!(store.load_sync_baseline("p1").unwrap(), Some(newer));

    store.clear_sync_baseline("p1").unwrap();
    assert_eq!(store.load_sync_baseline("p1").unwrap(), None);

    // Switching servers sweeps the active database and every registered one.
    store.save_sync_baseline("p1", &payload).unwrap();
    store
        .clear_all_sync_baselines(&[directory.clone()])
        .unwrap();
    assert_eq!(store.load_sync_baseline("p1").unwrap(), None);
    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn tombstones_roundtrip_as_deleted_rows() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-storage-tombstone-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);

    let mut snapshot = WorkspaceStore::default_snapshot();
    snapshot["collections"] = json!([
        { "id": "c1", "name": "用户服务", "updatedAt": 10, "items": [] }
    ]);
    snapshot["tombstones"] = json!([
        { "kind": "request", "id": "r1", "updatedAt": 900 },
        { "kind": "docPage", "id": "d1", "updatedAt": 901 }
    ]);
    store.save(&snapshot).unwrap();

    let conn = Connection::open(directory.join(DB_FILE)).unwrap();
    let (deleted, name): (i64, String) = conn
        .query_row(
            "SELECT deleted, name FROM entity WHERE id = 'r1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(deleted, 1, "墓碑必须写成 deleted=1 的行");
    assert_eq!(name, "", "墓碑行的 name 允许为空");
    drop(conn);

    let loaded = store.load().unwrap();
    let mut kinds: Vec<(String, String)> = loaded["tombstones"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["kind"].as_str().unwrap().to_string(),
                item["id"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    kinds.sort();
    assert_eq!(
        kinds,
        vec![
            ("docPage".to_string(), "d1".to_string()),
            ("request".to_string(), "r1".to_string())
        ]
    );

    // 墓碑被清理后，下一次保存不应再读回它们。
    snapshot.as_object_mut().unwrap().remove("tombstones");
    store.save(&snapshot).unwrap();
    assert!(store.load().unwrap().get("tombstones").is_none());

    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn copy_to_writes_a_verified_database_without_wal_sidecars() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-storage-copy-src-{}",
        crate::logging::now_millis()
    ));
    let target = std::env::temp_dir().join(format!(
        "reqora-storage-copy-dst-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);

    let mut snapshot = WorkspaceStore::default_snapshot();
    snapshot["collections"] = json!([
        { "id": "c1", "name": "用户服务", "updatedAt": 10, "items": [] }
    ]);
    store.save(&snapshot).unwrap();

    store.copy_to(&target).unwrap();

    let conn = Connection::open(target.join(DB_FILE)).unwrap();
    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM entity WHERE id = 'c1'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(rows, 1, "复制必须包含已 checkpoint 的写入");
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
    drop(conn);

    let _ = fs::remove_dir_all(&directory);
    let _ = fs::remove_dir_all(&target);
}

#[test]
fn trash_is_optional_but_bounded() {
    let mut snapshot = WorkspaceStore::default_snapshot();
    snapshot
        .as_object_mut()
        .unwrap()
        .remove("trash");
    assert!(validate_snapshot(&snapshot).is_ok());

    let mut snapshot = WorkspaceStore::default_snapshot();
    snapshot["trash"] = json!(vec![0; MAX_TRASH + 1]);
    assert!(validate_snapshot(&snapshot).is_err());
}

#[test]
fn save_load_roundtrip_stores_rows() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-storage-test-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);

    let mut initial = WorkspaceStore::default_snapshot();
    initial["collections"] = json!([
        {
            "id": "c1",
            "name": "用户服务",
            "auth": { "type": "bearer", "token": "local-token" },
            "updatedAt": 111,
            "items": [
                {
                    "id": "r1", "name": "登录", "method": "POST",
                    "url": "{{baseUrl}}/login", "folder": "auth",
                    "protocol": "http",
                    "headers": [{ "id": "h1", "key": "X", "value": "1", "enabled": true }],
                    "body": { "type": "json", "content": "{}" },
                    "auth": { "type": "inherit" }, "updatedAt": 222
                }
            ]
        }
    ]);
    initial["cases"] = json!([
        { "id": "k1", "requestId": "r1", "name": "正向", "group": "正向",
          "enabled": true, "request": { "id": "r1-copy" }, "updatedAt": 333 }
    ]);
    assert_eq!(store.load().unwrap(), WorkspaceStore::default_snapshot()); // empty -> defaults
    store.save(&initial).unwrap();

    assert!(directory.join(DB_FILE).exists());

    let loaded = store.load().unwrap();
    assert_eq!(loaded["collections"], initial["collections"]);
    assert_eq!(loaded["cases"], initial["cases"]);
    assert_eq!(loaded["version"], json!(1));

    // Rows are queryable: the request row carries method/url as columns.
    let conn = Connection::open(directory.join(DB_FILE)).unwrap();
    let (kind, method): (String, String) = conn
        .query_row(
            "SELECT kind, method FROM entity WHERE id = 'r1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(kind, "request");
    assert_eq!(method, "POST");
    let folder_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM entity WHERE kind = 'folder'", [], |row| row.get(0))
        .unwrap();
    assert_eq!(folder_count, 1);
    drop(conn);

    // Saving an emptied snapshot clears every row (no stale leftovers).
    let mut emptied = WorkspaceStore::default_snapshot();
    emptied["seeded"] = json!(true);
    store.save(&emptied).unwrap();
    assert_eq!(store.load().unwrap(), emptied);

    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn legacy_split_json_is_imported_once_and_kept() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-legacy-test-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    let mut legacy = WorkspaceStore::default_snapshot();
    legacy["history"] = json!([{ "id": "legacy", "at": 1, "status": 201 }]);
    legacy["environments"] = json!([
        { "id": "e1", "name": "测试", "variables": [], "updatedAt": 5 }
    ]);
    let manifest_keys = vec!["collections", "environments", "history"];
    for key in &manifest_keys {
        let file_name = format!("{key}.json");
        let value = if key == &"collections" {
            json!([])
        } else if key == &"environments" {
            legacy["environments"].clone()
        } else {
            legacy["history"].clone()
        };
        fs::write(
            directory.join(&file_name),
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .unwrap();
    }
    fs::write(
        directory.join(MANIFEST_FILE),
        serde_json::to_vec_pretty(&json!({
            "format": "split", "version": 1, "keys": manifest_keys
        }))
        .unwrap(),
    )
    .unwrap();

    let loaded = store.load().unwrap();
    assert_eq!(loaded["history"], legacy["history"]);
    assert_eq!(loaded["environments"], legacy["environments"]);
    // The original JSON files are kept for manual inspection / revert.
    assert!(directory.join("history.json").exists());
    assert!(directory.join(MANIFEST_FILE).exists());

    // A second load must not re-import (flagged in meta).
    fs::write(directory.join("history.json"), serde_json::to_vec_pretty(&json!([])).unwrap())
        .unwrap();
    let reloaded = store.load().unwrap();
    assert_eq!(reloaded["history"], legacy["history"]);

    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn legacy_single_file_is_imported() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-legacy-single-test-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    let mut legacy = WorkspaceStore::default_snapshot();
    legacy["history"] = json!([{ "id": "single", "at": 2, "status": 200 }]);
    fs::write(
        directory.join(LEGACY_FILE),
        serde_json::to_vec_pretty(&legacy).unwrap(),
    )
    .unwrap();
    assert_eq!(store.load().unwrap()["history"], legacy["history"]);
    assert!(directory.join(LEGACY_FILE).exists());
    let _ = fs::remove_dir_all(&directory);
}

/// A representative snapshot without credential-shaped fields: the vault
/// seals those with a random nonce, so including them would deliberately
/// (and correctly) produce a write on every save.
fn diff_snapshot() -> Value {
    let mut snapshot = WorkspaceStore::default_snapshot();
    snapshot["collections"] = json!([
        {
            "id": "c1", "name": "Users", "updatedAt": 111,
            "items": [
                { "id": "r1", "name": "List", "method": "GET",
                  "url": "https://example.com/users", "folder": "",
                  "protocol": "http", "updatedAt": 222 },
                { "id": "r2", "name": "Create", "method": "POST",
                  "url": "https://example.com/users", "folder": "",
                  "protocol": "http", "updatedAt": 223 }
            ]
        }
    ]);
    snapshot["environments"] = json!([
        { "id": "e1", "name": "Local", "variables": [], "updatedAt": 5 }
    ]);
    snapshot["history"] = json!([{ "id": "h1", "at": 1, "status": 200 }]);
    snapshot["trash"] = json!([{ "id": "t1", "deletedAt": 2, "kind": "request" }]);
    snapshot["revisions"] = json!({ "r1": [{ "id": "rv1", "at": 3 }] });
    snapshot["settings"] = json!({ "timeoutSecs": 30 });
    snapshot
}

#[test]
fn repeated_save_is_a_no_op_and_single_edit_writes_one_row() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-storage-diff-noop-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    let mut snapshot = diff_snapshot();
    let first_writes = store.save_with_write_count(&snapshot).unwrap();
    assert!(first_writes >= 8, "the first save must create the initial rows");

    assert_eq!(
        store.save_with_write_count(&snapshot).unwrap(),
        0,
        "an unchanged snapshot must not rewrite any row"
    );

    snapshot["collections"][0]["items"][0]["name"] = json!("List (renamed)");
    assert_eq!(
        store.save_with_write_count(&snapshot).unwrap(),
        1,
        "only the changed request row should be written"
    );
    assert_eq!(store.load().unwrap()["collections"], snapshot["collections"]);

    let _ = fs::remove_dir_all(&directory);
}

/// P0 regression: the WebView's in-memory snapshot must not silently
/// overwrite an out-of-process (MCP / CLI) write. Both writers share the
/// `workspace_rev` counter, and a stale auto-save writes nothing at all.
#[test]
fn checked_save_detects_external_writer_and_can_be_forced_after_backup() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-storage-rev-cas-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    let snapshot = diff_snapshot();
    let saved = match store.save_checked(&snapshot, None, false).unwrap() {
        SaveResult::Saved(rev) => rev,
        SaveResult::Conflict(_) => panic!("the first save cannot conflict"),
    };
    assert_eq!(saved.rev, 1);
    assert_eq!(saved.writer, "desktop");

    // Simulate bin/workspaceStore.mjs: one new row + a revision bump.
    store
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO entity
                    (id, kind, parent_id, folder_path, name, position, enabled,
                     updated_at, deleted, data)
                 VALUES ('mcp-added', 'request', NULL, '', 'From MCP', 0, 1, 99, 0, '{}')",
                [],
            )
            .unwrap();
            conn.execute(
                "UPDATE workspace_rev SET rev = rev + 1, writer = 'mcp', updated_at = 99
                 WHERE id = 1",
                [],
            )
            .unwrap();
            Ok::<(), AppError>(())
        })
        .unwrap();

    let mut stale = snapshot.clone();
    stale["collections"][0]["items"][0]["name"] = json!("Desktop edit");
    match store.save_checked(&stale, Some(1), false).unwrap() {
        SaveResult::Conflict(current) => {
            assert_eq!(current.rev, 2);
            assert_eq!(current.writer, "mcp");
        }
        SaveResult::Saved(_) => panic!("a stale revision must be rejected"),
    }

    // The rejected save touched nothing: MCP's row survived, the counter
    // did not move, and the desktop's edit was not persisted.
    let surviving: i64 = store
        .with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT COUNT(*) FROM entity WHERE id = 'mcp-added'",
                    [],
                    |row| row.get(0),
                )
                .unwrap())
        })
        .unwrap()
        .1;
    assert_eq!(surviving, 1, "external rows must not be deleted by a stale save");
    assert_eq!(store.workspace_rev().unwrap().rev, 2);
    assert_ne!(
        store.load().unwrap()["collections"][0]["items"][0]["name"],
        json!("Desktop edit")
    );

    // Explicit overwrite (the UI takes a backup first) succeeds and
    // advances the counter so subsequent saves are consistent again.
    match store.save_checked(&stale, Some(1), true).unwrap() {
        SaveResult::Saved(rev) => assert_eq!(rev.rev, 3),
        SaveResult::Conflict(_) => panic!("forced save must succeed"),
    }
    assert_eq!(
        store.load().unwrap()["collections"][0]["items"][0]["name"],
        json!("Desktop edit")
    );
    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn diff_save_removes_rows_that_disappeared_from_the_snapshot() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-storage-diff-delete-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    let mut snapshot = diff_snapshot();
    store.save(&snapshot).unwrap();

    snapshot["collections"][0]["items"].as_array_mut().unwrap().pop();
    snapshot["history"] = json!([]);
    snapshot["trash"] = json!([]);
    snapshot["revisions"] = json!({});
    store.save(&snapshot).unwrap();

    let conn = Connection::open(directory.join(DB_FILE)).unwrap();
    let requests: i64 = conn
        .query_row("SELECT COUNT(*) FROM entity WHERE kind = 'request'", [], |row| row.get(0))
        .unwrap();
    assert_eq!(requests, 1);
    for table in ["history", "trash", "request_revision"] {
        let count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0, "{table} should be empty after the snapshot shrank");
    }
    drop(conn);
    assert_eq!(store.load().unwrap()["collections"], snapshot["collections"]);

    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn saving_an_emptied_snapshot_still_clears_every_row() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-storage-diff-empty-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    store.save(&diff_snapshot()).unwrap();
    let mut emptied = WorkspaceStore::default_snapshot();
    emptied["seeded"] = json!(true);
    store.save(&emptied).unwrap();
    assert_eq!(store.load().unwrap(), emptied);

    let conn = Connection::open(directory.join(DB_FILE)).unwrap();
    for table in ["entity", "history", "trash", "request_revision"] {
        let count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0, "{table} still has stale rows");
    }
    drop(conn);

    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn backup_keeps_a_real_copy_and_prunes_to_ten() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-backup-test-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    let mut snapshot = WorkspaceStore::default_snapshot();
    snapshot["history"] = json!([{ "id": "local-only", "at": 1, "status": 200 }]);
    store.save(&snapshot).unwrap();

    let missing = test_store(&directory.join("missing-project"));
    assert!(missing.backup("cloud-pull").is_err());

    let first = store.backup("cloud-pull").unwrap();
    assert!(first.join(DB_FILE).exists());
    assert!(first.to_string_lossy().contains("cloud-pull"));

    for index in 0..12 {
        store.backup(&format!("reason-{index}")).unwrap();
    }
    let backups = fs::read_dir(directory.join(BACKUPS_DIR))
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .count();
    assert_eq!(backups, 10);

    let _ = fs::remove_dir_all(&directory);
}

// ---------------------------------------------- save_rows_checked ----

fn delta_request_row(id: &str, url: &str, updated_at: i64) -> Value {
    json!({
        "id": id,
        "folderId": "c1",
        "folderPath": "",
        "name": "登录",
        "method": "POST",
        "url": url,
        "protocol": "http",
        "position": 0,
        "updatedAt": updated_at,
        "data": { "body": { "type": "json", "content": "{\"a\":1}" } },
    })
}


fn delta_folder_row(id: &str, position: i64) -> Value {
    json!({
        "id": id,
        "name": "集合",
        "auth": null,
        "position": position,
        "updatedAt": 1,
        "data": {},
    })
}
fn delta(rows: Value) -> Value {
    json!({ "rows": { "requests": rows } })
}

/// 代码中台管理模板走的是统一 artifacts 行域（每行 kind=codeTemplate）。
/// 后端若不认识该域，会抛「未知的行域: artifacts」，模板编辑全部落盘失败。
#[test]
fn save_rows_accepts_unified_artifacts_domain() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-save-rows-artifacts-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    store
        .save_rows_checked(
            &json!({ "rows": { "folders": [delta_folder_row("c1", 0)] } }),
            None,
        )
        .unwrap();
    let rev = store.workspace_rev().unwrap().rev;

    let template = json!({
        "id": "tpl-code",
        "kind": "codeTemplate",
        "name": "示例模板",
        "position": 0,
        "updatedAt": 100,
        "data": { "language": "typescript", "content": "export const x = 1" },
    });
    store
        .save_rows_checked(
            &json!({ "rows": { "artifacts": [template] } }),
            Some(rev),
        )
        .unwrap();

    // 落库为 kind=artifact / sub_kind=codeTemplate，整份读取能装配回 codeTemplates。
    let (_, kind_and_sub): (_, (String, Option<String>)) = store
        .with_conn(|conn| {
            conn.query_row(
                "SELECT kind, sub_kind FROM entity WHERE id = 'tpl-code'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| AppError::Storage(format!("读取模板行失败: {error}")))
        })
        .unwrap();
    assert_eq!(kind_and_sub.0, KIND_ARTIFACT);
    assert_eq!(kind_and_sub.1.as_deref(), Some("codeTemplate"));

    let snapshot = store.load().unwrap();
    let templates = snapshot["codeTemplates"].as_array().unwrap();
    assert_eq!(templates.len(), 1);
    assert_eq!(templates[0]["id"], "tpl-code");

    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn save_rows_rejects_unknown_artifact_kind() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-save-rows-artifact-bad-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    let bad = json!({
        "id": "bad-1",
        "kind": "notARealKind",
        "name": "坏行",
        "position": 0,
        "updatedAt": 100,
        "data": {},
    });
    let error = store
        .save_rows_checked(&json!({ "rows": { "artifacts": [bad] } }), None)
        .expect_err("unknown artifact kind must be rejected");
    assert!(error.to_string().contains("未知 kind"), "{error}");

    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn save_rows_upserts_changes_and_bumps_rev() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-save-rows-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    store
        .save_rows_checked(
            &json!({ "rows": { "folders": [delta_folder_row("c1", 0)] } }),
            None,
        )
        .unwrap();
    let rev0 = store.workspace_rev().unwrap().rev;

    let outcome = store
        .save_rows_checked(&delta(json!([delta_request_row("r1", "{{base}}/login", 100)])), Some(rev0))
        .unwrap();
    let SaveResult::Saved(rev1) = outcome else { panic!("expected Saved") };
    assert!(rev1.rev > rev0);

    // 相同行再次保存：列级 diff 命中 → 零写入，但仍推进 rev（写事务语义）。
    let before = count_entity_rows(&store);
    let outcome = store
        .save_rows_checked(&delta(json!([delta_request_row("r1", "{{base}}/login", 100)])), Some(rev1.rev))
        .unwrap();
    let SaveResult::Saved(rev2) = outcome else { panic!("expected Saved") };
    assert!(rev2.rev > rev1.rev);
    assert_eq!(count_entity_rows(&store), before);

    // 变更行 → 数据被更新。
    store
        .save_rows_checked(&delta(json!([delta_request_row("r1", "{{base}}/logout", 200)])), Some(rev2.rev))
        .unwrap();
    let snapshot = store.load().unwrap();
    let item = &snapshot["collections"][0]["items"][0];
    assert_eq!(item["url"], "{{base}}/logout");
    assert_eq!(item["updatedAt"], 200);

    let _ = fs::remove_dir_all(&directory);
}

fn count_entity_rows(store: &WorkspaceStore) -> i64 {
    store
        .with_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM entity", [], |row| row.get::<_, i64>(0))
                .map_err(|error| AppError::Storage(format!("统计行失败: {error}")))
        })
        .map(|(_, count)| count)
        .unwrap()
}

#[test]
fn save_rows_conflicts_on_stale_rev() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-save-rows-conflict-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    store
        .save_rows_checked(
            &json!({ "rows": { "folders": [delta_folder_row("c1", 0)] } }),
            None,
        )
        .unwrap();
    let rev0 = store.workspace_rev().unwrap().rev;
    let outcome = store
        .save_rows_checked(&delta(json!([delta_request_row("r1", "{{base}}/login", 100)])), Some(rev0))
        .unwrap();
    let SaveResult::Saved(_) = outcome else { panic!("expected Saved") };
    let outcome = store
        .save_rows_checked(&delta(json!([delta_request_row("r1", "{{base}}/x", 300)])), Some(rev0))
        .unwrap();
    assert!(matches!(outcome, SaveResult::Conflict(_)), "expected Conflict on stale rev");
    // Conflict 时一行不写：数据保持第一次保存的内容。
    let snapshot = store.load().unwrap();
    assert_eq!(snapshot["collections"][0]["items"][0]["url"], "{{base}}/login");
    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn save_rows_secrets_are_sealed_and_roundtrip() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-save-rows-vault-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    store
        .save_rows_checked(
            &json!({ "rows": { "folders": [delta_folder_row("c1", 0)] } }),
            None,
        )
        .unwrap();
    let rev0 = store.workspace_rev().unwrap().rev;
    let mut row = delta_request_row("r1", "{{base}}/login", 100);
    row["data"]["auth"] = json!({ "type": "bearer", "token": "super-secret-token" });
    store.save_rows_checked(&delta(json!([row])), Some(rev0)).unwrap();

    // 落盘内容不含明文。
    let raw = store.with_conn(|conn| {
        conn.query_row(
            "SELECT data FROM entity WHERE id = 'r1'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| AppError::Storage(format!("读行失败: {error}")))
    }).map(|(_, data)| data).unwrap();
    assert!(!raw.contains("super-secret-token"));

    // 整份读回时解密还原。
    let snapshot = store.load().unwrap();
    assert_eq!(
        snapshot["collections"][0]["items"][0]["auth"]["token"],
        "super-secret-token"
    );
    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn save_rows_tombstones_and_aux_rows() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-save-rows-tomb-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    store
        .save_rows_checked(
            &json!({ "rows": { "folders": [delta_folder_row("c1", 0)] } }),
            None,
        )
        .unwrap();
    let rev0 = store.workspace_rev().unwrap().rev;
    store
        .save_rows_checked(&delta(json!([delta_request_row("r1", "{{base}}/login", 100)])), Some(rev0))
        .unwrap();

    // 墓碑行 → deleted=1 落库，整份读回时进 tombstones。
    let rev = store.workspace_rev().unwrap().rev;
    store
        .save_rows_checked(
            &json!({ "rows": { "requests": [ {
                "id": "r1", "deleted": true, "updatedAt": 500,
            } ] } }),
            Some(rev),
        )
        .unwrap();
    let snapshot = store.load().unwrap();
    assert_eq!(snapshot["collections"][0]["items"].as_array().unwrap().len(), 0);
    let tombstones = snapshot["tombstones"].as_array().unwrap();
    assert!(tombstones.iter().any(|t| t["id"] == "r1" && t["kind"] == "request"));

    // 历史行 + 删除。
    let rev = store.workspace_rev().unwrap().rev;
    store
        .save_rows_checked(
            &json!({
                "history": [ { "id": "h1", "at": 10, "kind": "request", "status": 200 } ],
            }),
            Some(rev),
        )
        .unwrap();
    let rev = store.workspace_rev().unwrap().rev;
    store
        .save_rows_checked(&json!({ "historyDeletes": ["h1"] }), Some(rev))
        .unwrap();
    let snapshot = store.load().unwrap();
    assert_eq!(snapshot["history"].as_array().unwrap().len(), 0);

    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn save_rows_meta_upserts_only_given_keys() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-save-rows-meta-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    let rev0 = store.workspace_rev().unwrap().rev;
    store
        .save_rows_checked(
            &json!({ "meta": { "activeEnvironmentId": "env-1" } }),
            Some(rev0),
        )
        .unwrap();
    let snapshot = store.load().unwrap();
    assert_eq!(snapshot["activeEnvironmentId"], "env-1");
    // settings 未随 meta 提供时不得被清空。
    assert!(snapshot["settings"]["timeoutSecs"].as_i64().is_some());
    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn save_rows_enforces_kind_caps() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-save-rows-cap-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    let rev = store.workspace_rev().unwrap().rev;
    let mcp_rows: Vec<Value> = (0..MAX_MCP_SERVERS)
        .map(|index| {
            json!({
                "id": format!("mcp-{index}"),
                "name": format!("server-{index}"),
                "position": index,
                "updatedAt": 1,
                "data": {},
            })
        })
        .collect();
    store
        .save_rows_checked(&json!({ "rows": { "mcpServers": mcp_rows } }), Some(rev))
        .unwrap();
    let rev = store.workspace_rev().unwrap().rev;
    let error = store
        .save_rows_checked(
            &json!({ "rows": { "mcpServers": [ {
                "id": "mcp-over", "name": "over", "position": 99, "updatedAt": 1, "data": {},
            } ] } }),
            Some(rev),
        )
        .expect_err("over-cap insert must fail");
    assert!(error.to_string().contains("上限"), "{error}");
    let _ = fs::remove_dir_all(&directory);
}

/// P0 回归：行级保存必须采用行自带的 `position`。旧实现用数组下标覆盖，
/// 单行编辑（数组里只有一行）会把该行 position 写成 0，重开项目后顺序错乱。
#[test]
fn save_rows_keeps_explicit_position() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-save-rows-position-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    store
        .save_rows_checked(
            &json!({ "rows": { "folders": [delta_folder_row("c1", 0)] } }),
            None,
        )
        .unwrap();
    let rev0 = store.workspace_rev().unwrap().rev;
    // 两行的数组下标是 0 / 1，但业务顺序是 7 / 3：落库必须按行内字段。
    let mut first = delta_request_row("r1", "{{base}}/one", 100);
    first["position"] = json!(7);
    let mut second = delta_request_row("r2", "{{base}}/two", 100);
    second["position"] = json!(3);
    store
        .save_rows_checked(&delta(json!([first, second])), Some(rev0))
        .unwrap();

    let positions = store
        .with_conn(|conn| {
            let mut statement = conn
                .prepare("SELECT id, position FROM entity WHERE kind = 'request' ORDER BY id")
                .map_err(|error| AppError::Storage(format!("读取顺序失败: {error}")))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .map_err(|error| AppError::Storage(format!("读取顺序失败: {error}")))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(|error| {
                    AppError::Storage(format!("读取顺序失败: {error}"))
                })?);
            }
            Ok(out)
        })
        .map(|(_, out)| out)
        .unwrap();
    assert_eq!(positions, vec![("r1".to_string(), 7), ("r2".to_string(), 3)]);

    // 整份读回也按 position 排序（ORDER BY kind, position, id）。
    let snapshot = store.load().unwrap();
    let ids: Vec<&str> = snapshot["collections"][0]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["r2", "r1"]);
    let _ = fs::remove_dir_all(&directory);
}

/// P1 回归：整份保存只删除"载荷实际提供的域"里的多余行。云同步 / 旧快照
/// 常常只带 collections，缺 suites / docPages 等键时不能把库里现有行抹掉；
/// 显式空数组仍然表示"这个域被清空了"。
#[test]
fn full_save_preserves_domains_absent_from_payload() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-full-save-partial-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    let mut snapshot = diff_snapshot();
    snapshot["suites"] = json!([{ "id": "s1", "name": "冒烟", "updatedAt": 5 }]);
    snapshot["docPages"] = json!([{ "id": "d1", "title": "文档", "updatedAt": 6 }]);
    store.save(&snapshot).unwrap();

    // 缺省域（partial 没有 suites / docPages 键）→ 保留库里的行。
    let mut partial = WorkspaceStore::default_snapshot();
    partial["collections"] = snapshot["collections"].clone();
    store.save(&partial).unwrap();
    let loaded = store.load().unwrap();
    assert_eq!(loaded["suites"][0]["id"], "s1", "缺省域不得被隐式删除");
    assert_eq!(loaded["docPages"][0]["id"], "d1");

    // 显式空数组 → 清空该域（用户确实删掉了全部内容）。
    partial["suites"] = json!([]);
    partial["docPages"] = json!([]);
    store.save(&partial).unwrap();
    let loaded = store.load().unwrap();
    // 空域在读回时可能整个键都不出现（rebuild 只在非空时插入）。
    let count = |key: &str| {
        loaded
            .get(key)
            .and_then(Value::as_array)
            .map_or(0, |items| items.len())
    };
    assert_eq!(count("suites"), 0);
    assert_eq!(count("docPages"), 0);
    // 已有集合同样保留（partial 仍提供了 collections）。
    assert_eq!(loaded["collections"][0]["id"], "c1");
    let _ = fs::remove_dir_all(&directory);
}

/// P2 回归：辅助表（history / trash / revisions / meta）没有实体行可增量
/// 合并，增量读取必须用 `auxChanged` 告诉前端整份重载，否则外部写入
/// 历史/回收站会被静默漏掉。
#[test]
fn workspace_delta_flags_auxiliary_table_changes() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-delta-aux-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    store
        .save_rows_checked(
            &json!({ "rows": { "folders": [delta_folder_row("c1", 0)] } }),
            None,
        )
        .unwrap();
    let base = store.workspace_rev().unwrap().rev;
    let clean = store.workspace_delta(base).unwrap();
    assert_eq!(clean["auxChanged"], false);
    assert_eq!(clean["auxTables"].as_array().unwrap().len(), 0);

    let rev = store.workspace_rev().unwrap().rev;
    store
        .save_rows_checked(
            &json!({ "history": [{ "id": "h1", "at": 10, "status": 200 }] }),
            Some(rev),
        )
        .unwrap();
    let payload = store.workspace_delta(base).unwrap();
    assert_eq!(payload["auxChanged"], true);
    assert!(
        payload["auxTables"]
            .as_array()
            .unwrap()
            .iter()
            .any(|name| name == "history"),
        "auxTables 应包含 history: {payload}"
    );

    // 水位推进后不再重复上报。
    let next = payload["rev"].as_i64().unwrap();
    let after = store.workspace_delta(next).unwrap();
    assert_eq!(after["auxChanged"], false);
    let _ = fs::remove_dir_all(&directory);
}

/// P3 回归：行级保存同样受"工作区上限"约束，超限必须回滚（行没落库、
/// 版本号不动），而不是悄悄把库撑大或退化成权限错误。
#[test]
fn save_rows_enforces_workspace_size_limit() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-save-rows-size-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    store
        .save_rows_checked(
            &json!({ "rows": { "folders": [delta_folder_row("c1", 0)] } }),
            None,
        )
        .unwrap();
    // 上限只比当前物理占用高 64 KiB：下一次写入必然越过。
    let used = store
        .with_conn(|conn| live_storage_bytes(conn))
        .map(|(_, used)| used)
        .unwrap();
    store.set_max_bytes(used + 64 * 1024).unwrap();

    let rev = store.workspace_rev().unwrap().rev;
    let mut row = delta_request_row("r-big", "{{base}}/big", 100);
    row["data"]["body"]["content"] = json!("x".repeat(2 * 1024 * 1024));
    let error = store
        .save_rows_checked(&delta(json!([row])), Some(rev))
        .expect_err("超出存储上限的行级保存必须失败");
    assert!(error.to_string().contains("上限"), "{error}");

    // 事务回滚：行没落库，版本号也没推进。
    assert_eq!(store.workspace_rev().unwrap().rev, rev);
    let count = store
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM entity WHERE id = 'r-big'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| AppError::Storage(format!("统计行失败: {error}")))
        })
        .map(|(_, count)| count)
        .unwrap();
    assert_eq!(count, 0, "超限保存必须整体回滚");

    // 已经超限的库仍允许"不继续变大"的写入（例如清理/删除），否则用户会被
    // 锁死在无法保存也无法清理的状态。
    store.set_max_bytes(used).unwrap();
    let rev = store.workspace_rev().unwrap().rev;
    store
        .save_rows_checked(&json!({}), Some(rev))
        .expect("不增加占用的保存不应被容量门禁拦住");
    let _ = fs::remove_dir_all(&directory);
}

// ---------------------------------------------- external delta read ----

/// 模拟进程外 MCP 写入：在事务里改行并把 workspace_rev 与实体行一起推进
/// （Node `workspaceStore.mjs` 的 #writeWithRev 语义）。
fn external_write(store: &WorkspaceStore, entity_id: &str, url: &str) -> i64 {
    store
        .with_conn(|conn| {
            let tx = conn
                .transaction()
                .map_err(|error| AppError::Storage(format!("开启事务失败: {error}")))?;
            tx.execute(
                "UPDATE entity SET url = ?1, updated_at = 200 WHERE id = ?2",
                rusqlite::params![url, entity_id],
            )
            .map_err(|error| AppError::Storage(format!("外部更新失败: {error}")))?;
            let rev = read_workspace_rev(&tx)?.rev + 1;
            tx.execute(
                "UPDATE entity SET rev = ?1 WHERE id = ?2",
                rusqlite::params![rev, entity_id],
            )
            .map_err(|error| AppError::Storage(format!("标记行水位失败: {error}")))?;
            tx.execute(
                "UPDATE workspace_rev SET rev = ?1, writer = 'mcp', updated_at = ?2 WHERE id = 1",
                rusqlite::params![rev, crate::logging::now_millis() as i64],
            )
            .map_err(|error| AppError::Storage(format!("推进版本号失败: {error}")))?;
            let result: Result<i64, AppError> = Ok(rev);
            tx.commit()
                .map_err(|error| AppError::Storage(format!("提交失败: {error}")))?;
            result
        })
        .map(|(_, rev)| rev)
        .unwrap()
}

#[test]
fn workspace_delta_returns_only_rows_changed_after_rev() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-delta-read-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    store
        .save_rows_checked(
            &json!({ "rows": { "folders": [delta_folder_row("c1", 0)] } }),
            None,
        )
        .unwrap();
    store
        .save_rows_checked(&delta(json!([delta_request_row("r1", "{{base}}/a", 100)])), None)
        .unwrap();
    let base = store.workspace_rev().unwrap().rev;
    // 基线之后没有外部写入 → 空增量。
    let empty = store.workspace_delta(base).unwrap();
    assert_eq!(empty["rev"], base);
    assert_eq!(empty["entries"].as_array().unwrap().len(), 0);

    let rev = external_write(&store, "r1", "{{base}}/mcp");
    let delta_payload = store.workspace_delta(base).unwrap();
    assert_eq!(delta_payload["rev"], rev);
    assert_eq!(delta_payload["writer"], "mcp");
    let entries = delta_payload["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1, "只返回变化的接口行: {entries:?}");
    assert_eq!(entries[0]["domain"], "requests");
    assert_eq!(entries[0]["parentId"], "c1");
    assert_eq!(entries[0]["position"], 0);
    assert_eq!(entries[0]["item"]["url"], "{{base}}/mcp");
    assert_eq!(entries[0]["item"]["name"], "登录");
    // 再次按新基线读取：没有新变化。
    let after = store.workspace_delta(rev).unwrap();
    assert_eq!(after["entries"].as_array().unwrap().len(), 0);
    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn workspace_delta_signals_reset_when_revision_is_ahead() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-delta-reset-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    store.save(&WorkspaceStore::default_snapshot()).unwrap();
    let rev = store.workspace_rev().unwrap().rev;
    let payload = store.workspace_delta(rev + 10).unwrap();
    assert_eq!(payload["reset"], true);
    assert_eq!(payload["rev"], rev);
    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn workspace_delta_exposes_tombstones_and_decrypts_secrets() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-delta-tomb-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    store
        .save_rows_checked(
            &json!({ "rows": { "folders": [delta_folder_row("c1", 0)] } }),
            None,
        )
        .unwrap();
    let base = store.workspace_rev().unwrap().rev;
    let mut row = delta_request_row("r1", "{{base}}/login", 100);
    row["data"]["auth"] = json!({ "type": "bearer", "token": "delta-secret" });
    store.save_rows_checked(&delta(json!([row])), Some(base)).unwrap();
    let rev = store.workspace_rev().unwrap().rev;
    store
        .save_rows_checked(
            &json!({ "rows": { "requests": [{
                "id": "r2", "folderId": "c1", "name": "已删", "position": 1,
                "updatedAt": 500, "deleted": true, "data": {},
            }] } }),
            Some(rev),
        )
        .unwrap();

    let payload = store.workspace_delta(base).unwrap();
    let entries = payload["entries"].as_array().unwrap();
    let request = entries
        .iter()
        .find(|entry| entry["item"]["id"] == "r1")
        .expect("changed request must be present");
    assert_eq!(
        request["item"]["auth"]["token"], "delta-secret",
        "凭据必须在离开 store 前解密"
    );
    let tombstone = entries
        .iter()
        .find(|entry| entry["deleted"] == true)
        .expect("tombstone must be present");
    assert_eq!(tombstone["domain"], "requests");
    assert_eq!(tombstone["tombstone"]["kind"], "request");
    assert_eq!(tombstone["tombstone"]["id"], "r2");
    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn legacy_entity_table_gets_rev_column_backfilled() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-delta-migration-{}",
        crate::logging::now_millis()
    ));
    fs::create_dir_all(&directory).unwrap();
    let db = directory.join(DB_FILE);
    {
        let conn = Connection::open(&db).unwrap();
        // 升级前真实表结构：没有 rev 列，而 workspace_rev 已领先。
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE entity (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, parent_id TEXT,
                folder_path TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
                method TEXT, url TEXT, protocol TEXT, auth TEXT,
                position INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
                case_group TEXT, sub_kind TEXT, updated_at INTEGER NOT NULL DEFAULT 0,
                deleted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}'
             );
             INSERT INTO entity (id, kind, name, data) VALUES ('c1', 'folder', '旧集合', '{}');
             INSERT INTO entity (id, kind, parent_id, name, data)
                 VALUES ('r1', 'request', 'c1', '旧接口', '{}');
             CREATE TABLE workspace_rev (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                rev INTEGER NOT NULL, writer TEXT NOT NULL, updated_at INTEGER NOT NULL
             );
             INSERT INTO workspace_rev VALUES (1, 7, 'desktop', 1);",
        )
        .unwrap();
    }
    let store = test_store(&directory);
    assert_eq!(store.load().unwrap()["collections"][0]["items"][0]["id"], "r1");
    // 回填到当前版本：升级后第一次增量读取是空操作，不会误报全库变化。
    let empty = store.workspace_delta(7).unwrap();
    assert_eq!(empty["rev"], 7);
    assert_eq!(empty["entries"].as_array().unwrap().len(), 0);
    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn legacy_case_rows_drop_transient_collection_cache_on_read() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-case-cache-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    let _ = store.workspace_rev().unwrap().rev;
    store
        .save_rows_checked(
            &json!({
                "rows": {
                    "folders": [delta_folder_row("c1", 0)],
                    "requests": [delta_request_row("r1", "{{base}}/x", 100)],
                    "cases": [{
                        "id": "case-legacy", "requestId": "r1", "name": "旧用例",
                        "caseGroup": "正向", "enabled": true, "position": 0,
                        "updatedAt": 100,
                        "data": {
                            "syncedAt": 100,
                            "request": {
                                "id": "copy-1", "method": "GET", "url": "{{base}}/x",
                                "__collection": { "id": "c1", "items": [{ "id": "r1" }] },
                            },
                        },
                    }],
                },
            }),
            None,
        )
        .unwrap();

    let snapshot = store.load().unwrap();
    let request = &snapshot["cases"][0]["request"];
    assert_eq!(request["id"], "copy-1");
    assert!(
        request.get("__collection").is_none(),
        "读取时剔除旧版 MCP 写入的整集合缓存"
    );

    let base = store.workspace_rev().unwrap().rev;
    let payload = store.workspace_delta(base - 1).unwrap();
    let entry = payload["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["item"]["id"] == "case-legacy")
        .expect("case row must appear in the delta");
    assert!(entry["item"]["request"].get("__collection").is_none());
    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn get_entity_reads_one_decrypted_row_with_derived_fields() {
    let directory = std::env::temp_dir().join(format!(
        "reqora-get-entity-{}",
        crate::logging::now_millis()
    ));
    let store = test_store(&directory);
    let mut row = delta_request_row("r-detail", "{{base}}/detail", 400);
    row["folderPath"] = json!("分组/子目录");
    row["data"]["auth"] = json!({ "type": "bearer", "token": "detail-secret" });
    store
        .save_rows_checked(&delta(json!([row])), None)
        .unwrap();

    let entity = store.get_entity("request", "r-detail").unwrap();
    assert_eq!(entity["id"], "r-detail");
    assert_eq!(entity["folder"], "分组/子目录");
    assert_eq!(entity["method"], "POST");
    assert_eq!(entity["auth"]["token"], "detail-secret");
    assert!(
        store.get_entity("request", "missing").is_err(),
        "不存在的实体必须报错而不是返回空壳"
    );
    let _ = fs::remove_dir_all(&directory);
}
