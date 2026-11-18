import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MCP_TOOL_SUMMARY, MCP_WRITE_TOOL_NAMES } from "../src/lib/mcpToolCatalog.ts";
import { createMcpServer } from "../bin/mcpServer.mjs";
import { WorkspaceStore } from "../bin/workspaceStore.mjs";

// --------------------------------------------------------------- fixtures ----

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE entity (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, parent_id TEXT,
  folder_path TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
  method TEXT, url TEXT, protocol TEXT, auth TEXT,
  position INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  case_group TEXT, sub_kind TEXT, updated_at INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}',
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE history (id TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE trash (id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE request_revision (
  request_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL,
  data TEXT NOT NULL, PRIMARY KEY (request_id, id)
);
`;

/** A project directory with a real `workspace.db` built from the app's schema. */
async function makeProject(rows = defaultRows()) {
  const dir = mkdtempSync(join(tmpdir(), "reqora-mcp-"));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(dir, "workspace.db"));
  db.exec(SCHEMA);
  db.prepare("INSERT INTO meta (key, value) VALUES ('settings', ?)").run(
    JSON.stringify({ timeoutSecs: 5, followRedirects: true }),
  );
  db.prepare("INSERT INTO meta (key, value) VALUES ('activeEnvironmentId', ?)").run('"env-1"');
  for (const row of rows) {
    db.prepare(
      `INSERT INTO entity (id, kind, parent_id, folder_path, name, method, url, protocol, auth,
        position, enabled, case_group, sub_kind, updated_at, deleted, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.kind,
      row.parentId ?? null,
      row.folder ?? "",
      row.name,
      row.method ?? null,
      row.url ?? null,
      row.protocol ?? null,
      row.auth ? JSON.stringify(row.auth) : null,
      row.position ?? 0,
      row.enabled === false ? 0 : 1,
      row.caseGroup ?? null,
      row.subKind ?? null,
      row.updatedAt ?? 1,
      row.deleted ? 1 : 0,
      JSON.stringify(row.data ?? {}),
    );
  }
  db.close();
  return dir;
}

function defaultRows(baseUrl = "https://example.test") {
  return [
    { id: "col-1", kind: "folder", name: "示例集合" },
    {
      id: "req-1",
      kind: "request",
      parentId: "col-1",
      name: "取用户",
      method: "GET",
      url: `${baseUrl}/users/:id`,
      protocol: "http",
      data: {
        pathVariables: [{ id: "p1", key: "id", value: "7", enabled: true }],
        headers: [
          { id: "h1", key: "Authorization", value: "Bearer super-secret-token", enabled: true },
          { id: "h2", key: "Accept", value: "application/json", enabled: true },
        ],
        query: [],
        body: { type: "none" },
        auth: { type: "none" },
        assertions: [],
        doc: { summary: "按 id 取用户", description: "", owner: "", status: "已完成", tags: [], paramMeta: {}, responses: [], updatedAt: 1 },
      },
    },
    { id: "env-1", kind: "environment", name: "测试环境", data: { variables: [{ id: "v1", key: "baseUrl", value: baseUrl, enabled: true }], headers: [] } },
    {
      id: "case-1",
      kind: "case",
      parentId: "req-1",
      name: "正向 · 存在用户",
      caseGroup: "正向",
      enabled: true,
      data: {
        request: {
          id: "case-req-1",
          name: "取用户",
          method: "GET",
          url: `${baseUrl}/users/7`,
          headers: [],
          query: [],
          body: { type: "none" },
          auth: { type: "none" },
          assertions: [{ id: "a1", enabled: true, name: "", source: "status", path: "", op: "eq", value: "200" }],
        },
        expectedStatus: 200,
        syncedAt: 1,
        createdAt: 1,
      },
    },
    {
      id: "scn-1",
      kind: "scenario",
      name: "回显链路",
      data: {
        description: "",
        createdAt: 1,
        steps: [
          { id: "step-1", name: "取用户", enabled: true, source: { kind: "case", caseId: "case-1" }, extracts: [{ id: "e1", varName: "uid", source: "json", path: "$.id" }], continueOnFailure: false },
          { id: "step-2", name: "等待", enabled: true, source: { kind: "wait", ms: 0 }, extracts: [], continueOnFailure: false },
        ],
      },
    },
    { id: "doc-1", kind: "artifact", subKind: "docPage", name: "鉴权说明", data: { slug: "auth", group: "guide", body: "# 鉴权" } },
    { id: "gone-1", kind: "request", parentId: "col-1", name: "已删除接口", method: "GET", url: "", deleted: true, data: {} },
  ];
}

