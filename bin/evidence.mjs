#!/usr/bin/env node
// `reqora.run.v1` evidence CLI — T1.2 / T1.3 / T1.4 / T1.5 entry point.
//
// Zero-invasive by design: the existing `bin/reqora.mjs` is NOT modified.
// `run` wraps it and consumes its existing `--json` report; `build` also
// accepts any JSON report (or a fixture) directly. One shared builder
// (`src/lib/runEvidence.ts`) is used by desktop, CLI and MCP alike.
//
// Gate semantics (--gate):
//   assertion failure / step exception / network error / evidence write
//   failure → exit 1. `skipped` is listed explicitly, never counted as pass.
//   Without --gate the command is informational and exits 0 on step failures,
//   leaving the existing CLI's exit behaviour completely untouched.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildEvidence, diffEvidence, explainFailure } from "../src/lib/runEvidence.ts";
import { buildHistory, failureFrequency, passRateTrend, queryHistory } from "../src/lib/runHistory.ts";
import {
  evidenceDirectory,
  listEvidence,
  loadBaseline,
  readEvidenceFile,
  writeEvidenceFile,
} from "./evidenceFs.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWN_VALUE_FLAGS = new Set([
  "--from", "--evidence", "--baseline", "--history-dir", "--engine",
  "--subject-kind", "--subject-id", "--subject-name", "--env-vars",
  "--run-id", "--started-at", "--limit", "--evidence-dir",
]);
const OWN_BOOL_FLAGS = new Set(["--gate", "--help", "-h"]);

const USAGE = `reqora evidence — 可携带的运行结果 reqora.run.v1

用法:
  node bin/evidence.mjs build  --from <report.json|-> --evidence <out.json> [选项]
  node bin/evidence.mjs run    <run-scenario|run-case|run-suite> "<名称>" [原 CLI 参数] --evidence <out.json> [--gate]
  node bin/evidence.mjs diff   --evidence <current.json> --baseline <baseline.json>
  node bin/evidence.mjs explain --evidence <run.json>
  node bin/evidence.mjs history [--evidence-dir <dir>] [--subject-id <id>] [--limit 20]

选项:
  --gate                 启用真门禁：断言失败 / 步骤异常 / 网络错误 / 证据写不出均 exit 1
  --baseline <file>      与上一次证据比对，输出新增失败 / 已修复 / 波动 / 契约漂移
  --history-dir <dir>    从该目录的历史证据做 flaky 归因（默认取 --evidence 所在目录）
  --engine <值>          sidecar | node-fetch | unknown，显式声明实际执行引擎
  --env <名称>           环境名称（仅名称入证据；值永不写入），同时透传给原 CLI
  --env-vars <a,b,c>     允许写入证据的变量名白名单（仅名称）
  --subject-*            覆盖 subject.kind / id / name
  --run-id / --started-at  固定运行标识与时间，便于复现与字节一致性测试
  REQORA_EVIDENCE_DIR    证据目录环境变量（history / MCP 工具共用）

示例:
  node bin/evidence.mjs run run-scenario "下单链路" --env staging \\
    --evidence ./artifacts/run.json --gate --baseline ./artifacts/baseline.json
  jq '.steps[] | select(.assertions[]?.ok == false)' artifacts/run.json
`;

function parse(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (OWN_VALUE_FLAGS.has(token)) {
      args[token] = argv[index + 1];
      index += 1;
    } else if (OWN_BOOL_FLAGS.has(token)) {
      args[token] = true;
    } else if (token.startsWith("--")) {
      // Passed through to bin/reqora.mjs; keep its value too.
      args[token] = argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")
        ? argv[index + 1]
        : true;
    } else {
      args._.push(token);
    }
  }
  return args;
}

function detectEngine(explicit) {
  if (explicit) {
    const value = ["sidecar", "node-fetch", "unknown"].includes(explicit) ? explicit : "unknown";
    return {
      transport: value,
      declared_by: "explicit",
      note: value === "unknown" ? "--engine 未给出可识别的值，按未知处理" : "由 --engine 显式声明",
    };
  }
  if (process.env.REQORA_ENGINE === "node") {
    return { transport: "node-fetch", declared_by: "environment", note: "REQORA_ENGINE=node 强制回落 Node fetch" };
  }
  const candidates = [
    process.env.REQORA_SEND_BIN,
    join(REPO_ROOT, "dist-engine", "reqora-send.exe"),
    join(REPO_ROOT, "dist-engine", "reqora-send"),
  ].filter(Boolean);
  if (candidates.some((file) => existsSync(file))) {
    return { transport: "sidecar", declared_by: "environment", note: "检测到 reqora-send sidecar" };
  }
  return {
    transport: "unknown",
    declared_by: "unspecified",
    note: "未检测到 sidecar 且未显式声明；请用 --engine 如实标注，不要假装两端一致",
  };
}

