/**
 * 同步状态持久化仓储（通用 KV，按 namespace 隔离）。
 *
 * 桌面端：状态落在「当前项目」的 SQLite（`sync_baseline` 表，随工作区一起
 * 备份 / 迁移 data root），不再受 WebView 缓存清理、WebView 数据目录重建的
 * 影响。浏览器预览与单元测试没有 Tauri IPC，自动降级到 localStorage。
 *
 * 目前有两个 namespace：
 * - `baseline`：上次成功同步的服务端行集 + cursor（三方合并的祖先）；
 * - `conflicts`：待裁决冲突的完整 base / local / remote 三份行。冲突明细
 *   可能非常大（一个带响应体的请求行就能顶破 localStorage 5 MiB 配额），
 *   因此必须与基线一样走 SQLite。
 *
 * 兼容性：升级前写在 localStorage 里的状态，首次读取时一次性搬进 SQLite
 * 并删除旧键；SQLite 读写失败也降级到 localStorage（丢基线是良性的，只是
 * 下一轮同步退化为全量拉取 + LWW）。
 *
 * 所有操作串行化：调用方有 fire-and-forget 的清理动作（换服务端 / 解绑），
 * 必须保证「先清后读」的顺序，不能让未完成的异步删除被下一次同步读到。
 */
import { api } from "./api.ts";

export type SyncStateValue = Record<string, unknown>;

export interface SyncStateStore {
  load: (projectKey: string) => Promise<SyncStateValue | null>;
  save: (projectKey: string, value: SyncStateValue) => Promise<void>;
  remove: (projectKey: string) => Promise<void>;
  clearAll: () => Promise<void>;
}

