import assert from "node:assert/strict";
import test from "node:test";

import {
  EVIDENCE_SCHEMA_ID,
  buildEvidence,
  diffableBytes,
  diffEvidence,
  explainFailure,
  safeFreeText,
  safeUrl,
  serializeEvidence,
  validateEvidence,
} from "../src/lib/runEvidence.ts";
import { createEvidenceCollector } from "../src/lib/evidenceCollector.ts";
import { runScenario } from "../src/lib/scenarioRunner.ts";
import {
  buildHistory,
  failureFrequency,
  passRateTrend,
  queryHistory,
} from "../src/lib/runHistory.ts";

// --------------------------------------------------------------- fixtures ----

const ENGINE = { transport: "node-fetch", declared_by: "explicit", note: "test" };
const SUBJECT = { kind: "scenario", id: "sc-1", name: "下单链路" };

function baseInput(steps, extra = {}) {
  return {
    runId: "run-1",
    startedAt: "2026-11-14T03:00:00.000Z",
    engine: ENGINE,
    subject: SUBJECT,
    envName: "staging",
    envVariableNames: ["BASE_URL", "API_TOKEN"],
    steps,
    ...extra,
  };
}

function step(id, overrides = {}) {
  return {
    stepId: id,
    name: `步骤 ${id}`,
    ok: true,
    skipped: false,
    status: 200,
    timeMs: 10,
    extracted: {},
    ...overrides,
  };
}

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

// -------------------------------------------------------------- T1.1 -----

test("T1.1 schema 字段齐全，序列化字节稳定且数组按 id 排序", () => {
  const evidence = buildEvidence(
    baseInput([
      step("s2", { body: '{"id":2}' }),
      step("s1", { body: '{"id":1}' }),
    ]),
  );
  assert.equal(evidence.schema, EVIDENCE_SCHEMA_ID);
  for (const key of ["schema", "run_id", "started_at", "engine", "subject", "env", "steps", "summary", "baseline_diff", "telemetry"]) {
    assert.ok(key in evidence, `缺少顶层字段 ${key}`);
  }
  assert.deepEqual(evidence.steps.map((item) => item.id), ["s1", "s2"]);
  assert.deepEqual(evidence.env.variables, ["API_TOKEN", "BASE_URL"]);
  assert.equal(serializeEvidence(evidence), serializeEvidence(evidence));
  const parsed = JSON.parse(serializeEvidence(evidence));
  assert.equal(validateEvidence(parsed).ok, true);
  assert.equal(validateEvidence({ schema: "reqora.run.v9" }).ok, false);
});

test("T1.1 时间不进 diff 区：同样输入、不同耗时仍字节一致", () => {
  const fast = buildEvidence(baseInput([step("s1", { timeMs: 5 })], { runId: "a", totalMs: 5 }));
  const slow = buildEvidence(
    baseInput([step("s1", { timeMs: 900 })], {
      runId: "b",
      startedAt: "2026-11-15T03:00:00.000Z",
      totalMs: 900,
    }),
  );
  assert.notEqual(serializeEvidence(fast), serializeEvidence(slow));
  assert.equal(diffableBytes(fast), diffableBytes(slow));
  assert.ok(!diffableBytes(fast).includes("timings"));
});

