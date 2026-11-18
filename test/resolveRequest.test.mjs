// The run-history request snapshot must contain the concrete values that were
// handed to the transport, not `{{...}}` placeholders. This mirrors the Rust
// resolver's field coverage in reqora-core/src/service/http.rs::prepare().
import assert from "node:assert/strict";
import test from "node:test";

import { resolveRequestDraft } from "../src/lib/resolveRequest.ts";
import { emptyRequest } from "../src/lib/defaults.ts";

const variables = {
  baseUrl: "https://api.example.test",
  token: "secret-token-123",
  userId: "42",
  nested: "{{unsetVar}}",
};

const row = (key, value, overrides = {}) => ({
  id: key,
  key,
  value,
  enabled: true,
  ...overrides,
});

function draft(overrides = {}) {
  return {
    ...emptyRequest(),
    id: "req-1",
    name: "示例接口",
    method: "POST",
    url: "{{baseUrl}}/users/:userId?token={{token}}",
    pathVariables: [row("userId", "{{userId}}")],
    headers: [row("Authorization", "Bearer {{token}}"), row("X-User", "{{userId}}")],
    query: [row("q", "{{userId}}")],
    body: { type: "json", content: '{"id":{{userId}},"tpl":"{{nested}}"}' },
    auth: { type: "bearer", token: "{{token}}", nested: { hint: "{{userId}}" } },
    ...overrides,
  };
}

test("resolveRequestDraft replaces url, path variables, headers, query, body and auth", () => {
  const input = draft();
  const out = resolveRequestDraft(input, variables);
  assert.equal(out.url, "https://api.example.test/users/42?token=secret-token-123");
  assert.equal(out.pathVariables[0].value, "42");
  assert.equal(out.headers[0].value, "Bearer secret-token-123");
  assert.equal(out.headers[1].value, "42");
  assert.equal(out.query[0].value, "42");
  assert.equal(out.body.content, '{"id":42,"tpl":"{{unsetVar}}"}');
  assert.equal(out.auth.token, "secret-token-123");
  assert.equal(out.auth.nested.hint, "42");
  // Single-pass: a variable value that itself contains a placeholder is not
  // re-scanned, exactly like Rust's template::resolve.
  assert.ok(out.body.content.includes("{{unsetVar}}"));
  // The source draft is never mutated.
  assert.equal(input.url, "{{baseUrl}}/users/:userId?token={{token}}");
  assert.equal(input.headers[0].value, "Bearer {{token}}");
  assert.equal(input.body.content, '{"id":{{userId}},"tpl":"{{nested}}"}');
});

test("resolveRequestDraft covers every body variant and leaves binary/file values alone", () => {
  const raw = resolveRequestDraft(draft({ body: { type: "raw", content: "{{token}}", contentType: "text/plain" } }), variables);
  assert.equal(raw.body.content, "secret-token-123");
  assert.equal(raw.body.contentType, "text/plain");

  const form = resolveRequestDraft(draft({
    body: { type: "formUrlEncoded", items: [row("{{userId}}", "{{token}}", { enabled: true })] },
  }), variables);
  assert.deepEqual(form.body.items[0].key, "42");
  assert.equal(form.body.items[0].value, "secret-token-123");

  const multipart = resolveRequestDraft(draft({
    body: {
      type: "formData",
      items: [
        row("field", "{{token}}"),
        { ...row("upload", "BASE64-DATA"), file: true, fileName: "{{token}}.bin" },
      ],
    },
  }), variables);
  assert.equal(multipart.body.items[0].value, "secret-token-123");
  assert.equal(multipart.body.items[1].value, "BASE64-DATA");
  assert.equal(multipart.body.items[1].fileName, "{{token}}.bin");

  const graphql = resolveRequestDraft(draft({
    body: { type: "graphql", query: "query { user(id: {{userId}}) }", variables: '{"t":"{{token}}"}' },
  }), variables);
  assert.equal(graphql.body.query, "query { user(id: 42) }");
  assert.equal(graphql.body.variables, '{"t":"secret-token-123"}');

  const binary = resolveRequestDraft(draft({
    body: { type: "binary", data: "{{token}}", fileName: "a.bin", contentType: "application/octet-stream" },
  }), variables);
  assert.equal(binary.body.data, "{{token}}");

  const none = resolveRequestDraft(draft({ body: { type: "none" } }), variables);
  assert.deepEqual(none.body, { type: "none" });
});

test("resolveRequestDraft keeps unknown variables, resolves dynamic ones, prefers user vars", () => {
  const out = resolveRequestDraft(draft({
    url: "{{missing}}/{{$randomInt}}/{{$randomInt}}",
    body: { type: "raw", content: "x", contentType: "text/plain" },
  }), { $randomInt: "7" });
  assert.ok(out.url.includes("{{missing}}"));
  assert.ok(out.url.endsWith("/7/7"));

  const dynamic = resolveRequestDraft(draft({
    url: "https://api.example.test/{{$randomInt}}",
    body: { type: "none" },
  }), {});
  const tail = dynamic.url.split("/").pop();
  assert.match(tail, /^\d+$/);
});

test("resolveRequestDraft does not touch scripts or assertions", () => {
  const input = draft({
    preScript: "setVar('k', '{{token}}')",
    postScript: "console.log('{{userId}}')",
    assertions: [{ id: "a1", enabled: true, name: "check", source: "text", path: "{{userId}}", op: "eq", value: "{{token}}" }],
  });
  const out = resolveRequestDraft(input, variables);
  assert.equal(out.preScript, "setVar('k', '{{token}}')");
  assert.equal(out.postScript, "console.log('{{userId}}')");
  assert.equal(out.assertions[0].value, "{{token}}");
});
