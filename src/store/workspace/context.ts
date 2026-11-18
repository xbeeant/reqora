import { api, ApiClientError } from "../../lib/api.ts";
import { loadSyncConflicts } from "../../lib/cloudSync.ts";
import type { SyncConflictRecord } from "../../lib/cloudSync.ts";
import { cloudProjectFor } from "../../lib/cloudConnection.ts";
import { readCloudConnection } from "../../lib/cloudConnection.ts";
import { setCloudProjectFor } from "../../lib/cloudConnection.ts";
import { writeCloudConnection } from "../../lib/cloudConnection.ts";
import { emptyDoc, normalizeSnapshot } from "../../lib/defaults.ts";
import { uid } from "../../lib/id.ts";
import type { HistoryEntry } from "../../types.ts";
import type { RequestDoc } from "../../types.ts";
import type { RequestDraft } from "../../types.ts";
import type { WorkspaceSnapshot } from "../../types.ts";
import type { StoreApi } from "zustand";
import { messageOf } from "./helpers.ts";
import { clone } from "./helpers.ts";
import { MAX_HISTORY } from "./helpers.ts";
import { deltaRowsFromDirty, stampSharedChanges } from "./rowProtocol.ts";
import type { AuxDirty, DirtyEntry } from "./rowProtocol.ts";
import type { WorkspaceDeltaPayload } from "../../lib/workspaceRows.ts";
import { t } from "../../i18n/index.ts";
import { decideExternalChange, registerExternalChangeApi } from "./externalChanges.ts";
import { mergeExternalDelta } from "./externalMerge.ts";
import type { WorkspaceState } from "./types.ts";

export type WorkspaceSet = StoreApi<WorkspaceState>["setState"];
export type WorkspaceGet = StoreApi<WorkspaceState>["getState"];
export interface StoreRuntime {
  persistTimer?: ReturnType<typeof setTimeout>;
  initializationStarted: boolean;
  /** 行级增量保存的 pending 队列（键 = `${kind}:${id}`，防抖窗口内同实体合并）。 */
  pendingRows: Map<string, DirtyEntry>;
  pendingHistory: Map<string, { id: string; at: number; data: unknown }>;
  pendingHistoryDeletes: Set<string>;
  pendingTrash: Map<string, { id: string; deletedAt: number; data: unknown }>;
  pendingTrashDeletes: Set<string>;
  pendingRevisions: Map<string, { requestId: string; id: string; at: number; data: unknown }>;
  pendingRevisionDeletes: Set<string>;
  pendingMeta: Map<string, unknown>;
  /** 整份保存兜底：导入 / 种子 / 本机域变更 / 绕过 commit 的批量写路径。 */
  pendingFullSave: boolean;
  /** 是否有保存请求在途（防止并发写与 rev 竞态）。 */
  saving: boolean;
}