test("T1.1 fail-closed：响应体值 / query token / 环境变量值都不入证据", () => {
  const secret = "SUPERSECRETVALUE_1234567890_abcdefgh";
  const evidence = buildEvidence(
    baseInput([
      step("s1", {
        name: `下单 {{token}}`,
        url: `https://api.example.test/v1/orders?access_token=${secret}`,
        error: `Authorization: Bearer ${secret}`,
        body: JSON.stringify({ id: 42, accessToken: secret }),
        extracted: { orderId: secret },
      }),
    ]),
  );
  const text = serializeEvidence(evidence);
  assert.ok(!text.includes(secret), "私密值不得出现在证据里");
  assert.ok(!text.includes("access_token"), "URL query 不得进入证据");
  assert.ok(text.includes("{{token}}"), "模板占位符不能被误伤");
  // response_schema 只保留字段名与类型，值本身绝不写入。
  assert.ok(text.includes('"accessToken"'), "字段名属于结构，允许出现");
  assert.ok(text.includes('"type": "string"'));
  assert.equal(evidence.steps[0].url, "https://api.example.test/v1/orders");
  assert.deepEqual(evidence.steps[0].extracted, ["orderId"]);
  assert.equal(evidence.env.variables.length, 2);
  assert.ok(evidence.steps[0].response_schema);
  assert.equal(evidence.steps[0].response_schema.properties.id.type, "integer");
  assert.equal(safeUrl("https://u:p@example.test/p?x=1"), "https://example.test/p");
  assert.equal(safeFreeText("{{token}}"), "{{token}}");
});

test("T1.1 未知形态凭据也打码（不依赖已知正则）", () => {
  const weird = "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
  const text = safeFreeText(`x-custom-credential = ${weird}`);
  assert.ok(!text.includes(weird), "未知形态长串必须被 fail-closed 打码");
  assert.ok(text.includes("[REDACTED]"));
});

// -------------------------------------------------------------- T1.2 -----

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

function scenarioStep(id, overrides = {}) {
  return {
    id,
    name: `步骤 ${id}`,
    enabled: true,
    source: { kind: "case", caseId: "case-1" },
    extracts: [],
    continueOnFailure: true,
    ...overrides,
  };
}

test("T1.2 8 步场景：onStep collector 每步的计时 / 断言 / 提取 / 跳过原因齐全", async () => {
  const steps = Array.from({ length: 8 }, (_, index) =>
    scenarioStep(`s${index + 1}`, {
      extracts: [{ id: `e${index + 1}`, varName: `statusCode${index + 1}`, source: "status", path: "" }],
      ...(index === 7 ? { enabled: false } : {}),
    }),
  );
  const scenario = { id: "sc-1", name: "8 步场景", steps, createdAt: 1, updatedAt: 1 };
  const collector = createEvidenceCollector({
    runId: "run-8",
    startedAt: "2026-11-14T03:00:00.000Z",
    engine: ENGINE,
    subject: SUBJECT,
    envName: "staging",
    now: () => 1_000,
  });
  const transport = async () => ({
    response: {
      ...response(),
      timings: {
        dnsMs: 1, tcpMs: 2, tlsMs: 1, serverMs: 3, transferMs: 1,
        totalMs: 8, reused: false, protocol: "http/1.1", tlsMerged: false,
      },
    },
    timeMs: 8,
    error: null,
    tests: [{ ok: true, name: "脚本断言" }],
    assertions: [{ ok: true }],
  });
  await runScenario(scenario, {
    cases: [caseItem],
    transport,
    onStep: collector.onStep,
    captureBody: true,
  });
  assert.equal(collector.size, 8, "8 个步骤都应被采集");
  const evidence = collector.finish();
  assert.equal(evidence.steps.length, 8);
  for (const row of evidence.steps) {
    assert.equal(typeof row.timings.total_ms, "number", `${row.id} 缺少计时`);
    assert.ok(Array.isArray(row.assertions), `${row.id} 缺少断言数组`);
    assert.ok(Array.isArray(row.extracted), `${row.id} 缺少提取变量名`);
    assert.equal(typeof row.skip_reason === "string" || row.skip_reason === null, true);
  }
  const executed = evidence.steps.filter((row) => !row.skipped);
  assert.equal(executed.length, 7);
  assert.equal(executed[0].timings.dns_ms, 1);
  assert.equal(executed[0].timings.connect_ms, 3);
  assert.equal(executed[0].timings.wait_ms, 3);
  assert.equal(executed[0].assertions.length, 2, "脚本 test() 与声明式断言都要逐条保留");
  assert.deepEqual(executed[0].extracted, ["statusCode1"]);
  const skipped = evidence.steps.find((row) => row.skipped);
  assert.equal(skipped.skip_reason, "步骤已停用");
  assert.equal(skipped.assertions.length, 0, "跳过步骤不应合成失败断言");
});

