/**
 * 重复导入的接口识别与覆盖合并。
 *
 * 所有已支持的导入格式（Postman / Postman 环境 / OpenAPI / HAR / cURL /
 * Insomnia）最终都走 placeImportedCollections，因此这里的「全格式」用例
 * 直接用真实解析器产出，再模拟两轮导入到同一个目标集合。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalRequestUrl,
  mergeImportedEnvironments,
  mergeImportedRequest,
  mergeImportedRequests,
  placeImportedCollections,
  requestIdentityKey,
} from "../src/lib/importTarget.ts";
import {
  importCurl,
  importHar,
  importInsomnia,
  importOpenApi,
  importPostman,
  importPostmanEnvironment,
} from "../src/lib/transfer.ts";

// --------------------------------------------------------------- helpers ----

let seq = 0;
const ids = () => `id-${++seq}`;
const row = (id, key, value, enabled = true) => ({ id, key, value, enabled });

function req(id, url, extra = {}) {
  return {
    id,
    name: id,
    method: "GET",
    url,
    folder: "",
    protocol: "http",
    headers: [],
    query: [],
    body: { type: "none" },
    auth: { type: "none" },
    ...extra,
  };
}

/** 模拟 store.importContent 中的解析 → 归一化 → 放置链路。 */
function importOnce(existing, content, parse, target = { collectionId: "c1" }) {
  const result = parse(content);
  const incoming = result.collections.map((raw) => ({
    id: ids(),
    name: raw.name,
    items: raw.items,
  }));
  return { placement: placeImportedCollections(existing, incoming, target, ids), result };
}

// ----------------------------------------------------------- URL identity ----

test("canonicalRequestUrl：query / fragment 不计入身份，模板内的 ? # 不误切", () => {
  assert.equal(
    canonicalRequestUrl("https://api.example.com/users/{id}?page=2#top"),
    "https://api.example.com/users/{id}",
  );
  assert.equal(
    canonicalRequestUrl("{{baseUrl}}/users?id={{ _.query }}#x"),
    "{{baseUrl}}/users",
  );
  assert.equal(
    canonicalRequestUrl("https://api.test/echo?ts={% now 'millis' %}"),
    "https://api.test/echo",
  );
});

test("canonicalRequestUrl：scheme/host 大小写归一化，path 大小写敏感", () => {
  assert.equal(
    canonicalRequestUrl("HTTPS://API.Example.COM/Users"),
    "https://api.example.com/Users",
  );
  assert.notEqual(
    canonicalRequestUrl("https://api.test/Users"),
    canonicalRequestUrl("https://api.test/users"),
  );
  // 模板化的 host 不改写，避免把 {{Host}} 与 {{host}} 两个变量混为同一个。
  assert.equal(canonicalRequestUrl("https://{{Host}}/x"), "https://{{Host}}/x");
  // 端口 / IPv6 / userinfo 不会被当成路径变量。
  assert.equal(canonicalRequestUrl("http://localhost:8080/x"), "http://localhost:8080/x");
  assert.equal(canonicalRequestUrl("https://User@API.test/x"), "https://User@api.test/x");
});

test("canonicalRequestUrl：路径变量计入 URL，:id 与 {id} 归一，变量名不同仍区分", () => {
  assert.equal(
    canonicalRequestUrl("https://api.test/users/:id"),
    canonicalRequestUrl("https://api.test/users/{id}"),
  );
  assert.notEqual(
    canonicalRequestUrl("https://api.test/users/:id"),
    canonicalRequestUrl("https://api.test/users/:userId"),
  );
  assert.notEqual(
    canonicalRequestUrl("https://api.test/users/:id"),
    canonicalRequestUrl("https://api.test/users"),
  );
  // {{变量}} 原样保留，身份与环境取值无关。
  assert.equal(canonicalRequestUrl("{{baseUrl}}/users/:id"), "{{baseUrl}}/users/{id}");
});

test("requestIdentityKey：文件夹 / 协议 / 方法共同限定作用域，空 URL 不参与匹配", () => {
  const base = { method: "GET", url: "https://api.test/users/:id", folder: "", protocol: "http" };
  assert.equal(requestIdentityKey(base), requestIdentityKey({ ...base, method: "get" }));
  assert.equal(
    requestIdentityKey({ ...base, folder: " a / b " }),
    requestIdentityKey({ ...base, folder: "a/b" }),
    "文件夹路径按 normalizeFolderPath 归一化",
  );
  assert.notEqual(requestIdentityKey(base), requestIdentityKey({ ...base, folder: "a/b" }));
  assert.notEqual(requestIdentityKey(base), requestIdentityKey({ ...base, method: "POST" }));
  assert.notEqual(requestIdentityKey(base), requestIdentityKey({ ...base, protocol: "ws" }));
  assert.equal(requestIdentityKey({ ...base, url: "  " }), null);
});

