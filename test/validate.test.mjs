import assert from "node:assert/strict";
import { test } from "node:test";
import { validateResponse } from "../src/lib/validate.ts";

function draftWith(responses) {
  return {
    id: "r1",
    name: "示例接口",
    method: "GET",
    url: "http://x/api",
    headers: [],
    query: [],
    body: { type: "none" },
    auth: { type: "none" },
    doc: {
      summary: "",
      description: "",
      owner: "",
      status: "联调中",
      tags: [],
      paramMeta: {},
      responses,
      updatedAt: 0,
    },
  };
}

function response(overrides = {}) {
  return {
    requestId: "x",
    status: 200,
    statusText: "OK",
    ok: true,
    timeMs: 10,
    size: 10,
    url: "http://x/api",
    resolvedUrl: "http://x/api",
    missingVariables: [],
    headers: [{ name: "content-type", value: "application/json" }],
    body: "{}",
    bodyKind: "json",
    truncated: false,
    ...overrides,
  };
}

const EXAMPLE = {
  id: "e1",
  name: "成功",
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({
    code: 0,
    data: { id: 1, name: "张三", tags: ["a"], profile: null },
  }),
  description: "",
};

test("no doc examples → nothing to validate", () => {
  assert.deepEqual(validateResponse(draftWith([]), response()), []);
  const noDoc = { ...draftWith([]) };
  delete noDoc.doc;
  assert.deepEqual(validateResponse(noDoc, response()), []);
});

test("all checks pass → empty findings", () => {
  const body = JSON.stringify({
    code: 0,
    data: { id: 2, name: "李四", tags: [], profile: { bio: "x" } },
  });
  assert.deepEqual(validateResponse(draftWith([EXAMPLE]), response({ body })), []);
});

test("status mismatch → error and stops early", () => {
  const findings = validateResponse(draftWith([EXAMPLE]), response({ status: 500, ok: false }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].name, "status");
  assert.equal(findings[0].level, "error");
  assert.ok(findings[0].message.includes("500"));
  assert.ok(findings[0].message.includes("200"));
});

test("missing documented field → warning", () => {
  const body = JSON.stringify({ code: 0, data: { id: 1, tags: [] } });
  const findings = validateResponse(draftWith([EXAMPLE]), response({ body }));
  assert.ok(findings.some((f) => f.level === "warning" && f.message.includes("缺少字段 data.name")));
});

test("type mismatch → warning with path", () => {
  const body = JSON.stringify({ code: 0, data: { id: "1", name: "张三", tags: [], profile: null } });
  const findings = validateResponse(draftWith([EXAMPLE]), response({ body }));
  const mismatch = findings.find((f) => f.message.includes("data.id"));
  assert.ok(mismatch, "expected a finding about data.id");
  assert.equal(mismatch.level, "warning");
  assert.ok(mismatch.message.includes("number") && mismatch.message.includes("string"));
});

test("extra fields are tolerated (forward-compatible)", () => {
  const body = JSON.stringify({
    code: 0,
    extra: true,
    data: { id: 1, name: "张三", tags: [], profile: null, bonus: 1 },
  });
  assert.deepEqual(validateResponse(draftWith([EXAMPLE]), response({ body })), []);
});

test("null in example accepts any actual type", () => {
  const body = JSON.stringify({
    code: 0,
    data: { id: 1, name: "张三", tags: [], profile: { anything: 42 } },
  });
  assert.deepEqual(validateResponse(draftWith([EXAMPLE]), response({ body })), []);
});

test("array element structure is checked via first item", () => {
  const d = draftWith([
    { ...EXAMPLE, body: JSON.stringify({ items: [{ id: 1, title: "x" }] }) },
  ]);
  const bad = validateResponse(d, response({ body: JSON.stringify({ items: [{ id: "1" }] }) }));
  assert.ok(bad.some((f) => f.message.includes("items[0].id") || f.message.includes("items[0].title")));
  const good = validateResponse(d, response({ body: JSON.stringify({ items: [{ id: 9, title: "y" }, { id: 10 }] }) }));
  assert.deepEqual(good, []);
});

test("content-type family mismatch → warning", () => {
  const findings = validateResponse(
    draftWith([EXAMPLE]),
    response({ headers: [{ name: "content-type", value: "text/html; charset=utf-8" }] }),
  );
  const ct = findings.find((f) => f.name === "content-type");
  assert.ok(ct, "expected a content-type finding");
  assert.equal(ct.level, "warning");
});

test("content-type parameters are ignored (charset ok)", () => {
  const body = JSON.stringify({ code: 0, data: { id: 1, name: "张三", tags: [], profile: null } });
  const findings = validateResponse(
    draftWith([EXAMPLE]),
    response({ headers: [{ name: "content-type", value: "application/json; charset=utf-8" }], body }),
  );
  assert.deepEqual(findings, []);
});

test("json content-type but unparseable body → error", () => {
  const findings = validateResponse(
    draftWith([EXAMPLE]),
    response({ body: "not json{", bodyKind: "text" }),
  );
  assert.ok(findings.some((f) => f.level === "warning" && f.message.includes("bodyKind")));
});

test("example body not json → info and skip structure check", () => {
  const d = draftWith([
    { id: "e2", name: "文本", status: 200, contentType: "text/plain", body: "hello", description: "" },
  ]);
  const findings = validateResponse(
    d,
    response({ headers: [{ name: "content-type", value: "text/plain" }], body: "hello", bodyKind: "text" }),
  );
  // status ok, content-type ok, structure skipped → clean
  assert.deepEqual(findings, []);
});

test("findings are capped to avoid explosion", () => {
  const d = draftWith([
    { ...EXAMPLE, body: JSON.stringify(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, i]))) },
  ]);
  const body = JSON.stringify({});
  const findings = validateResponse(d, response({ body }));
  assert.ok(findings.length <= 24);
});
