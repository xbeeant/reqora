import assert from "node:assert/strict";
import test from "node:test";

import {
  detectFormat,
  importInsomnia,
  insomniaInputError,
  previewImport,
} from "../src/lib/transfer.ts";

// --------------------------------------------------------------- fixtures ----

const V4 = JSON.stringify({
  _type: "export",
  __export_format: 4,
  resources: [
    { _id: "wrk_1", _type: "workspace", name: "示例工作区", parentId: null },
    {
      _id: "fld_1",
      _type: "request_group",
      parentId: "wrk_1",
      name: "用户",
      metaSortKey: -100,
      environment: { folderToken: "f-1" },
      authentication: { type: "bearer", token: "{{ _.token }}" },
    },
    { _id: "fld_2", _type: "request_group", parentId: "fld_1", name: "子分组", metaSortKey: -10 },
    {
      _id: "req_1",
      _type: "request",
      parentId: "fld_2",
      name: "取用户",
      method: "GET",
      url: "{{ _.baseUrl }}/users?from=url&{{ _.extra }}=1",
      parameters: [
        { name: "page", value: "{{ _.page }}", disabled: false },
        { name: "off", value: "x", disabled: true },
      ],
      headers: [
        { name: "X-Token", value: "{{ _.token }}", disabled: false },
        { name: "X-Off", value: "old", disabled: true },
      ],
      body: { mimeType: "application/json", text: '{"id":{{ _.id }}}' },
      metaSortKey: -20,
    },
    {
      _id: "req_2",
      _type: "request",
      parentId: "wrk_1",
      name: "无鉴权请求",
      method: "POST",
      // v4 允许完全不带 authentication（上游 #693 曾在这里崩）。
      url: "https://api.test/echo",
      body: { mimeType: "application/vnd.api+json", text: '{"a":1}' },
      metaSortKey: -10,
    },
    {
      _id: "req_3",
      _type: "request",
      parentId: "wrk_1",
      name: "XML 请求",
      method: "POST",
      url: "https://api.test/xml",
      body: { mimeType: "text/xml", text: "<a>1</a>" },
    },
    {
      _id: "env_1",
      _type: "environment",
      parentId: "wrk_1",
      name: "基础环境",
      data: { baseUrl: "https://api.test", token: "{{ _.secretToken }}" },
      isPrivate: false,
    },
  ],
});

const V5 = JSON.stringify({
  type: "collection.insomnia.rest/5.0",
  name: "V5 集合",
  meta: { id: "wrk", description: "desc" },
  collection: [
    {
      type: "folder",
      meta: { id: "fld", name: "分组", sortKey: -10 },
      authentication: { type: "apikey", key: "X-Key", value: "{{ _.key }}", addTo: "query" },
      children: [
        {
          type: "request",
          meta: { id: "req", name: "列表" },
          method: "PATCH",
          url: "https://api.test/items?a=1",
          parameters: [{ name: "b", value: "2" }],
          headers: [{ name: "Accept", value: "application/json" }],
          body: {
            mimeType: "application/x-www-form-urlencoded",
            params: [{ name: "q", value: "{{ _.q }}" }],
          },
        },
        {
          type: "request",
          meta: { name: "SOAP" },
          method: "POST",
          url: "https://api.test/soap",
          body: { mimeType: "application/soap+xml", text: "<x/>" },
        },
      ],
    },
    { type: "grpc_request", meta: { name: "流式" }, url: "" },
  ],
  environments: [{ name: "开发环境", data: { key: "k-1" }, isPrivate: true }],
});

function findRequest(result, name) {
  const item = result.collections.flatMap((collection) => collection.items).find((entry) => entry.name === name);
  assert.ok(item, `应导入请求 ${name}`);
  return item;
}

// ------------------------------------------------------------------ tests ----