async function makeServer({ allowWrite = false, baseUrl } = {}) {
  const dir = await makeProject(defaultRows(baseUrl));
  const store = new WorkspaceStore(
    { kind: "sqlite", dir, projectId: "test", projectName: "测试项目" },
    { allowWrite },
  );
  return { dir, store, server: createMcpServer({ store, allowWrite }) };
}

/** Drive the JSON-RPC surface exactly like a client would. */
async function rpc(server, method, params) {
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method, params });
  return response?.result;
}

async function call(server, name, args) {
  const result = await rpc(server, "tools/call", { name, arguments: args });
  assert.ok(result, `${name} 没有返回`);
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) return { isError: true, error: text };
  return JSON.parse(text);
}

// ------------------------------------------------------------------ tests ----

test("SQLite 行模型能重建出与桌面端一致的快照", async () => {
  const { store } = await makeServer();
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.collections.length, 1);
  assert.equal(snapshot.collections[0].name, "示例集合");
  // The tombstoned row must not show up as a live interface.
  assert.deepEqual(snapshot.collections[0].items.map((item) => item.name), ["取用户"]);
  assert.equal(snapshot.cases[0].requestId, "req-1");
  assert.equal(snapshot.cases[0].group, "正向");
  assert.equal(snapshot.environments[0].variables[0].key, "baseUrl");
  assert.equal(snapshot.docPages[0].title, "鉴权说明");
  assert.equal(snapshot.scenarios[0].steps.length, 2);
  store.close();
});

test("旧版拆分 JSON 工作区仍然可读", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reqora-json-"));
  const rows = { collections: [{ id: "c", name: "旧集合", items: [] }], cases: [], scenarios: [] };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ keys: ["collections", "cases", "scenarios"] }));
  writeFileSync(join(dir, "collections.json"), JSON.stringify(rows.collections));
  writeFileSync(join(dir, "cases.json"), "[]");
  writeFileSync(join(dir, "scenarios.json"), "[]");
  const store = new WorkspaceStore({ kind: "split", dir }, {});
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.collections[0].name, "旧集合");
});

