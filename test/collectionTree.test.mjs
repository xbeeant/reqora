import test from "node:test";
import assert from "node:assert/strict";
import {
  moveFolderInTree,
  moveRequestInTree,
  renameFolderInTree,
  renameRequestInTree,
} from "../src/lib/collectionTree.ts";

const req = (id, folder = "", extra = {}) => ({
  id,
  name: `接口 ${id}`,
  folder,
  method: "GET",
  url: "https://example.com",
  ...extra,
});
const col = (id, ...items) => ({ id, name: `集合 ${id}`, items });
const ids = (collections, id) => collections.find((c) => c.id === id).items.map((r) => r.id);

test("moveRequestInTree: insert before / after a sibling changes array order", () => {
  const collections = [col("c1", req("a", "用户"), req("b", "用户"), req("c", "用户"))];
  const before = moveRequestInTree(
    collections,
    { collectionId: "c1", requestId: "c" },
    { collectionId: "c1", folder: "用户", beforeId: "a" },
  );
  assert.deepEqual(ids(before, "c1"), ["c", "a", "b"]);
  const after = moveRequestInTree(
    collections,
    { collectionId: "c1", requestId: "a" },
    { collectionId: "c1", folder: "用户", afterId: "c" },
  );
  assert.deepEqual(ids(after, "c1"), ["b", "c", "a"]);
  // Original arrays are left untouched (immutability).
  assert.deepEqual(ids(collections, "c1"), ["a", "b", "c"]);
});

test("moveRequestInTree: dropping on a folder rewrites the folder path", () => {
  const collections = [
    col("c1", req("a", ""), req("b", "用户"), req("c", "订单")),
  ];
  const next = moveRequestInTree(
    collections,
    { collectionId: "c1", requestId: "a" },
    { collectionId: "c1", folder: "用户" },
  );
  const item = next[0].items.find((r) => r.id === "a");
  assert.equal(item.folder, "用户");
  // Without an anchor it lands right after the last request of that folder.
  assert.deepEqual(ids(next, "c1"), ["b", "a", "c"]);
});

test("moveRequestInTree: dropping on the collection root clears the folder", () => {
  const collections = [col("c1", req("a", "用户/登录"), req("b", ""))];
  const next = moveRequestInTree(
    collections,
    { collectionId: "c1", requestId: "a" },
    { collectionId: "c1", folder: "" },
  );
  assert.equal(next[0].items.find((r) => r.id === "a").folder, "");
});

test("moveRequestInTree: cross-collection drop removes from source and inserts into target", () => {
  const collections = [
    col("c1", req("a", "用户"), req("b", "用户")),
    col("c2", req("x", "订单"), req("y", "订单")),
  ];
  const next = moveRequestInTree(
    collections,
    { collectionId: "c1", requestId: "a" },
    { collectionId: "c2", folder: "订单", beforeId: "y" },
  );
  assert.deepEqual(ids(next, "c1"), ["b"]);
  assert.deepEqual(ids(next, "c2"), ["x", "a", "y"]);
  assert.equal(next[1].items.find((r) => r.id === "a").folder, "订单");
  assert.deepEqual(ids(collections, "c1"), ["a", "b"]);
});

test("moveRequestInTree: no-op, unknown ids and unknown target return the original reference", () => {
  const collections = [col("c1", req("a", ""), req("b", ""))];
  assert.equal(
    moveRequestInTree(collections, { collectionId: "c1", requestId: "missing" }, { collectionId: "c1", folder: "" }),
    collections,
  );
  assert.equal(
    moveRequestInTree(collections, { collectionId: "c1", requestId: "a" }, { collectionId: "nope", folder: "" }),
    collections,
  );
  const samePlace = moveRequestInTree(
    collections,
    { collectionId: "c1", requestId: "b" },
    { collectionId: "c1", folder: "", afterId: "a" },
  );
  assert.equal(samePlace, collections);
  assert.deepEqual(ids(samePlace, "c1"), ["a", "b"]);
});

test("moveRequestInTree: an unresolved anchor falls back to the folder tail", () => {
  const collections = [col("c1", req("a", ""), req("b", "用户"))];
  const next = moveRequestInTree(
    collections,
    { collectionId: "c1", requestId: "a" },
    { collectionId: "c1", folder: "用户", beforeId: "does-not-exist" },
  );
  assert.deepEqual(ids(next, "c1"), ["b", "a"]);
});

test("renameRequestInTree: only the name changes, no updatedAt bump", () => {
  const collections = [col("c1", req("a", "", { updatedAt: 123 }), req("b"))];
  const next = renameRequestInTree(collections, "a", "  新名字  ");
  assert.equal(next[0].items[0].name, "新名字");
  assert.equal(next[0].items[0].updatedAt, 123);
  assert.equal(next[0].items[0].folder, "");
  assert.equal(renameRequestInTree(collections, "a", "   "), collections);
  assert.equal(renameRequestInTree(collections, "missing", "x"), collections);
});

test("renameFolderInTree: cascades to sub-folders without matching prefixes by accident", () => {
  const collections = [col("c1", req("a", "用户"), req("b", "用户/登录"), req("c", "用户组"), req("d", ""))];
  const next = renameFolderInTree(collections, "c1", "用户", "会员");
  assert.deepEqual(next[0].items.map((r) => r.folder), ["会员", "会员/登录", "用户组", ""]);
  assert.deepEqual(collections[0].items.map((r) => r.folder), ["用户", "用户/登录", "用户组", ""]);
  assert.equal(renameFolderInTree(collections, "c1", "用户", "用户/子"), collections);
  assert.equal(renameFolderInTree(collections, "c1", "nope", "x"), collections);
});

test("moveFolderInTree: same collection is a path rename; cross collection migrates every descendant", () => {
  const collections = [
    col("c1", req("a", "用户/登录"), req("b", "用户/登录/子"), req("c", "订单")),
    col("c2", req("x", "公共")),
  ];
  const nested = moveFolderInTree(
    collections,
    { collectionId: "c1", path: "用户" },
    { collectionId: "c1", folder: "会员" },
  );
  assert.deepEqual(nested[0].items.map((r) => r.folder), [
    "会员/用户/登录",
    "会员/用户/登录/子",
    "订单",
  ]);

  // Dropping a nested folder onto the root promotes it to a top-level folder.
  const promoted = moveFolderInTree(
    collections,
    { collectionId: "c1", path: "用户/登录" },
    { collectionId: "c1", folder: "" },
  );
  assert.deepEqual(promoted[0].items.map((r) => r.folder), ["登录", "登录/子", "订单"]);

  const moved = moveFolderInTree(
    collections,
    { collectionId: "c1", path: "用户" },
    { collectionId: "c2", folder: "公共" },
  );
  assert.deepEqual(ids(moved, "c1"), ["c"]);
  assert.deepEqual(ids(moved, "c2"), ["x", "a", "b"]);
  assert.deepEqual(moved[1].items.map((r) => r.folder), [
    "公共",
    "公共/用户/登录",
    "公共/用户/登录/子",
  ]);
});

test("moveFolderInTree: refuses to move a folder into itself or its own descendant", () => {
  const collections = [col("c1", req("a", "用户"), req("b", "用户/登录"))];
  assert.equal(
    moveFolderInTree(collections, { collectionId: "c1", path: "用户" }, { collectionId: "c1", folder: "用户" }),
    collections,
  );
  assert.equal(
    moveFolderInTree(collections, { collectionId: "c1", path: "用户" }, { collectionId: "c1", folder: "用户/登录" }),
    collections,
  );
});