test("detectFormat 识别 Insomnia v4 / v5 / YAML，且不误伤既有格式", () => {
  assert.equal(detectFormat(V4), "insomnia");
  assert.equal(detectFormat(V5), "insomnia");
  assert.equal(detectFormat("type: collection.insomnia.rest/5.0\nname: Demo\ncollection: []"), "insomnia");
  assert.equal(detectFormat('{"info":{"schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"}}'), "postman");
  assert.equal(detectFormat('{"openapi":"3.0.0"}'), "openapi");
  assert.equal(detectFormat('{"log":{"entries":[]}}'), "har");
  assert.equal(detectFormat('{"foo":1}'), "unknown");
});

test("v4：嵌套文件夹、URL query + parameters、禁用行与变量全字段归一化", () => {
  const result = importInsomnia(V4);
  assert.equal(result.collections[0].name, "示例工作区");
  const items = result.collections[0].items;
  assert.deepEqual(items.map((item) => item.name), ["取用户", "无鉴权请求", "XML 请求"]);

  const first = findRequest(result, "取用户");
  // #290：URL 自带 query 与独立 parameters 都导入。
  assert.equal(first.folder, "用户/子分组");
  assert.equal(first.url, "{{baseUrl}}/users");
  assert.deepEqual(
    first.query.map((entry) => [entry.key, entry.value, entry.enabled]),
    [
      ["from", "url", true],
      ["{{extra}}", "1", true],
      ["page", "{{page}}", true],
      ["off", "x", false],
    ],
  );
  // #291：headers / body / auth / query 里的 {{ _.var }} 都要转换。
  assert.equal(first.headers.find((entry) => entry.key === "X-Token").value, "{{token}}");
  assert.equal(first.headers.find((entry) => entry.key === "X-Off").enabled, false);
  assert.equal(first.headers.find((entry) => entry.key.toLowerCase() === "content-type").value, "application/json");
  assert.equal(first.body.type, "json");
  assert.equal(first.body.content, '{"id":{{id}}}');
  // 文件夹级鉴权继承，且值里的变量也被转换。
  assert.equal(first.auth.type, "bearer");
  assert.equal(first.auth.token, "{{token}}");

  // #693：v4 request 无 authentication 时按「无鉴权」导入，不抛错。
  assert.equal(findRequest(result, "无鉴权请求").auth.type, "none");
  // #507：vendor +json 归为 json、text/xml 保留为 raw 且不丢 Content-Type。
  assert.equal(findRequest(result, "无鉴权请求").body.type, "json");
  const xml = findRequest(result, "XML 请求");
  assert.equal(xml.body.type, "raw");
  assert.equal(xml.body.content, "<a>1</a>");
  assert.equal(xml.body.contentType, "text/xml");
  assert.equal(xml.headers.find((entry) => entry.key === "Content-Type").value, "text/xml");

  // 环境资源 + 文件夹级变量都进入环境表。
  assert.equal(result.environments[0].name, "基础环境");
  assert.deepEqual(result.environments[0].variables.map((entry) => entry.key), ["baseUrl", "token"]);
  // #291：环境变量值里的 Insomnia 写法同样要归一化，不能只处理请求字段。
  assert.equal(result.environments[0].variables[1].value, "{{secretToken}}");
  assert.equal(result.environments[1].name, "示例工作区 文件夹变量");
  assert.equal(result.environments[1].variables[0].key, "folderToken");
});

