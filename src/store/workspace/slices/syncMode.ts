/**
 * 同步通道选择 + Git-native 双向同步 + 两种通道之间的带数据转换。
 *
 * 设计要点：
 * - 同一个本地项目只能处在一个通道（local / server / git），配置按项目 id
 *   存在 appConfig（本机配置，不进工作区快照、不进同步内容）。
 * - Git 通道复用云同步的 7 域行模型与 threeWayMerge，基线是「上次成功同步
 *   的文件内容 + 脱敏行集」，冲突保留本地版本并等用户裁决；写盘前绝不覆盖
 *   Git 侧改动。
 * - 通道转换是显式动作：server→git 先收敛云端数据再导出成 Git 基线；
 *   git→server 先把文件合并回本地，再加盖迁移时间戳让本地行在首次上传的
 *   LWW 中获胜。两条方向都不删除任何一方的数据。
 */

import { api } from "../../../lib/api.ts";
import {
  DEFAULT_SYNC_MODE,
  getSyncModes,
  setSyncModeFor,
} from "../../../lib/appConfig.ts";
import type { SyncMode, SyncModeConfig } from "../../../lib/appConfig.ts";
import { clearSyncBaseline } from "../../../lib/cloudSync.ts";
import { cloudProjectFor, readCloudConnection } from "../../../lib/cloudConnection.ts";
import {
  planGitSync,
  snapshotToGitFiles,
  stampRowsForTransfer,
} from "../../../lib/gitNative.ts";
import type {
  GitSyncBaseline,
  GitSyncConflict,
  GitSyncFileSet,
} from "../../../lib/gitNative.ts";
import { projectGitSyncRows } from "../../../lib/gitMirror.ts";
import {
  gitConflictStore,
  gitSyncStateStore,
} from "../../../lib/syncStateStore.ts";
import { rowsToSnapshot, snapshotToRows } from "../../../lib/workspaceRows.ts";
import type { WorkspaceRowsPayload } from "../../../lib/workspaceRows.ts";
import { t } from "../../../i18n/index.ts";
import { messageOf } from "../helpers.ts";
import type { StoreContext } from "../context.ts";
import type { SyncModeSlice } from "../types.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function asBaseline(raw: Record<string, unknown> | null, dir: string): GitSyncBaseline | null {
  if (
    !raw ||
    raw.dir !== dir ||
    !isRecord(raw.files) ||
    !isRecord(raw.rows) ||
    !Array.isArray(raw.conflicts)
  ) {
    return null;
  }
  return {
    dir,
    files: raw.files as GitSyncFileSet,
    rows: raw.rows as unknown as WorkspaceRowsPayload,
    conflicts: raw.conflicts as GitSyncConflict[],
    at: typeof raw.at === "number" ? raw.at : 0,
  };
}

function asConflicts(raw: Record<string, unknown> | null): GitSyncConflict[] {
  if (!raw || !Array.isArray(raw.entries)) return [];
  return raw.entries.filter(isRecord).map((entry) => ({
    domain: String(entry.domain ?? ""),
    id: String(entry.id ?? ""),
    name: String(entry.name ?? ""),
    base: isRecord(entry.base) ? entry.base : null,
    local: isRecord(entry.local) ? entry.local : null,
    remote: isRecord(entry.remote) ? entry.remote : null,
  }));
}

const conflictKey = (domain: string, id: string): string => `${domain}:${id}`;

