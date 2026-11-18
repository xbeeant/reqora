// Git-native 双向同步核心：稳定渲染 / YAML 反向解析 / 脱敏与凭据回填 /
// 基线三方合并 / 冲突裁决 / 删除传播 / 两条通道互转 / CLI 冒烟。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  GIT_MIRROR_MANIFEST_FILE,
  GIT_MIRROR_SCHEMA,
  GIT_SYNC_SCHEMA,
  projectGitSyncRows,
  renderGitMirror,
  renderGitSyncFilesFromRows,
} from "../src/lib/gitMirror.ts";
import {
  diffGitSyncFiles,
  gitFilesToServerRows,
  isGitSyncFileName,
  parseGitSyncFiles,
  planGitSync,
  serverRowsToGitFiles,
  snapshotToGitFiles,
  stampRowsForTransfer,
} from "../src/lib/gitNative.ts";
import { normalizeSnapshot, seedSnapshot } from "../src/lib/defaults.ts";
import { rowsToSnapshot, snapshotToRows } from "../src/lib/workspaceRows.ts";
import { rmTemp } from "../scripts/rm-temp.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
const baseSnapshot = () => normalizeSnapshot(seedSnapshot());
const baselineOf = (snapshot, files, dir = "test-dir") => ({
  dir,
  files,
  rows: projectGitSyncRows(snapshot),
  conflicts: [],
  at: 1,
});
const requestFile = "reqora.requests.yaml";

function onlyRequestName(snapshot, name) {
  const index = snapshot.collections[0].items.findIndex((item) => item.name === name);
  return index >= 0;
}

test("同步文件渲染稳定：8 个文件、schema 标记、连续两次逐字节一致", () => {
  const snap = baseSnapshot();
  const first = renderGitSyncFilesFromRows(projectGitSyncRows(snap));
  const second = renderGitSyncFilesFromRows(projectGitSyncRows(snap));
  assert.equal(Object.keys(first).length, 8);
  assert.deepEqual(first, second);
  assert.ok(first[requestFile].includes(GIT_SYNC_SCHEMA));
  assert.ok(first[requestFile].includes("updatedAt"));
  assert.ok(first[GIT_MIRROR_MANIFEST_FILE].includes("双向"));
  for (const text of Object.values(first)) assert.ok(text.endsWith("\n"));
  // 单项镜像仍保持只写不读的 v1 契约（时间戳被剔除）。
  const mirror = renderGitMirror(snap);
  assert.ok(mirror[requestFile].startsWith(`# ${GIT_MIRROR_SCHEMA}`));
  assert.ok(!mirror[requestFile].includes("1700000000002"));
  assert.equal(Object.keys(mirror).length, 7);
});

test("YAML 反向解析往返一致，支持嵌套对象数组", () => {
  const snap = baseSnapshot();
  const rows = projectGitSyncRows(snap);
  const files = renderGitSyncFilesFromRows(rows);
  const parsed = parseGitSyncFiles(files);
  assert.deepEqual(parsed.rows, rows);
  assert.equal(parsed.missing.length, 0);
  assert.equal(parsed.legacy, false);
  assert.ok(parsed.rows.requests.some((row) => Object.keys(row.data ?? {}).length > 3));
});

test("同步文件不泄露私密值，合并回工作区后本机凭据仍在", () => {
  const snap = baseSnapshot();
  const files = snapshotToGitFiles(snap);
  assert.ok(!Object.values(files).some((text) => text.includes("demo-token")));
  const plan = planGitSync(snap, files);
  assert.equal(plan.conflicts.length, 0);
  assert.equal(Object.keys(plan.changedFiles).length, 0);
  const value = plan.snapshot.environments[0].variables.find((v) => v.key === "token")?.value;
  assert.equal(value, "demo-token");
});

test("缺一个域文件时沿用基线，不误删整域数据", () => {
  const snap = baseSnapshot();
  const files = snapshotToGitFiles(snap);
  const baselineRows = projectGitSyncRows(snap);
  delete files[requestFile];
  const parsed = parseGitSyncFiles(files, baselineRows);
  assert.deepEqual(parsed.rows.requests, baselineRows.requests);
  assert.ok(parsed.warnings.some((line) => line.includes("reqora.requests.yaml")));
});

