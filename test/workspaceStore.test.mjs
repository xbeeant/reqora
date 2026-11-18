// Regression tests for the CLI/storage-layer review fixes:
//   1. read-only SQLite handle, deleteEntity kind whitelist, strict data decode
//   2. row→snapshot rebuild now delegates to src/lib/workspaceRows.ts
//   3. the shared cliArgs / requester helper exports
//
// No external dependencies, no plaintext credentials. The fixture uses the
// real desktop-app SQLite schema (mirrors test/mcp.test.mjs).
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { WorkspaceStore, entityRowsToPayload, KINDS } from "../bin/workspaceStore.mjs";
import { rowsToSnapshot } from "../src/lib/workspaceRows.ts";
import { normalizeSnapshot } from "../src/lib/defaults.ts";
import { parseArgs, formatUsage } from "../bin/cliArgs.mjs";
import { bodyFromSpec, transport, resolveRef } from "../bin/requester.mjs";

// --------------------------------------------------------------- fixtures ----

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
CREATE TABLE history (id TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE trash (id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE request_revision (
  request_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL,
  data TEXT NOT NULL, PRIMARY KEY (request_id, id)
);
`;

// Covers every shared domain + local-only domains + tombstones. Explicit empty
// header/query arrays keep normalizeRequest from generating random uid() rows.
const ENTITY_ROWS = [
  { id: "col-1", kind: "folder", name: "集合A", position: 0, updatedAt: 100, auth: { type: "none" } },
  { id: "col-2", kind: "folder", name: "集合B", position: 1, updatedAt: 101 },
  {
    id: "req-1", kind: "request", parentId: "col-1", name: "接口1", method: "GET",
    url: "https://a.test/x/:id", protocol: "http", position: 0, updatedAt: 200,
    data: {
      headers: [{ id: "h1", key: "Accept", value: "application/json", enabled: true }],
      query: [], body: { type: "none" }, auth: { type: "none" }, assertions: [],
      doc: { summary: "摘要", description: "", owner: "", status: "", tags: [], paramMeta: {}, responses: [], updatedAt: 1 },
    },
  },
  { id: "req-2", kind: "request", parentId: "col-1", name: "接口2", method: "", url: "", protocol: "ws", position: 1, updatedAt: 201, data: { headers: [], query: [] } },
  { id: "env-1", kind: "environment", name: "环境1", position: 0, updatedAt: 150, data: { variables: [{ id: "v1", key: "baseUrl", value: "https://a.test", enabled: true }], headers: [] } },
  {
    id: "case-1", kind: "case", parentId: "req-1", name: "用例1", caseGroup: "", enabled: false, position: 0, updatedAt: 300,
    data: {
      request: { id: "cr", name: "用例请求", method: "GET", url: "https://a.test/x/7", headers: [], query: [], body: { type: "none" }, auth: { type: "none" }, assertions: [] },
      expectedStatus: 200, syncedAt: 1, createdAt: 1,
    },
  },
  { id: "scn-1", kind: "scenario", name: "场景1", position: 0, updatedAt: 400, data: { description: "", createdAt: 1, steps: [] } },
  { id: "suite-1", kind: "suite", name: "套件1", position: 0, updatedAt: 500, data: { description: "", items: [], createdAt: 1 } },
  { id: "doc-1", kind: "artifact", subKind: "docPage", name: "文档1", position: 0, updatedAt: 600, data: { slug: "s", group: "g", body: "# hi" } },
  { id: "dm-1", kind: "artifact", subKind: "dataModel", name: "模型1", position: 1, updatedAt: 601, data: { schemaText: "{}", description: "" } },
  { id: "ss-1", kind: "artifact", subKind: "scriptSnippet", name: "片段1", position: 2, updatedAt: 602, data: { code: "console.log(1)", description: "" } },
  { id: "ct-1", kind: "artifact", subKind: "codeTemplate", name: "模板1", position: 3, updatedAt: 603, data: { content: "x", language: "js", description: "" } },
  { id: "dbc-1", kind: "dbConnection", name: "库1", position: 0, updatedAt: 700, data: { url: "postgres://x", description: "" } },
  { id: "mcps-1", kind: "mcpServer", name: "MCP1", position: 0, updatedAt: 701, data: { args: [], env: {}, headers: {} } },
  { id: "gone-req", kind: "request", parentId: "col-1", name: "删接口", deleted: true, updatedAt: 800, data: {} },
  { id: "gone-col", kind: "folder", name: "删集合", deleted: true, updatedAt: 801, data: {} },
  { id: "gone-doc", kind: "artifact", subKind: "docPage", name: "删文档", deleted: true, updatedAt: 802, data: {} },
  { id: "weird-1", kind: "artifact", subKind: "unknownKind", name: "怪", position: 4, updatedAt: 900, data: { foo: 1 } },
];

function insertEntity(db, r) {
  db.prepare(
    `INSERT INTO entity (id, kind, parent_id, folder_path, name, method, url, protocol, auth,
      position, enabled, case_group, sub_kind, updated_at, deleted, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id, r.kind, r.parentId ?? null, r.folder ?? "", r.name,
    r.method ?? null, r.url ?? null, r.protocol ?? null,
    r.auth ? JSON.stringify(r.auth) : null,
    r.position ?? 0, r.enabled === false ? 0 : 1, r.caseGroup ?? null,
    r.subKind ?? null, r.updatedAt ?? 1, r.deleted ? 1 : 0,
    JSON.stringify(r.data ?? {}),
  );
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), "reqora-wsstore-"));
  const db = new DatabaseSync(join(dir, DB_FILE));
  db.exec(SCHEMA);
  db.prepare("INSERT INTO meta (key,value) VALUES (?,?)").run("seeded", "true");
  db.prepare("INSERT INTO meta (key,value) VALUES (?,?)").run("activeEnvironmentId", JSON.stringify("env-1"));
  db.prepare("INSERT INTO meta (key,value) VALUES (?,?)").run("theme", JSON.stringify("dark"));
  db.prepare("INSERT INTO meta (key,value) VALUES (?,?)").run("settings", JSON.stringify({ timeoutSecs: 12, followRedirects: false, verifyTls: true, proxyUrl: "http://proxy.test" }));
  for (const r of ENTITY_ROWS) insertEntity(db, r);
  db.prepare("INSERT INTO history (id,at,data) VALUES (?,?,?)").run(
    "hist-1", 10,
    JSON.stringify({ request: { id: "hr", name: "H", method: "GET", url: "https://a.test", headers: [], query: [], body: { type: "none" }, auth: { type: "none" }, assertions: [] } }),
  );
  db.prepare("INSERT INTO trash (id,deleted_at,data) VALUES (?,?,?)").run(
    "trash-1", 20, JSON.stringify({ kind: "request", entity: { id: "x" }, deletedAt: 20 }),
  );
  db.prepare("INSERT INTO request_revision (request_id,id,at,data) VALUES (?,?,?,?)").run(
    "req-1", "rev-1", 30,
    JSON.stringify({ id: "rev-1", at: 30, snapshot: { id: "req-1", name: "接口1 v1" } }),
  );
  db.close();
  return dir;
}

