// 同步基线下沉：桌面端存项目 SQLite（Tauri IPC），浏览器/测试降级
// localStorage。必须保证：
// - 清掉 WebView 缓存后基线仍在（SQLite 命中）；
// - 升级前写在 localStorage 的基线首次读取时迁移一次；
// - SQLite 故障时降级不抛错；
// - 未被 await 的清理操作不会让随后读取拿到旧基线（串行队列）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  saveSyncBaseline,
  loadSyncBaseline,
  clearSyncBaseline,
  clearAllSyncBaselines,
} from "../src/lib/cloudSync.ts";

const emptyRows = () => ({
  folders: [],
  requests: [],
  environments: [],
  cases: [],
  scenarios: [],
  suites: [],
  artifacts: [],
});

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

test("browser fallback: save / load / clear", async () => {
  noDesktop();
  mockLocalStorage();
  await saveSyncBaseline("b1", 3, emptyRows(), 17);
  assert.equal((await loadSyncBaseline("b1")).cursor, 17);
  assert.equal((await loadSyncBaseline("b1")).cloudProjectId, 3);
  await clearSyncBaseline("b1");
  assert.equal(await loadSyncBaseline("b1"), null);
});

test("desktop: baseline survives a WebView localStorage wipe", async () => {
  const local = mockLocalStorage();
  const { db, calls } = mockDesktop();
  await saveSyncBaseline("p2", 7, emptyRows(), 42);
  assert.equal(db.size, 1);
  // 清 WebView 数据目录 / 用户清缓存：localStorage 全没了，基线不能丢。
  local.clear();
  const record = await loadSyncBaseline("p2");
  assert.equal(record.cursor, 42);
  assert.equal(record.cloudProjectId, 7);
  assert.deepEqual(record.rows, emptyRows());
  assert.ok(calls.some((call) => call.cmd === "save_sync_baseline"));
  noDesktop();
});

test("legacy localStorage baseline is migrated to SQLite on first read", async () => {
  const local = mockLocalStorage();
  local.set(
    "reqora.syncBaseline.old",
    JSON.stringify({ cloudProjectId: 9, savedAt: 1000, rows: emptyRows(), cursor: 5 }),
  );
  const { db, calls } = mockDesktop();
  const record = await loadSyncBaseline("old");
  assert.equal(record.cursor, 5);
  assert.equal(db.get("old").cloudProjectId, 9);
  assert.equal(local.has("reqora.syncBaseline.old"), false, "旧键应被删除");
  const savesBefore = calls.filter((call) => call.cmd === "save_sync_baseline").length;
  await loadSyncBaseline("old");
  const savesAfter = calls.filter((call) => call.cmd === "save_sync_baseline").length;
  assert.equal(savesAfter, savesBefore, "迁移只做一次");
  noDesktop();
});

test("SQLite failure degrades to localStorage without throwing", async () => {
  const local = mockLocalStorage();
  mockDesktop({ fail: true });
  await saveSyncBaseline("p4", 11, emptyRows(), 8);
  const record = await loadSyncBaseline("p4");
  assert.equal(record.cursor, 8);
  assert.ok(local.has("reqora.syncBaseline.p4"));
  noDesktop();
});

test("unawaited clear still precedes the next read", async () => {
  mockLocalStorage();
  mockDesktop();
  await saveSyncBaseline("p5", 2, emptyRows(), 1);
  void clearSyncBaseline("p5"); // 换绑/解绑路径就是 fire-and-forget
  assert.equal(await loadSyncBaseline("p5"), null);
  noDesktop();
});

test("switching servers clears baselines of every local project", async () => {
  mockLocalStorage();
  const { db, calls } = mockDesktop();
  await saveSyncBaseline("c1", 1, emptyRows(), 1);
  await saveSyncBaseline("c2", 2, emptyRows(), 2);
  assert.equal(db.size, 2);
  void clearAllSyncBaselines();
  assert.equal(await loadSyncBaseline("c1"), null);
  assert.equal(await loadSyncBaseline("c2"), null);
  assert.ok(calls.some((call) => call.cmd === "clear_all_sync_baselines"));
  noDesktop();
});

test("clearAll failure never resurrects a stale baseline in-process", async () => {
  mockLocalStorage();
  mockDesktop({ fail: true });
  await saveSyncBaseline("d1", 1, emptyRows(), 1);
  void clearAllSyncBaselines();
  assert.equal(await loadSyncBaseline("d1"), null);
  noDesktop();
});