test("旧版单向镜像文件可作为首次导入素材（缺行协议列时给 warning）", () => {
  const snap = baseSnapshot();
  const mirror = renderGitMirror(snap);
  const parsed = parseGitSyncFiles(mirror);
  assert.equal(parsed.legacy, true);
  assert.ok(parsed.rows.requests.length > 0);
  assert.equal(typeof parsed.rows.requests[0].updatedAt, "number");
  assert.ok(parsed.warnings.some((line) => line.includes("单向镜像")));
});

test("空目录首次同步：导出全部文件，绝不把空目录解释成删除", () => {
  const snap = baseSnapshot();
  const plan = planGitSync(snap, {});
  assert.equal(plan.remoteFound, false);
  assert.equal(plan.conflicts.length, 0);
  assert.equal(Object.keys(plan.changedFiles).length, 8);
  assert.equal(Object.keys(plan.files).length, 8);
});

test("三方合并：仅 Git 改 / 仅本地改 / 双方都改产生冲突且冲突时不写文件", () => {
  const snap = baseSnapshot();
  const files = snapshotToGitFiles(snap);
  const baseline = baselineOf(snap, files);
  const gitFiles = clone(files);
  gitFiles[requestFile] = gitFiles[requestFile].replace("GET 请求示例", "GIT 改名");

  const gitOnly = planGitSync(snap, gitFiles, { baseline });
  assert.equal(gitOnly.conflicts.length, 0);
  assert.equal(gitOnly.gitChanges, 1);
  assert.equal(Object.keys(gitOnly.changedFiles).length, 0);
  assert.ok(onlyRequestName(gitOnly.snapshot, "GIT 改名"));

  const localSnap = clone(snap);
  localSnap.collections[0].items[0].name = "本地改名";
  localSnap.collections[0].items[0].updatedAt = Date.now() + 10_000;
  const localOnly = planGitSync(localSnap, files, { baseline });
  assert.equal(localOnly.conflicts.length, 0);
  assert.equal(localOnly.localChanges, 1);
  assert.ok(localOnly.changedFiles[requestFile]?.includes("本地改名"));

  const both = planGitSync(localSnap, gitFiles, { baseline });
  assert.equal(both.conflicts.length, 1);
  assert.equal(Object.keys(both.changedFiles).length, 0, "冲突时绝不写回文件");
  assert.ok(onlyRequestName(both.snapshot, "本地改名"), "冲突保留本地版本");
});

test("冲突裁决：用 Git / 用本地都能收敛并生成可写文件", () => {
  const snap = baseSnapshot();
  const files = snapshotToGitFiles(snap);
  const baseline = baselineOf(snap, files);
  const gitFiles = clone(files);
  gitFiles[requestFile] = gitFiles[requestFile].replace("GET 请求示例", "GIT 改名");
  const localSnap = clone(snap);
  localSnap.collections[0].items[0].name = "本地改名";
  localSnap.collections[0].items[0].updatedAt = Date.now() + 10_000;
  const both = planGitSync(localSnap, gitFiles, { baseline });
  const key = `${both.conflicts[0].domain}:${both.conflicts[0].id}`;

  const useGit = planGitSync(localSnap, gitFiles, { baseline, resolutions: { [key]: "git" } });
  assert.equal(useGit.conflicts.length, 0);
  assert.ok(onlyRequestName(useGit.snapshot, "GIT 改名"));

  const useLocal = planGitSync(localSnap, gitFiles, { baseline, resolutions: { [key]: "local" } });
  assert.equal(useLocal.conflicts.length, 0);
  assert.ok(onlyRequestName(useLocal.snapshot, "本地改名"));
  assert.ok(useLocal.changedFiles[requestFile]?.includes("本地改名"));
});

test("删除以墓碑行进入 Git 文件，并能传播到另一副本", () => {
  const snap = baseSnapshot();
  const doomed = snap.collections[0].items[0];
  const afterDelete = clone(snap);
  afterDelete.collections[0].items = afterDelete.collections[0].items.filter((item) => item.id !== doomed.id);
  afterDelete.tombstones = [{ kind: "request", id: doomed.id, updatedAt: Date.now() + 1000 }];
  const files = snapshotToGitFiles(afterDelete);
  assert.ok(files[requestFile].includes("deleted: true"));
  const plan = planGitSync(snap, files, { baseline: baselineOf(snap, snapshotToGitFiles(snap)) });
  assert.equal(plan.conflicts.length, 0);
  assert.ok(!plan.snapshot.collections[0].items.some((item) => item.id === doomed.id));
});

