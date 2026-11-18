import test from "node:test";
import assert from "node:assert/strict";
import {
  computeRepeatIterations,
  evaluateStepCondition,
  newWaitStep,
} from "../src/lib/scenario.ts";
import { normalizeScenario } from "../src/lib/defaults.ts";

test("computeRepeatIterations：未配置 = 单次无绑定", () => {
  assert.deepEqual(computeRepeatIterations(undefined, {}), [{ bindings: {}, label: "" }]);
  assert.deepEqual(computeRepeatIterations({}, {}), [{ bindings: {}, label: "" }]);
});

test("computeRepeatIterations：固定次数 + indexVar", () => {
  const iterations = computeRepeatIterations({ count: 3, indexVar: "i" }, {});
  assert.equal(iterations.length, 3);
  assert.deepEqual(iterations[0].bindings, { i: "0" });
  assert.deepEqual(iterations[2].bindings, { i: "2" });
  assert.match(iterations[1].label, /第 2\/3 次/);

  const noIndex = computeRepeatIterations({ count: 2 }, {});
  assert.deepEqual(noIndex[0].bindings, {});
});

test("computeRepeatIterations：count 无效或超上限抛错", () => {
  assert.throws(() => computeRepeatIterations({ count: 0 }, {}), /循环次数无效/);
  assert.throws(() => computeRepeatIterations({ count: 101 }, {}), /超过单步上限/);
});

test("computeRepeatIterations：遍历数组变量，元素类型感知", () => {
  const vars = { userIds: JSON.stringify([101, 102, 103]) };
  const iterations = computeRepeatIterations({ over: "userIds", itemVar: "uid", indexVar: "idx" }, vars);
  assert.equal(iterations.length, 3);
  assert.deepEqual(iterations[0].bindings, { uid: "101", idx: "0" });
  assert.equal(iterations[2].label, "userIds[2]");
});

test("computeRepeatIterations：对象元素序列化为 JSON 字符串，null → null", () => {
  const vars = { rows: JSON.stringify([{ id: 1 }, null, { id: 2 }]) };
  const iterations = computeRepeatIterations({ over: "rows", itemVar: "row" }, vars);
  assert.equal(iterations[0].bindings.row, '{"id":1}');
  assert.equal(iterations[1].bindings.row, "null");
});

test("computeRepeatIterations：变量缺失 / 非数组 / 超上限抛错", () => {
  assert.throws(() => computeRepeatIterations({ over: "missing" }, {}), /不存在/);
  assert.throws(
    () => computeRepeatIterations({ over: "text" }, { text: "not json" }),
    /不是合法 JSON/,
  );
  assert.throws(
    () => computeRepeatIterations({ over: "num" }, { num: "42" }),
    /不是数组/,
  );
  assert.throws(
    () => computeRepeatIterations({ over: "big" }, { big: JSON.stringify(new Array(101).fill(1)) }),
    /超过单步上限/,
  );
});

test("evaluateStepCondition：8 种运算符 + 未定义变量", () => {
  const vars = { status: "200", name: "alice", empty: "" };
  assert.equal(evaluateStepCondition({ varName: "status", op: "eq", value: "200" }, vars).met, true);
  assert.equal(evaluateStepCondition({ varName: "status", op: "eq", value: "404" }, vars).met, false);
  assert.equal(evaluateStepCondition({ varName: "status", op: "gt", value: "199" }, vars).met, true);
  assert.equal(evaluateStepCondition({ varName: "status", op: "gte", value: "200" }, vars).met, true);
  assert.equal(evaluateStepCondition({ varName: "status", op: "lt", value: "300" }, vars).met, true);
  assert.equal(evaluateStepCondition({ varName: "name", op: "contains", value: "lic" }, vars).met, true);
  assert.equal(evaluateStepCondition({ varName: "name", op: "ne", value: "bob" }, vars).met, true);
  // exists：有值且非空
  assert.equal(evaluateStepCondition({ varName: "name", op: "exists", value: "" }, vars).met, true);
  assert.equal(evaluateStepCondition({ varName: "empty", op: "exists", value: "" }, vars).met, false);
  assert.equal(evaluateStepCondition({ varName: "ghost", op: "exists", value: "" }, vars).met, false);
  // 未定义变量：比较一律不满足
  assert.equal(evaluateStepCondition({ varName: "ghost", op: "eq", value: "" }, vars).met, false);
});