// ------------------------------------------------------ overwrite semantics ----

test("mergeImportedRequest：导入源覆盖定义，本地身份与本地独有数据保留", () => {
  const existing = req("keep-id", "https://api.test/users", {
    name: "旧名字",
    headers: [row("h-old", "X-Version", "1")],
    query: [row("q-old", "page", "1")],
    body: { type: "json", content: '{"old":true}' },
    preScript: "setVar('a', 1)",
    postScript: "test('ok', () => true)",
    assertions: [{ id: "a1", name: "状态 200" }],
    pathVariables: [row("p1", "id", "42")],
    stream: "on",
    doc: {
      summary: "旧摘要",
      description: "旧说明",
      owner: "alice",
      status: "已发布",
      tags: ["本地标签"],
      paramMeta: { "q:q-old": { description: "页码（本地写的）" } },
      responses: [{ id: "r1", name: "成功示例" }],
      updatedAt: 123,
    },
    updatedAt: 111,
    contentUpdatedAt: 222,
  });
  const incoming = req("drop-id", "https://api.test/users", {
    name: "新名字",
    headers: [row("h-new", "X-Version", "2")],
    query: [row("q-new", "page", "9")],
    body: { type: "json", content: '{"new":true}' },
    doc: {
      summary: "新摘要",
      description: "新说明",
      owner: "",
      status: "开发中",
      tags: [],
      paramMeta: { "q:q-new": { description: "页码（来自 OpenAPI）" } },
      responses: [],
      updatedAt: 0,
    },
    updatedAt: 0,
  });
  const merged = mergeImportedRequest(existing, incoming);

  // 导入源拥有的字段
  assert.equal(merged.name, "新名字");
  assert.deepEqual(merged.body, { type: "json", content: '{"new":true}' });
  assert.equal(merged.headers[0].value, "2");
  assert.equal(merged.query[0].value, "9");
  assert.equal(merged.doc.summary, "新摘要");
  assert.equal(merged.doc.description, "新说明");
  assert.equal(merged.doc.paramMeta["q:q-old"].description, "页码（来自 OpenAPI）",
    "导入参数说明已按复用后的行 id 重映射并覆盖同名项");
  assert.equal(merged.doc.paramMeta["q:q-new"], undefined, "不残留指向新行 id 的孤立键");

  // 本地身份与本地工作
  assert.equal(merged.id, "keep-id");
  assert.equal(merged.headers[0].id, "h-old", "沿用旧行 id，文档说明与内容指纹都不失效");
  assert.equal(merged.query[0].id, "q-old");
  assert.equal(merged.preScript, "setVar('a', 1)");
  assert.equal(merged.postScript, "test('ok', () => true)");
  assert.equal(merged.assertions.length, 1);
  assert.equal(merged.pathVariables[0].value, "42");
  assert.equal(merged.stream, "on");
  assert.equal(merged.doc.owner, "alice");
  assert.equal(merged.doc.status, "已发布");
  assert.deepEqual(merged.doc.tags, ["本地标签"]);
  assert.equal(merged.doc.responses[0].name, "成功示例");
  assert.equal(merged.updatedAt, 111);
  assert.equal(merged.contentUpdatedAt, 222);
});

test("mergeImportedRequests：同文件夹同方法+URL 覆盖，作用域变化则不覆盖", () => {
  const existing = [req("a", "https://api.test/users/:id", { folder: "用户" })];
  const first = mergeImportedRequests(existing, [
    req("i1", "https://api.test/users/{id}", { folder: "用户", name: "更新后的名字" }),
  ]);
  assert.equal(first.items.length, 1);
  assert.equal(first.overwritten, 1);
  assert.equal(first.added, 0);
  assert.equal(first.items[0].id, "a");
  assert.equal(first.items[0].name, "更新后的名字");

  const cases = [
    { label: "不同文件夹", extra: { folder: "订单" } },
    { label: "不同方法", extra: { method: "POST" } },
    { label: "不同协议", extra: { protocol: "ws" } },
    { label: "不同路径变量名", extra: { url: "https://api.test/users/:userId" } },
  ];
  for (const item of cases) {
    const placed = mergeImportedRequests(
      [req("a", "https://api.test/users/:id", { folder: "用户" })],
      [req("i1", "https://api.test/users/:id", { folder: "用户", ...item.extra })],
    );
    assert.equal(placed.items.length, 2, item.label);
    assert.equal(placed.overwritten, 0, item.label);
    assert.equal(placed.added, 1, item.label);
  }
});

