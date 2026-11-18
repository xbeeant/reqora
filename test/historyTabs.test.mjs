// Regression tests for execution-history centre tabs:
//   1. clicking a run opens a frozen tab with its recorded request/response
//   2. `setDraft` is a no-op while such a tab is active (read-only guarantee)
//   3. switching/closing tabs restores the right draft
//
// The slices are instantiated with a tiny in-memory zustand-like context, so
// no Tauri runtime, SQLite database or WebView is needed.
import assert from "node:assert/strict";
import test from "node:test";

import { createCoreSlice } from "../src/store/workspace/slices/core.ts";
import { createDraftUiSlice } from "../src/store/workspace/slices/draftUi.ts";
import { createHistorySlice } from "../src/store/workspace/slices/history.ts";
import { requestOfRun } from "../src/store/workspace/slices/history.ts";
import { emptyRequest } from "../src/lib/defaults.ts";

function makeStore() {
  let state;
  const ctx = {
    set: (patch) => { state = { ...state, ...patch }; },
    get: () => state,
    mutate: (fn) => { state = { ...state, snapshot: fn(state.snapshot) }; },
    runtime: null,
    hydrateCloud: () => {},
    flushBeforeSwitch: async () => {},
  };
  const core = createCoreSlice(ctx);
  const draftUi = createDraftUiSlice(ctx);
  const history = createHistorySlice(ctx);
  state = { ...core, ...history, ...draftUi };
  return {
    getState: () => state,
    patch: (value) => { state = { ...state, ...value }; },
    core,
    draftUi,
    history,
  };
}

const request = {
  ...emptyRequest(),
  id: "req-1",
  name: "示例接口",
  method: "GET",
  url: "https://api.example.test/users/7",
  headers: [],
  query: [],
};

const response = { status: 200, statusText: "OK", headers: [], body: "ok" };

function runRecord(overrides = {}) {
  return {
    id: "run-1",
    kind: "api",
    at: 1,
    projectId: "p1",
    projectName: "P1",
    subjectId: "req-1",
    subjectName: "示例接口",
    name: "GET /users/7",
    method: "GET",
    url: request.url,
    ok: true,
    status: 200,
    timeMs: 12,
    size: 2,
    total: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    error: "",
    request,
    response,
    outcome: null,
    summary: null,
    steps: [],
    truncated: [],
    ...overrides,
  };
}

function withFixture() {
  const store = makeStore();
  store.patch({
    snapshot: { ...store.getState().snapshot, collections: [{ id: "col-1", items: [request] }] },
    historyTabRecords: { "run-1": runRecord() },
    historyRuns: [],
    historyLoaded: true,
  });
  return store;
}

test("openHistoryRunTab opens a frozen tab with the recorded request and response", async () => {
  const store = withFixture();
  await store.history.openHistoryRunTab("run-1");
  const state = store.getState();
  assert.deepEqual(state.activeTab, { kind: "history", id: "run-1" });
  assert.equal(state.tabs.length, 1);
  assert.equal(state.draft.url, request.url);
  assert.equal(state.draft.id, request.id);
  assert.deepEqual(state.response, response);
  assert.equal(state.detailTab, "debug");
});

test("setDraft never mutates a frozen history tab", async () => {
  const store = withFixture();
  await store.history.openHistoryRunTab("run-1");
  store.core.setDraft({ url: "https://tampered.test" });
  assert.equal(store.getState().draft.url, request.url);
  // Leaving the snapshot for a normal interface tab restores editability.
  store.draftUi.openTab({ kind: "request", id: "req-1" });
  store.core.setDraft({ url: "https://edited.test" });
  assert.equal(store.getState().draft.url, "https://edited.test");
});

test("switching back to a history tab rehydrates its snapshot, closing restores the request", async () => {
  const store = withFixture();
  store.draftUi.openTab({ kind: "request", id: "req-1" });
  await store.history.openHistoryRunTab("run-1");
  store.draftUi.openTab({ kind: "request", id: "req-1" });
  assert.equal(store.getState().response, null);
  store.draftUi.openTab({ kind: "history", id: "run-1" });
  assert.equal(store.getState().activeTab.kind, "history");
  assert.deepEqual(store.getState().response, response);
  assert.equal(store.getState().draft.url, request.url);

  store.draftUi.closeTab({ kind: "history", id: "run-1" });
  assert.deepEqual(store.getState().activeTab, { kind: "request", id: "req-1" });
  assert.equal(store.getState().response, null);
  assert.equal(store.getState().draft.url, request.url);
});

test("requestOfRun falls back to a scenario step and normalises older snapshots", () => {
  const fromRoot = requestOfRun(runRecord());
  assert.equal(fromRoot.url, request.url);
  assert.equal(fromRoot.id, request.id);
  assert.ok(Array.isArray(fromRoot.pathVariables));

  const fromStep = requestOfRun(
    runRecord({ request: null, steps: [{ seq: 0, request: { id: "step-1", url: "https://step.test" } }] }),
  );
  assert.equal(fromStep.url, "https://step.test");
  assert.equal(fromStep.id, "step-1");
  assert.equal(requestOfRun(runRecord({ request: null, steps: [] })), null);
});
