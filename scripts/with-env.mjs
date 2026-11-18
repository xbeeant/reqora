#!/usr/bin/env node
/**
 * 通用包装器：先加载 .env / .env.production，再执行目标脚本。
 *
 *   node scripts/with-env.mjs scripts/sign-update-manifest.mjs --public-key
 *
 * 用于 `update:keygen` / `update:pubkey` / `update:verify` 等直接调用
 * sign-update-manifest.mjs 的入口，避免「配置文件里有值、CLI 却读不到」。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadReleaseEnv } from "./release-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadReleaseEnv(root);

const [script, ...rest] = process.argv.slice(2);
if (!script) {
  console.error("[with-env] 用法：node scripts/with-env.mjs <脚本路径> [参数...]");
  process.exit(1);
}
const result = spawnSync(process.execPath, [path.resolve(root, script), ...rest], {
  cwd: root,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