function rewriteData(dir, id, raw) {
  const db = new DatabaseSync(join(dir, DB_FILE));
  db.prepare("UPDATE entity SET data = ? WHERE id = ?").run(raw, id);
  db.close();
}

function rewriteMeta(dir, key, raw) {
  const db = new DatabaseSync(join(dir, DB_FILE));
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(raw, key);
  db.close();
}

function openStore(dir, allowWrite = false) {
  return new WorkspaceStore({ kind: "sqlite", dir, projectId: "p", projectName: "P" }, { allowWrite });
}

/** JSON round-trip drops `xxx: undefined` keys so deep-equal is stable. */
const asJson = (value) => JSON.parse(JSON.stringify(value));

/** Tombstones are a set keyed by kind:id; compare order-independently. */
const sortedTombstones = (list) =>
  [...(list ?? [])].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));

// ------------------------------------------------- 1. security hardening ----

test("只读 store 持有只读 SQLite 句柄：写操作与 PRAGMA journal_mode 被阻断", async () => {
  const dir = makeProject();
  const store = openStore(dir, false);
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.collections.length, 2);
  // this.db is the cached DatabaseSync handle opened by #openDb().
  assert.ok(store.db, "应已打开 SQLite 句柄");
  assert.throws(() => store.db.exec("PRAGMA journal_mode = WAL"), /readonly|read-only/i);
  assert.throws(
    () => store.db.prepare("UPDATE entity SET deleted = 1 WHERE id = ?").run("req-1"),
    /readonly|read-only/i,
  );
  store.close();
});

test("只读读取不写盘：不产生 WAL/SHM/journal 边车、db 文件 mtime/size 不变", async () => {
  const dir = makeProject();
  const file = join(dir, DB_FILE);
  const sidecars = () => readdirSync(dir).filter((name) => name !== DB_FILE);
  assert.deepEqual(sidecars(), [], "建库后应无残留边车文件");
  const before = statSync(file);
  const store = openStore(dir, false);
  await store.readSnapshot();
  store.close();
  assert.deepEqual(sidecars(), [], "只读打开不应产生 WAL/SHM/journal 文件");
  const after = statSync(file);
  assert.equal(after.mtimeMs, before.mtimeMs, "数据库文件不应被写入");
  assert.equal(after.size, before.size);
});

