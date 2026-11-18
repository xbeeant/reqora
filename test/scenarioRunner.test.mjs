import assert from "node:assert/strict";
import test from "node:test";

import { runScenario, runSteps } from "../src/lib/scenarioRunner.ts";

// --------------------------------------------------------------- fixtures ----

function response(body = JSON.stringify({ id: 42 }), status = 200) {
  return {
    requestId: "x",
    status,
    statusText: "OK",
    ok: status < 400,
    timeMs: 5,
    size: body.length,
    url: "https://example.test",
    resolvedUrl: "https://example.test",
    missingVariables: [],
    headers: [{ name: "content-type", value: "application/json" }],
    body,
    bodyKind: "json",
    truncated: false,
  };
}

const caseItem = {
  id: "case-1",
  requestId: "req-1",
  name: "用例",
  group: "正向",
  enabled: true,
  request: {
    id: "case-req-1",
    name: "用例请求",
    method: "GET",
    url: "https://example.test/base",
    headers: [],
    query: [],
    body: { type: "none" },
    auth: { type: "none" },
    assertions: [],
  },
  syncedAt: 1,
  createdAt: 1,
  updatedAt: 1,
};

function step(overrides = {}) {
  return {
    id: overrides.id ?? "step",
    name: overrides.name ?? "步骤",
    enabled: overrides.enabled ?? true,
    source: overrides.source ?? { kind: "case", caseId: "case-1" },
    extracts: overrides.extracts ?? [],
    continueOnFailure: overrides.continueOnFailure ?? false,
    ...(overrides.condition ? { condition: overrides.condition } : {}),
    ...(overrides.repeat ? { repeat: overrides.repeat } : {}),
  };
}

/** Transport that records what it saw and always succeeds. */
function recorder(payload = { id: 7 }, { fail = false } = {}) {
  const calls = [];
  const transport = async (request, variables, ownerRequestId) => {
    calls.push({ url: request.url, variables: { ...variables }, ownerRequestId });
    if (fail) {
      return {
        response: null,
        timeMs: 1,
        error: "请求失败：ECONNREFUSED",
        tests: [],
        assertions: [],
      };
    }
    return {
      response: response(JSON.stringify(payload)),
      timeMs: 5,
      error: null,
      tests: [{ ok: true, name: "脚本断言" }],
      assertions: [],
    };
  };
  return { calls, transport };
}

// ------------------------------------------------------------------ tests ----

test("captureBody 按需带出响应体，超长响应体按上限截断", async () => {
  const body = JSON.stringify({ id: 7 });
  const transport = async () => ({ response: response(body), timeMs: 5, error: null, tests: [], assertions: [] });

  const plain = await runSteps([step()], { cases: [caseItem], transport });
  assert.equal(plain.steps[0].body, undefined, "默认不捕获，桌面端报告保持轻量");

  const captured = await runSteps([step()], { cases: [caseItem], transport, captureBody: true });
  assert.equal(captured.steps[0].body, body);
  assert.equal(captured.steps[0].bodyTruncated, false);

  const bigTransport = async () => ({
    response: response("x".repeat(20_000)),
    timeMs: 5,
    error: null,
    tests: [],
    assertions: [],
  });
  const big = await runSteps([step()], { cases: [caseItem], transport: bigTransport, captureBody: true });
  assert.equal(big.steps[0].body.length, 16_384);
  assert.equal(big.steps[0].bodyTruncated, true);
});

test("循环步骤聚合后仍保留最后一次响应体", async () => {
  let call = 0;
  const transport = async () => ({
    response: response(JSON.stringify({ n: ++call })),
    timeMs: 5,
    error: null,
    tests: [],
    assertions: [],
  });
  const run = await runSteps(
    [step({ id: "s1", repeat: { count: 2 } })],
    { cases: [caseItem], transport, captureBody: true },
  );
  assert.equal(run.steps[0].body, JSON.stringify({ n: 2 }));
});

test("停用的步骤记为跳过", async () => {
  const { calls, transport } = recorder();
  const run = await runSteps([step({ id: "s1", enabled: false })], { cases: [caseItem], transport });
  assert.equal(calls.length, 0);
  assert.equal(run.steps[0].skipped, true);
  assert.equal(run.summary.skipped, 1);
});

