/**
 * transfer.ts 纯逻辑测试：Postman / OpenAPI(JSON+YAML) / cURL 导入，
 * OpenAPI / Markdown 导出与格式检测。Node 22 原生剥离 TS 类型。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { emptyDoc, normalizeRequest } from "../src/lib/defaults.ts";
import {
  detectFormat,
  exportMarkdown,
  exportOpenApi,
  importCurl,
  importOpenApi,
  importPostman,
  importPostmanEnvironment,
  previewImport,
} from "../src/lib/transfer.ts";

function snapshot(collections, environments = []) {
  return {
    version: 1,
    seeded: false,
    collections,
    environments,
    activeEnvironmentId: null,
    history: [],
    cases: [],
    settings: { timeoutSecs: 30, followRedirects: true, verifyTls: true },
  };
}

// ------------------------------------------------------------ detectFormat ----

test("detectFormat 识别 postman / openapi / 未知", () => {
  assert.equal(detectFormat('{"info":{"schema":".../v2.1.0/collection.json","name":"x"}}'), "unknown");
  const postman = JSON.stringify({
    info: { name: "x", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  });
  assert.equal(detectFormat(postman), "postman");
  assert.equal(detectFormat('{"openapi":"3.0.0","info":{},"paths":{}}'), "openapi");
  assert.equal(detectFormat("openapi: 3.0.0\ninfo:\n  title: x"), "openapi");
  assert.equal(detectFormat("curl -X POST http://x.io"), "unknown");
  assert.equal(detectFormat("   "), "unknown");
});

// ------------------------------------------------------------ importPostman ----

const POSTMAN = JSON.stringify({
  info: {
    name: "Demo API",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  auth: { type: "basic", basic: [{ key: "username", value: "u" }, { key: "password", value: "p" }] },
  item: [
    {
      name: "用户",
      item: [
        {
          name: "登录",
          item: [
            {
              name: "登录接口",
              request: {
                method: "POST",
                url: {
                  raw: "https://api.example.com/login?page=1",
                  query: [{ key: "page", value: "1" }],
                },
                header: [{ key: "Content-Type", value: "application/json" }],
                body: { mode: "raw", raw: '{"user":"amy"}', options: { raw: { language: "json" } } },
                auth: { type: "bearer", bearer: [{ key: "token", value: "t-1" }] },
                description: "登录说明",
              },
            },
          ],
        },
      ],
    },
    {
      name: "表单提交",
      request: {
        method: "POST",
        url: "https://api.example.com/form",
        body: {
          mode: "urlencoded",
          urlencoded: [{ key: "a", value: "1" }, { key: "b", value: "2", disabled: true }],
        },
      },
    },
    {
      name: "上传头像",
      request: {
        method: "POST",
        url: "https://api.example.com/avatar",
        body: {
          mode: "formdata",
          formdata: [{ key: "file", type: "file", src: "/tmp/a.png" }, { key: "note", value: "hi" }],
        },
      },
    },
  ],
});

test("importPostman 解析嵌套 folder、json body 与请求级 auth", () => {
  const r = importPostman(POSTMAN);
  assert.equal(r.collections.length, 1);
  assert.equal(r.collections[0].name, "Demo API");
  assert.equal(r.collections[0].items.length, 3);

  const login = r.collections[0].items[0];
  assert.equal(login.folder, "用户/登录");
  assert.equal(login.method, "POST");
  assert.equal(login.url, "https://api.example.com/login");
  assert.deepEqual(login.query.map((q) => [q.key, q.value, q.enabled]), [["page", "1", true]]);
  assert.equal(login.body.type, "json");
  assert.equal(login.body.content, '{"user":"amy"}');
  assert.equal(login.auth.type, "bearer");
  assert.equal(login.auth.token, "t-1");
  assert.equal(login.doc.description, "登录说明");

  const form = r.collections[0].items[1];
  assert.equal(form.folder, "");
  assert.equal(form.body.type, "formUrlEncoded");
  assert.equal(form.body.items[1].enabled, false);
  // 无请求级 auth 时回落到集合级 basic
  assert.deepEqual(form.auth, { type: "basic", username: "u", password: "p" });
});

test("importPostman 处理 multipart 文件部分并给出 warning", () => {
  const r = importPostman(POSTMAN);
  const upload = r.collections[0].items[2];
  assert.equal(upload.body.type, "formData");
  const filePart = upload.body.items[0];
  assert.equal(filePart.file, true);
  assert.equal(filePart.fileName, "a.png");
  assert.ok(r.warnings.some((w) => w.includes("file") && w.includes("a.png")));
});

test("importPostman 拒绝非 JSON 输入", () => {
  assert.throws(() => importPostman("{oops"), /不是合法 JSON/);
});

// ------------------------------------------------------------ importOpenApi ----

const OPENAPI_JSON = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Pet" },
  servers: [{ url: "https://pet.example.com/v1" }],
  components: { securitySchemes: { s: { type: "http", scheme: "basic" } } },
  security: [{ s: [] }],
  paths: {
    "/pets": {
      get: {
        summary: "列表",
        tags: ["宠物"],
        parameters: [
          {
            name: "page",
            in: "query",
            required: true,
            description: "页码",
            schema: { type: "integer", example: 2 },
          },
          { name: "sess", in: "cookie", schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "ok", content: { "application/json": { example: { pets: [] } } } },
        },
      },
      post: {
        summary: "创建",
        security: [],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
            },
          },
        },
      },
    },
    "/pets/{id}": {
      get: {
        summary: "详情",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      },
    },
  },
});

test("importOpenApi(JSON)：servers 生成 baseUrl、paramMeta、示例响应与 security", () => {
  const r = importOpenApi(OPENAPI_JSON);
  assert.equal(r.collections[0].name, "Pet");
  assert.equal(r.environments[0].variables[0].key, "baseUrl");
  assert.equal(r.environments[0].variables[0].value, "https://pet.example.com/v1");

  const list = r.collections[0].items[0];
  assert.equal(list.method, "GET");
  assert.equal(list.url, "{{baseUrl}}/pets");
  assert.equal(list.folder, "宠物");
  assert.equal(list.auth.type, "basic");
  const page = list.query[0];
  const meta = list.doc.paramMeta[`q:${page.id}`];
  assert.equal(meta.required, true);
  assert.equal(meta.description, "页码");
  assert.equal(meta.example, "2");
  assert.equal(meta.type, "integer");
  assert.ok(r.warnings.some((w) => w.includes("sess") && w.includes("cookie")));
  assert.equal(list.doc.responses[0].status, 200);
  assert.ok(list.doc.responses[0].body.includes("pets"));

  const create = r.collections[0].items[1];
  assert.equal(create.auth.type, "none", "operation 级 security:[] 覆盖根级");
  assert.equal(create.body.type, "json");
  assert.deepEqual(JSON.parse(create.body.content), { name: "" }, "按 required 合成空示例");

  const detail = r.collections[0].items[2];
  assert.equal(detail.url, "{{baseUrl}}/pets/{id}", "path 参数保留原样");
});

test("importOpenApi(YAML 子集)：缩进映射、列表与流式集合", () => {
  const yaml = `# 注释行应被忽略
openapi: 3.0.0
info:
  title: YAML API
servers:
  - url: https://yaml.example.com
paths:
  /ping:
    get:
      summary: ping
      parameters:
        - name: q
          in: query
          description: 查询词
          schema:
            type: string
            example: hello
  /data:
    post:
      summary: 提交
      requestBody:
        content:
          application/json:
            example: { "a": 1, "b": [true, null, "x"] }
`;
  const r = importOpenApi(yaml);
  assert.equal(r.collections[0].name, "YAML API");
  assert.equal(r.environments[0].variables[0].value, "https://yaml.example.com");
  const ping = r.collections[0].items[0];
  assert.equal(ping.method, "GET");
  assert.equal(ping.url, "{{baseUrl}}/ping");
  const q = ping.query[0];
  assert.equal(q.key, "q");
  assert.equal(ping.doc.paramMeta[`q:${q.id}`].example, "hello");
  const submit = r.collections[0].items[1];
  assert.deepEqual(JSON.parse(submit.body.content), { a: 1, b: [true, null, "x"] });
});

test("importOpenApi 对解析不了的输入抛出带说明的错误", () => {
  assert.throws(() => importOpenApi("{oops"), /合法 JSON/);
  assert.throws(
    () => importOpenApi("openapi: 3.0\npaths:\n  bad line without colon\n"),
    /建议先把文档转换为 JSON/,
  );
  assert.throws(() => importOpenApi(""), /内容为空/);
});

// ------------------------------------------------------------ importCurl ----

test("importCurl 解析多行续行、引号转义与 JSON body", () => {
  const cmd = [
    "curl -X POST 'https://api.example.com/users?page=1' \\",
    "  -H 'Content-Type: application/json' \\",
    '  -H "Authorization: Bearer abc" \\',
    "  --data-raw '{\"name\":\"amy\",\"age\":18}'",
  ].join("\n");
  const r = importCurl(cmd);
  assert.equal(r.warnings.length, 0);
  const req = r.collections[0].items[0];
  assert.equal(req.method, "POST");
  assert.equal(req.url, "https://api.example.com/users");
  assert.deepEqual(req.query.map((q) => [q.key, q.value]), [["page", "1"]]);
  assert.equal(req.body.type, "json");
  assert.equal(JSON.parse(req.body.content).name, "amy");
  assert.deepEqual(req.headers.map((h) => h.key), ["Content-Type", "Authorization"]);
  assert.equal(req.headers[1].value, "Bearer abc");
});

test("importCurl 缺省 method、form 数据与 basic auth", () => {
  const post = importCurl("curl -u amy:secret -d 'a=1' -d 'b=2' http://x.io/search");
  const postReq = post.collections[0].items[0];
  assert.equal(postReq.method, "POST");
  assert.equal(postReq.body.type, "formUrlEncoded");
  assert.deepEqual(postReq.body.items.map((kv) => [kv.key, kv.value]), [["a", "1"], ["b", "2"]]);
  assert.deepEqual(postReq.auth, { type: "basic", username: "amy", password: "secret" });

  const get = importCurl("curl http://x.io");
  assert.equal(get.collections[0].items[0].method, "GET");
  assert.equal(get.collections[0].items[0].body.type, "none");

  const g = importCurl("curl -G 'http://x.io/search' --data-urlencode 'kw=白 泡'");
  const gReq = g.collections[0].items[0];
  assert.equal(gReq.method, "GET");
  assert.deepEqual(gReq.query.map((q) => [q.key, q.value]), [["kw", "白 泡"]]);
});

test("importCurl multipart、-X 覆盖、紧跟值与 $'' 引用", () => {
  const cmd = [
    "curl -XPUT --form 'file=@/tmp/a.png' --form 'note=hello' \\",
    "  $'http://x.io/up load' -k -s",
  ].join("\n");
  const r = importCurl(cmd);
  const req = r.collections[0].items[0];
  assert.equal(req.method, "PUT");
  assert.equal(req.url, "http://x.io/up load");
  assert.equal(req.body.type, "formData");
  const filePart = req.body.items[0];
  assert.equal(filePart.file, true);
  assert.equal(filePart.fileName, "a.png");
  assert.equal(req.body.items[1].value, "hello");
  assert.ok(r.warnings.some((w) => w.includes("a.png")));
});

test("importCurl 缺少 URL 时报错", () => {
  assert.throws(() => importCurl("curl -H 'X: 1'"), /没有找到 URL/);
  assert.throws(() => importCurl(""), /命令为空/);
});

// ------------------------------------------------------------ exportOpenApi ----

function exportFixture() {
  const doc = {
    ...emptyDoc(),
    summary: "创建",
    description: "创建用户说明",
    paramMeta: {
      "q:q1": { type: "integer", required: true, description: "页码", example: "" },
      "h:h1": { type: "string", required: false, description: "自定义标记", example: "" },
    },
    responses: [
      {
        id: "e1",
        name: "成功",
        status: 200,
        contentType: "application/json",
        body: '{"ok":true}',
        description: "",
      },
    ],
  };
  const item = normalizeRequest({
    id: "r1",
    name: "创建用户",
    method: "POST",
    url: "{{baseUrl}}/users",
    description: "",
    headers: [
      { id: "h1", key: "X-Flag", value: "1", enabled: true },
      { id: "h2", key: "Content-Type", value: "application/json", enabled: true },
    ],
    query: [{ id: "q1", key: "page", value: "2", enabled: true }],
    body: { type: "json", content: '{"name":"amy"}' },
    auth: { type: "basic", username: "u", password: "p" },
    doc,
  });
  const getItem = normalizeRequest({
    id: "r2",
    name: "查询用户",
    method: "GET",
    url: "{{baseUrl}}/users/{id}",
    query: [{ id: "q2", key: "full", value: "", enabled: true }],
  });
  return snapshot(
    [{ id: "c1", name: "集合A", items: [item, getItem] }],
    [
      {
        id: "env1",
        name: "测试环境",
        variables: [{ id: "v1", key: "baseUrl", value: "http://api.test", enabled: true }],
      },
    ],
  );
}

test("exportOpenApi 生成 paths、paramMeta 描述、securitySchemes 与响应示例", () => {
  const out = exportOpenApi(exportFixture());
  const oas = JSON.parse(out);
  assert.equal(oas.openapi, "3.0.3");
  assert.deepEqual(oas.servers, [{ url: "http://api.test" }]);

  const post = oas.paths["/users"].post;
  assert.equal(post.summary, "创建");
  assert.equal(post.description, "创建用户说明");
  assert.deepEqual(post.tags, ["集合A"]);
  assert.deepEqual(post.requestBody.content["application/json"].schema.example, { name: "amy" });

  const page = post.parameters.find((p) => p.name === "page");
  assert.equal(page.in, "query");
  assert.equal(page.required, true);
  assert.equal(page.description, "页码");
  assert.equal(page.schema.type, "integer");
  const flag = post.parameters.find((p) => p.name === "X-Flag");
  assert.equal(flag.description, "自定义标记");
  assert.ok(!post.parameters.some((p) => p.name.toLowerCase() === "content-type"), "Content-Type 头不进 parameters");

  assert.deepEqual(post.security, [{ basicAuth: [] }]);
  assert.equal(oas.components.securitySchemes.basicAuth.scheme, "basic");

  const get = oas.paths["/users/{id}"].get;
  const idParam = get.parameters.find((p) => p.in === "path");
  assert.equal(idParam.name, "id");
  assert.equal(idParam.required, true);

  assert.equal(post.responses["200"].description, "成功");
  assert.deepEqual(post.responses["200"].content["application/json"].example, { ok: true });
});

test("exportOpenApi → importOpenApi 往返保持方法/路径/文档", () => {
  const exported = exportOpenApi(exportFixture());
  const r = importOpenApi(exported);
  const create = r.collections[0].items.find((x) => x.url.endsWith("/users"));
  assert.equal(create.method, "POST");
  assert.equal(create.url, "{{baseUrl}}/users");
  assert.equal(create.doc.summary, "创建");
  assert.equal(create.auth.type, "basic");
  assert.equal(create.doc.responses[0].status, 200);
});

// ------------------------------------------------------------ exportMarkdown ----

test("exportMarkdown 输出接口章节、参数表与响应示例", () => {
  const md = exportMarkdown(exportFixture());
  assert.ok(md.includes("# 集合A"));
  assert.ok(md.includes("## POST {{baseUrl}}/users 创建用户"));
  assert.ok(md.includes("**创建**"));
  assert.ok(md.includes("**Query 参数**"));
  assert.ok(md.includes("| page | query | integer | 是 | 页码 | 2 |"));
  assert.ok(md.includes("**请求体**（JSON）"));
  assert.ok(md.includes('"name": "amy"') || md.includes('{"name":"amy"}'));
  assert.ok(md.includes("**响应示例**"));
  assert.ok(md.includes("### 成功（200）"));
  assert.ok(md.includes('"ok": true') || md.includes('{"ok":true}'));
});

test("exportMarkdown 渲染鉴权行、multipart 文件与空工作区", () => {
  const bearer = normalizeRequest({
    id: "r3",
    name: "Bearer 示例",
    method: "GET",
    url: "{{baseUrl}}/me",
    auth: { type: "bearer", token: "" },
    body: {
      type: "formData",
      items: [
        { id: "f1", key: "file", value: "", enabled: true, file: true, fileName: "a.png" },
      ],
    },
  });
  const md = exportMarkdown(snapshot([{ id: "c1", name: "C", items: [bearer] }]));
  assert.ok(md.includes("- 鉴权：Bearer"));
  assert.ok(md.includes("（文件 a.png）"));

  const empty = exportMarkdown(snapshot([]));
  assert.ok(empty.includes("空工作区"));
});

test("导出解析集合级 inherit 鉴权，且不改写工作区", () => {
  const item = normalizeRequest({
    id: "r9",
    name: "继承示例",
    method: "GET",
    url: "{{baseUrl}}/me",
    auth: { type: "inherit" },
  });
  const snap = snapshot([
    {
      id: "c9",
      name: "C",
      auth: { type: "bearer", token: "live-token-should-not-leak" },
      items: [item],
    },
  ]);
  const oas = JSON.parse(exportOpenApi(snap));
  assert.deepEqual(oas.paths["/me"].get.security, [{ bearerAuth: [] }]);
  assert.equal(oas.components.securitySchemes.bearerAuth.scheme, "bearer");
  const md = exportMarkdown(snap);
  assert.ok(md.includes("- 鉴权：Bearer"), "Markdown 也应描述解析后的集合鉴权");
  assert.ok(!md.includes("live-token-should-not-leak"));
  assert.deepEqual(snap.collections[0].items[0].auth, { type: "inherit" });
});

test("Markdown 导出绝不写入明文 token / 密码 / API Key", () => {
  const auths = [
    { type: "bearer", token: "live-bearer-SECRET-991" },
    { type: "basic", username: "amy", password: "live-basic-SECRET-991" },
    { type: "apiKey", key: "X-Api-Key", value: "live-header-SECRET-991", location: "header" },
    { type: "apiKey", key: "access_token", value: "live-query-SECRET-991", location: "query" },
  ];
  const items = auths.map((auth, index) =>
    normalizeRequest({
      id: `rx${index}`,
      name: `接口${index}`,
      method: "GET",
      url: `{{baseUrl}}/p${index}`,
      auth,
    }),
  );
  const md = exportMarkdown(snapshot([{ id: "cx", name: "C", items }]));
  for (const secret of [
    "live-bearer-SECRET-991",
    "live-basic-SECRET-991",
    "live-header-SECRET-991",
    "live-query-SECRET-991",
  ]) {
    assert.ok(!md.includes(secret), `${secret} 不应出现在导出文档`);
  }
  assert.ok(md.includes("{{token}}"));
  assert.ok(md.includes("{{password}}"));
  assert.ok(md.includes("{{apiKey}}"));
  assert.ok(md.includes("X-Api-Key"), "非机密的 key 名仍需保留，文档才可用");
});

// -------------------------------------------------------- 空集合边界 ----

test("空 Postman 集合与无 paths 的 OpenAPI 记 warning 而不抛错", () => {
  const p = importPostman(
    JSON.stringify({ info: { name: "空", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" }, item: [] }),
  );
  assert.equal(p.collections[0].items.length, 0);
  assert.ok(p.warnings.some((w) => w.includes("没有")));
  const o = importOpenApi(JSON.stringify({ openapi: "3.0.0", info: { title: "空" } }));
  assert.equal(o.collections[0].items.length, 0);
  assert.ok(o.warnings.length > 0);
});

// ------------------------------------------- Postman 变量与环境文件 ----

const POSTMAN_WITH_VARS = JSON.stringify({
  info: {
    name: "Var API",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [
    { key: "baseUrl", value: "https://api.example.com" },
    { key: "token", value: "t-secret", type: "string" },
    { key: "off", value: "disabled", disabled: true },
  ],
  item: [
    {
      name: "分组",
      variable: [{ key: "tenant", value: "acme" }],
      item: [
        {
          name: "列表",
          request: {
            method: "GET",
            url: "::baseUrl/users/:id?token=::token&x=1",
            header: [{ key: "X-Tenant", value: "::tenant" }],
            body: { mode: "raw", raw: '{"note":"::tenant"}', options: { raw: { language: "json" } } },
          },
        },
      ],
    },
  ],
});

test("importPostman 把集合/分组 variable 转成环境，并把 ::name 归一化为 {{name}}", () => {
  const r = importPostman(POSTMAN_WITH_VARS);
  assert.equal(r.collections.length, 1);
  assert.equal(r.environments.length, 1);
  assert.equal(r.environments[0].name, "Var API 变量");
  assert.deepEqual(
    r.environments[0].variables.map((v) => [v.key, v.value, v.enabled]),
    [
      ["baseUrl", "https://api.example.com", true],
      ["token", "t-secret", true],
      ["off", "disabled", false],
      ["tenant", "acme", true],
    ],
  );

  const item = r.collections[0].items[0];
  assert.equal(item.url, "{{baseUrl}}/users/:id", "单冒号路径变量 :id 必须保留");
  assert.deepEqual(item.query.map((q) => [q.key, q.value]), [["token", "{{token}}"], ["x", "1"]]);
  assert.equal(item.headers[0].value, "{{tenant}}");
  assert.equal(item.body.content, '{"note":"{{tenant}}"}');
});

test("::name 归一化不误伤 http://、IPv6 与标准 {{变量}}", () => {
  const raw = JSON.stringify({
    info: { name: "n", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    item: [
      {
        name: "mixed",
        request: {
          method: "GET",
          url: "https://api.example.com:8080/v1/{{id}}",
          header: [{ key: "X-Host", value: "[::1]" }],
        },
      },
    ],
  });
  const item = importPostman(raw).collections[0].items[0];
  assert.equal(item.url, "https://api.example.com:8080/v1/{{id}}");
  assert.equal(item.headers[0].value, "[::1]");
});

const POSTMAN_ENV = JSON.stringify({
  id: "e-1",
  name: "Local",
  values: [
    { key: "baseUrl", value: "http://127.0.0.1:8000", type: "default", enabled: true },
    { key: "apiKey", value: "", type: "secret", enabled: true },
  ],
  _postman_variable_scope: "environment",
});

test("detectFormat 识别 Postman 环境文件且不误伤集合 / OpenAPI / HAR", () => {
  assert.equal(detectFormat(POSTMAN_ENV), "postman-env");
  assert.equal(detectFormat(POSTMAN), "postman");
  assert.equal(detectFormat(JSON.stringify({ openapi: "3.0.0", info: {} })), "openapi");
  assert.equal(detectFormat(JSON.stringify({ log: { entries: [] } })), "har");
});

test("importPostmanEnvironment 只生成环境并提示 secret 空值", () => {
  const r = importPostmanEnvironment(POSTMAN_ENV);
  assert.equal(r.collections.length, 0);
  assert.equal(r.environments.length, 1);
  assert.equal(r.environments[0].name, "Local");
  assert.deepEqual(
    r.environments[0].variables.map((v) => [v.key, v.value]),
    [["baseUrl", "http://127.0.0.1:8000"], ["apiKey", ""]],
  );
  assert.ok(r.warnings.some((w) => w.includes("secret")));
});

test("importPostmanEnvironment 拒绝非法 JSON / 空 values", () => {
  assert.throws(() => importPostmanEnvironment("{oops"), /不是合法 JSON/);
  assert.throws(() => importPostmanEnvironment(JSON.stringify({ name: "x", values: [] })), /没有 values/);
});

// ------------------------------------------------------- previewImport ----

test("previewImport 只读解析 Postman 集合，给出集合/接口/环境/变量摘要", () => {
  const p = previewImport(POSTMAN_WITH_VARS);
  assert.equal(p.error, null);
  assert.equal(p.format, "postman");
  assert.deepEqual(p.collectionNames, ["Var API"]);
  assert.equal(p.requestCount, 1);
  assert.deepEqual(p.environmentNames, ["Var API 变量"]);
  assert.deepEqual(p.variableNames, ["baseUrl", "token", "off", "tenant"]);
});

test("previewImport 解析环境文件不产生集合，失败时返回 error 而非抛出", () => {
  const p = previewImport(POSTMAN_ENV);
  assert.equal(p.format, "postman-env");
  assert.equal(p.collectionNames.length, 0);
  assert.equal(p.requestCount, 0);
  assert.deepEqual(p.variableNames, ["baseUrl", "apiKey"]);

  // 缺少 URL 的 cURL 片段必定解析失败，但预览必须返回 error 而不是抛异常。
  const bad = previewImport("curl -X POST -H 'Content-Type: application/json'");
  assert.equal(bad.format, "curl");
  assert.ok(bad.error, "解析失败应通过 error 返回");
  assert.match(bad.error, /URL/);
  assert.equal(bad.requestCount, 0);
});
