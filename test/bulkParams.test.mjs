import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BULK_ROWS,
  applyBulkEdit,
  applyCaseStyle,
  itemsToBulkText,
  parseBulkText,
  serializeBulkRows,
} from "../src/lib/bulkParams.ts";

const kvRow = (id, key, value, extra = {}) => ({ id, key, value, enabled: true, ...extra });
const rowsOf = (text, format = "kv") => parseBulkText(text, format).rows;

test("kv: colon / equals / tab separators, blank lines and comments", () => {
  const text = [
    "a:b",
    "page = 2",
    "flag\ttrue",
    "",
    "   ",
    "# 这是一行注释",
    "// 也是注释",
    "bare_key",
  ].join("\r\n");
  assert.deepEqual(rowsOf(text), [
    { key: "a", value: "b", description: "" },
    { key: "page", value: "2", description: "" },
    { key: "flag", value: "true", description: "" },
    { key: "bare_key", value: "", description: "" },
  ]);
});

test("kv: colons inside values survive; quoted keys with colons work", () => {
  assert.deepEqual(rowsOf("callback: http://example.com:8080/hook"), [
    { key: "callback", value: "http://example.com:8080/hook", description: "" },
  ]);
  assert.deepEqual(rowsOf('"a:b": "x:y"'), [
    { key: "a:b", value: "x:y", description: "" },
  ]);
  assert.deepEqual(rowsOf("token=abc=def"), [
    { key: "token", value: "abc=def", description: "" },
  ]);
});

test("json: nested objects and arrays flatten to dotted / indexed paths", () => {
  const text = JSON.stringify({
    user: { id: 1, name: "Ada", active: true, extra: null },
    list: [{ id: 2 }, 3],
    empty: {},
  });
  assert.deepEqual(rowsOf(text, "json"), [
    { key: "user.id", value: "1", description: "" },
    { key: "user.name", value: "Ada", description: "" },
    { key: "user.active", value: "true", description: "" },
    { key: "user.extra", value: "", description: "" },
    { key: "list[0].id", value: "2", description: "" },
    { key: "list[1]", value: "3", description: "" },
    { key: "empty", value: "{}", description: "" },
  ]);
});

test("json: empty input is valid, malformed input reports a readable error", () => {
  assert.deepEqual(parseBulkText("  ", "json"), { rows: [], error: null, truncated: false });
  const bad = parseBulkText('{"a":', "json");
  assert.equal(bad.rows.length, 0);
  assert.match(bad.error, /^JSON 解析失败：/);
});

test("desc: last column is the description, colons in the value survive", () => {
  assert.deepEqual(
    rowsOf("page: 1: 页码\nurl: http://x:8080/a: 回调地址\nkeyword\tabc\t搜索词", "desc"),
    [
      { key: "page", value: "1", description: "页码" },
      { key: "url", value: "http://x:8080/a", description: "回调地址" },
      { key: "keyword", value: "abc", description: "搜索词" },
    ],
  );
  assert.deepEqual(rowsOf("bare: value", "desc"), [
    { key: "bare", value: "value", description: "" },
  ]);
});

test("parsing is bounded and reports truncation", () => {
  const text = Array.from({ length: MAX_BULK_ROWS + 3 }, (_, i) => `k${i}:v${i}`).join("\n");
  const result = parseBulkText(text, "kv");
  assert.equal(result.truncated, true);
  assert.equal(result.rows.length, MAX_BULK_ROWS);
  assert.equal(result.rows[0].key, "k0");
});

test("case styles: camel / pascal / snake, non-ASCII keys untouched", () => {
  assert.equal(applyCaseStyle("user_name", "camel"), "userName");
  assert.equal(applyCaseStyle("user-name", "pascal"), "UserName");
  assert.equal(applyCaseStyle("UserID", "snake"), "user_id");
  assert.equal(applyCaseStyle("user_name", "as-is"), "user_name");
  assert.equal(applyCaseStyle("用户名", "camel"), "用户名");
  assert.equal(applyCaseStyle("!!!", "snake"), "!!!");
});

test("serialize: all three formats round-trip through their parser", () => {
  const rows = [
    { key: "page", value: "1", description: "页码" },
    { key: "url", value: "http://x:8080", description: "回调地址" },
  ];
  for (const format of ["kv", "json", "desc"]) {
    const text = serializeBulkRows(rows, format);
    const parsed = rowsOf(text, format);
    assert.equal(parsed.length, rows.length, `${format}: row count`);
    assert.equal(parsed[0].key, "page");
    assert.equal(parsed[1].value, "http://x:8080");
  }
  assert.equal(rowsOf(serializeBulkRows(rows, "desc"), "desc")[0].description, "页码");
  assert.equal(serializeBulkRows([], "json"), "{}");
});

test("itemsToBulkText drops blank rows and preserves values with colons", () => {
  const items = [
    kvRow("r1", "page", "1"),
    kvRow("r2", "", "orphan value"),
    kvRow("r3", "callback", "http://x:8080"),
  ];
  assert.equal(itemsToBulkText(items), "page: 1\ncallback: http://x:8080");
  assert.deepEqual(rowsOf(itemsToBulkText(items)).map((row) => row.value), [
    "1",
    "http://x:8080",
  ]);
});

test("applyBulkEdit replace: keeps row id / enabled / secret for matching keys", () => {
  const existing = [
    kvRow("r1", "page", "1", { enabled: false, secret: true }),
    kvRow("r2", "old", "x"),
    kvRow("r3", "", "trailing blank"),
  ];
  const { items, descriptions } = applyBulkEdit({
    existing,
    rows: [
      { key: "page", value: "2", description: "页码" },
      { key: "keyword", value: "abc", description: "" },
    ],
    caseStyle: "as-is",
    mode: "replace",
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].id, "r1");
  assert.equal(items[0].enabled, false);
  assert.equal(items[0].secret, true);
  assert.equal(items[0].value, "2");
  assert.notEqual(items[1].id, "__placeholder__");
  assert.equal(items[1].enabled, true);
  assert.deepEqual(descriptions, { r1: "页码" });
});

test("applyBulkEdit append: untouched rows stay, blank rows are cleaned", () => {
  const existing = [kvRow("r1", "page", "1"), kvRow("r2", "", "")];
  const { items } = applyBulkEdit({
    existing,
    rows: [{ key: "keyword", value: "abc", description: "" }],
    caseStyle: "as-is",
    mode: "append",
  });
  assert.deepEqual(items.map((row) => row.key), ["page", "keyword"]);
});

test("applyBulkEdit: case rename still reuses the original row id", () => {
  const existing = [kvRow("r1", "user_name", "Ada")];
  const { items, descriptions } = applyBulkEdit({
    existing,
    rows: [{ key: "user_name", value: "Grace", description: "用户名" }],
    caseStyle: "camel",
    mode: "replace",
  });
  assert.equal(items[0].id, "r1");
  assert.equal(items[0].key, "userName");
  assert.equal(items[0].value, "Grace");
  assert.deepEqual(descriptions, { r1: "用户名" });
});

test("applyBulkEdit: duplicate keys collapse, empty keys are ignored, ids are unique", () => {
  const { items, descriptions } = applyBulkEdit({
    existing: [],
    rows: [
      { key: "page", value: "1", description: "第一版" },
      { key: "page", value: "2", description: "页码" },
      { key: "", value: "ignored", description: "" },
    ],
    caseStyle: "as-is",
    mode: "replace",
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].value, "2");
  assert.deepEqual(descriptions, { [items[0].id]: "页码" });
  assert.equal(new Set(items.map((row) => row.id)).size, items.length);
});
