// Regression tests for resolved parameter values in run history:
//   1. send() stores concrete values (not {{...}}) in both history layers
//   2. the original template is kept so a frozen tab can be re-sent safely
//   3. re-sending from a frozen history tab uses that template, not the
//      already-resolved draft shown in the editor
//
// The slice is driven through a fake in-memory context and a fake Tauri
// `invoke`, so no WebView, Rust command or real network is involved.
import assert from "node:assert/strict";
import test, { after } from "node:test";

const commands = [];
const originalWindow = globalThis.window;
globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args) => {
      commands.push({ cmd, args });
      if (cmd === "send_request") return makeResponse();
      throw new Error(`unexpected command: ${cmd}`);
    },
  },
};
after(() => {
  globalThis.window = originalWindow;
});

const { createRequestRunSlice } = await import("../src/store/workspace/slices/requestRun.ts");
const { emptyRequest, emptySnapshot } = await import("../src/lib/defaults.ts");
const { templateOfRun } = await import("../src/store/workspace/slices/history.ts");

function makeResponse() {
  return {
    requestId: "r1",
    status: 200,
    statusText: "OK",
    ok: true,
    timeMs: 12,
    size: 2,
    url: "https://api.example.test/users/42",
    resolvedUrl: "https://api.example.test/users/42",
    missingVariables: [],
    headers: [{ name: "content-type", value: "text/plain" }],
    body: "ok",
    bodyKind: "text",
    truncated: false,
    inlineBytes: 2,
    totalLines: 1,
  };
}

function row(id, key, value) {
  return { id, key, value, enabled: true };
}

function draft() {
  return {
    ...emptyRequest(),
    id: "req-1",
    name: "用户详情",
    method: "GET",
    url: "{{baseUrl}}/users/:userId",
    pathVariables: [row("p1", "userId", "{{userId}}")],
    headers: [row("h1", "Authorization", "Bearer {{token}}")],
    query: [row("q1", "uid", "{{userId}}")],
    body: { type: "json", content: '{"token":"{{token}}"}' },
    auth: { type: "none" },
  };
}

function makeHarness() {
  const captured = { records: [], light: [], console: [] };
  let state;
  const ctx = {
    set: (patch) => { state = { ...state, ...patch }; },
    get: () => state,
    runtime: {},
    recordHistory: (request, status, timeMs, error) =>
      captured.light.push({ request, status, timeMs, error }),
  };
  const slice = createRequestRunSlice(ctx);
  const snapshot = emptySnapshot();
  snapshot.environments = [{
    id: "env-1",
    name: "测试环境",
    variables: [
      row("v1", "baseUrl", "https://api.example.test"),
      row("v2", "token", "secret-123"),
      row("v3", "userId", "42"),
    ],
    headers: [],
  }];
  snapshot.activeEnvironmentId = "env-1";
  state = {
    ...slice,
    snapshot,
    draft: draft(),
    historyTabRecords: {},
    activeTab: { kind: "request", id: "req-1" },
    detailTab: "debug",
    isSending: false,
    pushConsole: (entry) => captured.console.push(entry),
    appendHistory: (record) => captured.records.push(record),
  };
  return {
    captured,
    send: slice.send,
    state: () => state,
    patch: (value) => { state = { ...state, ...value }; },
  };
}

const specOf = () => commands.find((item) => item.cmd === "send_request").args.spec;

test("send() freezes resolved parameters in both history layers", async () => {
  commands.length = 0;
  const harness = makeHarness();
  await harness.send();

  const record = harness.captured.records[0];
  assert.ok(record, "an execution-history record must be appended");
  assert.equal(record.url, "https://api.example.test/users/42");
  assert.equal(record.request.url, "https://api.example.test/users/42");
  assert.equal(record.request.pathVariables[0].value, "42");
  assert.equal(
    record.request.headers.find((item) => item.key === "Authorization").value,
    "Bearer secret-123",
  );
  assert.equal(record.request.query.find((item) => item.key === "uid").value, "42");
  assert.equal(record.request.body.content, '{"token":"secret-123"}');
  // The workspace's lightweight history gets the same concrete snapshot.
  assert.equal(harness.captured.light[0].request.url, "https://api.example.test/users/42");

  // The template is kept for re-sending, and the transport itself still
  // receives the placeholders + variable map (Rust stays authoritative).
  assert.equal(record.requestTemplate.url, "{{baseUrl}}/users/:userId");
  const spec = specOf();
  assert.equal(spec.url, "{{baseUrl}}/users/{{userId}}");
  assert.equal(spec.variables.token, "secret-123");
  assert.equal(spec.variables.userId, "42");
});

test("re-sending from a frozen history tab uses the original template", async () => {
  commands.length = 0;
  const harness = makeHarness();
  await harness.send();
  const first = harness.captured.records[0];

  commands.length = 0;
  harness.patch({
    activeTab: { kind: "history", id: first.id },
    historyTabRecords: { [first.id]: first },
    // A frozen tab displays the resolved snapshot in the editor.
    draft: { ...first.request },
  });
  await harness.send();

  const spec = specOf();
  assert.equal(spec.url, "{{baseUrl}}/users/{{userId}}");
  assert.ok(spec.headers.some((item) => item.value === "Bearer {{token}}"));
  assert.equal(spec.body.content, '{"token":"{{token}}"}');
  // The new run still records concrete values.
  const second = harness.captured.records[1];
  assert.equal(second.request.url, "https://api.example.test/users/42");
  assert.equal(second.request.body.content, '{"token":"secret-123"}');
});

test("templateOfRun falls back to request for records written before this change", () => {
  const legacy = { request: draft(), steps: [] };
  assert.equal(templateOfRun(legacy).url, "{{baseUrl}}/users/:userId");
  const modern = { request: draft(), requestTemplate: draft(), steps: [] };
  modern.request.url = "https://api.example.test/users/42";
  assert.equal(templateOfRun(modern).url, "{{baseUrl}}/users/:userId");
  assert.equal(templateOfRun({ request: null, steps: [] }), null);
});
