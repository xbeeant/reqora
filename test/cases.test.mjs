/**
 * Pure-logic tests for the case and documentation projections.
 * Node 22 strips TS types natively, so these run against production modules.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  countByGroup,
  isCaseStale,
  newCaseFromRequest,
  sortCases,
  syncCaseFromRequest,
  summarizeRun,
} from "../src/lib/cases.ts";
import {
  bodyFieldRows,
  deriveParamSections,
  generateMockBody,
  parseInline,
  parseMarkdownBlocks,
} from "../src/lib/docs.ts";
import { normalizeRequest } from "../src/lib/defaults.ts";

let seq = 0;
const uid = () => `id-${++seq}`;

function request(overrides = {}) {
  return normalizeRequest({
    id: "req-1",
    name: "登录接口",
    method: "POST",
    url: "{{baseUrl}}/login",
    updatedAt: 100,
    query: [
      { id: uid(), key: "page", value: "1", enabled: true },
      { id: uid(), key: "size", value: "20", enabled: false },
    ],
    headers: [
      { id: uid(), key: "X-Client", value: "Reqora", enabled: true },
      { id: uid(), key: "", value: "", enabled: true },
    ],
    body: { type: "json", content: '{"user":{"name":"amy","age":18,"tags":[]},"ok":true}' },
    ...overrides,
  });
}

test("newCaseFromRequest snapshots the interface and stays linked to it", () => {
  const base = request();
  const item = newCaseFromRequest(base, "空密码", "负向");
  assert.equal(item.requestId, base.id);
  assert.equal(item.group, "负向");
  assert.equal(item.request.method, base.method);
  assert.equal(item.request.body.type, "json");
  assert.equal(item.request.doc.summary, "", "case does not carry interface docs");
  assert.ok(!isCaseStale(item, base), "freshly created case is in sync");
});

test("stale hint fires only when the interface changed after the sync", () => {
  const base = request();
  const item = newCaseFromRequest(base);
  // 改名 / 移动 / 文档只刷新 updatedAt，不算接口内容变更。
  const renamed = { ...base, name: "换个名字", updatedAt: 200 };
  assert.equal(isCaseStale(item, renamed), false);
  // 真正的内容变更（如方法 / URL / 参数）会同时刷新 contentUpdatedAt。
  const changed = { ...base, url: "{{baseUrl}}/logout", updatedAt: 200, contentUpdatedAt: 200 };
  assert.equal(isCaseStale(item, changed), true);
  const synced = syncCaseFromRequest(item, changed);
  assert.equal(isCaseStale(synced, changed), false);
  assert.equal(synced.request.updatedAt, 0, "case keeps its own identity");
});

test("group counts and ordering follow the Apifox chip order", () => {
  const base = request();
  const items = [
    newCaseFromRequest(base, "a", "安全性"),
    newCaseFromRequest(base, "b", "正向"),
    newCaseFromRequest(base, "c", "边界值"),
    newCaseFromRequest(base, "d", "正向"),
  ];
  const counts = countByGroup(items);
  assert.equal(counts["正向"], 2);
  assert.equal(counts["安全性"], 1);
  assert.equal(counts["负向"], 0);
  const sorted = sortCases(items);
  assert.deepEqual(
    sorted.map((item) => item.name),
    ["b", "d", "c", "a"],
  );
});

test("summarizeRun combines status expectation, script tests and errors", () => {
  const okRun = summarizeRun(
    { status: 200, timeMs: 12, ok: true },
    { tests: [{ ok: true }, { ok: false }], error: null, preError: null },
    200,
  );
  assert.equal(okRun.ok, false, "one failed test fails the case");
  assert.deepEqual([okRun.passed, okRun.failed], [1, 1]);

  const good = summarizeRun(
    { status: 200, timeMs: 12, ok: true },
    { tests: [{ ok: true }], error: null, preError: null },
    200,
  );
  assert.equal(good.ok, true);

  const wrongStatus = summarizeRun(
    { status: 401, timeMs: 8, ok: false },
    { tests: [], error: null, preError: null },
    200,
  );
  assert.equal(wrongStatus.ok, false);
  assert.equal(wrongStatus.status, 401);

  const scriptError = summarizeRun(
    { status: 200, timeMs: 5, ok: true },
    { tests: [], error: "boom", preError: null },
    undefined,
  );
  assert.equal(scriptError.ok, false);
  assert.equal(scriptRunError(scriptError), "boom");
});

function scriptRunError(run) {
  return run.error ?? "";
}

test("param sections are derived from live rows plus doc-only metadata", () => {
  const base = request();
  const doc = {
    summary: "",
    description: "",
    owner: "",
    status: "开发中",
    tags: [],
    paramMeta: {},
    responses: [],
    updatedAt: 0,
  };
  const sections = deriveParamSections(base, doc);
  const query = sections.find((section) => section.location === "query");
  assert.deepEqual(
    query.rows.map((row) => row.name),
    ["page", "size"],
    "doc lists every named param; enabled is a request-time toggle",
  );
  assert.equal(query.rows[0].key.startsWith("q:"), true);
  assert.equal(query.rows[0].meta.example, "1", "row value seeds the example");

  const header = sections.find((section) => section.location === "header");
  assert.equal(header.rows.length, 1, "empty keys are skipped");

  const body = sections.find((section) => section.location === "body");
  assert.deepEqual(
    body.rows.map((row) => row.name),
    ["user.name", "user.age", "user.tags", "ok", "user"],
    "JSON body appends a synthetic container row so arrays/objects can carry doc metadata",
  );
  assert.equal(body.rows.find((row) => row.name === "user.age").meta.type, "number");
  const container = body.rows.find((row) => row.key === "b:user");
  assert.equal(container.meta.type, "object", "container row carries the structural type");
});

test("json body fields flatten to leaf paths with inferred types", () => {
  const rows = bodyFieldRows({ type: "json", content: '{"a":{"b":[1,"x"]},"c":null,"d":true}' });
  assert.deepEqual(
    rows.map((row) => `${row.path}:${row.type}`),
    ["a.b[0]:number", "a.b[1]:string", "c:null", "d:boolean"],
  );
  const invalid = bodyFieldRows({ type: "json", content: "{oops}" });
  assert.equal(invalid[0].path, "body");
  assert.equal(invalid[0].type, "invalid json");
});

test("markdown parser handles headings, lists, code fences and inline tokens", () => {
  const blocks = parseMarkdownBlocks("# 标题\n\n正文 **加粗** 与 `代码`。\n\n- 列表项\n\n```json\n{\"a\":1}\n```");
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["h1", "p", "li", "code"],
  );
  const inline = parseInline("前面 **加粗** 后面 `代码` 结尾");
  assert.deepEqual(
    inline.map((token) => ({ bold: !!token.bold, code: !!token.code })),
    [{ bold: false, code: false }, { bold: true, code: false }, { bold: false, code: false }, { bold: false, code: true }, { bold: false, code: false }],
  );
});

test("mock generation prefers a saved example, else synthesises from the definition", () => {
  const base = request();
  const doc = {
    summary: "",
    description: "",
    owner: "",
    status: "开发中",
    tags: [],
    paramMeta: {},
    responses: [
      {
        id: "ex-1",
        name: "成功",
        status: 200,
        contentType: "application/json",
        body: '{"ok":true,"user":{"id":7}}',
        description: "",
      },
    ],
    updatedAt: 0,
  };
  assert.equal(generateMockBody(base, doc), JSON.stringify({ ok: true, user: { id: 7 } }, null, 2));

  const withoutExample = { ...doc, responses: [] };
  const generated = JSON.parse(generateMockBody(base, withoutExample));
  assert.equal(generated.ok, true);
  assert.equal(generated.user.name, "amy", "definition example values are reused first");
  assert.equal(generated.user.age, 18, "numbers stay numeric");
  assert.equal(generated.page, "1", "query params join the mock");
});

test("normalizeRequest keeps doc fields across a persist round-trip", () => {
  const raw = request();
  const round = JSON.parse(JSON.stringify(raw));
  const again = normalizeRequest(round);
  assert.equal(again.doc.status, "开发中");
  assert.ok(Array.isArray(again.doc.responses));
  assert.equal(again.updatedAt, 100);
});