// -------------------------------------------------------------- T1.4 -----

test("T1.4 baseline diff：新增失败 / 已修复 / 契约漂移", () => {
  const baseline = buildEvidence(
    baseInput([step("s1", { status: 200, body: '{"id":42,"name":"order"}' })], { runId: "base" }),
  );
  const current = buildEvidence(
    baseInput([
      step("s1", { status: 200, body: '{"id":"oops"}' }), // 类型变化 + 字段消失
      step("s2", {
        ok: false,
        assertions: [{ id: "a1", name: "含 orderId", ok: false, message: "响应缺少字段 orderId" }],
      }),
    ], { runId: "cur", baseline }),
  );
  const diff = current.baseline_diff;
  assert.ok(diff.added_failures.some((item) => item.key === "s2:a1"));
  const kinds = new Set(diff.contract_drift.map((item) => item.kind));
  assert.ok(kinds.has("type_changed"), "id 从 integer 变 string 应报类型变化");
  assert.ok(kinds.has("field_removed"), "name 字段消失应报字段消失");
  const failing = buildEvidence(baseInput([step("s1", { ok: false })], { runId: "failing" }));
  const recovered = buildEvidence(baseInput([step("s1")], { runId: "recovered", baseline: failing }));
  assert.ok(
    recovered.baseline_diff.fixed.some((item) => item.key === "s1"),
    "基线里的失败被修复应进 fixed",
  );
  assert.equal(diffEvidence(baseline, current).added_failures.length, 0);
});

test("T1.4 flaky：成败交替被标记，且不额外制造门禁失败", () => {
  const pass = buildEvidence(baseInput([step("s1")], { runId: "p1" }));
  const fail = buildEvidence(baseInput([step("s1", { ok: false })], { runId: "f1" }));
  const again = buildEvidence(baseInput([step("s1")], { runId: "p2", history: [pass, fail] }));
  assert.ok(again.baseline_diff.flaky.includes("s1"));
  assert.equal(again.summary.ok, true, "本次通过就是绿，历史波动只报告");
  const stable = buildEvidence(baseInput([step("s1")], { runId: "p3", history: [pass, pass] }));
  assert.deepEqual(stable.baseline_diff.flaky, []);
});

test("T1.4 explain_failure 指向具体步骤与断言", () => {
  const evidence = buildEvidence(
    baseInput([
      step("s1"),
      step("s2"),
      step("s3", {
        ok: false,
        assertions: [{ id: "a1", name: "含字段 Y", ok: false, message: "响应缺少字段 Y" }],
      }),
    ]),
  );
  const explanation = explainFailure(evidence);
  assert.equal(explanation.ok, false);
  assert.match(explanation.message, /第 3 步/);
  assert.match(explanation.message, /含字段 Y/);
  assert.equal(explanation.failing_steps[0].step_id, "s3");
});

// -------------------------------------------------------------- T1.5 -----

test("T1.5 run_history：20 次归档、按主体查询、通过率趋势与失败频次", () => {
  const runs = Array.from({ length: 20 }, (_, index) => {
    const evidence = buildEvidence(
      baseInput([step("s1", { ok: index % 2 === 0 })], {
        runId: `run-${index}`,
        startedAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
      }),
    );
    return { evidence, path: `artifacts/run-${index}.json` };
  });
  const history = buildHistory(runs);
  assert.equal(history.length, 20);
  const recent = queryHistory(history, { subjectId: "sc-1", limit: 5 });
  assert.equal(recent.length, 5);
  assert.equal(recent[0].run_id, "run-19");
  assert.equal(recent[0].evidence_path, "artifacts/run-19.json");
  assert.equal(passRateTrend(history).length, 20);
  assert.equal(failureFrequency(runs.map((item) => item.evidence))[0].count, 10);
  assert.equal(history[0].ok, true);
  assert.equal(history[1].ok, false);
});