export interface SyncStateStoreOptions {
  /** SQLite 里的键前缀。基线不带前缀（兼容上一版已落库的数据）。 */
  keyPrefix?: string;
  /** 升级前 localStorage 使用的键前缀。 */
  legacyPrefix: string;
  /** 清除失败时写时间戳墓碑使用的键前缀。 */
  tombPrefix: string;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Tauri v2 injects this on the WebView global; browsers and Node do not. */
function isDesktop(): boolean {
  return typeof globalThis !== "undefined" && "__TAURI_INTERNALS__" in globalThis;
}

function isRecord(value: unknown): value is SyncStateValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createSyncStateStore(options: SyncStateStoreOptions): SyncStateStore {
  const { keyPrefix = "", legacyPrefix, tombPrefix } = options;
  const dbKey = (projectKey: string) => `${keyPrefix}${projectKey}`;
  const localKey = (projectKey: string) => `${legacyPrefix}${projectKey}`;
  const tombKey = (projectKey: string) => `${tombPrefix}${projectKey}`;

  function parseLocal(key: string): SyncStateValue | null {
    try {
      const raw = storage()?.getItem(key);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeLocal(key: string, value: SyncStateValue): void {
    try {
      storage()?.setItem(key, JSON.stringify(value));
    } catch {
      // 配额不足等失败是良性的：下一轮同步退化为全量拉取。
    }
  }

  function removeLocal(key: string): void {
    try {
      storage()?.removeItem(key);
    } catch {
      // ignore
    }
  }

  function clearLocal(): void {
    try {
      const store = storage();
      if (!store) return;
      const doomed: string[] = [];
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        if (key?.startsWith(legacyPrefix) || key?.startsWith(tombPrefix)) doomed.push(key);
      }
      for (const key of doomed) store.removeItem(key);
    } catch {
      // ignore
    }
  }

  /**
   * 清除操作在 SQLite 侧失败时留下的标记。内存 set 保证本次进程内该键读到空；
   * localStorage 时间戳保证重启后旧状态也不会因为「清除没落盘」而复活。
   */
  const invalidated = new Set<string>();
  let invalidatedAll = false;
  const savedSinceInvalidation = new Set<string>();

  function tombAt(projectKey: string): number {
    try {
      const raw = storage()?.getItem(tombKey(projectKey));
      const value = raw === null || raw === undefined ? 0 : Number(raw);
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  function putTomb(projectKey: string): void {
    try {
      storage()?.setItem(tombKey(projectKey), String(Date.now()));
    } catch {
      // ignore：内存标记仍然生效
    }
  }

  function isBlocked(projectKey: string, value: SyncStateValue): boolean {
    if (invalidated.has(projectKey)) return true;
    if (invalidatedAll && !savedSinceInvalidation.has(projectKey)) return true;
    const clearedAt = tombAt(projectKey);
    const savedAt = typeof value.savedAt === "number" ? value.savedAt : 0;
    return clearedAt > 0 && savedAt < clearedAt;
  }

  /** 串行队列：即便前一个操作失败，后续操作也照常执行。 */
  let tail: Promise<unknown> = Promise.resolve();
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  }

  async function load(projectKey: string): Promise<SyncStateValue | null> {
    // localStorage 只在「SQLite 没有记录 / SQLite 不可用」时才解析：状态可能
    // 有好几 MB，正常增量同步不该为此多付一次 JSON.parse。
    const legacy = () => parseLocal(localKey(projectKey));
    if (isDesktop()) {
      try {
        const stored: unknown = await api.loadSyncBaseline(dbKey(projectKey));
        if (isRecord(stored)) {
          return isBlocked(projectKey, stored) ? null : stored;
        }
        // 旧版本升级后的第一次同步：把 localStorage 里的状态搬进 SQLite。
        const old = legacy();
        if (old && !isBlocked(projectKey, old)) {
          await api.saveSyncBaseline(dbKey(projectKey), { ...old, savedAt: Date.now() });
          removeLocal(localKey(projectKey));
          return old;
        }
        return null;
      } catch {
        // IPC / 数据库不可用：本地缓存仍能救回这一轮的状态。
        const old = legacy();
        return old && !isBlocked(projectKey, old) ? old : null;
      }
    }
    const old = legacy();
    return old && !isBlocked(projectKey, old) ? old : null;
  }

  async function save(projectKey: string, value: SyncStateValue): Promise<void> {
    // savedAt 是墓碑判断的依据：每次保存都刷新，避免「清 → 存残差记录」
    // 时被旧时间戳误判为已作废。
    const stamped: SyncStateValue = { ...value, savedAt: Date.now() };
    if (isDesktop()) {
      try {
        await api.saveSyncBaseline(dbKey(projectKey), stamped);
        removeLocal(localKey(projectKey));
        invalidated.delete(projectKey);
        savedSinceInvalidation.add(projectKey);
        return;
      } catch {
        // 落到 localStorage；下次读取会再尝试迁移到 SQLite。
      }
    }
    writeLocal(localKey(projectKey), stamped);
    invalidated.delete(projectKey);
    savedSinceInvalidation.add(projectKey);
  }

  async function remove(projectKey: string): Promise<void> {
    removeLocal(localKey(projectKey));
    invalidated.add(projectKey);
    savedSinceInvalidation.delete(projectKey);
    if (!isDesktop()) return;
    try {
      await api.clearSyncBaseline(dbKey(projectKey));
    } catch {
      putTomb(projectKey);
    }
  }

  async function clearAll(): Promise<void> {
    clearLocal();
    invalidatedAll = true;
    savedSinceInvalidation.clear();
    if (!isDesktop()) return;
    try {
      // Rust 侧清空整张 KV 表：基线与冲突记录一起作废（换服务端时本就都要清）。
      await api.clearAllSyncBaselines();
    } catch {
      // 无法逐个写墓碑（不知道所有项目键）；读取时由 invalidatedAll 兜底，
      // 且记录本身带 cloudProjectId，换服务端后 id 校验是第二道防线。
    }
  }

  return {
    load: (projectKey) => enqueue(() => load(projectKey)),
    save: (projectKey, value) => enqueue(() => save(projectKey, value)),
    remove: (projectKey) => enqueue(() => remove(projectKey)),
    clearAll: () => enqueue(clearAll),
  };
}

/** 基线：键不带前缀，兼容上一版已写入 SQLite 的数据。 */
export const syncBaselineStore = createSyncStateStore({
  legacyPrefix: "reqora.syncBaseline.",
  tombPrefix: "reqora.syncBaseline.cleared.",
});

/** 冲突明细：独立命名空间，与基线共用同一张随工作区备份的 KV 表。 */
export const syncConflictStore = createSyncStateStore({
  keyPrefix: "conflicts:",
  legacyPrefix: "reqora.syncConflicts.",
  tombPrefix: "reqora.syncConflicts.cleared.",
});

/**
 * Git-native 同步基线：上次成功同步后的「文件内容 + 脱敏行集」。行集是
 * 三方合并的共同祖先，文件内容用来判断目录是否被外部改写。与云基线同一张
 * 随工作区备份的 KV 表，但命名空间独立，切换通道不会互相污染。
 */
export const gitSyncStateStore = createSyncStateStore({
  keyPrefix: "git-sync:",
  legacyPrefix: "reqora.gitSync.",
  tombPrefix: "reqora.gitSync.cleared.",
});

/** Git-native 通道待裁决的冲突明细（与云冲突同样可能很大，必须走 SQLite）。 */
export const gitConflictStore = createSyncStateStore({
  keyPrefix: "git-conflicts:",
  legacyPrefix: "reqora.gitConflicts.",
  tombPrefix: "reqora.gitConflicts.cleared.",
});

/**
 * 同步协议 v2：Automerge 文档快照（A.save(doc) 的 base64）+ actorId / cursor /
 * pending change。与基线/冲突共用的这层 KV 在桌面端落在项目 SQLite，随工作区
 * 一起备份；二进制不直接入表，而是 base64 编码进 TEXT（见
 * docs/SYNC_PROTOCOL_V2.md 第 3 节的决策记录）。
 *
 * 命名空间独立：v2 状态不会被 v1 的 clearAllSyncBaselines / 解绑清理误伤之外的
 * 操作污染；解绑协作空间时由调用方显式 clear。
 */
export const crdtDocStore = createSyncStateStore({
  keyPrefix: "crdt-doc:",
  legacyPrefix: "reqora.crdtDoc.",
  tombPrefix: "reqora.crdtDoc.cleared.",
});
