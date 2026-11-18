import { api } from "../../../lib/api.ts";
import { uid } from "../../../lib/id.ts";
import { variablesFrom } from "../../../lib/template.ts";
import { resolveRequestDraft } from "../../../lib/resolveRequest.ts";
import { normalizeRequest } from "../../../lib/defaults.ts";
import type { Collection } from "../../../types.ts";
import type { OpenTab } from "../../../types.ts";
import type { RequestDraft } from "../../../types.ts";
import { REVISION_CAP } from "../../../lib/revisions.ts";
import { messageOf } from "../helpers.ts";
import { clone } from "../helpers.ts";
import { emptySseState } from "../helpers.ts";
import { sameTab } from "../helpers.ts";
import { withGlobalHeaders } from "../helpers.ts";
import { t } from "../../../i18n/index.ts";
import { buildBenchmarkRunRecord } from "../../../lib/historyRecord.ts";
import { historyContextOf, templateOfRun } from "./history.ts";
import type { StoreContext } from "../context.ts";
import type { MiscSlice, RevisionTabRecord } from "../types.ts";

export const createMiscSlice = (ctx: StoreContext): MiscSlice => {
  const { set, get, commit, mutate } = ctx;
  return {
    // ---- request revisions (P1-7) ----

    revisionTabRecords: {},

    /**
     * Saved revisions open as frozen interface tabs, just like execution-history
     * rows: the snapshot fills the read-only editor while Send / Load test still
     * operate on it. Unlike a run, a revision carries no response or outcome.
     */
    openRevisionTab: (revisionId) => {
      const state = get();
      let record: RevisionTabRecord | null = (state.revisionTabRecords ?? {})[revisionId] ?? null;
      if (!record) {
        const revisions = state.snapshot.revisions ?? {};
        for (const [requestId, list] of Object.entries(revisions)) {
          if (!Array.isArray(list)) continue;
          const found = list.find((item) => item.id === revisionId);
          if (!found) continue;
          record = { requestId, revision: clone(found) };
          break;
        }
      }
      if (!record) return;
      const tab: OpenTab = { kind: "revision", id: revisionId };
      const current = get();
      const tabs = current.tabs.some((item) => sameTab(item, tab))
        ? current.tabs
        : [...current.tabs, tab];
      set({
        revisionTabRecords: { ...(current.revisionTabRecords ?? {}), [revisionId]: record },
        tabs,
        activeTab: tab,
        draft: clone(normalizeRequest(record.revision.snapshot)),
        response: null,
        scriptOutcome: null,
        sse: emptySseState(),
        sendError: null,
        detailTab: "debug",
      });
    },

    // 回滚：把当前内容作为新修订存档（可再回滚回来），然后用快照替换。
    revertRequestToRevision: (requestId, revisionId) => {
      const state = get();
      const revisions = state.snapshot.revisions ?? {};
      const list = revisions[requestId] ?? [];
      const revision = list.find((item) => item.id === revisionId);
      if (!revision) return;
      let collections: Collection[] = state.snapshot.collections;
      let current: RequestDraft | null = null;
      collections = collections.map((collection) => ({
        ...collection,
        items: collection.items.map((item) => {
          if (item.id !== requestId) return item;
          current = clone(item);
          return { ...clone(revision.snapshot), updatedAt: Date.now() };
        }),
      }));
      if (!current) return;
      const nextRevisions = {
        ...revisions,
        [requestId]: [
          { id: uid(), at: Date.now(), snapshot: current },
          ...list.filter((item) => item.id !== revisionId),
        ].slice(0, REVISION_CAP),
      };
      const restored = { ...clone(revision.snapshot), updatedAt: Date.now() };
      // Reverting from a frozen tab must not overwrite the snapshot on screen.
      const frozen = state.activeTab?.kind === "history" || state.activeTab?.kind === "revision";
      // 行级回滚：接口行 + 修订表的增删都以 delta 表达（revisions /
      // revisionDeletes），不再整份保存。
      commit(
        { ...state.snapshot, collections, revisions: nextRevisions },
        !frozen && state.draft.id === requestId ? { draft: restored } : {},
      );
    },

    clearRequestRevisions: (requestId) => {
      const state = get();
      const revisions = { ...(state.snapshot.revisions ?? {}) };
      delete revisions[requestId];
      // 只删辅助表行：diffAux 产出 revisionDeletes，走行级保存。
      commit({ ...state.snapshot, revisions });
    },

    // ---- script library (P1-8) ----

    addScriptSnippet: (snippet) => {
      mutate((snapshot) => ({
        ...snapshot,
        scriptLibrary: [
          ...(snapshot.scriptLibrary ?? []),
          { id: uid(), name: snippet.name.trim() || "未命名片段", description: snippet.description, code: snippet.code },
        ],
      }));
    },

    updateScriptSnippet: (id, patch) => {
      mutate((snapshot) => ({
        ...snapshot,
        scriptLibrary: (snapshot.scriptLibrary ?? []).map((item) =>
          item.id === id ? { ...item, ...patch } : item,
        ),
      }));
    },

    deleteScriptSnippet: (id) => {
      mutate((snapshot) => ({
        ...snapshot,
        scriptLibrary: (snapshot.scriptLibrary ?? []).filter((item) => item.id !== id),
      }));
    },

    // ---- 全局命名数据库连接（P2-13）----
    saveDbConnections: (connections) => {
      mutate((snapshot) => ({ ...snapshot, dbConnections: connections }));
    },

    // ---- 场景定时运行（P2-14）----
    startScenarioSchedule: (scenarioId, intervalSecs) => {
      // 先停掉旧调度，避免双计时器。
      get().stopScenarioSchedule();
      const seconds = Math.min(Math.max(Math.round(intervalSecs), 5), 3600);
      const timer = window.setInterval(() => {
        const state = get();
        // 上一轮还没跑完 / 场景已被删除 → 跳过本轮。
        if (state.runningScenarioId) return;
        if (!state.snapshot.scenarios.some((item) => item.id === scenarioId)) {
          get().stopScenarioSchedule();
          return;
        }
        void get().runScenario(scenarioId);
      }, seconds * 1000);
      set({ schedule: { scenarioId, intervalSecs: seconds, timer } });
      get().pushConsole({
        level: "info",
        source: "scenario",
        text: t("store.schedule.started", { seconds }),
      });
    },

    stopScenarioSchedule: () => {
      const schedule = get().schedule;
      if (schedule) {
        window.clearInterval(schedule.timer);
        set({ schedule: null });
        get().pushConsole({ level: "info", source: "scenario", text: t("store.schedule.stopped") });
      }
    },

    restoreFromTrash: (entryId) => {
      const state = get();
      const entry = state.snapshot.trash?.find((item) => item.id === entryId);
      if (!entry) return;
      const snapshot = {
        ...state.snapshot,
        trash: state.snapshot.trash.filter((item) => item.id !== entryId),
      };
      const payload = entry.payload;
      if (payload.kind === "request") {
        // Prefer the original collection; fall back to the first one, or create one.
        const collections = [...snapshot.collections];
        const index = collections.findIndex((item) => item.id === payload.collectionId);
        const targetIndex = index >= 0 ? index : collections.length > 0 ? 0 : -1;
        if (targetIndex < 0) {
          collections.push({
            id: uid(),
            name: "恢复的接口",
            items: [clone(payload.request)],
          });
        } else {
          collections[targetIndex] = {
            ...collections[targetIndex],
            items: [...collections[targetIndex].items, clone(payload.request)],
          };
        }
        commit({ ...snapshot, collections });
      } else if (payload.kind === "case") {
        commit({ ...snapshot, cases: [...snapshot.cases, clone(payload.caseItem)] });
      } else {
        commit({
          ...snapshot,
          scenarios: [...snapshot.scenarios, clone(payload.scenario)],
        });
      }
    },

    deleteTrashEntry: (entryId) => {
      const state = get();
      // 回收站是独立的行表：删除一行 → trashDeletes 载荷。
      commit({
        ...state.snapshot,
        trash: (state.snapshot.trash ?? []).filter((item) => item.id !== entryId),
      });
    },

    emptyTrash: () => {
      const state = get();
      commit({ ...state.snapshot, trash: [] });
    },

    // ---- Benchmark ----

    runBenchmark: async (total, concurrency) => {
      const state = get();
      if (state.benchmarkRunning) return;
      if (!state.draft.url.trim()) {
        set({ benchmarkError: t("store.send.urlRequired") });
        return;
      }
      const environment = state.snapshot.environments.find(
        (item) => item.id === state.snapshot.activeEnvironmentId,
      );
      const startedAt = Date.now();
      const variables = variablesFrom(environment?.variables ?? []);
      // A frozen history tab shows resolved values; the load engine must run
      // the original template so dynamic tokens are generated per iteration.
      const frozenRecord =
        state.activeTab?.kind === "history"
          ? state.historyTabRecords?.[state.activeTab.id] ?? null
          : null;
      const benchmarkSource =
        (frozenRecord ? templateOfRun(frozenRecord) : null) ?? state.draft;
      const draft = withGlobalHeaders(clone(benchmarkSource), get().snapshot);
      const recordInput = {
        context: historyContextOf(get()),
        subjectId: state.draft.id,
        subjectName: state.draft.name || state.draft.url,
        request: resolveRequestDraft(draft, variables),
        requestTemplate: clone(benchmarkSource),
        total,
        concurrency,
        startedAt,
      };
      set({ benchmarkRunning: true, benchmarkError: null, benchmarkReport: null });
      get().pushConsole({
        level: "info",
        source: "http",
        text: t("store.bench.started", { total, concurrency, method: state.draft.method, url: state.draft.url }),
      });
      try {
        const report = await api.benchmarkRun(
          draft,
          {
            variables,
            settings: state.snapshot.settings,
          },
          total,
          concurrency,
        );
        set({ benchmarkRunning: false, benchmarkReport: report });
        get().pushConsole({
          level: report.failed > 0 ? "warn" : "info",
          source: "http",
          text: t("store.bench.finished", { total: report.total, rps: report.rps.toFixed(1), failed: report.failed }),
        });
        // Fire-and-forget: a history write failure must never break a load run.
        get().appendHistory(buildBenchmarkRunRecord({ ...recordInput, report, error: null }));
      } catch (error) {
        const message = messageOf(error);
        set({ benchmarkRunning: false, benchmarkError: message });
        get().appendHistory(buildBenchmarkRunRecord({ ...recordInput, report: null, error: message }));
      }
    },

  };
};
