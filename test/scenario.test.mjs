import test from "node:test";
import assert from "node:assert/strict";
import {
  moveStep,
  newScenario,
  resolveStepRequest,
  runExtracts,
  stepFromCase,
  stepFromRequest,
  summarizeScenario,
} from "../src/lib/scenario.ts";
import { normalizeScenario, normalizeSnapshot } from "../src/lib/defaults.ts";

const baseRequest = {
  id: "req-1",
  name: "请求",
  method: "POST",
  url: "https://api.example.com/post",
  headers: [],
  query: [],
  body: { type: "none" },
  auth: { type: "none" },
};

const makeCase = (id, name = "用例") => ({
  id,
  requestId: "req-1",
  name,
  group: "正向",
  description: "",
  enabled: true,
  request: { ...baseRequest, id: `req-${id}` },
  syncedAt: 1,
  createdAt: 1,
  updatedAt: 1,
});

const response = {
  requestId: "r",
  status: 200,
  statusText: "OK",
  ok: true,
  timeMs: 10,
  size: 10,
  url: "",
  resolvedUrl: "",
  missingVariables: [],
  headers: [{ name: "X-Trace-Id", value: "trace-9" }],
  body: '{"json":{"hello":"world"},"n":42}',
  bodyKind: "json",
  truncated: false,
};

test("stepFromCase 引用用例，resolveStepRequest 能解析与悬空", () => {
  const caseItem = makeCase("c1");
  const step = stepFromCase(caseItem);
  assert.equal(step.source.kind, "case");
  assert.equal(resolveStepRequest(step, [caseItem])?.url, baseRequest.url);
  assert.equal(resolveStepRequest(step, []), null);
});

test("stepFromRequest 深拷贝内联请求", () => {
  const request = { ...baseRequest, name: "内联" };
  const step = stepFromRequest(request);
  assert.equal(step.source.kind, "inline");
  step.source.request.url = "https://changed.example.com";
  assert.equal(request.url, baseRequest.url);
});

test("moveStep 上移/下移与越界保护", () => {
  const steps = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(moveStep(steps, "b", -1).map((s) => s.id), ["b", "a", "c"]);
  assert.deepEqual(moveStep(steps, "a", -1).map((s) => s.id), ["a", "b", "c"]);
  assert.deepEqual(moveStep(steps, "c", 1).map((s) => s.id), ["a", "b", "c"]);
  assert.equal(moveStep(steps, "zzz", 1), steps);
});

test("runExtracts 支持 json / header / status 三种来源", () => {
  const { extracted } = runExtracts(
    [
      { id: "1", varName: "greeting", source: "json", path: "$.json.hello" },
      { id: "2", varName: "trace", source: "header", path: "x-trace-id" },
      { id: "3", varName: "code", source: "status", path: "" },
    ],
    response,
  );
  assert.deepEqual(extracted, { greeting: "world", trace: "trace-9", code: "200" });
});

test("runExtracts 找不到值或响应非法 JSON 时报错", () => {
  const missing = runExtracts(
    [{ id: "1", varName: "x", source: "json", path: "$.nope" }],
    response,
  );
  assert.ok(missing.error?.includes("找不到"));
  const bad = runExtracts(
    [{ id: "1", varName: "x", source: "json", path: "$.a" }],
    { ...response, body: "{nope" },
  );
  assert.ok(bad.error?.includes("合法 JSON"));
  const okNoExtracts = runExtracts([], null);
  assert.deepEqual(okNoExtracts.extracted, {});
});

test("summarizeScenario 统计通过/失败/跳过（含未执行步骤）", () => {
  const summary = summarizeScenario(
    [
      { stepId: "1", name: "a", status: 200, ok: true, skipped: false, timeMs: 5, passed: 2, failed: 0, extracted: {} },
      { stepId: "2", name: "b", status: 500, ok: false, skipped: false, timeMs: 5, passed: 0, failed: 2, extracted: {} },
      { stepId: "3", name: "c", status: null, ok: false, skipped: true, timeMs: 0, passed: 0, failed: 0, extracted: {} },
    ],
    5,
    30,
  );
  assert.equal(summary.total, 5);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 3);
  assert.equal(summary.timeMs, 30);
});

test("normalizeScenario 持久化往返：inline 请求归一化、extracts 补 id", () => {
  const scenario = newScenario("s1");
  scenario.steps = [stepFromRequest(baseRequest)];
  scenario.steps[0].extracts = [{ id: "", varName: "v", source: "json", path: "$.a" }];
  const round = normalizeScenario(JSON.parse(JSON.stringify(scenario)));
  assert.equal(round.steps[0].source.kind, "inline");
  assert.ok(round.steps[0].extracts[0].id.length > 0);
  assert.equal(round.steps[0].extracts[0].source, "json");
});

test("normalizeSnapshot 兼容缺失的 scenarios 字段", () => {
  const raw = { version: 1, seeded: true, collections: [], environments: [], activeEnvironmentId: null, history: [], cases: [], settings: {} };
  const snapshot = normalizeSnapshot(raw);
  assert.deepEqual(snapshot.scenarios, []);
});
