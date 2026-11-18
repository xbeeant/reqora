/**
 * rowProtocol 引用短路 + dirty 收集 + 辅助表差分的纯逻辑测试。
 *
 * 背景：commit() 曾经对每个实体做两次 stableStringify 比较（O(全库字节数)/次
 * 编辑）。改造后未变实体靠引用相等短路跳过，同时把变更行收集成 dirty 列表，
 * 供行级增量保存（save_workspace_rows）使用。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { deltaRowsFromDirty, stampSharedChanges } from "../src/store/workspace/rowProtocol.ts";
import { snapshotToRows } from "../src/lib/workspaceRows.ts";

const NOW = 1_700_000_000_000;

function request(overrides = {}) {
  return {
    id: "r1",
    name: "登录",
    method: "POST",
    url: "{{base}}/login",
    folder: "",
    protocol: "http",
    headers: [{ id: "h1", key: "X", value: "1", enabled: true }],
    body: { type: "json", content: '{"a":1}' },
    updatedAt: 100,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    version: 1,
    seeded: true,
    collections: [
      {
        id: "c1",
        name: "集合",
        items: [request()],
        updatedAt: 100,
      },
    ],
    environments: [],
    activeEnvironmentId: null,
    history: [],
    cases: [],
    scenarios: [],
    trash: [],
    settings: {},
    tombstones: [],
    ...overrides,
  };
}

test("unchanged entities short-circuit: no restamp, not dirty", () => {
  const prev = snapshot();
  const next = snapshot();
  const { stamped, dirty } = stampSharedChanges(prev, next);
  // 未变实体直接返回 next 侧原引用（短路），updatedAt 不会被刷新。
  assert.equal(stamped.collections[0], next.collections[0]);
  assert.equal(stamped.collections[0].items[0], next.collections[0].items[0]);
  assert.equal(stamped.collections[0].updatedAt, 100);
  assert.deepEqual(dirty, []);
});

test("content-only edit dirties exactly one request row", () => {
  const prev = snapshot();
  const edited = request({ url: "{{base}}/logout" });
  const next = snapshot({
    collections: [{ ...prev.collections[0], items: [edited] }],
  });
  const { stamped, dirty } = stampSharedChanges(prev, next);
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0].kind, "request");
  assert.equal(dirty[0].id, "r1");
  assert.equal(dirty[0].collectionId, "c1");
  assert.equal(dirty[0].position, 0);
  assert.equal(dirty[0].entity.url, "{{base}}/logout");
  assert.ok(
    (dirty[0].entity.contentUpdatedAt ?? 0) > 0,
    "content edit bumps contentUpdatedAt",
  );
  assert.equal(stamped.collections[0].items[0].contentUpdatedAt, dirty[0].entity.contentUpdatedAt);
});

test("rename / doc edits bump updatedAt but not contentUpdatedAt", () => {
  const prev = snapshot();
  const renamed = request({ name: "改名", doc: { summary: "x" } });
  const next = snapshot({
    collections: [{ ...prev.collections[0], items: [renamed] }],
  });
  const { dirty } = stampSharedChanges(prev, next);
  assert.equal(dirty.length, 1);
  assert.ok(dirty[0].entity.updatedAt > 0);
  assert.equal(
    dirty[0].entity.contentUpdatedAt,
    undefined,
    "metadata-only change must not mark interface content as changed",
  );
});

test("reorder dirties moved rows via placement change", () => {
  const a = request({ id: "r1", updatedAt: 1 });
  const b = request({ id: "r2", url: "{{base}}/b", updatedAt: 1 });
  const prev = snapshot({ collections: [{ id: "c1", name: "集合", items: [a, b], updatedAt: 1 }] });
  const next = snapshot({
    collections: [{ ...prev.collections[0], items: [b, a] }],
  });
  const { dirty } = stampSharedChanges(prev, next);
  const ids = dirty.filter((entry) => entry.kind === "request").map((entry) => entry.id);
  assert.deepEqual(ids.sort(), ["r1", "r2"], "both rows change position");
  for (const entry of dirty) {
    assert.equal(entry.entity.contentUpdatedAt, undefined, "move is not a content change");
  }
});

test("new entities are dirty with fresh timestamps", () => {
  const prev = snapshot();
  const added = request({ id: "r2", updatedAt: 0 });
  const next = snapshot({
    collections: [{ ...prev.collections[0], items: [request(), added] }],
  });
  const { dirty } = stampSharedChanges(prev, next);
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0].id, "r2");
  assert.ok(dirty[0].entity.updatedAt > 0);
  assert.ok(dirty[0].entity.contentUpdatedAt > 0);
});

test("deletions generate tombstones and dirty tombstone rows", () => {
  const prev = snapshot();
  const next = snapshot({ collections: [{ ...prev.collections[0], items: [] }] });
  const { stamped, dirty } = stampSharedChanges(prev, next);
  const tombstoneDirty = dirty.find((entry) => entry.entity === null);
  assert.ok(tombstoneDirty, "deletion must emit a dirty tombstone");
  assert.equal(tombstoneDirty.kind, "request");
  assert.equal(tombstoneDirty.id, "r1");
  assert.ok(tombstoneDirty.tombstone.updatedAt > 0);
  assert.equal(stamped.tombstones.length, 1);
  // 再次以带墓碑的快照为 prev 时不再重复生成（幂等）。
  const again = stampSharedChanges(stamped, stamped);
  assert.deepEqual(again.dirty, []);
});

test("case edits dirty only the case row", () => {
  const base = request();
  const caseItem = {
    id: "case-1",
    requestId: "r1",
    name: "空密码",
    group: "负向",
    enabled: true,
    request: base,
    syncedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const prev = snapshot({ cases: [caseItem] });
  const edited = { ...caseItem, name: "改名" };
  const next = snapshot({ cases: [edited] });
  const { dirty } = stampSharedChanges(prev, next);
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0].kind, "case");
  assert.equal(dirty[0].id, "case-1");
});

test("aux diff: appended history / trash rows and pruned revisions", () => {
  const prev = snapshot();
  const withHistory = snapshot({
    history: [
      { id: "h1", at: 5, kind: "request", request: request() },
      { id: "h2", at: 6, kind: "request", request: request() },
    ],
    trash: [{ id: "t1", deletedAt: 7, kind: "case", data: {} }],
    revisions: {
      r1: [
        { id: "rev1", at: 1, snapshot: request() },
        { id: "rev2", at: 2, snapshot: request() },
        { id: "rev3", at: 3, snapshot: request() },
      ],
    },
  });
  const first = stampSharedChanges(prev, withHistory);
  assert.deepEqual(
    first.aux.history.map((row) => row.id),
    ["h1", "h2"],
  );
  assert.deepEqual(
    first.aux.trash.map((row) => row.id),
    ["t1"],
  );
  assert.deepEqual(
    first.aux.revisions.map((row) => row.id),
    ["rev1", "rev2", "rev3"],
  );

  // 第二轮：追加一条历史并触发 200 上限外的裁剪 / 修订裁剪。
  const pruned = snapshot({
    history: [{ id: "h2", at: 6, kind: "request", request: request() }],
    trash: [{ id: "t1", deletedAt: 7, kind: "case", data: {} }],
    revisions: {
      r1: [
        { id: "rev2", at: 2, snapshot: request() },
        { id: "rev3", at: 3, snapshot: request() },
      ],
    },
  });
  const second = stampSharedChanges(withHistory, pruned);
  assert.deepEqual(second.aux.history, [], "kept rows are not re-uploaded");
  assert.deepEqual(second.aux.historyDeletes, ["h1"]);
  assert.deepEqual(second.aux.trashDeletes, []);
  assert.deepEqual(
    second.aux.revisionDeletes.map((key) => key.id),
    ["rev1"],
  );
});

test("delta rows are identical to snapshotToRows output for the same entities", () => {
  const entity = (overrides = {}) => ({
    id: "x1",
    name: "实体",
    updatedAt: 42,
    ...overrides,
  });
  const snapshot = {
    version: 1,
    seeded: true,
    collections: [
      {
        id: "c1",
        name: "集合",
        auth: { type: "bearer", token: "t" },
        folders: ["/分组"],
        items: [request({ id: "r1", folder: "/分组" })],
        updatedAt: 42,
      },
    ],
    environments: [entity({ id: "e1", variables: [] })],
    cases: [
      {
        id: "case1",
        requestId: "r1",
        name: "用例",
        group: "正向",
        enabled: true,
        request: request(),
        syncedAt: 1,
        createdAt: 1,
        updatedAt: 42,
      },
    ],
    scenarios: [entity({ id: "s1", steps: [] })],
    suites: [entity({ id: "suite1" })],
    docPages: [{ id: "d1", title: "文档", content: "# hi", updatedAt: 42 }],
    dataModels: [entity({ id: "dm1", schemaText: "{}" })],
    scriptLibrary: [entity({ id: "sc1", code: "x" })],
    codeTemplates: [entity({ id: "ct1", content: "y" })],
    history: [],
    trash: [],
    settings: {},
    tombstones: [],
  };
  const rows = snapshotToRows(snapshot);
  // 让每个实体都发生一次“引用不同但内容相同”的 stamp 不行 —— golden 测试的
  // 意图是校验转换函数本身，所以直接用“无 previous 的新实体”路径构造 dirty
  // 行，并与 snapshotToRows 的输出逐行比对（新增路径与既有行的差异只可能是
  // 时间戳，因此构造时带上相同 updatedAt）。
  const dirty = [
    { kind: "folder", id: "c1", entity: snapshot.collections[0], position: 0 },
    { kind: "request", id: "r1", entity: snapshot.collections[0].items[0], collectionId: "c1", position: 0 },
    { kind: "environment", id: "e1", entity: snapshot.environments[0], position: 0 },
    { kind: "case", id: "case1", entity: snapshot.cases[0] },
    { kind: "scenario", id: "s1", entity: snapshot.scenarios[0], position: 0 },
    { kind: "suite", id: "suite1", entity: snapshot.suites[0], position: 0 },
    { kind: "docPage", id: "d1", entity: snapshot.docPages[0], position: 0 },
    { kind: "dataModel", id: "dm1", entity: snapshot.dataModels[0], position: 0 },
    { kind: "scriptSnippet", id: "sc1", entity: snapshot.scriptLibrary[0], position: 0 },
    { kind: "codeTemplate", id: "ct1", entity: snapshot.codeTemplates[0], position: 0 },
  ];
  const deltaRows = deltaRowsFromDirty(dirty);
  for (const domain of ["folders", "requests", "environments", "cases", "scenarios", "suites", "artifacts"]) {
    const expected = JSON.stringify(rows[domain]);
    const actual = JSON.stringify(deltaRows[domain]);
    assert.equal(actual, expected, `domain ${domain} must match snapshotToRows`);
  }
});

test("suite / scenario deletions are single tombstone rows, not a full snapshot", () => {
  const prev = snapshot({
    suites: [{ id: "s1", name: "套件", items: [], updatedAt: 100 }],
    scenarios: [{ id: "sc1", name: "场景", steps: [], updatedAt: 100 }],
  });
  const next = snapshot({ suites: [], scenarios: [] });
  const { dirty } = stampSharedChanges(prev, next);
  const rows = deltaRowsFromDirty(dirty);
  assert.equal(rows.suites.length, 1);
  assert.equal(rows.suites[0].id, "s1");
  assert.equal(rows.suites[0].deleted, true);
  assert.equal(rows.scenarios.length, 1);
  assert.equal(rows.scenarios[0].deleted, true);
  // 载荷只含被删的两行，其余共享域不得出现。
  assert.deepEqual(Object.keys(rows).sort(), ["scenarios", "suites"]);
});

test("deltaRowsFromDirty routes tombstones into deleted rows", () => {
  const rows = deltaRowsFromDirty([
    { kind: "request", id: "r9", entity: null, tombstone: { kind: "request", id: "r9", updatedAt: 99 } },
  ]);
  assert.equal(rows.requests.length, 1);
  assert.equal(rows.requests[0].deleted, true);
  assert.equal(rows.requests[0].id, "r9");
  assert.equal(rows.requests[0].updatedAt, 99);
});