export const createContext = (set: WorkspaceSet, get: WorkspaceGet) => {
  const runtime: StoreRuntime = {
    initializationStarted: false,
    pendingRows: new Map(),
    pendingHistory: new Map(),
    pendingHistoryDeletes: new Set(),
    pendingTrash: new Map(),
    pendingTrashDeletes: new Set(),
    pendingRevisions: new Map(),
    pendingRevisionDeletes: new Set(),
    pendingMeta: new Map(),
    pendingFullSave: false,
    saving: false,
  };

  /**
   * Project the persisted connection config into store state. Called at boot
   * and after every cloud action — purely local, so an offline backend can
   * never delay or change workspace initialization.
   */
  const cloudView = () => {
    const connection = readCloudConnection();
    const localId = get().projectsState?.activeProjectId ?? "default";
    const space = cloudProjectFor(localId);
    return {
      cloudBaseUrl: connection.baseUrl,
      cloudUser: connection.user,
      cloudLoggedIn: connection.session !== null,
      cloudProjectId: space?.id ?? null,
      cloudProjectName: space?.name ?? null,
      cloudLastImport: connection.lastImport,
      cloudLastImportError: connection.lastImportError,
    };
  };

  /**
   * 读取当前本地项目待裁决的冲突。冲突明细现在存在项目 SQLite，读取是异步的；
   * 精简列表给设置页提示条，完整记录（base/local/remote）给字段级合并弹窗。
   */
  const cloudConflictsView = async (): Promise<{
    cloudConflicts: Array<{ domain: string; id: string; name: string }>;
    cloudConflictRecord: SyncConflictRecord | null;
  }> => {
    const localId = get().projectsState?.activeProjectId ?? "default";
    const record = await loadSyncConflicts(localId);
    return {
      cloudConflicts: (record?.entries ?? []).map((entry) => ({
        domain: entry.domain,
        id: entry.id,
        name: entry.name,
      })),
      cloudConflictRecord: record,
    };
  };

  /** Restore the login/connection state at startup, without any network call. */
  const hydrateCloud = (snapshot?: WorkspaceSnapshot) => {
    let connection = readCloudConnection();
    // One-time migration from the legacy snapshot-bound cloud settings.
    const legacyUrl = snapshot?.settings.cloudBaseUrl?.trim() ?? "";
    if (!connection.baseUrl && legacyUrl) {
      writeCloudConnection({ baseUrl: legacyUrl.replace(/\/+$/, "") });
      connection = readCloudConnection();
    }
    const legacyProjectId = Number(snapshot?.settings.cloudProjectId ?? 0);
    const localId = get().projectsState?.activeProjectId ?? "default";
    if (connection.baseUrl && legacyProjectId > 0 && !cloudProjectFor(localId)) {
      setCloudProjectFor(localId, {
        id: legacyProjectId,
        name: "",
        slug: "",
      });
    }
    set({ ...cloudView(), cloudConflicts: [], cloudConflictRecord: null });
    void cloudConflictsView().then((view) => set(view));
  };

  /** P0: the WebView holds the whole snapshot in memory. Every auto-save
   * carries the revision it loaded, so an MCP / CLI write into the same
   * workspace.db is detected instead of being silently overwritten by the
   * next 400 ms debounce. A pending conflict pauses auto-save until the user
   * picks "reload" (keep external changes) or "backup + overwrite". */
  const hasQueuedEdits = () =>
    runtime.pendingRows.size > 0 ||
    runtime.pendingHistory.size > 0 ||
    runtime.pendingHistoryDeletes.size > 0 ||
    runtime.pendingTrash.size > 0 ||
    runtime.pendingTrashDeletes.size > 0 ||
    runtime.pendingRevisions.size > 0 ||
    runtime.pendingRevisionDeletes.size > 0 ||
    runtime.pendingMeta.size > 0 ||
    runtime.pendingFullSave;

  /** 未落盘的本地编辑（含在途保存）——外部写入裁决用。 */
  const hasPendingEdits = () =>
    Boolean(runtime.persistTimer) || runtime.saving || hasQueuedEdits();

  const clearPending = () => {
    runtime.pendingRows.clear();
    runtime.pendingHistory.clear();
    runtime.pendingHistoryDeletes.clear();
    runtime.pendingTrash.clear();
    runtime.pendingTrashDeletes.clear();
    runtime.pendingRevisions.clear();
    runtime.pendingRevisionDeletes.clear();
    runtime.pendingMeta.clear();
    runtime.pendingFullSave = false;
  };

  const queueDirty = (dirty: DirtyEntry[], aux: AuxDirty) => {
    for (const entry of dirty) {
      runtime.pendingRows.set(`${entry.kind}:${entry.id}`, entry);
    }
    for (const row of aux.history) runtime.pendingHistory.set(row.id, row);
    for (const id of aux.historyDeletes) runtime.pendingHistoryDeletes.add(id);
    for (const row of aux.trash) runtime.pendingTrash.set(row.id, row);
    for (const id of aux.trashDeletes) runtime.pendingTrashDeletes.add(id);
    for (const row of aux.revisions) {
      runtime.pendingRevisions.set(`${row.requestId}\u0000${row.id}`, row);
    }
    for (const key of aux.revisionDeletes) {
      runtime.pendingRevisionDeletes.add(`${key.requestId}\u0000${key.id}`);
    }
  };

  /** meta 键（seeded / activeEnvironmentId / theme / settings）按引用比较收集。 */
  const queueMeta = (previous: WorkspaceSnapshot, next: WorkspaceSnapshot) => {
    if (previous.seeded !== next.seeded) runtime.pendingMeta.set("seeded", next.seeded);
    if (previous.activeEnvironmentId !== next.activeEnvironmentId) {
      runtime.pendingMeta.set("activeEnvironmentId", next.activeEnvironmentId);
    }
    if (previous.theme !== next.theme) runtime.pendingMeta.set("theme", next.theme ?? null);
    if (previous.settings !== next.settings) runtime.pendingMeta.set("settings", next.settings);
  };

  const buildDelta = (): WorkspaceDeltaPayload => {
    const delta: WorkspaceDeltaPayload = {
      rows: deltaRowsFromDirty([...runtime.pendingRows.values()]),
    };
    if (runtime.pendingHistory.size > 0) delta.history = [...runtime.pendingHistory.values()];
    if (runtime.pendingHistoryDeletes.size > 0) {
      delta.historyDeletes = [...runtime.pendingHistoryDeletes];
    }
    if (runtime.pendingTrash.size > 0) delta.trash = [...runtime.pendingTrash.values()];
    if (runtime.pendingTrashDeletes.size > 0) {
      delta.trashDeletes = [...runtime.pendingTrashDeletes];
    }
    if (runtime.pendingRevisions.size > 0) delta.revisions = [...runtime.pendingRevisions.values()];
    if (runtime.pendingRevisionDeletes.size > 0) {
      delta.revisionDeletes = [...runtime.pendingRevisionDeletes].map((key) => {
        const [requestId, id] = key.split("\u0000");
        return { requestId, id };
      });
    }
    if (runtime.pendingMeta.size > 0) {
      delta.meta = Object.fromEntries(runtime.pendingMeta) as WorkspaceDeltaPayload["meta"];
    }
    return delta;
  };

  const persist = () => {
    if (get().workspaceConflict) return;
    if (runtime.persistTimer) clearTimeout(runtime.persistTimer);
    runtime.persistTimer = setTimeout(() => {
      runtime.persistTimer = undefined;
      // 在途保存期间的新编辑：由 flushPending 的完成回调续派，避免并发写。
      if (runtime.saving) return;
      void flushPending();
    }, 400);
  };

  /** 绕过 commit() 的批量写路径（云同步合并 / CRDT 导入 / 回收站清理等）：
   * 变更无法用 dirty 行表达（含行删除），退回整份保存。 */
  const persistFull = () => {
    runtime.pendingFullSave = true;
    persist();
  };

  const flushPending = async () => {
    if (get().workspaceConflict) return;
    if (runtime.saving) return;
    const expectedRev = get().workspaceRev;
    // 捕获本次要发送的内容；保存成功后只清除这些条目，期间的新编辑保留。
    const sentRows = new Map(runtime.pendingRows);
    const sentHistory = new Map(runtime.pendingHistory);
    const sentTrash = new Map(runtime.pendingTrash);
    const sentRevisions = new Map(runtime.pendingRevisions);
    const sentHistoryDeletes = new Set(runtime.pendingHistoryDeletes);
    const sentTrashDeletes = new Set(runtime.pendingTrashDeletes);
    const sentRevisionDeletes = new Set(runtime.pendingRevisionDeletes);
    const sentMeta = new Map(runtime.pendingMeta);
    const nothingQueued =
      sentRows.size === 0 &&
      sentHistory.size === 0 &&
      sentHistoryDeletes.size === 0 &&
      sentTrash.size === 0 &&
      sentTrashDeletes.size === 0 &&
      sentRevisions.size === 0 &&
      sentRevisionDeletes.size === 0 &&
      sentMeta.size === 0;
    const full = runtime.pendingFullSave || nothingQueued;
    if (full && nothingQueued && !runtime.pendingFullSave) return;
    let saved = false;
    runtime.saving = true;
    try {
      const rev = full
        ? await api.saveWorkspace(get().snapshot, { expectedRev })
        : await api.saveWorkspaceRows(buildDelta(), { expectedRev });
      saved = true;
      if (full) {
        clearPending();
      } else {
        // 只清除本次已发送的条目；保存期间同一实体的新编辑（引用已变）保留。
        for (const [key, row] of sentRows) {
          if (runtime.pendingRows.get(key) === row) runtime.pendingRows.delete(key);
        }
        for (const [key, row] of sentHistory) {
          if (runtime.pendingHistory.get(key) === row) runtime.pendingHistory.delete(key);
        }
        for (const [key, row] of sentTrash) {
          if (runtime.pendingTrash.get(key) === row) runtime.pendingTrash.delete(key);
        }
        for (const [key, row] of sentRevisions) {
          if (runtime.pendingRevisions.get(key) === row) runtime.pendingRevisions.delete(key);
        }
        for (const key of sentHistoryDeletes) runtime.pendingHistoryDeletes.delete(key);
        for (const key of sentTrashDeletes) runtime.pendingTrashDeletes.delete(key);
        for (const key of sentRevisionDeletes) runtime.pendingRevisionDeletes.delete(key);
        for (const [key, value] of sentMeta) {
          if (runtime.pendingMeta.get(key) === value) runtime.pendingMeta.delete(key);
        }
      }
      // 我们自己的保存也推进计数器；保持基线同步，下一次编辑才不会被视为过期。
      set({ workspaceRev: rev?.rev ?? expectedRev ?? null });
      // 一次成功的自动保存让更早的瞬时 toast 过期。
      if (get().saveError?.startsWith(t("store.save.autoFailedPrefix"))) set({ saveError: null });
    } catch (error: unknown) {
      if (error instanceof ApiClientError && error.code === "WORKSPACE_CONFLICT") {
        // 保留 pending 队列，交给冲突条让用户选择。
        set({ workspaceConflict: messageOf(error), saveError: null });
        return;
      }
      set({ saveError: t("store.save.autoFailed", { message: messageOf(error) }) });
    } finally {
      runtime.saving = false;
      // 成功后若保存期间又有新编辑入队，立即续派（失败时等待下一次编辑触发，
      // 避免对持续报错的后端形成重试风暴）。
      if (saved && !get().workspaceConflict && hasQueuedEdits() && !runtime.persistTimer) {
        runtime.persistTimer = setTimeout(() => {
          runtime.persistTimer = undefined;
          void flushPending();
        }, 0);
      }
    }
  };

  /** Cancel the pending debounce and flush the CURRENT project before Rust
   * points the store at another directory. Otherwise a late timer would write
   * the old project's snapshot into the new project. */
  const flushBeforeSwitch = async () => {
    if (runtime.persistTimer) {
      clearTimeout(runtime.persistTimer);
      runtime.persistTimer = undefined;
    }
    try {
      await api.saveWorkspace(get().snapshot);
    } catch {
      // Best effort: switching must still leave the app usable.
    }
    // 整份保存已覆盖全部 pending；即使失败也不能把旧项目的队列带进新项目。
    clearPending();
  };

  /**
   * MCP / CLI 直接写 workspace.db，而 WebView 只在启动时把快照读进内存。
   * 没有这个监视器时，外部写入的用例要等下一次本地编辑触发自动保存、
   * 撞上 WORKSPACE_CONFLICT 才会被看见（而且表现为「写数据失败」）。
   * workspace_rev.writer 区分是谁改的：desktop 是我们自己未记帐的保存
   * （首次种子数据 / 项目切换 / 运行历史），其余一律是外部写入，需要刷新界面。
   */
  let watchTimer: ReturnType<typeof setInterval> | null = null;
  let checking = false;

  const checkExternalChanges = async (_reason = "poll") => {
    if (checking) return;
    const state = get();
    if (state.isLoading || state.workspaceConflict || state.workspaceRev === null) return;
    checking = true;
    try {
      const disk = await api.loadWorkspaceRev();
      const decision = decideExternalChange(
        disk,
        state.workspaceRev,
        hasPendingEdits(),
      );
      if (decision === "none") return;
      // 自己的写入只推进基线，不需要重载内存快照。
      if (decision === "advance-baseline") {
        set({ workspaceRev: disk.rev });
        return;
      }
      // 有未保存的本地编辑：不能静默丢弃，交给冲突条让用户选择。
      if (decision === "conflict") {
        set({ workspaceConflict: t("store.save.externalChangePending"), saveError: null });
        return;
      }
      // 优先增量合并：MCP / CLI 的写入通常只触碰几行，无需重载整份快照。
      // 结构漂移（位置/父级不一致）、版本倒退或旧版写入方不盖行水位时，
      // mergeExternalDelta 返回 null / 空条目 → 回退整份重载自愈。
      let merged = false;
      try {
        const delta = await api.loadWorkspaceDelta(state.workspaceRev);
        if (!delta.reset && Array.isArray(delta.entries)) {
          const advances = Number(delta.rev) > state.workspaceRev;
          if (advances && delta.entries.length > 0) {
            const nextSnapshot = mergeExternalDelta(get().snapshot, delta);
            if (nextSnapshot) {
              if (hasPendingEdits()) return;
              clearPending();
              set({
                // 与整份重载一样：不动 tabs / draft，避免吞掉编辑器内容。
                snapshot: nextSnapshot,
                workspaceRev: Number(delta.rev),
                workspaceConflict: null,
                saveError: null,
              });
              merged = true;
            }
          }
        }
      } catch {
        // 命令不存在（旧版二进制）或读取失败：静默回退整份重载。
      }
      if (merged) return;
      const [snapshotResult, revResult] = await Promise.allSettled([
        api.loadWorkspace(),
        api.loadWorkspaceRev(),
      ]);
      if (snapshotResult.status !== "fulfilled") return;
      // 读取期间用户可能又开始编辑；此时放弃这次自动刷新。
      if (hasPendingEdits()) return;
      clearPending();
      set({
        // 刻意不动 tabs / activeTab / draft：后台刷新绝不能吞掉编辑器里的
        // 未保存内容。用例、场景、侧栏等列表视图都直接读 snapshot，会立刻更新。
        snapshot: normalizeSnapshot(snapshotResult.value),
        workspaceRev: revResult.status === "fulfilled" ? revResult.value.rev : disk.rev,
        workspaceConflict: null,
        saveError: null,
      });
    } catch {
      // 纯浏览器开发模式没有 Tauri invoke，或 SQLite 短暂被锁：下个周期重试。
    } finally {
      checking = false;
    }
  };

  const externalChanges = {
    check: checkExternalChanges,
    start: () => {
      if (watchTimer) return;
      watchTimer = setInterval(() => void checkExternalChanges("poll"), 2000);
    },
    stop: () => {
      if (watchTimer) clearInterval(watchTimer);
      watchTimer = null;
    },
  };
  registerExternalChangeApi(externalChanges);

  /**
   * 所有共享域写入的统一出口：先跑业务 updater，再刷新行时间戳 / 生成墓碑。
   * `patch` 用于同时更新 tabs / draft 等非快照状态。变更行进入 pending
   * 队列，由 400ms 防抖后的 `save_workspace_rows` 行级落盘。
   */
  const commit = (next: WorkspaceSnapshot, patch: Partial<WorkspaceState> = {}) => {
    const previous = get().snapshot;
    const { stamped: snapshot, dirty, aux } = stampSharedChanges(previous, next);
    // 本机域（dbConnections / mcpServers）的删除无法用墓碑行表达，delta 不
    // 覆盖：变化时退回整份保存（低频设置操作，代价可接受）。
    if (
      previous.dbConnections !== next.dbConnections ||
      previous.mcpServers !== next.mcpServers
    ) {
      runtime.pendingFullSave = true;
    }
    queueDirty(dirty, aux);
    queueMeta(previous, next);
    set({ ...patch, snapshot });
    persist();
    return snapshot;
  };

  const mutate = (updater: (snapshot: WorkspaceSnapshot) => WorkspaceSnapshot) => {
    commit(updater(get().snapshot));
  };

  /** 把组装好的文档写回指定接口的集合记录（两个保存示例入口共用）。 */
  const writeDoc = (requestId: string, doc: RequestDoc) => {
    mutate((snapshot) => ({
      ...snapshot,
      collections: snapshot.collections.map((collection) => ({
        ...collection,
        items: collection.items.map((item) =>
          item.id === requestId ? { ...item, doc } : item,
        ),
      })),
    }));
  };

  /**
   * Single write path for response field documentation. Doc metadata is never
   * request content: it does not bump request.updatedAt (cases stay fresh) and
   * must work even when no request tab is focused.
   */
  const patchDoc = (updater: (doc: RequestDoc) => RequestDoc) => {
    const state = get();
    const doc: RequestDoc = { ...updater(state.draft.doc ?? emptyDoc()), updatedAt: Date.now() };
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
  };

  const recordHistory = (
    request: RequestDraft,
    status: number | null,
    timeMs: number,
    error?: string,
  ) => {
    const entry: HistoryEntry = {
      id: uid(),
      at: Date.now(),
      name: request.name,
      method: request.method,
      url: request.url,
      status,
      timeMs,
      error,
      request: clone(request),
    };
    mutate((snapshot) => ({
      ...snapshot,
      history: [entry, ...snapshot.history].slice(0, MAX_HISTORY),
    }));
  };

  return { set, get, runtime, cloudView, cloudConflictsView, hydrateCloud, persist, persistFull, flushPending, clearPending, flushBeforeSwitch, commit, mutate, writeDoc, patchDoc, recordHistory };
};

export type StoreContext = ReturnType<typeof createContext>;
