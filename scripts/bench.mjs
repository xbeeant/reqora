#!/usr/bin/env node
// Reqora 同条件性能基准 + 产物体积回归门禁（T3.3）。
//
// 诚实性优先：桌面冷启动 / 窗口可见时间 / 常驻 PSS / 大集合打开耗时，
// 在没有 Tauri release 二进制与 GUI 会话的机器上**测不到**，一律输出
// { status: "unavailable", reason }，绝不编造毫秒数，也不假装测过。
// 可测的部分是纯逻辑微基准（渲染 N 条集合、解析大响应体），用
// performance.now() 真实测量，并固定输入规模 N / 迭代次数、声明机器与
// Node 版本，明确标注「纯逻辑微基准，非桌面冷启动」。
//
// 零第三方依赖，Node >= 22，可 `node scripts/bench.mjs` 直接跑。
// 输出 schema: reqora.bench.v1（--json 为 JSON，默认人类可读文本）。
// CLI 入口放在文件末尾的 import.meta.url 判断之后，纯函数可 import 测试。

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const SCHEMA_ID = "reqora.bench.v1";

/** 固定的微基准输入规模与迭代次数（可复现条件）。 */
export const MICRO = Object.freeze({
  collections: 100,
  requestsPerCollection: 3,
  // 真实工作区里用例是体积大头；基准要覆盖 310 条用例的保存路径。
  cases: 310,
  parseRecords: 1200,
  iterations: 15,
  warmup: 2,
});

/** 各产物的默认体积阈值（MiB）。--threshold-mb 为全局覆盖。 */
export const DEFAULT_THRESHOLDS_MB = Object.freeze({
  mcp: 1, // MCP 单文件 1 MiB
  dist: 20, // 前端 dist 20 MiB
  bundle: 150, // 安装包 bundle
  extra: 5, // --path 指定产物
});

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

// ------------------------------------------------------------- 参数解析 ----

export function parseBenchArgs(argv) {
  const args = {
    json: false,
    check: false,
    strict: false,
    sizeGate: false,
    paths: [],
    thresholdMb: undefined,
    out: undefined,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") args.json = true;
    else if (token === "--check") args.check = true;
    else if (token === "--strict") args.strict = true;
    else if (token === "--size-gate") args.sizeGate = true;
    else if (token === "--path") args.paths.push(argv[++index]);
    else if (token === "--threshold-mb") args.thresholdMb = Number(argv[++index]);
    else if (token === "--out") args.out = argv[++index];
    else if (token === "--help" || token === "-h") args.help = true;
  }
  return args;
}

export function usageBench() {
  return `Reqora 性能基准 + 产物体积门禁（${SCHEMA_ID}）

用法：
  node scripts/bench.mjs                 人类可读文本
  node scripts/bench.mjs --json          JSON（含 conditions / metrics / sizeGate）
  node scripts/bench.mjs --strict       体积超阈值时退出 1
  node scripts/bench.mjs --check        只打印摘要，不写任何文件
  node scripts/bench.mjs --help

选项：
  --json                输出 JSON 报告（schema: ${SCHEMA_ID}）
  --size-gate           显式声明启用产物体积门禁（标准产物默认已检查）
  --path <path>         追加检查一个产物（可重复；目录递归累计字节）
  --threshold-mb <N>    全局体积阈值覆盖（MiB，默认 MCP 1 / dist 20 / bundle 150）
  --strict              任一产物超出阈值 → 退出 1；文件缺失标注 skipped，不算失败
  --check               不写文件，只打印摘要
  --out <file>          额外把 JSON 报告写入文件（--check 时忽略）

四项桌面指标（冷启动 / 窗口可见 / 常驻 PSS / 大集合打开）在无 release 二进制、
无 GUI 的环境下如实标注 unavailable；renderWorkspace / parse 为纯逻辑微基准，
用 performance.now() 实测并声明 N / 迭代次数 / 机器与 Node 版本。`;
}

// --------------------------------------------------------------- 条件 ----

function readGitCommit(repoRoot) {
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    return String(out).trim() || null;
  } catch {
    return null; // git 不可用 / 非仓库：可选字段留空
  }
}