test("allowWrite store 写入仍可用（回归：只读修复未破坏写路径）", async () => {
  const dir = makeProject();
  const store = openStore(dir, true);
  assert.equal(await store.deleteEntity("req-1"), true);
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.collections[0].items.some((item) => item.id === "req-1"), false);
  assert.ok(snapshot.tombstones.some((item) => item.id === "req-1"));
  store.close();
});

test("deleteEntity 仅允许白名单 kind，未知 id 返回 false，死参数已移除", async () => {
  const dir = makeProject();
  const store = openStore(dir, true);
  // 公开 KINDS 导出（= 同步协议内 7 种）保持兼容
  assert.deepEqual(Object.values(KINDS).sort(), ["artifact", "case", "environment", "folder", "request", "scenario", "suite"]);
  assert.equal(WorkspaceStore.prototype.deleteEntity.length, 1);
  // 本机域 kind 不在白名单：任意 id 不能再被软删
  await assert.rejects(() => store.deleteEntity("dbc-1"), /不允许删除实体类型「dbConnection」/);
  await assert.rejects(() => store.deleteEntity("mcps-1"), /不允许删除实体类型「mcpServer」/);
  assert.equal(await store.deleteEntity("不存在"), false);
  assert.equal(await store.deleteEntity("req-1"), true);
  assert.equal(await store.deleteEntity("doc-1"), true);
  store.close();
});

test("只读 store 的 deleteEntity 先被 --allow-write 拦截", async () => {
  const dir = makeProject();
  const store = openStore(dir, false);
  await assert.rejects(() => store.deleteEntity("req-1"), /--allow-write/);
  store.close();
});

test("损坏的 entity.data 列抛带 id/kind 上下文的错误，不再静默返回 {}", async () => {
  const dir = makeProject();
  rewriteData(dir, "req-1", "{not-json");
  const store = openStore(dir, false);
  await assert.rejects(
    () => store.readSnapshot(),
    (error) => /data 列不是合法 JSON/.test(error.message) && /req-1/.test(error.message) && /request/.test(error.message),
  );
  store.close();
});

test("entity.data 为非对象 JSON 时同样视为损坏", async () => {
  const dir = makeProject();
  rewriteData(dir, "env-1", "[1,2]");
  const store = openStore(dir, false);
  await assert.rejects(
    () => store.readSnapshot(),
    (error) => /应为 JSON 对象/.test(error.message) && /env-1/.test(error.message),
  );
  store.close();
});

test("墓碑行的 data 不解码（与 storage.rs::rebuild_snapshot 一致）", async () => {
  const dir = makeProject();
  rewriteData(dir, "gone-req", "{broken");
  const store = openStore(dir, false);
  const snapshot = await store.readSnapshot();
  assert.ok(snapshot.tombstones.some((item) => item.id === "gone-req"));
  store.close();
});

test("结构化 meta 项损坏时抛错，不静默降级为字符串", async () => {
  const dir = makeProject();
  rewriteMeta(dir, "settings", "{oops");
  const store = openStore(dir, false);
  await assert.rejects(() => store.readSnapshot(), /meta 项「settings」不是合法 JSON/);
  store.close();
});

// --------------------------------------------- 2. row→snapshot delegation ----

