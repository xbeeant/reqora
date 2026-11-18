#!/usr/bin/env node
/**
 * Reqora 更新包打包工具。
 *
 * 从已构建的 release 产物打出自更新 zip，并生成待签名的更新清单 manifest.json：
 *
 *   node scripts/pack-update.mjs [--exe <reqora.exe>] [--out-dir <dir>] [--url <zip下载地址>] [--url-base <发布地址>] [--notes <文本>]
 *
 * 发布地址优先级：--url-base > REQORA_RELEASE_URL_BASE（.env / .env.production）> 示例占位。
 *
 * 产物（默认输出到 dist-update/）：
 *   reqora-<version>-x64-update.zip   内部为 zip 根目录下的 reqora.exe
 *   manifest.json                     交给 `bun run update:sign -- ...` 签名
 *
 * 后续步骤（脚本结束时会再次提示）：
 *   bun run update:sign  -- dist-update/manifest.json --out dist-update/update.json --days 365
 *   把 zip 与 update.json 上传到后台检测地址对应的静态目录。
 */

import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadReleaseEnv, normalizeUrlBase } from "./release-env.mjs";

// 独立运行 `bun run update:pack` 时也要能读到 .env.production 里的发布地址。
loadReleaseEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const exePath = flag("--exe") ?? path.join("src-tauri", "target", "release", "reqora.exe");
const outDir = flag("--out-dir") ?? "dist-update";
const notes = flag("--notes") ?? "";

/** 示例静态目录；实际发布请用 REQORA_RELEASE_URL_BASE / --url-base 改成自己的 HTTPS 地址。 */
const DEFAULT_URL_BASE = "https://example.com/reqora";
const urlBase =
  normalizeUrlBase(flag("--url-base")) ??
  normalizeUrlBase(process.env.REQORA_RELEASE_URL_BASE) ??
  DEFAULT_URL_BASE;

const root = process.cwd();
const exe = path.resolve(root, exePath);
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const zipName = `reqora-${version}-x64-update.zip`;

// --url 省略时按后台目录约定推导：<base>/reqora-<version>-x64-update.zip。
const downloadUrl = flag("--url") ?? `${urlBase}/${zipName}`;

// ---- 前置校验 ---------------------------------------------------------------

let exeSize = 0;
try {
  const stat = await import("node:fs/promises").then((m) => m.stat(exe));
  exeSize = stat.size;
} catch {
  console.error(`[pack-update] 找不到 ${exe}`);
  console.error("[pack-update] 请先执行构建：bun run tauri:build");
  process.exit(1);
}

// ---- 组包 -------------------------------------------------------------------

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const zipPath = path.join(outDir, zipName);
const staging = path.join(outDir, ".staging");
await mkdir(staging, { recursive: true });
await copyFile(exe, path.join(staging, "reqora.exe"));

// 用 Windows 自带的 PowerShell Compress-Archive 组 zip（不依赖 PATH 里的 tar/zip，
// GNU tar 会把 E:\ 误判为远程主机）。staging 里只有一个 reqora.exe，落在 zip 根目录。
const psCommand = `Compress-Archive -Path '${staging}\\reqora.exe' -DestinationPath '${zipPath}' -Force`;
const packed = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", psCommand],
  { stdio: "inherit" },
);
await rm(staging, { recursive: true, force: true });
if (packed.status !== 0) {
  console.error("[pack-update] zip 打包失败（Compress-Archive 调用出错，详见上方输出）");
  process.exit(1);
}

// 大小校验：zip 必须小于原始 exe（有压缩）且大于 0。
let zipSize = 0;
for await (const chunk of createReadStream(zipPath)) {
  zipSize += chunk.length;
}
if (zipSize <= 0 || zipSize > exeSize) {
  console.error(`[pack-update] 产物大小异常（exe ${exeSize} B → zip ${zipSize} B），请检查`);
  process.exit(1);
}

// ---- 生成待签名清单 ---------------------------------------------------------

const manifest = {
  version,
  pubDate: new Date().toISOString().slice(0, 10),
  notes,
  url: downloadUrl,
};
const manifestPath = path.join(outDir, "manifest.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`
[pack-update] 完成 ✓
  zip      : ${zipPath}  (${(zipSize / 1024 / 1024).toFixed(2)} MiB, 内含 reqora.exe)
  manifest : ${manifestPath}

[pack-update] 下一步：
  1. 签名   : bun run update:sign -- ${path.join(outDir, "manifest.json")} --out ${path.join(outDir, "update.json")} --days 365
  2. 自检   : bun run update:verify -- ${path.join(outDir, "update.json")}
  3. 上传   : 把 ${zipName} 与 update.json 上传到 ${urlBase}
             （update.json 中 url 已指向：${downloadUrl}）
  4. 客户端 : REQORA_UPDATE_MANIFEST_URL=${urlBase}/update.json
             （发布地址来自 REQORA_RELEASE_URL_BASE / --url-base，须为 HTTPS）
`);