export function buildConditions(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const cpuList = cpus();
  const releaseBundlePath = join(repoRoot, "src-tauri", "target", "release", "bundle");
  const releaseBundleExists = existsSync(releaseBundlePath);
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    cpu: cpuList[0]?.model ?? "unknown",
    cpuCount: cpuList.length,
    releaseBuild: releaseBundleExists,
    releaseBundlePath,
    releaseBundleExists,
    headless: Boolean(process.env.CI) || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY),
    gitCommit: readGitCommit(repoRoot), // 可选
    repoRoot,
    micro: { ...MICRO },
    comparability:
      "四项桌面指标与竞品口径（冷启动 / 窗口可见 / PSS / 大集合打开）需 Tauri release 二进制 + GUI 计时钩子，" +
      "本机不可测，故标注 unavailable 而非给出不可比数字；renderWorkspace / parse 为固定输入的纯逻辑微基准，" +
      "不是桌面冷启动，不可与竞品桌面数字直接横比。",
  };
}

// ------------------------------------------------------- 产物体积门禁 ----

export function sizeTargets(extraPaths = []) {
  const targets = [
    { path: "dist-mcp/mcp.mjs", label: "MCP 单文件", kind: "file", defaultThresholdMb: DEFAULT_THRESHOLDS_MB.mcp },
    { path: "dist", label: "前端 dist", kind: "dir", defaultThresholdMb: DEFAULT_THRESHOLDS_MB.dist },
    {
      path: "src-tauri/target/release/bundle",
      label: "安装包 bundle",
      kind: "dir",
      defaultThresholdMb: DEFAULT_THRESHOLDS_MB.bundle,
    },
  ];
  for (const path of extraPaths) {
    targets.push({ path, label: path, kind: "auto", defaultThresholdMb: DEFAULT_THRESHOLDS_MB.extra });
  }
  return targets;
}

function pathBytes(full, kind) {
  const stat = statSync(full);
  if (kind === "file" || stat.isFile()) return stat.size;
  if (stat.isDirectory()) {
    let total = 0;
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue; // 不跟随符号链接，避免环
      const child = join(full, entry.name);
      if (entry.isDirectory()) total += pathBytes(child, "dir");
      else if (entry.isFile()) total += statSync(child).size;
    }
    return total;
  }
  return stat.size;
}

/**
 * 纯逻辑：检查体积门禁。返回 { items, passed, warnings }。
 * 每个 item：{ path, label, kind, exists, bytes|null, thresholdMb,
 * thresholdBytes, status: 'ok'|'exceeded'|'skipped', pass, reason? }。
 * 文件不存在 → skipped 且 pass=true（不算失败）。
 */
