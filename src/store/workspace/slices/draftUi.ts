import { DEFAULT_MERGE_CONFIG } from "../../../lib/sse.ts";
import { createSseMerger } from "../../../lib/sse.ts";
import { clone } from "../helpers.ts";
import { emptySseState } from "../helpers.ts";
import { sameTab } from "../helpers.ts";
import { emptyRequest, normalizeRequest } from "../../../lib/defaults.ts";
import { requestOfRun } from "./history.ts";
import { checkExternalChanges } from "../externalChanges.ts";
import type { StoreContext } from "../context.ts";
import type { DraftUiSlice, WorkspaceState } from "../types.ts";
import type { OpenTab } from "../../../types.ts";

export const createDraftUiSlice = (ctx: StoreContext): DraftUiSlice => {
  const { set, get, mutate } = ctx;

  const tabKey = (tab: { kind: OpenTab["kind"]; id: string }) => `${tab.kind}:${tab.id}`;

  /**
   * Rehydrate the shared editor state for the tab becoming active. A history
   * tab restores both the recorded request and its response; a revision tab
   * restores only the saved request snapshot; request/case tabs read the
   * collection copy exactly as they always did.
   */
  const restoreForTab = (state: WorkspaceState, tab: OpenTab | null): Partial<WorkspaceState> => {
    const cleared = {
      response: null,
      scriptOutcome: null,
      sse: emptySseState(),
      sendError: null,
    };
    if (!tab) {
      // Closed the last remaining tab: hand back a fresh empty request so the
      // fallback draft tab shows cleared data instead of the stale request.
      return { draft: emptyRequest(), ...cleared };
    }
    if (tab.kind === "request") {
      const request = state.snapshot.collections
        .flatMap((collection) => collection.items)
        .find((item) => item.id === tab.id);
      return { draft: request ? clone(request) : state.draft, ...cleared };
    }
    if (tab.kind === "case") {
      const caseItem = state.snapshot.cases.find((item) => item.id === tab.id);
      return { draft: caseItem ? clone(caseItem.request) : state.draft, ...cleared };
    }
    if (tab.kind === "history") {
      const record = state.historyTabRecords[tab.id];
      const request = record ? requestOfRun(record) : null;
      return {
        draft: request ? clone(request) : state.draft,
        response: record?.response ? clone(record.response) : null,
        scriptOutcome: record?.outcome ? clone(record.outcome) : null,
        sse: emptySseState(),
        sendError: null,
      };
    }
    if (tab.kind === "revision") {
      const record = (state.revisionTabRecords ?? {})[tab.id];
      return {
        draft: record ? clone(normalizeRequest(record.revision.snapshot)) : state.draft,
        ...cleared,
      };
    }
    return { draft: state.draft, ...cleared };
  };

  /**
   * Shared implementation for every tab-closing action. `keys` lists the
   * tabs to close; `anchorIndex` is the closed/kept tab's index in the OLD
   * array — the tab landing there afterwards becomes active (same selection
   * rule the original single-tab close used).
   */
  const closeMany = (keys: Set<string>, anchorIndex: number) => {
    const state = get();
    const tabs = state.tabs.filter((item) => !keys.has(tabKey(item)));
    if (tabs.length === state.tabs.length) return;
    if (!state.activeTab || !keys.has(tabKey(state.activeTab))) {
      set({ tabs });
      return;
    }
    const next = tabs[Math.min(Math.max(anchorIndex, 0), tabs.length - 1)] ?? null;
    set({
      tabs,
      activeTab: next,
      ...restoreForTab(state, next),
    });
  };

  return {
    setEnvironmentModalOpen: (open) => set({ environmentModalOpen: open }),
    setSettingsModalOpen: (open) => set({ settingsModalOpen: open }),
    setAboutModalOpen: (open) => set({ aboutModalOpen: open }),
    setTrashModalOpen: (open: boolean) => set({ trashModalOpen: open }),
    setBenchmarkModalOpen: (open: boolean) =>
      set({
        benchmarkModalOpen: open,
        ...(open ? { benchmarkReport: null, benchmarkError: null } : {}),
      }),
    setImportExportModalOpen: (open) => set({ importExportModalOpen: open }),
    setSearchModalOpen: (open) => set({ searchModalOpen: open }),
    setConsoleOpen: (open) => set({ consoleOpen: open }),
    openDocPages: (id = null) => set({ docPagesModalOpen: true, docPagesFocusId: id }),
    closeDocPages: () => set({ docPagesModalOpen: false, docPagesFocusId: null }),

    openTab: (tab) => {
      // MCP / CLI 可能刚写入该接口的用例；点开接口时补一次磁盘版本检查，
      // 让「点击接口看不到新用例」不必等后台轮询的下一个周期。
      void checkExternalChanges("open-tab");
      const state = get();
      const tabs = state.tabs.some((item) => sameTab(item, tab))
        ? state.tabs
        : [...state.tabs, tab];
      if (tab.kind === "request") {
        const collection = state.snapshot.collections.find((item) =>
          item.items.some((request) => request.id === tab.id),
        );
        const request = collection?.items.find((item) => item.id === tab.id);
        set({
          tabs,
          activeTab: tab,
          ...(request
            ? {
                draft: clone(request),
                activeCollectionId: collection?.id ?? null,
                response: null,
                scriptOutcome: null,
                sse: emptySseState(),
                sendError: null,
              }
            : {}),
        });
        return;
      }
      if (tab.kind === "history" || tab.kind === "revision") {
        set({ tabs, activeTab: tab, ...restoreForTab(state, tab), detailTab: "debug" });
        return;
      }
      const caseItem = state.snapshot.cases.find((item) => item.id === tab.id);
      set({
        tabs,
        activeTab: tab,
        ...(caseItem
          ? {
              draft: clone(caseItem.request),
              response: null,
              scriptOutcome: null,
              sse: emptySseState(),
              sendError: null,
            }
          : {}),
      });
    },

    closeTab: (tab) => {
      closeMany(new Set([tabKey(tab)]), get().tabs.findIndex((item) => sameTab(item, tab)));
    },

    closeOtherTabs: (tab) => {
      const anchor = tabKey(tab);
      closeMany(
        new Set(get().tabs.filter((item) => tabKey(item) !== anchor).map(tabKey)),
        get().tabs.findIndex((item) => sameTab(item, tab)),
      );
    },

    closeTabsToLeft: (tab) => {
      const index = get().tabs.findIndex((item) => sameTab(item, tab));
      if (index <= 0) return;
      closeMany(
        new Set(get().tabs.slice(0, index).map(tabKey)),
        index,
      );
    },

    closeTabsToRight: (tab) => {
      const state = get();
      const index = state.tabs.findIndex((item) => sameTab(item, tab));
      if (index < 0 || index >= state.tabs.length - 1) return;
      closeMany(new Set(state.tabs.slice(index + 1).map(tabKey)), index);
    },

    closeAllTabs: () => {
      closeMany(new Set(get().tabs.map(tabKey)), 0);
    },

    setTheme: (theme) => {
      mutate((snapshot) => ({ ...snapshot, theme }));
    },

    setSseMergeConfig: (patch) => {
      mutate((snapshot) => ({
        ...snapshot,
        settings: {
          ...snapshot.settings,
          sseMerge: {
            ...DEFAULT_MERGE_CONFIG,
            ...(snapshot.settings.sseMerge ?? {}),
            ...patch,
          },
        },
      }));
      // Re-run the merge over already-received frames so changing a JSONPath
      // shows the new result immediately, without re-sending the request.
      get().remergeSse();
    },

    remergeSse: () => {
      const state = get();
      if (!state.sse.frames.length) return;
      const config = state.snapshot.settings.sseMerge ?? DEFAULT_MERGE_CONFIG;
      const merger = createSseMerger(config);
      let merged = merger.snapshot();
      for (const frame of state.sse.frames) merged = merger.push(frame);
      set({
        sse: {
          ...state.sse,
          format: merged.format,
          mergedText: merged.mergedText,
          reasoningText: merged.reasoningText,
          snippets: merged.snippets,
        },
      });
    },

  };
};
