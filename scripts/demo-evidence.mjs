#!/usr/bin/env node
// T1.7 — one-command, offline, zero-account evidence demo.
//
//   node scripts/demo-evidence.mjs [--out <dir>]
//
// What it proves (five acceptance metrics for the evidence gate):
//   1. a real 8-step scenario runs through src/lib/scenarioRunner.ts and its
//      onStep collector, against a loopback HTTP server only — no external
//      request, no account, no backend;
//   2. the run produces a portable reqora.run.v1 evidence file;
//   3. --gate makes CI go red on an assertion failure (non-zero exit);
//   4. --baseline reports added failures + contract drift;
//   5. the same evidence is readable by jq and by the read-only MCP tools
//      (no --allow-write needed).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runScenario } from "../src/lib/scenarioRunner.ts";
import { createEvidenceCollector } from "../src/lib/evidenceCollector.ts";
import { createMcpServer } from "../bin/mcpServer.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "bin", "evidence.mjs");
const KEEP = process.argv.includes("--out");
const OUT = KEEP
  ? resolve(REPO_ROOT, process.argv[process.argv.indexOf("--out") + 1])
  : mkdtempSync(join(tmpdir(), "reqora-evidence-demo-"));
mkdirSync(OUT, { recursive: true });

const log = (...parts) => process.stdout.write(`${parts.join(" ")}\n`);
const line = (title) => log(`\n=== ${title} ===`);

function invoke(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, REQORA_EVIDENCE_DIR: OUT, ...env },
    timeout: 60_000,
  });
}

function listen(server) {
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => ok(server.address().port));
  });
}

const GOOD_BODY = (index) => JSON.stringify({ id: index, name: "order", orderId: `o-${index}` });
// Step 3 drifts: id changes type, name/orderId disappear.
const DRIFT_BODY = JSON.stringify({ id: "oops" });

const caseOf = (index, url) => ({
  id: `case-${index}`,
  requestId: `req-${index}`,
  name: `用例 ${index}`,
  group: "正向",
  enabled: true,
  request: {
    id: `case-req-${index}`,
    name: `请求 ${index}`,
    method: "GET",
    url,
    headers: [],
    query: [],
    body: { type: "none" },
    auth: { type: "none" },
    assertions: [],
  },
  syncedAt: 1,
  createdAt: 1,
  updatedAt: 1,
});

function stepOf(index) {
  return {
    id: `s${index}`,
    name: `下单链路 第 ${index} 步`,
    enabled: index !== 8,
    source: { kind: "case", caseId: `case-${index}` },
    extracts: [{ id: `e${index}`, varName: `statusCode${index}`, source: "status", path: "" }],
    continueOnFailure: true,
  };
}

let server = null;

