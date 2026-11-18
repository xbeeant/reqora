// 增量同步（overlayRows + cursor 基线）与大字段旁路（extractBlobRefs /
// hydrateBlobRows）：
// - overlayRows 把 delta 覆盖到基线上构造「服务端当前视图」，必须覆盖基线
//   全部行（threeWayMerge 的 remote 不能漏行）、按 id 替换、墓碑覆盖活行；
// - blob 旁路必须往返一致（extract → hydrate 还原原 data），引用绝不能当
//   内容落库，对象缺失/损坏必须显式失败。
import test from "node:test";
import assert from "node:assert/strict";
import {
  BLOB_THRESHOLD_BYTES,
  extractBlobRefs,
  hydrateBlobRows,
  overlayRows,
  saveSyncBaseline,
  loadSyncBaseline,
} from "../src/lib/cloudSync.ts";
import { registerDict } from "../src/i18n/index.ts";
import { zh as cloudZh } from "../src/i18n/ns/cloud.ts";

// hydrateBlobRows 的错误消息经 i18n 渲染，测试环境需注册词典。
registerDict("zh", cloudZh);

const emptyRows = () => ({
  folders: [],
  requests: [],
  environments: [],
  cases: [],
  scenarios: [],
  suites: [],
  artifacts: [],
});

const folderRow = (id, name) => ({ id, updatedAt: 100, name, position: 0 });

test("overlayRows: no baseline returns delta as-is (first sync bootstrap)", () => {
  const delta = emptyRows();
  delta.folders.push(folderRow("f1", "集合"));
  const view = overlayRows(null, delta);
  assert.deepEqual(view.folders.map((row) => row.id), ["f1"]);
});

test("overlayRows: base rows are preserved and delta rows replace by id", () => {
  const base = emptyRows();
  base.folders.push(folderRow("f1", "旧名"));
  base.requests.push({
    id: "r1",
    updatedAt: 100,
    folderId: "f1",
    folderPath: "",
    name: "接口",
    method: "GET",
    url: "/a",
    protocol: "http",
    position: 0,
    data: {},
  });
  const delta = emptyRows();
  delta.folders.push({ ...folderRow("f1", "新名"), updatedAt: 200 });
  delta.folders.push(folderRow("f2", "新集合"));
  const view = overlayRows(base, delta);
  // 基线独有的行保留（delta 没提 = 服务端没变），delta 行按 id 替换/新增。
  assert.deepEqual(view.folders.map((row) => row.id), ["f1", "f2"]);
  assert.equal(view.folders[0].name, "新名");
  assert.equal(view.requests.length, 1);
  assert.equal(view.requests[0].id, "r1");
});

test("overlayRows: tombstone in delta replaces live baseline row", () => {
  const base = emptyRows();
  base.folders.push(folderRow("f1", "集合"));
  const delta = emptyRows();
  delta.folders.push({ ...folderRow("f1", ""), updatedAt: 300, deleted: true });
  const view = overlayRows(base, delta);
  assert.equal(view.folders.length, 1);
  assert.equal(view.folders[0].deleted, true);
});

test("overlayRows does not mutate the baseline", () => {
  const base = emptyRows();
  base.folders.push(folderRow("f1", "旧名"));
  const delta = emptyRows();
  delta.folders.push({ ...folderRow("f1", "新名"), updatedAt: 200 });
  overlayRows(base, delta);
  assert.equal(base.folders[0].name, "旧名");
});

test("overlayRows: full=true replaces the baseline (compacted tombstones cannot resurrect rows)", () => {
  // 墓碑回收水位的退化全量：delta 缺少基线里的 f1 意味着服务端已经没有
  // 它（删除墓碑已回收），叠加基线会让它复活，必须整体替换。
  const base = emptyRows();
  base.folders.push(folderRow("f1", "应消失"));
  base.folders.push(folderRow("f2", "仍在"));
  const delta = emptyRows();
  delta.folders.push(folderRow("f2", "仍在"));
  const overlayView = overlayRows(base, delta);
  assert.deepEqual(overlayView.folders.map((row) => row.id), ["f1", "f2"]);
  const fullView = overlayRows(base, delta, true);
  assert.deepEqual(fullView.folders.map((row) => row.id), ["f2"]);
});

