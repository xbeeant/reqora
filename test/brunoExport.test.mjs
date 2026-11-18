/**
 * T2.2 · Bruno .bru 清单 与 OpenCollection 单文件导出。
 *
 * 覆盖：block 齐全 / 文件夹树 / 脚本方言与降级警告 / 脱敏 / 确定性。
 * Bruno 是多文件目录格式，但渲染器只能返回 string：这里断言渲染器返回的是
 * 确定的 JSON 文件清单（schema: reqora.bruno.v1 + files{相对路径:内容} +
 * warnings[]），而不是单文件 .bru；由 export --all 落盘时展开成真实目录。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { renderExport } from "../src/lib/exportFormats.ts";

const SECRET = "sk-live-canaryA1b2c3d4e5f6g7h8";

const row = (id, key, value, extra = {}) => ({ id, key, value, enabled: true, ...extra });

function req(id, name, overrides = {}) {
  return {
    id, name, method: "GET", url: "{{baseUrl}}/v1/users", folder: "用户/详情",
    headers: [
      row(`${id}-h1`, "Accept", "application/json"),
      row(`${id}-h2`, "Authorization", `Bearer ${SECRET}`, { secret: true }),
    ],
    query: [row(`${id}-q1`, "page", "1")],
    body: { type: "json", content: '{"name":"A","password":"{{password}}"}' },
    auth: { type: "bearer", token: SECRET },
    // 同时混入 Postman / Bruno 两套方言，必须出现在降级报告里而不是被静默丢弃。
    preScript: "pm.environment.set('k', '{{token}}');\nbru.setVar('page', '1');",
    postScript: "pm.test('ok', function () { bru.setVar('done', '1'); });",
    assertions: [
      { id: `${id}-a1`, enabled: true, name: "状态", source: "status", path: "", op: "eq", value: "200" },
      { id: `${id}-a2`, enabled: true, name: "正则", source: "json", path: "$.id", op: "matches", value: "^[0-9]+$" },
      { id: `${id}-a3`, enabled: true, name: "存在", source: "json", path: "$.ok", op: "exists", value: "" },
      { id: `${id}-a4`, enabled: true, name: "耗时", source: "latency", path: "", op: "lt", value: "500" },
      { id: `${id}-a5`, enabled: true, name: "全文", source: "text", path: "", op: "contains", value: "ok" },
    ],
    doc: { summary: "", description: "", owner: "", status: "", tags: [], paramMeta: {}, responses: [], updatedAt: 1 },
    ...overrides,
  };
}

function fixture() {
  return {
    version: 1, seeded: false,
    collections: [{
      id: "col1", name: "订单服务", folders: ["用户/archive"],
      items: [
        req("r1", "创建订单", { method: "POST" }),
        req("r2", "查询订单", { method: "GET", folder: "用户" }),
        req("r3", "局部更新", { method: "PUT" }),
        req("r4", "删除订单", { method: "DELETE" }),
        req("r5", "再次下单", { method: "PATCH" }),
        req("r6", "GraphQL", { body: { type: "graphql", content: "query { user { id } }" } }),
        req("r7", "gRPC 调用", { protocol: "grpc" }),
        req("r8", "MQTT", { protocol: "mqtt", mqtt: { topic: "t" } }),
        req("r9", "SOAP", { protocol: "soap", soap: { action: "A" } }),
      ],
    }],
    environments: [{
      id: "env1", name: "本地",
      variables: [
        row("v1", "baseUrl", "https://api.example.com"),
        row("v2", "token", SECRET, { secret: true }),
        row("v3", "apiKey", SECRET, { secret: true }),
      ],
    }],
    activeEnvironmentId: "env1",
    scriptLibrary: [{ id: "sl1", name: "公共片段", code: "pm.environment.set('t', '{{token}}');" }],
    settings: { timeoutSecs: 30, followRedirects: true, verifyTls: true },
  };
}

function bruno() {
  return JSON.parse(renderExport(fixture(), "bruno-collection"));
}

test("Bruno 渲染结果是确定的 JSON 文件清单，不是单文件 .bru", () => {
  const manifest = bruno();
  assert.equal(manifest.schema, "reqora.bruno.v1");
  assert.ok(manifest.files && typeof manifest.files === "object", "应有 files 映射");
  assert.ok(Array.isArray(manifest.warnings), "应有 warnings[]");
  const keys = Object.keys(manifest.files);
  assert.ok(keys.includes("bruno.json"), "应有集合根文件 bruno.json");
  assert.equal(JSON.parse(manifest.files["bruno.json"]).type, "collection");
  assert.ok(keys.includes("WARNINGS.md"), "降级报告应落成 WARNINGS.md");
  assert.ok(keys.filter((k) => k.endsWith(".bru") && !k.endsWith("folder.bru")).length >= 9,
    "每个请求一个 .bru 文件");
  assert.ok(keys.filter((k) => k.endsWith("folder.bru")).length >= 2, "文件夹树应生成 folder.bru");
  // WARNINGS.md 与 warnings[] 内容一致，不是两份互不相干的报告。
  for (const line of manifest.warnings) {
    assert.ok(manifest.files["WARNINGS.md"].includes(line), `WARNINGS.md 缺少警告：${line.slice(0, 20)}…`);
  }
  assert.ok(manifest.files["WARNINGS.md"].startsWith("# Reqora → Bruno 降级报告"));
});

test(".bru block 齐全：meta / 方法 / headers / body / vars / assert / script / tests", () => {
  const manifest = bruno();
  const bruFiles = Object.keys(manifest.files)
    .filter((k) => k.endsWith(".bru") && !k.endsWith("folder.bru"))
    .map((k) => manifest.files[k]);
  assert.ok(bruFiles.length >= 9);

  // 每个请求都带齐 8 类 block。
  for (const text of bruFiles) {
    for (const block of [
      "meta {", "headers {", "body:json {", "vars:pre-request {",
      "assert {", "script:pre-request {", "tests {",
    ]) {
      assert.ok(text.includes(block), `缺少 block ${block}`);
    }
    assert.match(text, /\b(?:get|post|put|patch|delete) \{/, "缺少 HTTP 方法块");
  }
  // 5 种方言方法块都被映射（不是所有请求都写成同一个动词）。
  const joined = bruFiles.join("\n");
  for (const method of ["get {", "post {", "put {", "patch {", "delete {"]) {
    assert.ok(joined.includes(method), `缺少方法块 ${method}`);
  }
  // 断言 / 脚本 / 变量的具体映射。
  assert.ok(joined.includes("res.status: eq 200"), "status 断言应映射到 res.status");
  assert.ok(joined.includes("matches") && joined.includes("exists"), "Reqora 特有运算符原文保留供人工改写");
  assert.ok(joined.includes("pm.environment.set") && joined.includes("bru.setVar"), "脚本原文保留");
  assert.ok(joined.includes("pm.test("), "后置脚本应落进 tests 块");
});

test("文件夹树：请求落在 folder 层级，folder.bru 覆盖每个目录", () => {
  const manifest = bruno();
  const keys = Object.keys(manifest.files);
  // 单集合时前缀为空，folder 直接成为相对路径段。
  assert.ok(keys.includes("用户/详情/创建订单.bru"), "多层 folder 应展开成目录");
  assert.ok(keys.includes("用户/查询订单.bru"), "单层 folder 应展开成目录");
  assert.ok(keys.includes("用户/folder.bru"), "父目录应有 folder.bru");
  assert.ok(keys.includes("用户/详情/folder.bru"), "子目录应有 folder.bru");
  assert.ok(keys.includes("用户/archive/folder.bru"), "空文件夹也应生成 folder.bru");
  const folder = manifest.files["用户/详情/folder.bru"];
  assert.ok(folder.includes("meta {") && folder.includes("type: folder"));
  assert.ok(folder.includes("name: 详情"));
  // 目录穿越防护：路径里不允许出现 .. 或绝对路径段。
  for (const key of keys) {
    assert.ok(!key.startsWith("/"), `路径不应为绝对路径：${key}`);
    assert.ok(!key.split("/").includes(".."), `路径不应含 ..：${key}`);
  }
});

test("降级报告显式列出脚本方言、Reqora 特有断言、非 HTTP 协议与未带走资产", () => {
  const manifest = bruno();
  const joined = manifest.warnings.join("\n");
  // 脚本方言：pm.* / bru.* 互不兼容，必须点名。
  assert.ok(joined.includes("pm.environment") || joined.includes("pm.test"), "应点名 Postman 方言 pm.*");
  assert.ok(joined.includes("bru.setVar"), "应点名 Bruno 方言 bru.*");
  assert.ok(joined.includes("Bruno / OpenCollection 无 pm.* 运行时"), "应说明 pm.* 在目标格式不可执行");
  // Reqora 特有断言运算符与来源。
  assert.ok(joined.includes("exists, matches"), "应点名 Reqora 特有断言运算符");
  assert.ok(joined.includes("latency, text"), "应点名无法表达的断言来源");
  // 非 HTTP 协议能力。
  assert.ok(joined.includes("非 HTTP 协议能力未带走"), "应有非 HTTP 协议降级段落");
  assert.ok(joined.includes("grpc") && joined.includes("mqtt") && joined.includes("soap"),
    "应点名 gRPC / MQTT / SOAP");
  assert.ok(joined.includes("GraphQL"), "应点名 GraphQL 降级为普通 body");
  // 集合级鉴权 / 全局 Header / 运行历史等未带走资产。
  assert.ok(joined.includes("集合级继承鉴权、环境级全局 Header"), "应列出未带走的集合级资产");

  // OpenCollection 是单文件 YAML，但降级报告同样以 warnings[] 显式列出。
  const oc = renderExport(fixture(), "opencollection-v1");
  assert.match(oc, /^opencollection: "1\.0\.0"/m);
  assert.ok(oc.includes("warnings:"), "OpenCollection 应带 warnings[]");
  assert.ok(oc.includes('code: "DEGRADE-1"'), "应有 DEGRADE-N 编号");
  assert.ok(oc.includes("pm.environment"), "OpenCollection 也应点名 pm.* 方言");
  assert.ok(oc.includes("非 HTTP 协议能力未带走"), "OpenCollection 也应带非 HTTP 协议降级");
});

test("脱敏：不含明文私密值，凭据一律占位符，{{token}} 不被二次破坏", () => {
  const brunoText = renderExport(fixture(), "bruno-collection");
  const oc = renderExport(fixture(), "opencollection-v1");
  for (const [label, text] of [["Bruno", brunoText], ["OpenCollection", oc]]) {
    assert.ok(!text.includes(SECRET), `${label} 泄漏明文私密值`);
    assert.ok(!text.includes(`Bearer ${SECRET}`), `${label} 泄漏 Bearer 凭据`);
    assert.ok(text.includes("{{token}}"), `${label} 的 {{token}} 占位符被破坏`);
    assert.ok(text.includes("{{password}}"), `${label} 的 {{password}} 占位符被破坏`);
    assert.ok(text.includes("{{apiKey}}"), `${label} 的 {{apiKey}} 占位符被破坏`);
  }
  // 敏感 Header 外发成占位符而不是原值。
  assert.ok(brunoText.includes("Authorization: {{Authorization}}"), "敏感 Header 应占位符化");
  const manifest = bruno();
  assert.ok(manifest.files["用户/详情/创建订单.bru"].includes("Authorization: {{Authorization}}"),
    "展开后的 .bru 内容也应占位符化");
  // OpenCollection：私密变量只带名字与 secret 标记，值仍是占位符。
  assert.ok(oc.includes('key: "token"') && oc.includes("secret: true"));
  assert.ok(oc.includes('value: "{{token}}"'), "私密变量值必须是占位符");
  assert.ok(!oc.includes(SECRET), "OpenCollection 不应带出私密变量值");
  // 结构化凭据字段（bearer token）不进入 .bru：方法块里的 auth 只能是 none。
  const firstBru = Object.values(manifest.files)
    .find((value) => typeof value === "string" && value.includes("post {"));
  assert.ok(firstBru, "应存在 POST 请求文件");
  assert.ok(firstBru.includes("auth: none"), "Bearer token 不应进入 .bru 的 auth 块");
  assert.ok(!firstBru.includes(SECRET), ".bru 内不应出现明文 token");
});

test("确定性：两次导出字节一致，且不改动原始快照", () => {
  const snap = fixture();
  const before = JSON.stringify(snap);
  const a = renderExport(snap, "bruno-collection");
  const b = renderExport(snap, "bruno-collection");
  assert.equal(a, b, "Bruno 清单两次导出应字节一致");
  const ocA = renderExport(snap, "opencollection-v1");
  const ocB = renderExport(snap, "opencollection-v1");
  assert.equal(ocA, ocB, "OpenCollection 两次导出应字节一致");
  assert.equal(JSON.stringify(snap), before, "导出不得修改工作区快照");
  // 两次 JSON 清单的 files 顺序也稳定（写盘顺序可复现）。
  assert.deepEqual(Object.keys(JSON.parse(a).files), Object.keys(JSON.parse(b).files));
});
