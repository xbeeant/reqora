import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodeTemplateContext,
  builtinCodeTemplates,
  renderCodeTemplate,
} from "../src/lib/codeTemplate.ts";
import { emptyRequest } from "../src/lib/defaults.ts";

const row = (key, value, enabled = true) => ({ id: `id-${key}`, key, value, enabled });

function makeRequest() {
  return {
    ...emptyRequest(),
    name: "Get User Info",
    method: "POST",
    url: "{{host}}/users",
    headers: [row("X-Trace", "abc")],
    query: [row("page", "2")],
    body: { type: "json", content: '{"name":"Amy"}' },
    auth: { type: "bearer", token: "T" },
  };
}

const context = () =>
  buildCodeTemplateContext(makeRequest(), { host: "https://api.example.com" });

test("buildCodeTemplateContext：URL 变量展开、query/鉴权/Content-Type 合并", () => {
  const ctx = context();
  assert.equal(ctx.method, "POST");
  assert.equal(ctx.methodLower, "post");
  assert.equal(ctx.url, "https://api.example.com/users?page=2");
  assert.equal(ctx.urlJson, '"https://api.example.com/users?page=2"');
  assert.deepEqual(
    ctx.headers.map((item) => item.key),
    ["X-Trace", "Authorization", "Content-Type"],
  );
  assert.equal(ctx.headers.find((item) => item.key === "Authorization").value, "Bearer T");
});

test("buildCodeTemplateContext：函数名派生与请求体字面量", () => {
  const ctx = context();
  assert.equal(ctx.nameCamel, "getUserInfo");
  assert.equal(ctx.namePascal, "GetUserInfo");
  assert.equal(ctx.nameSnake, "get_user_info");
  assert.equal(ctx.hasBody, true);
  assert.match(ctx.bodyLiteral, /"name": "Amy"/);
  assert.equal(ctx.bodyJson, '"{\\"name\\":\\"Amy\\"}"');
  const chinese = buildCodeTemplateContext({ ...makeRequest(), name: "获取用户" }, {});
  assert.equal(chinese.nameCamel, "request");
});

test("renderCodeTemplate：普通变量与三花括号等价", () => {
  const ctx = context();
  const result = renderCodeTemplate("{{method}} {{{urlJson}}}", ctx);
  assert.equal(result.code, 'POST "https://api.example.com/users?page=2"');
  assert.deepEqual(result.unknownTokens, []);
});

test("renderCodeTemplate：headers 循环暴露 key/value/index/first/last", () => {
  const ctx = context();
  const result = renderCodeTemplate(
    "{{#each headers}}{{index}}:{{key}}={{value}}{{#if first}}(first){{/if}}{{#if last}}(last){{/if}};{{/each}}",
    ctx,
  );
  assert.match(result.code, /0:X-Trace=abc\(first\);/);
  assert.match(result.code, /2:Content-Type=application\/json\(last\);/);
  assert.deepEqual(result.unknownTokens, []);
});

test("renderCodeTemplate：条件块与嵌套块", () => {
  const ctx = context();
  assert.equal(renderCodeTemplate("{{#if hasBody}}BODY{{/if}}", ctx).code, "BODY");
  assert.equal(renderCodeTemplate("{{#if bodyNote}}SHOULD-NOT{{/if}}", ctx).code, "");
  const nested = renderCodeTemplate(
    "{{#if hasBody}}[{{#each headers}}{{key}},{{/each}}]{{/if}}",
    ctx,
  ).code;
  assert.equal(nested, "[X-Trace,Authorization,Content-Type,]");
});

test("renderCodeTemplate：未知变量渲染为空并被收集", () => {
  const result = renderCodeTemplate("A{{nope}}B{{alsoMissing}}", context());
  assert.equal(result.code, "AB");
  assert.deepEqual(result.unknownTokens, ["nope", "alsoMissing"]);
});

test("renderCodeTemplate：未闭合标签不泄漏控制语法", () => {
  const result = renderCodeTemplate("x{{/if}}y", context());
  assert.equal(result.code, "xy");
});

test("renderCodeTemplate：标签后紧跟的右花括号不会被吞掉", () => {
  const result = renderCodeTemplate("const cfg = { url: {{{urlJson}}} };", context());
  assert.equal(
    result.code,
    'const cfg = { url: "https://api.example.com/users?page=2" };',
  );
  assert.deepEqual(result.unknownTokens, []);
});

test("内置示例模板可渲染且不含未知变量", () => {
  const ctx = context();
  const templates = builtinCodeTemplates();
  assert.equal(templates.length, 2);
  for (const template of templates) {
    const result = renderCodeTemplate(template.content, ctx);
    assert.deepEqual(result.unknownTokens, [], `${template.name} 有未知变量`);
    assert.match(result.code, /https:\/\/api\.example\.com\/users\?page=2/);
    assert.match(result.code, /Amy/);
  }
  assert.match(templates[0].content, /@\/utils\/http/);
});

// ---- 增强：URL 运行时变量（{{baseUrl}} → ${baseUrl}）--------------------

