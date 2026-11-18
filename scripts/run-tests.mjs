#!/usr/bin/env node
// 跨平台测试入口：显式把测试文件列表交给 node --test。
//
// 历史实现是 package.json 里的 shell 管道：
//   node --test $(ls test/*.test.mjs | grep -vE '...')
// 在 Windows 的 cmd / PowerShell / Bun Shell 下没有 grep，命令替换会静默变成空串，
// node --test 收到零个文件参数就退化为「递归自动发现整个仓库」，于是把
// server/build/reports/tests/test/js/report.js（Gradle HTML 报告的浏览器脚本）
// 也当测试文件加载，报 `ReferenceError: window is not defined`，并连带跑起
// 本不该在 unit 阶段执行的 e2e 用例。
//
// 顺带修掉一个隐藏偏差：Bun Shell 内置的 `ls` 输出不带 `test/` 目录前缀，
// 旧脚本的 grep 正则却以 `/` 开头，因此三个 e2e 文件从来没被排除成功，
// `test:unit` 实际一直在跑全量。现在按脚本名的设计意图真正区分 unit / all；
// 发布门禁（release.mjs）显式用 all，保持原有的 101 文件覆盖不降级。
//
// 这里用 Node 自己枚举文件，不依赖任何外部命令 / shell 展开；无论从
// bun run、npm run、cmd 还是 PowerShell 启动，行为都一致。
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(root, "test");

/** e2e 三件套需要外部服务 / 更长耗时，unit 阶段排除。 */
const E2E_FILES = new Set([
  "e2e-identity.test.mjs",
  "mcp.test.mjs",
  "engineChain.test.mjs",
]);
const EVIDENCE_FILES = new Set(["runEvidence.test.mjs", "gate.test.mjs"]);

const allFiles = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();

const [mode = "unit", ...extraArgs] = process.argv.slice(2);

/** 模式 → 文件集合 + 是否沿用 unit 的超时设置。 */
const modes = {
  unit: {
    files: allFiles.filter((name) => !E2E_FILES.has(name)),
    timeout: true,
  },
  all: { files: allFiles, timeout: false },
  e2e: { files: allFiles.filter((name) => E2E_FILES.has(name)), timeout: false },
  evidence: {
    files: allFiles.filter((name) => EVIDENCE_FILES.has(name)),
    timeout: false,
  },
};

const selected = modes[mode];
if (!selected) {
  console.error(
    `[run-tests] 未知模式 ${mode}；可用：${Object.keys(modes).join(" / ")}`,
  );
  process.exit(2);
}
if (selected.files.length === 0) {
  console.error(`[run-tests] ${mode} 模式没有匹配到测试文件`);
  process.exit(2);
}

// 关键：始终显式传文件，绝不让 node --test 走自动发现。
const args = [
  "--test",
  ...(selected.timeout ? ["--test-timeout=30000"] : []),
  ...extraArgs,
  ...selected.files.map((name) => join(testDir, name)),
];

console.log(`[run-tests] ${mode}: ${selected.files.length} 个测试文件`);
const result = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: "inherit",
});
if (result.error) {
  console.error(`[run-tests] 无法启动测试进程：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
