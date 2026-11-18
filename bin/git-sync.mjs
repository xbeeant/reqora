#!/usr/bin/env node
/**
 * Git-native bidirectional sync CLI — the same pure logic the desktop uses.
 *
 *   node bin/git-sync.mjs check      --out DIR --snapshot FILE
 *   node bin/git-sync.mjs push       --out DIR --snapshot FILE
 *   node bin/git-sync.mjs pull       --out DIR [--snapshot FILE] --write-snapshot FILE
 *   node bin/git-sync.mjs sync       --out DIR --snapshot FILE --write-snapshot FILE \
 *                                     [--pull] [--commit] [--push] [--resolutions FILE]
 *   node bin/git-sync.mjs to-server  --out DIR --rows-out FILE
 *   node bin/git-sync.mjs to-git     --rows-in FILE --out DIR
 *   node bin/git-sync.mjs status     --out DIR
 *
 * `--snapshot` is a workspace snapshot JSON (the same shape the desktop stores).
 * Without it, the CLI reads the active local project via `WorkspaceStore` (or
 * `--workspace <path|id|name>`). Merged snapshots are written with
 * `--write-snapshot` as JSON; they can be imported into the desktop app or fed
 * back into `push`. Nothing writes to the project SQLite behind the app's back.
 *
 * The per-directory three-way merge baseline is kept outside the Git tree at
 * ~/.reqora/git-sync/<dir hash>.json, so it is never committed.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  diffGitSyncFiles,
  gitFilesToServerRows,
  isGitSyncFileName,
  planGitSync,
  serverRowsToGitFiles,
  snapshotToGitFiles,
} from "../src/lib/gitNative.ts";
import { projectGitSyncRows } from "../src/lib/gitMirror.ts";
import { emptySnapshot, normalizeSnapshot } from "../src/lib/defaults.ts";
import { WorkspaceStore } from "./workspaceStore.mjs";

const HELP = `Reqora Git-native 同步 CLI（与桌面端共用同一套三方合并逻辑）

用法:
  node bin/git-sync.mjs <command> [选项]

命令:
  check       比对磁盘文件与快照渲染结果，发现漂移退出码 1（供 CI 使用）
  push        快照 → Git-native 同步文件（服务端/本地 → Git 转换）
  pull        Git-native 同步文件 → 快照 JSON（--write-snapshot）
  sync        三方合并双向同步，同时更新文件与快照 JSON
  to-server   Git 文件 → 可上传协作后端的脱敏行集 JSON（--rows-out）
  to-git      服务端行集 JSON → Git-native 同步文件（--rows-in）
  status      显示目录里的 Git 仓库 / 同步文件状态

通用选项:
  --out, -o <dir>          同步文件目录（必填）
  --snapshot, -s <file>    工作区快照 JSON；缺省读当前 CLI 工作区
  --workspace <path|id>    CLI 工作区（配合 --snapshot 缺省时使用）
  --write-snapshot <file>  pull/sync 写出合并后的快照 JSON
  --rows-out <file>        to-server 写出的行集 JSON
  --rows-in <file>         to-git 读入的行集 JSON
  --resolutions <file>     冲突裁决 JSON：{ "requests:<id>": "local" | "git" }
  --message <text>         --commit 的提交信息
  --pull / --commit / --push   sync 期间执行对应 git 动作（显式开启）
  --help, -h               显示本帮助

示例:
  node bin/git-sync.mjs push --out ./api-spec --snapshot ./workspace.json
  node bin/git-sync.mjs sync --out ./api-spec --snapshot ./workspace.json \\
      --write-snapshot ./merged.json --pull --commit
  node bin/git-sync.mjs to-server --out ./api-spec --rows-out ./rows.json
`;

function parseArgv(argv) {
  const first = argv[0] ?? "";
  const out = {
    command: first.startsWith("-") || first === "help" ? "" : first,
    out: "",
    snapshot: "",
    workspace: "",
    writeSnapshot: "",
    rowsOut: "",
    rowsIn: "",
    resolutions: "",
    message: "",
    pull: false,
    commit: false,
    push: false,
    help: false,
  };
  const takesValue = new Set([
    "--out", "-o", "--snapshot", "-s", "--workspace", "--write-snapshot",
    "--rows-out", "--rows-in", "--resolutions", "--message",
  ]);
  const aliases = {
    "--out": "out", "-o": "out",
    "--snapshot": "snapshot", "-s": "snapshot",
    "--workspace": "workspace",
    "--write-snapshot": "writeSnapshot",
    "--rows-out": "rowsOut",
    "--rows-in": "rowsIn",
    "--resolutions": "resolutions",
    "--message": "message",
  };
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    const [flag, inline] = token.includes("=") && token.startsWith("--")
      ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)]
      : [token, undefined];
    if (takesValue.has(flag)) {
      out[aliases[flag]] = inline ?? argv[++i] ?? "";
      continue;
    }
    if (flag === "--help" || flag === "-h") out.help = true;
    else if (flag === "--pull") out.pull = true;
    else if (flag === "--commit") out.commit = true;
    else if (flag === "--push") out.push = true;
    else if (flag.startsWith("-")) throw new Error(`未知选项：${flag}`);
  }
  return out;
}

const fail = (message) => {
  throw new Error(message);
};

function readJson(file, label) {
  if (!file) fail(`缺少 ${label}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`无法读取 ${label} ${file}：${error.message}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function loadSnapshot(args) {
  if (args.snapshot) return normalizeSnapshot(readJson(args.snapshot, "工作区快照"));
  const store = WorkspaceStore.open(args.workspace || undefined);
  try {
    return await store.readSnapshot();
  } finally {
    store.close();
  }
}

function readFiles(dir) {
  if (!fs.existsSync(dir)) return {};
  const files = {};
  for (const name of fs.readdirSync(dir)) {
    if (!isGitSyncFileName(name)) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isFile()) files[name] = fs.readFileSync(full, "utf8");
  }
  return files;
}

function writeFiles(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const [name, text] of Object.entries(files)) {
    if (!isGitSyncFileName(name)) fail(`不允许写入的同步文件名：${name}`);
    const target = path.join(dir, name);
    const tmp = path.join(dir, `.${name}.reqora-tmp`);
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, target);
    written.push(name);
  }
  return written;
}

function statePath(dir) {
  const hash = createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 16);
  return path.join(os.homedir(), ".reqora", "git-sync", `${hash}.json`);
}

function loadBaseline(dir) {
  const file = statePath(dir);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw?.dir !== path.resolve(dir) || !raw.rows || !raw.files) return null;
    return { ...raw, conflicts: Array.isArray(raw.conflicts) ? raw.conflicts : [] };
  } catch {
    return null;
  }
}

function saveBaseline(dir, plan) {
  const file = statePath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, {
    dir: path.resolve(dir),
    files: plan.files,
    rows: plan.rows,
    conflicts: [],
    at: Date.now(),
  });
}

function git(dir, args, { fatal = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) {
    if (fatal) fail(`无法执行 git：${result.error.message}`);
    return { ok: false, text: result.error.message };
  }
  const text = (result.stdout || result.stderr || "").trim();
  if (result.status !== 0 && fatal) fail(`git ${args.join(" ")} 失败：${text}`);
  return { ok: result.status === 0, text };
}

function isRepo(dir) {
  return git(dir, ["rev-parse", "--is-inside-work-tree"]).ok;
}

function statusText(dir, files) {
  if (!isRepo(dir)) return "非 Git 仓库（文件同步仍可用）";
  const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).text;
  const porcelain = git(dir, ["status", "--porcelain", "--", "reqora.*.yaml", "reqora.MANIFEST.md"]).text;
  const changed = porcelain ? porcelain.split("\n").length : 0;
  return `分支 ${branch || "?"} · ${changed} 个同步文件有改动 · 目录内 ${Object.keys(files).length} 个同步文件`;
}

function readResolutions(file) {
  if (!file) return undefined;
  const raw = readJson(file, "裁决文件");
  const out = {};
  for (const [key, choice] of Object.entries(raw)) {
    if (choice === "local" || choice === "git") out[key] = choice;
  }
  return out;
}

function reportConflicts(conflicts) {
  process.stderr.write(`发现 ${conflicts.length} 处冲突，未写回文件：\n`);
  for (const conflict of conflicts) {
    process.stderr.write(`  ${conflict.domain}:${conflict.id}  ${conflict.name}\n`);
  }
  process.stderr.write("用 --resolutions 提供 {\"domain:id\":\"local|git\"} 后再同步。\n");
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help || args.command === "help" || !args.command) {
    process.stdout.write(HELP);
    return 0;
  }
  const commands = ["check", "push", "pull", "sync", "to-server", "to-git", "status"];
  if (!commands.includes(args.command)) fail(`未知命令：${args.command}`);
  if (!args.out) fail("缺少 --out <dir>");
  const dir = path.resolve(args.out);
  const files = readFiles(dir);

  switch (args.command) {
    case "status": {
      process.stdout.write(`${dir}\n${statusText(dir, files)}\n`);
      return 0;
    }

    case "check": {
      const snapshot = await loadSnapshot(args);
      const expected = snapshotToGitFiles(snapshot);
      const diffs = Object.keys(expected).filter((name) => expected[name] !== (files[name] ?? ""));
      if (diffs.length === 0) {
        process.stdout.write("OK：同步文件与工作区快照一致\n");
        return 0;
      }
      process.stderr.write(`发现 ${diffs.length} 个文件漂移：${diffs.join(", ")}\n`);
      return 1;
    }

    case "push": {
      const snapshot = await loadSnapshot(args);
      const expected = snapshotToGitFiles(snapshot);
      const changed = diffGitSyncFiles(files, expected);
      const written = writeFiles(dir, changed);
      saveBaseline(dir, {
        files: expected,
        rows: projectGitSyncRows(snapshot),
      });
      process.stdout.write(`已写出 ${written.length} 个文件（共 ${Object.keys(expected).length} 个，无变化 ${Object.keys(expected).length - written.length} 个）\n`);
      return 0;
    }

    case "pull": {
      const base = args.snapshot || args.workspace
        ? await loadSnapshot(args)
        : normalizeSnapshot(emptySnapshot());
      const plan = planGitSync(base, files, { baseline: loadBaseline(dir) });
      if (plan.conflicts.length) {
        reportConflicts(plan.conflicts);
        return 2;
      }
      if (!args.writeSnapshot) fail("pull 需要 --write-snapshot <file> 指定输出快照");
      writeJson(args.writeSnapshot, plan.snapshot);
      const written = writeFiles(dir, plan.changedFiles);
      saveBaseline(dir, plan);
      process.stdout.write(`已合并 ${plan.gitChanges} 行 Git 变更，快照写入 ${args.writeSnapshot}，更新 ${written.length} 个文件\n`);
      return 0;
    }

    case "sync": {
      const snapshot = await loadSnapshot(args);
      if (args.pull && isRepo(dir)) {
        const pulled = git(dir, ["pull", "--ff-only"]);
        if (!pulled.ok) process.stderr.write(`git pull 提示（不阻断同步）：${pulled.text}\n`);
      }
      const currentFiles = readFiles(dir);
      const plan = planGitSync(snapshot, currentFiles, {
        baseline: loadBaseline(dir),
        resolutions: readResolutions(args.resolutions),
      });
      if (plan.conflicts.length) {
        reportConflicts(plan.conflicts);
        return 2;
      }
      if (args.writeSnapshot) writeJson(args.writeSnapshot, plan.snapshot);
      const written = writeFiles(dir, plan.changedFiles);
      saveBaseline(dir, plan);
      if (args.commit) {
        const names = Object.keys(plan.files);
        git(dir, ["add", "--", ...names], { fatal: true });
        const quiet = git(dir, ["diff", "--cached", "--quiet"]);
        if (!quiet.ok) {
          git(dir, ["commit", "-m", args.message || "chore(reqora): sync workspace"], { fatal: true });
        }
      }
      if (args.push) git(dir, ["push"], { fatal: true });
      process.stdout.write(
        `同步完成：本地写入 ${plan.localChanges} 行 / Git 合并 ${plan.gitChanges} 行 / 更新 ${written.length} 个文件` +
        `${plan.warnings.length ? ` · 提示：${plan.warnings.join("；")}` : ""}\n`,
      );
      return 0;
    }

    case "to-server": {
      const rows = gitFilesToServerRows(files, Date.now());
      if (!rows) fail("目录里没有可转换的 Git-native 同步文件，请先执行 push / sync");
      if (!args.rowsOut) fail("缺少 --rows-out <file>");
      writeJson(args.rowsOut, rows);
      const count = Object.values(rows).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
      process.stdout.write(`已把 Git 文件转换为 ${count} 行脱敏行集（加盖迁移时间戳），写入 ${args.rowsOut}\n`);
      return 0;
    }

    case "to-git": {
      const rows = readJson(args.rowsIn, "服务端行集");
      const expected = serverRowsToGitFiles(rows);
      const written = writeFiles(dir, diffGitSyncFiles(files, expected));
      process.stdout.write(`已把服务端行集写出为 ${written.length} 个 Git-native 同步文件\n`);
      return 0;
    }
  }
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
