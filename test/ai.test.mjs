import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DRAFT_SYSTEM_PROMPT,
  buildDraftPrompt,
  extractJsonObject,
  parseRequestDraft,
} from "../src/lib/ai.ts";

test("extractJsonObject finds balanced object with strings and escapes", () => {
  const text = '前言 {"a": "{\\"b\\": 1}", "c": {"d": [1,2]}} 结尾 {"other": 1}';
  assert.equal(
    extractJsonObject(text),
    '{"a": "{\\"b\\": 1}", "c": {"d": [1,2]}}',
  );
});

test("extractJsonObject returns null for unbalanced or absent json", () => {
  assert.equal(extractJsonObject("no json here"), null);
  assert.equal(extractJsonObject('{"a": 1'), null);
});

test("extractJsonObject tolerates braces inside strings", () => {
  assert.equal(extractJsonObject('{"a": "}"}'), '{"a": "}"}');
});

test("parseRequestDraft parses a clean draft", () => {
  const output = JSON.stringify({
    name: "获取用户",
    method: "post",
    url: "{{baseUrl}}/users",
    headers: [
      { key: "Authorization", value: "Bearer {{token}}" },
      { key: "", value: "ignored" },
      "garbage",
    ],
    bodyType: "json",
    body: '{"name":"李四"}',
  });
  const { draft, error } = parseRequestDraft(output);
  assert.equal(error, null);
  assert.ok(draft);
  assert.equal(draft.method, "POST");
  assert.equal(draft.url, "{{baseUrl}}/users");
  assert.equal(draft.name, "获取用户");
  assert.equal(draft.headers.length, 1);
  assert.equal(draft.headers[0].key, "Authorization");
  assert.deepEqual(draft.body, { type: "json", content: '{"name":"李四"}' });
});

test("parseRequestDraft strips markdown fences", () => {
  const output = '```json\n{"method": "GET", "url": "https://x.dev/api"}\n```';
  const { draft, error } = parseRequestDraft(output);
  assert.equal(error, null);
  assert.equal(draft.method, "GET");
  assert.equal(draft.url, "https://x.dev/api");
  assert.equal(draft.body.type, "none");
});

test("parseRequestDraft handles formUrlEncoded string body", () => {
  const output = JSON.stringify({
    method: "POST",
    url: "https://x.dev/login",
    bodyType: "formUrlEncoded",
    body: "username=amy&password=s3cret",
  });
  const { draft } = parseRequestDraft(output);
  assert.equal(draft.body.type, "formUrlEncoded");
  if (draft.body.type === "formUrlEncoded") {
    assert.equal(draft.body.items.length, 2);
    assert.deepEqual(
      draft.body.items.map((item) => [item.key, item.value]),
      [["username", "amy"], ["password", "s3cret"]],
    );
  }
});

test("parseRequestDraft handles formUrlEncoded item arrays", () => {
  const output = JSON.stringify({
    method: "POST",
    url: "https://x.dev/login",
    bodyType: "formUrlEncoded",
    bodyItems: [
      { key: "username", value: "amy" },
      { key: "", value: "skip" },
    ],
  });
  const { draft } = parseRequestDraft(output);
  assert.equal(draft.body.type, "formUrlEncoded");
  if (draft.body.type === "formUrlEncoded") {
    assert.equal(draft.body.items.length, 1);
    assert.equal(draft.body.items[0].key, "username");
  }
});

test("parseRequestDraft rejects bad method / missing url", () => {
  assert.ok(parseRequestDraft('{"method":"BREW","url":"https://x"}').error);
  assert.ok(parseRequestDraft('{"method":"GET"}').error);
});

test("parseRequestDraft rejects non-json output", () => {
  assert.ok(parseRequestDraft("抱歉，我做不到").error);
  assert.ok(parseRequestDraft('{"broken": ').error);
});

test("parseRequestDraft defaults name for empty output", () => {
  const { draft } = parseRequestDraft('{"method":"get","url":"https://x.dev"}');
  assert.equal(draft.name, "AI 生成的接口");
});

test("draft prompt carries the description and JSON-only instruction", () => {
  const prompt = buildDraftPrompt("GET https://x.dev/ping");
  assert.ok(prompt.includes("GET https://x.dev/ping"));
  assert.ok(DRAFT_SYSTEM_PROMPT.includes("chat/completions") === false);
  assert.ok(DRAFT_SYSTEM_PROMPT.includes("GET|POST"));
});
