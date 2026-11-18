// 外部增量刷新（load_workspace_delta → mergeExternalDelta）的合并语义：
// 原位替换 / 新增插入 / 墓碑移除 / 集合元数据补丁保留 items /
// 位置或父级漂移时回退整份重载（返回 null）。
import assert from "node:assert/strict";
import test from "node:test";

import { mergeExternalDelta } from "../src/store/workspace/externalMerge.ts";

const snapshot = () => ({
  version: 1,
  seeded: true,
  collections: [
    { id: "col-1", name: "集合A", updatedAt: 1, items: [{ id: "req-1", name: "接口1" }] },
    { id: "col-2", name: "集合B", updatedAt: 1, items: [] },
  ],
  environments: [{ id: "env-1", name: "环境1" }],
  activeEnvironmentId: null,
  history: [],
  cases: [{ id: "case-1", name: "用例1", requestId: "req-1" }],
  scenarios: [],
  trash: [],
  settings: { timeoutSecs: 30, followRedirects: true, verifyTls: true },
});

test("活实体原位替换：未触及的域保持原引用", () => {
  const before = snapshot();
  const next = mergeExternalDelta(before, {
    rev: 5,
    entries: [{ domain: "cases", position: 0, item: { id: "case-1", name: "用例1-改" } }],
  });
  assert.ok(next);
  assert.equal(next.cases[0].name, "用例1-改");
  assert.equal(next.collections, before.collections, "未触及域引用不变");
  assert.equal(before.cases[0].name, "用例1", "原快照不被原地修改");
});

test("新实体按 position 插入；后续条目可依赖前一条的插入结果", () => {
  const next = mergeExternalDelta(snapshot(), {
    rev: 6,
    entries: [
      { domain: "cases", position: 0, item: { id: "case-new", name: "新用例" } },
      { domain: "cases", position: 1, item: { id: "case-1", name: "用例1" } },
    ],
  });
  assert.deepEqual(next.cases.map((row) => row.id), ["case-new", "case-1"]);
});

test("request 行写回 parentId 指向的集合，并保留其他集合", () => {
  const next = mergeExternalDelta(snapshot(), {
    rev: 7,
    entries: [
      {
        domain: "requests",
        position: 1,
        parentId: "col-1",
        item: { id: "req-2", name: "接口2" },
      },
    ],
  });
  assert.deepEqual(next.collections[0].items.map((row) => row.id), ["req-1", "req-2"]);
  assert.deepEqual(next.collections[1].items, []);
});

test("集合行只打元数据补丁，保留内存里的接口列表", () => {
  const next = mergeExternalDelta(snapshot(), {
    rev: 8,
    entries: [
      { domain: "collections", position: 0, item: { id: "col-1", name: "新名字", items: [] } },
    ],
  });
  assert.equal(next.collections[0].name, "新名字");
  assert.deepEqual(
    next.collections[0].items.map((row) => row.id),
    ["req-1"],
    "items 不能被空数组覆盖",
  );
});

test("墓碑同时移除活动实体并 upsert 到 tombstones", () => {
  const next = mergeExternalDelta(snapshot(), {
    rev: 9,
    entries: [
      {
        domain: "cases",
        deleted: true,
        tombstone: { kind: "case", id: "case-1", updatedAt: 900 },
      },
    ],
  });
  assert.deepEqual(next.cases, []);
  assert.deepEqual(next.tombstones, [{ kind: "case", id: "case-1", updatedAt: 900 }]);
});

test("请求墓碑从所属集合移除，但不改其他集合", () => {
  const next = mergeExternalDelta(snapshot(), {
    rev: 10,
    entries: [
      {
        domain: "requests",
        deleted: true,
        tombstone: { kind: "request", id: "req-1", updatedAt: 901 },
      },
    ],
  });
  assert.deepEqual(next.collections[0].items, []);
  assert.deepEqual(next.collections[1].items, []);
});

test("位置漂移 / 父集合缺失 / 未知域 / reset 均回退整份重载", () => {
  const base = snapshot();
  assert.equal(
    mergeExternalDelta(base, {
      rev: 11,
      entries: [{ domain: "cases", position: 3, item: { id: "case-1", name: "x" } }],
    }),
    null,
    "位置不一致",
  );
  assert.equal(
    mergeExternalDelta(base, {
      rev: 11,
      entries: [
        { domain: "requests", position: 0, parentId: "missing", item: { id: "req-x" } },
      ],
    }),
    null,
    "父集合缺失",
  );
  assert.equal(
    mergeExternalDelta(base, {
      rev: 11,
      entries: [{ domain: "mystery", position: 0, item: { id: "x" } }],
    }),
    null,
    "未知域",
  );
  assert.equal(
    mergeExternalDelta(base, { rev: 1, reset: true, entries: [] }),
    null,
    "版本倒退",
  );
});

test("空条目保持原快照引用", () => {
  const base = snapshot();
  assert.equal(mergeExternalDelta(base, { rev: 12, entries: [] }), base);
});

test("辅助表（history / trash / revisions / meta）变化时回退整份重载", () => {
  const base = snapshot();
  assert.equal(
    mergeExternalDelta(base, {
      rev: 13,
      auxChanged: true,
      auxTables: ["history"],
      entries: [],
    }),
    null,
    "auxChanged 必须整份重载，否则外部写入的历史会丢失",
  );
  // 只带条目、没有 auxChanged 的旧后端行为保持增量合并。
  const next = mergeExternalDelta(base, {
    rev: 14,
    entries: [{ domain: "cases", position: 0, item: { id: "case-1", name: "用例1-改" } }],
  });
  assert.equal(next.cases[0].name, "用例1-改");
});