test("mergeImportedRequests：用户手写 query 能与导入器拆表的 query 命中同一接口", () => {
  const existing = [req("a", "https://api.test/users?page=2&size=10")];
  const merged = mergeImportedRequests(existing, [
    req("i1", "https://api.test/users", { query: [row("q1", "page", "1")] }),
  ]);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.overwritten, 1);
});

test("mergeImportedRequests：同批重复项不互相吞掉，反复导入收敛到稳定条目", () => {
  const batch = () => [
    req("b1", "https://api.test/users", { name: "抓包 1" }),
    req("b2", "https://api.test/users", { name: "抓包 2" }),
    req("b3", "https://api.test/users", { name: "抓包 3" }),
  ];
  const first = mergeImportedRequests([], batch());
  assert.equal(first.items.length, 3);
  assert.equal(first.added, 3);
  assert.equal(first.duplicateIncoming, 2);
  const second = mergeImportedRequests(first.items, batch());
  assert.equal(second.items.length, 3, "第二轮不再增长");
  assert.equal(second.overwritten, 3);
  assert.equal(second.added, 0);
  assert.deepEqual(second.items.map((item) => item.id), ["b1", "b2", "b3"], "身份稳定");
  assert.deepEqual(second.items.map((item) => item.name), ["抓包 1", "抓包 2", "抓包 3"]);
});

test("mergeImportedRequests：空 URL 的残缺请求一律新增，不误覆盖", () => {
  const merged = mergeImportedRequests([req("a", "")], [req("i1", "")]);
  assert.equal(merged.items.length, 2);
  assert.equal(merged.overwritten, 0);
});

// ------------------------------------------------------------ environments ----

test("mergeImportedEnvironments：同名合并、保留本地已填值、只补新变量", () => {
  const existing = [{
    id: "env-1",
    name: "Demo 变量",
    variables: [row("v1", "token", "local-secret"), row("v2", "baseUrl", "https://local.test")],
    headers: [row("h1", "X-Env", "local")],
  }];
  const incoming = [{
    name: "Demo 变量",
    variables: [row("new1", "token", ""), row("new2", "page", "1")],
  }];
  const first = mergeImportedEnvironments(existing, incoming, ids);
  assert.equal(first.environments.length, 1);
  assert.equal(first.merged, 1);
  assert.equal(first.added, 0);
  assert.equal(first.environments[0].id, "env-1");
  assert.equal(first.environments[0].variables[0].id, "v1");
  assert.equal(first.environments[0].variables[0].value, "local-secret", "本地 token 不被空默认值冲掉");
  assert.equal(first.environments[0].variables[2].key, "page");
  assert.equal(first.environments[0].headers[0].value, "local");

  const second = mergeImportedEnvironments(first.environments, incoming, ids);
  assert.equal(second.environments.length, 1, "重复导入不追加同名环境");
  assert.equal(second.environments[0].variables.length, 3, "反复导入收敛");
  assert.equal(second.merged, 1);

  const other = mergeImportedEnvironments(first.environments, [{ name: "另一份环境", variables: [] }], ids);
  assert.equal(other.environments.length, 2);
  assert.equal(other.added, 1);
  assert.ok(other.environments[1].id, "新环境分配了 id");
});

// -------------------------------------------------- all supported formats ----

const POSTMAN = JSON.stringify({
  info: { name: "Demo", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  item: [{ name: "用户", request: { method: "GET", url: "https://api.test/users/:id" } }],
});
const POSTMAN_ENV = JSON.stringify({ name: "Demo 环境", values: [{ key: "token", value: "t-1" }] });
const OPENAPI = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Demo", version: "1" },
  paths: { "/users/{id}": { get: { responses: { 200: { description: "ok" } } } } },
});
const HAR = JSON.stringify({
  log: {
    version: "1.2",
    creator: { name: "test", version: "1" },
    entries: [{ request: { method: "GET", url: "https://api.test/users/1", headers: [], queryString: [], cookies: [] } }],
  },
});
const CURL = "curl https://api.test/users/1";
const INSOMNIA = JSON.stringify({
  _type: "export",
  __export_format: 4,
  resources: [
    { _id: "wrk", _type: "workspace", name: "Demo", parentId: null },
    { _id: "rq", _type: "request", parentId: "wrk", name: "用户", method: "GET", url: "https://api.test/users/1" },
  ],
});