export const createSyncModeSlice = (ctx: StoreContext): SyncModeSlice => {
  const { set, get, persistFull } = ctx;

  const projectId = (): string => get().projectsState?.activeProjectId ?? "default";

  const loadConflicts = async (): Promise<GitSyncConflict[]> =>
    asConflicts(await gitConflictStore.load(projectId()));

  const saveConflicts = async (entries: GitSyncConflict[]): Promise<void> => {
    await gitConflictStore.save(projectId(), {
      entries: entries as unknown as Record<string, unknown>[],
    });
    set({ gitConflicts: entries });
  };

  const refreshGitStatus = async (): Promise<void> => {
    const dir = get().gitSyncDir;
    if (!dir) {
      set({ gitStatus: null });
      return;
    }
    try {
      set({ gitStatus: await api.gitSyncStatus(dir) });
    } catch {
      set({ gitStatus: null });
    }
  };

  /** 运行一个 git 动作；失败时把 git 自己的 stderr 带出来（不吞错误信息）。 */
  const runGit = async (
    dir: string,
    action: "init" | "pull" | "commit" | "push",
    message?: string,
    { fatal = true }: { fatal?: boolean } = {},
  ): Promise<string> => {
    const result = await api.gitSyncRun(dir, action, message);
    if (!result.ok) {
      const detail = (result.stderr || result.stdout).trim() || `exit ${result.code}`;
      if (fatal) throw new Error(t("sync.error.gitFailed", { action, message: detail }));
      return detail;
    }
    return result.stdout.trim();
  };

  return {
    // ---- 初始状态（缺省沿用既有的服务端协作行为） ----
    syncMode: DEFAULT_SYNC_MODE.mode,
    gitSyncDir: "",
    gitAutoPull: true,
    gitBusy: false,
    gitError: null,
    gitNotice: null,
    gitLastSyncAt: null,
    gitConflicts: [],
    gitResolutions: {},
    gitStatus: null,
    syncConverting: false,

    refreshSyncMode: async () => {
      const modes = await getSyncModes();
      const cfg: SyncModeConfig = modes[projectId()] ?? DEFAULT_SYNC_MODE;
      set({
        syncMode: cfg.mode,
        gitSyncDir: cfg.gitDir ?? "",
        gitAutoPull: cfg.gitAutoPull ?? true,
      });
      const conflicts = await loadConflicts();
      set({ gitConflicts: conflicts });
      if (cfg.mode === "git" && cfg.gitDir) void refreshGitStatus();
    },

    setSyncMode: async (mode: SyncMode) => {
      if (get().syncConverting) return;
      await setSyncModeFor(projectId(), { mode });
      set({
        syncMode: mode,
        gitError: null,
        gitNotice: t("sync.notice.modeChanged", { mode: t(`sync.mode.${mode}`) }),
      });
      if (mode === "git" && get().gitSyncDir) void refreshGitStatus();
    },

    setGitSyncDir: async (dir: string) => {
      const next = dir.trim();
      if (get().gitSyncDir === next) return;
      // 换目录后旧基线（上一个仓库的文件内容）不再是共同祖先，必须作废。
      await gitSyncStateStore.remove(projectId());
      await setSyncModeFor(projectId(), { gitDir: next });
      set({
        gitSyncDir: next,
        gitConflicts: [],
        gitResolutions: {},
        gitError: null,
        gitNotice: next ? t("sync.notice.dirChanged", { dir: next }) : null,
      });
      if (next) void refreshGitStatus();
    },

    pickGitSyncDir: async () => {
      const picked = await api.pickDirectory();
      if (picked) await get().setGitSyncDir(picked);
    },

    setGitAutoPull: async (value: boolean) => {
      await setSyncModeFor(projectId(), { gitAutoPull: value });
      set({ gitAutoPull: value });
    },

    refreshGitStatus,

    gitResolveConflict: (domain, id, choice) => {
      const key = conflictKey(domain, id);
      set({ gitResolutions: { ...get().gitResolutions, [key]: choice } });
    },

    gitApplyResolutions: async () => {
      if (Object.keys(get().gitResolutions).length === 0) return;
      await get().gitSyncNow({ pull: false });
    },

    /**
     * 一次完整的 Git-native 同步：可选 pull → 读文件 → 基线三方合并 →
     * 写回工作区 / 写回文件 → 保存新基线 → 可选 commit / push。
     * 有冲突时不写任何文件、不覆盖本地快照，只持久化冲突明细等待裁决。
     */
    gitSyncNow: async (options = {}) => {
      const state = get();
      if (state.gitBusy) return;
      const dir = state.gitSyncDir;
      if (!dir) {
        set({ gitError: t("sync.error.dirRequired") });
        return;
      }
      set({ gitBusy: true, gitError: null, gitNotice: null });
      try {
        let pullWarning = "";
        const shouldPull = options.pull === true || (options.pull === undefined && state.gitAutoPull);
        if (shouldPull) {
          const status = await api.gitSyncStatus(dir);
          if (status.available && status.repo) {
            // 无远端 / 无 tracking 分支的仓库 pull 会失败，但本地同步仍可继续：
            // 这里只把它作为提示带进同步结果，绝不阻断读写。
            pullWarning = await runGit(dir, "pull", undefined, { fatal: false });
          }
        }

        const files = await api.gitSyncReadFiles(dir);
        const baseline = asBaseline(await gitSyncStateStore.load(projectId()), dir);
        const plan = planGitSync(get().snapshot, files, {
          baseline,
          resolutions: get().gitResolutions,
        });

        if (plan.conflicts.length > 0) {
          await saveConflicts(plan.conflicts);
          set({
            gitBusy: false,
            gitNotice: t("sync.notice.conflictsFound", {
              count: plan.conflicts.length,
              warnings: [...plan.warnings, ...(pullWarning ? [pullWarning] : [])].join("；"),
            }),
            gitLastSyncAt: null,
          });
          void refreshGitStatus();
          return;
        }

        // 合并结果写回工作区（本机凭据已回填），再写回变更过的文件。
        set({ snapshot: plan.snapshot });
        persistFull();
        if (Object.keys(plan.changedFiles).length > 0) {
          await api.gitSyncWriteFiles(dir, plan.changedFiles);
        }
        await gitSyncStateStore.save(projectId(), {
          dir,
          files: plan.files,
          rows: plan.rows as unknown as Record<string, unknown>,
          conflicts: [],
          at: Date.now(),
        });
        await saveConflicts([]);
        set({
          gitResolutions: {},
          gitLastSyncAt: Date.now(),
        });

        if (options.commit) {
          await runGit(
            dir,
            "commit",
            options.message || t("sync.action.commitMessage"),
          );
        }
        if (options.push) await runGit(dir, "push");
        void refreshGitStatus();
        set({
          gitNotice: t("sync.notice.syncDone", {
            local: plan.localChanges,
            git: plan.gitChanges,
            files: Object.keys(plan.changedFiles).length,
            warnings: [...plan.warnings, ...(pullWarning ? [pullWarning] : [])].join("；"),
          }),
        });
      } catch (error) {
        set({ gitError: messageOf(error), gitNotice: null });
      } finally {
        set({ gitBusy: false });
      }
    },

    /**
     * 带数据转换：切换通道的同时把当前数据带到目标通道。
     * - → git：先在服务端通道收敛一次（已登录且已绑定才做），再把本地快照
     *   导出成 Git-native 文件作为新基线；旧仓库里已有的同名文件会被覆盖，
     *   这是「以当前工作区为准」的显式转换语义。
     * - → server：先把 Git 文件合并回本地，再给全部行加盖迁移时间戳，清掉
     *   云基线后走一次 cloudImport；本地行因此在 LWW 中胜出并被上传。
     */
    convertSyncChannel: async (target) => {
      const state = get();
      if (state.syncConverting) return;
      set({ syncConverting: true, gitError: null, cloudError: null, gitNotice: null });
      try {
        const id = projectId();
        const from = state.syncMode;
        if (target === "git") {
          const dir = state.gitSyncDir;
          if (!dir) throw new Error(t("sync.error.dirRequired"));
          const connection = readCloudConnection();
          if (from === "server" && connection.session && cloudProjectFor(id)) {
            await get().cloudImport();
            if (get().cloudError) throw new Error(get().cloudError as string);
          }
          const snapshot = get().snapshot;
          const files = snapshotToGitFiles(snapshot);
          const rows = projectGitSyncRows(snapshot);
          await api.gitSyncWriteFiles(dir, files);
          await gitSyncStateStore.save(id, {
            dir,
            files,
            rows: rows as unknown as Record<string, unknown>,
            conflicts: [],
            at: Date.now(),
          });
          await saveConflicts([]);
          await setSyncModeFor(id, { mode: "git", convertedFrom: from });
          const count = Object.keys(files).length;
          set({
            syncMode: "git",
            gitLastSyncAt: Date.now(),
            gitNotice: t("sync.notice.toGitDone", { files: count }),
          });
          void refreshGitStatus();
          return;
        }

        // ---- Git → 服务端 ----
        if (from === "git" && state.gitSyncDir) {
          await get().gitSyncNow({ pull: false });
          if (get().gitConflicts.length > 0 || get().gitError) {
            throw new Error(get().gitError ?? t("sync.error.resolveFirst"));
          }
        }
        const connection = readCloudConnection();
        if (!connection.baseUrl || !connection.session) {
          throw new Error(t("sync.error.loginRequired"));
        }
        const stamped = stampRowsForTransfer(snapshotToRows(get().snapshot), Date.now());
        set({ snapshot: rowsToSnapshot(stamped, get().snapshot) });
        persistFull();
        await clearSyncBaseline(id);
        await get().cloudImport();
        if (get().cloudError || get().cloudPickerOpen) {
          throw new Error(get().cloudError ?? t("sync.error.bindSpaceFirst"));
        }
        await setSyncModeFor(id, { mode: "server", convertedFrom: from });
        set({
          syncMode: "server",
          cloudNotice: t("sync.notice.toServerDone", {
            rows: Object.values(stamped).reduce(
              (total, list) => total + (Array.isArray(list) ? list.length : 0),
              0,
            ),
          }),
        });
      } catch (error) {
        set({ gitError: messageOf(error), gitNotice: null });
      } finally {
        set({ syncConverting: false });
      }
    },

    /** 自动同步心跳：按用户选择的通道分派，本地模式静默跳过。 */
    syncAutoTick: async () => {
      const state = get();
      const minutes = state.snapshot.settings.autoSyncMinutes ?? 5;
      if (minutes <= 0 || state.isLoading || state.syncConverting) return;
      if (state.syncMode === "server") {
        await get().cloudAutoSyncTick();
        return;
      }
      if (state.syncMode !== "git") return;
      if (
        !state.gitSyncDir ||
        state.gitBusy ||
        state.gitConflicts.length > 0 ||
        Object.keys(state.gitResolutions).length > 0
      ) {
        return;
      }
      await get().gitSyncNow();
    },
  };
};

