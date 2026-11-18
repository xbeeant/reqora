use super::*;

struct TempDb {
    dir: PathBuf,
}

impl TempDb {
    fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "reqora-history-test-{label}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        Self { dir }
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn record(id: &str, kind: &str, name: &str) -> Value {
    json!({
        "id": id,
        "kind": kind,
        "at": 1_700_000_000_000_i64,
        "projectId": "project-a",
        "projectName": "本地项目",
        "subjectId": format!("subject-{id}"),
        "subjectName": name,
        "name": name,
        "method": "POST",
        "url": "https://example.test/secret-path",
        "ok": true,
        "status": 200,
        "timeMs": 42,
        "size": 512,
        "total": 1,
        "passed": 1,
        "failed": 0,
        "skipped": 0,
        "response": {
            "status": 200,
            "headers": [{ "key": "Authorization", "value": "Bearer VERY_SECRET" }],
            "body": "{\"token\":\"VERY_SECRET\"}"
        },
        "steps": [{
            "seq": 0,
            "ok": true,
            "status": 200,
            "name": "步骤一",
            "response": { "body": "STEP_BODY_SECRET" }
        }]
    })
}

fn store(dir: &Path) -> HistoryStore {
    HistoryStore::new(dir, Vault::for_tests()).unwrap()
}

#[test]
fn payload_columns_are_ciphertext_and_round_trip() {
    let temp = TempDb::new("seal");
    let history = store(&temp.dir);
    let entry = history.append(&record("run-1", "api", "登录接口")).unwrap();
    assert_eq!(entry["name"].as_str(), Some("登录接口"));
    assert_eq!(entry["stepCount"].as_i64(), Some(1));

    let detail = history.get("run-1").unwrap();
    assert_eq!(
        detail["response"]["body"].as_str(),
        Some("{\"token\":\"VERY_SECRET\"}")
    );
    assert_eq!(
        detail["steps"][0]["response"]["body"].as_str(),
        Some("STEP_BODY_SECRET")
    );

    // Flush the WAL into the main file before inspecting raw bytes.
    history
        .lock()
        .unwrap()
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
    // A raw dump of the file must not contain any user data.
    let raw = fs::read(history.path()).unwrap();
    for secret in ["VERY_SECRET", "STEP_BODY_SECRET", "secret-path", "登录接口", "Bearer"] {
        let needle = secret.as_bytes();
        assert!(
            !raw.windows(needle.len()).any(|window| window == needle),
            "history.db leaked plaintext: {secret}"
        );
    }
    // ...but it does carry the frozen envelope prefix.
    assert!(String::from_utf8_lossy(&raw).contains("reqora.enc.v1."));
}

#[test]
fn list_filters_by_kind_project_and_encrypted_text() {
    let temp = TempDb::new("list");
    let history = store(&temp.dir);
    history.append(&record("run-1", "api", "登录接口")).unwrap();
    let mut case_record = record("run-2", "case", "正向用例");
    case_record["projectId"] = json!("project-b");
    history.append(&case_record).unwrap();
    history.append(&record("run-3", "scenario", "下单流程")).unwrap();

    let all = history.list(&ListQuery {
        scope: "all".into(),
        project_id: None,
        kind: None,
        search: None,
        limit: 50,
        cursor: None,
    }).unwrap();
    assert_eq!(all.len(), 3);

    let only_cases = history.list(&ListQuery {
        scope: "all".into(),
        project_id: None,
        kind: Some("case".into()),
        search: None,
        limit: 50,
        cursor: None,
    }).unwrap();
    assert_eq!(only_cases.len(), 1);
    assert_eq!(only_cases[0]["id"].as_str(), Some("run-2"));

    let project_a = history.list(&ListQuery {
        scope: "project".into(),
        project_id: Some("project-a".into()),
        kind: None,
        search: None,
        limit: 50,
        cursor: None,
    }).unwrap();
    assert_eq!(project_a.len(), 2);

    // name lives only inside the envelope, so this proves search happens
    // after decryption rather than in SQL.
    let found = history.list(&ListQuery {
        scope: "all".into(),
        project_id: None,
        kind: None,
        search: Some("下单".into()),
        limit: 50,
        cursor: None,
    }).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0]["id"].as_str(), Some("run-3"));
}

#[test]
fn delete_cascades_steps_and_clear_is_scoped() {
    let temp = TempDb::new("delete");
    let history = store(&temp.dir);
    history.append(&record("run-1", "api", "A")).unwrap();
    let mut other = record("run-2", "case", "B");
    other["projectId"] = json!("project-b");
    history.append(&other).unwrap();
    assert_eq!(history.stats().unwrap()["steps"].as_i64(), Some(2));

    history.delete("run-1").unwrap();
    assert!(history.get("run-1").is_err());
    assert_eq!(history.stats().unwrap()["steps"].as_i64(), Some(1));

    assert_eq!(history.clear("project", Some("project-b")).unwrap(), 1);
    assert_eq!(history.stats().unwrap()["runs"].as_i64(), Some(0));
}

