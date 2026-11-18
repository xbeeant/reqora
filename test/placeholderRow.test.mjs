import test from "node:test";
import assert from "node:assert/strict";

import { applyRowEdit, newPlaceholderId } from "../src/lib/placeholderRow.ts";

const makeRow = (id) => ({ id, key: "", value: "", enabled: true });

test("连续输入 type 只生成一行，且正在编辑的行 key 不变", () => {
  // The focused input is the DOM node whose React key is `focusedKey`.
  // Regression: it used to stay on an empty add-row, so every keystroke
  // promoted a fresh one-character row (t / y / p / e).
  const focusedKey = "__add_row__focused";
  let state = { items: [], placeholderId: focusedKey };
  for (const char of "type") {
    const row = state.items.find((item) => item.id === focusedKey);
    state = applyRowEdit(state, focusedKey, { key: (row?.key ?? "") + char }, makeRow);
  }
  assert.equal(state.items.length, 1, "四个字符不应变成四行");
  assert.equal(state.items[0].key, "type");
  assert.equal(state.items[0].id, focusedKey, "提升后的行必须沿用原 key，DOM 才不会重新挂载");
  assert.equal(state.items[0].enabled, true);
  assert.notEqual(state.placeholderId, focusedKey);
});

test("提升后轮转新的新增行 id，且不与任何实体行冲突", () => {
  const first = "__add_row__a";
  const next = applyRowEdit({ items: [], placeholderId: first }, first, { key: "a" }, makeRow);
  assert.notEqual(next.placeholderId, first);
  assert.ok(!next.items.some((item) => item.id === next.placeholderId));

  const second = applyRowEdit(next, next.placeholderId, { key: "b" }, makeRow);
  assert.equal(second.items.length, 2);
  assert.deepEqual(second.items.map((item) => item.key), ["a", "b"]);
  assert.equal(second.items[1].id, next.placeholderId);
});

test("编辑已有行不轮转新增行 id，也不额外生成行", () => {
  const state = {
    items: [{ ...makeRow("real"), key: "type" }],
    placeholderId: "__add_row__p",
  };
  const next = applyRowEdit(state, "real", { value: "json" }, makeRow);
  assert.equal(next.items.length, 1);
  assert.deepEqual(next.items[0], { id: "real", key: "type", value: "json", enabled: true });
  assert.equal(next.placeholderId, state.placeholderId);
});

test("文件选择器持有的旧新增行 id 仍提升为新行（异步竞态）", () => {
  const stale = "__add_row__stale";
  const state = { items: [], placeholderId: "__add_row__current" };
  const makePart = (id) => ({ ...makeRow(id), fileName: "", file: false });
  const next = applyRowEdit(state, stale, { key: "avatar", fileName: "a.png" }, makePart);
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0].id, stale);
  assert.equal(next.items[0].fileName, "a.png");
  assert.equal(next.items[0].file, false);
});

test("newPlaceholderId 生成带前缀且避开已存在 id 的 key", () => {
  const id = newPlaceholderId(["x", "y"]);
  assert.match(id, /^__add_row__/u);
  assert.ok(!["x", "y"].includes(id));
  assert.notEqual(id, newPlaceholderId());
});