test("通道转换：Git → 服务端加盖迁移时间戳且不泄露凭据", () => {
  const snap = baseSnapshot();
  const files = snapshotToGitFiles(snap);
  const rows = gitFilesToServerRows(files, 1_900_000_000_000);
  assert.ok(rows.requests.length > 0);
  assert.equal(rows.requests[0].updatedAt, 1_900_000_000_000);
  assert.ok(!JSON.stringify(rows).includes("demo-token"));
  assert.equal(rows.meta, undefined);
  // 时间戳严格大于行集里已有的最大值，首次 LWW 上传必然本地获胜。
  const old = snapshotToRows(snap);
  old.requests[0].updatedAt = 1_900_000_000_500;
  const stamped = stampRowsForTransfer(old, 1_900_000_000_000);
  assert.ok(stamped.requests[0].updatedAt > 1_900_000_000_500);
  assert.equal(gitFilesToServerRows({}, 1), null);
});

test("通道转换：服务端行集 → Git 文件，与桌面端渲染口径一致", () => {
  const snap = baseSnapshot();
  const rows = snapshotToRows(snap);
  const fromRows = serverRowsToGitFiles(rows);
  const fromSnapshot = snapshotToGitFiles(snap);
  assert.deepEqual(fromRows, fromSnapshot);
  assert.ok(fromRows[requestFile].includes(GIT_SYNC_SCHEMA));
});

test("文件 diff 与文件名白名单：阻断路径穿越与无关文件", () => {
  assert.equal(isGitSyncFileName("reqora.requests.yaml"), true);
  assert.equal(isGitSyncFileName(GIT_MIRROR_MANIFEST_FILE), true);
  assert.equal(isGitSyncFileName("../evil.yaml"), false);
  assert.equal(isGitSyncFileName("sub/reqora.requests.yaml"), false);
  assert.equal(isGitSyncFileName(".env"), false);
  const before = { "reqora.a.yaml": "one" };
  assert.deepEqual(diffGitSyncFiles(before, { "reqora.a.yaml": "one", "reqora.b.yaml": "two" }), {
    "reqora.b.yaml": "two",
  });
  assert.throws(() => diffGitSyncFiles({}, { "../bad.yaml": "x" }), /不允许/);
});

test("解析校验：坏 schema / count 不一致 / 非法 YAML 都明确报错", () => {
  const snap = baseSnapshot();
  const files = snapshotToGitFiles(snap);
  const badSchema = {
    ...files,
    [requestFile]: files[requestFile].replace(`schema: "${GIT_SYNC_SCHEMA}"`, 'schema: "evil.v9"'),
  };
  assert.throws(() => parseGitSyncFiles(badSchema), /schema 不受支持/);
  const badCount = { ...files, [requestFile]: files[requestFile].replace(/count: \d+/, "count: 999") };
  assert.throws(() => parseGitSyncFiles(badCount), /count=/);
  const broken = { ...files, [requestFile]: "items:\n  - id: \"x\"\n    bad line\n" };
  assert.throws(() => parseGitSyncFiles(broken), /解析失败|无法识别/);
});