test("baseline cursor is persisted and restored", async () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
    key: (index) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  };
  await saveSyncBaseline("p1", 7, emptyRows(), 42);
  const record = await loadSyncBaseline("p1");
  assert.equal(record.cursor, 42);
  // 没传 cursor（旧基线）时缺省，同步侧按 0（全量）处理。
  await saveSyncBaseline("p1", 7, emptyRows());
  assert.equal((await loadSyncBaseline("p1")).cursor, undefined);
});

// ------------------------------------------------ blob 旁路 ----

const requestRow = (id, dataKiB, extra = {}) => ({
  id,
  updatedAt: 1731300000000,
  folderId: "f1",
  folderPath: "",
  name: `行 ${id}`,
  method: "POST",
  url: "/x",
  protocol: "http",
  position: 0,
  data: { blob: "x".repeat(dataKiB * 1024) },
  ...extra,
});

test("extractBlobRefs: small rows stay inline", async () => {
  const payload = emptyRows();
  payload.requests.push(requestRow("r1", 1));
  const { payload: out, blobs } = await extractBlobRefs(payload);
  assert.equal(blobs.length, 0);
  assert.equal(out.requests[0].data.blob, "x".repeat(1024));
});

test("extractBlobRefs: oversized row gets a content-addressed ref", async () => {
  const payload = emptyRows();
  const big = requestRow("huge", 600); // > 512 KiB 阈值
  payload.requests.push(requestRow("r1", 1), big, { ...requestRow("gone", 600), deleted: true });
  const { payload: out, blobs } = await extractBlobRefs(payload);
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0].id, "huge");
  assert.equal(blobs[0].domain, "requests");
  const ref = out.requests[1].data;
  assert.match(ref.__blob, /^[0-9a-f]{64}$/);
  assert.equal(ref.encoding, "json");
  assert.ok(ref.size > BLOB_THRESHOLD_BYTES);
  // 墓碑行跳过；小行不动。
  assert.equal(out.requests[2].data.blob, "x".repeat(600 * 1024));
  assert.equal(out.requests[0].data.blob, "x".repeat(1024));
});

test("extract → hydrate round-trips the original data", async () => {
  const payload = emptyRows();
  payload.requests.push(requestRow("huge", 600));
  const original = JSON.parse(JSON.stringify(payload.requests[0].data));
  const { blobs } = await extractBlobRefs(payload);
  const objects = new Map(blobs.map((blob) => [blob.hash, blob.bytes]));
  const restored = await hydrateBlobRows(payload, async (hash) => {
    const bytes = objects.get(hash);
    if (!bytes) throw new Error(`missing object ${hash}`);
    return bytes;
  });
  assert.deepEqual(restored.requests[0].data, original);
});

test("hydrateBlobRows: missing object fails loudly instead of storing refs", async () => {
  const payload = emptyRows();
  payload.requests.push(requestRow("huge", 600));
  const { blobs } = await extractBlobRefs(payload);
  payload.requests[0].data = { __blob: blobs[0].hash, size: blobs[0].bytes.length, encoding: "json" };
  await assert.rejects(
    () => hydrateBlobRows(payload, async () => {
      throw new Error("404");
    }),
    /404/,
  );
});

test("hydrateBlobRows: corrupt object content fails loudly", async () => {
  const payload = emptyRows();
  payload.requests.push(requestRow("huge", 600));
  const { blobs } = await extractBlobRefs(payload);
  payload.requests[0].data = { __blob: blobs[0].hash, size: 4, encoding: "json" };
  // i18n 文案随 navigator.language 切换（Node 与浏览器可能不同），两种语言都算通过。
  await assert.rejects(
    () => hydrateBlobRows(payload, async () => new TextEncoder().encode("不是JSON")),
    /不是合法 JSON|not valid JSON/,
  );
});