test("urlExpr：残留 {{baseUrl}} 生成带反引号的 TS 模板字面量", () => {
  const request = {
    ...makeRequest(),
    url: "{{baseUrl}}/polaris/api/admin/spec/edit",
    query: [row("status", "1")],
  };
  // 变量表为空 → baseUrl 未被展开，urlExpr 应保留为运行时插值。
  const ctx = buildCodeTemplateContext(request, {});
  assert.deepEqual(ctx.urlVariables, ["baseUrl"]);
  assert.equal(ctx.urlTemplate, "${baseUrl}/polaris/api/admin/spec/edit?status=1");
  assert.equal(ctx.urlExpr, "`${baseUrl}/polaris/api/admin/spec/edit?status=1`");
  // url / urlJson 仍是「已展开（此处保留标记）」的旧语义，向后兼容。
  assert.match(ctx.url, /\{\{baseUrl\}\}/);
});

test("urlExpr：query 值里的 {{变量}} 不被百分号编码", () => {
  const request = { ...makeRequest(), url: "{{baseUrl}}/search", query: [row("token", "{{token}}")] };
  const ctx = buildCodeTemplateContext(request, {});
  assert.equal(ctx.urlTemplate, "${baseUrl}/search?token=${token}");
  assert.deepEqual(ctx.urlVariables, ["baseUrl", "token"]);
});

test("urlExpr：无残留变量时退化为双引号字面量", () => {
  const ctx = buildCodeTemplateContext(
    { ...makeRequest(), url: "https://api.example.com/users" },
    {},
  );
  assert.deepEqual(ctx.urlVariables, []);
  assert.equal(ctx.urlExpr, '"https://api.example.com/users?page=2"');
  assert.equal(ctx.urlTemplate, "https://api.example.com/users?page=2");
});

test("urlExpr：URL 含真实反引号时转义，不破坏模板字面量", () => {
  const ctx = buildCodeTemplateContext(
    { ...makeRequest(), url: "{{baseUrl}}/a`b", query: [] },
    {},
  );
  assert.equal(ctx.urlExpr, "`${baseUrl}/a\\`b`");
});

test("renderCodeTemplate 用 urlExpr 生成可直接粘贴的 fetch 代码", () => {
  const ctx = buildCodeTemplateContext(
    { ...makeRequest(), url: "{{baseUrl}}/users", query: [], body: { type: "none" } },
    {},
  );
  const code = renderCodeTemplate("fetch({{{urlExpr}}}, { method: \"{{methodLower}}\" })", ctx).code;
  assert.equal(code, 'fetch(`${baseUrl}/users`, { method: "post" })');
});

// ---- 增强：请求 / 响应 TS 类型推导 ---------------------------------------

test("requestType/responseType：由请求体与响应示例推导 TS 类型", () => {
  const request = {
    ...makeRequest(),
    name: "Edit Spec",
    body: { type: "json", content: '{"specId":123,"title":"x","tags":["a"]}' },
    doc: {
      ...emptyRequest().doc,
      responses: [
        { id: "r1", name: "ok", status: 200, contentType: "application/json", body: '{"code":0,"data":{"id":9}}', description: "" },
      ],
    },
  };
  const ctx = buildCodeTemplateContext(request, {});
  assert.equal(ctx.requestTypeName, "EditSpecRequest");
  assert.equal(ctx.responseTypeName, "EditSpecResponse");
  assert.equal(ctx.hasTypes, true);
  assert.match(ctx.requestType, /export type EditSpecRequest = \{/);
  assert.match(ctx.requestType, /"specId": number;/);
  assert.match(ctx.requestType, /"tags": Array<string>;/);
  assert.match(ctx.responseType, /export type EditSpecResponse = \{/);
  assert.match(ctx.responseType, /"code": number;/);
});

test("类型推导：无请求体/无响应示例时给出 unknown 占位而非报错", () => {
  const request = { ...makeRequest(), name: "Ping", body: { type: "none" }, doc: undefined };
  const ctx = buildCodeTemplateContext(request, {});
  assert.equal(ctx.hasTypes, false);
  assert.match(ctx.requestType, /export type PingRequest = unknown;/);
  assert.match(ctx.responseType, /export type PingResponse = unknown;/);
});

test("类型推导：纯中文名用 Api 前缀，避免 RequestRequest 冗余", () => {
  const ctx = buildCodeTemplateContext(
    { ...makeRequest(), name: "编辑规格", body: { type: "json", content: '{"a":1}' } },
    {},
  );
  assert.equal(ctx.requestTypeName, "ApiRequest");
  assert.equal(ctx.responseTypeName, "ApiResponse");
  assert.match(ctx.requestType, /export type ApiRequest =/);
});

test("renderCodeTemplate 渲染类型声明 token，无未知变量", () => {
  const ctx = buildCodeTemplateContext(makeRequest(), {});
  const result = renderCodeTemplate("{{requestType}}\n\n{{responseType}}", ctx);
  assert.deepEqual(result.unknownTokens, []);
  assert.match(result.code, /export type GetUserInfoRequest =/);
  assert.match(result.code, /export type GetUserInfoResponse =/);
});
