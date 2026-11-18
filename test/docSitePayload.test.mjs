import test from "node:test";
import assert from "node:assert/strict";
import { seedSnapshot, normalizeSnapshot, emptySnapshot } from "../src/lib/defaults.ts";
import { exportDocSiteHtml } from "../src/lib/docsite.ts";
import {
  buildDocSitePayload,
  normalizeDocSitePayload,
  publicVariables,
  resolveRequestUrl,
} from "../src/lib/docSitePayload.ts";

test("publicVariables：token / 口令 / API Key / Cookie 类变量不参与公开替换", () => {
  assert.deepEqual(
    publicVariables({
      baseUrl: "https://api.example.com",
      authToken: "s",
      apiKey: "k",
      api_key: "k2",
      client_secret: "s2",
      password: "p",
      Cookie: "c",
      region: "cn",
    }),
    { baseUrl: "https://api.example.com", region: "cn" },
  );
  assert.deepEqual(publicVariables(null), {});
});

test("resolveRequestUrl：变量展开 + 启用 query，敏感 query 值替换为占位符", () => {
  const request = {
    ...seedSnapshot().collections[0].items[0],
    url: "{{baseUrl}}/v1/items",
    query: [
      { id: "q1", key: "page", value: "1", enabled: true },
      { id: "q2", key: "access_token", value: "real-secret", enabled: true },
      { id: "q3", key: "disabled", value: "x", enabled: false },
    ],
  };
  const url = resolveRequestUrl(request, { baseUrl: "https://api.example.com" });
  assert.ok(url.startsWith("https://api.example.com/v1/items?page=1"));
  assert.ok(url.includes("access_token="));
  assert.ok(!url.includes("real-secret"));
  assert.ok(!url.includes("disabled"));
  assert.ok(decodeURIComponent(url).includes("<请自行填写>"));
});

test("buildDocSitePayload：禁用的 query / header / form 行不进入公开参数表", () => {
  const snapshot = seedSnapshot();
  const request = snapshot.collections[0].items[0];
  request.query = [
    { id: "q-on", key: "page", value: "1", enabled: true },
    { id: "q-off", key: "ReqoraDisabledQuery", value: "stale", enabled: false },
  ];
  request.headers = [
    { id: "h-on", key: "Accept", value: "application/json", enabled: true },
    { id: "h-off", key: "ReqoraDisabledHeader", value: "stale", enabled: false },
  ];
  request.body = {
    type: "formUrlEncoded",
    items: [
      { id: "f-on", key: "name", value: "alice", enabled: true },
      { id: "f-off", key: "ReqoraDisabledForm", value: "stale", enabled: false },
    ],
  };

  const payload = buildDocSitePayload(snapshot, { title: "禁用行" });
  const json = JSON.stringify(payload);
  for (const key of ["ReqoraDisabledQuery", "ReqoraDisabledHeader", "ReqoraDisabledForm"]) {
    assert.ok(!json.includes(key), `${key} 不应出现在对外发布的文档站`);
  }
  assert.ok(json.includes("page"));
  assert.ok(json.includes("Accept"));
  assert.ok(json.includes("name"));
});

test("buildDocSitePayload：章节 / 集合 / 接口投影，且不泄露凭据", () => {
  const snapshot = seedSnapshot();
  snapshot.environments[0].variables = [
    { id: "v1", key: "baseUrl", value: "https://api.example.com", enabled: true },
    { id: "v2", key: "authToken", value: "super-secret-value", enabled: true },
  ];
  snapshot.activeEnvironmentId = snapshot.environments[0].id;
  snapshot.collections[0].items[0].headers = [
    { id: "h1", key: "Authorization", value: "Bearer top-secret", enabled: true },
    { id: "h2", key: "X-Trace", value: "trace-ok", enabled: true },
  ];

  const payload = buildDocSitePayload(snapshot, {
    title: "测试文档",
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

  assert.equal(payload.version, 1);
  assert.equal(payload.title, "测试文档");
  assert.equal(payload.generatedAt, "2026-01-01T00:00:00.000Z");
  assert.ok(payload.chapters.length >= 4);
  assert.ok(payload.chapters.some((chapter) => chapter.errorCodes.rows.length > 0));
  assert.ok(payload.collections.length > 0);
  assert.equal(
    payload.totalRequests,
    payload.collections.reduce((sum, item) => sum + item.requests.length, 0),
  );
  assert.ok(payload.collections[0].requests[0].snippets.length > 0);

  const json = JSON.stringify(payload);
  assert.ok(json.includes("https://api.example.com"));
  assert.ok(json.includes("Authorization"), "文档仍需说明要传鉴权头");
  assert.ok(json.includes("X-Trace"));
  assert.ok(!json.includes("super-secret-value"));
  assert.ok(!json.includes("Bearer top-secret"));
  assert.ok(!json.includes("top-secret"));
});

test("normalizeDocSitePayload：往返一致、不可信输入有界且容错", () => {
  const payload = buildDocSitePayload(seedSnapshot(), { title: "往返" });
  const roundTrip = normalizeDocSitePayload(JSON.parse(JSON.stringify(payload)));
  assert.ok(roundTrip);
  assert.equal(roundTrip.title, "往返");
  assert.equal(roundTrip.chapters.length, payload.chapters.length);
  assert.equal(roundTrip.totalRequests, payload.totalRequests);
  assert.equal(roundTrip.collections[0].requests[0].method, payload.collections[0].requests[0].method);

  assert.equal(normalizeDocSitePayload(null), null);
  assert.equal(normalizeDocSitePayload({}), null);
  assert.equal(normalizeDocSitePayload({ collections: "bad" }), null);

  const huge = {
    title: "大文档",
    collections: [
      {
        id: "c",
        name: "集合",
        requests: Array.from({ length: 1200 }, (_, index) => ({
          id: String(index),
          name: "接口",
          method: "GET",
          url: "/x",
        })),
      },
    ],
    chapters: [],
  };
  assert.equal(normalizeDocSitePayload(huge).totalRequests, 1000);

  const weird = normalizeDocSitePayload({
    collections: [
      {
        requests: [
          null,
          42,
          { name: 5, tables: "x", responses: [null], snippets: null, body: "x" },
        ],
      },
    ],
    chapters: [null, { title: "A", errorCodes: { rows: [["1", "2"], "bad"] } }],
  });
  assert.equal(weird.collections[0].requests.length, 1);
  assert.deepEqual(weird.collections[0].requests[0].tables, []);
  assert.equal(weird.collections[0].requests[0].body, null);
  assert.equal(weird.chapters.length, 1);
  assert.deepEqual(weird.chapters[0].errorCodes.rows, [["1", "2"], []]);
});

test("快照归一化：旧快照补 docPages，示例快照带骨架章节", () => {
  const raw = JSON.parse(JSON.stringify(seedSnapshot()));
  delete raw.docPages;
  assert.deepEqual(normalizeSnapshot(raw).docPages, []);
  assert.deepEqual(emptySnapshot().docPages, []);
  assert.ok(seedSnapshot().docPages.length >= 4);
});

test("单文件 HTML 导出：公共章节进入目录、正文与错误码对照表", () => {
  const html = exportDocSiteHtml(seedSnapshot(), "测试文档");
  assert.ok(html.includes('href="#page-quickstart"'));
  assert.ok(html.includes('href="#page-auth"'));
  assert.ok(html.includes('id="page-errors"'));
  assert.ok(html.includes("错误码对照表"));
  assert.ok(html.includes("接口鉴权"));
});