/** Tolerant normaliser: reqora.mjs writes its own --json shape; fixtures and
 * JUnit-converted reports may differ. Only structural fields are trusted. */
function rowsFromReport(report) {
  if (Array.isArray(report)) return report;
  if (!report || typeof report !== "object") throw new Error("报告根节点必须是对象或数组");
  for (const key of ["steps", "results", "rows", "items", "cases", "failingSteps"]) {
    if (Array.isArray(report[key])) return report[key];
  }
  const firstArray = Object.values(report).find((value) => Array.isArray(value));
  if (firstArray) return firstArray;
  throw new Error("报告里找不到步骤数组（steps / results / rows / items）");
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function subjectFromReport(report, args) {
  const record = asRecord(report);
  const nested = asRecord(record.subject);
  const kind = args["--subject-kind"] ?? nested.kind ?? "scenario";
  return {
    kind: ["case", "scenario", "suite"].includes(kind) ? kind : "scenario",
    id: String(args["--subject-id"] ?? nested.id ?? record.id ?? "unknown"),
    name: String(args["--subject-name"] ?? nested.name ?? record.name ?? args._[1] ?? "未命名运行"),
  };
}

function envFromReport(report, args) {
  const record = asRecord(report);
  const nested = asRecord(record.env);
  const declared =
    args["--env-vars"] !== undefined
      ? String(args["--env-vars"]).split(",").map((item) => item.trim())
      : Array.isArray(nested.variableNames)
        ? nested.variableNames
        : Array.isArray(nested.variables)
          ? nested.variables.filter((item) => typeof item === "string")
          : [];
  return {
    name: String(typeof args["--env"] === "string" ? args["--env"] : (nested.name ?? record.environment ?? "")),
    names: declared.filter((item) => typeof item === "string"),
  };
}

function readReport(from) {
  if (from === "-") return JSON.parse(readFileSync(0, "utf8"));
  const path = resolve(from);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`无法读取报告 ${path}：${error.message}`);
  }
}

function historyOf(args, evidencePath) {
  const dir = args["--history-dir"] ?? evidenceDirectory(dirname(evidencePath));
  try {
    return listEvidence(dir);
  } catch (error) {
    process.stderr.write(`历史证据目录不可读，本次跳过 flaky 归因：${error.message}\n`);
    return [];
  }
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message, extra = {}) {
  process.stderr.write(`GATE FAIL: ${message}\n`);
  print({ gate: "fail", reason: message, ...extra });
  process.exit(1);
}

function buildCommand(args) {
  const from = args["--from"] ?? "-";
  const evidencePath = args["--evidence"] ?? join(evidenceDirectory(), `run-${Date.now()}.json`);
  let rows;
  let report = {};
  try {
    report = readReport(from);
    rows = rowsFromReport(report);
  } catch (error) {
    // A missing / broken report is itself a hard failure (CLI crash, network
    // failure before the report was written). Still emit evidence describing it.
    rows = [{
      id: "cli-run",
      name: "命令行运行",
      ok: false,
      skipped: false,
      status: null,
      error: String(error.message),
    }];
    report = { name: args._[1] ?? "未命名运行", _reportError: String(error.message) };
  }

  const listed = historyOf(args, evidencePath);
  const history = listed.map((item) => item.evidence);
  let baseline = null;
  try {
    baseline = loadBaseline(args["--baseline"]);
  } catch (error) {
    if (args["--gate"]) fail(error.message);
    process.stderr.write(`${error.message}\n`);
  }

  const env = envFromReport(report, args);
  const evidence = buildEvidence({
    runId: args["--run-id"] ?? `run-${Date.now()}-${randomUUID().slice(0, 8)}`,
    startedAt: args["--started-at"] ?? new Date().toISOString(),
    engine: detectEngine(args["--engine"]),
    subject: subjectFromReport(report, args),
    envName: env.name,
    envVariableNames: env.names,
    steps: rows,
    baseline,
    history: [...history, ...(baseline ? [baseline] : [])],
  });

  try {
    writeEvidenceFile(evidencePath, evidence);
  } catch (error) {
    fail(error.message, { failure_class: "evidence-write", run_id: evidence.run_id });
  }

  const failures = evidence.steps
    .filter((step) => !step.skipped && !step.ok)
    .map((step) => ({
      sequence: step.sequence,
      step_id: step.id,
      name: step.name,
      failure_class: step.failure_class,
      error: step.error,
    }));
  const skipped = evidence.steps
    .filter((step) => step.skipped)
    .map((step) => ({ sequence: step.sequence, step_id: step.id, name: step.name, reason: step.skip_reason }));

  const result = {
    schema: evidence.schema,
    run_id: evidence.run_id,
    evidence: resolve(evidencePath),
    engine: evidence.engine,
    summary: evidence.summary,
    gateway: args["--gate"] ? "enabled" : "disabled",
    failures,
    // Explicit: skipped is never folded into "passed".
    skipped,
    baseline_diff: evidence.baseline_diff,
  };

  if (args["--gate"] && failures.length > 0) {
    const classes = [...new Set(failures.map((item) => item.failure_class))];
    print({ ...result, gate: "fail", failure_classes: classes });
    process.stderr.write(
      `GATE FAIL: ${failures.length} 个失败（${classes.join(" / ")}），${skipped.length} 个跳过（不计入通过）\n`,
    );
    process.exit(1);
  }
  print({ ...result, gate: "pass" });
  return 0;
}

