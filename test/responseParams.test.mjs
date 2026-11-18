/**
 * 响应参数定义（每个响应示例一份字段表）的纯逻辑回归：
 * 派生 / 合并 / 归一化 / OpenAPI 往返 / 文档站 / 单文件 HTML / Markdown / 自动校验。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { emptyDoc, emptyResponseExample, emptySnapshot, normalizeRequest } from "../src/lib/defaults.ts";
import {
  deriveResponseParams,
  matchesResponseType,
  mergeResponseParams,
  normalizeResponseParams,
  responseParamTables,
  responseParamsToHeaders,
  responseParamsToSchema,
  resolveResponsePath,
  schemaToResponseParams,
} from "../src/lib/responseParams.ts";
import { buildDocSitePayload, normalizeDocSitePayload } from "../src/lib/docSitePayload.ts";
import { exportDocSiteHtml } from "../src/lib/docsite.ts";
import { exportMarkdown, exportOpenApi, importOpenApi } from "../src/lib/transfer.ts";
import { validateResponse } from "../src/lib/validate.ts";

const BODY = JSON.stringify({
  code: 0,
  message: "ok",
  data: {
    id: 42,
    name: "Amy",
    vip: true,
    tags: ["a", "b"],
    orders: [{ id: "A1", total: 12.5 }],
    token: "sk-secret-123",
  },
});

const rows = [
  { id: "p1", name: "code", location: "body", type: "integer", required: true, example: "0", description: "业务码" },
  { id: "p2", name: "data.list[0].id", location: "body", type: "string", required: false, example: "A1", description: "订单号" },
  { id: "p3", name: "X-Total-Count", location: "header", type: "integer", required: true, example: "10", description: "总数" },
  { id: "p4", name: "Authorization", location: "header", type: "string", required: false, example: "Bearer abc", description: "凭据" },
];

function docWith(params, overrides = {}) {
  return {
    ...emptyDoc(),
    responses: [
      {
        ...emptyResponseExample(),
        id: "e1",
        name: "成功",
        status: 200,
        contentType: "application/json",
        body: '{"code":0,"legacy":true}',
        description: "请求成功",
        params,
        ...overrides,
      },
    ],
  };
}

function snapshotWith(doc) {
  const snapshot = emptySnapshot();
  snapshot.collections = [
    {
      id: "c1",
      name: "示例集合",
      items: [
        normalizeRequest({
          id: "r1",
          name: "用户详情",
          method: "GET",
          url: "https://api.example.com/users/1",
          doc,
        }),
      ],
    },
  ];
  return snapshot;
}

test("deriveResponseParams：嵌套对象、数组、类型推断与凭据脱敏", () => {
  const derived = deriveResponseParams(BODY, "application/json");
  const byName = new Map(derived.map((row) => [row.name, row]));
  assert.equal(byName.get("code").type, "integer");
  assert.equal(byName.get("code").example, "0");
  assert.equal(byName.get("message").type, "string");
  assert.equal(byName.get("data.vip").type, "boolean");
  assert.equal(byName.get("data.orders[0].total").type, "number");
  assert.equal(byName.get("data.tags").type, "array<string>");
  assert.equal(byName.get("data.orders[0].id").example, "A1");
  assert.equal(byName.get("data.token").example, "", "凭据类字段不复制示例值");
  assert.ok(derived.every((row) => row.location === "body" && row.required === false));
});

test("deriveResponseParams：非法 JSON / 非 JSON 内容返回空数组", () => {
  assert.deepEqual(deriveResponseParams("not json", "application/json"), []);
  assert.deepEqual(deriveResponseParams("<html/>", "text/html"), []);
  assert.deepEqual(deriveResponseParams("", "application/json"), []);
});

test("normalizeResponseParams：旧快照与异常数据有界归一化", () => {
  assert.deepEqual(normalizeResponseParams(undefined), []);
  const out = normalizeResponseParams([
    { name: "a" },
    { id: "x", name: "Authorization", location: "header", type: 7, required: "yes", example: "t", description: 5 },
    null,
    "bad",
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].location, "body");
  assert.equal(out[0].type, "string");
  assert.ok(out[0].id.length > 0);
  assert.equal(out[1].location, "header");
  assert.equal(out[1].required, false);
  assert.equal(out[1].description, "");
});

test("mergeResponseParams：保留用户说明，追加新字段，保留手工响应头", () => {
  const existing = [
    { ...rows[0], description: "用户手写的业务码说明" },
    { id: "manual", name: "X-Trace-Id", location: "header", type: "string", required: false, example: "", description: "链路 ID" },
  ];
  const derived = [
    { ...rows[0], description: "" },
    { ...rows[1], description: "" },
  ];
  const merged = mergeResponseParams(existing, derived);
  assert.equal(merged[0].description, "用户手写的业务码说明");
  assert.equal(merged[1].name, "data.list[0].id");
  assert.ok(merged.some((row) => row.name === "X-Trace-Id"));
  assert.equal(merged.length, 3);
});

test("responseParamsToSchema / Headers：嵌套数组、required 与敏感响应头", () => {
  const schema = responseParamsToSchema(rows);
  assert.equal(schema.type, "object");
  assert.equal(schema.properties.code.type, "integer");
  assert.deepEqual(schema.required, ["code"]);
  assert.equal(schema.properties.data.properties.list.type, "array");
  assert.equal(schema.properties.data.properties.list.items.properties.id.type, "string");
  const headers = responseParamsToHeaders(rows);
  assert.equal(headers["X-Total-Count"].schema.type, "integer");
  assert.equal(headers["X-Total-Count"].required, true);
  assert.equal(headers["X-Total-Count"].example, 10);
  assert.equal(headers.Authorization.example, undefined, "凭据响应头不导出示例值");
  assert.equal(responseParamsToSchema([]), null);
});

test("schemaToResponseParams：OpenAPI schema / headers 还原成可编辑字段表", () => {
  const schema = responseParamsToSchema(rows);
  const headers = responseParamsToHeaders(rows);
  const restored = schemaToResponseParams(schema, headers);
  const names = restored.map((row) => row.name);
  assert.ok(names.includes("code"));
  assert.ok(names.includes("data.list[0].id"));
  assert.ok(names.includes("X-Total-Count"));
  assert.ok(names.includes("Authorization"));
  assert.equal(restored.find((row) => row.name === "code").required, true);
  assert.equal(restored.find((row) => row.name === "Authorization").example, "");
  assert.ok(restored.every((row) => typeof row.id === "string" && row.id.length > 0));
});

test("resolveResponsePath / matchesResponseType：JSON 路径与宽松类型匹配", () => {
  const value = { data: { list: [{ id: "A1" }] }, ok: true };
  assert.deepEqual(resolveResponsePath(value, "data.list[0].id"), { found: true, value: "A1" });
  assert.equal(resolveResponsePath(value, "data.list[0].missing").found, false);
  assert.equal(matchesResponseType(3, "integer"), true);
  assert.equal(matchesResponseType(3.5, "integer"), true, "number 与 integer 互相兼容");
  assert.equal(matchesResponseType("3", "integer"), false);
  assert.equal(matchesResponseType(["a"], "array<string>"), true);
  assert.equal(matchesResponseType(null, "integer"), true, "null 视为任意类型");
  assert.equal(matchesResponseType({ a: 1 }, "any"), true);
});

test("normalizeRequest：旧快照的响应示例自动补 params 空数组", () => {
  const legacy = normalizeRequest({
    id: "r1",
    name: "旧接口",
    doc: {
      ...emptyDoc(),
      responses: [{ id: "e1", name: "成功", status: 200, contentType: "application/json", body: "{}", description: "" }],
    },
  });
  assert.deepEqual(legacy.doc.responses[0].params, []);
  const broken = normalizeRequest({ id: "r2", doc: { ...emptyDoc(), responses: [null, "bad"] } });
  assert.equal(broken.doc.responses.length, 0);
});

test("buildDocSitePayload / normalizeDocSitePayload：响应参数表进入公开 payload", () => {
  const payload = buildDocSitePayload(snapshotWith(docWith(rows)));
  const response = payload.collections[0].requests[0].responses[0];
  assert.equal(response.tables.length, 2);
  assert.equal(response.tables[0].label, "响应参数（Body）");
  assert.equal(response.tables[1].label, "响应参数（Header）");
  assert.equal(response.tables[1].rows.find((row) => row.name === "Authorization").example, "<请自行填写>");
  const roundTrip = normalizeDocSitePayload(JSON.parse(JSON.stringify(payload)));
  assert.equal(roundTrip.collections[0].requests[0].responses[0].tables.length, 2);
  const legacy = normalizeDocSitePayload({
    collections: [{ requests: [{ responses: [{ status: 200 }] }] }],
  });
  assert.deepEqual(legacy.collections[0].requests[0].responses[0].tables, []);
});

test("单文件 HTML 文档站导出包含响应参数表（按对象层级展开）", () => {
  const html = exportDocSiteHtml(snapshotWith(docWith(rows)), "接口文档");
  assert.ok(html.includes("响应参数（Body）"));
  // 点路径不再平铺：data → list → id 逐级缩进，父级标注 object / array<object>。
  assert.ok(html.includes(">data<"));
  assert.ok(html.includes(">list<"));
  assert.ok(html.includes(">id<"));
  assert.ok(html.includes("array&lt;object&gt;"));
  assert.ok(html.includes("padding-left:28px"), "id 是第三层，缩进 2 级");
  assert.ok(!html.includes("data.list[0].id"), "导出页不再输出扁平点路径");
  assert.ok(html.includes("响应参数（Header）"));
  assert.ok(!html.includes("Bearer abc"), "凭据响应头示例值不进入公开 HTML");
});

test("OpenAPI 导出 / 导入：响应字段定义往返不丢失", () => {
  const snapshot = snapshotWith(docWith(rows));
  const exported = JSON.parse(exportOpenApi(snapshot));
  const pathKey = Object.keys(exported.paths)[0];
  const entry = exported.paths[pathKey].get.responses["200"];
  assert.equal(entry.content["application/json"].schema.properties.code.type, "integer");
  assert.equal(entry.headers["X-Total-Count"].schema.type, "integer");
  const imported = importOpenApi(JSON.stringify(exported));
  const params = imported.collections[0].items[0].doc.responses[0].params;
  assert.ok(params.some((row) => row.name === "code" && row.type === "integer"));
  assert.ok(params.some((row) => row.name === "X-Total-Count" && row.location === "header"));
});

test("Markdown 导出包含每个响应示例的字段表", () => {
  const md = exportMarkdown(snapshotWith(docWith(rows)));
  assert.ok(md.includes("**响应参数（Body）**"));
  assert.ok(md.includes("| code | integer | 是 | 业务码 | 0 |"));
  assert.ok(md.includes("**响应参数（Header）**"));
  assert.ok(!md.includes("Bearer abc"));
});

test("validateResponse：有响应参数定义时按字段表比对且检查必填响应头", () => {
  const draft = normalizeRequest({
    id: "r1",
    name: "用户详情",
    method: "GET",
    url: "/users/1",
    doc: docWith(rows),
  });
  const response = {
    requestId: "x",
    status: 200,
    statusText: "OK",
    ok: true,
    timeMs: 10,
    size: 10,
    url: "/users/1",
    resolvedUrl: "/users/1",
    missingVariables: [],
    headers: [{ name: "content-type", value: "application/json" }],
    body: JSON.stringify({ code: "oops" }),
    bodyKind: "json",
    truncated: false,
  };
  const findings = validateResponse(draft, response);
  const paramFindings = findings.filter((item) => item.check === "响应参数");
  assert.ok(paramFindings.some((item) => item.message.includes("code") && item.message.includes("integer")));
  assert.ok(paramFindings.some((item) => item.message.includes("X-Total-Count")));
  assert.ok(!findings.some((item) => item.message.includes("legacy")), "有字段定义时不再按示例结构重复比对");
});

test("responseParamTables：按位置分组并遮蔽敏感响应头示例", () => {
  const tables = responseParamTables(rows);
  assert.equal(tables.length, 2);
  assert.equal(tables[0].rows.length, 2);
  assert.equal(tables[1].rows.find((row) => row.name === "Authorization").example, "<请自行填写>");
  assert.deepEqual(responseParamTables(undefined), []);
});
