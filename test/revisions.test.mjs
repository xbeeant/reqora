import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRevisions,
  pushRevision,
  requestFingerprint,
  revisionDiff,
  REVISION_CAP,
} from "../src/lib/revisions.ts";
import { emptyRequest, normalizeSnapshot } from "../src/lib/defaults.ts";

function draft(patch = {}) {
  return { ...emptyRequest(), ...patch };
}

test("requestFingerprint：内容字段变化才影响指纹，文档元数据不算", () => {
  const base = draft({ doc: { status: "已完成" } });
  const docChanged = { ...base, doc: { status: "已废弃" } };
  assert.equal(requestFingerprint(base), requestFingerprint(docChanged));

  const urlChanged = { ...base, url: "https://other.example.com" };
  assert.notEqual(requestFingerprint(base), requestFingerprint(urlChanged));
});

test("pushRevision：新在前、指纹相同跳过、截断到上限", () => {
  let revisions = {};
  const v1 = draft({ url: "https://a" });
  const v2 = draft({ url: "https://b" });
  const v3 = draft({ url: "https://c" });
  revisions = pushRevision(revisions, "r1", v1);
  revisions = pushRevision(revisions, "r1", v1); // 与最新一致 → 跳过
  assert.equal(revisions.r1.length, 1);
  revisions = pushRevision(revisions, "r1", v2);
  revisions = pushRevision(revisions, "r1", v3);
  assert.equal(revisions.r1.length, 3);
  assert.equal(revisions.r1[0].snapshot.url, "https://c");

  for (let index = 0; index < 30; index += 1) {
    revisions = pushRevision(revisions, "r1", draft({ url: `https://v${index}` }));
  }
  assert.equal(revisions.r1.length, REVISION_CAP);
});

test("revisionDiff：逐字段摘要，一致返回空", () => {
  const previous = draft({ method: "GET", url: "https://a", preScript: "" });
  const current = draft({
    method: "POST",
    url: "https://b",
    body: { type: "json", content: "{}" },
    preScript: "setVar('x','1')",
    assertions: [{ id: "1", enabled: true, name: "s", source: "status", path: "$", op: "eq", value: "200" }],
  });
  const changes = revisionDiff(current, previous);
  assert.ok(changes.some((line) => line.includes("方法 GET → POST")));
  assert.ok(changes.some((line) => line.includes("URL")));
  assert.ok(changes.some((line) => line.includes("请求体")));
  assert.ok(changes.some((line) => line.includes("前置脚本")));
  assert.ok(changes.some((line) => line.includes("断言 0 → 1")));

  assert.deepEqual(revisionDiff(previous, previous), []);
});

test("normalizeRevisions：非法条目过滤、截断", () => {
  const revisions = normalizeRevisions({
    r1: [
      { id: "a", at: 1, snapshot: draft() },
      null,
      { id: "b", at: 2, snapshot: "not-a-request" },
      { at: 3, snapshot: draft() },
    ].slice(0, 2),
    broken: "nope",
  });
  assert.equal(revisions.r1.length, 1);
  assert.equal(revisions.r1[0].id, "a");
  assert.equal(revisions.broken, undefined);
  assert.deepEqual(normalizeRevisions(undefined), {});
});

test("normalizeSnapshot：revisions 字段随快照往返", () => {
  const snapshot = normalizeSnapshot({
    version: 1,
    seeded: true,
    collections: [],
    environments: [],
    activeEnvironmentId: null,
    history: [],
    cases: [],
    scenarios: [],
    trash: [],
    settings: {},
    revisions: { r1: [{ id: "x", at: 5, snapshot: draft() }] },
  });
  assert.equal(snapshot.revisions.r1.length, 1);
  assert.equal(snapshot.revisions.r1[0].at, 5);
});