test("newWaitStep：默认 1000ms 且可自定义", () => {
  assert.equal(newWaitStep().source.kind, "wait");
  assert.equal(newWaitStep(2500).source.ms, 2500);
});

test("normalizeScenarioStep：wait 源与 repeat / condition 归一", () => {
  const scenario = normalizeScenario({
    id: "s1",
    name: "编排",
    steps: [
      {
        id: "w1",
        name: "等一下",
        enabled: true,
        source: { kind: "wait", ms: 99999 },
        extracts: [],
        continueOnFailure: false,
      },
      {
        id: "r1",
        name: "循环步",
        enabled: true,
        source: { kind: "case", caseId: "c1" },
        extracts: [],
        continueOnFailure: false,
        repeat: { over: "list", itemVar: "it", count: 3, indexVar: "i" },
        condition: { varName: "flag", op: "bogus", value: "1" },
      },
      {
        id: "c1",
        name: "普通步",
        enabled: true,
        source: { kind: "case", caseId: "c2" },
        extracts: [],
        continueOnFailure: false,
      },
    ],
    createdAt: 0,
    updatedAt: 0,
  });

  const [waitStep, repeatStep, plain] = scenario.steps;
  // wait：毫秒 clamp 到 60000
  assert.equal(waitStep.source.kind, "wait");
  assert.equal(waitStep.source.ms, 60000);
  // repeat：over 优先，count 保留；condition：非法 op 归一为 eq
  assert.deepEqual(repeatStep.repeat, { count: 3, over: "list", itemVar: "it", indexVar: "i" });
  assert.equal(repeatStep.condition.op, "eq");
  // 无 repeat / condition 的步骤字段为 undefined
  assert.equal(plain.repeat, undefined);
  assert.equal(plain.condition, undefined);
});

test("normalizeScenarioStep：无效 wait / 空 repeat 归一清理", () => {
  const scenario = normalizeScenario({
    id: "s2",
    name: "清理",
    steps: [
      {
        id: "w2",
        name: "坏等待",
        enabled: true,
        source: { kind: "wait", ms: "abc" },
        extracts: [],
        continueOnFailure: false,
      },
      {
        id: "r2",
        name: "空循环",
        enabled: true,
        source: { kind: "case", caseId: "c3" },
        extracts: [],
        continueOnFailure: false,
        repeat: { itemVar: "x" },
        condition: { varName: "  ", op: "eq", value: "" },
      },
    ],
    createdAt: 0,
    updatedAt: 0,
  });
  assert.equal(scenario.steps[0].source.ms, 1000);
  assert.equal(scenario.steps[1].repeat, undefined);
  assert.equal(scenario.steps[1].condition, undefined);
});

// ---- P2-13：命名数据库连接解析 ----

import { resolveDbConnectionUrl } from "../src/lib/scenario.ts";

test("resolveDbConnectionUrl：优先命名连接，缺失时回退手填 URL", () => {
  const connections = [
    { id: "c1", url: "mysql://prod/db" },
    { id: "c2", url: "postgres://stage/db" },
  ];
  assert.equal(
    resolveDbConnectionUrl({ connectionId: "c2", url: "mysql://manual/db" }, connections),
    "postgres://stage/db",
  );
  // 连接被删除 → 回退手填
  assert.equal(
    resolveDbConnectionUrl({ connectionId: "gone", url: "mysql://manual/db" }, connections),
    "mysql://manual/db",
  );
  // 未引用连接 → 手填 URL
  assert.equal(resolveDbConnectionUrl({ url: "mysql://manual/db" }, connections), "mysql://manual/db");
});
