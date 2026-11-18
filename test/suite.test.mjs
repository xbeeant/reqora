import test from "node:test";
import assert from "node:assert/strict";
import { newSuite, suiteItem, suiteItemName, summarizeSuite } from "../src/lib/suite.ts";
import { normalizeSnapshot } from "../src/lib/defaults.ts";

test("newSuite：默认字段完整", () => {
  const suite = newSuite("回归套件");
  assert.equal(suite.name, "回归套件");
  assert.deepEqual(suite.items, []);
  assert.equal(typeof suite.createdAt, "number");
});

test("suiteItemName：用例 / 场景解析，缺失返回 null", () => {
  const cases = [{ id: "c1", name: "正常提交" }];
  const scenarios = [{ id: "s1", name: "回显链路" }];
  assert.equal(suiteItemName(suiteItem("case", "c1"), cases, scenarios), "正常提交");
  assert.equal(suiteItemName(suiteItem("scenario", "s1"), cases, scenarios), "回显链路");
  assert.equal(suiteItemName(suiteItem("case", "ghost"), cases, scenarios), null);
});

test("summarizeSuite：聚合通过 / 失败 / 跳过", () => {
  const items = [suiteItem("case", "c1"), suiteItem("scenario", "s1"), suiteItem("case", "c2")];
  const results = [
    { itemId: items[0].id, kind: "case", refId: "c1", name: "A", ok: true, skipped: false, passed: 3, failed: 0, timeMs: 10 },
    { itemId: items[1].id, kind: "scenario", refId: "s1", name: "B", ok: false, skipped: false, passed: 2, failed: 1, timeMs: 30, error: "断言失败" },
    null,
  ];
  const summary = summarizeSuite(items, results, 50);
  assert.equal(summary.total, 3);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.timeMs, 50);
  const skipped = summary.items.find((item) => item.skipped);
  assert.match(skipped.error ?? "", /未运行/);
  assert.equal(skipped.ok, false);
});

test("normalizeSnapshot：suites 归一（过滤非法成员、补 id）", () => {
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
    suites: [
      {
        id: "suite1",
        name: "回归",
        items: [
          { kind: "case", refId: "c1" },
          { kind: "bogus", refId: "x" },
          { id: "i3", kind: "scenario", refId: "s1" },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    settings: {},
  });
  assert.equal(snapshot.suites.length, 1);
  const items = snapshot.suites[0].items;
  assert.equal(items.length, 2);
  assert.ok(items[0].id);
  assert.equal(items[0].kind, "case");
  assert.equal(items[1].id, "i3");
});
