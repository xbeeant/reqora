#!/usr/bin/env node
// Reqora CLI — run cases / scenarios / suites, and start the MCP server.
//
// Zero npm dependencies: Node 22+ native TS loading, native fetch. Reuses the
// same production modules the app runs (template substitution, declarative
// assertions, scenario orchestration) so CI results match the UI.
//
// Usage:
//   reqora list
//   reqora run-scenario <nameOrId> [--env <name>] [--data <csv>] [--junit out.xml] [--json out.json]
//   reqora run-case <nameOrId>     [--env <name>] [--junit out.xml] [--json out.json]
//   reqora run-suite <nameOrId>    [--env <name>] [--data <csv>] [--junit out.xml] [--json out.json]
//   reqora mcp [--allow-write] [--config]     # hand the project to an AI agent
//   reqora --help
//
// Workspace discovery: --workspace, $REQORA_WORKSPACE,
// or the project the desktop app currently has open.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseCsvDataset } from "../src/lib/scenario.ts";
import { runScenario, runSteps } from "../src/lib/scenarioRunner.ts";
import { EXPORT_FORMATS, renderExportAsync } from "../src/lib/exportFormats.ts";
import { createRequester } from "./requester.mjs";
import { evidenceDirectory } from "./evidenceFs.mjs";
import { WorkspaceStore } from "./workspaceStore.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------- context ----

async function loadContext(args) {
  const store = WorkspaceStore.open(args.workspace);
  const snapshot = await store.readSnapshot();
  if (args.scriptTimeout !== undefined) {
    const parsed = Number(args.scriptTimeout);
    snapshot.settings = {
      ...(snapshot.settings ?? {}),
      scriptTimeoutMs: Number.isFinite(parsed) && parsed > 0 ? Math.max(100, Math.min(60_000, parsed)) : undefined,
    };
  }
  const requester = createRequester(snapshot);
  const transport = async (request, variables, ownerRequestId) => {
    const result = await requester.send(request, variables, ownerRequestId);
    const scored = requester.outcome(request, result);
    return {
      response: result.response,
      timeMs: result.timeMs,
      error: result.error,
      preError: result.preError,
      tests: result.scripts?.post?.tests ?? [],
      assertions: scored.assertions ?? [],
      activeVariables: result.activeVariables,
      note: result.note,
    };
  };
  const environment = requester.pickEnvironment(args.env) ?? requester.pickEnvironment(snapshot.activeEnvironmentId);
  if (args.env && !requester.pickEnvironment(args.env)) {
    console.error(
      `找不到环境「${args.env}」。可用：${(snapshot.environments ?? []).map((item) => item.name).join(", ") || "（无）"}`,
    );
    process.exit(2);
  }
  return { store, snapshot, requester, transport, environment, variables: requester.baseVariables(args.env ?? undefined).variables };
}

function findOne(items, ref, label) {
  const pool = items ?? [];
  if (!ref) {
    console.error(`缺少${label}名称或 ID。用 reqora list 查看。`);
    process.exit(2);
  }
  const byId = pool.find((item) => item.id === ref);
  if (byId) return byId;
  const exact = pool.filter((item) => item.name === ref);
  if (exact.length === 1) return exact[0];
  const partial = pool.filter((item) => String(item.name).includes(ref));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    console.error(
      `「${ref}」匹配到多个${label}，请改用 ID：\n${partial
        .map((item) => `  [${item.id}] ${item.name}`)
        .join("\n")}`,
    );
    process.exit(2);
  }
  console.error(`找不到${label}「${ref}」。用 reqora list 查看。`);
  process.exit(2);
}

function readDatasetFile(args) {
  if (!args.data) return null;
  if (!existsSync(args.data)) {
    console.error(`找不到数据文件 ${args.data}`);
    process.exit(2);
  }
  const parsed = parseCsvDataset(readFileSync(args.data, "utf8"));
  if (parsed.rows.length === 0) {
    console.error(`数据文件无效：${parsed.error ?? "没有数据行"}`);
    process.exit(2);
  }
  return parsed.rows;
}

// ----------------------------------------------------------- reporting ----

function printRow(cells, widths) {
  console.log(cells.map((cell, index) => String(cell).padEnd(widths[index])).join("  "));
}