test("initialize 协商协议版本并声明工具与资源能力", async () => {
  const { server } = await makeServer();
  const result = await rpc(server, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  assert.equal(result.protocolVersion, "2025-06-18");
  assert.equal(result.serverInfo.name, "reqora");
  assert.equal(result.capabilities.tools.listChanged, false);
  assert.ok(result.instructions.includes("reqora_workspace_overview"));

  const unknown = await rpc(server, "initialize", { protocolVersion: "1999-01-01" });
  assert.equal(unknown.protocolVersion, "2025-06-18");

  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("未开启写入时只暴露只读工具，且写工具被拒绝", async () => {
  const { server } = await makeServer({ allowWrite: false });
  const { tools } = await rpc(server, "tools/list", {});
  assert.ok(tools.length >= 14);
  assert.ok(tools.every((tool) => !tool.name.includes("create") && !tool.name.includes("delete")));
  assert.ok(tools.every((tool) => tool.annotations.readOnlyHint === true));
  assert.ok(tools.some((tool) => tool.name === "reqora_run_scenario"));

  const denied = await call(server, "reqora_create_request", { name: "x", url: "https://x.test" });
  assert.equal(denied.isError, true);
  assert.match(denied.error, /--allow-write/);

  const withWrite = await makeServer({ allowWrite: true });
  const list = await rpc(withWrite.server, "tools/list", {});
  assert.ok(list.tools.some((tool) => tool.name === "reqora_create_request"));
  assert.ok(list.tools.length > tools.length);
});

test("项目概览与接口检索反映真实数据", async () => {
  const { server } = await makeServer({ baseUrl: "https://api.test" });
  const overview = await call(server, "reqora_workspace_overview", {});
  assert.equal(overview.counts.requests, 1);
  assert.equal(overview.counts.cases, 1);
  assert.equal(overview.counts.scenarios, 1);
  assert.equal(overview.writeEnabled, false);
  assert.equal(overview.activeEnvironment, "测试环境");

  const listed = await call(server, "reqora_list_requests", { query: "取用户" });
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].collectionName, "示例集合");
  assert.equal(listed.items[0].cases, 1);

  const detail = await call(server, "reqora_get_request", { ref: "取用户" });
  assert.equal(detail.request.url, "https://api.test/users/:id");
  // Sensitive header values stay masked unless explicitly revealed.
  const auth = detail.request.headers.find((row) => row.key === "Authorization");
  assert.match(auth.value, /\*\*\*/);
  assert.equal(detail.doc.summary, "按 id 取用户");

  const revealed = await call(server, "reqora_get_request", { ref: "req-1", revealSecrets: true });
  assert.equal(
    revealed.request.headers.find((row) => row.key === "Authorization").value,
    "Bearer super-secret-token",
  );

  const missing = await call(server, "reqora_get_request", { ref: "不存在的接口" });
  assert.equal(missing.isError, true);
});

test("场景与套件列表带出编排细节", async () => {
  const { server } = await makeServer();
  const scenarios = await call(server, "reqora_list_scenarios", {});
  assert.equal(scenarios.total, 1);
  assert.deepEqual(
    scenarios.items[0].stepOverview.map((step) => step.kind),
    ["case", "wait"],
  );
  const detail = await call(server, "reqora_get_scenario", { ref: "回显链路" });
  assert.equal(detail.steps[0].source.caseName, "正向 · 存在用户");
  assert.equal(detail.steps[0].extracts[0].varName, "uid");

  const suites = await call(server, "reqora_list_suites", {});
  assert.equal(suites.total, 0);
});

test("资源列表与读取覆盖接口、用例、场景", async () => {
  const { server } = await makeServer();
  const { resources } = await rpc(server, "resources/list", {});
  assert.ok(resources.some((item) => item.uri === "reqora://request/req-1"));
  assert.ok(resources.some((item) => item.uri === "reqora://case/case-1"));
  assert.ok(resources.some((item) => item.uri === "reqora://scenario/scn-1"));

  const read = await rpc(server, "resources/read", { uri: "reqora://request/req-1" });
  const payload = JSON.parse(read.contents[0].text);
  assert.equal(payload.request.name, "取用户");
});

test("send_request 走真实 HTTP 链路并评估断言", async () => {
  const httpServer = createServer((request, response) => {
    if (request.url === "/hello") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, path: request.url }));
      return;
    }
    response.writeHead(500, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const { server } = await makeServer({ baseUrl });
    const result = await call(server, "reqora_send_request", {
      method: "GET",
      url: `${baseUrl}/hello`,
      assertions: [
        { source: "status", op: "eq", expected: "200" },
        { source: "json", path: "$.ok", op: "eq", expected: "true" },
      ],
    });
    assert.equal(result.isError, undefined, result.error);
    assert.equal(result.status, 200);
    assert.equal(result.ok, true);
    assert.equal(result.assertions.length, 2);
    assert.ok(result.assertions.every((item) => item.ok));

    const failing = await call(server, "reqora_send_request", {
      method: "GET",
      url: `${baseUrl}/missing`,
      assertions: [{ source: "status", op: "eq", expected: "200" }],
    });
    assert.equal(failing.ok, false);
    assert.equal(failing.assertions[0].ok, false);
  } finally {
    httpServer.close();
  }
});

