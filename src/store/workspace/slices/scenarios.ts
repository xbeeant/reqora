import { emptyDoc } from "../../../lib/defaults.ts";
import { newScenario } from "../../../lib/scenario.ts";
import type { RequestDoc } from "../../../types.ts";
import { clone } from "../helpers.ts";
import { pushTrash } from "../helpers.ts";
import type { StoreContext } from "../context.ts";
import type { ScenariosSlice } from "../types.ts";

export const createScenariosSlice = (ctx: StoreContext): ScenariosSlice => {
  const { set, get, commit, mutate } = ctx;
  return {
    // ---- test scenarios (cross-interface chains with a shared variable table) ----

    addScenario: (name) => {
      const scenario = newScenario(name?.trim() || `场景 ${get().snapshot.scenarios.length + 1}`);
      mutate((snapshot) => ({
        ...snapshot,
        scenarios: [...snapshot.scenarios, scenario],
      }));
      return scenario.id;
    },

    updateScenario: (id, patch) => {
      mutate((snapshot) => ({
        ...snapshot,
        scenarios: snapshot.scenarios.map((item) =>
          item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item,
        ),
      }));
    },

    deleteScenario: (id) => {
      const state = get();
      const source = state.snapshot.scenarios.find((item) => item.id === id);
      const tabs = state.tabs.filter((tab) => !(tab.kind === "scenario" && tab.id === id));
      const activeTab =
        state.activeTab?.kind === "scenario" && state.activeTab.id === id
          ? tabs[tabs.length - 1] ?? null
          : state.activeTab;
      // 行级删除：场景行变成墓碑行，回收站新增的那一行走 trash 差分，
      // 两者都在同一个 delta 载荷里，不必整份快照落盘。
      commit(
        {
          ...state.snapshot,
          scenarios: state.snapshot.scenarios.filter((item) => item.id !== id),
          trash: source
            ? pushTrash(state.snapshot.trash ?? [], { kind: "scenario", scenario: clone(source) })
            : (state.snapshot.trash ?? []),
        },
        { tabs, activeTab },
      );
    },

    // ---- data models ----

    selectModel: (id) => set({ selectedModelId: id }),

    upsertDataModel: (model) => {
      mutate((snapshot) => {
        const existing = (snapshot.dataModels ?? []).some((item) => item.id === model.id);
        return {
          ...snapshot,
          dataModels: existing
            ? (snapshot.dataModels ?? []).map((item) =>
                item.id === model.id ? { ...model, updatedAt: Date.now() } : item,
              )
            : [...(snapshot.dataModels ?? []), { ...model, updatedAt: Date.now() }],
        };
      });
    },

    deleteDataModel: (id) => {
      mutate((snapshot) => ({
        ...snapshot,
        dataModels: (snapshot.dataModels ?? []).filter((item) => item.id !== id),
      }));
    },

    /**
     * Bind a model from the Models view. Unlike the doc actions below, this
     * targets an arbitrary request id, so it works even when the request is not
     * the currently open tab. `"response"` binds the first saved example; the
     * UI disables that option when the request has no examples yet.
     */
    bindDataModel: (requestId, target, modelId) => {
      mutate((snapshot) => ({
        ...snapshot,
        collections: snapshot.collections.map((collection) => ({
          ...collection,
          items: collection.items.map((item) => {
            if (item.id !== requestId) return item;
            const doc: RequestDoc = {
              ...(item.doc ?? emptyDoc()),
              updatedAt: Date.now(),
            };
            if (target === "request") {
              doc.requestModelId = modelId ?? undefined;
            } else {
              doc.responses = (doc.responses ?? []).map((example, index) =>
                index === 0
                  ? { ...example, modelId: modelId ?? undefined }
                  : example,
              );
            }
            return { ...item, doc };
          }),
        })),
      }));
      // Keep the open draft in sync when the same request is being edited.
      const state = get();
      if (state.draft.id === requestId) {
        const fresh = state.snapshot.collections
          .flatMap((collection) => collection.items)
          .find((item) => item.id === requestId);
        if (fresh) set({ draft: clone(fresh) });
      }
    },

  };
};
