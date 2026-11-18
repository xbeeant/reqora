import assert from "node:assert/strict";
import test from "node:test";

import { runCliScript } from "../bin/cliScriptRuntime.mjs";
import { WORKER_HELPERS_SOURCE } from "../src/lib/scripts.ts";

function makeRequest() {
  return {
    id: "r1",
    name: "示例请求",
    method: "GET",
    url: "https://example.test/api",
    headers: [{ id: "h1", key: "Accept", value: "application/json", enabled: true }],
    query: [],
    body: { type: "none" },
    auth: { type: "none" },
  };
}

function makeResponse() {
  return {
    requestId: "cli",
    status: 200,
    statusText: "OK",
    ok: true,
    timeMs: 12,
    size: 30,
    url: "https://example.test/api",
    resolvedUrl: "https://example.test/api",
    headers: [{ name: "Content-Type", value: "application/json" }],
    body: '{"data":{"id":42}}',
    bodyKind: "json",
    truncated: false,
  };
}

test("CLI 与桌面端共用同一份 helper 源码", () => {
  assert.ok(WORKER_HELPERS_SOURCE.includes("function setVar("));
  assert.ok(WORKER_HELPERS_SOURCE.includes("function hmac("));
  assert.ok(WORKER_HELPERS_SOURCE.includes("function test("));
});

test("空脚本原样返回且不报错", async () => {
  const request = makeRequest();
  const result = await runCliScript({ code: "   ", request, variables: { a: "1" } });
  assert.equal(result.error, null);
  assert.deepEqual(result.variables, { a: "1" });
  assert.equal(result.request.url, request.url);
  assert.deepEqual(result.logs, []);
});

test("getHeader / getQuery 忽略禁用的同名行", async () => {
  const request = makeRequest();
  request.headers = [
    { id: "h-old", key: "Authorization", value: "Bearer old", enabled: false },
    { id: "h-new", key: "Authorization", value: "Bearer new", enabled: true },
    { id: "h-off", key: "X-Disabled", value: "stale", enabled: false },
  ];
  request.query = [
    { id: "q-old", key: "page", value: "1", enabled: false },
    { id: "q-new", key: "page", value: "2", enabled: true },
  ];
  const result = await runCliScript({
    code: `
      log('auth=' + getHeader('Authorization'));
      log('page=' + getQuery('page'));
      log('missing=' + getHeader('X-Missing'));
      log('disabled=' + getHeader('X-Disabled'));
    `,
    request,
  });
  assert.equal(result.error, null);
  assert.deepEqual(result.logs, ["auth=Bearer new", "page=2", "missing=null", "disabled=null"]);
});

test("setHeader / setQuery 不会重新启用被禁用的同名行", async () => {
  const request = makeRequest();
  request.headers = [{ id: "h-off", key: "X-Token", value: "old", enabled: false }];
  request.query = [{ id: "q-off", key: "token", value: "old", enabled: false }];
  const result = await runCliScript({
    code: `
      setHeader('X-Token', 'fresh');
      setQuery('token', 'fresh-q');
      log(getHeader('X-Token') + '/' + getQuery('token'));
    `,
    request,
  });
  assert.equal(result.error, null);
  assert.equal(result.logs[0], "fresh/fresh-q");
  assert.equal(result.request.headers.find((row) => row.id === "h-off").enabled, false);
  assert.equal(result.request.query.find((row) => row.id === "q-off").enabled, false);
  assert.equal(result.request.headers.filter((row) => row.enabled).length, 1);
  assert.equal(result.request.query.filter((row) => row.enabled).length, 1);
});

test("前置脚本可改 URL / Header / Query / Body / 变量", async () => {
  const result = await runCliScript({
    code: `
      setUrl('https://example.test/v2');
      setHeader('X-Trace', 'abc');
      setQuery('page', '2');
      setBody({ hello: 'world' });
      setVar('token', 't-1');
      unsetVar('obsolete');
    `,
    request: makeRequest(),
    variables: { obsolete: "x", base: "b" },
  });
  assert.equal(result.error, null);
  assert.equal(result.request.url, "https://example.test/v2");
  assert.equal(result.request.headers.find((row) => row.key === "X-Trace").value, "abc");
  assert.equal(result.request.query.find((row) => row.key === "page").value, "2");
  assert.equal(result.request.body.type, "json");
  assert.equal(result.variables.token, "t-1");
  assert.equal(result.variables.obsolete, undefined);
  assert.equal(result.variables.base, "b");
  assert.ok(result.mutations.includes("var:token"));
});

test("异步 helper sha256 / hmac / uuid / base64 在 CLI 可用", async () => {
  const result = await runCliScript({
    code: `
      log(await sha256('abc'));
      log(await hmac('sha256', 'key', 'text'));
      log(uuid());
      log(base64('hi'));
    `,
    request: makeRequest(),
  });
  assert.equal(result.error, null);
  assert.equal(result.logs[0], "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.match(result.logs[1], /^[0-9a-f]{64}$/);
  assert.match(result.logs[2], /^[0-9a-f-]{36}$/);
  assert.equal(result.logs[3], "aGk=");
});

test("后置脚本可读响应、写 test 与 log", async () => {
  const result = await runCliScript({
    code: `
      log('status=' + response.status);
      log('ct=' + header('content-type'));
      log('id=' + json('$.data.id'));
      test('status 200', function () { assert(response.status === 200); });
      test('提取 id', function () { assert(json('$.data.id') === 42); });
    `,
    request: makeRequest(),
    response: makeResponse(),
  });
  assert.equal(result.error, null);
  assert.deepEqual(result.logs, ["status=200", "ct=application/json", "id=42"]);
  assert.equal(result.tests.length, 2);
  assert.ok(result.tests.every((item) => item.ok));
});

test("失败的 test 记录 message 且不抛到外层", async () => {
  const result = await runCliScript({
    code: `test('应当失败', function () { assert(false, '预期不成立'); });`,
    request: makeRequest(),
    response: makeResponse(),
  });
  assert.equal(result.error, null);
  assert.equal(result.tests[0].ok, false);
  assert.match(result.tests[0].message, /预期不成立/);
});

test("脚本抛错时返回 error 而非崩溃", async () => {
  const result = await runCliScript({
    code: `throw new Error('boom');`,
    request: makeRequest(),
  });
  assert.match(result.error, /boom/);
});

test("语法错误返回可阅读的错误", async () => {
  const result = await runCliScript({
    code: `function (`,
    request: makeRequest(),
  });
  assert.match(result.error, /脚本执行失败/);
});

test("同步死循环被超时终止", async () => {
  const result = await runCliScript({
    code: `while (true) {}`,
    request: makeRequest(),
    timeoutMs: 150,
  });
  assert.match(result.error, /超过 150ms|timed out/i);
});