test("运行用例与场景编排返回逐步报告", async () => {
  const httpServer = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: 7, url: request.url }));
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const { server } = await makeServer({ baseUrl });
    const cases = await call(server, "reqora_run_cases", { requestRef: "取用户" });
    assert.equal(cases.summary.total, 1);
    assert.equal(cases.summary.passed, 1);
    assert.equal(cases.results[0].status, 200);
    assert.equal(cases.environment, "测试环境");

    const scenario = await call(server, "reqora_run_scenario", { ref: "回显链路" });
    assert.equal(scenario.summary.failed, 0);
    assert.equal(scenario.steps.length, 2);
    assert.equal(scenario.steps[0].extracted.uid, "7");
    assert.match(scenario.steps[0].body, /"id":7/u, "场景步骤应带出响应体，MCP 客户端才看得到返回内容");
    assert.equal(scenario.steps[0].bodyTruncated, false);
    assert.equal(scenario.steps[1].note, "等待 0ms");
    assert.equal(scenario.steps[1].body, undefined, "wait 步骤没有响应体");
  } finally {
    httpServer.close();
  }
});

test("开启写入后可新建接口、用例与场景并读回", async () => {
  const { server, store } = await makeServer({ allowWrite: true, baseUrl: "https://api.test" });

  const created = await call(server, "reqora_create_request", {
    name: "新建订单",
    method: "POST",
    url: "{{baseUrl}}/orders",
    json: { sku: "A-1" },
    docSummary: "创建订单",
    assertions: [{ source: "status", op: "eq", expected: "201" }],
  });
  assert.equal(created.created, true);
  assert.equal(created.collection.name, "示例集合");

  const caseCreated = await call(server, "reqora_create_case", {
    requestRef: "新建订单",
    name: "正向 · 创建成功",
    group: "正向",
    expectedStatus: 201,
  });
  assert.equal(caseCreated.created, true);

  const scenarioCreated = await call(server, "reqora_create_scenario", {
    name: "下单链路",
    steps: [
      { caseRef: "正向 · 创建成功", extracts: [{ varName: "orderId", source: "json", path: "$.id" }] },
      { waitMs: 0 },
    ],
  });
  assert.equal(scenarioCreated.created, true);
  assert.equal(scenarioCreated.scenario.steps, 2);

  const snapshot = await store.readSnapshot();
  const request = snapshot.collections[0].items.find((item) => item.name === "新建订单");
  assert.ok(request, "接口没有落库");
  assert.equal(request.assertions[0].value, "201");
  const createdCase = snapshot.cases.find((item) => item.name === "正向 · 创建成功");
  assert.equal(createdCase.expectedStatus, 201);
  assert.equal(
    Object.hasOwn(createdCase.request, "__collection"),
    false,
    "MCP 查找接口时注入的 __collection 运行时缓存不能写进用例行",
  );
  const scenario = snapshot.scenarios.find((item) => item.name === "下单链路");
  assert.equal(scenario.steps[0].source.caseId, snapshot.cases.find((item) => item.name === "正向 · 创建成功").id);

  const updated = await call(server, "reqora_update_request", {
    ref: "新建订单",
    patch: { method: "PATCH", json: { sku: "B-2" } },
    docSummary: "更新后的摘要",
  });
  assert.equal(updated.updated, true);
  const after = await store.readSnapshot();
  const patched = after.collections[0].items.find((item) => item.id === request.id);
  assert.equal(patched.method, "PATCH");
  assert.equal(patched.doc.summary, "更新后的摘要");

  const deleted = await call(server, "reqora_delete_request", { ref: "新建订单" });
  assert.equal(deleted.deleted, true);
  const finalSnapshot = await store.readSnapshot();
  assert.equal(finalSnapshot.collections[0].items.some((item) => item.id === request.id), false);
  assert.ok((finalSnapshot.tombstones ?? []).some((item) => item.id === request.id));
  store.close();
});

