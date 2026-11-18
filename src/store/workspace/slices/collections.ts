import { emptyRequest } from "../../../lib/defaults.ts";
import { normalizeRequest } from "../../../lib/defaults.ts";
import { uid } from "../../../lib/id.ts";
import { createFolderInTree } from "../../../lib/collectionTree.ts";
import { deleteFolderInTree } from "../../../lib/collectionTree.ts";
import type { Collection } from "../../../types.ts";
import type { OpenTab } from "../../../types.ts";
import { pushRevision } from "../../../lib/revisions.ts";
import { requestFingerprint } from "../../../lib/revisions.ts";
import { clone } from "../helpers.ts";
import { emptySseState } from "../helpers.ts";
import { sameTab } from "../helpers.ts";
import { pushTrash } from "../helpers.ts";
import type { WorkspaceState } from "../types.ts";
import type { StoreContext } from "../context.ts";
import type { CollectionsSlice } from "../types.ts";

export const createCollectionsSlice = (ctx: StoreContext): CollectionsSlice => {
  const { set, get, commit, mutate } = ctx;
  return {
    selectRequest: (collectionId, request) => {
      const tabs = get().tabs;
      const tab: OpenTab = { kind: "request", id: request.id };
      set({
        draft: clone(request),
        activeTab: tab,
        activeCollectionId: collectionId,
        tabs: tabs.some((item) => sameTab(item, tab)) ? tabs : [...tabs, tab],
        response: null,
        scriptOutcome: null,
        sse: emptySseState(),
        sendError: null,
      });
    },

    loadFromHistory: (entry) => {
      const tabs = get().tabs;
      const request = normalizeRequest(entry.request);
      const tab: OpenTab = { kind: "request", id: request.id };
      set({
        draft: clone(request),
        activeTab: tab,
        tabs: tabs.some((item) => sameTab(item, tab)) ? tabs : [...tabs, tab],
        response: null,
        scriptOutcome: null,
        sse: emptySseState(),
        sendError: null,
      });
    },

    newRequest: (collectionId) => {
      const state = get();
      const request = emptyRequest();
      const target =
        collectionId ??
        state.activeCollectionId ??
        state.snapshot.collections[0]?.id;
      const exists = state.snapshot.collections.some(
        (collection) => collection.id === target,
      );

      if (target && exists) {
        mutate((snapshot) => ({
          ...snapshot,
          collections: snapshot.collections.map((collection) =>
            collection.id === target
              ? { ...collection, items: [...collection.items, clone(request)] }
              : collection,
          ),
        }));
      }
      const tab: OpenTab = { kind: "request", id: request.id };
      set({
        draft: request,
        activeTab: tab,
        activeCollectionId: target ?? null,
        tabs: [...get().tabs, tab],
        response: null,
        scriptOutcome: null,
        sse: emptySseState(),
        sendError: null,
      });
    },

    saveRequest: () => {
      const state = get();
      const saved = clone(state.draft);
      // Any explicit save marks the interface as changed, so stale cases show
      // the "接口已变更" hint until they are re-synced from the interface.
      saved.updatedAt = Date.now();

      // P1-7：接口已存在且内容有变化时，把被覆盖的旧版本存入变更历史。
      const previous = state.snapshot.collections
        .flatMap((collection) => collection.items)
        .find((item) => item.id === saved.id);
      const revisions =
        previous && requestFingerprint(previous) !== requestFingerprint(saved)
          ? pushRevision(state.snapshot.revisions ?? {}, saved.id, clone(previous))
          : (state.snapshot.revisions ?? {});

      let collections: Collection[] = state.snapshot.collections;
      let collectionId =
        state.activeCollectionId && collections.some((c) => c.id === state.activeCollectionId)
          ? state.activeCollectionId
          : null;

      if (!collectionId && collections.length === 0) {
        collectionId = uid();
        collections = [{ id: collectionId, name: "我的请求", items: [] }];
      } else if (!collectionId) {
        collectionId = collections[0].id;
      }

      const targetId = collectionId;
      collections = collections.map((collection) => {
        if (collection.id !== targetId) return collection;
        const exists = collection.items.some((item) => item.id === saved.id);
        return {
          ...collection,
          items: exists
            ? collection.items.map((item) =>
                item.id === saved.id ? saved : item,
              )
            : [...collection.items, saved],
        };
      });

      const snapshot = commit(
        { ...state.snapshot, collections, revisions },
        { activeTab: { kind: "request", id: saved.id }, activeCollectionId: targetId },
      );
      // 用收口后的实体回填 draft，确保 `contentUpdatedAt` 与快照一致，下一次
      // 保存不会把它丢掉。
      const persisted =
        snapshot.collections
          .flatMap((collection) => collection.items)
          .find((item) => item.id === saved.id) ?? saved;
      set({ draft: clone(persisted) });
    },

    deleteRequest: (collectionId, requestId) => {
      const state = get();
      const collection = state.snapshot.collections.find((item) => item.id === collectionId);
      const request = collection?.items.find((item) => item.id === requestId);
      const collections = state.snapshot.collections.map((item) =>
        item.id === collectionId
          ? {
              ...item,
              items: item.items.filter((entry) => entry.id !== requestId),
            }
          : item,
      );
      // Cases belong to their interface: delete them together.
      const cases = state.snapshot.cases.filter((item) => item.requestId !== requestId);
      const trash =
        request && collection
          ? pushTrash(state.snapshot.trash ?? [], {
              kind: "request",
              request: clone(request),
              collectionId,
              collectionName: collection.name,
            })
          : (state.snapshot.trash ?? []);
      const tabs = state.tabs.filter((tab) => !(tab.kind === "request" && tab.id === requestId));
      const patch: Partial<WorkspaceState> = { tabs };
      if (state.activeTab?.kind === "request" && state.activeTab.id === requestId) {
        const next = tabs[tabs.length - 1] ?? null;
        patch.activeTab = next;
        patch.draft =
          next?.kind === "request"
            ? clone(
                collections
                  .flatMap((collection) => collection.items)
                  .find((item) => item.id === next.id) ?? emptyRequest(),
              )
            : next?.kind === "case"
              ? clone(
                  cases.find((item) => item.id === next.id)?.request ?? emptyRequest(),
                )
              : emptyRequest();
        patch.response = null;
        patch.scriptOutcome = null;
        patch.sse = emptySseState();
      }
      commit({ ...state.snapshot, collections, cases, trash }, patch);
    },

    addCollection: () => {
      const state = get();
      const collection: Collection = {
        id: uid(),
        name: `集合 ${state.snapshot.collections.length + 1}`,
        items: [],
        auth: { type: "none" },
      };
      mutate((snapshot) => ({
        ...snapshot,
        collections: [...snapshot.collections, collection],
      }));
      set({ activeCollectionId: collection.id });
    },

    createFolder: (collectionId, path) => {
      const before = get().snapshot.collections;
      if (createFolderInTree(before, collectionId, path) === before) return;
      mutate((snapshot) => ({
        ...snapshot,
        collections: createFolderInTree(snapshot.collections, collectionId, path),
      }));
    },

    deleteFolder: (collectionId, path) => {
      const before = get().snapshot.collections;
      if (deleteFolderInTree(before, collectionId, path) === before) return;
      mutate((snapshot) => ({
        ...snapshot,
        collections: deleteFolderInTree(snapshot.collections, collectionId, path),
      }));
      // 活动请求若在被删文件夹内，draft.folder 跟随上移到父文件夹。
      const state = get();
      const source = path.trim();
      const current = (state.draft.folder ?? "").trim();
      const sameCollection =
        state.activeTab?.kind === "request" &&
        state.snapshot.collections.some(
          (item) =>
            item.id === collectionId &&
            item.items.some((request) => request.id === state.draft.id),
        );
      if (sameCollection && source && (current === source || current.startsWith(`${source}/`))) {
        const parent = source.split("/").slice(0, -1).join("/");
        set({
          draft: {
            ...state.draft,
            folder: current === source ? parent : `${parent}${current.slice(source.length)}`,
          },
        });
      }
    },

    renameCollection: (id, name) => {
      mutate((snapshot) => ({
        ...snapshot,
        collections: snapshot.collections.map((collection) =>
          collection.id === id ? { ...collection, name } : collection,
        ),
      }));
    },

    setCollectionAuth: (id, auth) => {
      mutate((snapshot) => ({
        ...snapshot,
        collections: snapshot.collections.map((collection) =>
          collection.id === id ? { ...collection, auth } : collection,
        ),
      }));
    },

    deleteCollection: (id) => {
      const state = get();
      const collection = state.snapshot.collections.find((item) => item.id === id);
      // Recycle every request in the collection individually so each can be
      // restored on its own; deleting a whole tree is still reversible.
      let trash = state.snapshot.trash ?? [];
      if (collection) {
        for (const request of collection.items) {
          trash = pushTrash(trash, {
            kind: "request",
            request: clone(request),
            collectionId: id,
            collectionName: collection.name,
          });
        }
      }
      mutate((snapshot) => ({
        ...snapshot,
        collections: snapshot.collections.filter(
          (item) => item.id !== id,
        ),
        cases: snapshot.cases.filter(
          (item) => !collection?.items.some((request) => request.id === item.requestId),
        ),
        trash,
      }));
    },

  };
};
