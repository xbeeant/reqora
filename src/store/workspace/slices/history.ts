/**
 * Zustand slice for the unified execution history.
 *
 * The data itself lives in Rust's separate encrypted SQLite file — this slice
 * only holds the decrypted list/detail currently visible in the WebView. It
 * never touches `snapshot`, so cloud sync, git mirror and export paths cannot
 * see it.
 */
import { api } from "../../../lib/api.ts";
import { normalizeRequest } from "../../../lib/defaults.ts";
import { t } from "../../../i18n/index.ts";
import {
  HISTORY_MAX_ROWS,
  HISTORY_PAGE_SIZE,
  matchesHistorySearch,
  mergeHistoryPage,
} from "../../../lib/historyPaging.ts";
import { clone, emptySseState, messageOf, sameTab } from "../helpers.ts";
import type { StoreContext } from "../context.ts";
import type { HistorySlice, WorkspaceState } from "../types.ts";
import type { HistoryContext } from "../../../lib/historyRecord.ts";
import type {
  HistoryCursor,
  HistoryListQuery,
  HistoryRunKind,
  HistoryRunRecord,
  HistoryRunSummary,
  OpenTab,
  RequestDraft,
} from "../../../types.ts";

/**
 * Scenario runs keep their request snapshots inside the steps; everything else
 * stores one at the root. Normalising also repairs records written before new
 * request fields existed, so the editor always receives a complete draft.
 */
export function requestOfRun(record: HistoryRunRecord): RequestDraft | null {
  const raw = record.request ?? record.steps?.find((step) => step.request)?.request ?? null;
  return raw ? normalizeRequest(raw) : null;
}

/**
 * A frozen tab displays resolved values. Re-sending must use the original
 * template: otherwise a `{{...}}` left inside a substituted value would be
 * resolved a second time, and dynamic tokens would be regenerated from an
 * already-concrete request. Older records have no template and fall back to
 * `request` (which was the template before this change).
 */
export function templateOfRun(record: HistoryRunRecord): RequestDraft | null {
  const raw =
    record.requestTemplate ??
    record.steps?.find((step) => step.requestTemplate)?.requestTemplate ??
    record.request ??
    record.steps?.find((step) => step.request)?.request ??
    null;
  return raw ? normalizeRequest(raw) : null;
}

/** The active local project is stored on every run so the list can be scoped. */
export function historyContextOf(
  state: Pick<WorkspaceState, "projectsState">,
): HistoryContext {
  const activeId = state.projectsState?.activeProjectId ?? "default";
  const name =
    state.projectsState?.projects.find((item) => item.id === activeId)?.name ?? "默认项目";
  return { projectId: activeId, projectName: name };
}