test("未知工具与非法参数返回可读错误", async () => {
  const { server } = await makeServer();
  const unknown = await call(server, "reqora_nope", {});
  assert.equal(unknown.isError, true);
  assert.match(unknown.error, /未知工具/);

  const missingRef = await call(server, "reqora_get_request", {});
  assert.equal(missingRef.isError, true);

  // Substring matching is intentional: a unique partial name resolves.
  const partial = await call(server, "reqora_get_case", { ref: "正向" });
  assert.equal(partial.name, "正向 · 存在用户");

  const badResource = await server.handle({
    jsonrpc: "2.0",
    id: 9,
    method: "resources/read",
    params: { uri: "file:///etc/passwd" },
  });
  assert.match(badResource.error?.message ?? "", /不支持的资源地址/u);
});

// ------------------------------------------------- redaction regressions ----

test("--reveal-secrets 是服务端全局开关（工具与资源都遵循）", async () => {
  const dir = await makeProject();
  const store = new WorkspaceStore(
    { kind: "sqlite", dir, projectId: "test", projectName: "测试项目" },
    { allowWrite: false },
  );
  const masked = createMcpServer({ store, allowWrite: false });
  const revealed = createMcpServer({ store, allowWrite: false, defaults: { revealSecrets: true } });

  const authValue = async (server) =>
    (await call(server, "reqora_get_request", { ref: "req-1" }))
      .request.headers.find((row) => row.key === "Authorization").value;
  assert.match(await authValue(masked), /\*\*\*/u);
  assert.equal(await authValue(revealed), "Bearer super-secret-token");

  const maskedResource = await rpc(masked, "resources/read", { uri: "reqora://request/req-1" });
  const revealedResource = await rpc(revealed, "resources/read", { uri: "reqora://request/req-1" });
  assert.match(maskedResource.contents[0].text, /\*\*\*/u);
  assert.match(revealedResource.contents[0].text, /Bearer super-secret-token/u);
  store.close();
});

test("自定义敏感 Header 与 URL query 中的凭据同样打码", async () => {
  const rows = defaultRows();
  const request = rows.find((row) => row.id === "req-1");
  request.url = "https://api.test/users/:id?access_token=demo-query-token";
  request.data.headers.push({
    id: "h3",
    key: "X-Session-Token",
    value: "demo-custom-header-token",
    enabled: true,
  });
  const dir = await makeProject(rows);
  const store = new WorkspaceStore({ kind: "sqlite", dir, projectId: "test" }, { allowWrite: false });
  const server = createMcpServer({ store, allowWrite: false });

  const detail = JSON.stringify(await call(server, "reqora_get_request", { ref: "req-1" }));
  assert.ok(!detail.includes("demo-query-token"), "URL query 凭据泄露");
  assert.ok(!detail.includes("demo-custom-header-token"), "自定义敏感 Header 泄露");
  assert.match(detail, /\*\*\*/u);

  const revealed = JSON.stringify(
    await call(server, "reqora_get_request", { ref: "req-1", revealSecrets: true }),
  );
  assert.match(revealed, /demo-custom-header-token/u);
  store.close();
});

