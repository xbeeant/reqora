import { emptyDoc } from "../../../lib/defaults.ts";
import { emptyParamMeta } from "../../../lib/defaults.ts";
import { newCaseFromRequest } from "../../../lib/cases.ts";
import { pushCaseRun } from "../../../lib/cases.ts";
import { syncCaseFromRequest } from "../../../lib/cases.ts";
import { summarizeRun } from "../../../lib/cases.ts";
import { uid } from "../../../lib/id.ts";
import { deriveResponseParams } from "../../../lib/responseParams.ts";
import { emptyResponseParam } from "../../../lib/responseParams.ts";
import { mergeResponseParams } from "../../../lib/responseParams.ts";
import { normalizeResponseParams } from "../../../lib/responseParams.ts";
import { buildResponseExample } from "../../../lib/responseExamples.ts";
import { variablesFrom } from "../../../lib/template.ts";
import { resolveRequestDraft } from "../../../lib/resolveRequest.ts";
import type { ApiCase } from "../../../types.ts";
import type { RequestDoc } from "../../../types.ts";
import { clone } from "../helpers.ts";
import { withGlobalHeaders } from "../helpers.ts";
import { pushTrash } from "../helpers.ts";
import { executePipeline } from "../pipeline.ts";
import { buildSingleRunRecord } from "../../../lib/historyRecord.ts";
import { historyContextOf } from "./history.ts";
import type { StoreContext } from "../context.ts";
import type { CasesSlice } from "../types.ts";

