// 同步通道分派：用户选择的通道决定自动同步心跳去向，以及冲突裁决如何进入下一轮。
// 用内存 zustand-like ctx 实例化 slice，不触碰 Tauri / SQLite / WebView。
import test from "node:test";
import assert from "node:assert/strict";

import { createSyncModeSlice } from "../src/store/workspace/slices/syncMode.ts";

function makeStore(overrides = {}) {
  let state;
  const ctx = {
    set: (patch) => {
      const next = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...next };
    },
    get: () => state,
    persist: () => {},
    persistFull: () => {},
    clearPending: () => {},
  };
  const slice = createSyncModeSlice(ctx);
  const calls = { cloud: [], git: [] };
  state = {
    ...slice,
    projectsState: { activeProjectId: "p-1" },
    snapshot: { settings: { autoSyncMinutes: 5 } },
    isLoading: false,
    syncConverting: false,
    syncMode: "server",
    gitSyncDir: "",
    gitBusy: false,
    gitConflicts: [],
    gitResolutions: {},
    cloudAutoSyncTick: async () => { calls.cloud.push("tick"); },
    gitSyncNow: async (options) => { calls.git.push(options ?? {}); },
    ...overrides,
  };
  return {
    slice,
    calls,
    getState: () => state,
    patch: (value) => { state = { ...state, ...value }; },
  };
}

test("自动同步心跳按通道分派：server → 云、git → Git、local → 静默", async () => {
  const server = makeStore({ syncMode: "server" });
  await server.slice.syncAutoTick();
  assert.deepEqual(server.calls.cloud, ["tick"]);
  assert.equal(server.calls.git.length, 0, "服务端通道不应同时跑 Git 同步");

  const git = makeStore({ syncMode: "git", gitSyncDir: "/repo" });
  await git.slice.syncAutoTick();
  assert.equal(git.calls.cloud.length, 0, "Git 通道不应同时跑云同步");
  assert.deepEqual(git.calls.git, [{}]);

  const local = makeStore({ syncMode: "local" });
  await local.slice.syncAutoTick();
  assert.equal(local.calls.cloud.length, 0);
  assert.equal(local.calls.git.length, 0);
});

test("关闭自动同步 / 加载中 / 转换中 / Git 忙 / 有冲突或未应用裁决时都不触发", async () => {
  const cases = [
    ["server 且 autoSyncMinutes=0", {
      syncMode: "server", snapshot: { settings: { autoSyncMinutes: 0 } },
    }],
    ["git 且 autoSyncMinutes=0", {
      syncMode: "git", gitSyncDir: "/repo", snapshot: { settings: { autoSyncMinutes: 0 } },
    }],
    ["isLoading", { syncMode: "git", gitSyncDir: "/repo", isLoading: true }],
    ["syncConverting", { syncMode: "git", gitSyncDir: "/repo", syncConverting: true }],
    ["gitBusy", { syncMode: "git", gitSyncDir: "/repo", gitBusy: true }],
    ["无 Git 目录", { syncMode: "git", gitSyncDir: "" }],
    ["存在未裁决冲突", {
      syncMode: "git", gitSyncDir: "/repo",
      gitConflicts: [{ domain: "requests", id: "r-1", name: "A", base: {}, local: {}, remote: {} }],
    }],
    ["存在未应用裁决", {
      syncMode: "git", gitSyncDir: "/repo", gitResolutions: { "requests:r-1": "git" },
    }],
  ];
  for (const [name, overrides] of cases) {
    const store = makeStore(overrides);
    await store.slice.syncAutoTick();
    assert.equal(store.calls.cloud.length + store.calls.git.length, 0, name);
  }
});

test("冲突裁决累积后应用：以 pull:false 触发下一轮 Git 同步", async () => {
  const store = makeStore({ syncMode: "git", gitSyncDir: "/repo" });
  store.slice.gitResolveConflict("requests", "r-1", "git");
  store.slice.gitResolveConflict("cases", "c-1", "local");
  assert.deepEqual(store.getState().gitResolutions, {
    "requests:r-1": "git",
    "cases:c-1": "local",
  });

  // 用户在裁决面板里还没点「应用」，自动心跳必须停手，不能覆盖选择。
  await store.slice.syncAutoTick();
  assert.equal(store.calls.git.length, 0);

  await store.slice.gitApplyResolutions();
  assert.deepEqual(store.calls.git, [{ pull: false }]);
});

test("没有裁决时应用按钮不触发同步", async () => {
  const store = makeStore({ syncMode: "git", gitSyncDir: "/repo" });
  await store.slice.gitApplyResolutions();
  assert.equal(store.calls.git.length, 0);
});