#[test]
fn retention_trims_oldest_runs() {
    let temp = TempDb::new("trim");
    let history = store(&temp.dir);
    for index in 0..(MAX_RUNS + 3) {
        let mut entry = record(&format!("run-{index}"), "api", "接口");
        entry["at"] = json!(1_700_000_000_000_i64 + index as i64);
        entry["steps"] = json!([]);
        history.append(&entry).unwrap();
    }
    assert_eq!(history.stats().unwrap()["runs"].as_i64(), Some(MAX_RUNS as i64));
    assert!(history.get("run-0").is_err());
    assert!(history.get(&format!("run-{}", MAX_RUNS + 2)).is_ok());
}

#[test]
fn a_changed_master_key_is_reported_not_silently_ignored() {
    let temp = TempDb::new("key");
    let first = store(&temp.dir);
    first.append(&record("run-1", "api", "接口")).unwrap();
    drop(first);

    let second = HistoryStore::new(&temp.dir, Vault::for_tests_with_key(7)).unwrap();
    assert_eq!(second.stats().unwrap()["keyMismatch"].as_bool(), Some(true));
    let error = second.get("run-1").unwrap_err();
    assert!(format!("{error:?}").contains("主密钥"));

    let restored = store(&temp.dir);
    assert_eq!(restored.get("run-1").unwrap()["name"].as_str(), Some("接口"));
}

#[test]
fn key_mismatch_refuses_destructive_ops_but_keeps_diagnostics() {
    let temp = TempDb::new("key-destructive");
    let first = store(&temp.dir);
    first.append(&record("run-1", "api", "接口")).unwrap();
    first.append(&record("run-2", "api", "接口")).unwrap();
    drop(first);

    // Rotate the master key: old payloads are now undecryptable.
    let second = HistoryStore::new(&temp.dir, Vault::for_tests_with_key(7)).unwrap();

    // Destructive operations must not touch data the user could still recover.
    assert!(second.delete("run-1").is_err());
    assert!(second.clear("project", Some("project-a")).is_err());
    assert!(second.clear("all", None).is_err());

    // The diagnostic channel stays open so the UI can warn the user.
    let stats = second.stats().unwrap();
    assert_eq!(stats["keyMismatch"].as_bool(), Some(true));
    assert_eq!(stats["runs"].as_i64(), Some(2));

    // Restoring the key proves nothing was actually deleted.
    let restored = store(&temp.dir);
    assert!(restored.get("run-1").is_ok());
    assert!(restored.get("run-2").is_ok());
}

#[test]
fn rejects_untrusted_input_at_the_rust_boundary() {
    let temp = TempDb::new("validate");
    let history = store(&temp.dir);
    let mut bad_kind = record("run-1", "api", "接口");
    bad_kind["kind"] = json!("drop-table");
    assert!(history.append(&bad_kind).is_err());
    let mut huge = record("run-2", "api", "接口");
    huge["response"]["body"] = json!("x".repeat(MAX_RECORD_BYTES + 1));
    assert!(history.append(&huge).is_err());
    assert!(history.append(&json!({ "id": "x" })).is_err());
}

#[test]
fn benchmark_runs_round_trip_with_aggregate_metrics() {
    let temp = TempDb::new("benchmark");
    let history = store(&temp.dir);
    let mut entry = record("bench-1", "benchmark", "压测");
    entry["steps"] = json!([]);
    entry["benchmark"] = json!({
        "total": 200,
        "concurrency": 8,
        "report": {
            "total": 200,
            "success": 195,
            "failed": 5,
            "timeMs": 4200,
            "rps": 47.6,
            "latency": { "minMs": 2.0, "avgMs": 18.5, "p50Ms": 15.0,
                         "p90Ms": 30.0, "p95Ms": 42.0, "p99Ms": 88.0, "maxMs": 120.0 },
            "statuses": { "200": 195, "503": 5 },
            "errors": ["upstream unavailable"],
            "errorCount": 5
        }
    });
    let summary = history.append(&entry).unwrap();
    assert_eq!(summary["kind"].as_str(), Some("benchmark"));
    assert_eq!(summary["rps"].as_f64(), Some(47.6));
    assert_eq!(summary["p95Ms"].as_f64(), Some(42.0));

    let listed = history
        .list(&ListQuery {
            scope: "all".into(),
            project_id: None,
            kind: Some("benchmark".into()),
            search: None,
            limit: 50,
            cursor: None,
        })
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["rps"].as_f64(), Some(47.6));

    let detail = history.get("bench-1").unwrap();
    assert_eq!(detail["benchmark"]["report"]["statuses"]["200"], 195);
    assert_eq!(detail["benchmark"]["report"]["errors"][0], "upstream unavailable");
    // The aggregate payload is still sealed, not stored as plaintext.
    history
        .lock()
        .unwrap()
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
    let raw = fs::read(history.path()).unwrap();
    let needle: &[u8] = b"upstream unavailable";
    assert!(!raw.windows(needle.len()).any(|window| window == needle));
}