function report(title, rows) {
  const widths = [4, 34, 10, 12, 10];
  console.log(`\n${title}`);
  printRow(["#", "名称", "状态码", "断言", "耗时"], widths);
  for (const [index, row] of rows.entries()) {
    const name = row.skipped ? `${row.name}（跳过）` : row.name;
    printRow(
      [
        index + 1,
        name.length > 32 ? `${name.slice(0, 31)}…` : name,
        row.status ?? "ERR",
        row.skipped ? "—" : `${row.passed}✓${row.failed ? ` ${row.failed}✗` : ""}`,
        `${row.timeMs}ms`,
      ],
      widths,
    );
    if (row.error) console.log(`    ↳ ${row.error}`);
    if (row.note) console.log(`    ↳ ${row.note}`);
    for (const [key, value] of Object.entries(row.extracted ?? {})) {
      console.log(`    ↳ 提取 ${key}=${value}`);
    }
  }
  return rows.filter((row) => !row.ok && !row.skipped).length;
}

function junitXml(name, cases) {
  const esc = (text) =>
    String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const total = cases.length;
  const failures = cases.filter((item) => !item.ok && !item.skipped).length;
  const time = (cases.reduce((sum, item) => sum + (item.timeMs ?? 0), 0) / 1000).toFixed(3);
  const body = cases
    .map((item) => {
      const timeSec = ((item.timeMs ?? 0) / 1000).toFixed(3);
      if (item.skipped) {
        return `    <testcase name="${esc(item.name)}" classname="${esc(name)}" time="0"><skipped/></testcase>`;
      }
      if (item.ok) {
        return `    <testcase name="${esc(item.name)}" classname="${esc(name)}" time="${timeSec}"/>`;
      }
      return (
        `    <testcase name="${esc(item.name)}" classname="${esc(name)}" time="${timeSec}">\n` +
        `      <failure message="${esc(item.error ?? "断言失败")}">${esc(item.note ?? "")}</failure>\n` +
        `    </testcase>`
      );
    })
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${total}" failures="${failures}" time="${time}">\n` +
    `  <testsuite name="${esc(name)}" tests="${total}" failures="${failures}" time="${time}">\n${body}\n  </testsuite>\n</testsuites>\n`
  );
}

function writeReports(args, name, steps) {
  const payload = steps.map((row) => ({
    name: row.name,
    ok: row.ok,
    skipped: row.skipped,
    status: row.status,
    timeMs: row.timeMs,
    passed: row.passed,
    failed: row.failed,
    error: row.error,
    note: row.note,
    extracted: row.extracted,
  }));
  if (args.json) {
    writeFileSync(args.json, JSON.stringify({ name, cases: payload }, null, 2));
    console.log(`JSON 报告已写入 ${args.json}`);
  }
  if (args.junit) {
    writeFileSync(args.junit, junitXml(name, payload));
    console.log(`JUnit 报告已写入 ${args.junit}`);
  }
}

// ------------------------------------------------------------ commands ----

async function cmdList(args) {
  const { snapshot, store } = await loadContext(args);
  console.log(`工作区：${store.path}（${store.kind}${store.projectName ? ` · ${store.projectName}` : ""}）`);
  const collections = snapshot.collections ?? [];
  console.log(`\n接口（${collections.reduce((sum, item) => sum + item.items.length, 0)}）：`);
  for (const collection of collections) {
    console.log(`  ${collection.name}（${collection.items.length}）`);
    for (const request of collection.items) {
      console.log(`    ${request.method.padEnd(6)} ${request.name} — ${request.url}`);
    }
  }
  console.log(`\n测试场景（${snapshot.scenarios.length}）：`);
  for (const scenario of snapshot.scenarios) {
    console.log(`  [${scenario.id}] ${scenario.name} — ${scenario.steps.length} 步`);
  }
  console.log(`\n接口用例（${snapshot.cases.length}）：`);
  for (const caseItem of snapshot.cases) {
    console.log(`  [${caseItem.id}] ${caseItem.name}（${caseItem.group}）`);
  }
  if (snapshot.suites?.length) {
    console.log(`\n测试套件（${snapshot.suites.length}）：`);
    for (const suite of snapshot.suites) {
      console.log(`  [${suite.id}] ${suite.name} — ${suite.items.length} 项`);
    }
  }
  if (snapshot.environments.length) {
    console.log(`\n环境：${snapshot.environments.map((item) => item.name).join(", ")}`);
  }
  store.close();
}