test("readSnapshot 重建字段与改动前一致（共享域 + 本机域 + 墓碑）", async () => {
  const dir = makeProject();
  const store = openStore(dir, false);
  const s = asJson(await store.readSnapshot());
  store.close();

  // 共享域：集合 / 接口（字段映射与 storage.rs::rebuild_snapshot 一致）
  assert.deepEqual(s.collections.map((c) => [c.id, c.name, c.updatedAt]), [
    ["col-1", "集合A", 100], ["col-2", "集合B", 101],
  ]);
  assert.deepEqual(s.collections[0].auth, { type: "none" });
  const [r1, r2] = s.collections[0].items;
  assert.deepEqual(
    [r1.id, r1.method, r1.url, r1.protocol, r1.folder, r1.updatedAt],
    ["req-1", "GET", "https://a.test/x/:id", "http", "", 200],
  );
  assert.equal(r1.headers[0].key, "Accept");
  assert.equal(r1.doc.summary, "摘要");
  assert.deepEqual([r2.id, r2.method, r2.url, r2.protocol, r2.updatedAt], ["req-2", "GET", "", "ws", 201]);
  assert.deepEqual(r2.headers, []);
  assert.deepEqual(r2.query, []);

  // 环境 / 用例 / 场景 / 套件
  assert.equal(s.environments[0].variables[0].key, "baseUrl");
  assert.deepEqual(
    [s.cases[0].id, s.cases[0].requestId, s.cases[0].group, s.cases[0].enabled, s.cases[0].updatedAt],
    ["case-1", "req-1", "其他", false, 300],
  );
  assert.equal(s.scenarios[0].name, "场景1");
  assert.equal(s.suites[0].updatedAt, 500);

  // 公共构件：docPage.title 来自 name，其余域保留 updatedAt
  assert.deepEqual([s.docPages[0].id, s.docPages[0].title, s.docPages[0].slug], ["doc-1", "文档1", "s"]);
  assert.equal(s.dataModels[0].updatedAt, 601);
  assert.equal(s.scriptLibrary[0].updatedAt, 602);
  assert.equal(s.codeTemplates[0].updatedAt, 603);
  assert.equal(s.docPages.length, 1, "未知 sub_kind 的 artifact 应被忽略");

  // 本机域（workspaceRows.ts 注释明确不进同步协议）
  assert.equal(s.dbConnections[0].url, "postgres://x");
  assert.equal(s.mcpServers[0].id, "mcps-1");
  assert.equal(s.history.length, 1);
  assert.equal(s.trash.length, 1);
  assert.deepEqual(s.revisions["req-1"], [
    { id: "rev-1", at: 30, snapshot: { id: "req-1", name: "接口1 v1" } },
  ]);
  assert.equal(s.theme, "dark");
  assert.equal(s.seeded, true);
  assert.equal(s.activeEnvironmentId, "env-1");
  assert.equal(s.settings.timeoutSecs, 12);
  assert.equal(s.settings.proxyUrl, "http://proxy.test");

  // 墓碑：作为 keyed set 与改动前一致
  assert.deepEqual(sortedTombstones(s.tombstones), [
    { kind: "docPage", id: "gone-doc", updatedAt: 802 },
    { kind: "folder", id: "gone-col", updatedAt: 801 },
    { kind: "request", id: "gone-req", updatedAt: 800 },
  ]);
});

test("entityRowsToPayload 适配层：构造行数据 → WorkspaceRowsPayload", () => {
  const rows = [
    { id: "f1", kind: "folder", name: "F", updated_at: 10, deleted: 0, position: 0, auth: null, data: "{}" },
    { id: "r1", kind: "request", parent_id: "f1", folder_path: "grp", name: "R", method: "POST", url: "http://x", protocol: "http", updated_at: 11, deleted: 0, position: 0, data: '{"headers":[]}' },
    { id: "c1", kind: "case", parent_id: "r1", case_group: "", enabled: 0, name: "C", updated_at: 12, deleted: 0, position: 0, data: '{"expectedStatus":204}' },
    { id: "t1", kind: "request", name: "T", updated_at: 13, deleted: 1, position: 0, data: "{}" },
    { id: "d1", kind: "dbConnection", name: "D", updated_at: 14, deleted: 0, position: 0, data: '{"url":"mysql://x"}' },
  ];
  const { payload, local } = entityRowsToPayload(rows);
  assert.equal(payload.folders.length, 1);
  assert.equal(payload.requests.length, 2);
  assert.equal(payload.requests[1].deleted, true);
  assert.deepEqual(payload.cases[0], {
    id: "c1", name: "C", updatedAt: 12, position: 0, deleted: false,
    requestId: "r1", caseGroup: "其他", enabled: false, data: { expectedStatus: 204 },
  });
  // 本机域不进 payload，由 base 提供给 rowsToSnapshot
  assert.equal(payload.dbConnections, undefined);
  assert.equal(local.dbConnections[0].url, "mysql://x");

  const snap = rowsToSnapshot(payload, { version: 1, history: [], trash: [], settings: {} });
  assert.equal(snap.collections[0].items.length, 1, "墓碑行不得进入活对象");
  assert.equal(snap.collections[0].items[0].folder, "grp");
  assert.ok(snap.tombstones.some((t) => t.id === "t1" && t.kind === "request"));
});

// --------------------------------------------- 3. shared helper exports ----

