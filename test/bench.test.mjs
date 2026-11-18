// T3.3 同条件性能基准 + 产物体积门禁：sizeGate / metrics 状态 / JSON / 条件 / --strict。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SCHEMA_ID,
  checkSizeGate,
  sizeTargets,
  buildConditions,
  buildReport,
  exitCodeFor,
  parseBenchArgs,
} from "../scripts/bench.mjs";
import { rmTemp } from "../scripts/rm-temp.mjs";

const BENCH = fileURLToPath(new URL("../scripts/bench.mjs", import.meta.url));

function runBench(args) {
  return spawnSync(process.execPath, [BENCH, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

// ----------------------------------------------------------- sizeGate ----

test("sizeGate：通过 / 超限 / 文件缺失（skipped 不算失败）", () => {
  const root = mkdtempSync(join(tmpdir(), "reqora-bench-size-"));
  try {
    const small = join(root, "small.bin");
    const big = join(root, "big.bin");
    const missing = join(root, "missing.bin");
    const dir = join(root, "distdir");
    writeFileSync(small, Buffer.alloc(128));
    writeFileSync(big, Buffer.alloc(2 * 1024 * 1024)); // 2 MiB > 1 MiB 阈值
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.js"), Buffer.alloc(512));

    const targets = [
      { path: small, label: "small", kind: "file", defaultThresholdMb: 1 },
      { path: big, label: "big", kind: "file", defaultThresholdMb: 1 },
      { path: missing, label: "missing", kind: "file", defaultThresholdMb: 1 },
      { path: dir, label: "dir", kind: "dir", defaultThresholdMb: 1 },
    ];
    const gate = checkSizeGate(targets);
    assert.equal(gate.items[0].status, "ok");
    assert.equal(gate.items[0].pass, true);
    assert.ok(gate.items[0].bytes > 0);

    assert.equal(gate.items[1].status, "exceeded");
    assert.equal(gate.items[1].pass, false);
    assert.ok(gate.items[1].bytes > gate.items[1].thresholdBytes);
    assert.ok(gate.warnings.some((warning) => warning.includes("big.bin")));

    assert.equal(gate.items[2].status, "skipped", "文件缺失标注 skipped");
    assert.equal(gate.items[2].pass, true, "skipped 不算失败");
    assert.equal(gate.items[2].bytes, null);

    assert.equal(gate.items[3].status, "ok", "目录递归累计字节");
    assert.ok(gate.items[3].bytes >= 512);

    assert.equal(gate.passed, false, "存在 exceeded 则整体不通过");
  } finally {
    rmTemp(root);
  }
});

test("sizeGate：--threshold-mb 全局覆盖阈值", () => {
  const root = mkdtempSync(join(tmpdir(), "reqora-bench-thr-"));
  try {
    const file = join(root, "f.bin");
    writeFileSync(file, Buffer.alloc(4096));
    const target = { path: file, label: "f", kind: "file", defaultThresholdMb: 20 };
    assert.equal(checkSizeGate([target]).items[0].status, "ok");
    const overridden = checkSizeGate([target], { thresholdMb: 0.001 });
    assert.equal(overridden.items[0].thresholdMb, 0.001);
    assert.equal(overridden.items[0].status, "exceeded");
  } finally {
    rmTemp(root);
  }
});

test("sizeTargets 覆盖 dist / MCP 单文件 / release bundle 与 --path", () => {
  const targets = sizeTargets(["extra.zip", "another.dmg"]);
  const paths = targets.map((target) => target.path);
  assert.ok(paths.includes("dist"));
  assert.ok(paths.includes("dist-mcp/mcp.mjs"));
  assert.ok(paths.includes("src-tauri/target/release/bundle"));
  assert.ok(paths.includes("extra.zip"));
  assert.ok(paths.includes("another.dmg"));
});

// ----------------------------------------------------------- metrics ----

test("metrics 状态枚举合法；四项桌面指标如实 unavailable；微基准真实 measured", async () => {
  const report = await buildReport();
  assert.equal(report.schema, SCHEMA_ID);
  const statuses = new Set(["measured", "unavailable"]);
  for (const [key, metric] of Object.entries(report.metrics)) {
    assert.ok(statuses.has(metric.status), `${key} 的 status 必须在枚举内`);
  }
  for (const key of ["coldStart", "windowVisible", "residentPss", "largeCollectionOpen"]) {
    const metric = report.metrics[key];
    assert.equal(metric.status, "unavailable", `${key} 无 release 二进制 / 无 GUI，须标注 unavailable`);
    assert.ok(typeof metric.reason === "string" && metric.reason.length > 0);
    assert.equal(metric.value, undefined, "不得编造毫秒数");
  }
  for (const key of ["renderWorkspace", "parse"]) {
    const metric = report.metrics[key];
    assert.equal(metric.status, "measured");
    assert.equal(typeof metric.value, "number");
    assert.ok(metric.value >= 0);
    assert.equal(metric.unit, "ms");
    assert.ok(metric.method.includes("纯逻辑微基准"), "明确标注非桌面冷启动");
  }
  const commit = report.metrics.commitSingleEdit;
  assert.equal(commit.status, "measured");
  assert.ok(commit.value >= 0);
  const delta = report.metrics.deltaPayloadBytes;
  assert.equal(delta.status, "measured");
  assert.equal(delta.unit, "bytes");
  assert.ok(delta.value > 0 && delta.value < 256 * 1024, "单编辑载荷必须远小于整份快照");
  assert.ok(report.conditions.micro.cases >= 300);
});

test("conditions 字段完整（平台 / Node / CPU / release 构建 / 微基准规模）", () => {
  const c = buildConditions();
  for (const key of ["platform", "arch", "nodeVersion", "cpu", "releaseBuild", "micro", "comparability"]) {
    assert.ok(key in c, `conditions 缺 ${key}`);
  }
  assert.equal(typeof c.nodeVersion, "string");
  assert.equal(typeof c.cpu, "string");
  assert.equal(typeof c.releaseBuild, "boolean");
  assert.ok(c.micro.collections > 0 && c.micro.iterations > 0);
});

test("exitCodeFor：仅 --strict 且存在 exceeded 时返回 1", () => {
  const fake = (passed) => ({ sizeGate: { passed } });
  assert.equal(exitCodeFor(fake(true), true), 0);
  assert.equal(exitCodeFor(fake(false), true), 1);
  assert.equal(exitCodeFor(fake(false), false), 0, "非 strict 不因超限失败");
});

test("parseBenchArgs 解析全部开关", () => {
  const args = parseBenchArgs([
    "--json", "--check", "--strict", "--size-gate",
    "--path", "a.zip", "--path", "b.dmg",
    "--threshold-mb", "3.5", "--out", "report.json",
  ]);
  assert.equal(args.json, true);
  assert.equal(args.check, true);
  assert.equal(args.strict, true);
  assert.equal(args.sizeGate, true);
  assert.deepEqual(args.paths, ["a.zip", "b.dmg"]);
  assert.equal(args.thresholdMb, 3.5);
  assert.equal(args.out, "report.json");
});

// ----------------------------------------------------------- CLI ----

test("CLI --json 输出可解析且字段齐全", () => {
  const result = runBench(["--json"]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.schema, SCHEMA_ID);
  assert.ok(parsed.conditions && parsed.metrics && parsed.sizeGate);
  assert.ok(Array.isArray(parsed.sizeGate.items) && parsed.sizeGate.items.length >= 3);
  // 桌面四项如实 unavailable
  for (const key of ["coldStart", "windowVisible", "residentPss", "largeCollectionOpen"]) {
    assert.equal(parsed.metrics[key].status, "unavailable");
  }
  assert.equal(parsed.metrics.renderWorkspace.status, "measured");
  assert.equal(parsed.metrics.parse.status, "measured");
});

test("CLI --check 不写文件，只打印摘要", () => {
  const root = mkdtempSync(join(tmpdir(), "reqora-bench-check-"));
  try {
    const outFile = join(root, "should-not-exist.json");
    const result = runBench(["--check", "--out", outFile]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(outFile), false, "--check 忽略 --out，不写文件");
    assert.ok(result.stdout.includes("摘要"));
  } finally {
    rmTemp(root);
  }
});

test("CLI --strict 退出码：通过 0 / 超限 1 / 非 strict 超限仍 0", () => {
  // 显式追加一个必然存在的文件作为产物：默认产物（dist / bundle）在
  // 全新检出里尚未构建，按门禁语义会被 skipped，不能拿它们断言超限。
  const knownFile = fileURLToPath(new URL("../package.json", import.meta.url));
  const pass = runBench(["--json", "--strict", "--threshold-mb", "100", "--path", knownFile]);
  assert.equal(pass.status, 0, `通过应退出 0：${pass.stderr}`);

  const fail = runBench(["--json", "--strict", "--threshold-mb", "0.0005", "--path", knownFile]);
  assert.equal(fail.status, 1, "超阈值 + --strict 应退出 1");
  assert.ok(fail.stderr.includes("⚠") || fail.stderr.includes("阈值"), "输出告警");

  const noStrict = runBench(["--json", "--threshold-mb", "0.0005", "--path", knownFile]);
  assert.equal(noStrict.status, 0, "非 strict 只告警不失败");
});
