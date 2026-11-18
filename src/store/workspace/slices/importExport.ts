import { api } from "../../../lib/api.ts";
import { normalizeCase, normalizeRequest, normalizeScenario } from "../../../lib/defaults.ts";
import { uid } from "../../../lib/id.ts";
import { moveFolderInTree } from "../../../lib/collectionTree.ts";
import { moveRequestInTree } from "../../../lib/collectionTree.ts";
import { renameFolderInTree } from "../../../lib/collectionTree.ts";
import { renameRequestInTree } from "../../../lib/collectionTree.ts";
import { normalizeFolderPath } from "../../../lib/importTarget.ts";
import { mergeImportedEnvironments } from "../../../lib/importTarget.ts";
import { placeImportedCollections } from "../../../lib/importTarget.ts";
import type { ImportSummary } from "../../../lib/importTarget.ts";
import { exportFormatSpec, renderExportAsync } from "../../../lib/exportFormats.ts";
import { detectFormat } from "../../../lib/transfer.ts";
import { importCurl } from "../../../lib/transfer.ts";
import { importHar } from "../../../lib/transfer.ts";
import { importInsomnia } from "../../../lib/transfer.ts";
import { importOpenApi } from "../../../lib/transfer.ts";
import { importPostman } from "../../../lib/transfer.ts";
import { importPostmanEnvironment } from "../../../lib/transfer.ts";
import { importTestAssets } from "../../../lib/transfer.ts";
import { decodeTestAssets } from "../../../lib/testAssets.ts";
import type { DecodedTestAssets } from "../../../lib/testAssets.ts";
import type { ImportResult } from "../../../lib/transfer.ts";
import type { Collection } from "../../../types.ts";
import type { RequestDraft } from "../../../types.ts";
import type { ApiCase, ScenarioDataSet, ScriptSnippet, TestScenario, TestSuite, WorkspaceSettings } from "../../../types.ts";
import { messageOf } from "../helpers.ts";
import { clone } from "../helpers.ts";
import type { StoreContext } from "../context.ts";
import type { ImportExportSlice } from "../types.ts";
import { t } from "../../../i18n/index.ts";

