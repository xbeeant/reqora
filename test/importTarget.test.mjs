import test from "node:test";
import assert from "node:assert/strict";
import {
  KEEP_FOLDER,
  NEW_COLLECTION,
  listFolderPaths,
  normalizeFolderPath,
  placeImportedCollections,
  resolveImportFolder,
} from "../src/lib/importTarget.ts";

const req = (id, folder = "") => ({ id, name: id, folder, method: "GET", url: "https://api.example.com" });
const col = (id, name, items) => ({ id, name, items });
let seq = 0;
const ids = () => `new-${++seq}`;

test("normalizeFolderPath trims segments and drops empty / dot segments", () => {
  assert.equal(normalizeFolderPath("  用户模块 / 登录 /  "), "用户模块/登录");
  assert.equal(normalizeFolderPath("a//./b/../c"), "a/b/c");
  assert.equal(normalizeFolderPath(""), "");
  assert.equal(normalizeFolderPath("   "), "");
});

test("listFolderPaths includes ancestors, deduplicates and sorts", () => {
  const collections = [
    col("c1", "A", [req("a", "用户/登录/子页"), req("b", "用户/资料"), req("c", "")]),
    col("c2", "B", [req("d", "订单")]),
  ];
  assert.deepEqual(listFolderPaths(collections, "c1"), ["用户", "用户/登录", "用户/登录/子页", "用户/资料"]);
  assert.deepEqual(listFolderPaths(collections, "c2"), ["订单"]);
  assert.deepEqual(listFolderPaths(collections, "missing"), []);
  assert.deepEqual(
    listFolderPaths([col("c3", "C", [req("x", KEEP_FOLDER)])], "c3"),
    [],
    "sentinel option values are never offered as real folders",
  );
});

test("resolveImportFolder: keep / root / prefix", () => {
  assert.equal(resolveImportFolder(undefined, "用户/登录"), "用户/登录");
  assert.equal(resolveImportFolder({ folderMode: "keep" }, "用户/登录"), "用户/登录");
  assert.equal(resolveImportFolder({ folderMode: "root" }, "用户/登录"), "");
  assert.equal(
    resolveImportFolder({ folderMode: "prefix", folder: "商城 API" }, "用户/登录"),
    "商城 API/用户/登录",
  );
  assert.equal(
    resolveImportFolder({ folderMode: "prefix", folder: "商城 API", preserveSourceFolders: false }, "用户/登录"),
    "商城 API",
  );
  assert.equal(resolveImportFolder({ folderMode: "prefix", folder: "" }, ""), "");
  assert.equal(resolveImportFolder({ folderMode: "prefix", folder: " a / b " }, "c"), "a/b/c");
});

test("placeImportedCollections without a target keeps the legacy behaviour", () => {
  const existing = [col("c1", "已有", [req("a")])];
  const incoming = [col("i1", "cURL 导入", [req("b")])];
  const placed = placeImportedCollections(existing, incoming, undefined, ids);
  assert.equal(placed.collections.length, 2);
  assert.equal(placed.collections[0], existing[0], "untouched collections keep identity");
  assert.equal(placed.collections[1].name, "cURL 导入");
  assert.equal(placed.createdCollections, 1);
  assert.equal(placed.importedRequests, 1);
  assert.equal(placed.targetCollectionId, placed.collections[1].id);
});

test("placeImportedCollections merges into an existing collection", () => {
  const existing = [col("c1", "已有", [req("a", "旧分组")]), col("c2", "其它", [])];
  const incoming = [
    col("i1", "cURL 导入", [req("b"), req("c")]),
    col("i2", "另一批", [req("d")]),
  ];
  const placed = placeImportedCollections(existing, incoming, {
    collectionId: "c1",
    folderMode: "prefix",
    folder: "导入",
  }, ids);
  assert.equal(placed.collections.length, 2, "no new collection is created");
  assert.deepEqual(placed.collections[0].items.map((r) => r.id), ["a", "b", "c", "d"]);
  assert.deepEqual(placed.collections[0].items.map((r) => r.folder), ["旧分组", "导入", "导入", "导入"]);
  assert.equal(placed.collections[1], existing[1], "other collections keep identity");
  assert.equal(placed.importedRequests, 3);
  assert.equal(placed.targetCollectionId, "c1");
  assert.equal(placed.createdCollections, 0);
  assert.deepEqual(existing[0].items.map((r) => r.id), ["a"], "input is not mutated");
  assert.deepEqual(incoming[0].items.map((r) => r.folder), ["", ""], "incoming is not mutated");
});