test("条件门不满足时跳过且不中断链路", async () => {
  const { calls, transport } = recorder();
  const run = await runSteps(
    [
      step({
        id: "s1",
        condition: { varName: "token", op: "exists", value: "" },
      }),
      step({ id: "s2", name: "第二" }),
    ],
    { cases: [caseItem], transport, baseVariables: {} },
  );
  assert.equal(calls.length, 1, "只有第二步真正发出请求");
  assert.equal(run.steps[0].skipped, true);
  assert.match(run.steps[0].note, /条件未满足/u);
  assert.equal(run.steps[1].ok, true);
});

test("循环按次数执行并把下标绑定到变量", async () => {
  const { calls, transport } = recorder();
  const run = await runSteps(
    [step({ id: "s1", repeat: { count: 3, indexVar: "i" } })],
    { cases: [caseItem], transport },
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => call.variables.i),
    ["0", "1", "2"],
  );
  assert.equal(run.steps[0].passed, 3);
  assert.match(run.steps[0].note, /循环执行 3 次/u);
});

test("遍历数组变量时每轮绑定元素", async () => {
  const { calls, transport } = recorder();
  const run = await runSteps(
    [step({ id: "s1", repeat: { over: "ids", itemVar: "uid" } })],
    {
      cases: [caseItem],
      transport,
      baseVariables: { ids: JSON.stringify(["a", "b"]) },
    },
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((call) => call.variables.uid),
    ["a", "b"],
  );
});

test("循环配置无效时该步失败并按策略中断", async () => {
  const { calls, transport } = recorder();
  const run = await runSteps(
    [step({ id: "s1", repeat: { over: "missing" } }), step({ id: "s2", name: "后续" })],
    { cases: [caseItem], transport },
  );
  assert.equal(calls.length, 0);
  assert.equal(run.steps[0].ok, false);
  assert.match(run.steps[0].error, /不存在/u);
  assert.equal(run.steps.length, 1, "失败后链路中断，后续步骤未产生结果");
  assert.equal(run.summary.failed, 1);
});

test("continueOnFailure 让链路继续", async () => {
  const { transport } = recorder({}, { fail: true });
  const run = await runSteps(
    [
      step({ id: "s1", continueOnFailure: true }),
      step({ id: "s2", name: "后续" }),
    ],
    { cases: [caseItem], transport },
  );
  assert.equal(run.steps.length, 2);
  assert.equal(run.steps[0].ok, false);
  assert.equal(run.steps[1].ok, false, "后续步骤仍然执行并同样失败");
});