export function checkSizeGate(targets, options = {}) {
  const rootDir = options.rootDir ?? REPO_ROOT;
  const items = [];
  const warnings = [];
  for (const target of targets) {
    const full = isAbsolute(target.path) ? target.path : resolve(rootDir, target.path);
    const thresholdMb = options.thresholdMb ?? target.defaultThresholdMb;
    const thresholdBytes = Math.round(thresholdMb * 1024 * 1024);
    const base = {
      path: target.path,
      label: target.label,
      kind: target.kind,
      thresholdMb,
      thresholdBytes,
    };
    if (!existsSync(full)) {
      items.push({
        ...base,
        exists: false,
        bytes: null,
        status: "skipped",
        pass: true,
        reason: "文件/目录不存在（跳过，不算失败）",
      });
      continue;
    }
    let bytes;
    try {
      bytes = pathBytes(full, target.kind);
    } catch (error) {
      items.push({
        ...base,
        exists: true,
        bytes: null,
        status: "skipped",
        pass: true,
        reason: `读取失败，跳过：${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const exceeded = bytes > thresholdBytes;
    const status = exceeded ? "exceeded" : "ok";
    items.push({
      ...base,
      exists: true,
      bytes,
      status,
      pass: !exceeded,
      ...(exceeded ? { reason: `超出阈值 ${thresholdMb} MiB` } : {}),
    });
    if (exceeded) {
      warnings.push(`${target.path}：${bytes} 字节 > ${thresholdMb} MiB（${thresholdBytes} 字节）阈值`);
    }
  }
  return { items, passed: items.every((item) => item.pass), warnings };
}

// --------------------------------------------------------------- 微基准 ----

/** 固定规模的合成工作区快照（确定性，无随机值 / 当前时间）。 */
export function synthSnapshot() {
  const collections = [];
  for (let c = 0; c < MICRO.collections; c += 1) {
    const items = [];
    for (let r = 0; r < MICRO.requestsPerCollection; r += 1) {
      items.push({
        id: `col-${c}-req-${r}`,
        name: `接口 ${c}-${r}`,
        method: r % 2 === 0 ? "GET" : "POST",
        url: `https://api.example.com/v1/collections/${c}/items/${r}`,
        headers: [{ id: `h-${c}-${r}`, key: "Content-Type", value: "application/json", enabled: true }],
        query: [],
        body: { type: "json", content: `{"page":${r}}` },
        auth: { type: "none" },
        description: `集合 ${c} 的接口 ${r}`,
        updatedAt: 1700000000000 + c * 100 + r,
      });
    }
    collections.push({ id: `col-${c}`, name: `集合 ${c}`, items, updatedAt: 1700000000000 + c });
  }
  return {
    version: 1,
    seeded: false,
    activeEnvironmentId: "env-default",
    collections,
    environments: [
      {
        id: "env-default",
        name: "默认",
        variables: [{ id: "v1", key: "baseUrl", value: "https://api.example.com", enabled: true }],
        updatedAt: 1,
      },
    ],
    cases: Array.from({ length: MICRO.cases }, (_, index) => ({
      id: `case-${index}`,
      requestId: `col-0-req-0`,
      name: `用例 ${index}`,
      group: "正向",
      enabled: true,
      description: "",
      syncedAt: 1700000000000,
      createdAt: 1700000000000 + index,
      updatedAt: 1700000000000 + index,
      request: {
        ...collections[0].items[0],
        id: `case-copy-${index}`,
        doc: undefined,
      },
    })),
    scenarios: [],
    suites: [],
    history: [],
    trash: [],
    tombstones: [],
    settings: { timeoutSecs: 30 },
  };
}

/** 固定的大响应体（确定性）。 */
export function synthParseBody() {
  const rows = [];
  for (let i = 0; i < MICRO.parseRecords; i += 1) {
    rows.push({
      id: `row-${i}`,
      name: `记录 ${i}`,
      ok: i % 2 === 0,
      value: i * 1.25,
      tags: ["alpha", "beta", "gamma"],
      note: "固定负载，用于纯逻辑 JSON.parse 微基准",
    });
  }
  return JSON.stringify({ code: 0, message: "ok", data: { total: rows.length, rows } });
}

/** 回退渲染器：仅当 gitMirror.ts 不可加载时使用（仍是真实纯逻辑操作）。 */
function localRender(snapshot) {
  const out = [];
  for (const collection of snapshot.collections ?? []) {
    const rows = (collection.items ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      method: item.method,
      url: item.url,
    }));
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    out.push(`${collection.id}|${rows.map((row) => `${row.id}:${row.method}:${row.url}`).join(",")}`);
  }
  return out.join("\n");
}

async function resolveRenderer() {
  try {
    const mod = await import("../src/lib/gitMirror.ts");
    if (typeof mod.renderGitMirror === "function") return { fn: mod.renderGitMirror, real: true };
  } catch {
    // 回退到内置合成渲染，保证基准仍可运行且如实标注
  }
  return { fn: localRender, real: false };
}

function meanPerOp(fn, iterations) {
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) fn();
  return (performance.now() - start) / iterations;
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

