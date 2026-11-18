// 执行栈统一回归：桌面 / CLI / MCP 必须共用同一份 wire contract 与同一个
// reqora-core 发送引擎；sidecar 不可用时才允许回落到 Node fetch。

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { toWireSpec, wireVariables } from "../src/lib/wireSpec.ts";
import { normalizeEngineResponse } from "../bin/requester.mjs";
import { EngineClient, discoverEngineBin, enginePreference } from "../bin/engineClient.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative) => readFileSync(join(root, relative), "utf8");

const baseRequest = () => ({
  id: "req-1",
  name: "取用户",
  method: "GET",
  url: "{{baseUrl}}/users/:id",
  pathVariables: [{ id: "p1", key: "id", value: "42", enabled: true }],
  headers: [{ id: "h1", key: "X-Token", value: "{{token}}", enabled: true }],
  query: [{ id: "q1", key: "page", value: "1", enabled: true }],
  body: { type: "none" },
  auth: { type: "inherit" },
});

test("wire contract：路径变量已解析、{{}} 留给 Rust、inherit 不越界", () => {
  const spec = toWireSpec(baseRequest(), {
    variables: { baseUrl: "https://api.test", token: 12345 },
    settings: {
      timeoutSecs: 9,
      followRedirects: false,
      verifyTls: false,
      proxyUrl: "  http://127.0.0.1:7890  ",
      manageCookies: false,
    },
  });
  // {{}} 由 Rust 的单次解析器（http.rs: sub(&spec.url, &spec.variables, ...)）
  // 在发送时求值：JS 侧只解析 URL-only 的 :id 路径变量，静态 {{baseUrl}} 与
  // 动态 token 都必须原样保留，且变量表要随 wire spec 一起交给 Rust。
  assert.equal(spec.url, "{{baseUrl}}/users/42", "{{}} 变量由 Rust 单次解析，TS 侧只解析 :id 路径变量");
  assert.equal(spec.headers[0].value, "{{token}}", "变量替换必须由 Rust 单次解析");
  assert.equal(spec.variables.baseUrl, "https://api.test", "baseUrl 必须随 variables 交给 Rust 解析 URL");
  assert.deepEqual(spec.auth, { type: "none" }, "inherit 是前端专用标记");
  assert.equal(spec.variables.token, "12345", "变量必须转成 String");
  assert.equal(spec.timeoutSecs, 9);
  assert.equal(spec.followRedirects, false);
  assert.equal(spec.verifyTls, false);
  assert.equal(spec.proxyUrl, "http://127.0.0.1:7890");
  assert.equal(spec.useCookies, false);
  assert.equal(wireVariables(undefined).x, undefined);
});

test("wire contract：桌面端与 CLI 指向同一实现，Rust 侧只有一份 http.rs", () => {
  const api = source("src/lib/api.ts");
  assert.match(api, /return toWireSpec\(request, options\)/);
  const mod = source("src-tauri/src/service/mod.rs");
  // 发送链下沉到 reqora-core 后，shell 的 service/mod.rs 只声明壳独有的模块，
  // 命令层直接用 `reqora_core::service::...` 引用，不再需要 `pub use` 转出。
  // 这里守护的是「实现只有一份」：shell 侧不得再声明或重新实现 http 模块。
  assert.doesNotMatch(mod, /pub\s+mod\s+http\s*;/, "shell 不得再自带 http 模块");
  assert.equal(
    existsSync(join(root, "src-tauri", "src", "service", "http.rs")),
    false,
    "旧位置若仍有 http.rs 就意味着发送链被复制了",
  );
  assert.equal(
    existsSync(join(root, "src-tauri", "crates", "reqora-core", "src", "service", "http.rs")),
    true,
    "唯一的发送实现必须落在 reqora-core",
  );
  assert.match(
    source("src-tauri/Cargo.toml"),
    /reqora-core\s*=\s*\{\s*path\s*=\s*"crates\/reqora-core"\s*\}/,
    "桌面壳必须链接同一个 reqora-core",
  );
  const requester = source("bin/requester.mjs");
  assert.match(requester, /toWireSpec\(request, \{ variables, settings \}\)/);
  assert.match(requester, /engine\.send\(spec/);
  const core = source("src-tauri/crates/reqora-core/Cargo.toml");
  assert.doesNotMatch(core, /^tauri\s*=/m, "reqora-core 不得依赖 tauri");
});

test("normalizeEngineResponse 收敛为脚本/断言消费的同一形状", () => {
  const data = normalizeEngineResponse({
    requestId: "r1",
    status: 201,
    statusText: "Created",
    ok: true,
    timeMs: 12,
    size: 7,
    url: "https://a.test/x",
    resolvedUrl: "https://a.test/x",
    missingVariables: ["v"],
    headers: [{ name: "X", value: "1" }],
    body: "hello",
    bodyKind: "text",
    truncated: false,
    // 引擎专有字段不得外泄到 MCP / CI 报告
    rawRequest: "GET /x Authorization: Bearer secret",
    rawResponse: "HTTP/1.1 201 ...",
    timings: { totalMs: 12 },
  });
  assert.deepEqual(Object.keys(data).sort(), [
    "body", "bodyKind", "headers", "missingVariables", "ok", "requestId",
    "resolvedUrl", "size", "status", "statusText", "timeMs", "truncated", "url",
  ].sort());
  assert.equal(data.body, "hello");
  assert.equal(data.rawRequest, undefined);
  assert.equal(data.timings, undefined);
});

const bin = discoverEngineBin();
const skipReason = enginePreference() === "node"
  ? "REQORA_ENGINE=node"
  : bin ? false : "未构建 reqora-send（先跑 bun run engine:build:debug）";

test("sidecar 握手 + 真实 HTTP + 跨请求 Cookie Jar + 结构化错误", { skip: skipReason }, async () => {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url, cookie: request.headers.cookie ?? "" });
    if (request.url === "/hello") {
      response.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "sid=engine-1; Path=/",
      });
      response.end(JSON.stringify({ ok: true, path: request.url }));
      return;
    }
    if (request.url === "/echo-cookie") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(request.headers.cookie ?? "no-cookie");
      return;
    }
    response.writeHead(404);
    response.end("nope");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = new EngineClient(bin);
  try {
    const spec = (url) => toWireSpec(
      { ...baseRequest(), url, pathVariables: [], headers: [], query: [] },
      { variables: {}, settings: { timeoutSecs: 5, followRedirects: true } },
    );
    const first = await client.send(spec(`${base}/hello`));
    assert.equal(first.status, 200);
    assert.equal(first.requestId.startsWith("sidecar-"), true);
    assert.equal(JSON.parse(first.body).ok, true);
    assert.equal(seen[0].url, "/hello", "空 query 不能给 URL 添加多余的 ?");
    assert.ok(Array.isArray(first.headers));
    assert.ok(first.timings, "分段计时来自 reqora-core");

    const second = await client.send(spec(`${base}/echo-cookie`));
    assert.equal(second.body, "sid=engine-1", "cookie jar 必须在多次 send 之间保留");

    await assert.rejects(
      () => client.send(spec("not-a-url")),
      (error) => {
        assert.equal(error.code, "INVALID_INPUT");
        assert.match(error.message, /URL|格式/);
        return true;
      },
    );
  } finally {
    client.close();
    server.close();
  }
});
