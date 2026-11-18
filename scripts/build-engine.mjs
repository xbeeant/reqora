#!/usr/bin/env node
/**
 * 构建 reqora-send：从 reqora-core 编译出的无 Tauri 请求引擎 sidecar。
 *
 *   node scripts/build-engine.mjs              # release（默认）
 *   node scripts/build-engine.mjs --debug      # debug（本地开发/测试更快）
 *   node scripts/build-engine.mjs --check      # 构建后跑 hello/send 冒烟
 *
 * 产物复制到 dist-engine/<platform>-<arch>/reqora-send[.exe]，CLI / MCP 会
 * 自动发现（也可用 REQORA_SEND_BIN 显式指定）。cargo 的工作目录固定为
 * src-tauri/，因为 MSVC 工具链固定与 reqwest_unstable cfg 写在
 * src-tauri/.cargo/config.toml 里。
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = path.join(root, "src-tauri");
const args = process.argv.slice(2);
const debug = args.includes("--debug");
const check = args.includes("--check");
const profile = debug ? "debug" : "release";
const exe = process.platform === "win32" ? "reqora-send.exe" : "reqora-send";

// Honour CARGO_TARGET_DIR (relative paths are resolved against src-tauri/,
// matching cargo's cwd) so CI / parallel builds can use an isolated target.
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(tauriDir, process.env.CARGO_TARGET_DIR)
  : path.join(tauriDir, "target");
const built = path.join(targetDir, profile, exe);
const outDir = path.join(root, "dist-engine", `${process.platform}-${process.arch}`);
const outFile = path.join(outDir, exe);

console.log(`[engine] cargo build -p reqora-send (${profile})`);
const cargoArgs = ["build", "-p", "reqora-send"];
if (!debug) cargoArgs.push("--release");
const result = spawnSync("cargo", cargoArgs, {
  cwd: tauriDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.status !== 0) {
  console.error(`[engine] ✗ cargo 构建失败（exit=${result.status}）`);
  process.exit(result.status ?? 1);
}
if (!existsSync(built)) {
  console.error(`[engine] ✗ 未找到构建产物 ${built}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
rmSync(outFile, { force: true });
copyFileSync(built, outFile);

if (check) {
  const probe = spawnSync(outFile, [], {
    input: '{"id":"1","method":"hello"}\n{"id":"2","method":"shutdown"}\n',
    encoding: "utf8",
  });
  if (probe.status !== 0 || !/"engine":"reqora-core"/.test(probe.stdout ?? "")) {
    console.error(`[engine] ✗ 握手自检失败：${probe.stderr || probe.stdout}`);
    process.exit(1);
  }
  console.log("[engine] ✓ NDJSON 握手自检通过");
}

console.log(`[engine] ✓ ${outFile}`);
console.log("[engine]   CLI/MCP 会自动发现；或设置 REQORA_SEND_BIN 指向该文件。");