/** 真实测量两项纯逻辑微基准。固定 N / 迭代次数，结果随机器负载波动但可复现条件。 */
export async function runMicroBenchmarks() {
  const { fn, real } = await resolveRenderer();
  const snapshot = synthSnapshot();
  const body = synthParseBody();
  for (let i = 0; i < MICRO.warmup; i += 1) {
    fn(snapshot);
    JSON.parse(body);
  }
  const renderMs = meanPerOp(() => fn(snapshot), MICRO.iterations);
  const parseMs = meanPerOp(() => JSON.parse(body), MICRO.iterations);
  const requestCount = MICRO.collections * MICRO.requestsPerCollection;
  // 单实体改名：验证行级保存路径不随快照总量线性增长。
  const { stampSharedChanges, deltaRowsFromDirty } = await import(
    "../src/store/workspace/rowProtocol.ts"
  );
  const next = {
    ...snapshot,
    collections: snapshot.collections.map((collection, index) =>
      index === 0
        ? {
            ...collection,
            items: collection.items.map((item, itemIndex) =>
              itemIndex === 0 ? { ...item, name: `${item.name}-改名` } : item,
            ),
          }
        : collection,
    ),
  };
  const commitStart = performance.now();
  const outcome = stampSharedChanges(snapshot, next);
  const commitMs = performance.now() - commitStart;
  const rows = deltaRowsFromDirty(outcome.dirty);
  const deltaBytes = Buffer.byteLength(
    JSON.stringify({ rows, history: outcome.aux?.history ?? [] }),
    "utf8",
  );
  const fullBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  return {
    commitSingleEdit: {
      status: "measured",
      value: round(commitMs),
      unit: "ms",
      method:
        `单接口改名后 stampSharedChanges + deltaRowsFromDirty；` +
        `N=${MICRO.cases} 用例 / ${requestCount} 接口，iterations=1。` +
        `纯逻辑微基准（引用短路命中时与快照总字节数无关）。`,
    },
    deltaPayloadBytes: {
      status: "measured",
      value: deltaBytes,
      unit: "bytes",
      method:
        `单编辑防抖载荷（行级 delta）；对照整份快照 ${fullBytes} 字节，` +
        `压缩比 ${round(fullBytes / Math.max(deltaBytes, 1))}×。`,
    },
    renderWorkspace: {
      status: "measured",
      value: round(renderMs),
      unit: "ms",
      method:
        `${real ? "调用项目真实 renderGitMirror" : "内置合成渲染（gitMirror.ts 不可加载时的回退）"}；` +
        `N=${MICRO.collections} 集合 × ${MICRO.requestsPerCollection} 接口 = ${requestCount} 条，` +
        `iterations=${MICRO.iterations}，warmup=${MICRO.warmup}，取每次均值。` +
        `纯逻辑微基准（含稳定 YAML 序列化），非桌面 UI 渲染、非冷启动。`,
    },
    parse: {
      status: "measured",
      value: round(parseMs),
      unit: "ms",
      method:
        `JSON.parse 大响应体；body=${Buffer.byteLength(body, "utf8")} 字节 / ${MICRO.parseRecords} 条记录，` +
        `iterations=${MICRO.iterations}，warmup=${MICRO.warmup}，取每次均值。` +
        `纯逻辑微基准，非桌面冷启动。`,
    },
  };
}

// --------------------------------------------------------------- 指标 ----

function desktopMetrics(conditions) {
  const reason =
    `本机未检测到可测量的桌面环境：release 构建产物 ${conditions.releaseBundleExists ? "存在" : "缺失"}` +
    `（${conditions.releaseBundlePath}），且本进程没有已启动的 Tauri 应用窗口、` +
    `无 PSS 采样目标、无 GUI 首帧 / 大集合打开计时钩子。` +
    `真实桌面冷启动、窗口可见时间、常驻 PSS、大集合打开耗时均无法在此 CLI 中测量；` +
    `按诚实性要求标注 unavailable，不编造毫秒数，也不与竞品数字强行对齐。`;
  const unavailable = (unit, method) => ({ status: "unavailable", unit, reason, method });
  return {
    coldStart: unavailable("ms", "桌面冷启动：需 Tauri release 二进制 + 进程启动计时"),
    windowVisible: unavailable("ms", "窗口可见时间：需 GUI 会话首帧事件计时"),
    residentPss: unavailable("KiB", "常驻 PSS：需运行中进程的 /proc smaps 或 vmmap 采样"),
    largeCollectionOpen: unavailable("ms", "大集合打开耗时：需桌面 UI 实测"),
  };
}

export function buildMetrics(conditions, micro) {
  return { ...desktopMetrics(conditions), ...micro };
}