export const createCasesSlice = (ctx: StoreContext): CasesSlice => {
  const { set, get, commit, mutate, writeDoc, patchDoc } = ctx;
  return {
    // ---- cases (Apifox 单接口用例) ----

    addCase: (requestId, name, group) => {
      const state = get();
      const request = state.snapshot.collections
        .flatMap((collection) => collection.items)
        .find((item) => item.id === requestId);
      if (!request) return null;
      const caseItem = newCaseFromRequest(
        request,
        name?.trim() || `${request.name} 用例`,
        group,
      );
      mutate((snapshot) => ({
        ...snapshot,
        cases: [...snapshot.cases, caseItem],
      }));
      return caseItem.id;
    },

    updateCase: (id, patch) => {
      mutate((snapshot) => ({
        ...snapshot,
        cases: snapshot.cases.map((item) =>
          item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item,
        ),
      }));
    },

    deleteCase: (id) => {
      const state = get();
      const source = state.snapshot.cases.find((item) => item.id === id);
      const snapshot = {
        ...state.snapshot,
        cases: state.snapshot.cases.filter((item) => item.id !== id),
        trash: source
          ? pushTrash(state.snapshot.trash ?? [], { kind: "case", caseItem: clone(source) })
          : (state.snapshot.trash ?? []),
      };
      const tabs = state.tabs.filter((tab) => !(tab.kind === "case" && tab.id === id));
      const activeTab =
        state.activeTab?.kind === "case" && state.activeTab.id === id
          ? tabs[tabs.length - 1] ?? null
          : state.activeTab;
      commit(snapshot, { tabs, activeTab });
    },

    duplicateCase: (id) => {
      const state = get();
      const source = state.snapshot.cases.find((item) => item.id === id);
      if (!source) return;
      const now = Date.now();
      const copy: ApiCase = {
        ...clone(source),
        id: uid(),
        name: `${source.name} 副本`,
        createdAt: now,
        updatedAt: now,
        lastRun: undefined,
        runHistory: undefined,
      };
      mutate((snapshot) => ({
        ...snapshot,
        cases: [...snapshot.cases, copy],
      }));
    },

    syncCase: (id) => {
      const state = get();
      const caseItem = state.snapshot.cases.find((item) => item.id === id);
      if (!caseItem) return;
      const request = state.snapshot.collections
        .flatMap((collection) => collection.items)
        .find((item) => item.id === caseItem.requestId);
      if (!request) return;
      const synced = syncCaseFromRequest(caseItem, request);
      mutate((snapshot) => ({
        ...snapshot,
        cases: snapshot.cases.map((item) => (item.id === id ? synced : item)),
      }));
      if (state.activeTab?.kind === "case" && state.activeTab.id === id) {
        set({ draft: clone(synced.request) });
      }
    },

    runCase: async (id) => {
      const state = get();
      if (state.runningCaseIds.includes(id)) return;
      const caseItem = state.snapshot.cases.find((item) => item.id === id);
      if (!caseItem) return;
      const environment = state.snapshot.environments.find(
        (item) => item.id === state.snapshot.activeEnvironmentId,
      );
      const controller = new AbortController();
      const startedAt = Date.now();
      set({ runningCaseIds: [...state.runningCaseIds, id] });

      const result = await executePipeline(
        withGlobalHeaders(clone(caseItem.request), get().snapshot, caseItem.requestId),
        {
        variables: variablesFrom(environment?.variables ?? []),
        settings: state.snapshot.settings,
        signal: controller.signal,
        startedAt,
        onSse: (sse) => {
          const active = get().activeTab;
          if (active?.kind === "case" && active.id === id) set({ sse });
        },
      });

      const summary = summarizeRun(
        result.response,
        result.outcome,
        caseItem.expectedStatus,
        result.error?.message,
      );
      const outgoing =
        result.sentRequest ??
        withGlobalHeaders(clone(caseItem.request), get().snapshot, caseItem.requestId);
      const resolvedRequest = resolveRequestDraft(outgoing, result.sentVariables);
      mutate((snapshot) => ({
        ...snapshot,
        cases: snapshot.cases.map((item) =>
          item.id === id
            ? {
                ...item,
                // lastRun 只留最近一次；runHistory 是完整执行历史（最新在前，封顶截断）。
                lastRun: summary,
                runHistory: pushCaseRun(item.runHistory, summary),
              }
            : item,
        ),
      }));
      // 统一执行历史：用例的完整请求快照 + 响应 + 断言，写入本地加密库。
      get().appendHistory(buildSingleRunRecord({
        context: historyContextOf(get()),
        kind: "case",
        subjectId: caseItem.id,
        subjectName: caseItem.name,
        name: caseItem.name,
        request: resolvedRequest,
        requestTemplate: clone(caseItem.request),
        response: result.response,
        outcome: result.outcome,
        error: result.error?.message ?? result.outcome.error ?? null,
        startedAt,
        ok: summary.ok,
        summary,
      }));
      // When the case tab is open, surface the full response details too.
      const active = get().activeTab;
      if (active?.kind === "case" && active.id === id) {
        set({
          response: result.response,
          scriptOutcome: result.outcome,
          sse: result.sse,
          sendError: result.error,
        });
      }
      set({ runningCaseIds: get().runningCaseIds.filter((item) => item !== id) });
    },

    runCases: async (ids) => {
      for (const id of ids) {
        await get().runCase(id);
      }
    },

    saveDraftAsCase: (name) => {
      const state = get();
      const requestId =
        state.activeTab?.kind === "request" ? state.activeTab.id : state.draft.id;
      const caseItem: ApiCase = {
        ...newCaseFromRequest(
          state.draft,
          name?.trim() || `${state.draft.name} 用例`,
          "正向",
        ),
        requestId,
      };
      mutate((snapshot) => ({
        ...snapshot,
        cases: [...snapshot.cases, caseItem],
      }));
      return caseItem.id;
    },

    // ---- documentation (projection of the interface definition) ----

    updateDoc: (patch) => {
      const state = get();
      // No activeTab guard — doc edits must not be silently dropped.
      const doc: RequestDoc = {
        ...(state.draft.doc ?? emptyDoc()),
        ...patch,
        updatedAt: Date.now(),
      };
      set({ draft: { ...state.draft, doc } });
      // Doc edits save immediately (they are metadata, not request content):
      // they do NOT bump request.updatedAt, so cases stay fresh.
      mutate((snapshot) => ({
        ...snapshot,
        collections: snapshot.collections.map((collection) => ({
          ...collection,
          items: collection.items.map((item) =>
            item.id === state.draft.id ? { ...item, doc } : item,
          ),
        })),
      }));
    },

    updateParamMeta: (key, patch) => {
      const state = get();
      // No activeTab guard — doc edits must not be silently dropped.
      const base = state.draft.doc ?? emptyDoc();
      const current = base.paramMeta[key] ?? emptyParamMeta();
      const doc: RequestDoc = {
        ...base,
        paramMeta: { ...base.paramMeta, [key]: { ...current, ...patch } },
        updatedAt: Date.now(),
      };
      set({ draft: { ...state.draft, doc } });
      mutate((snapshot) => ({
        ...snapshot,
        collections: snapshot.collections.map((collection) => ({
          ...collection,
          items: collection.items.map((item) =>
            item.id === state.draft.id ? { ...item, doc } : item,
          ),
        })),
      }));
    },

    saveResponseExample: (name) => {
      const state = get();
      // No activeTab guard — doc edits must not be silently dropped.
      const response = state.response;
      if (!response) return "missing";
      const base = state.draft.doc ?? emptyDoc();
      const built = buildResponseExample(response, base, {
        name: name?.trim() || `示例 ${response.status}`,
        description: "",
      });
      if (built.result === "duplicate") return "duplicate";
      const doc = built.doc;
      set({ draft: { ...state.draft, doc } });
      writeDoc(state.draft.id, doc);
      return "added";
    },

    /**
     * 用例运行后的响应 → 所属接口的返回示例。用例标签打开时文档入口不可达，
     * 且此时 draft 是用例的请求副本（id 对不上集合里的接口），因此不能复用
     * saveResponseExample —— 这里直接按 caseItem.requestId 定位接口写入 doc。
     * 去重 / 字段继承 / 文档组装全部复用 buildResponseExample。
     */
    saveCaseResponseExample: (caseId) => {
      const state = get();
      const response = state.response;
      const caseItem = state.snapshot.cases.find((item) => item.id === caseId);
      if (!response || !caseItem) return "missing";
      const requestId = caseItem.requestId;
      const request = state.snapshot.collections
        .flatMap((collection) => collection.items)
        .find((item) => item.id === requestId);
      if (!request) return "missing";
      const base = request.doc ?? emptyDoc();
      const built = buildResponseExample(response, base, {
        name: `示例 ${response.status}`,
        description: `来自用例「${caseItem.name}」`,
      });
      if (built.result === "duplicate") return "duplicate";
      const doc = built.doc;
      writeDoc(requestId, doc);
      // 接口标签重新打开时 draft 会从快照重载；若接口此刻恰好处于激活状态，
      // 同步刷新 live draft，避免展示旧文档。
      if (state.draft.id === requestId) {
        set({ draft: { ...state.draft, doc } });
      }
      return "added";
    },

    updateResponseExample: (id, patch) => {
      const state = get();
      // No activeTab guard — doc edits must not be silently dropped.
      const base = state.draft.doc ?? emptyDoc();
      const doc: RequestDoc = {
        ...base,
        responses: base.responses.map((example) =>
          example.id === id ? { ...example, ...patch } : example,
        ),
        updatedAt: Date.now(),
      };
      set({ draft: { ...state.draft, doc } });
      mutate((snapshot) => ({
        ...snapshot,
        collections: snapshot.collections.map((collection) => ({
          ...collection,
          items: collection.items.map((item) =>
            item.id === state.draft.id ? { ...item, doc } : item,
          ),
        })),
      }));
    },

    deleteResponseExample: (id) => {
      const state = get();
      // No activeTab guard — doc edits must not be silently dropped.
      const base = state.draft.doc ?? emptyDoc();
      const doc: RequestDoc = {
        ...base,
        responses: base.responses.filter((example) => example.id !== id),
        updatedAt: Date.now(),
      };
      set({ draft: { ...state.draft, doc } });
      mutate((snapshot) => ({
        ...snapshot,
        collections: snapshot.collections.map((collection) => ({
          ...collection,
          items: collection.items.map((item) =>
            item.id === state.draft.id ? { ...item, doc } : item,
          ),
        })),
      }));
    },

    // ---- response parameter documentation (per response example) ----

    addResponseParam: (exampleId, location = "body") => {
      patchDoc((base) => ({
        ...base,
        responses: base.responses.map((example) =>
          example.id === exampleId
            ? {
                ...example,
                params: [
                  ...normalizeResponseParams(example.params),
                  emptyResponseParam(location),
                ],
              }
            : example,
        ),
      }));
    },

    updateResponseParam: (exampleId, paramId, patch) => {
      patchDoc((base) => ({
        ...base,
        responses: base.responses.map((example) =>
          example.id === exampleId
            ? {
                ...example,
                params: normalizeResponseParams(example.params).map((row) =>
                  row.id === paramId ? { ...row, ...patch } : row,
                ),
              }
            : example,
        ),
      }));
    },

    deleteResponseParam: (exampleId, paramId) => {
      patchDoc((base) => ({
        ...base,
        responses: base.responses.map((example) =>
          example.id === exampleId
            ? {
                ...example,
                params: normalizeResponseParams(example.params).filter(
                  (row) => row.id !== paramId,
                ),
              }
            : example,
        ),
      }));
    },

    generateResponseParams: (exampleId) => {
      const base = get().draft.doc ?? emptyDoc();
      const example = base.responses.find((item) => item.id === exampleId);
      if (!example) return 0;
      const existing = normalizeResponseParams(example.params);
      const derived = deriveResponseParams(example.body, example.contentType);
      if (derived.length === 0) return 0;
      const keys = new Set(existing.map((row) => `${row.location}:${row.name}`));
      const added = derived.filter(
        (row) => !keys.has(`${row.location}:${row.name}`),
      ).length;
      const params = mergeResponseParams(existing, derived);
      patchDoc((doc) => ({
        ...doc,
        responses: doc.responses.map((item) =>
          item.id === exampleId ? { ...item, params } : item,
        ),
      }));
      return added;
    },

  };
};