export const createImportExportSlice = (ctx: StoreContext): ImportExportSlice => {
  const { set, get, mutate } = ctx;
  return {
    // ---- Import / export ----

    importContent: (content, sourceLabel, target) => {
      const format = detectFormat(content);
      let result: ImportResult;
      let testAssets: DecodedTestAssets | null = null;
      try {
        if (format === "test-assets") {
          result = importTestAssets(content);
          testAssets = decodeTestAssets(result.testAssets);
        } else if (format === "postman") result = importPostman(content);
        else if (format === "postman-env") result = importPostmanEnvironment(content);
        else if (format === "openapi") result = importOpenApi(content);
        else if (format === "har") result = importHar(content);
        else if (format === "insomnia") result = importInsomnia(content);
        else if (sourceLabel?.startsWith("curl") || content.trim().startsWith("curl")) {
          result = importCurl(content);
        } else {
          result = importCurl(content);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : t("store.import.failed");
        get().pushConsole({ level: "error", source: "import", text: t("store.import.failedLog", { message }) });
        set({ saveError: t("store.import.failedMsg", { message}) });
        return null;
      }

      // T2.1：测试资产包不带请求集合。importTestAssets 返回的 collections 只是
      // 导入弹窗的只读预览数据，沿用下面的集合导入链路会把工作区集合洗成空。
      if (testAssets) {
        const decoded = testAssets;
        const base = get().snapshot;
        const identity = function <T>(value: T): T { return value; };
        const upsert = function <T extends { id: string }>(
          current: T[],
          incoming: Record<string, unknown>[],
          normalize: (raw: T) => T,
        ): { items: T[]; added: number; overwritten: number } {
          const byId = new Map(current.map((item) => [item.id, item]));
          let added = 0;
          let overwritten = 0;
          for (const raw of incoming) {
            if (typeof raw.id !== "string" || raw.id.trim() === "") continue;
            // 保留原 id：场景步骤的 caseId、套件 items 的 refId 靠它引用。
            const payload = raw as unknown as T;
            const existing = byId.get(payload.id);
            // 本机时间戳 / 运行历史 / 同步标记不随包导出，合并时保留本地值。
            byId.set(payload.id, normalize(existing ? { ...existing, ...payload } : payload));
            if (existing) overwritten += 1;
            else added += 1;
          }
          return { items: [...byId.values()], added, overwritten };
        };
        const cases = upsert<ApiCase>(base.cases ?? [], decoded.cases, normalizeCase);
        const scenarios = upsert<TestScenario>(base.scenarios ?? [], decoded.scenarios, normalizeScenario);
        const suites = upsert<TestSuite>(base.suites ?? [], decoded.suites, identity);
        const scripts = upsert<ScriptSnippet>(base.scriptLibrary ?? [], decoded.scriptLibrary, identity);
        // CSV 数据集按 scenarioId 回填：投影已内联在 scenario.dataSet，这里补齐只带
        // csvDataSets 而没有内联 dataSet 的旧版资产包。
        const csvByScenario = new Map<string, Record<string, unknown>>();
        for (const row of decoded.csvDataSets) {
          const id = row.scenarioId;
          const dataSet = row.dataSet;
          if (typeof id === "string" && id && dataSet && typeof dataSet === "object" && !Array.isArray(dataSet)) {
            csvByScenario.set(id, dataSet as Record<string, unknown>);
          }
        }
        const mergedScenarios = scenarios.items.map((scenario) => (
          scenario.dataSet || !csvByScenario.has(scenario.id)
            ? scenario
            : normalizeScenario({ ...scenario, dataSet: csvByScenario.get(scenario.id) as unknown as ScenarioDataSet })
        ));
        const settingsPatch: Partial<WorkspaceSettings> = {};
        if (typeof decoded.document.globalPreScript === "string") {
          settingsPatch.globalPreScript = decoded.document.globalPreScript;
        }
        if (typeof decoded.document.globalPostScript === "string") {
          settingsPatch.globalPostScript = decoded.document.globalPostScript;
        }
        mutate((snapshot) => ({
          ...snapshot,
          cases: cases.items,
          scenarios: mergedScenarios,
          suites: suites.items,
          scriptLibrary: scripts.items,
          settings: { ...snapshot.settings, ...settingsPatch },
        }));
        const warnings = [...result.warnings];
        if (decoded.privateVariableNames.length > 0) {
          warnings.push(t("store.import.privateVars", { count: decoded.privateVariableNames.length }));
        }
        if (decoded.environmentVariableNames.length > 0) {
          warnings.push(t("store.import.envVars", { count: decoded.environmentVariableNames.length }));
        }
        warnings.push(t("store.import.dbWarning"));
        const summary: ImportSummary = {
          format: "test-assets",
          addedRequests: 0,
          overwrittenRequests: 0,
          duplicateIncoming: 0,
          addedEnvironments: 0,
          mergedEnvironments: 0,
          warnings,
        };
        get().pushConsole({
          level: warnings.length > 0 ? "warn" : "info",
          source: "import",
          text: t("store.import.testAssetsDone", {
            casesAdded: cases.added,
            casesOverwritten: cases.overwritten,
            scenariosAdded: scenarios.added,
            scenariosOverwritten: scenarios.overwritten,
            suitesAdded: suites.added,
            suitesOverwritten: suites.overwritten,
            scriptsAdded: scripts.added,
            scriptsOverwritten: scripts.overwritten,
            assertions: decoded.assertionRules.length,
            mocks: decoded.mockRules.length,
          }) +
            (warnings.length > 0 ? t("store.import.hintsSuffix", { count: warnings.length }) : ""),
        });
        return summary;
      }

      const incoming: Collection[] = result.collections.map((raw) => ({
        id: uid(),
        name: raw.name,
        items: raw.items.map((item) => normalizeRequest(item)),
      }));
      // 环境与接口一样按身份合并：重复导入不再每轮追加一份同名环境，
      // 本地填好的 token / 密码等变量值也不会被默认值冲掉。
      const environmentMerge = mergeImportedEnvironments(
        get().snapshot.environments,
        result.environments.map((raw) => ({
          name: raw.name,
          variables: raw.variables,
          headers: [],
        })),
        uid,
      );
      const firstEnvName = result.environments[0]?.name?.trim() ?? "";
      const autoActivateId = firstEnvName
        ? environmentMerge.environments.find((item) => item.name.trim() === firstEnvName)?.id ?? null
        : null;

      // Placement is pure: an existing target collection absorbs every parsed
      // request, otherwise new collections are created as before. `mutate` runs
      // synchronously, so `get().snapshot.collections` is the same array the
      // updater below receives.
      const before = get().snapshot.collections;
      const placement = placeImportedCollections(before, incoming, target, uid);
      mutate((snapshot) => ({
        ...snapshot,
        collections: placement.collections,
        environments: environmentMerge.environments,
        // 导入 Postman 集合 / 环境文件时，若当前没有激活环境就自动激活第一份，
        // 让 {{baseUrl}} 等变量导入后立刻可用；不覆盖用户已经选好的环境。
        activeEnvironmentId: snapshot.activeEnvironmentId ?? autoActivateId,
      }));
      // 被覆盖的接口若正好开在编辑器里，草稿必须同步，否则下一次保存会把
      // 旧定义写回去。只在目标集合 == 当前激活集合时刷新，避免草稿跨集合搬家。
      if (
        placement.overwrittenRequestIds.length > 0 &&
        get().activeCollectionId === placement.targetCollectionId &&
        placement.overwrittenRequestIds.includes(get().draft.id)
      ) {
        // 从 mutate 之后的快照取，行协议已打过时间戳，草稿与落盘内容一致。
        const refreshed = get().snapshot.collections
          .find((item) => item.id === placement.targetCollectionId)
          ?.items.find((item) => item.id === get().draft.id);
        if (refreshed) set({ draft: { ...refreshed } });
      }
      // Deliberately do NOT switch `activeCollectionId` here: saveRequest()
      // uses it as the destination, so changing it while another request is
      // open would append a duplicate copy of the unsaved draft into the
      // imported collection. The dialog reports the destination instead.
      const destination = placement.createdCollections > 0
        ? t("store.import.createdCollections", { count: placement.createdCollections })
        : t("store.import.intoCollection", {
            name: before.find((item) => item.id === placement.targetCollectionId)?.name ?? "—",
          });
      const folderText = target?.folderMode === "keep" || !target
        ? t("store.import.folderKeep")
        : target.folderMode === "root"
          ? t("store.import.folderRoot")
          : normalizeFolderPath(target.folder ?? "") || t("store.import.folderRoot");
      const warnings = [...result.warnings];
      if (placement.duplicateIncoming > 0) {
        warnings.push(
          t("store.import.duplicates", { count: placement.duplicateIncoming }),
        );
      }
      const summary: ImportSummary = {
        format: format === "unknown" ? "curl" : format,
        addedRequests: placement.addedRequests,
        overwrittenRequests: placement.overwrittenRequests,
        duplicateIncoming: placement.duplicateIncoming,
        addedEnvironments: environmentMerge.added,
        mergedEnvironments: environmentMerge.merged,
        warnings,
      };
      get().pushConsole({
        level: warnings.length > 0 ? "warn" : "info",
        source: "import",
        text: t("store.import.done", {
          format: summary.format,
          added: summary.addedRequests,
          overwritten: summary.overwrittenRequests,
          destination,
          folder: folderText,
          envAdded: summary.addedEnvironments,
          envMerged: summary.mergedEnvironments,
        }) +
          (warnings.length > 0 ? t("store.import.warningsSuffix", { count: warnings.length }) : ""),
      });
      if (warnings.length > 0) {
        set({ saveError: t("store.import.completedWithWarnings", { warnings: warnings.slice(0, 3).join("；") }) });
      }
      return summary;
    },

    exportAs: async (format, password) => {
      const spec = exportFormatSpec(format);
      try {
        // 唯一的导出渲染入口：内部统一调用 redact.ts 的 redactSnapshot +
        // redactFreeText，任何格式（含文档站 / SDK）都不会绕过脱敏出口。
        const content = await renderExportAsync(get().snapshot, format, {
          password: password || undefined,
        });
        const path = await api.saveTextFile(spec.fileName, content);
        get().pushConsole({
          level: "info",
          source: "import",
          text: t("store.export.done", { label: spec.label, version: spec.version, path }),
        });
      } catch (error) {
        if (messageOf(error).includes("取消")) return;
        set({ saveError: t("store.export.failed", { message: messageOf(error) }) });
      }
    },

    // ---- Collection tree ----

    moveRequest: (collectionId, requestId, folder) => {
      mutate((snapshot) => ({
        ...snapshot,
        collections: snapshot.collections.map((collection) =>
          collection.id === collectionId
            ? {
                ...collection,
                items: collection.items.map((item) =>
                  item.id === requestId ? { ...item, folder } : item,
                ),
              }
            : collection,
        ),
      }));
    },

    renameRequest: (requestId, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const before = get().snapshot.collections;
      if (renameRequestInTree(before, requestId, trimmed) !== before) {
        mutate((snapshot) => ({
          ...snapshot,
          collections: renameRequestInTree(snapshot.collections, requestId, trimmed),
        }));
      }
      // The editor's name field and a not-yet-saved draft tab must follow
      // immediately. A direct patch keeps the draft in sync without creating
      // a revision entry; `stampSharedChanges` still bumps row-level
      // `updatedAt` (but not `contentUpdatedAt`, so cases stay fresh).
      const draft = get().draft;
      if (draft.id === requestId && draft.name !== trimmed) {
        set({ draft: { ...draft, name: trimmed } });
      }
    },

    moveRequestTo: (source, target) => {
      const before = get().snapshot.collections;
      if (moveRequestInTree(before, source, target) === before) return;
      mutate((snapshot) => ({
        ...snapshot,
        collections: moveRequestInTree(snapshot.collections, source, target),
      }));
      // saveRequest() writes back to activeCollectionId; after a
      // cross-collection drag both that id and draft.folder must point at the
      // new owner or the next save would move the request back.
      const state = get();
      if (state.activeTab?.kind === "request" && state.activeTab.id === source.requestId) {
        set({
          activeCollectionId: target.collectionId,
          draft: { ...state.draft, folder: target.folder.trim() },
        });
      }
    },

    moveFolderTo: (source, target) => {
      const before = get().snapshot.collections;
      if (moveFolderInTree(before, source, target) === before) return;
      mutate((snapshot) => ({
        ...snapshot,
        collections: moveFolderInTree(snapshot.collections, source, target),
      }));
      const state = get();
      const from = source.path.trim();
      const current = (state.draft.folder ?? "").trim();
      if (from && (current === from || current.startsWith(`${from}/`))) {
        const parent = target.folder.trim();
        const name = from.split("/").filter(Boolean).pop() ?? "";
        const to = parent ? `${parent}/${name}` : name;
        const isOpen =
          state.activeTab?.kind === "request" && state.activeTab.id === state.draft.id;
        set({
          ...(isOpen ? { activeCollectionId: target.collectionId } : {}),
          draft: { ...state.draft, folder: `${to}${current.slice(from.length)}` },
        });
      }
    },

    duplicateRequest: (collectionId, requestId) => {
      const state = get();
      const collection = state.snapshot.collections.find((item) => item.id === collectionId);
      const source = collection?.items.find((item) => item.id === requestId);
      if (!collection || !source) return;
      const copy: RequestDraft = {
        ...clone(source),
        id: uid(),
        name: `${source.name} 副本`,
        updatedAt: Date.now(),
      };
      mutate((snapshot) => ({
        ...snapshot,
        collections: snapshot.collections.map((item) =>
          item.id === collectionId
            ? { ...item, items: [...item.items, copy] }
            : item,
        ),
      }));
    },

    renameFolder: (collectionId, from, to) => {
      const before = get().snapshot.collections;
      if (renameFolderInTree(before, collectionId, from, to) === before) return;
      mutate((snapshot) => ({
        ...snapshot,
        collections: renameFolderInTree(snapshot.collections, collectionId, from, to),
      }));
      const state = get();
      const source = from.trim();
      const destination = to.trim();
      const current = (state.draft.folder ?? "").trim();
      if (source && (current === source || current.startsWith(`${source}/`))) {
        set({
          draft: {
            ...state.draft,
            folder: `${destination}${current.slice(source.length)}`,
          },
        });
      }
    },

  };
};
