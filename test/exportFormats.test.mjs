/**
 * 版本化集合导出器测试：格式版本标记、导入回环、脱敏出口与快照不变性。
 * 所有导出都从 renderExport / renderExportAsync 走，验证 redact.ts 闸门不可绕过。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPORT_FORMAT_GROUPS,
  EXPORT_FORMATS,
  exportFormatSpec,
  formatsOfFamily,
  isExportFormatId,
  redactedExportSnapshot,
  renderExport,
  renderExportAsync,
} from "../src/lib/exportFormats.ts";
import {
  detectFormat,
  importCurl,
  importHar,
  importInsomnia,
  importOpenApi,
  importPostman,
  importPostmanEnvironment,
} from "../src/lib/transfer.ts";

const MARKER = "CANARY_0001";

function row(id, key, value, extra = {}) {
  return { id, key, value, enabled: true, ...extra };
}

function fixture() {
  return {
    version: 1,
    seeded: false,
    collections: [
      {
        id: "col1",
        name: "用户服务",
        folders: ["用户/空文件夹"],
        auth: { type: "apiKey", key: "X-Api-Key", value: MARKER, location: "header" },
        items: [
          {
            id: "req1",
            name: "登录",
            method: "POST",
            url: "{{baseUrl}}/v1/login",
            folder: "用户",
            headers: [
              row("h1", "Content-Type", "application/json"),
              row("h2", "X-Internal", MARKER, { secret: true }),
            ],
            query: [row("q1", "page", "1")],
            body: { type: "json", content: '{"username":"demo","password":"{{password}}"}' },
            auth: { type: "bearer", token: MARKER },
            preScript: "const key = '{{token}}';",
            postScript: "console.log('done');",
            assertions: [
              { id: "a1", enabled: true, name: "状态 200", source: "status", path: "", op: "eq", expected: "200" },
            ],
            doc: {
              summary: "登录接口",
              description: "使用账号密码登录",
              paramMeta: {},
              responses: [
                {
                  id: "r1", name: "成功", status: "200", description: "OK",
                  contentType: "application/json", body: '{"ok":true}', params: [],
                },
              ],
            },
          },
          {
            id: "req2",
            name: "详情",
            method: "GET",
            url: "{{baseUrl}}/v1/users/{id}",
            folder: "用户/详情",
            headers: [],
            query: [],
            body: { type: "none" },
            auth: { type: "inherit" },
          },
        ],
      },
    ],
    environments: [
      {
        id: "env1",
        name: "本地",
        variables: [
          row("v1", "baseUrl", "https://api.example.com"),
          row("v2", "token", MARKER, { secret: true }),
        ],
      },
    ],
    activeEnvironmentId: "env1",
    history: [],
    cases: [],
    scenarios: [],
    trash: [],
    docPages: [],
    settings: { timeoutSecs: 30, followRedirects: true, verifyTls: true },
  };
}

const SYNC_FORMATS = EXPORT_FORMATS.filter((spec) => !spec.encrypted).map((spec) => spec.id);

test("注册表覆盖全部格式族，每个 id 都有文件名与版本标识", () => {
  assert.ok(EXPORT_FORMATS.length >= 18);
  assert.equal(new Set(EXPORT_FORMATS.map((spec) => spec.id)).size, EXPORT_FORMATS.length);
  for (const group of EXPORT_FORMAT_GROUPS) {
    assert.ok(formatsOfFamily(group.family).length > 0, `缺少格式族 ${group.family}`);
  }
  for (const spec of EXPORT_FORMATS) {
    assert.ok(isExportFormatId(spec.id));
    assert.equal(exportFormatSpec(spec.id), spec);
    assert.ok(spec.version.length > 0);
    assert.ok(spec.fileName.endsWith(`.${spec.extension}`));
  }
  assert.equal(isExportFormatId("not-a-format"), false);
  assert.throws(() => exportFormatSpec("not-a-format"), /未知的导出格式/);
});

test("所有导出格式都不带出私密值，且原始快照不被改动", () => {
  const snap = fixture();
  const before = JSON.stringify(snap);
  const safe = redactedExportSnapshot(snap);
  assert.notEqual(JSON.stringify(safe), before, "脱敏出口应返回脱敏后的副本");
  assert.equal(JSON.stringify(snap), before, "导出不得修改工作区快照");

  for (const id of SYNC_FORMATS) {
    const text = renderExport(snap, id);
    assert.equal(typeof text, "string", `${id} 应产出文本`);
    assert.ok(text.length > 0, `${id} 不应为空`);
    assert.ok(!text.includes(MARKER), `${id} 泄漏了私密值`);
  }
  assert.equal(JSON.stringify(snap), before);
});

test("格式版本写进导出文件自身", () => {
  const snap = fixture();
  const postman21 = JSON.parse(renderExport(snap, "postman-v21"));
  const postman20 = JSON.parse(renderExport(snap, "postman-v20"));
  assert.match(postman21.info.schema, /v2\.1\.0/);
  assert.match(postman20.info.schema, /v2\.0\.0/);
  assert.equal(postman21.info["x-reqora-export"].version, "v2.1");

  const env = JSON.parse(renderExport(snap, "postman-env"));
  assert.equal(env._postman_variable_scope, "environment");
  assert.ok(env.values.some((item) => item.type === "secret"));

  const oa303 = JSON.parse(renderExport(snap, "openapi-303-json"));
  const oa310 = JSON.parse(renderExport(snap, "openapi-310-json"));
  assert.equal(oa303.openapi, "3.0.3");
  assert.equal(oa310.openapi, "3.1.0");
  assert.match(oa310.jsonSchemaDialect, /json-schema\.org/);
  assert.equal(oa303.info["x-reqora-export"].version, "3.0.3");

  const oaYaml = renderExport(snap, "openapi-303-yaml");
  assert.match(oaYaml, /^openapi: "3\.0\.3"/m);
  assert.match(renderExport(snap, "openapi-310-yaml"), /^openapi: "3\.1\.0"/m);

  const swagger = JSON.parse(renderExport(snap, "swagger-20-json"));
  assert.equal(swagger.swagger, "2.0");
  assert.ok(swagger.paths["/v1/login"]);
  assert.match(renderExport(snap, "swagger-20-yaml"), /^swagger: "2\.0"/m);

  const insomnia4 = JSON.parse(renderExport(snap, "insomnia-v4"));
  const insomnia5 = JSON.parse(renderExport(snap, "insomnia-v5"));
  assert.equal(insomnia4.__export_format, 4);
  assert.match(insomnia5.type, /collection\.insomnia\.rest\/5/);

  const har = JSON.parse(renderExport(snap, "har-12"));
  assert.equal(har.log.version, "1.2");
  assert.ok(har.log.entries.length >= 2);

  const curl = renderExport(snap, "curl");
  assert.match(curl, /curl -X POST/);
  assert.match(curl, /\{\{token\}\}/);
  assert.ok(!curl.includes(MARKER));
});

test("导出结果可被 detectFormat 正确识别", () => {
  const snap = fixture();
  const expected = {
    "postman-v21": "postman",
    "postman-v20": "postman",
    "postman-env": "postman-env",
    "openapi-303-json": "openapi",
    "openapi-303-yaml": "openapi",
    "openapi-310-json": "openapi",
    "openapi-310-yaml": "openapi",
    "swagger-20-json": "openapi",
    "swagger-20-yaml": "openapi",
    "insomnia-v4": "insomnia",
    "insomnia-v5": "insomnia",
    "har-12": "har",
  };
  for (const [id, format] of Object.entries(expected)) {
    assert.equal(detectFormat(renderExport(snap, id)), format, `${id} 格式检测失败`);
  }
});

test("集合格式可回导：Postman / 环境 / OpenAPI / Swagger / Insomnia / HAR / cURL", () => {
  const snap = fixture();
  const postman = importPostman(renderExport(snap, "postman-v21"));
  assert.equal(postman.collections[0].items.length, 2);
  assert.ok(postman.collections[0].items.some((item) => item.folder === "用户/详情"));
  assert.equal(importPostman(renderExport(snap, "postman-v20")).collections[0].items.length, 2);

  const env = importPostmanEnvironment(renderExport(snap, "postman-env"));
  assert.ok(env.environments[0].variables.length >= 1);

  for (const id of ["openapi-303-json", "openapi-303-yaml", "openapi-310-json", "openapi-310-yaml"]) {
    const result = importOpenApi(renderExport(snap, id));
    assert.ok(result.collections[0].items.length >= 2, `${id} 回导接口数不足`);
  }
  const swagger = importOpenApi(renderExport(snap, "swagger-20-json"));
  assert.ok(swagger.collections[0].items.length >= 2);

  for (const id of ["insomnia-v4", "insomnia-v5"]) {
    const result = importInsomnia(renderExport(snap, id));
    assert.equal(result.collections[0].items.length, 2, `${id} 回导接口数不对`);
  }

  const har = importHar(renderExport(snap, "har-12"));
  assert.equal(har.collections[0].items.length, 2);

  const curl = importCurl(renderExport(snap, "curl"));
  assert.ok(curl.collections[0].items.length >= 1);
});

test("Postman 导出保留文件夹、变量、脚本注释与鉴权占位符", () => {
  const snap = fixture();
  const text = renderExport(snap, "postman-v21");
  const doc = JSON.parse(text);
  assert.equal(doc.info.name, "用户服务");
  assert.ok(Array.isArray(doc.variable));
  assert.ok(doc.variable.some((item) => item.key === "baseUrl"));
  assert.ok(text.includes("pm.test 等价断言"));
  assert.ok(text.includes("{{token}}"));
  const folder = doc.item.find((item) => item.name === "用户");
  assert.ok(folder);
  assert.ok(folder.item.some((item) => item.name === "登录"));
  assert.ok(folder.item.some((item) => item.name === "详情"));
  assert.ok(folder.item.some((item) => item.name === "空文件夹"));
});

test("自由文本里的凭据形态也在最终出口被清洗", () => {
  const snap = fixture();
  const marker = "DEMOVALUE0001";
  snap.collections[0].items[0].headers.push(row("h3", "Authorization", `Bearer ${marker}`));
  snap.collections[0].items[0].doc.description = `调用示例：Bearer ${marker}`;
  for (const id of ["postman-v21", "openapi-303-json", "har-12", "curl", "markdown", "docsite"]) {
    const text = renderExport(snap, id);
    assert.ok(!text.includes(marker), `${id} 泄漏了自由文本凭据`);
  }
});

test("只暴露统一渲染入口，格式渲染器不对外泄漏", async () => {
  const module = await import("../src/lib/exportFormats.ts");
  assert.equal(typeof module.renderExport, "function");
  assert.equal(typeof module.renderExportAsync, "function");
  for (const key of Object.keys(module)) {
    assert.ok(
      !/^render(Postman|OpenApi|Swagger|Insomnia|Har|Curl)/.test(key),
      `${key} 不应导出，否则可绕过脱敏闸门`,
    );
  }
});

test("加密文档站走异步入口且同样经过脱敏出口", async () => {
  const snap = fixture();
  assert.throws(() => renderExport(snap, "docsite-encrypted"), /renderExportAsync/);
  const html = await renderExportAsync(snap, "docsite-encrypted", { password: "pass-1234" });
  assert.ok(html.length > 0);
  assert.ok(!html.includes(MARKER));
  assert.ok((await renderExportAsync(snap, "markdown")).includes("登录接口"));
});