async function main() {
  let externalAttempts = 0;
  let loopbackRequests = 0;
  let mode = "baseline";
  server = createServer((req, res) => {
    loopbackRequests += 1;
    const index = Number((req.url ?? "").split("/").pop()) || 1;
    const body = mode === "failing" && index === 3 ? DRIFT_BODY : GOOD_BODY(index);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}/step`;
  const cases = Array.from({ length: 8 }, (_, i) => caseOf(i + 1, `${baseUrl}/${i + 1}`));
  const scenario = {
    id: "sc-order-flow",
    name: "下单链路",
    steps: Array.from({ length: 8 }, (_, i) => stepOf(i + 1)),
    createdAt: 1,
    updatedAt: 1,
  };

  const transport = async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "127.0.0.1") {
      externalAttempts += 1;
      throw new Error(`demo 禁止外部请求：${url.origin}`);
    }
    const started = Date.now();
    const upstream = await fetch(url.href);
    const body = await upstream.text();
    const payload = JSON.parse(body);
    const idOk = Number.isInteger(payload.id);
    const orderIdOk = typeof payload.orderId === "string";
    return {
      response: {
        requestId: request.id,
        status: upstream.status,
        statusText: upstream.statusText,
        ok: upstream.ok,
        timeMs: Date.now() - started,
        size: body.length,
        url: url.href,
        resolvedUrl: url.href,
        missingVariables: [],
        headers: [{ name: "content-type", value: "application/json" }],
        body,
        bodyKind: "json",
        truncated: false,
        timings: {
          dnsMs: 0, tcpMs: 1, tlsMs: 0, serverMs: 1,
          transferMs: 1, totalMs: Date.now() - started,
          reused: false, protocol: "http/1.1", tlsMerged: false,
        },
      },
      timeMs: Date.now() - started,
      error: null,
      tests: [
        { ok: idOk, name: "id 是整数", message: idOk ? undefined : "响应缺少整数 id" },
        { ok: orderIdOk, name: "含 orderId", message: orderIdOk ? undefined : "响应缺少字段 orderId" },
      ],
      assertions: [],
    };
  };

  async function runOne(label, runId, startedAt) {
    const collector = createEvidenceCollector({
      runId,
      startedAt,
      engine: { transport: "node-fetch", declared_by: "explicit", note: "demo 使用本地 fetch，显式标注" },
      subject: { kind: "scenario", id: scenario.id, name: scenario.name },
      envName: "demo-local",
      envVariableNames: ["BASE_URL"],
    });
    const run = await runScenario(scenario, {
      cases,
      transport,
      onStep: collector.onStep,
      captureBody: true,
    });
    assert.equal(collector.size, 8, `${label}: 8 个步骤都必须进证据流`);
    const evidence = collector.finish();
    for (const step of evidence.steps) {
      assert.ok(step.timings && Array.isArray(step.assertions) && Array.isArray(step.extracted));
    }
    // Feed the *same* real step results to the CLI, so the evidence file is
    // produced by the production entry point, not by a demo-only shortcut.
    const reportFile = join(OUT, `${label}.report.json`);
    writeFileSync(reportFile, JSON.stringify({ name: scenario.name, steps: run.steps }));
    return { evidence, reportFile };
  }

  line("1/5 真实编排：8 步场景，仅访问 127.0.0.1");
  mode = "baseline";
  const baselineRun = await runOne("baseline", "demo-baseline", "2026-11-14T03:00:00.000Z");
  assert.equal(baselineRun.evidence.summary.ok, true);

  const baseBuild = invoke([
    "build", "--from", baselineRun.reportFile, "--evidence", join(OUT, "baseline.json"),
    "--gate", "--engine", "node-fetch", "--run-id", "demo-baseline",
    "--started-at", "2026-11-14T03:00:00.000Z", "--subject-id", scenario.id,
  ]);
  assert.equal(baseBuild.status, 0, `基线应通过：${baseBuild.stderr}`);
  log(`基线证据：${join(OUT, "baseline.json")}（exit 0）`);

  line("2/5 制造契约漂移：第 3 步响应删字段 / 改类型，CI 必须变红");
  mode = "failing";
  const failingRun = await runOne("failing", "demo-failing", "2026-11-14T03:01:00.000Z");
  assert.equal(failingRun.evidence.summary.ok, false);
  const gate = invoke([
    "build", "--from", failingRun.reportFile, "--evidence", join(OUT, "run.json"),
    "--gate", "--baseline", join(OUT, "baseline.json"),
    "--engine", "node-fetch", "--run-id", "demo-failing",
    "--started-at", "2026-11-14T03:01:00.000Z", "--subject-id", scenario.id,
  ]);
  assert.equal(gate.status, 1, "断言失败必须让 CI 真的红（非 0 退出）");
  const gateReport = JSON.parse(gate.stdout);
  assert.equal(gateReport.gate, "fail");
  assert.ok(gateReport.baseline_diff.added_failures.length > 0);
  const driftKinds = new Set(gateReport.baseline_diff.contract_drift.map((item) => item.kind));
  assert.ok(driftKinds.has("field_removed") || driftKinds.has("type_changed"));
  log(`门禁退出码 ${gate.status}；新增失败 ${gateReport.baseline_diff.added_failures.length} 条；契约漂移 ${[...driftKinds].join("/")}`);

  line("3/5 agent 读证据定位失败步骤（只读 MCP 工具，不开 --allow-write）");
  const mcp = createMcpServer({
    store: {
      path: OUT,
      projectId: "demo",
      projectName: "demo",
      kind: "json",
      readSnapshot: async () => ({}),
    },
    allowWrite: false,
  });
  const tools = mcp.listTools().map((tool) => tool.name);
  for (const name of ["reqora_list_runs", "reqora_get_evidence", "reqora_diff_runs", "reqora_explain_failure"]) {
    assert.ok(tools.includes(name), `${name} 必须在只读工具清单里`);
  }
  const explained = await mcp.callTool("reqora_explain_failure", { path: join(OUT, "run.json") });
  // createMcpServer.callTool returns the handler payload; the JSON-RPC layer
  // wraps it into { content: [...] } later (j()). Handle both shapes.
  const text = explained?.content?.[0]?.text ?? JSON.stringify(explained);
  assert.match(text, /第 3 步/);
  assert.match(text, /orderId|整数/);
  log("explain_failure → 第 3 步断言失败（响应缺少字段 orderId / id 类型变化）");

  line("4/5 没装 Reqora 的机器上用通用工具读全");
  const evidenceText = readFileSync(join(OUT, "run.json"), "utf8");
  const portable = JSON.parse(evidenceText);
  assert.equal(portable.schema, "reqora.run.v1");
  assert.ok(portable.steps.every((step) => Array.isArray(step.assertions)));
  log("jq '.steps[] | select(.assertions[]?.ok == false)' artifacts/run.json");
  log("jq '.baseline_diff | { added_failures, contract_drift }' artifacts/run.json");

  line("5/5 零外连核对");
  assert.equal(externalAttempts, 0, "demo 不得发起任何外部请求");
  assert.ok(loopbackRequests >= 14, `应有 8 步 × 2 轮以上的回环请求，实际 ${loopbackRequests}`);
  log(`回环请求 ${loopbackRequests} 次，外部请求 ${externalAttempts} 次，账号 0 个，后端 0 个`);

  const history = invoke(["history", "--evidence-dir", OUT, "--limit", "20"]);
  assert.equal(history.status, 0);
  log(`历史归档：${JSON.parse(history.stdout).total} 次运行`);
  log(`\n产物目录：${OUT}`);
  log("全部 5 项验收判据通过。");
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  process.stderr.write(`DEMO FAIL: ${error?.stack ?? error}\n`);
  exitCode = 1;
} finally {
  // Leave artifacts in place (temp or --out) so they can be inspected.
  server?.close?.();
}
process.exitCode = exitCode;