const FORMATS = [
  ["Postman", POSTMAN, importPostman],
  ["OpenAPI", OPENAPI, importOpenApi],
  ["HAR", HAR, importHar],
  ["cURL", CURL, importCurl],
  ["Insomnia", INSOMNIA, importInsomnia],
];

test("全部导入格式：两轮导入同一份文件只保留一个接口，第二轮覆盖", () => {
  for (const [label, content, parse] of FORMATS) {
    const empty = [{ id: "c1", name: "已有集合", items: [] }];
    const first = importOnce(empty, content, parse, { collectionId: "c1", folderMode: "root" });
    assert.equal(first.placement.collections[0].items.length, 1, `${label} 首轮应新增 1 个接口`);
    assert.equal(first.placement.addedRequests, 1, label);
    assert.equal(first.placement.overwrittenRequests, 0, label);

    const second = importOnce(first.placement.collections, content, parse, {
      collectionId: "c1",
      folderMode: "root",
    });
    assert.equal(second.placement.collections[0].items.length, 1, `${label} 第二轮不应产生重复接口`);
    assert.equal(second.placement.overwrittenRequests, 1, `${label} 第二轮应覆盖`);
    assert.equal(second.placement.addedRequests, 0, label);
    assert.equal(
      second.placement.collections[0].items[0].id,
      first.placement.collections[0].items[0].id,
      `${label} 覆盖后保持原 id，用例 / 历史引用不失效`,
    );
  }
});

test("跨格式收敛：OpenAPI 的 {id} 与 Postman 的 :id 视为同一接口", () => {
  // 两边的 baseUrl 都写成同一个模板变量，才谈得上「同一个接口」。
  const openapi = JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Demo", version: "1" },
    servers: [{ url: "https://api.test" }],
    paths: { "/users/{id}": { get: { responses: { 200: { description: "ok" } } } } },
  });
  const postman = JSON.stringify({
    info: { name: "Demo", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    item: [{ name: "用户", request: { method: "GET", url: "{{baseUrl}}/users/:id" } }],
  });
  const empty = [{ id: "c1", name: "已有集合", items: [] }];
  const first = importOnce(empty, openapi, importOpenApi, { collectionId: "c1", folderMode: "root" });
  assert.equal(first.placement.collections[0].items[0].url, "{{baseUrl}}/users/{id}");
  const second = importOnce(first.placement.collections, postman, importPostman, {
    collectionId: "c1",
    folderMode: "root",
  });
  assert.equal(second.placement.collections[0].items.length, 1);
  assert.equal(second.placement.overwrittenRequests, 1);
});

test("Postman 环境文件：两轮导入只保留一份环境，本地值不被覆盖", () => {
  const parse = (content) => importPostmanEnvironment(content);
  const first = mergeImportedEnvironments([], parse(POSTMAN_ENV).environments, ids);
  first.environments[0].variables[0].value = "用户后来填的 token";
  const second = mergeImportedEnvironments(first.environments, parse(POSTMAN_ENV).environments, ids);
  assert.equal(second.environments.length, 1);
  assert.equal(second.merged, 1);
  assert.equal(second.environments[0].variables[0].value, "用户后来填的 token");
  // 环境文件不产生接口，放置链路保持 no-op。
  const empty = [{ id: "c1", name: "已有集合", items: [] }];
  const placed = importOnce(empty, POSTMAN_ENV, parse, { collectionId: "c1" });
  assert.equal(placed.placement.importedRequests, 0);
  assert.equal(placed.placement.collections, empty);
});

test("目标为新建集合时不触碰其它集合的已有接口", () => {
  const existing = [
    { id: "c1", name: "已有集合", items: [req("a", "https://api.test/users")] },
  ];
  const placed = importOnce(existing, CURL, importCurl, { collectionId: null });
  assert.equal(placed.placement.createdCollections, 1);
  assert.equal(placed.placement.overwrittenRequests, 0);
  assert.equal(placed.placement.collections[0].items.length, 1);
  assert.equal(placed.placement.collections[1].items.length, 1);
});
