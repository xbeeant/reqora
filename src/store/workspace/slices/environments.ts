import { uid } from "../../../lib/id.ts";
import { api } from "../../../lib/api.ts";
import { applyEnvMerge } from "../../../lib/environment.ts";
import { builtinCodeTemplates } from "../../../lib/codeTemplate.ts";
import { builtinDocPages } from "../../../lib/docPages.ts";
import { moveDocPage as shiftDocPage } from "../../../lib/docPages.ts";
import { newDocPage } from "../../../lib/docPages.ts";
import { normalizeDocPages } from "../../../lib/docPages.ts";
import type { Environment } from "../../../types.ts";
import type { KeyValue } from "../../../types.ts";
import type { StoreContext } from "../context.ts";
import type { EnvironmentsSlice } from "../types.ts";

export const createEnvironmentsSlice = (ctx: StoreContext): EnvironmentsSlice => {
  const { get, mutate } = ctx;
  return {
    addEnvironment: () => {
      const state = get();
      const environment: Environment = {
        id: uid(),
        name: `环境 ${state.snapshot.environments.length + 1}`,
        variables: [{ id: uid(), key: "", value: "", enabled: true }],
        headers: [{ id: uid(), key: "", value: "", enabled: true }],
      };
      mutate((snapshot) => ({
        ...snapshot,
        environments: [...snapshot.environments, environment],
        activeEnvironmentId: environment.id,
      }));
    },

    renameEnvironment: (id, name) => {
      mutate((snapshot) => ({
        ...snapshot,
        environments: snapshot.environments.map((environment) =>
          environment.id === id ? { ...environment, name } : environment,
        ),
      }));
    },

    deleteEnvironment: (id) => {
      mutate((snapshot) => {
        const environments = snapshot.environments.filter(
          (environment) => environment.id !== id,
        );
        return {
          ...snapshot,
          environments,
          // Keep variables usable after deleting the active environment by
          // falling back to the first remaining one instead of "无环境".
          activeEnvironmentId:
            snapshot.activeEnvironmentId === id
              ? (environments[0]?.id ?? null)
              : snapshot.activeEnvironmentId,
        };
      });
    },

    updateEnvironmentVariables: (id, variables) => {
      mutate((snapshot) => ({
        ...snapshot,
        environments: snapshot.environments.map((environment) =>
          environment.id === id ? { ...environment, variables } : environment,
        ),
      }));
    },

    setActiveEnvironment: (id) => {
      mutate((snapshot) => ({ ...snapshot, activeEnvironmentId: id }));
    },

    duplicateEnvironment: (id) => {
      mutate((snapshot) => {
        const source = snapshot.environments.find((item) => item.id === id);
        if (!source) return snapshot;
        const copyRow = (row: KeyValue): KeyValue => ({ ...row, id: uid() });
        const copy: Environment = {
          id: uid(),
          name: `${source.name || "环境"} 副本`,
          variables: (source.variables ?? []).map(copyRow),
          headers: (source.headers ?? []).map(copyRow),
        };
        return {
          ...snapshot,
          environments: [...snapshot.environments, copy],
          activeEnvironmentId: copy.id,
        };
      });
    },

    updateEnvironmentHeaders: (id, headers) => {
      mutate((snapshot) => ({
        ...snapshot,
        environments: snapshot.environments.map((environment) =>
          environment.id === id ? { ...environment, headers } : environment,
        ),
      }));
    },

    mergeEnvironments: (sourceId, targetId, selection) => {
      mutate((snapshot) => {
        const source = snapshot.environments.find((item) => item.id === sourceId);
        if (!source || sourceId === targetId) return snapshot;
        return {
          ...snapshot,
          environments: snapshot.environments.map((environment) =>
            environment.id === targetId
              ? {
                  ...environment,
                  variables: applyEnvMerge(
                    environment.variables,
                    source.variables,
                    selection.variableKeys,
                    selection.overwrite,
                  ),
                  // Header 名不区分大小写；变量名区分。
                  headers: applyEnvMerge(
                    environment.headers ?? [],
                    source.headers ?? [],
                    selection.headerKeys,
                    selection.overwrite,
                    true,
                  ),
                }
              : environment,
          ),
        };
      });
    },

    addCodeTemplate: () => {
      mutate((snapshot) => ({
        ...snapshot,
        codeTemplates: [
          ...(snapshot.codeTemplates ?? []),
          {
            id: uid(),
            name: `自定义模板 ${(snapshot.codeTemplates ?? []).length + 1}`,
            description: "",
            language: "",
            content: `// {{name}} · {{method}} {{url}}
const response = await fetch({{{urlJson}}}, {
  method: "{{method}}",
  headers: {{{headersJson}}},{{#if hasBody}}
  body: {{{bodyJson}}},{{/if}}
});
`,
          },
        ],
      }));
    },

    addBuiltinCodeTemplates: () => {
      mutate((snapshot) => {
        const existing = new Set((snapshot.codeTemplates ?? []).map((item) => item.name));
        const additions = builtinCodeTemplates().filter((item) => !existing.has(item.name));
        return additions.length > 0
          ? { ...snapshot, codeTemplates: [...(snapshot.codeTemplates ?? []), ...additions] }
          : snapshot;
      });
    },

    updateCodeTemplate: (id, patch) => {
      mutate((snapshot) => ({
        ...snapshot,
        codeTemplates: (snapshot.codeTemplates ?? []).map((item) =>
          item.id === id ? { ...item, ...patch } : item,
        ),
      }));
    },

    deleteCodeTemplate: (id) => {
      mutate((snapshot) => ({
        ...snapshot,
        codeTemplates: (snapshot.codeTemplates ?? []).filter((item) => item.id !== id),
      }));
    },

    addDocPage: (group = "guide") => {
      mutate((snapshot) => ({
        ...snapshot,
        docPages: [...(snapshot.docPages ?? []), newDocPage("新章节", group)],
      }));
    },

    addBuiltinDocPages: () => {
      mutate((snapshot) => {
        const existing = new Set((snapshot.docPages ?? []).map((item) => item.slug));
        const additions = builtinDocPages().filter((item) => !existing.has(item.slug));
        return additions.length > 0
          ? { ...snapshot, docPages: [...(snapshot.docPages ?? []), ...additions] }
          : snapshot;
      });
    },

    updateDocPage: (id, patch) => {
      mutate((snapshot) => ({
        ...snapshot,
        // slug 由编辑面板显式维护；改标题不自动重算，避免已分享出去的锚点失效。
        docPages: (snapshot.docPages ?? []).map((item) =>
          item.id === id ? { ...item, ...patch } : item,
        ),
      }));
    },

    deleteDocPage: (id) => {
      mutate((snapshot) => ({
        ...snapshot,
        docPages: (snapshot.docPages ?? []).filter((item) => item.id !== id),
      }));
    },

    moveDocPage: (id, delta) => {
      mutate((snapshot) => ({
        ...snapshot,
        docPages: shiftDocPage(snapshot.docPages ?? [], id, delta),
      }));
    },

    setDocPages: (pages) => {
      mutate((snapshot) => ({ ...snapshot, docPages: normalizeDocPages(pages) }));
    },

    clearHistory: () => {
      mutate((snapshot) => ({ ...snapshot, history: [] }));
    },

    updateSettings: (patch) => {
      mutate((snapshot) => ({
        ...snapshot,
        settings: { ...snapshot.settings, ...patch },
      }));
      // 快照存储上限需要单独同步到本地 SQLite 存储层（其余引擎上限随请求下发）。
      // 非桌面环境（浏览器 / 测试）invoke 会失败，best-effort 吞掉。
      if (typeof patch.maxWorkspaceBytes === "number") {
        void api.setWorkspaceLimit(patch.maxWorkspaceBytes).catch(() => {});
      }
    },

  };
};
