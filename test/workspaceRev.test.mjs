// P0: the desktop WebView and out-of-process writers (MCP / CLI) share one
// optimistic-lock counter in workspace.db. A stale desktop save must be
// rejected instead of silently overwriting an MCP write.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { WorkspaceStore } from "../bin/workspaceStore.mjs";

const root = resolve(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const DB_FILE = "workspace.db";

const SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE entity (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, parent_id TEXT,
    folder_path TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
    method TEXT, url TEXT, protocol TEXT, auth TEXT,
    position INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
    case_group TEXT, sub_kind TEXT, updated_at INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}',
    rev INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE workspace_rev (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    rev INTEGER NOT NULL DEFAULT 0,
    writer TEXT NOT NULL DEFAULT 'init',
    updated_at INTEGER NOT NULL DEFAULT 0
  );
`;

function makeProject({ withRev = true, rev = 3 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "reqora-rev-"));
  const db = new DatabaseSync(join(dir, DB_FILE));
  db.exec(SCHEMA);
  db.prepare("INSERT INTO meta (key,value) VALUES (?,?)").run("seeded", "true");
  if (withRev) {
    db.prepare("INSERT INTO workspace_rev (id,rev,writer,updated_at) VALUES (1,?,?,?)")
      .run(rev, "desktop", 100);
  }
  db.prepare("INSERT INTO entity (id,kind,name,data) VALUES (?,?,?,?)")
    .run("req-1", "request", "R", "{}");
  db.close();
  return dir;
}

const open = (dir) =>
  new WorkspaceStore(
    { kind: "sqlite", dir, projectId: "p", projectName: "P" },
    { allowWrite: true },
  );

test("readRev 读到桌面端写入的当前版本", async () => {
  const dir = makeProject();
  const store = open(dir);
  assert.deepEqual(await store.readRev(), { rev: 3, writer: "desktop", updatedAt: 100 });
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("MCP 写入在同一事务内递增版本并标记 writer=mcp", async () => {
  const dir = makeProject();
  const store = open(dir);
  assert.equal(await store.deleteEntity("req-1"), true);
  const after = await store.readRev();
  assert.equal(after.rev, 4, "外部写入必须 bump 共享版本号");
  assert.equal(after.writer, "mcp");
  assert.ok(after.updatedAt > 0);
  // 桌面端以 expectedRev=3 保存时，Rust CAS 会因为 4 !== 3 拒绝写入
  // （Rust 侧 storage::tests::checked_save_detects_external_writer... 覆盖）。
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("MCP 写入把行水位标成新的 workspace_rev（桌面可增量发现）", async () => {
  const dir = makeProject();
  const store = open(dir);
  await store.putCase({
    id: "case-mcp",
    name: "MCP 用例",
    requestId: "req-1",
    updatedAt: 200,
  });
  const db = new DatabaseSync(join(dir, DB_FILE));
  const row = db.prepare("SELECT rev FROM entity WHERE id = ?").get("case-mcp");
  const counter = db.prepare("SELECT rev FROM workspace_rev WHERE id = 1").get();
  db.close();
  assert.equal(counter.rev, 4, "共享版本号前进 1");
  assert.equal(row.rev, 0, "新行的 rev 必须与本次发布的版本号一致");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("软删墓碑也盖行水位，外部刷新能发现删除", async () => {
  const dir = makeProject();
  const store = open(dir);
  assert.equal(await store.deleteEntity("req-1"), true);
  const db = new DatabaseSync(join(dir, DB_FILE));
  const row = db.prepare("SELECT deleted, rev FROM entity WHERE id = ?").get("req-1");
  db.close();
  assert.equal(row.deleted, 1);
  assert.equal(row.rev, 0, "墓碑行的 rev 必须前进，否则增量刷新看不到删除");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("legacy / 自建测试库无 workspace_rev 表时写入不失败", async () => {
  const dir = makeProject({ withRev: false });
  const store = open(dir);
  assert.deepEqual(await store.readRev(), { rev: 0, writer: "init", updatedAt: 0 });
  assert.equal(await store.deleteEntity("req-1"), true);
  assert.deepEqual(await store.readRev(), { rev: 0, writer: "init", updatedAt: 0 });
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("MCP 写工具包装器会把 workspaceRev 暴露给调用方", () => {
  const source = readFileSync(join(root, "bin", "mcpServer.mjs"), "utf8");
  assert.match(source, /const before = await store\.readRev\(\)/);
  assert.match(source, /const after = await store\.readRev\(\)/);
  assert.match(source, /body\.workspaceRev =/);
  assert.match(source, /before: before\.rev/);
  assert.match(source, /after: after\.rev/);
  assert.match(source, /writer: after\.writer/);
});

test("桌面保存链携带 expectedRev，冲突时 WORKSPACE_CONFLICT 且提供两个动作", () => {
  const context = readFileSync(join(root, "src", "store", "workspace", "context.ts"), "utf8");
  assert.match(context, /saveWorkspace\(get\(\)\.snapshot, \{ expectedRev \}\)/);
  assert.match(context, /error\.code === "WORKSPACE_CONFLICT"/);
  assert.match(context, /workspaceConflict: messageOf\(error\)/);
  const core = readFileSync(join(root, "src", "store", "workspace", "slices", "core.ts"), "utf8");
  assert.match(core, /api\.loadWorkspaceRev\(\)/);
  assert.match(core, /api\.backupWorkspace\("before-force-overwrite"\)/);
  assert.match(core, /force: true/);
});