test("GraphQL envelope：拆成可发送 body，variables 保持 JSON 类型，Content-Type 为 application/json", () => {
  const text = JSON.stringify({
    query: "query Q($id:Int!){user(id:$id){id}}",
    variables: { id: 7, active: true },
    operationName: "Q",
  });
  const doc = JSON.stringify({
    _type: "export",
    __export_format: 4,
    resources: [
      { _id: "wrk", _type: "workspace", name: "GQL" },
      {
        _id: "req",
        _type: "request",
        parentId: "wrk",
        name: "查询",
        method: "POST",
        url: "https://api.test/graphql",
        body: { mimeType: "application/graphql", text },
      },
    ],
  });
  const request = findRequest(importInsomnia(doc), "查询");
  assert.equal(request.body.type, "graphql");
  assert.match(request.body.query, /query Q/u);
  // 上游 #693 review 的 P1：数字与布尔不能被字符串化。
  assert.match(request.body.variables, /"id":\s*7/u);
  assert.match(request.body.variables, /"active":\s*true/u);
  assert.equal(request.headers.find((entry) => entry.key === "Content-Type").value, "application/json");
  assert.ok(importInsomnia(doc).warnings.some((warning) => warning.includes("operationName")));
});

test("GraphQL envelope 含模板标签时按原始文本恢复，不改写变量值类型", () => {
  const text = '{"query":"{me{id}}","variables":{"id":{{ _.id }},"flag":true,"n":5}}';
  const doc = JSON.stringify({
    type: "collection.insomnia.rest/5.0",
    name: "GQL",
    collection: [
      {
        type: "request",
        meta: { name: "查询" },
        method: "POST",
        url: "https://api.test/graphql",
        body: { mimeType: "application/graphql", text },
      },
    ],
  });
  const result = importInsomnia(doc);
  const request = findRequest(result, "查询");
  assert.equal(request.body.query, "{me{id}}");
  assert.match(request.body.variables, /\{\{id\}\}/u);
  assert.match(request.body.variables, /"flag":\s*true/u);
  assert.match(request.body.variables, /"n":\s*5/u);
  assert.equal(request.headers.find((entry) => entry.key === "Content-Type").value, "application/json");
  assert.ok(!result.warnings.some((warning) => warning.includes("整体保留为 query")));
});

test("模板变量与 Nunjucks 标签：精确转换，其余保留并显式告警（不静默发送）", () => {
  const doc = JSON.stringify({
    _type: "export",
    __export_format: 4,
    resources: [
      { _id: "wrk", _type: "workspace", name: "Tags" },
      {
        _id: "req",
        _type: "request",
        parentId: "wrk",
        name: "标签",
        method: "GET",
        url:
          "https://api.test/{{ _.id }}?ts={% now 'millis' %}&u={% uuid %}" +
          "&legacy={% timestamp %}&custom={% now 'custom', 'YYYY' %}" +
          "&resp={% response 'body', 'req_x', '$.id', 'never', 60 %}",
        headers: [{ name: "X-Bracket", value: "{{ _['x-token'] }}" }],
        authentication: { type: "basic", username: "{{ _.user }}", password: "p" },
      },
    ],
  });
  const result = importInsomnia(doc);
  const request = findRequest(result, "标签");
  assert.match(request.url, /\{\{id\}\}/u);
  // URL 里的 query 会拆成独立 query 行；标签转换必须同样覆盖到这些行（#291）。
  const queryText = request.query.map((entry) => `${entry.key}=${entry.value}`).join("&");
  assert.ok(queryText.includes("{{$timestampMs}}"), "now/timestamp 应转成 Reqora 动态变量");
  assert.ok(queryText.includes("{{$guid}}"), "uuid 应转成 Reqora 动态变量");
  // 不支持的 tag 保留原文，warning 里点名，用户不会以为请求已经正确发出。
  assert.ok(queryText.includes("{% now 'custom', 'YYYY' %}"));
  assert.ok(queryText.includes("{% response 'body'"));
  assert.equal(request.headers[0].value, "{{x-token}}");
  assert.equal(request.auth.username, "{{user}}");
  // #77：Basic auth 直接保存明文凭据由 Rust 侧编码，导入器不做 Base64（避免 padding 问题）。
  assert.equal(request.auth.password, "p");
  const warning = result.warnings.find((item) => item.includes("没有等价实现"));
  assert.ok(warning, "应明确列出未转换的标签");
  assert.match(warning, /now/u);
  assert.match(warning, /response/u);
});

