#!/usr/bin/env node
// Reqora 单向 Git 镜像写盘 CLI（T2.3）。
//
// 把当前工作区快照经 src/lib/gitMirror.ts 渲染成 reqora.*.yaml，原子写入
// --out 目录，并附一份 MANIFEST。刻意只写不读：SQLite 仍是唯一真相源，
// 这里不实现 importer / 反向同步，不触发云同步、不调用任何同步 API。
//
// 用法：
//   node bin/git-mirror.mjs --out <dir> [--workspace <路径>|--snapshot <file>]
//   node bin/git-mirror.mjs --out <dir> --check        # 只比对差异，不写盘，供 CI
//   node bin/git-mirror.mjs --help
//
// 工作区加载：参考 bin/reqora.mjs 的 loadContext 与 bin/vault.mjs。
//   - 默认走 WorkspaceStore.open(...).readSnapshot()（内部经 vault.mjs 的
//     openAtRest 打开静态加密的凭据，再由 gitMirror 的 redactSnapshot 重新
//     打码后写入 YAML）；--workspace 可指定项目目录 / id / 名称。
//   - --snapshot <file> 直接读取一份裸 JSON 快照（CI / 测试用，绕过桌面端
//     数据目录与 keychain，便于在无 GUI 环境下复现）。
// 本模块把纯逻辑导出供 node --test 直接 import；CLI 入口放在文件末尾的
// import.meta.url 判断之后。

import {
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "./atomicWrite.mjs";
import {
  GIT_MIRROR_MANIFEST,
  GIT_MIRROR_MANIFEST_FILE,
  GIT_MIRROR_UNSYNCED,
  renderGitMirror,
} from "../src/lib/gitMirror.ts";

// ------------------------------------------------------------- 参数解析 ----

export function parseMirrorArgs(argv) {
  const args = {
    out: resolve(process.cwd()),
    check: false,
    help: false,
    workspace: undefined,
    snapshot: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--out") args.out = resolve(argv[++index] ?? "");
    else if (token === "--workspace" || token === "-w") args.workspace = argv[++index];
    else if (token === "--snapshot") args.snapshot = resolve(argv[++index] ?? "");
    else if (token === "--check") args.check = true;
    else if (token === "--help" || token === "-h") args.help = true;
  }
  return args;
}

export function usage() {
  return `Reqora 单向 Git 镜像（只写不读，SQLite 仍是唯一真相源）

用法：
  node bin/git-mirror.mjs --out <dir> [选项]     渲染并原子写入 reqora.*.yaml + MANIFEST
  node bin/git-mirror.mjs --out <dir> --check    只比对已有文件是否有差异，不写盘（CI 用）
  node bin/git-mirror.mjs --help

选项：
  --out <dir>          输出目录（默认当前工作目录）
  --workspace <路径>    项目数据目录 / 项目 id / 名称（默认桌面端当前项目；参考 reqora.mjs）
  --snapshot <file>    直接读取裸 JSON 快照文件（CI / 测试，绕过桌面端数据目录）
  --check              比对已有文件：一致退出 0，有差异 / 缺失退出 1，不写盘

说明：
  - 只写不读：本命令不实现 importer / 反向同步，不触发云同步、不调用同步 API。
  - 不镜像的本机专属域：${GIT_MIRROR_UNSYNCED.join("、")}。
  - 私密变量只写变量名，token / Cookie / 凭据值不写入；内容按 id 稳定排序。
  - 原子写盘：先写同名 .tmp 临时文件再 rename，避免留下半截文件。`;
}

// --------------------------------------------------------------- 纯逻辑 ----

/** 完整写盘计划：7 份 YAML + 一份 MANIFEST。相对路径 → 文本。 */
export function buildMirrorPlan(snapshot) {
  return {
    ...renderGitMirror(snapshot),
    [GIT_MIRROR_MANIFEST_FILE]: GIT_MIRROR_MANIFEST,
  };
}

/** 比对已有文件（不写盘）。返回 { ok, diffs }。 */
export function compareMirror(outDir, files) {
  const diffs = [];
  for (const [name, text] of Object.entries(files)) {
    const target = join(outDir, name);
    if (!existsSync(target)) {
      diffs.push({ file: name, reason: "missing" });
      continue;
    }
    let current = "";
    try {
      current = readFileSync(target, "utf8");
    } catch {
      current = "";
    }
    if (current !== text) diffs.push({ file: name, reason: "changed" });
  }
  return { ok: diffs.length === 0, diffs };
}

/** 原子写入：先写 .tmp 再 rename。返回已写文件列表。 */
export function writeMirrorAtomic(outDir, files) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [name, text] of Object.entries(files)) {
    writeFileAtomic(join(outDir, name), text);
    written.push(name);
  }
  return written;
}

/** 加载快照：--snapshot 裸读，否则走 WorkspaceStore（参考 loadContext / vault）。 */
export async function loadSnapshot(args) {
  if (args.snapshot) {
    return JSON.parse(readFileSync(args.snapshot, "utf8"));
  }
  const { WorkspaceStore } = await import("./workspaceStore.mjs");
  const store = WorkspaceStore.open(args.workspace);
  try {
    return await store.readSnapshot();
  } finally {
    store.close();
  }
}

// --------------------------------------------------------------- CLI 入口 ----

async function main(argv) {
  const args = parseMirrorArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  let snapshot;
  try {
    snapshot = await loadSnapshot(args);
  } catch (error) {
    console.error(`无法加载工作区：${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const files = buildMirrorPlan(snapshot);

  if (args.check) {
    const { ok, diffs } = compareMirror(args.out, files);
    if (ok) {
      console.log(`✓ 镜像与 ${args.out} 中已有文件一致（${Object.keys(files).length} 个文件）`);
      return 0;
    }
    console.error(`✗ 镜像有差异（${diffs.length} 个文件）：`);
    for (const diff of diffs) console.error(`  - ${diff.file}: ${diff.reason}`);
    return 1;
  }

  const written = writeMirrorAtomic(args.out, files);
  console.log(`✓ 已原子写入 ${written.length} 个镜像文件到 ${args.out}`);
  console.log("  只写不读：SQLite 仍是唯一真相源；本目录未触发任何同步。");
  return 0;
}

const isMain =
  !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = await main(process.argv.slice(2));
}
