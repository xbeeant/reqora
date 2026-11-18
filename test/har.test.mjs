/**
 * HAR 1.2 导入测试：entry → RequestDraft 转换、query 拆表、cookie 注入、
 * 各类 postData 形态、重名去重、上限截断与格式检测。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { detectFormat, importHar } from "../src/lib/transfer.ts";

function har(entries) {
  return JSON.stringify({
    log: { version: "1.2", creator: { name: "test", version: "1" }, entries },
  });
}

test("importHar: 基本 entry 转换（query 拆表 + header + 命名）", () => {
  const result = importHar(
    har([
      {
        request: {
          method: "GET",
          url: "https://api.example.com/users?page=2&size=10",
          headers: [{ name: "Accept", value: "application/json" }],
          queryString: [],
          cookies: [],
        },
      },
    ]),
  );
  assert.equal(result.collections.length, 1);
  assert.equal(result.collections[0].name, "HAR 导入");
  const item = result.collections[0].items[0];
  assert.equal(item.name, "GET /users");
  assert.equal(item.method, "GET");
  assert.equal(item.url, "https://api.example.com/users");
  assert.deepEqual(
    item.query.map((q) => [q.key, q.value]),
    [["page", "2"], ["size", "10"]],
  );
  assert.equal(item.headers[0].key, "Accept");
  assert.equal(item.body.type, "none");
});

test("importHar: cookies 转 Cookie 头，显式 Cookie 头优先不重复", () => {
  const result = importHar(
    har([
      {
        request: {
          method: "GET",
          url: "https://a.com/x",
          headers: [],
          cookies: [
            { name: "sid", value: "abc" },
            { name: "theme", value: "dark" },
          ],
        },
      },
      {
        request: {
          method: "GET",
          url: "https://a.com/y",
          headers: [{ name: "Cookie", value: "keep=1" }],
          cookies: [{ name: "sid", value: "abc" }],
        },
      },
    ]),
  );
  const [first, second] = result.collections[0].items;
  assert.equal(first.headers[0].key, "Cookie");
  assert.equal(first.headers[0].value, "sid=abc; theme=dark");
  assert.equal(second.headers[0].value, "keep=1");
  assert.equal(second.headers.length, 1);
});

test("importHar: postData 各形态（json / urlencoded / multipart / raw）", () => {
  const result = importHar(
    har([
      {
        request: {
          method: "POST", url: "https://a.com/json",
          headers: [], cookies: [],
          postData: { mimeType: "application/json; charset=utf-8", text: '{"a":1}' },
        },
      },
      {
        request: {
          method: "POST", url: "https://a.com/form",
          headers: [], cookies: [],
          postData: { mimeType: "application/x-www-form-urlencoded", params: [{ name: "user", value: "张三" }] },
        },
      },
      {
        request: {
          method: "POST", url: "https://a.com/multi",
          headers: [], cookies: [],
          postData: { mimeType: "multipart/form-data; boundary=x", params: [{ name: "f", value: "1", fileName: "a.txt" }] },
        },
      },
      {
        request: {
          method: "PUT", url: "https://a.com/raw",
          headers: [], cookies: [],
          postData: { mimeType: "text/plain", text: "hello" },
        },
      },
    ]),
  );
  const items = result.collections[0].items;
  assert.deepEqual([items[0].body.type, items[1].body.type, items[2].body.type, items[3].body.type], [
    "json", "formUrlEncoded", "formData", "raw",
  ]);
  assert.equal(items[0].body.content, '{"a":1}');
  assert.equal(items[1].body.items[0].key, "user");
  assert.equal(items[1].body.items[0].value, "张三");
  assert.ok(result.warnings.some((w) => w.includes("文件字段")));
  assert.equal(items[3].body.contentType, "text/plain");
});

test("importHar: 重名去重 + 非法 method 归一 GET + 缺 URL 跳过计 warning", () => {
  const result = importHar(
    har([
      { request: { method: "get", url: "https://a.com/same" } },
      { request: { method: "GET", url: "https://b.com/same" } },
      { request: { method: "POST", url: "" } },
      {},
    ]),
  );
  const items = result.collections[0].items;
  assert.deepEqual(items.map((item) => item.name), ["GET /same", "GET /same (2)"]);
  assert.ok(items.every((item) => item.method === "GET"));
  assert.ok(result.warnings.some((w) => w.includes("2 条 entry")));
});

test("importHar: 上限 200 截断 + 空 entries / 非法 JSON 抛中文错误", () => {
  const many = Array.from({ length: 205 }, (_, i) => ({
    request: { method: "GET", url: `https://a.com/p${i}` },
  }));
  const result = importHar(har(many));
  assert.equal(result.collections[0].items.length, 200);
  assert.ok(result.warnings.some((w) => w.includes("仅导入前 200 条")));

  assert.throws(() => importHar(har([])), /log\.entries/);
  assert.throws(() => importHar("not json"), /合法 JSON/);
  assert.throws(() => importHar(JSON.stringify({ log: { entries: [] } })), /log\.entries/);
});

test("detectFormat 识别 HAR（log.entries）且不误伤 Postman/OpenAPI", () => {
  assert.equal(detectFormat(har([{ request: { method: "GET", url: "https://a.com" } }])), "har");
  assert.equal(detectFormat('{"info":{"schema":"postman v2.1"}}'), "postman");
  assert.equal(detectFormat('{"openapi":"3.0.0"}'), "openapi");
  assert.equal(detectFormat('{"log":{"entries":[]}}'), "har");
  assert.equal(detectFormat('{"other":1}'), "unknown");
});
