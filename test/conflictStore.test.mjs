// 冲突明细下沉：base + local + remote 三份完整行走项目 SQLite（与基线共用
// KV 表但独立命名空间），浏览器/测试降级 localStorage。必须保证：
// - 清掉 WebView 缓存后待裁决冲突仍在；
// - 旧版本 localStorage 记录（没有 base）首次读取时迁移并补 base: null；
// - 清冲突不会连带清掉基线；
// - SQLite 故障降级、未 await 的清理不会让随后读取拿到陈旧记录。
import test from "node:test";
import assert from "node:assert/strict";
import {
  clearAllSyncConflicts,
  clearSyncConflicts,
  loadSyncConflicts,
  saveSyncBaseline,
  loadSyncBaseline,
  saveSyncConflicts,
} from "../src/lib/cloudSync.ts";

function mockLocalStorage() {
  const data = new Map();
  globalThis.localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
  return data;
}

/** 用 window.__TAURI_INTERNALS__.invoke 打桩（@tauri-apps/api 的真实入口）。 */
function mockDesktop({ fail = false } = {}) {
  const db = new Map();
  const calls = [];
  globalThis.window = globalThis;
  globalThis.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args = {}) => {
      calls.push({ cmd, args });
      if (fail) throw new Error("database unavailable");
      switch (cmd) {
        case "load_sync_baseline":
          return db.get(args.projectKey) ?? null;
        case "save_sync_baseline":
          db.set(args.projectKey, structuredClone(args.payload));
          return null;
        case "clear_sync_baseline":
          db.delete(args.projectKey);
          return null;
        case "clear_all_sync_baselines":
          db.clear();
          return null;
        default:
          throw new Error(`unexpected command ${cmd}`);
      }
    },
  };
  return { db, calls };
}

function noDesktop() {
  delete globalThis.__TAURI_INTERNALS__;
  delete globalThis.window;
}

const bigRow = (tag) => ({
  id: "r1",
  name: `接口-${tag}`,
  updatedAt: 100,
  data: { body: { raw: "x".repeat(2048), tag } },
});

const entries = () => [
  {
    domain: "requests",
    id: "r1",
    name: "接口",
    base: bigRow("base"),
    local: bigRow("local"),
    remote: bigRow("remote"),
  },
];

test("browser fallback: conflict entries round-trip through localStorage", async () => {
  const data = mockLocalStorage();
  noDesktop();
  await clearAllSyncConflicts();
  await saveSyncConflicts("p1", 7, entries());
  const record = await loadSyncConflicts("p1");
  assert.equal(record.cloudProjectId, 7);
  assert.equal(record.entries.length, 1);
  assert.equal(record.entries[0].base.data.body.tag, "base");
  assert.ok(data.has("reqora.syncConflicts.p1"));
  assert.equal(await loadSyncConflicts("p2"), null);
});

test("desktop: conflicts survive a full WebView cache wipe", async () => {
  const data = mockLocalStorage();
  const { db } = mockDesktop();
  await clearAllSyncConflicts();
  await saveSyncConflicts("p1", 7, entries());
  assert.ok(db.has("conflicts:p1"), "SQLite 键带独立命名空间");
  assert.equal(data.has("reqora.syncConflicts.p1"), false, "桌面端不留 localStorage 副本");

  // 模拟清理 WebView 缓存：localStorage 全空，SQLite 仍在。
  data.clear();
  const record = await loadSyncConflicts("p1");
  assert.equal(record.entries[0].local.data.body.tag, "local");
  assert.equal(record.entries[0].remote.data.body.tag, "remote");
});

test("legacy localStorage entries are migrated once and get a null base", async () => {
  const data = mockLocalStorage();
  const { db, calls } = mockDesktop();
  db.clear();
  data.set(
    "reqora.syncConflicts.p1",
    JSON.stringify({
      cloudProjectId: 7,
      entries: [
        {
          domain: "requests",
          id: "r1",
          name: "旧冲突",
          local: bigRow("local"),
          remote: bigRow("remote"),
        },
      ],
    }),
  );

  const record = await loadSyncConflicts("p1");
  assert.equal(record.entries[0].base, null, "旧记录缺 base 时补 null，合并退化为整行二选一");
  assert.ok(db.has("conflicts:p1"), "已写入 SQLite");
  assert.equal(data.has("reqora.syncConflicts.p1"), false, "旧键已删除");
  assert.ok(calls.some((call) => call.cmd === "save_sync_baseline"));

  await loadSyncConflicts("p1");
  assert.equal(
    calls.filter((call) => call.cmd === "save_sync_baseline").length,
    1,
    "只迁移一次",
  );
});

test("clearing conflicts does not clear the baseline", async () => {
  mockLocalStorage();
  const { db } = mockDesktop();
  await clearAllSyncConflicts();
  await saveSyncConflicts("p1", 7, entries());
  await saveSyncBaseline("p1", 7, {
    folders: [],
    requests: [],
    environments: [],
    cases: [],
    scenarios: [],
    suites: [],
    artifacts: [],
  });

  await clearSyncConflicts("p1");
  assert.equal(await loadSyncConflicts("p1"), null);
  assert.ok(db.has("p1"), "基线键不受影响");
  assert.notEqual(await loadSyncBaseline("p1"), null);
});

test("clearAll invalidates every project and both namespaces", async () => {
  mockLocalStorage();
  const { db } = mockDesktop();
  await saveSyncConflicts("p1", 7, entries());
  await saveSyncConflicts("p2", 7, entries());
  await clearAllSyncConflicts();
  assert.equal(db.size, 0);
  assert.equal(await loadSyncConflicts("p1"), null);
  assert.equal(await loadSyncConflicts("p2"), null);
});

test("SQLite failure degrades to localStorage instead of throwing", async () => {
  const data = mockLocalStorage();
  mockDesktop({ fail: true });
  await saveSyncConflicts("p1", 7, entries());
  const record = await loadSyncConflicts("p1");
  assert.equal(record.entries[0].base.data.body.tag, "base");
  assert.ok(data.has("reqora.syncConflicts.p1"));
});

test("fire-and-forget clear cannot be outrun by the next read", async () => {
  mockLocalStorage();
  mockDesktop();
  await saveSyncConflicts("p1", 7, entries());
  void clearAllSyncConflicts();
  // 串行队列保证先清后读，即便调用方没有 await。
  assert.equal(await loadSyncConflicts("p1"), null);
});

test("malformed persisted records are ignored", async () => {
  const data = mockLocalStorage();
  noDesktop();
  await clearAllSyncConflicts();
  data.set("reqora.syncConflicts.bad", JSON.stringify({ cloudProjectId: "x" }));
  data.set("reqora.syncConflicts.bad2", "{not json");
  assert.equal(await loadSyncConflicts("bad"), null);
  assert.equal(await loadSyncConflicts("bad2"), null);
});