test("resources/read 的场景资源不泄露内联鉴权、变量与运行结果", async () => {
  const rows = defaultRows();
  const scenario = rows.find((row) => row.kind === "scenario");
  scenario.data = {
    ...scenario.data,
    steps: [
      {
        id: "st-secret",
        name: "内联请求",
        enabled: true,
        source: {
          kind: "request",
          request: {
            id: "inline-1",
            name: "内联请求",
            method: "POST",
            url: "https://api.test/login?token=demo-url-token",
            auth: { type: "bearer", token: "demo-auth-token" },
            headers: [
              { key: "X-Session-Token", value: "demo-inline-header-token", enabled: true },
            ],
          },
        },
      },
    ],
    variables: { apiKey: "demo-scenario-key" },
    lastRun: { variables: { sessionToken: "demo-last-run-key" } },
  };
  const dir = await makeProject(rows);
  const store = new WorkspaceStore({ kind: "sqlite", dir, projectId: "test" }, { allowWrite: false });
  const server = createMcpServer({ store, allowWrite: false });

  const result = await rpc(server, "resources/read", { uri: "reqora://scenario/scn-1" });
  const text = result.contents[0].text;
  for (const secret of [
    "demo-url-token",
    "demo-auth-token",
    "demo-inline-header-token",
    "demo-scenario-key",
    "demo-last-run-key",
  ]) {
    assert.ok(!text.includes(secret), `场景资源泄露了 ${secret}`);
  }
  store.close();
});

test("工具目录与共享口径一致", async () => {
  const { server, store } = await makeServer({ allowWrite: true });
  const { tools } = await rpc(server, "tools/list", {});
  assert.equal(tools.length, MCP_TOOL_SUMMARY.total);
  assert.equal(tools.filter((tool) => tool.annotations.readOnlyHint).length, MCP_TOOL_SUMMARY.readOnly);
  assert.equal(tools.filter((tool) => !tool.annotations.readOnlyHint).length, MCP_TOOL_SUMMARY.write);
  for (const name of MCP_WRITE_TOOL_NAMES) {
    assert.ok(tools.some((tool) => tool.name === name), `缺少写工具 ${name}`);
  }
  store.close();
});

// -------------------------------- 私密变量（值仅本机） regressions ----

test("私密变量：MCP 工具与资源都不放行，即使全局 --reveal-secrets", async () => {
  const rows = defaultRows();
  const environment = rows.find((item) => item.id === "env-1");
  environment.data.variables.push(
    { id: "v-account", key: "account", value: "demo-private-account", enabled: true, secret: true },
    { id: "v-password", key: "password", value: "demo-private-password", enabled: true, secret: true },
    { id: "v-public", key: "publicNote", value: "demo-public-note", enabled: true },
  );
  const dir = await makeProject(rows);
  const store = new WorkspaceStore(
    { kind: "sqlite", dir, projectId: "test" },
    { allowWrite: false },
  );
  // 全局明文开关：普通变量照常放行，私密变量必须挡住。
  const server = createMcpServer({
    store,
    allowWrite: false,
    defaults: { revealSecrets: true },
  });

  const list = await call(server, "reqora_list_environments", {});
  const variables = list.items[0].variables;
  assert.equal(
    variables.find((item) => item.key === "publicNote").value,
    "demo-public-note",
    "revealSecrets 对普通变量仍然生效",
  );
  for (const key of ["account", "password"]) {
    const row = variables.find((item) => item.key === key);
    assert.equal(row.private, true, "私密标记随变量名返回，客户端能识别");
    assert.match(row.value, /\*\*\*/u);
  }
  const listed = JSON.stringify(list);
  assert.ok(!listed.includes("demo-private-account"));
  assert.ok(!listed.includes("demo-private-password"));

  // 调用级 revealSecrets 也不能绕过用户显式勾选的私密标记。
  const revealed = JSON.stringify(
    await call(server, "reqora_list_environments", { revealSecrets: true }),
  );
  assert.ok(!revealed.includes("demo-private-account"));
  assert.ok(!revealed.includes("demo-private-password"));

  const resource = JSON.stringify(
    await rpc(server, "resources/read", { uri: "reqora://request/req-1" }),
  );
  assert.ok(!resource.includes("demo-private-password"));
  store.close();
});
