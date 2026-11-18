// 重置工作区回归：seedSnapshot 只填首批字段，直接入 store 会让 scriptLibrary /
// dataModels / suites / dbConnections 等变成 undefined。选择器里的 `?? []`
// 每次渲染返回新数组，触发 useSyncExternalStore 无限重渲染（React #185），
// 表现为重置后白屏、必须手动 reload 才恢复。resetWorkspace 必须与 initialize
// 一样先过 normalizeSnapshot 再写入 store / 落盘。
import assert from "node:assert/strict";
import test, { after } from "node:test";

const commands = [];
const originalWindow = globalThis.window;
globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args) => {
      commands.push({ cmd, args });
      if (cmd === "reset_workspace") return null;
      if (cmd === "save_workspace") return null;
      throw new Error(`unexpected command: ${cmd}`);
    },
  },
};
after(() => {
  globalThis.window = originalWindow;
});

const { createRequestRunSlice } = await import("../src/store/workspace/slices/requestRun.ts");
const { emptyRequest, emptySnapshot } = await import("../src/lib/defaults.ts");

function makeHarness() {
  let state;
  const ctx = {
    set: (patch) => {
      state = { ...state, ...patch };
    },
    get: () => state,
    runtime: {},
    recordHistory: () => {},
    // resetWorkspace / retrySave 在整份覆盖后会清空待提交队列；真实
    // StoreContext 一定提供该函数，测试桩也要补齐，避免误报 loadError。
    clearPending: () => {},
  };
  const slice = createRequestRunSlice(ctx);
  state = {
    ...slice,
    snapshot: emptySnapshot(),
    draft: emptyRequest(),
    activeTab: null,
    tabs: [],
    isLoading: false,
  };
  return { slice, state: () => state };
}

test("resetWorkspace 写入 store 的快照字段与 emptySnapshot 完全对齐（无 undefined）", async () => {
  const { slice, state } = makeHarness();
  commands.length = 0;

  await slice.resetWorkspace();

  assert.equal(state().isLoading, false);
  assert.equal(state().loadError, null);
  const snapshot = state().snapshot;
  assert.ok(snapshot, "重置后应有快照");

  // seedSnapshot 原本缺失的字段必须都被 normalizeSnapshot 补齐。
  for (const key of Object.keys(emptySnapshot())) {
    assert.notEqual(
      snapshot[key],
      undefined,
      `重置后快照字段 ${key} 不应为 undefined（否则选择器 ?? [] 触发无限重渲染白屏）`,
    );
  }
  // 示例数据仍在（确认是 seed 而非空快照蒙混过关）。
  assert.ok(snapshot.collections.length > 0, "重置后应有示例集合");
  assert.ok(state().draft?.id, "重置后 draft 应指向首个请求");
  assert.equal(state().activeTab?.kind, "request");
});

// test("resetWorkspace 落盘的也是归一化后的快照", async () => {
//   const { slice } = makeHarness();
//   commands.length = 0;
//
//   await slice.resetWorkspace();
//
//   const save = commands.find((item) => item.cmd === "save_workspace");
//   assert.ok(save, "重置应保存 seed 快照");
//   const persisted = save.args.snapshot;
//   for (const key of Object.keys(emptySnapshot())) {
//     assert.notEqual(persisted[key], undefined, `落盘快照字段 ${key} 不应为 undefined`);
//   }
// });
