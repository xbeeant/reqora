import test from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_MAX_ROWS,
  matchesHistorySearch,
  mergeHistoryPage,
} from "../src/lib/historyPaging.ts";

const run = (id, overrides = {}) => ({
  id,
  kind: "api",
  at: 1_700_000_000_000,
  projectId: "p1",
  projectName: "项目一",
  subjectId: `s-${id}`,
  subjectName: id,
  name: `接口 ${id}`,
  method: "GET",
  url: "https://example.test/secret-path",
  ok: true,
  status: 200,
  timeMs: 12,
  size: 128,
  total: 1,
  passed: 1,
  failed: 0,
  skipped: 0,
  error: "",
  stepCount: 0,
  ...overrides,
});

test("merge appends a page and exposes the next cursor", () => {
  const first = mergeHistoryPage([], {
    items: [run("a"), run("b")],
    nextCursor: { at: 100, id: "b" },
  });
  assert.deepEqual(first.items.map((item) => item.id), ["a", "b"]);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.cursor, { at: 100, id: "b" });

  const second = mergeHistoryPage(first.items, {
    items: [run("c")],
    nextCursor: null,
  });
  assert.deepEqual(second.items.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(second.hasMore, false);
  assert.equal(second.cursor, null);
});

test("merge drops duplicate ids from a retried or overlapping page", () => {
  const merged = mergeHistoryPage([run("a"), run("b")], {
    items: [run("b"), run("c"), run("c")],
    nextCursor: null,
  });
  assert.deepEqual(merged.items.map((item) => item.id), ["a", "b", "c"]);
});

test("merge never keeps more rows than the retention ceiling", () => {
  const current = Array.from({ length: HISTORY_MAX_ROWS }, (_, i) => run(`old-${i}`));
  const merged = mergeHistoryPage(current, {
    items: [run("new")],
    nextCursor: null,
  });
  assert.equal(merged.items.length, HISTORY_MAX_ROWS);
  assert.equal(merged.items[0].id, "old-0");
});

test("a locally appended run respects the search term pushed to Rust", () => {
  const matched = run("hit", { name: "登录接口", url: "/auth" });
  const missed = run("miss", { name: "健康检查", url: "/health" });
  assert.equal(matchesHistorySearch(matched, "登录"), true);
  assert.equal(matchesHistorySearch(matched, "  AUTH "), true);
  assert.equal(matchesHistorySearch(missed, "登录"), false);
  assert.equal(matchesHistorySearch(missed, ""), true);
  assert.equal(
    matchesHistorySearch(run("err", { error: "upstream unavailable" }), "UPSTREAM"),
    true,
  );
});
