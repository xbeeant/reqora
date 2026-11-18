// Regression tests for saved-revision centre tabs:
//   1. clicking a revision opens a frozen tab with the saved request snapshot
//   2. `setDraft` is a no-op while such a tab is active (read-only guarantee)
//   3. switching/closing tabs restores the right draft
//   4. reverting still archives the current request and keeps a frozen tab intact
//
// The slices are instantiated with a tiny in-memory zustand-like context, so
// no Tauri runtime, SQLite database or WebView is needed.
import assert from "node:assert/strict";
import test from "node:test";

import { createCoreSlice } from "../src/store/workspace/slices/core.ts";
import { createDraftUiSlice } from "../src/store/workspace/slices/draftUi.ts";
import { createHistorySlice } from "../src/store/workspace/slices/history.ts";
import { createMiscSlice } from "../src/store/workspace/slices/misc.ts";
import { emptyRequest } from "../src/lib/defaults.ts";

function makeStore() {
  let state;
  const ctx = {
    set: (patch) => { state = { ...state, ...patch }; },
    get: () => state,
    mutate: (fn) => { state = { ...state, snapshot: fn(state.snapshot) }; },
    persist: () => {},
    persistFull: () => {},
    clearPending: () => {},
    // 与真实 commit 一致：写回快照并按 patch 更新 tabs / draft 等非快照状态。
    commit: (snapshot, patch = {}) => {
      state = { ...state, ...patch, snapshot };
      return snapshot;
    },
    runtime: null,
    hydrateCloud: () => {},
    flushBeforeSwitch: async () => {},
  };
  const core = createCoreSlice(ctx);
  const draftUi = createDraftUiSlice(ctx);
  const history = createHistorySlice(ctx);
  const misc = createMiscSlice(ctx);
  state = { ...core, ...history, ...draftUi, ...misc };
  return {
    getState: () => state,
    patch: (value) => { state = { ...state, ...value }; },
    core,
    draftUi,
    misc,
  };
}

const current = {
  ...emptyRequest(),
  id: "req-1",
  name: "示例接口 v2",
  method: "POST",
  url: "https://api.example.test/v2",
  headers: [],
  query: [],
};

// Older snapshots may lack fields added later; normalisation must repair them.
const old = {
  id: "req-1",
  name: "示例接口 v1",
  method: "GET",
  url: "https://api.example.test/v1",
  headers: [],
  query: [],
};

const revision = { id: "rev-1", at: 1, snapshot: old };

function withFixture() {
  const store = makeStore();
  store.patch({
    snapshot: {
      ...store.getState().snapshot,
      collections: [{ id: "col-1", items: [current] }],
      revisions: { "req-1": [revision] },
    },
    historyTabRecords: {},
  });
  return store;
}

test("openRevisionTab opens a frozen tab with the saved request snapshot", () => {
  const store = withFixture();
  store.misc.openRevisionTab("rev-1");
  const state = store.getState();
  assert.deepEqual(state.activeTab, { kind: "revision", id: "rev-1" });
  assert.equal(state.tabs.length, 1);
  assert.equal(state.draft.url, old.url);
  assert.equal(state.draft.id, "req-1");
  assert.ok(Array.isArray(state.draft.pathVariables));
  assert.equal(state.response, null);
  assert.equal(state.scriptOutcome, null);
  assert.equal(state.detailTab, "debug");
  assert.equal(state.revisionTabRecords["rev-1"].requestId, "req-1");
});

test("openRevisionTab ignores unknown ids", () => {
  const store = withFixture();
  store.misc.openRevisionTab("missing");
  assert.equal(store.getState().activeTab, null);
  assert.equal(store.getState().tabs.length, 0);
});

test("setDraft never mutates a frozen revision tab", () => {
  const store = withFixture();
  store.misc.openRevisionTab("rev-1");
  store.core.setDraft({ url: "https://tampered.test" });
  assert.equal(store.getState().draft.url, old.url);
  // Leaving the snapshot for a normal interface tab restores editability.
  store.draftUi.openTab({ kind: "request", id: "req-1" });
  store.core.setDraft({ url: "https://edited.test" });
  assert.equal(store.getState().draft.url, "https://edited.test");
});

test("switching back to a revision tab rehydrates its snapshot, closing restores the request", () => {
  const store = withFixture();
  store.draftUi.openTab({ kind: "request", id: "req-1" });
  store.misc.openRevisionTab("rev-1");
  store.draftUi.openTab({ kind: "request", id: "req-1" });
  assert.equal(store.getState().draft.url, current.url);
  store.draftUi.openTab({ kind: "revision", id: "rev-1" });
  assert.equal(store.getState().activeTab.kind, "revision");
  assert.equal(store.getState().draft.url, old.url);

  store.draftUi.closeTab({ kind: "revision", id: "rev-1" });
  assert.deepEqual(store.getState().activeTab, { kind: "request", id: "req-1" });
  assert.equal(store.getState().draft.url, current.url);
});

test("reverting archives the current request without overwriting a frozen tab", () => {
  const store = withFixture();
  store.misc.openRevisionTab("rev-1");
  store.misc.revertRequestToRevision("req-1", "rev-1");
  const state = store.getState();
  assert.equal(state.snapshot.collections[0].items[0].url, old.url);
  assert.equal(state.snapshot.revisions["req-1"][0].snapshot.url, current.url);
  assert.equal(state.draft.url, old.url);
});
