/**
 * Pure-logic tests for the unified execution-history builders.
 *
 * The builders produce the plaintext record that Rust seals as a single
 * AES-256-GCM envelope. These tests pin down the important contract: full
 * response information really is captured, and oversized bodies are bounded
 * and reported instead of silently dropped.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  HISTORY_BODY_LIMIT,
  HISTORY_RAW_LIMIT,
  buildScenarioRunRecord,
  buildSingleRunRecord,
  buildHistoryStep,
  buildBenchmarkRunRecord,
} from "../src/lib/historyRecord.ts";

const context = { id: "run-fixed", at: 1_700_000_000_000, projectId: "p1", projectName: "本地项目" };

const request = {
  id: "req-1",
  name: "登录接口",
  method: "POST",
  url: "https://example.test/login",
  headers: [{ key: "Authorization", value: "Bearer SECRET", enabled: true }],
  query: [],
  body: { kind: "raw", text: "{\"user\":\"alice\"}" },
  auth: { type: "none" },
  preScript: "",
  postScript: "",
};

const response = {
  requestId: "http-1",
  status: 200,
  statusText: "OK",
  ok: true,
  timeMs: 42,
  size: 512,
  url: "https://example.test/login",
  resolvedUrl: "https://example.test/login",
  missingVariables: [],
  headers: [{ key: "Content-Type", value: "application/json" }],
  body: "{\"token\":\"SECRET\"}",
  bodyKind: "json",
  truncated: false,
  timings: { dnsMs: 1, tcpMs: 2, tlsMs: 3, serverMs: 20, transferMs: 5, totalMs: 42 },
  rawRequest: "POST /login HTTP/1.1",
  rawResponse: "HTTP/1.1 200 OK",
};

const outcome = {
  logs: ["pre ok", "post ok"],
  tests: [{ name: "status", ok: true, message: "", origin: "script" }],
  mutations: [],
  assertions: [{ name: "token", ok: false, message: "missing", origin: "assertion", source: "json", path: "$.token", op: "exists", expected: "", actual: "" }],
  error: null,
  durationMs: 3,
  preError: null,
};

test("single run keeps the whole response: status, headers, body, timings, raw wire", () => {
  const record = buildSingleRunRecord({
    context,
    kind: "api",
    subjectId: "req-1",
    subjectName: "登录接口",
    name: "登录接口",
    request,
    response,
    outcome,
    error: null,
    startedAt: context.at - 42,
    ok: true,
  });

  assert.equal(record.id, "run-fixed");
  assert.equal(record.kind, "api");
  assert.equal(record.projectId, "p1");
  assert.equal(record.status, 200);
  assert.equal(record.size, 512);
  assert.equal(record.timeMs, 42);
  assert.equal(record.response.headers[0].value, "application/json");
  assert.equal(record.response.body, "{\"token\":\"SECRET\"}");
  assert.equal(record.response.timings.serverMs, 20);
  assert.equal(record.response.rawRequest, "POST /login HTTP/1.1");
  assert.equal(record.outcome.logs.length, 2);
  assert.equal(record.outcome.assertions.length, 1);
  assert.equal(record.request.headers[0].value, "Bearer SECRET");
  assert.equal(record.passed, 1);
  assert.equal(record.failed, 1);
  assert.equal(record.total, 2);
  assert.deepEqual(record.truncated, []);
  assert.deepEqual(record.steps, []);
});

test("case runs reuse the case summary counters", () => {
  const summary = { at: context.at, status: 200, ok: true, timeMs: 42, passed: 3, failed: 0 };
  const record = buildSingleRunRecord({
    context,
    kind: "case",
    subjectId: "case-1",
    subjectName: "正向用例",
    name: "正向用例",
    request,
    response,
    outcome,
    error: null,
    startedAt: context.at,
    ok: true,
    summary,
  });
  assert.equal(record.kind, "case");
  assert.equal(record.passed, 3);
  assert.equal(record.failed, 0);
  assert.equal(record.total, 3);
  assert.deepEqual(record.summary, summary);
  assert.equal(record.ok, true);
});

test("failed sends still record the error and no response", () => {
  const record = buildSingleRunRecord({
    context,
    kind: "api",
    subjectId: "req-1",
    subjectName: "登录接口",
    name: "登录接口",
    request,
    response: null,
    outcome: null,
    error: "connection refused",
    startedAt: context.at - 10,
    ok: false,
  });
  assert.equal(record.status, null);
  assert.equal(record.error, "connection refused");
  assert.equal(record.ok, false);
  assert.equal(record.response, null);
  assert.equal(record.total, 0);
  assert.equal(record.request.url, "https://example.test/login");
});

test("oversized bodies and raw dumps are bounded and reported", () => {
  const huge = {
    ...response,
    body: "B".repeat(HISTORY_BODY_LIMIT + 100),
    rawResponse: "R".repeat(HISTORY_RAW_LIMIT + 100),
  };
  const record = buildSingleRunRecord({
    context,
    kind: "api",
    subjectId: "req-1",
    subjectName: "大响应",
    name: "大响应",
    request,
    response: huge,
    outcome,
    error: null,
    startedAt: context.at,
    ok: true,
  });
  assert.equal(record.response.body.length, HISTORY_BODY_LIMIT);
  assert.equal(record.response.rawResponse.length, HISTORY_RAW_LIMIT);
  assert.ok(record.truncated.some((line) => line.includes("response.body")));
  assert.ok(record.truncated.some((line) => line.includes("response.rawResponse")));
  // The caller's object is never mutated.
  assert.equal(huge.body.length, HISTORY_BODY_LIMIT + 100);
});

test("scenario aggregates counts and keeps one response per step", () => {
  const stepResult = {
    stepId: "step-1", name: "下单", status: 201, ok: true, skipped: false,
    timeMs: 30, passed: 1, failed: 0, extracted: {},
  };
  const step = buildHistoryStep({
    seq: 0,
    result: stepResult,
    captures: [{ request, response, outcome, timeMs: 30 }],
  });
  const summary = {
    at: context.at, total: 2, passed: 2, failed: 0, skipped: 0,
    timeMs: 60, steps: [stepResult],
  };
  const record = buildScenarioRunRecord({
    context,
    scenarioId: "scenario-1",
    scenarioName: "下单流程",
    summary,
    steps: [step],
    startedAt: context.at,
  });
  assert.equal(record.kind, "scenario");
  assert.equal(record.subjectId, "scenario-1");
  assert.equal(record.total, 2);
  assert.equal(record.passed, 2);
  assert.equal(record.failed, 0);
  assert.equal(record.size, 512);
  assert.equal(record.steps.length, 1);
  assert.equal(record.steps[0].response.body, "{\"token\":\"SECRET\"}");
  assert.equal(record.steps[0].outcome.tests.length, 1);
  assert.equal(record.ok, true);
});

const benchmarkReport = {
  total: 200,
  success: 195,
  failed: 5,
  timeMs: 4200,
  rps: 47.6,
  latency: { minMs: 2, avgMs: 18.5, p50Ms: 15, p90Ms: 30, p95Ms: 42, p99Ms: 88, maxMs: 120 },
  statuses: { "200": 195, "503": 5 },
  errors: ["upstream unavailable"],
  errorCount: 5,
};

const benchmarkInput = {
  context,
  subjectId: "req-1",
  subjectName: "登录接口",
  request,
  total: 200,
  concurrency: 8,
  startedAt: context.at - 4200,
};

test("benchmark runs keep the load parameters and full aggregate report", () => {
  const record = buildBenchmarkRunRecord({ ...benchmarkInput, report: benchmarkReport, error: null });
  assert.equal(record.kind, "benchmark");
  assert.equal(record.benchmark.total, 200);
  assert.equal(record.benchmark.concurrency, 8);
  assert.deepEqual(record.benchmark.report.statuses, { "200": 195, "503": 5 });
  assert.equal(record.benchmark.report.latency.p95Ms, 42);
  assert.equal(record.benchmark.report.rps, 47.6);
  assert.equal(record.benchmark.report.errors[0], "upstream unavailable");
  assert.equal(record.status, 200, "dominant non-zero status wins");
  assert.equal(record.timeMs, 4200);
  assert.equal(record.size, 0, "no per-response bytes survive aggregation");
  assert.equal(record.total, 200);
  assert.equal(record.passed, 195);
  assert.equal(record.failed, 5);
  assert.equal(record.ok, false);
  assert.equal(record.request.headers[0].value, "Bearer SECRET");
  assert.equal(record.response, null);
  assert.deepEqual(record.steps, []);
  assert.ok(record.name.includes("200×8"));
});

test("a failed benchmark IPC is still recorded with its error", () => {
  const record = buildBenchmarkRunRecord({ ...benchmarkInput, report: null, error: "benchmark_run failed" });
  assert.equal(record.kind, "benchmark");
  assert.equal(record.benchmark.report, null);
  assert.equal(record.error, "benchmark_run failed");
  assert.equal(record.ok, false);
  assert.equal(record.status, null);
  assert.equal(record.failed, 200);
  assert.equal(record.request.url, "https://example.test/login");
});

test("benchmark request snapshots are bounded like every other history record", () => {
  const huge = {
    ...request,
    body: { kind: "raw", text: "X".repeat(HISTORY_BODY_LIMIT + 100) },
  };
  const record = buildBenchmarkRunRecord({
    ...benchmarkInput,
    request: huge,
    report: benchmarkReport,
    error: null,
  });
  assert.equal(record.request.body.text.length, HISTORY_BODY_LIMIT);
  assert.ok(record.truncated.some((line) => line.includes("request.body.text")));
  assert.equal(huge.body.text.length, HISTORY_BODY_LIMIT + 100);
});

test("looped steps keep every iteration response", () => {
  const stepResult = {
    stepId: "step-2", name: "循环", status: 200, ok: true, skipped: false,
    timeMs: 20, passed: 2, failed: 0, extracted: {},
  };
  const capture = (body) => ({
    request,
    response: { ...response, body },
    outcome,
    timeMs: 10,
  });
  const step = buildHistoryStep({
    seq: 1,
    result: stepResult,
    captures: [capture("first"), capture("second")],
  });
  assert.equal(step.iterations.length, 2);
  assert.equal(step.iterations[0].response.body, "first");
  assert.equal(step.iterations[1].response.body, "second");
  assert.equal(step.response.body, "first");
});
