#!/usr/bin/env node
/**
 * sign-update-manifest.mjs 的易用包装：
 * `--sign <manifest.json>` 未指定 `--out` 时，默认输出到清单同目录的 update.json。
 * 其余参数原样透传。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadReleaseEnv } from "./release-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// 单独执行 `bun run update:sign` 时同样能读到 .env.production 中的签名私钥。
loadReleaseEnv(path.resolve(here, ".."));

const argv = process.argv.slice(2);
let signIndex = argv.indexOf("--sign");
if (signIndex < 0 && argv.length > 0 && !argv[0].startsWith("-")) {
  // 简写：第一个位置参数视为待签名的 manifest.json（等价于 --sign <file>）。
  argv.unshift("--sign");
  signIndex = 0;
  console.log("[update:sign] 已把首个参数视为 --sign <manifest.json>");
}
if (signIndex >= 0 && signIndex + 1 < argv.length && !argv.includes("--out")) {
  const manifest = argv[signIndex + 1];
  const outPath = path.join(path.dirname(path.resolve(manifest)), "update.json");
  argv.push("--out", outPath);
  console.log(`[update:sign] 未指定 --out，默认输出到 ${outPath}`);
}

const script = path.join(here, "sign-update-manifest.mjs");
const result = spawnSync(process.execPath, [script, ...argv], { stdio: "inherit" });
process.exit(result.status ?? 1);
