import { ApiClientError } from "../../../lib/api.ts";
import { api } from "../../../lib/api.ts";
import { normalizeSnapshot, seedSnapshot } from "../../../lib/defaults.ts";
import { variablesFrom } from "../../../lib/template.ts";
import { resolveRequestDraft } from "../../../lib/resolveRequest.ts";
import { messageOf } from "../helpers.ts";
import { clone } from "../helpers.ts";
import { withGlobalHeaders } from "../helpers.ts";
import { emptySseState } from "../helpers.ts";
import { executePipeline } from "../pipeline.ts";
import { buildSingleRunRecord } from "../../../lib/historyRecord.ts";
import { suggestDownloadFileName } from "../../../lib/downloadName.ts";
import { historyContextOf, templateOfRun } from "./history.ts";
import { t } from "../../../i18n/index.ts";
import type { RequestDraft, ResponseData } from "../../../types.ts";
import type { StoreContext } from "../context.ts";
import type { RequestRunSlice, SendRunOptions } from "../types.ts";

export const createRequestRunSlice = (ctx: StoreContext): RequestRunSlice => {
  const { set, get, runtime, recordHistory, clearPending } = ctx;
  // The native save dialog is not part of `isSending`, so guard re-entry here
  // instead of exposing another state flag to the whole store.
  let downloadPending = false;

  /** Copy the full spooled body into a user-chosen file (binary-safe). */
  const saveDownload = async (response: ResponseData, request: RequestDraft) => {
    const fileName = suggestDownloadFileName(response, request.name, request.url);
    try {
      if (!response.bodyRef) {
        throw new ApiClientError({
          code: "INVALID_INPUT",
          message: t("store.send.download.noBody"),
          requestId: "-",
          retryable: false,
        });
      }
      const saved = await api.saveResponseBody(response.bodyRef, fileName);
      set({ downloadResult: { fileName, path: saved.path, size: saved.size } });
      get().pushConsole({
        level: "info",
        source: "http",
        text: t("store.send.download.done", { path: saved.path }),
      });
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "FILE_CANCELLED") {
        get().pushConsole({
          level: "warn",
          source: "http",
          text: t("store.send.download.cancelled"),
        });
        return;
      }
      const message = messageOf(error);
      set({ downloadError: message });
      get().pushConsole({
        level: "error",
        source: "http",
        text: t("store.send.download.failed", { message }),
      });
    }
  };

  return {
    downloadResult: null,
    downloadError: null,
    clearDownload: () => set({ downloadResult: null, downloadError: null }),

    send: async (options?: SendRunOptions) => {
      const download = options?.download === true;
      const state = get();
      if (state.isSending || downloadPending) return;
      // 编辑页没有响应区：发送时自动切到调试页，让响应立刻可见。
      // 仅接口标签生效；用例编辑器本身是分栏布局，不需要切换。
      if (state.activeTab?.kind === "request" && state.detailTab !== "debug") {
        set({ detailTab: "debug" });
      }
      if (!state.draft.url.trim()) {
        set({
          sendError: new ApiClientError({
            code: "INVALID_INPUT",
            message: t("store.send.urlRequired"),
            requestId: "-",
            retryable: false,
          }),
          downloadResult: null,
          downloadError: null,
        });
        return;
      }

      // A frozen history tab displays resolved values. Re-send from its
      // original template instead, so nothing is substituted twice.
      const frozenRecord =
        state.activeTab?.kind === "history"
          ? state.historyTabRecords?.[state.activeTab.id] ?? null
          : null;
      const sendSource =
        (frozenRecord ? templateOfRun(frozenRecord) : null) ?? clone(state.draft);
      const original = clone(sendSource);
      const environment = state.snapshot.environments.find(
        (item) => item.id === state.snapshot.activeEnvironmentId,
      );
      const controller = new AbortController();
      const startedAt = Date.now();
      set({
        isSending: true,
        sendError: null,
        scriptOutcome: null,
        sse: emptySseState(),
        response: null,
        abortController: controller,
        downloadResult: null,
        downloadError: null,
      });
      get().pushConsole({
        level: "info",
        source: "http",
        text: `→ ${original.method} ${original.url}`,
      });
      if (download) {
        get().pushConsole({
          level: "info",
          source: "http",
          text: t("store.send.download.mode"),
        });
      }

      const result = await executePipeline(
        withGlobalHeaders(clone(sendSource), get().snapshot),
        {
          variables: variablesFrom(environment?.variables ?? []),
          settings: state.snapshot.settings,
          signal: controller.signal,
          startedAt,
          onSse: (sse) => set({ sse }),
          forceBuffered: download,
          skipFullBodyMaterialization: download,
        },
      );

      set({
        response: result.response,
        scriptOutcome: result.outcome,
        sse: result.sse,
        sendError: result.error,
        isSending: false,
        abortController: null,
      });
      if (result.aborted) {
        get().pushConsole({ level: "warn", source: "http", text: t("store.log.cancelled", { method: original.method, url: original.url }) });
        return;
      }
      if (download) {
        // 「发送并下载」通常用于文件下载，响应体可能非常大：既不能进工作区
        // 快照里的轻量历史，也不能进加密执行历史（后者会保存完整响应体）。
        get().pushConsole({
          level: "info",
          source: "http",
          text: t("store.send.download.noHistory"),
        });
        if (result.response) {
          downloadPending = true;
          try {
            await saveDownload(result.response, original);
          } finally {
            downloadPending = false;
          }
        }
        return;
      }
      // Freeze the request that actually reached the transport (global headers
      // and pre-script edits included) with the exact variable map used then.
      const outgoing =
        result.sentRequest ?? withGlobalHeaders(clone(sendSource), get().snapshot);
      const resolvedRequest = resolveRequestDraft(outgoing, result.sentVariables);
      if (result.error) {
        get().pushConsole({ level: "error", source: "http", text: `✕ ${original.method} ${original.url} · ${result.error.message}` });
        recordHistory(resolvedRequest, null, Date.now() - startedAt, result.error.message);
        get().appendHistory(buildSingleRunRecord({
          context: historyContextOf(get()),
          kind: "api",
          subjectId: original.id,
          subjectName: original.name,
          name: original.name,
          request: resolvedRequest,
          requestTemplate: original,
          response: null,
          outcome: result.outcome,
          error: result.error.message,
          startedAt,
          ok: false,
        }));
      } else if (result.response) {
        get().pushConsole({
          level: result.response.ok ? "info" : "warn",
          source: "http",
          text: `← ${result.response.status} ${original.method} ${original.url} · ${result.response.timeMs}ms · ${result.response.size}B`,
        });
        recordHistory(resolvedRequest, result.response.status, result.response.timeMs);
        get().appendHistory(buildSingleRunRecord({
          context: historyContextOf(get()),
          kind: "api",
          subjectId: original.id,
          subjectName: original.name,
          name: original.name,
          request: resolvedRequest,
          requestTemplate: original,
          response: result.response,
          outcome: result.outcome,
          error: null,
          startedAt,
          ok: result.response.ok,
        }));
      }
    },

    cancelSend: () => {
      get().abortController?.abort();
    },

    resetWorkspace: async () => {
      set({ isLoading: true });
      try {
        await api.resetWorkspace();
        // 与首次初始化同一条路径：seedSnapshot 只填首批字段，必须过
        // normalizeSnapshot 补齐 scriptLibrary / dbConnections / mcpServers
        // 等字段，否则选择器的 `?? []` 每次渲染返回新数组会触发无限重渲染。
        const seeded = normalizeSnapshot(seedSnapshot());
        await api.saveWorkspace(seeded);
        // 磁盘已被重置 + 种子整份覆盖，旧队列作废。
        clearPending();
        const firstCollection = seeded.collections[0];
        const firstRequest = firstCollection.items[0];
        set({
          snapshot: seeded,
          draft: clone(firstRequest),
          activeTab: { kind: "request", id: firstRequest.id },
          tabs: [{ kind: "request", id: firstRequest.id }],
          activeCollectionId: firstCollection.id,
          response: null,
          sendError: null,
          loadError: null,
          saveError: null,
          isLoading: false,
        });
      } catch (error) {
        set({ isLoading: false, loadError: messageOf(error) });
      }
    },

    dismissLoadError: () => set({ loadError: null, loadStage: "ready" }),
    dismissSaveError: () => set({ saveError: null }),
    retrySave: async () => {
      if (runtime.persistTimer) {
        clearTimeout(runtime.persistTimer);
        runtime.persistTimer = undefined;
      }
      try {
        await api.saveWorkspace(get().snapshot);
        // 手动重试走整份保存，已覆盖全部 pending。
        clearPending();
        set({ saveError: null });
      } catch (error) {
        set({ saveError: t("store.save.failed", { message: messageOf(error) }) });
      }
    },

  };
};