test("等待步骤只睡眠不发请求", async () => {
  const { calls, transport } = recorder();
  const slept = [];
  const run = await runSteps([step({ id: "w", name: "等待", source: { kind: "wait", ms: 250 } })], {
    cases: [caseItem],
    transport,
    sleep: async (ms) => slept.push(ms),
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(slept, [250]);
  assert.equal(run.steps[0].ok, true);
  assert.equal(run.steps[0].timeMs, 250);
});

test("提取结果对后续步骤可见，脚本变量也会传递", async () => {
  const seen = [];
  const transport = async (request, variables) => {
    seen.push({ ...variables });
    return {
      response: response(JSON.stringify({ token: "abc" })),
      timeMs: 1,
      error: null,
      tests: [],
      assertions: [],
      activeVariables: { ...variables, fromScript: "yes" },
    };
  };
  const run = await runSteps(
    [
      step({ id: "s1", extracts: [{ id: "e", varName: "token", source: "json", path: "$.token" }] }),
      step({ id: "s2", name: "第二步" }),
    ],
    { cases: [caseItem], transport },
  );
  assert.equal(seen.length, 2);
  assert.equal(seen[1].token, "abc", "上一步的提取值进入下一步变量表");
  assert.equal(seen[1].fromScript, "yes", "脚本 setVar 写入的变量也会传递");
  assert.equal(run.variables.token, "abc");
});

test("数据库步骤在进程外明确失败而不是静默通过", async () => {
  const { calls, transport } = recorder();
  const run = await runSteps(
    [
      step({
        id: "db",
        continueOnFailure: true,
        source: { kind: "db", db: { sql: "select 1", mode: "query", extracts: [], asserts: [] } },
      }),
    ],
    { cases: [caseItem], transport },
  );
  assert.equal(calls.length, 0);
  assert.equal(run.steps[0].ok, false);
  assert.match(run.steps[0].error, /桌面端/u);
});

test("数据集每行一轮执行，步骤名带轮次", async () => {
  const { calls, transport } = recorder();
  const scenario = {
    id: "scn",
    name: "数据驱动",
    steps: [step({ id: "s1", name: "下单" })],
    dataSet: { columns: ["sku"], rows: [{ sku: "A" }, { sku: "B" }] },
    createdAt: 1,
    updatedAt: 1,
  };
  const run = await runScenario(scenario, { cases: [caseItem], transport });
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((call) => call.variables.sku),
    ["A", "B"],
  );
  assert.equal(run.rounds.length, 2);
  assert.equal(run.steps.length, 2);
  assert.match(run.steps[0].name, /第 1\/2 轮/u);
  assert.equal(run.summary.total, 2);
});

test("步数上限阻止失控执行", async () => {
  const { calls, transport } = recorder();
  const run = await runSteps(
    [step({ id: "s1" }), step({ id: "s2" }), step({ id: "s3" })],
    { cases: [caseItem], transport, maxSteps: 2 },
  );
  assert.equal(calls.length, 2);
  assert.equal(run.steps.length, 3);
  assert.equal(run.steps[2].skipped, true);
  assert.match(run.steps[2].note, /上限/u);
});

test("断言失败计入 failed 并影响整体结论", async () => {
  const transport = async () => ({
    response: response("{}", 500),
    timeMs: 3,
    error: null,
    tests: [],
    assertions: [{ ok: false }],
  });
  const run = await runSteps([step({ id: "s1" })], { cases: [caseItem], transport });
  assert.equal(run.steps[0].ok, false);
  assert.equal(run.steps[0].failed, 1);
  assert.equal(run.ok, false);
});

test("没有数据库执行器时，数据库步骤明确失败而不是静默通过", async () => {
  const { transport } = recorder();
  const run = await runSteps(
    [step({ id: "db1", source: { kind: "db", db: { connectionId: "c", sql: "select 1" } } })],
    { cases: [caseItem], transport },
  );
  assert.equal(run.steps[0].ok, false);
  assert.equal(run.steps[0].failed, 1);
  assert.match(run.steps[0].error, /桌面端/u);
  assert.equal(run.ok, false);
});

test("注入 dbTransport 后数据库步骤参与编排并可提取变量", async () => {
  const seen = [];
  const run = await runSteps(
    [
      step({
        id: "db1",
        source: { kind: "db", db: { connectionId: "c", sql: "select id from t" } },
        extracts: [{ id: "e1", varName: "dbId", source: "json", path: "$.rows[0].id" }],
      }),
      step({ id: "s2" }),
    ],
    {
      cases: [caseItem],
      transport: async () => ({
        response: response("{}"),
        timeMs: 2,
        error: null,
        tests: [],
        assertions: [],
      }),
      dbTransport: async (dbStep, variables) => {
        seen.push({ stepId: dbStep.id, variables: { ...variables } });
        return {
          ok: true,
          timeMs: 3,
          passed: 1,
          failed: 0,
          extracted: { dbId: "42" },
        };
      },
    },
  );
  assert.deepEqual(seen, [{ stepId: "db1", variables: {} }]);
  assert.equal(run.steps[0].ok, true);
  assert.equal(run.steps[0].passed, 1);
  assert.equal(run.steps[0].extracted.dbId, "42");
  assert.equal(run.variables.dbId, "42");
  assert.equal(run.ok, true);
});

test("数据行多轮可把轮次标签写到 note 上（桌面端形态）", async () => {
  const { transport } = recorder();
  const run = await runScenario(
    {
      id: "sc",
      name: "多轮",
      steps: [step({ id: "s1", name: "提交订单" })],
      dataSet: { columns: ["id"], rows: [{ id: "1" }, { id: "2" }] },
    },
    { cases: [caseItem], transport, roundLabelTarget: "note" },
  );
  assert.equal(run.steps.length, 2);
  assert.equal(run.steps[0].name, "提交订单");
  assert.match(run.steps[0].note, /第 1\/2 轮/u);
});