async function cmdRunScenario(nameOrId, args) {
  const context = await loadContext(args);
  const scenario = findOne(context.snapshot.scenarios, nameOrId, "测试场景");
  const dataRows = readDatasetFile(args);
  const rounds = dataRows ?? (scenario.dataSet?.rows?.length ? scenario.dataSet.rows : [{}]);
  console.log(
    `运行场景「${scenario.name}」（${scenario.steps.length} 步）` +
      `${context.environment ? ` · 环境 ${context.environment.name}` : " · 无环境"}` +
      `${rounds.length > 1 ? ` · ${rounds.length} 轮` : ""}`,
  );

  const run = await runScenario(scenario, {
    cases: context.snapshot.cases,
    transport: context.transport,
    baseVariables: context.variables,
    dataRows,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  const failed = report("场景步骤", run.steps);
  console.log(
    `\n汇总：${run.summary.passed} 通过 / ${run.summary.failed} 失败 / ${run.summary.skipped} 跳过 · ${run.summary.timeMs}ms`,
  );
  writeReports(args, scenario.name, run.steps);
  context.store.close();
  process.exit(failed > 0 ? 1 : 0);
}

async function cmdRunCase(nameOrId, args) {
  const context = await loadContext(args);
  const caseItem = findOne(context.snapshot.cases, nameOrId, "用例");
  console.log(
    `运行用例「${caseItem.name}」${context.environment ? ` · 环境 ${context.environment.name}` : " · 无环境"}`,
  );
  const run = await runSteps(
    [
      {
        id: caseItem.id,
        name: caseItem.name,
        enabled: true,
        source: { kind: "case", caseId: caseItem.id },
        extracts: [],
        continueOnFailure: false,
      },
    ],
    { cases: context.snapshot.cases, transport: context.transport, baseVariables: context.variables },
  );
  // Case semantics: the status only counts when the case declares one.
  const step = run.steps[0];
  const ok =
    step.ok &&
    (caseItem.expectedStatus === undefined ? Boolean(step.status && step.status < 400) : step.status === caseItem.expectedStatus);
  const result = { ...step, ok };
  const failed = report("结果", [result]);
  writeReports(args, caseItem.name, [result]);
  context.store.close();
  process.exit(step.ok ? (failed > 0 ? 1 : 0) : 1);
}

async function cmdRunSuite(nameOrId, args) {
  const context = await loadContext(args);
  const suite = findOne(context.snapshot.suites ?? [], nameOrId, "测试套件");
  if (!suite.items.length) {
    console.error(`套件「${suite.name}」没有任何成员。`);
    process.exit(2);
  }
  const dataRows = readDatasetFile(args);
  console.log(
    `运行套件「${suite.name}」（${suite.items.length} 项）` +
      `${context.environment ? ` · 环境 ${context.environment.name}` : " · 无环境"}`,
  );

  const rows = [];
  let failed = 0;
  for (const member of suite.items) {
    if (member.kind === "case") {
      const caseItem = (context.snapshot.cases ?? []).find((item) => item.id === member.refId);
      if (!caseItem) {
        console.error(`✗ 用例 ${member.refId} 已删除，跳过`);
        failed += 1;
        continue;
      }
      const run = await runSteps(
        [
          {
            id: caseItem.id,
            name: `用例 · ${caseItem.name}`,
            enabled: true,
            source: { kind: "case", caseId: caseItem.id },
            extracts: [],
            continueOnFailure: false,
          },
        ],
        { cases: context.snapshot.cases, transport: context.transport, baseVariables: context.variables },
      );
      const step = run.steps[0];
      const ok =
        step.ok &&
        (caseItem.expectedStatus === undefined
          ? Boolean(step.status && step.status < 400)
          : step.status === caseItem.expectedStatus);
      rows.push({ ...step, ok });
      if (!ok) failed += 1;
    } else {
      const scenario = (context.snapshot.scenarios ?? []).find((item) => item.id === member.refId);
      if (!scenario) {
        console.error(`✗ 场景 ${member.refId} 已删除，跳过`);
        failed += 1;
        continue;
      }
      const run = await runScenario(scenario, {
        cases: context.snapshot.cases,
        transport: context.transport,
        baseVariables: context.variables,
        dataRows: dataRows ?? undefined,
      });
      rows.push(
        ...run.steps.map((step) => ({ ...step, name: `场景 · ${scenario.name} · ${step.name}` })),
      );
      failed += run.summary.failed;
    }
  }
  report("套件结果", rows);
  writeReports(args, suite.name, rows);
  context.store.close();
  process.exit(failed > 0 ? 1 : 0);
}

/** Delegate to the MCP entry so stdio stays 1:1 with the AI client. */
function cmdMcp(rest) {
  const child = spawn(process.execPath, [join(here, "mcp.mjs"), ...rest], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
}

// ------------------------------------------------------- T2.6 · export ----

/** 明确列出「哪些资产没被带走」，避免把「没出现」误当成「已包含」。 */
const NOT_INCLUDED = [
  { asset: "请求历史（history）", reason: "本机运行痕迹，含历史响应，不进入导出包" },
  { asset: "回收站（trash）", reason: "已删除条目与恢复上下文属本机状态，不进入导出包" },
  { asset: "本机凭据（token / 口令 / API Key / Cookie / 私钥 / 证书）", reason: "一律以 {{占位符}} 或 <redacted> 表示，真实值留在本机 / OS keychain" },
  { asset: "私密变量值", reason: "只导出变量名，值仅本机；导入后需重新填写" },
  { asset: "同步基线（syncBaseline / tombstones）", reason: "行同步协议内部状态，不进入导出包" },
  { asset: "OS keychain 主密钥", reason: "操作系统凭据库中的主密钥，永不外发" },
  { asset: "运行历史（lastRun / CaseRunResult / ScenarioRunSummary / SuiteRunSummary）", reason: "测试资产显式省略时间戳与历史结果，保证可 diff" },
  { asset: "二进制上传内容 / 溢出响应体", reason: "本机文件字节，不进入导出包" },
  { asset: "云端连接地址 / 协作空间令牌", reason: "存于本机 localStorage，不进入导出包" },
];

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * docsite.ts（本次文件边界之外，不可修改）在 HTML 里写
 * `new Date().toLocaleString()`。为满足「默认不把生成时间戳写进内容 /
 * sha256 稳定」，把这份时间戳替换为固定文案。内容仍完整由 renderExportAsync
 * 生成并经过两道脱敏闸门，这里只是落盘前的确定性归一化，不是新渲染入口。
 */
function stabilizeDocSite(content) {
  const match = content.match(/Reqora 导出 · ([^<]*)<\/small>/);
  if (!match || match[1].trim() === "") return content;
  return content.split(match[1]).join("（确定性导出·未写时间戳）");
}

/** 清单里的相对路径清洗：拒绝绝对路径 / .. / 空段，杜绝目录穿越。 */
function safeRelativePath(rel) {
  if (typeof rel !== "string" || rel.trim() === "") return null;
  const normalized = rel.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return parts.join("/");
}

async function cmdExportAll(args) {
  const outDir = resolve(args.out ?? "reqora-export");
  const { snapshot, store } = await loadContext(args);
  try {
    await writeExportBundle(snapshot, outDir, args);
  } finally {
    store.close();
  }
}

async function writeExportBundle(snapshot, outDir, args) {
  mkdirSync(outDir, { recursive: true });
  const includeEncrypted = typeof args.password === "string" && args.password.trim() !== "";
  const files = [];
  const skippedFormats = [];
  const warnings = [];

  const record = (relPath, format, content) => {
    const full = join(outDir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
    files.push({
      path: relPath,
      format,
      bytes: Buffer.byteLength(content, "utf8"),
      sha256: sha256(content),
    });
  };

  for (const spec of EXPORT_FORMATS) {
    if (spec.encrypted && !includeEncrypted) {
      skippedFormats.push({
        id: spec.id,
        reason: "加密文档站需要交互输入密码，且 AES-GCM 的 salt/IV 为随机值，无法确定性复现；默认跳过以保持包可复现。可用 --password <口令> 显式导出（该格式本身不可复现）。",
      });
      continue;
    }
    let content = await renderExportAsync(
      snapshot,
      spec.id,
      includeEncrypted ? { password: args.password } : {},
    );
    if (spec.id === "docsite") {
      const stabilized = stabilizeDocSite(content);
      if (stabilized !== content) {
        warnings.push("docsite HTML 内嵌的生成时间戳已归一化，以保证 sha256 稳定；渲染仍走 renderExportAsync 的两道脱敏闸门");
        content = stabilized;
      }
    }
    record(`exports/${spec.fileName}`, spec.id, content);

    if (spec.id === "test-assets-v1") {
      // T2.1 测试资产同时单独落到 assets/，便于在干净机器上直接读。
      record(`assets/${spec.fileName}`, spec.id, content);
    }
    if (spec.id === "bruno-collection") {
      // 多文件清单展开成 exports/bruno/ 真实目录。
      let manifest;
      try {
        manifest = JSON.parse(content);
      } catch {
        warnings.push("Bruno 清单不是合法 JSON，已跳过目录展开（清单原文仍保留在 exports/）");
        manifest = null;
      }
      const entries = manifest && manifest.files && typeof manifest.files === "object"
        ? manifest.files : null;
      if (!entries) {
        if (manifest) warnings.push("Bruno 清单缺少 files 映射，已跳过目录展开");
      } else {
        for (const rel of Object.keys(entries).sort()) {
          const safe = safeRelativePath(rel);
          if (!safe) {
            warnings.push(`Bruno 清单路径被拒绝：${rel}`);
            continue;
          }
          record(`exports/bruno/${safe}`, spec.id, String(entries[rel]));
        }
      }
    }
  }

  // 环境变量名清单单独成文件（只有名字，没有任何值）。
  const envNames = [
    ...new Set(
      (snapshot.environments ?? []).flatMap((environment) =>
        (environment.variables ?? [])
          .map((row) => String(row.key ?? "").trim())
          .filter(Boolean)),
    ),
  ].sort();
  record(
    "assets/environment-variable-names.txt",
    "environment-variable-names",
    envNames.length > 0 ? `${envNames.join("\n")}\n` : "（无环境变量）\n",
  );

  // 运行证据：REQORA_EVIDENCE_DIR 或默认证据目录存在时原样复制。
  if (!args.noEvidence) {
    const source = evidenceDirectory();
    if (existsSync(source)) {
      let stat;
      try { stat = statSync(source); } catch { stat = null; }
      if (stat?.isDirectory()) {
        const walk = (dir, prefix) => {
          for (const name of readdirSync(dir).sort()) {
            const full = join(dir, name);
            let child;
            try { child = statSync(full); } catch { continue; }
            if (child.isDirectory()) {
              walk(full, prefix ? `${prefix}/${name}` : name);
              continue;
            }
            if (!child.isFile()) continue;
            const rel = prefix ? `evidence/${prefix}/${name}` : `evidence/${name}`;
            record(rel, "run-evidence", readFileSync(full, "utf8"));
          }
        };
        walk(source, "");
      }
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = {
    schema: "reqora.export.v1",
    generated_from: "Reqora",
    readable_without_reqora: true,
    note: "本包可在没装 Reqora 的机器上阅读：包含 Postman / OpenAPI / Swagger / Insomnia / HAR / cURL / Markdown / 文档站 / SDK / reqora.test.v1 / Bruno / OpenCollection 等通用格式。",
    deterministic: !includeEncrypted,
    timestamp_policy: args.noTimestamp ? "explicit-no-timestamp" : "deterministic-by-default",
    evidence_included: !args.noEvidence,
    formats: EXPORT_FORMATS.map((spec) => ({
      id: spec.id,
      family: spec.family,
      exported: !(spec.encrypted && !includeEncrypted),
    })),
    skipped_formats: skippedFormats,
    warnings,
    not_included: NOT_INCLUDED,
    files,
  };
  writeFileSync(join(outDir, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`导出包已写入 ${outDir}`);
  console.log(
    `  格式 ${manifest.formats.filter((item) => item.exported).length}/${manifest.formats.length}` +
      ` · 文件 ${manifest.files.length} 个 · 未带走资产 ${manifest.not_included.length} 类`,
  );
  if (skippedFormats.length > 0) {
    console.log(`  跳过的格式：${skippedFormats.map((item) => item.id).join(", ")}（见 MANIFEST.skipped_formats）`);
  }
}

// ----------------------------------------------------------------- main ----

function parseArgs(argv) {
  const args = {};
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--env") args.env = argv[++index];
    else if (token === "--junit") args.junit = argv[++index];
    else if (token === "--json") args.json = argv[++index];
    else if (token === "--data") args.data = argv[++index];
    else if (token === "--workspace" || token === "-w") args.workspace = argv[++index];
    else if (token === "--script-timeout") args.scriptTimeout = argv[++index];
    else if (token === "--out") args.out = argv[++index];
    else if (token === "--password") args.password = argv[++index];
    else if (token === "--all") args.all = true;
    else if (token === "--no-evidence") args.noEvidence = true;
    else if (token === "--no-timestamp") args.noTimestamp = true;
    else if (!args.positional) args.positional = token;
    else rest.push(token);
  }
  args.rest = rest;
  return args;
}

function usage() {
  console.log(`Reqora CLI — 在命令行运行测试场景与用例，或把项目交给 AI

用法：
  reqora list                                  列出接口、场景、用例、套件与环境
  reqora run-scenario <名称|ID> [选项]         运行一个测试场景（条件/循环/等待/提取全支持）
  reqora run-case <名称|ID> [选项]             运行单个接口用例
  reqora run-suite <名称|ID> [选项]            运行一个测试套件（用例 + 场景组合）
  reqora export --all [--out <dir>] [选项]     把全部导出格式 + 测试资产 + 运行证据打成可复现的包
  reqora mcp [--allow-write] [--config]        启动 MCP 服务，供 AI 客户端调用
  reqora --help

选项：
  -w, --workspace <路径> 指定项目数据目录 / 项目 id / 项目名（默认用桌面端当前项目）
  --env <名称>           使用指定环境变量（默认用当前激活环境）
  --data <csv>           数据驱动：CSV 文件（第一行变量名表头），场景按行多轮执行
  --script-timeout <ms>  脚本执行超时（默认取工作区设置，未设置时 2000）
  --junit <路径>         输出 JUnit XML（可接入 Jenkins / GitHub Actions）
  --json <路径>          输出 JSON 报告

导出包（reqora export --all）：
  --out <dir>            导出包目录（默认 ./reqora-export）
  --no-evidence          不复制运行证据目录（REQORA_EVIDENCE_DIR 或默认 artifacts/）
  --no-timestamp         显式声明不写生成时间戳（默认即为确定性输出，行为相同）
  --password <口令>      额外导出加密文档站（AES-GCM 随机 salt/IV，该格式不可复现）
  产物：<out>/exports/（全部格式）、<out>/assets/（测试资产与环境变量名清单）、
        <out>/evidence/（运行证据，若存在）、<out>/exports/bruno/（Bruno 清单展开的目录）、
        <out>/MANIFEST.json（每个文件的相对路径 / 格式 id / 字节数 / sha256 + 未带走资产清单）。
  默认确定性：不写生成时间戳、文件顺序稳定、sha256 稳定；包可在没装 Reqora 的机器上阅读。

MCP：
  reqora mcp --config    打印 Claude Desktop / Claude Code / Cursor / VS Code 配置片段
  只读工具默认可用；改写项目数据需要 --allow-write，且建议桌面端未打开该项目时使用。

工作区：优先 --workspace，其次 $REQORA_WORKSPACE，
      默认读取桌面端当前项目（每个项目一个 workspace.db，旧版 JSON 工作区仍兼容）。
脚本：前置 / 后置脚本与桌面端共用同一份 helper 源码（setVar / setHeader / test / sha256 / hmac 等），
      在 node:vm 中执行；前置脚本报错会阻断发送，test() 结果计入断言与 JUnit 报告。
鉴权：请求设为「继承集合鉴权」时按 requestId 反查所属集合；用例副本按 caseId → ApiCase.requestId 回退。`);
}

const [command, ...argvRest] = process.argv.slice(2);
const args = parseArgs(argvRest);

if (command === "list") await cmdList(args);
else if (command === "run-scenario") await cmdRunScenario(args.positional, args);
else if (command === "run-case") await cmdRunCase(args.positional, args);
else if (command === "run-suite") await cmdRunSuite(args.positional, args);
else if (command === "export") await cmdExportAll(args);
else if (command === "mcp") cmdMcp(argvRest);
else {
  usage();
  const isHelp = ["--help", "-h", "help"].includes(command);
  process.exit(command && !isHelp ? 2 : 0);
}
