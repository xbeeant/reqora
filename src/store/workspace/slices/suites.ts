import type { SuiteItemResult } from "../../../types.ts";
import { newSuite } from "../../../lib/suite.ts";
import { suiteItem } from "../../../lib/suite.ts";
import { summarizeSuite } from "../../../lib/suite.ts";
import type { StoreContext } from "../context.ts";
import type { SuitesSlice } from "../types.ts";

export const createSuitesSlice = (ctx: StoreContext): SuitesSlice => {
  const { set, get, commit, mutate } = ctx;
  return {
    // ---- test suites ----

    addSuite: (name) => {
      const count = get().snapshot.suites?.length ?? 0;
      const suite = newSuite(name?.trim() || `套件 ${count + 1}`);
      mutate((snapshot) => ({
        ...snapshot,
        suites: [...(snapshot.suites ?? []), suite],
      }));
      return suite.id;
    },

    updateSuite: (id, patch) => {
      mutate((snapshot) => ({
        ...snapshot,
        suites: (snapshot.suites ?? []).map((item) =>
          item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item,
        ),
      }));
    },

    deleteSuite: (id) => {
      const state = get();
      const tabs = state.tabs.filter((tab) => !(tab.kind === "suite" && tab.id === id));
      const activeTab =
        state.activeTab?.kind === "suite" && state.activeTab.id === id
          ? tabs[tabs.length - 1] ?? null
          : state.activeTab;
      // 行级删除：套件只是快照里少了一行，stampSharedChanges 会生成墓碑
      // 行并进入 delta；不需要整份快照落盘。
      commit(
        {
          ...state.snapshot,
          suites: (state.snapshot.suites ?? []).filter((item) => item.id !== id),
        },
        { tabs, activeTab },
      );
    },

    addSuiteItem: (suiteId, kind, refId) => {
      if (!refId) return;
      mutate((snapshot) => ({
        ...snapshot,
        suites: (snapshot.suites ?? []).map((suite) =>
          suite.id === suiteId
            ? { ...suite, items: [...suite.items, suiteItem(kind, refId)], updatedAt: Date.now() }
            : suite,
        ),
      }));
    },

    removeSuiteItem: (suiteId, itemId) => {
      mutate((snapshot) => ({
        ...snapshot,
        suites: (snapshot.suites ?? []).map((suite) =>
          suite.id === suiteId
            ? { ...suite, items: suite.items.filter((item) => item.id !== itemId), updatedAt: Date.now() }
            : suite,
        ),
      }));
    },

    runSuite: async (id) => {
      const state = get();
      const suite = (state.snapshot.suites ?? []).find((item) => item.id === id);
      if (!suite) return;
      if (state.runningSuiteId) return;
      set({ runningSuiteId: id });
      const startedAt = Date.now();
      const results: (SuiteItemResult | null)[] = [];

      for (const item of suite.items) {
        if (item.kind === "case") {
          const caseItem = state.snapshot.cases.find((candidate) => candidate.id === item.refId);
          if (!caseItem) {
            results.push(null);
            continue;
          }
          const caseBefore = Date.now();
          await get().runCase(caseItem.id);
          const summary = get().snapshot.cases.find((candidate) => candidate.id === caseItem.id)
            ?.lastRun;
          results.push({
            itemId: item.id,
            kind: "case",
            refId: caseItem.id,
            name: caseItem.name,
            ok: summary ? summary.failed === 0 : false,
            skipped: false,
            passed: summary?.passed ?? 0,
            failed: summary?.failed ?? 1,
            timeMs: summary?.timeMs ?? Date.now() - caseBefore,
            error: summary?.error,
          });
        } else {
          const scenario = state.snapshot.scenarios.find(
            (candidate) => candidate.id === item.refId,
          );
          if (!scenario) {
            results.push(null);
            continue;
          }
          const scenarioBefore = Date.now();
          await get().runScenario(scenario.id);
          const summary = get().snapshot.scenarios.find(
            (candidate) => candidate.id === scenario.id,
          )?.lastRun;
          results.push({
            itemId: item.id,
            kind: "scenario",
            refId: scenario.id,
            name: scenario.name,
            ok: summary ? summary.failed === 0 : false,
            skipped: false,
            passed: summary?.passed ?? 0,
            failed: summary?.failed ?? 1,
            timeMs: summary?.timeMs ?? Date.now() - scenarioBefore,
            error: summary?.steps.find((step) => step.error)?.error,
          });
        }
      }

      const summary = summarizeSuite(suite.items, results, Date.now() - startedAt);
      mutate((snapshot) => ({
        ...snapshot,
        suites: (snapshot.suites ?? []).map((item) =>
          item.id === id ? { ...item, lastRun: summary } : item,
        ),
      }));
      set({ runningSuiteId: null });
    },

  };
};