function runCommand(args, rawArgv) {
  const sub = args._[0];
  const subject = args._[1];
  if (!["run-scenario", "run-case", "run-suite"].includes(sub)) {
    fail("run 需要一个子命令：run-scenario / run-case / run-suite");
  }
  if (!subject) fail(`run ${sub} 需要一个用例 / 场景 / 套件名称`);
  const commandIndex = rawArgv.indexOf(sub);
  const subjectIndex = commandIndex + 1;
  // Strip our own flags (and their values) before handing the rest to reqora.mjs.
  const pass = [];
  for (let index = 0; index < rawArgv.length; index += 1) {
    const token = rawArgv[index];
    if (index === commandIndex || index === subjectIndex) continue;
    if (token === "--json") {
      // Our wrapper owns the report path; never let a caller override it.
      if (rawArgv[index + 1] && !rawArgv[index + 1].startsWith("--")) index += 1;
      continue;
    }
    if (OWN_BOOL_FLAGS.has(token) || OWN_VALUE_FLAGS.has(token)) {
      if (OWN_VALUE_FLAGS.has(token)) index += 1;
      continue;
    }
    pass.push(token);
  }
  pass.unshift(sub, subject);
  const tmpReport = join(tmpdir(), `reqora-report-${randomUUID()}.json`);
  const child = spawnSync(
    process.execPath,
    [join(REPO_ROOT, "bin", "reqora.mjs"), ...pass, "--json", tmpReport],
    { cwd: REPO_ROOT, encoding: "utf8", env: process.env, timeout: 180_000 },
  );
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  const reportArgs = { ...args, "--from": tmpReport };
  const code = buildCommand(reportArgs);
  try {
    rmSync(tmpReport, { force: true });
  } catch {
    // temp cleanup is best-effort
  }
  return code;
}

function diffCommand(args) {
  const current = readEvidenceFile(args["--evidence"]);
  const baseline = loadBaseline(args["--baseline"]);
  if (!baseline) fail("diff 需要 --baseline <file>");
  print(diffEvidence(current, baseline));
  return 0;
}

function explainCommand(args) {
  const current = readEvidenceFile(args["--evidence"]);
  const explanation = explainFailure(current);
  process.stdout.write(`${explanation.message}\n`);
  print(explanation);
  return 0;
}

function historyCommand(args) {
  const listed = listEvidence(args["--evidence-dir"] ?? evidenceDirectory());
  const evidences = listed.map((item) => item.evidence);
  const history = buildHistory(listed);
  print({
    total: history.length,
    runs: queryHistory(history, {
      subjectId: args["--subject-id"],
      limit: Number(args["--limit"] ?? 20),
    }),
    pass_rate_trend: passRateTrend(history),
    failure_frequency: failureFrequency(evidences),
  });
  return 0;
}

function main() {
  const rawArgv = process.argv.slice(2);
  const command = rawArgv[0];
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  const args = parse(rawArgv.slice(1));
  switch (command) {
    case "build": return buildCommand(args, rawArgv);
    case "run": return runCommand(args, rawArgv);
    case "diff": return diffCommand(args);
    case "explain": return explainCommand(args);
    case "history": return historyCommand(args);
    default:
      process.stderr.write(`未知命令：${command}\n\n${USAGE}`);
      return 2;
  }
}

try {
  process.exitCode = main();
} catch (error) {
  fail(error?.message ?? String(error));
}