test("cliArgs: parseArgs 与 formatUsage 签名通用", () => {
  const spec = {
    defaults: { workspace: null, allowWrite: false, maxBodyBytes: 16_384, help: false },
    options: [
      { key: "workspace", flags: ["--workspace", "-w"], value: true, label: "<路径>", description: "路径" },
      { key: "allowWrite", flags: ["--allow-write"], description: "允许写" },
      { key: "maxBodyBytes", flags: ["--max-body-bytes"], value: true, label: "<n>", coerce: (raw, args) => Number(raw) || args.maxBodyBytes, description: "字节数" },
      { key: "help", flags: ["--help", "-h"], description: "帮助" },
    ],
    usage: { title: "Demo", command: "demo [选项]", env: [["REQORA_WORKSPACE", "同 --workspace"]], footer: "结束。" },
  };
  assert.deepEqual(
    parseArgs(["--workspace=/x", "--allow-write", "--max-body-bytes", "oops", "-h"], spec),
    { workspace: "/x", allowWrite: true, maxBodyBytes: 16_384, help: true },
  );
  // defaults 不被修改
  assert.equal(spec.defaults.maxBodyBytes, 16_384);
  const usage = formatUsage(spec);
  assert.match(usage, /Demo/);
  assert.match(usage, /--workspace, -w <路径>/);
  assert.match(usage, /REQORA_WORKSPACE/);
});

test("requester: bodyFromSpec 覆盖 json/raw/formUrlEncoded/graphql/none", () => {
  const sub = (text, vars) => String(text ?? "").replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
  const vars = { v: "7" };

  assert.deepEqual(bodyFromSpec({ type: "json", content: '{"x":"{{v}}"}' }, vars, sub), {
    body: '{"x":"7"}', contentType: "application/json", notes: [],
  });
  assert.deepEqual(bodyFromSpec({ type: "raw", content: "hi", contentType: "text/custom" }, vars, sub), {
    body: "hi", contentType: "text/custom", notes: [],
  });
  assert.equal(bodyFromSpec({ type: "raw", content: "hi" }, vars, sub).contentType, "text/plain");
  assert.deepEqual(
    bodyFromSpec({ type: "formUrlEncoded", items: [
      { key: "a", value: "{{v}}", enabled: true },
      { key: "skip", value: "x", enabled: false },
    ] }, vars, sub),
    { body: "a=7", contentType: "application/x-www-form-urlencoded", notes: [] },
  );
  assert.deepEqual(bodyFromSpec({ type: "graphql", query: "query { x }", variables: '{"n":1}' }, vars, sub), {
    body: '{"query":"query { x }","variables":{"n":1}}', contentType: "application/json", notes: [],
  });
  const badGraphql = bodyFromSpec({ type: "graphql", query: "q", variables: "not-json" }, vars, sub);
  assert.equal(badGraphql.notes.length, 1);
  assert.equal(badGraphql.body, '{"query":"q","variables":{}}');
  assert.deepEqual(bodyFromSpec({ type: "none" }, vars, sub), { body: undefined, contentType: undefined, notes: [] });
});

test("requester: transport 返回 response 或 error，不抛", async () => {
  const ok = await transport("http://x", {}, async () => ({ status: 200 }));
  assert.equal(ok.error, null);
  assert.equal(ok.response.status, 200);
  const bad = await transport("http://x", {}, async () => { throw new Error("boom"); });
  assert.equal(bad.response, null);
  assert.equal(bad.error.message, "boom");
});

test("requester: resolveRef 按 id/精确名/唯一子串解析", () => {
  const snapshot = {
    collections: [{ id: "c1", items: [{ id: "r1", name: "Get User" }, { id: "r2", name: "Get Order" }] }],
  };
  assert.equal(resolveRef(snapshot, "r1").request.name, "Get User");
  assert.equal(resolveRef(snapshot, "Get Order").collection.id, "c1");
  assert.equal(resolveRef(snapshot, "order").request.id, "r2");
  assert.equal(resolveRef(snapshot, "get"), null, "歧义子串返回 null");
  assert.equal(resolveRef(snapshot, "nope"), null);
  assert.equal(resolveRef(snapshot, ""), null);
});

test("normalizeSnapshot 容忍缺 request 的坏行（不再卡在加载工作区）", () => {
  // 真实库里出现过 data:{} 的历史/用例行：以前 normalizeRequest(undefined)
  // 直接抛错，initialize() 停在 isLoading=true，页面永远显示「加载工作区」。
  const snapshot = normalizeSnapshot({
    version: 1,
    collections: [],
    environments: [],
    cases: [{ id: "case-broken", requestId: "missing", name: "", group: "其他" }],
    history: [{ id: "h-broken", at: 1, status: 200 }],
    scenarios: [],
    settings: {},
  });
  assert.equal(snapshot.history[0].request.id.length > 0, true);
  assert.equal(snapshot.cases[0].request.method, "GET");
});