test("CLI：push / check / to-server / to-git / sync 全链路", () => {
  if (process.platform !== "win32" && !fs.existsSync(path.join(process.cwd(), "bin/git-sync.mjs"))) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reqora-git-sync-test-"));
  try {
    const cli = path.join(process.cwd(), "bin/git-sync.mjs");
    const snapshotFile = path.join(root, "workspace.json");
    const rowsFile = path.join(root, "rows.json");
    const spec = path.join(root, "spec");
    const fromRows = path.join(root, "from-rows");
    const merged = path.join(root, "merged.json");
    fs.writeFileSync(snapshotFile, JSON.stringify(baseSnapshot(), null, 2));

    const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    const push = run(["push", "--out", spec, "--snapshot", snapshotFile]);
    assert.equal(push.status, 0, push.stderr);
    assert.equal(fs.readdirSync(spec).length, 8);
    const check = run(["check", "--out", spec, "--snapshot", snapshotFile]);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /一致/);
    const toServer = run(["to-server", "--out", spec, "--rows-out", rowsFile]);
    assert.equal(toServer.status, 0, toServer.stderr);
    const rows = JSON.parse(fs.readFileSync(rowsFile, "utf8"));
    assert.ok(rows.requests.length > 0);
    assert.ok(!fs.readFileSync(rowsFile, "utf8").includes("demo-token"));
    const toGit = run(["to-git", "--rows-in", rowsFile, "--out", fromRows]);
    assert.equal(toGit.status, 0, toGit.stderr);
    assert.equal(fs.readdirSync(fromRows).length, 8);
    const sync = run(["sync", "--out", spec, "--snapshot", snapshotFile, "--write-snapshot", merged]);
    assert.equal(sync.status, 0, sync.stderr);
    assert.ok(fs.existsSync(merged));
    // 漂移检查：改一个文件后 check 必须失败（CI 门禁语义）。
    const target = path.join(spec, requestFile);
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("GET 请求示例", "手工改名"));
    assert.equal(run(["check", "--out", spec, "--snapshot", snapshotFile]).status, 1);
  } finally {
    rmTemp(root);
  }
});

test("通道转换写入新基线：文件/行集自洽且下一轮零冲突、零变更、零写盘", () => {
  const snap = baseSnapshot();
  const oldFiles = snapshotToGitFiles(snap);
  const oldBaseline = baselineOf(snap, oldFiles);

  // 模拟「服务端 / 本地已有新数据，转换到 Git 时以当前工作区为准覆盖文件」。
  const converted = clone(snap);
  converted.collections[0].items[0].name = "服务端改名";
  converted.collections[0].items[0].updatedAt = Date.now() + 10_000;
  const files = snapshotToGitFiles(converted);
  const newBaseline = {
    dir: "test-dir",
    files,
    rows: projectGitSyncRows(converted),
    conflicts: [],
    at: 2,
  };

  // 转换保存的 `files` 与 `rows` 必须自洽：共同祖先来自同一份迁移结果，
  // 否则换目录 / 换通道后旧仓库的行集会混进三方合并。
  assert.notEqual(oldFiles[requestFile], files[requestFile], "转换必须以当前工作区为准覆盖旧文件");
  assert.deepEqual(parseGitSyncFiles(files).rows, newBaseline.rows, "基线行集必须能从文件互逆还原");
  assert.equal(oldBaseline.dir, newBaseline.dir, "目录不变时基线 dir 保持一致");

  const settled = planGitSync(converted, files, { baseline: newBaseline });
  assert.equal(settled.conflicts.length, 0);
  assert.equal(settled.localChanges, 0);
  assert.equal(settled.gitChanges, 0);
  assert.deepEqual(settled.changedFiles, {});
  assert.ok(onlyRequestName(settled.snapshot, "服务端改名"));

  // 转换后本地与文件内容一致，因此即便误用旧基线也不会冲突；重置基线是
  // 针对「旧仓库 / 另一通道的行集语义混入」的防御，而不是靠冲突来兜底。
  const stale = planGitSync(converted, files, { baseline: oldBaseline });
  assert.equal(stale.conflicts.length, 0);
  assert.ok(onlyRequestName(stale.snapshot, "服务端改名"));
});

test("Git → 服务端转换写回快照时不丢失本机凭据与用例顺序", () => {
  const snap = baseSnapshot();
  snap.environments[0].variables.push({
    key: "secret", value: "s3cr3t", secret: true, enabled: true,
  });
  const stamped = stampRowsForTransfer(snapshotToRows(snap), 1_900_000_000_000);
  const next = rowsToSnapshot(stamped, snap);
  assert.equal(next.environments[0].variables.find((v) => v.key === "secret")?.value, "s3cr3t");
  assert.equal(next.environments[0].variables.find((v) => v.key === "token")?.value, "demo-token");
  assert.equal(next.collections[0].items.length, snap.collections[0].items.length);
  assert.deepEqual(
    next.collections[0].items.map((item) => item.id),
    snap.collections[0].items.map((item) => item.id),
  );
});