export const createHistorySlice = (ctx: StoreContext): HistorySlice => {
  const { set, get } = ctx;
  /**
   * Every reload (new project / kind / search term) invalidates in-flight
   * page requests. Without this, a slow older page could land after the list
   * was reset and mix records from another project into it.
   */
  let epoch = 0;

  /**
   * History always follows the project selected in the top bar. There is no
   * "all projects" toggle in the UI, so the scope is fixed here rather than
   * read from mutable view state.
   */
  const queryOf = (cursor: HistoryCursor | null): HistoryListQuery => {
    const state = get();
    return {
      scope: "project",
      projectId: historyContextOf(state).projectId,
      kind: state.historyKind,
      search: state.historySearch || null,
      limit: HISTORY_PAGE_SIZE,
      cursor,
    };
  };

  const refreshStats = async () => {
    try {
      set({ historyStats: await api.historyStats() });
    } catch {
      // Statistics are cosmetic; a failure must not break the list.
    }
  };

  const loadHistory: HistorySlice["loadHistory"] = async () => {
    const mine = ++epoch;
    set({ historyLoading: true, historyLoadingMore: false, historyError: null });
    try {
      const [page, stats] = await Promise.all([
        api.historyList(queryOf(null)),
        api.historyStats(),
      ]);
      if (epoch !== mine) return;
      // Switching the top-bar project reloads the list. A detail pane still
      // showing a run from the previous project must not linger behind it.
      const selectedId = get().historySelectedId;
      const keepSelection =
        selectedId && page.items.some((run) => run.id === selectedId);
      set({
        historyRuns: page.items,
        historyCursor: page.nextCursor,
        historyHasMore: page.nextCursor !== null,
        historyStats: stats,
        historyLoaded: true,
        historyLoading: false,
        ...(selectedId && !keepSelection
          ? { historySelectedId: null, historyDetail: null }
          : {}),
      });
    } catch (error) {
      if (epoch !== mine) return;
      set({
        historyLoading: false,
        historyLoadingMore: false,
        historyCursor: null,
        historyHasMore: false,
        historyError: messageOf(error),
      });
    }
  };

  const loadMoreHistory: HistorySlice["loadMoreHistory"] = async () => {
    const state = get();
    if (
      !state.historyLoaded ||
      !state.historyHasMore ||
      state.historyLoading ||
      state.historyLoadingMore ||
      !state.historyCursor
    ) {
      return;
    }
    const mine = epoch;
    set({ historyLoadingMore: true, historyError: null });
    try {
      let cursor: HistoryCursor | null = state.historyCursor;
      let staged: HistoryRunSummary[] = [];
      // A search page can legitimately contain zero matches (Rust skips rows
      // whose encrypted summary does not match). Walk a few empty windows in
      // one gesture so the footer keeps advancing without another scroll.
      for (let attempt = 0; attempt < 8 && cursor; attempt++) {
        const page = await api.historyList(queryOf(cursor));
        if (epoch !== mine) return;
        const merged = mergeHistoryPage(staged, page);
        staged = merged.items;
        cursor = merged.cursor;
        if (staged.length > 0 || !cursor) break;
      }
      set((current) => {
        const merged = mergeHistoryPage(current.historyRuns, {
          items: staged,
          nextCursor: cursor,
        });
        return {
          historyRuns: merged.items,
          historyCursor: merged.cursor,
          historyHasMore: merged.hasMore,
          historyLoadingMore: false,
        };
      });
    } catch (error) {
      if (epoch !== mine) return;
      set({ historyLoadingMore: false, historyError: messageOf(error) });
    }
  };

  return {
    historyRuns: [],
    historyDetail: null,
    historySelectedId: null,
    historyLoading: false,
    historyError: null,
    historyStats: null,
    historyKind: "all",
    historyLoaded: false,
    historySearch: "",
    historyCursor: null,
    historyHasMore: false,
    historyLoadingMore: false,
    historyTabRecords: {},

    /**
     * History rows open as frozen interface tabs: the recorded request fills
     * the editor (read-only) and the recorded response fills the viewer, but
     * Send / Load test still operate on that draft. The record is cached in
     * memory so switching tabs never needs another decrypt round-trip.
     */
    openHistoryRunTab: async (id) => {
      const state = get();
      let record = state.historyTabRecords[id] ?? null;
      if (!record) {
        set({ historyLoading: true, historyError: null });
        try {
          record = await api.historyGet(id);
        } catch (error) {
          set({ historyLoading: false, historyError: messageOf(error) });
          return;
        }
      }
      const request = record ? requestOfRun(record) : null;
      if (!record || !request) {
        set({ historyLoading: false, historyError: t("request.history.noRequest") });
        return;
      }
      const tab: OpenTab = { kind: "history", id };
      const current = get();
      const tabs = current.tabs.some((item) => sameTab(item, tab))
        ? current.tabs
        : [...current.tabs, tab];
      set({
        historyTabRecords: { ...current.historyTabRecords, [id]: record },
        historyLoading: false,
        historyError: null,
        tabs,
        activeTab: tab,
        draft: clone(request),
        response: record.response ? clone(record.response) : null,
        scriptOutcome: record.outcome ? clone(record.outcome) : null,
        sse: emptySseState(),
        sendError: null,
        detailTab: "debug",
      });
    },

    loadHistory,
    loadMoreHistory,
    refreshHistory: async () => {
      await get().loadHistory();
    },

    selectHistoryRun: async (id) => {
      if (!id) {
        set({ historySelectedId: null, historyDetail: null });
        return;
      }
      // Clear the previous detail immediately: a benchmark tab must not briefly
      // render the last run's response while the next record is being decrypted.
      set({ historySelectedId: id, historyDetail: null, historyLoading: true, historyError: null });
      try {
        const detail = await api.historyGet(id);
        // Ignore a slower response for a row the user has since deselected.
        if (get().historySelectedId !== id) return;
        set({ historyDetail: detail, historyLoading: false });
      } catch (error) {
        set({ historyLoading: false, historyError: messageOf(error) });
      }
    },

    /**
     * Fire-and-forget: a failed write must never fail or delay the request /
     * case / scenario run that produced the record.
     */
    appendHistory: (record: HistoryRunRecord) => {
      void api
        .historyAppend(record)
        .then((summary) => {
          const state = get();
          const context = historyContextOf(state);
          const visible =
            summary.projectId === context.projectId &&
            (state.historyKind === "all" || summary.kind === state.historyKind) &&
            matchesHistorySearch(summary, state.historySearch);
          if (visible) {
            set({
              historyRuns: [
                summary,
                ...state.historyRuns.filter((entry) => entry.id !== summary.id),
              ].slice(0, HISTORY_MAX_ROWS),
              historyLoaded: true,
            });
          }
          void refreshStats();
        })
        .catch((error: unknown) => set({ historyError: messageOf(error) }));
    },

    deleteHistoryRun: async (id) => {
      try {
        await api.historyDelete(id);
        set((state) => ({
          historyRuns: state.historyRuns.filter((entry) => entry.id !== id),
          historySelectedId: state.historySelectedId === id ? null : state.historySelectedId,
          historyDetail: state.historySelectedId === id ? null : state.historyDetail,
          historyError: null,
        }));
        void refreshStats();
      } catch (error) {
        set({ historyError: messageOf(error) });
      }
    },

    clearHistoryRuns: async (scope) => {
      try {
        const context = historyContextOf(get());
        await api.historyClear(scope, context.projectId);
        set({
          historyRuns: [],
          historyDetail: null,
          historySelectedId: null,
          historyCursor: null,
          historyHasMore: false,
          historyLoadingMore: false,
          historyError: null,
        });
        void refreshStats();
      } catch (error) {
        set({ historyError: messageOf(error) });
      }
    },

    setHistoryKind: (kind: HistoryRunKind | "all") => {
      if (get().historyKind === kind) return;
      set({ historyKind: kind });
      void get().loadHistory();
    },

    setHistorySearch: (needle: string) => {
      const next = needle.trim();
      if (get().historySearch === next) return;
      set({ historySearch: next });
      void get().loadHistory();
    },
  };
};