test("v5：层级 collection、继承鉴权、query/form/环境私密标记与未知资源告警", () => {
  const result = importInsomnia(V5);
  assert.equal(result.collections[0].name, "V5 集合");
  const list = findRequest(result, "列表");
  assert.equal(list.folder, "分组");
  assert.equal(list.method, "PATCH");
  assert.deepEqual(list.query.map((entry) => [entry.key, entry.value]), [["a", "1"], ["b", "2"]]);
  assert.equal(list.body.type, "formUrlEncoded");
  assert.equal(list.body.items[0].value, "{{q}}");
  assert.equal(list.auth.type, "apiKey");
  assert.equal(list.auth.location, "query");
  assert.equal(list.auth.key, "X-Key");
  // v4 / v5 共用 body 映射：+xml 也不能丢。
  const soap = findRequest(result, "SOAP");
  assert.equal(soap.body.type, "raw");
  assert.equal(soap.body.contentType, "application/soap+xml");
  assert.equal(result.environments[0].name, "开发环境");
  assert.equal(result.environments[0].variables[0].secret, true);
  assert.ok(result.warnings.some((warning) => warning.includes("grpc_request")));
});

test("表单/二进制文件引用与不支持的鉴权均给出中文告警，不静默丢数据", () => {
  const doc = JSON.stringify({
    _type: "export",
    __export_format: 4,
    resources: [
      { _id: "wrk", _type: "workspace", name: "Files" },
      {
        _id: "req",
        _type: "request",
        parentId: "wrk",
        name: "上传",
        method: "POST",
        url: "https://api.test/upload",
        authentication: { type: "oauth2", token: "x" },
        body: {
          mimeType: "multipart/form-data",
          params: [
            { name: "text", value: "v" },
            { name: "avatar", value: "", fileName: "/tmp/a.png" },
          ],
        },
      },
    ],
  });
  const result = importInsomnia(doc);
  const request = findRequest(result, "上传");
  assert.equal(request.body.type, "formData");
  assert.equal(request.body.items[1].file, true);
  assert.equal(request.body.items[1].fileName, "/tmp/a.png");
  assert.equal(request.auth.type, "none");
  assert.ok(result.warnings.some((warning) => warning.includes("avatar")));
  assert.ok(result.warnings.some((warning) => warning.includes("oauth2")));
});

test("zip / 超大文件 / 非法内容给明确中文错误，不落回 cURL 空转", () => {
  assert.match(insomniaInputError("PK\u0003\u0004dummy") ?? "", /ZIP/u);
  assert.match(insomniaInputError("x".repeat(20 * 1024 * 1024 + 1)) ?? "", /过大/u);
  assert.throws(() => importInsomnia("PK\u0003\u0004dummy"), /ZIP/u);
  assert.throws(() => importInsomnia("not json nor yaml"), /无法解析/u);
});

test("空 Insomnia 导出给出 warning 而不是异常", () => {
  const result = importInsomnia('{"_type":"export","__export_format":4,"resources":[]}');
  assert.equal(result.collections[0].items.length, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("没有找到可导入的 HTTP 请求")));
});

test("previewImport 给出 Insomnia 摘要、变量清单与重复导入提示", () => {
  const preview = previewImport(V4);
  assert.equal(preview.format, "insomnia");
  assert.equal(preview.error, null);
  assert.deepEqual(preview.collectionNames, ["示例工作区"]);
  assert.equal(preview.requestCount, 3);
  assert.ok(preview.environmentNames.includes("基础环境"));
  assert.ok(preview.variableNames.includes("baseUrl"));
  assert.ok(preview.variableNames.includes("folderToken"));
  assert.ok(preview.warnings.some((warning) => warning.includes("重复导入")));
  assert.match(previewImport("PK\u0003\u0004dummy").error ?? "", /ZIP/u);
});