fn paged_query(limit: usize, cursor: Option<HistoryCursor>) -> ListQuery {
    ListQuery {
        scope: "all".into(),
        project_id: None,
        kind: None,
        search: None,
        limit,
        cursor,
    }
}

fn seed(history: &HistoryStore, count: usize, name: &dyn Fn(usize) -> String) {
    for index in 0..count {
        let mut entry = record(&format!("run-{index:02}"), "api", &name(index));
        entry["at"] = json!(1_700_000_000_000_i64 + index as i64);
        entry["steps"] = json!([]);
        history.append(&entry).unwrap();
    }
}

#[test]
fn keyset_pages_cover_every_run_once_in_order() {
    let temp = TempDb::new("page");
    let history = store(&temp.dir);
    seed(&history, 12, &|index| format!("接口-{index}"));

    let mut cursor = None;
    let mut seen = Vec::new();
    for _ in 0..12 {
        let page = history.page(&paged_query(5, cursor)).unwrap();
        assert!(page.items.len() <= 5);
        seen.extend(
            page.items
                .iter()
                .map(|item| item["id"].as_str().unwrap().to_string()),
        );
        cursor = page.next_cursor.clone();
        if cursor.is_none() {
            assert!(page.to_value()["nextCursor"].is_null());
            break;
        }
        assert!(page.to_value()["nextCursor"]["id"].is_string());
    }
    assert_eq!(seen.len(), 12);
    assert_eq!(seen.iter().collect::<std::collections::HashSet<_>>().len(), 12);
    assert_eq!(seen[0], "run-11");
    assert_eq!(seen[11], "run-00");
}

#[test]
fn search_pages_keep_matches_across_cursor_boundaries() {
    let temp = TempDb::new("search-page");
    let history = store(&temp.dir);
    seed(&history, 20, &|index| {
        if [1, 6, 11, 16].contains(&index) {
            "MATCH 关键接口".into()
        } else {
            format!("普通接口-{index}")
        }
    });

    let mut cursor = None;
    let mut seen = Vec::new();
    for _ in 0..12 {
        let page = history
            .page(&ListQuery {
                search: Some("match".into()),
                ..paged_query(2, cursor)
            })
            .unwrap();
        seen.extend(
            page.items
                .iter()
                .map(|item| item["id"].as_str().unwrap().to_string()),
        );
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(seen, vec!["run-16", "run-11", "run-06", "run-01"]);
}

#[test]
fn v1_rows_without_summary_are_backfilled_and_still_listable() {
    let temp = TempDb::new("v1");
    let history = store(&temp.dir);
    history.append(&record("run-1", "api", "旧版记录")).unwrap();
    history
        .lock()
        .unwrap()
        .execute("UPDATE history_runs SET summary_payload = NULL WHERE id = 'run-1'", [])
        .unwrap();

    let page = history.page(&paged_query(30, None)).unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0]["name"].as_str(), Some("旧版记录"));
    assert_eq!(page.items[0]["stepCount"].as_i64(), Some(1));

    let upgraded: Option<String> = history
        .lock()
        .unwrap()
        .query_row(
            "SELECT summary_payload FROM history_runs WHERE id = 'run-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(upgraded.is_some(), "v1 row should be upgraded on first read");
    assert!(upgraded.unwrap().starts_with("reqora.enc.v1."));
}

#[test]
fn list_pages_never_read_the_full_response_payload() {
    let temp = TempDb::new("small-summary");
    let history = store(&temp.dir);
    let mut entry = record("run-1", "api", "登录接口");
    entry["response"]["body"] = json!("SECRET_BODY ".repeat(20_000));
    history.append(&entry).unwrap();

    let page = history.page(&paged_query(1, None)).unwrap();
    assert_eq!(page.items[0]["name"].as_str(), Some("登录接口"));
    // The small envelope holds the name but not the response body.
    let small: String = history
        .lock()
        .unwrap()
        .query_row(
            "SELECT summary_payload FROM history_runs WHERE id = 'run-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(small.len() < 2_000);
    assert!(history
        .vault
        .open_text(&small)
        .unwrap()
        .contains("登录接口"));
    assert!(!history.vault.open_text(&small).unwrap().contains("SECRET_BODY"));
}