/** 组装完整报告。async：微基准渲染器按需动态 import。 */
export async function buildReport(options = {}) {
  const conditions = buildConditions(options);
  const targets = sizeTargets(options.paths ?? []);
  const sizeGate = checkSizeGate(targets, {
    thresholdMb: options.thresholdMb,
    rootDir: conditions.repoRoot,
  });
  const micro = await runMicroBenchmarks();
  const metrics = buildMetrics(conditions, micro);
  return {
    schema: SCHEMA_ID,
    conditions,
    metrics,
    sizeGate,
    warnings: sizeGate.warnings,
  };
}

/** --strict 退出码：仅体积超限触发 1；unavailable 的桌面指标不算失败。 */
export function exitCodeFor(report, strict) {
  if (!strict) return 0;
  return report.sizeGate.passed ? 0 : 1;
}

// --------------------------------------------------------------- 输出 ----

export function humanText(report) {
  const c = report.conditions;
  const lines = [];
  lines.push(`Reqora 性能基准 / 产物体积门禁  (${report.schema})`);
  lines.push(
    `条件: platform=${c.platform}/${c.arch}  node=${c.nodeVersion}  cpu=${c.cpu} (${c.cpuCount} 核)  ` +
      `releaseBuild=${c.releaseBuild}  headless=${c.headless}  commit=${c.gitCommit ?? "n/a"}`,
  );
  lines.push(`微基准规模: N=${c.micro.collections} 集合 / ${c.micro.cases} 用例 / ${c.micro.parseRecords} 条记录  iterations=${c.micro.iterations}  warmup=${c.micro.warmup}`);
  lines.push("");
  lines.push("指标（四项桌面指标 + 纯逻辑微基准）：");
  for (const [key, metric] of Object.entries(report.metrics)) {
    if (metric.status === "measured") {
      lines.push(`  [measured]    ${key}: ${metric.value} ${metric.unit}`);
      lines.push(`                ${metric.method}`);
    } else {
      lines.push(`  [unavailable] ${key}: ${metric.reason}`);
    }
  }
  lines.push("");
  lines.push("产物体积门禁：");
  for (const item of report.sizeGate.items) {
    lines.push(
      `  ${item.status.padEnd(9)} ${item.path}  bytes=${item.bytes ?? "-"}  ` +
        `threshold=${item.thresholdMb} MiB  pass=${item.pass}${item.reason ? `  (${item.reason})` : ""}`,
    );
  }
  if (report.warnings.length) {
    lines.push("");
    lines.push("告警：");
    for (const warning of report.warnings) lines.push(`  ! ${warning}`);
  }
  return lines.join("\n");
}

export function checkSummary(report) {
  const measured = Object.values(report.metrics).filter((m) => m.status === "measured").length;
  const unavailable = Object.values(report.metrics).filter((m) => m.status === "unavailable").length;
  return [
    `${report.schema} 摘要（--check：不写文件）`,
    `  条件: node=${report.conditions.nodeVersion} platform=${report.conditions.platform} releaseBuild=${report.conditions.releaseBuild}`,
    `  指标: ${unavailable} 项 unavailable（无 release 二进制 / 无 GUI，如实标注）、${measured} 项 measured（纯逻辑微基准）`,
    `  体积门禁: ${report.sizeGate.items.length} 项  passed=${report.sizeGate.passed}  exceeded=${report.warnings.length}`,
    `  renderWorkspace=${report.metrics.renderWorkspace.value} ms  parse=${report.metrics.parse.value} ms`,
  ].join("\n");
}

// --------------------------------------------------------------- CLI 入口 ----

const isMain =
  !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseBenchArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usageBench());
    process.exitCode = 0;
  } else {
    const report = await buildReport({
      paths: args.paths,
      thresholdMb: args.thresholdMb,
      sizeGateRequested: args.sizeGate,
    });
    if (args.check) {
      // 不写文件，只打印摘要
      console.log(checkSummary(report));
    } else if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      console.log(humanText(report));
    }
    if (!args.check && args.out) {
      writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.log(`JSON 报告已写入 ${args.out}`);
    }
    if (report.warnings.length && !args.check) {
      for (const warning of report.warnings) console.error(`⚠ ${warning}`);
    }
    process.exitCode = exitCodeFor(report, args.strict);
  }
}
