/**
 * T2.1 · reqora.test.v1 测试资产导出器与往返 importer。
 *
 * 覆盖：往返关键字段一致 / 导出文本不含明文私密值 / {{token}} 占位符不被二次破坏
 * / 两次导出字节一致 / 无时间戳 / detectFormat + previewImport 只读预览。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { renderExport } from "../src/lib/exportFormats.ts";
import { detectFormat, importTestAssets, previewImport } from "../src/lib/transfer.ts";

const SECRET_A = "sk-live-canaryA1b2c3d4e5f6g7h8";
const SECRET_B = "ghp_canaryB9z8y7x6w5v4u3t2s1r0q";

function row(id, key, value, extra = {}) {
  return { id, key, value, enabled: true, ...extra };
}

function request(id, name, overrides = {}) {
  return {
    id,
    name,
    method: "POST",
    url: "{{baseUrl}}/v1/orders",
    folder: "用户/详情",
    headers: [
      row(`${id}-h1`, "Content-Type", "application/json"),
      row(`${id}-h2`, "Authorization", `Bearer ${SECRET_A}`, { secret: true }),
    ],
    query: [row(`${id}-q1`, "page", "1")],
    body: { type: "json", content: '{"sku":"A","password":"{{password}}"}' },
    auth: { type: "bearer", token: SECRET_A },
    // 脚本 / 断言里嵌凭据，必须被两道脱敏闸门清掉；{{token}} 必须原样保留。
    preScript: `setHeader('X-Trace', '{{token}}');\nconst leak = '${SECRET_B}';\npm.environment.set('k', '{{apiKey}}');`,
    postScript: "pm.test('ok', function () { bru.setVar('page', '1'); });",
    assertions: [
      { id: `${id}-a1`, enabled: true, name: "状态码", source: "status", path: "", op: "eq", value: "200" },
      { id: `${id}-a2`, enabled: true, name: "正则匹配", source: "json", path: "$.id", op: "matches", value: "^[0-9]+$" },
      { id: `${id}-a3`, enabled: true, name: "凭据断言", source: "text", path: "", op: "contains", value: SECRET_B },
    ],
    doc: {
      summary: "下单", description: "下单接口", owner: "me", status: "开发中",
      tags: [], paramMeta: {},
      responses: [{
        id: `${id}-re1`, name: "成功", status: 200, contentType: "application/json",
        body: `{"ok":true,"token":"${SECRET_B}"}`, description: "OK", params: [],
      }],
      updatedAt: 1,
    },
    ...overrides,
  };
}

function fixture() {
  return {
    version: 1,
    seeded: false,
    collections: [{
      id: "col1", name: "订单服务", folders: ["用户/空目录"],
      items: [request("r1", "创建订单"), request("r2", "查询订单", { method: "GET", folder: "用户" })],
    }],
    environments: [{
      id: "env1", name: "本地",
      variables: [
        row("v1", "baseUrl", "https://api.example.com"),
        row("v2", "token", SECRET_A, { secret: true }),
        row("v3", "apiKey", SECRET_A, { secret: true }),
      ],
    }],
    activeEnvironmentId: "env1",
    history: [],
    trash: [],
    cases: [
      {
        id: "case1", requestId: "r1", name: "正向用例", group: "正向",
        description: "正常下单", enabled: true, expectedStatus: 200,
        request: request("r1", "创建订单"),
      },
      {
        id: "case2", requestId: "r2", name: "负向用例", group: "负向",
        enabled: true, expectedStatus: 400,
        request: request("r2", "查询订单", { method: "GET" }),
      },
      {
        id: "case3", requestId: "r1", name: "边界值用例", group: "边界值",
        enabled: false,
        request: request("r1", "创建订单", { body: { type: "none" } }),
      },
    ],
    scenarios: [
      {
        id: "sc1", name: "下单链路", description: "条件/循环/等待/提取",
        steps: [
          {
            id: "s1", name: "下单", enabled: true,
            source: { kind: "case", caseId: "case1" },
            extracts: [
              { id: "x1", varName: "orderId", source: "json", path: "$.id" },
              { id: "x2", varName: "statusCode", source: "status", path: "" },
            ],
            continueOnFailure: false,
            repeat: { count: 3, itemVar: "item", indexVar: "i" },
            condition: { varName: "ok", op: "eq", value: "1" },
          },
          {
            id: "s2", name: "等待", enabled: true,
            source: { kind: "wait", ms: 250 }, extracts: [], continueOnFailure: true,
          },
          {
            id: "s3", name: "内联请求", enabled: true,
            source: { kind: "inline", request: request("r3", "内联查询", { method: "GET" }) },
            extracts: [], continueOnFailure: false,
            condition: { varName: "retry", op: "gte", value: "2" },
          },
          {
            id: "s4", name: "DB 校验", enabled: true,
            source: {
              kind: "db",
              db: {
                url: "mysql://user:password@127.0.0.1:3306/db", connectionId: "dbc1",
                sql: "select count(*) as c from orders", mode: "query", maxRows: 10,
                extracts: [{ id: "dx1", varName: "cnt", column: "c", row: 0 }],
                asserts: [{ id: "da1", target: "rows", row: 0, column: "c", op: "gt", value: "0" }],
              },
            },
            extracts: [], continueOnFailure: true,
          },
        ],
      },
      {
        id: "sc2", name: "数据驱动", description: "CSV 多轮",
        steps: [{
          id: "t1", name: "按行下单", enabled: true,
          source: { kind: "case", caseId: "case2" }, extracts: [], continueOnFailure: false,
        }],
        dataSet: {
          columns: ["sku", "qty", "region"],
          rows: [{ sku: "A", qty: "1", region: "CN" }, { sku: "B", qty: "2", region: "US" }],
        },
      },
    ],
    suites: [{
      id: "su1", name: "回归套件", description: "用例 + 场景",
      items: [
        { id: "i1", kind: "case", refId: "case1" },
        { id: "i2", kind: "scenario", refId: "sc1" },
      ],
    }],
    scriptLibrary: [{
      id: "sl1", name: "公共鉴权片段", description: "复用",
      code: "pm.environment.set('t', '{{token}}');\nconst leak = '" + SECRET_B + "';",
    }],
    settings: {
      timeoutSecs: 30, followRedirects: true, verifyTls: true,
      globalPreScript: "setHeader('X-Global', '{{token}}');",
      globalPostScript: "log('done');",
    },
  };
}

test("导出含 schema/版本元数据、无时间戳与运行历史字段", () => {
  const text = renderExport(fixture(), "test-assets-v1");
  assert.match(text, /^schema: "reqora\.test\.v1"/m);
  assert.match(text, /^version: 1$/m);
  assert.match(text, /^generated_from: "Reqora"$/m);
  for (const unstable of ["generatedAt", "generated_at", "createdAt", "updatedAt", "syncedAt", "lastRun"]) {
    assert.ok(!text.includes(unstable), `不应出现不稳定字段 ${unstable}`);
  }
  assert.ok(!/\b20\d\d-\d\d-\d\d/.test(text), "不应出现日期时间戳");
});

test("导出文本不含任何明文私密值，{{token}} 等占位符不被二次破坏", () => {
  const snap = fixture();
  const text = renderExport(snap, "test-assets-v1");
  assert.ok(!text.includes(SECRET_A), "结构化凭据泄漏");
  assert.ok(!text.includes(SECRET_B), "脚本 / 断言 / Mock 模板里的自由文本凭据泄漏");
  // 原始脚本里的 {{token}} 占位符经两道 redactFreeText 仍完整保留。
  assert.ok(text.includes("setHeader('X-Trace', '{{token}}');"), "{{token}} 被破坏");
  assert.ok(text.includes("{{password}}"), "{{password}} 被破坏");
  assert.ok(text.includes("{{apiKey}}"), "{{apiKey}} 被破坏");
  assert.ok((text.match(/\{\{token\}\}/g) ?? []).length >= 3, "占位符数量异常");
  // 凭据被清洗成占位符，而不是被删成空串后重新暴露。
  assert.ok(text.includes("<redacted"), "自由文本凭据应被打码标记覆盖");
});

test("两次导出字节一致，且不改动原始快照", () => {
  const snap = fixture();
  const before = JSON.stringify(snap);
  const a = renderExport(snap, "test-assets-v1");
  const b = renderExport(snap, "test-assets-v1");
  assert.equal(a, b, "两次导出应字节一致");
  assert.equal(JSON.stringify(snap), before, "导出不得修改工作区快照");
});

test("detectFormat 识别 test-assets，previewImport 给出只读预览", () => {
  const text = renderExport(fixture(), "test-assets-v1");
  assert.equal(detectFormat(text), "test-assets");
  const preview = previewImport(text);
  assert.equal(preview.format, "test-assets");
  assert.equal(preview.error, null);
  assert.ok(preview.collectionNames.includes("测试资产用例"));
  assert.equal(preview.requestCount, 3);
  assert.ok(preview.variableNames.includes("token"));
  assert.ok(preview.variableNames.includes("baseUrl"));
  assert.ok(preview.warnings.some((line) => line.includes("用例 3")));
});

test("导出 → 导入 → 关键字段集合一致", () => {
  const snap = fixture();
  const before = JSON.stringify(snap);
  const text = renderExport(snap, "test-assets-v1");
  const result = importTestAssets(text);
  assert.equal(result.warnings.length > 0, true);
  const doc = result.testAssets;
  assert.ok(doc, "应带 testAssets 载荷");
  assert.equal(doc.schema, "reqora.test.v1");
  assert.equal(doc.version, 1);
  assert.equal(doc.generated_from, "Reqora");

  assert.deepEqual(
    doc.cases.map((item) => [item.id, item.name, item.group, item.enabled, item.expectedStatus]),
    [
      ["case1", "正向用例", "正向", true, 200],
      ["case2", "负向用例", "负向", true, 400],
      ["case3", "边界值用例", "边界值", false, undefined],
    ],
  );
  // 用例里的断言（双轨断言的声明式一侧）与脚本源码保真。
  assert.deepEqual(
    doc.cases[0].request.assertions.map((a) => [a.id, a.source, a.op]),
    [
      ["r1-a1", "status", "eq"],
      ["r1-a2", "json", "matches"],
      ["r1-a3", "text", "contains"],
    ],
  );
  assert.ok(doc.cases[0].request.preScript.includes("{{token}}"), "脚本占位符往返丢失");
  assert.ok(!doc.cases[0].request.preScript.includes(SECRET_B), "脚本凭据往返泄漏");
  // 扁平索引 = 3 条用例各 3 条断言 + 场景内联步骤的 3 条断言。
  assert.equal(doc.assertionRules.length, 12, "断言规则扁平索引应含用例与内联步骤断言");

  // 场景：步骤 / 条件门 / 循环 / wait / 失败策略 / 变量提取 / DB 步骤。
  assert.deepEqual(doc.scenarios.map((s) => s.id), ["sc1", "sc2"]);
  assert.deepEqual(doc.scenarios[0].steps.map((s) => [s.id, s.source.kind, s.continueOnFailure]), [
    ["s1", "case", false], ["s2", "wait", true], ["s3", "inline", false], ["s4", "db", true],
  ]);
  assert.deepEqual(doc.scenarios[0].steps[0].repeat, { count: 3, itemVar: "item", indexVar: "i" });
  assert.equal(doc.scenarios[0].steps[0].condition.op, "eq");
  assert.equal(doc.scenarios[0].steps[0].condition.value, "1");
  assert.deepEqual(
    doc.scenarios[0].steps[0].extracts.map((e) => [e.varName, e.source, e.path]),
    [["orderId", "json", "$.id"], ["statusCode", "status", ""]],
  );
  assert.equal(doc.scenarios[0].steps[1].source.ms, 250);
  assert.equal(doc.scenarios[0].steps[2].condition.op, "gte");
  assert.equal(doc.scenarios[0].steps[3].source.db.sql, "select count(*) as c from orders");
  assert.equal(doc.scenarios[0].steps[3].source.db.connectionId, "dbc1");
  assert.ok(!("url" in doc.scenarios[0].steps[3].source.db), "DB 直连 URL 应明确省略");

  // 套件 / CSV 数据集 / Mock 规则 / 变量名清单。
  assert.deepEqual(doc.suites[0].items.map((i) => [i.kind, i.refId]), [
    ["case", "case1"], ["scenario", "sc1"],
  ]);
  assert.deepEqual(doc.csvDataSets.map((d) => d.scenarioId), ["sc2"]);
  assert.deepEqual(doc.csvDataSets[0].dataSet.columns, ["sku", "qty", "region"]);
  assert.equal(doc.csvDataSets[0].dataSet.rows.length, 2);
  assert.deepEqual(doc.csvDataSets[0].dataSet.rows[0], { sku: "A", qty: "1", region: "CN" });
  assert.deepEqual(doc.csvDataSets[0].dataSet.rows[1], { sku: "B", qty: "2", region: "US" });
  assert.equal(doc.mockRules.length, 2, "每个 method+path 一条 Mock 规则");
  assert.deepEqual(doc.mockRules.map((r) => [r.method, r.path]), [
    ["POST", "/v1/orders"], ["GET", "/v1/orders"],
  ]);
  assert.ok(!JSON.stringify(doc.mockRules).includes(SECRET_B), "Mock 模板往返泄漏");
  assert.deepEqual(doc.privateVariableNames, ["apiKey", "token"]);
  assert.deepEqual(doc.environmentVariableNames, ["apiKey", "baseUrl", "token"]);
  assert.deepEqual(doc.scriptLibrary.map((s) => s.id), ["sl1"]);
  assert.equal(doc.globalPreScript, "setHeader('X-Global', '{{token}}');");
  assert.equal(JSON.stringify(snap), before, "导入/导出不得修改工作区快照");
});
