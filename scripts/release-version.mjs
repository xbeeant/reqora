#!/usr/bin/env node
/**
 * release 版本号解析 / 递增 / 写回。
 *
 * 版本号是这个仓库里的一个「分布式常量」：桌面壳、Tauri 配置、Rust 引擎、
 * 服务端、MCP 运行时各自持有一份。发版时若只改 package.json，产物会出现
 * 「安装包叫 0.0.2 但关于页 / MCP 握手仍报 0.0.1」的版本漂移。本模块是
 * 这些权威来源的唯一写回点，被 release.mjs 在构建之前调用。
 *
 * 策略：
 *   - 默认：把当前 patch 位 +1（0.0.1 → 0.0.2），符合 semver；
 *   - 显式：`--version <x.y.z>` 由用户指定，原样采用（校验格式）。
 *
 * 不在这里改 CHANGELOG / docs 里的历史版本叙述：那些是给读者看的记录，
 * 不是构建产物读取的版本常量，自动改写会破坏历史事实（见测试）。
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 语义化版本：纯 x.y.z，与项目当前口径一致，不接受 v 前缀 / prerelease。 */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** 校验并归一化版本号；非法输入抛错（含错误说明）。返回规范化字符串。 */
export function parseVersion(input, label = "版本号") {
  if (typeof input !== "string") {
    throw new Error(`${label}必须是字符串，收到 ${typeof input}`);
  }
  const trimmed = input.trim();
  const match = SEMVER.exec(trimmed);
  if (!match) {
    throw new Error(
      `${label} "${input}" 非法：需要 x.y.z 形式（如 1.2.3），不接受 v 前缀、预发布或构建元数据`,
    );
  }
  // 去掉前导零，保证 01.2.3 与 1.2.3 是同一版本；数值必须安全整数。
  const parts = match.slice(1).map((segment) => {
    const value = Number(segment);
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${label} "${input}" 的数值段超出安全整数范围`);
    }
    return value;
  });
  return parts.join(".");
}

/** patch 位 +1；major/minor 不变。这是 release 的默认递增策略。 */
export function bumpPatch(version) {
  const [major, minor, patch] = parseVersion(version).split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * 决定本次发版的目标版本。
 * @param currentVersion 当前 package.json 版本（已校验）
 * @param requested      用户 --version 传入值，undefined / 空串表示「默认自增」
 * @returns {{ version: string, source: "bump" | "explicit" }}
 */
export function resolveReleaseVersion(currentVersion, requested) {
  const current = parseVersion(currentVersion, "当前版本号");
  if (requested === undefined || requested === null || String(requested).trim() === "") {
    return { version: bumpPatch(current), source: "bump" };
  }
  return { version: parseVersion(requested, "指定的版本号"), source: "explicit" };
}

/**
 * 版本写回目标。每项用正则精确替换「唯一的一处」版本字面量，避免误伤
 * 依赖版本（如 Cargo.toml 里大量的 `version = "1"`）或文档里的历史条目。
 * `expect` 用于确认旧值与当前 package.json 一致；不一致说明仓库版本已被
 * 部分改动，直接中止而不是把不一致扩散到更多文件。
 */
const VERSION_TARGETS = [
  {
    file: "package.json",
    expect: (v) => `"version": "${v}"`,
    replace: (src, oldV, newV) => replaceOnce(src, `"version": "${oldV}"`, `"version": "${newV}"`, "package.json"),
  },
  {
    file: "src-tauri/tauri.conf.json",
    expect: (v) => `"version": "${v}"`,
    replace: (src, oldV, newV) =>
      replaceOnce(src, `"version": "${oldV}"`, `"version": "${newV}"`, "tauri.conf.json"),
  },
  {
    file: "src-tauri/Cargo.toml",
    // 只匹配 [package] 段的行首 version，不动依赖里的 `version = "1"`。
    expect: (v) => `version = "${v}"`,
    replace: (src, oldV, newV) =>
      replaceOnce(src, `version = "${oldV}"`, `version = "${newV}"`, "Cargo.toml"),
  },
  {
    file: "src-tauri/crates/reqora-core/Cargo.toml",
    expect: (v) => `version = "${v}"`,
    replace: (src, oldV, newV) =>
      replaceOnce(src, `version = "${oldV}"`, `version = "${newV}"`, "reqora-core/Cargo.toml"),
  },
  {
    file: "src-tauri/crates/reqora-send/Cargo.toml",
    expect: (v) => `version = "${v}"`,
    replace: (src, oldV, newV) =>
      replaceOnce(src, `version = "${oldV}"`, `version = "${newV}"`, "reqora-send/Cargo.toml"),
  },
  {
    file: "server/build.gradle.kts",
    expect: (v) => `version = "${v}"`,
    replace: (src, oldV, newV) =>
      replaceOnce(src, `version = "${oldV}"`, `version = "${newV}"`, "build.gradle.kts"),
  },
  {
    file: "bin/mcpServer.mjs",
    expect: (v) => `version: "${v}"`,
    replace: (src, oldV, newV) =>
      replaceOnce(src, `version: "${oldV}"`, `version: "${newV}"`, "mcpServer.mjs"),
  },
  {
    file: "src-tauri/Cargo.lock",
    // workspace 三个包各自有 version 行；依赖里同版本字面量也可能出现，
    // 因此只替换 `name = "<pkg>"` 紧随其后的那一行（见 replaceAllWorkspacePkgs）。
    expect: () => null, // 由 replaceAllWorkspacePkgs 自行核对
    replace: (src, oldV, newV) => replaceWorkspaceLock(src, oldV, newV),
  },
];

/** 替换且仅替换一次；找不到或找到多处都视为异常，避免静默错改。 */
function replaceOnce(source, from, to, label) {
  const first = source.indexOf(from);
  if (first < 0) {
    throw new Error(`写回版本失败：${label} 中找不到 "${from}"（版本来源可能已漂移）`);
  }
  if (source.indexOf(from, first + from.length) >= 0) {
    throw new Error(`写回版本失败：${label} 中 "${from}" 出现多处，拒绝猜测替换`);
  }
  return source.slice(0, first) + to + source.slice(first + from.length);
}

/** Cargo.lock 里只改 workspace 三个包自己的 version，不动第三方依赖。 */
function replaceWorkspaceLock(source, oldV, newV) {
  let result = source;
  for (const name of ["reqora", "reqora-core", "reqora-send"]) {
    const anchor = `name = "${name}"\nversion = "${oldV}"`;
    const replacement = `name = "${name}"\nversion = "${newV}"`;
    result = replaceOnce(result, anchor, replacement, `Cargo.lock (${name})`);
  }
  return result;
}

/**
 * 从 package.json 读取当前版本。
 */
export function readCurrentVersion(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  return parseVersion(pkg.version, "package.json 的 version");
}

/**
 * 把 newVersion 原子写回所有权威来源：先全部读+算出新内容，全部成功后再
 * 统一落盘，避免中途失败造成「改了一半」的不一致状态。
 *
 * @returns {{ from: string, to: string, files: string[] }}
 */
export function applyVersion(root, newVersion, fromVersion = readCurrentVersion(root)) {
  const to = parseVersion(newVersion, "目标版本号");
  const from = parseVersion(fromVersion, "旧版本号");
  if (to === from) return { from, to, files: [] };

  const staged = [];
  for (const target of VERSION_TARGETS) {
    const abs = path.join(root, target.file);
    const source = readFileSync(abs, "utf8");
    // 除 Cargo.lock 外，先确认旧版本确实就位；否则中止。
    if (target.expect(from) && !source.includes(target.expect(from))) {
      throw new Error(
        `写回版本失败：${target.file} 不含旧版本 ${from}，仓库版本可能已被部分修改`,
      );
    }
    stagingPush(staged, abs, target.replace(source, from, to));
  }
  for (const [abs, content] of staged) writeFileSync(abs, content, "utf8");
  return { from, to, files: VERSION_TARGETS.map((target) => target.file) };
}

function stagingPush(staged, abs, content) {
  staged.push([abs, content]);
}

/** 供 --help / 日志展示：会被写回的文件清单。 */
export const VERSION_FILES = VERSION_TARGETS.map((target) => target.file);
