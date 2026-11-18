#!/usr/bin/env node
/**
 * Reqora 一键打包：桌面端安装包 + MCP 单文件发行版 + 可发布 zip + 更新清单。
 *
 *   node scripts/release.mjs                    # 完整流程
 *   node scripts/release.mjs --fast             # 跳过 typecheck
 *   node scripts/release.mjs --skip-tauri       # 跳过桌面端构建（复用已有产物）
 *   node scripts/release.mjs --skip-tests       # 跳过全量测试
 *   node scripts/release.mjs --notes "..."      # 更新清单发布说明
 *   node scripts/release.mjs --version 1.2.3    # 显式指定版本号（默认 patch 位 +1）
 *   node scripts/release.mjs --url-base https://cdn.example.com/reqora
 *   node scripts/release.mjs --key <path|64hex> # 显式指定签名私钥
 *   node scripts/release.mjs --no-sync-public-key  # 不同步内置验签公钥
 *   node scripts/release.mjs --allow-unsigned  # 显式允许产出未签名清单
 *
 * 流程：
 *   0. 加载 .env/.env.production、解析签名私钥、同步验签公钥（必须在构建之前）
 *   1. typecheck（--fast 跳过）+ 全量测试（--skip-tests 跳过）
 *   2. node scripts/build-mcp.mjs --check → dist-mcp/mcp.mjs
 *   3. node scripts/build-engine.mjs --check → dist-engine/<platform>-<arch>/reqora-send
 *   3b.node scripts/stage-bundle-assets.mjs --strict → src-tauri/bundle-assets/
 *      （把 mcp / skills / 可选 sidecar 打进桌面安装包的资源目录，须早于 tauri build）
 *   4. 清空 bundle 目录后 bun run tauri:build → src-tauri/target/release/bundle/**
 *      （--skip-tauri 跳过清空与构建，复用已有产物）
 *   5. 只收集文件名匹配当前版本的安装包 → dist-release/<version>/，
 *      打包 dist-release/reqora-<version>-release.zip
 *      （内含安装包 + reqora-mcp.mjs + reqora-send + skills/ + dist-update/update.json，如已生成）
 *   6. node scripts/pack-update.mjs → dist-update/<zip> + manifest.json（Windows）
 *   7. node scripts/update-sign.mjs → dist-update/update.json
 *   8. node scripts/sign-update-manifest.mjs --verify 自检 update.json
 *
 * 环境变量（见 .env.example）：
 *   REQORA_UPDATE_SIGNING_KEY   Ed25519 签名 seed；也支持 ~/.reqora/update-signing.key
 *   REQORA_RELEASE_URL_BASE     发布地址，决定更新清单里的下载 URL（须 HTTPS）
 *   REQORA_COLLAB_SERVER_URL    构建期注入到前端的默认协作服务器地址
 *   REQORA_UPDATE_PUBLIC_KEY    验签公钥；发布时按签名私钥自动同步
 *
 * 私钥缺失时会自动生成到 ~/.reqora/update-signing.key（0600），不再静默跳过签名。
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  loadReleaseEnv,
  normalizeUrlBase,
  resolveSigningKey,
  syncUpdateTrustRoot,
} from "./release-env.mjs";
import {
  applyVersion,
  readCurrentVersion,
  resolveReleaseVersion,
} from "./release-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name) => args.includes(name);

if (has("--help")) {
  console.log(`用法：node scripts/release.mjs [选项]
  --fast / --skip-tests / --skip-tauri / --skip-engine  跳过耗时步骤
  --notes <文本>                        更新清单发布说明
  --days <天数>                         清单有效期（默认 365）
  --version <x.y.z>                     指定版本号；默认在当前版本上把 patch 位 +1
  --url-base <HTTPS 地址>               覆盖 REQORA_RELEASE_URL_BASE
  --key <路径|64hex>                    覆盖签名私钥来源
  --no-sync-public-key                  不改写内置验签公钥常量
  --no-keygen                           私钥缺失时不自动生成
  --allow-unsigned                      仅配合 --no-keygen 时允许无签名发布
  --help                                显示本帮助`);
  process.exit(0);
}

const skipTauri = has("--skip-tauri");
const skipTests = has("--skip-tests");
const allowUnsigned = has("--allow-unsigned");
const noSyncPublicKey = has("--no-sync-public-key");
const notes = flag("--notes") ?? "";
const days = flag("--days") ?? "365";

// ---- 0a. 版本号：默认 patch 位 +1，或 --version 显式指定 ------------------
// 必须在任何构建之前写回全部权威来源（Tauri 配置、三个 Cargo.toml、
// build.gradle.kts、MCP 运行时、Cargo.lock），否则会出现产物版本漂移：
// 安装包叫 0.0.2 但应用内 / MCP 握手仍报 0.0.1。同一事务先算后写，
// 中途发现版本不一致立即中止，不留「改了一半」的仓库。
const currentVersion = readCurrentVersion(root);
let target;
try {
  target = resolveReleaseVersion(currentVersion, flag("--version"));
} catch (error) {
  console.error(`[release] ✗ ${error.message}`);
  process.exit(1);
}
let version;
try {
  const applied = applyVersion(root, target.version, currentVersion);
  version = applied.to;
  if (applied.files.length) {
    const how = target.source === "explicit" ? "--version 指定" : "patch 位自增";
    console.log(
      `[release] 版本号：${applied.from} → ${applied.to}（${how}），已同步 ${applied.files.length} 处版本来源`,
    );
  } else {
    console.log(`[release] 版本号：${version}（与当前一致，未改动版本文件）`);
  }
} catch (error) {
  console.error(`[release] ✗ ${error.message}`);
  process.exit(1);
}

const run = (label, command, cmdArgs, options = {}) => {
  console.log(`\n[release] ▶ ${label}: ${command} ${cmdArgs.join(" ")}`.trimEnd());
  const result = spawnSync(command, cmdArgs, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    console.error(`[release] ✗ ${label} 失败（exit=${result.status}）`);
    process.exit(result.status ?? 1);
  }
};

const started = Date.now();
console.log(`[release] Reqora v${version} 一键打包开始`);

// ---- 0. 发布环境 / 签名密钥 / 验签信任根 -----------------------------------
// 必须早于 tauri build：客户端内置的验签公钥要随本次私钥一起编译进产物。

const envInfo = loadReleaseEnv(root);
console.log(`[release] 环境文件：${envInfo.loaded.join("、") || "（无，使用进程环境变量）"}`);

const urlBase =
  normalizeUrlBase(flag("--url-base")) ??
  normalizeUrlBase(process.env.REQORA_RELEASE_URL_BASE) ??
  undefined;
if (!urlBase) {
  console.log(
    "[release] ⚠ 未配置 REQORA_RELEASE_URL_BASE，更新清单下载地址将退回示例占位；\n" +
      "          发布前请在 .env.production 填好 HTTPS 发布地址（或传 --url-base）。",
  );
}

const signing = resolveSigningKey({ key: flag("--key"), autoGenerate: !has("--no-keygen") });
if (!signing) {
  if (!allowUnsigned) {
    console.error(
      "[release] ✗ 找不到 Ed25519 签名私钥。请设置 REQORA_UPDATE_SIGNING_KEY、" +
        '放到 ~/.reqora/update-signing.key，或运行 "bun run update:keygen"。',
    );
    process.exit(1);
  }
  console.log("[release] ⚠ --allow-unsigned 已生效：本次发布不生成签名更新清单。");
} else {
  console.log(
    `[release] 签名私钥来源：${signing.source}` +
      (signing.generated ? "（本次新建，请备份 ~/.reqora/update-signing.key）" : ""),
  );
  if (noSyncPublicKey) {
    process.env.REQORA_UPDATE_PUBLIC_KEY = signing.publicHex;
    console.log("[release] ⚠ --no-sync-public-key：跳过内置公钥同步，请自行确认客户端信任根一致。");
  } else {
    const synced = syncUpdateTrustRoot({ root, publicHex: signing.publicHex });
    console.log(`[release] 验签公钥：${signing.publicHex}`);
    console.log(`[release] 信任根同步：${synced.changed.join("、") || "已一致，无需写盘"}`);
    // 曾经因为同步目标指向重构前的旧路径而静默跳过：签名用的是新私钥，
    // 客户端却仍编译着旧公钥，产物能通过自检却无法用于自更新。宁可中止。
    // 只把「内置信任根」视为致命；.env.production 是可选的本地文件。
    if (synced.critical.length) {
      console.error(
        `[release] ✗ 以下内置信任根未能同步：${synced.critical.join("、")}。\n` +
          "          请确认客户端内置公钥常量路径与本次签名私钥一致后再发版。",
      );
      process.exit(1);
    }
    if (synced.skipped.length) {
      console.log(`[release] ⚠ 可选信任根未同步：${synced.skipped.join("、")}`);
    }
  }
}

// ---- 1. 前置校验 ------------------------------------------------------------

if (!has("--fast")) run("typecheck", "bun", ["run", "typecheck"]);
// 直接调用跨平台测试入口，不经过 bun run：Bun Shell 在 Windows 上无法解释
// package.json 脚本里的 `ls | grep` 管道，命令替换变空会让 node --test 退化成
// 全仓库自动发现，误把构建报告里的浏览器 JS 当测试文件执行。
// 用 all 而非 unit：发布门禁历来覆盖全部测试文件（含 e2e 三件套），不降级。
if (!skipTests) run("全量测试", "node", ["scripts/run-tests.mjs", "all"]);

// ---- 2. MCP 单文件打包 ------------------------------------------------------

run("MCP 单文件打包", "node", ["scripts/build-mcp.mjs", "--check"]);

// ---- 3. 请求引擎 sidecar（CLI / MCP 与桌面共用同一条发送链）---------------
// 桌面端链接 reqora-core rlib，CLI / MCP 则通过 reqora-send NDJSON 进程调用
// 同一个 HttpService，因此发布包必须同时带上这个二进制。
const engineExe = process.platform === "win32" ? "reqora-send.exe" : "reqora-send";
const engineSrc = path.join(root, "dist-engine", `${process.platform}-${process.arch}`, engineExe);
if (!has("--skip-engine")) {
  run("请求引擎 sidecar 构建", "node", ["scripts/build-engine.mjs", "--check"]);
} else if (!existsSync(engineSrc)) {
  console.error("[release] ✗ --skip-engine 需要 dist-engine/ 已有产物");
  process.exit(1);
}

// ---- 3b. 桌面安装包内置资源（mcp / skills / 可选 sidecar）-------------------
// 必须早于 tauri build：bundle.resources 指向 src-tauri/bundle-assets，
// 这里把版本相关的 MCP bundle、SKILL.md、sidecar 复制进去并写 manifest。
run("打包内置资源", "node", ["scripts/stage-bundle-assets.mjs", "--strict"]);

// ---- 4. 桌面端构建 ----------------------------------------------------------
// Tauri 的 bundle 目录按版本号命名输出，且不会自动清理上一次构建的安装包。
// 构建前清空，避免旧版本 exe/msi/dmg 被下一步误收进当前版本发布包。
const bundleRoot = path.join(root, "src-tauri", "target", "release", "bundle");

if (!skipTauri) {
  rmSync(bundleRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  run("桌面端构建", "bun", ["run", "tauri:build"]);
} else if (!existsSync(path.join(root, "src-tauri", "target", "release"))) {
  console.error("[release] --skip-tauri 需要 src-tauri/target/release 已有构建产物");
  process.exit(1);
}

// ---- 5. 收集安装包并打可发布 zip --------------------------------------------

const outDir = path.join(root, "dist-release", version);
rmSync(outDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
mkdirSync(outDir, { recursive: true });

const INSTALLER_DIRS = [
  ["nsis", ".exe"],
  ["msi", ".msi"],
  ["dmg", ".dmg"],
  ["deb", ".deb"],
  ["rpm", ".rpm"],
  ["appimage", ".AppImage"],
];
// 文件名形如 Reqora_0.0.0_x64-setup.exe / Reqora_0.0.0_aarch64.dmg。
// 用分隔符锚定版本号：既不把 0.0.10 误当成 0.0.1，也拒绝 0.0.4 这类旧产物。
const versionPattern = new RegExp(`(?:^|[_-])${version.replaceAll(".", "\\.")}(?:[_-]|$)`);
const installers = [];
const staleInstallers = [];
for (const [dir, ext] of INSTALLER_DIRS) {
  const dirPath = path.join(bundleRoot, dir);
  if (!existsSync(dirPath)) continue;
  for (const file of readdirSync(dirPath)) {
    if (!file.endsWith(ext)) continue;
    if (!versionPattern.test(file)) {
      staleInstallers.push(file);
      continue;
    }
    copyFileSync(path.join(dirPath, file), path.join(outDir, file));
    installers.push(path.join(outDir, file));
  }
}
if (staleInstallers.length) {
  console.log(
    `[release] 跳过 ${staleInstallers.length} 个非 v${version} 的旧安装包：${staleInstallers.join("、")}`,
  );
}
if (installers.length === 0) {
  if (!skipTauri || staleInstallers.length) {
    console.error(
      `[release] ✗ bundle 目录里没有找到 v${version} 的安装包` +
        (skipTauri
          ? "（--skip-tauri 不会重新构建，请先清理并构建对应版本）"
          : "，请检查 tauri build 产物"),
    );
    process.exit(1);
  }
  console.log("[release] ⚠ 未找到安装包（--skip-tauri），本次仅打包 MCP / skills / 更新清单。");
}

// ---- 5. Windows 自更新包 + 更新清单 ----------------------------------------

const distUpdate = path.join(root, "dist-update");
let updateJsonPath = null;
const exePath = path.join(root, "src-tauri", "target", "release", "reqora.exe");
if (process.platform === "win32" && existsSync(exePath)) {
  const packArgs = ["scripts/pack-update.mjs", "--out-dir", "dist-update"];
  if (notes) packArgs.push("--notes", notes);
  if (urlBase) packArgs.push("--url-base", urlBase);
  run("更新包打包", "node", packArgs);

  // 签名私钥已在 step 0 解析并注入子进程环境；这里不再「缺钥匙就静默跳过」。
  if (signing) {
    updateJsonPath = path.join(distUpdate, "update.json");
    run("更新清单签名", "node", [
      "scripts/update-sign.mjs",
      path.join(distUpdate, "manifest.json"),
      "--out", updateJsonPath,
      "--days", days,
    ]);
    run("更新清单自检", "node", ["scripts/sign-update-manifest.mjs", "--verify", updateJsonPath]);
  } else {
    console.log(
      "\n[release] ⚠ 本次未生成签名 update.json（--allow-unsigned / --no-keygen）。\n" +
        "          该产物不可用于客户端自更新；单独签名：bun run update:sign -- dist-update/manifest.json\n",
    );
  }
} else {
  console.log("\n[release] ⚠ 非 Windows 环境或缺少 reqora.exe，跳过自更新包（自更新目前仅覆盖 Windows）。");
}

// ---- 6. 可发布 zip ----------------------------------------------------------
// zip 内保留目录结构：安装包 / reqora-mcp.mjs / reqora-send 在根，skills 在
// skills/ 下，与安装版 ~/.reqora/skills/<name>/SKILL.md 的布局一致。
const mcpFile = path.join(root, "dist-mcp", "mcp.mjs");
if (existsSync(mcpFile)) {
  copyFileSync(mcpFile, path.join(outDir, "reqora-mcp.mjs"));
}
if (existsSync(engineSrc)) {
  copyFileSync(engineSrc, path.join(outDir, engineExe));
}
const skillsOut = path.join(outDir, "skills");
rmSync(skillsOut, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
if (existsSync(path.join(root, "skills"))) {
  cpSync(path.join(root, "skills"), skillsOut, { recursive: true });
}
// Copy update.json into outDir so every zip input is relative to outDir on
// non-Windows (zip -r would otherwise store an absolute path prefix).
const zippedUpdate = path.join(outDir, "update.json");
if (updateJsonPath && existsSync(updateJsonPath)) {
  copyFileSync(updateJsonPath, zippedUpdate);
}

const zipName = `reqora-${version}-release.zip`;
const zipPath = path.join(root, "dist-release", zipName);
const zipInputs = [...installers];
if (existsSync(path.join(outDir, "reqora-mcp.mjs"))) zipInputs.push(path.join(outDir, "reqora-mcp.mjs"));
if (existsSync(path.join(outDir, engineExe))) zipInputs.push(path.join(outDir, engineExe));
if (existsSync(skillsOut)) zipInputs.push(skillsOut);
if (existsSync(zippedUpdate)) zipInputs.push(zippedUpdate);

const parentArg = path.dirname(zipPath);
mkdirSync(parentArg, { recursive: true });
if (process.platform === "win32") {
  // Compress-Archive with a directory input keeps its structure; file inputs
  // are placed at the zip root. Quoting each path keeps spaces safe.
  const psCommand = `Compress-Archive -Path '${zipInputs.map((p) => p.replaceAll("'", "''")).join("','")}' -DestinationPath '${zipPath}' -Force`;
  run("发布 zip", "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCommand]);
} else {
  // All inputs now live under outDir; zip -r keeps skills/ as a subdirectory.
  const rel = zipInputs.map((p) => path.relative(outDir, p));
  run("发布 zip", "zip", ["-r", zipPath, ...rel], { cwd: outDir });
}

// ---- 7. 汇总 ----------------------------------------------------------------

const sizeOf = (file) => `${(statSync(file).size / 1024 / 1024).toFixed(2)} MiB`;
console.log(`
[release] 完成 ✓（耗时 ${((Date.now() - started) / 1000).toFixed(0)}s）
  安装包目录 : ${outDir}
${installers.map((file) => `    - ${path.basename(file)}  (${sizeOf(file)})`).join("\n") || "    （无安装包）"}
  发布 zip   : ${zipPath}  (${sizeOf(zipPath)})
  MCP 单文件 : ${path.join(root, "dist-mcp", "mcp.mjs")}（已复制为 ${path.join(outDir, "reqora-mcp.mjs")}）
  Skills     : ${skillsOut}（已随 zip 与桌面安装包分发）
  内置资源   : ${path.join(root, "src-tauri", "bundle-assets")}（首次启动写入 ~/.reqora/{mcp,skills,bin}）
${updateJsonPath
    ? `  更新包     : ${path.join(distUpdate, `reqora-${version}-x64-update.zip`)}\n  更新清单   : ${updateJsonPath}（Ed25519 已签名并自检通过）`
    : "  更新清单   : 未签名（见上方提示）"}
  发布地址   : ${urlBase ?? "（未配置 REQORA_RELEASE_URL_BASE，清单仍指向示例占位地址）"}
  清单地址   : ${urlBase ? `${urlBase}/update.json` : "（未配置）"}
`);