test("placeImportedCollections keeps Postman sub-folders under the chosen prefix", () => {
  const incoming = [col("i1", "Postman", [req("a", "用户"), req("b", "用户/登录"), req("c", "")])];
  const placed = placeImportedCollections([], incoming, {
    folderMode: "prefix",
    folder: "商城",
  }, ids);
  assert.deepEqual(placed.collections[0].items.map((r) => r.folder), ["商城/用户", "商城/用户/登录", "商城"]);
});

test("unknown collection id falls back to creating a collection", () => {
  const placed = placeImportedCollections([], [col("i1", "HAR 导入", [req("a")])], {
    collectionId: "does-not-exist",
    folderMode: "root",
  }, ids);
  assert.equal(placed.collections.length, 1);
  assert.equal(placed.collections[0].name, "HAR 导入");
  assert.equal(placed.collections[0].items[0].folder, "");
});

test("newCollectionName renames a single new collection only", () => {
  const single = placeImportedCollections([], [col("i1", "cURL 导入", [req("a")])], {
    collectionId: NEW_COLLECTION,
    newCollectionName: "  支付网关  ",
    folderMode: "prefix",
    folder: "外部接口",
  }, ids);
  assert.equal(single.collections[0].name, "支付网关");
  assert.equal(single.collections[0].items[0].folder, "外部接口");

  const multi = placeImportedCollections([], [
    col("i1", "A", [req("a")]),
    col("i2", "B", [req("b")]),
  ], { newCollectionName: "覆盖名" }, ids);
  assert.deepEqual(multi.collections.map((c) => c.name), ["A", "B"]);
});

test("placeImportedCollections 重复导入按方法+URL 覆盖并上报计数", () => {
  const existing = [col("c1", "已有", [{ ...req("a"), url: "https://api.example.com/users" }])];
  const incoming = [col("i1", "导入", [{ ...req("b"), url: "https://api.example.com/users" }])];
  const target = { collectionId: "c1", folderMode: "root" };
  const first = placeImportedCollections(existing, incoming, target, ids);
  assert.equal(first.collections[0].items.length, 1);
  assert.equal(first.overwrittenRequests, 1);
  assert.equal(first.addedRequests, 0);
  assert.deepEqual(first.overwrittenRequestIds, ["a"]);
  assert.equal(first.collections[0].items[0].id, "a", "覆盖保持原 id");

  const second = placeImportedCollections(first.collections, incoming, target, ids);
  assert.equal(second.collections[0].items.length, 1, "第二轮不再增长");
  assert.equal(second.overwrittenRequests, 1);
  assert.deepEqual(second.overwrittenRequestIds, ["a"]);

  const different = [col("i2", "导入", [{ ...req("c"), url: "https://api.example.com/orders" }])];
  const third = placeImportedCollections(second.collections, different, target, ids);
  assert.equal(third.collections[0].items.length, 2);
  assert.equal(third.addedRequests, 1);
  assert.equal(third.overwrittenRequests, 0);
});

test("placeImportedCollections 文件夹不同不互相覆盖", () => {
  const existing = [col("c1", "已有", [req("a", "用户")])];
  const incoming = [col("i1", "导入", [req("b", "订单")])];
  const placed = placeImportedCollections(existing, incoming, { collectionId: "c1" }, ids);
  assert.equal(placed.collections[0].items.length, 2);
  assert.equal(placed.overwrittenRequests, 0);
  assert.equal(placed.addedRequests, 1);
});

test("environment-only import creates no collection", () => {
  const existing = [col("c1", "已有", [req("a")])];
  const placed = placeImportedCollections(existing, [], {
    collectionId: "c1",
    folderMode: "root",
  }, ids);
  assert.equal(placed.collections, existing);
  assert.equal(placed.importedRequests, 0);
  assert.equal(placed.createdCollections, 0);
  assert.equal(placed.targetCollectionId, "c1");
});

test("empty incoming collection with a merged target is a no-op", () => {
  const existing = [col("c1", "已有", [req("a")])];
  const placed = placeImportedCollections(existing, [col("i1", "空", [])], {
    collectionId: "c1",
    folderMode: "root",
  }, ids);
  assert.equal(placed.collections, existing);
  assert.equal(placed.importedRequests, 0);
});
