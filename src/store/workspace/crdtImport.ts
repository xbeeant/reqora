/**
 * 协议 v2 在云同步 slice 里的接线层。
 *
 * 为了让灰度可控，v1（基线 + 三方合并 + LWW）完整保留在 slices/cloud.ts。
 * 这里只做三件事：
 *   1. 能力探测：GET /crdt/bootstrap 不可用 → 返回 false，调用方原样走 v1；
 *   2. 一轮 v2 往返 → 写回本地快照、持久化 doc 状态、把冲突投给既有 UI；
 *   3. 冲突裁决：v2 模式下改走「产生新 CRDT change」，不再用时间戳 LWW。
 *
 * 一旦某空间进入了 v2，就不自动退回 v1：两个真相源正是这次要根除的缺陷。
 */
import type { StoreContext } from "./context.ts";
import type { CloudProjectRef } from "../../lib/cloudConnection.ts";
import {
  setCloudImportResult,
  cloudProjectFor,
} from "../../lib/cloudConnection.ts";
import { createCloudCrdtTransport } from "../../lib/cloudCrdt.ts";
import {
  crdtConflictsToEntries,
  normalizeCrdtState,
  runCrdtSync,
  type CrdtSyncOutcome,
  type CrdtSyncState,
} from "../../lib/crdtSync.ts";
import {
  CRDT_ROW_DOMAINS,
  base64ToBytes,
  crdtHeads,
  loadCrdtDoc,
  projectRows,
  resolveCrdtConflict,
  saveCrdtDoc,
  stableJson,
  bytesToBase64,
  type CrdtResolution,
  type CrdtRowDomain,
} from "../../lib/crdtDoc.ts";
import {
  clearSyncConflicts,
  sanitizeRowsForUpload,
  saveSyncConflicts,
  stripForUpload,
} from "../../lib/cloudSync.ts";
import { crdtDocStore } from "../../lib/syncStateStore.ts";
import {
  restoreRowsCredentials,
  rowsToSnapshot,
  snapshotToRows,
  type WorkspaceRowsPayload,
} from "../../lib/workspaceRows.ts";
import type { WorkspaceSnapshot } from "../../types.ts";
import { t } from "../../i18n/index.ts";

const emptyRows = (): WorkspaceRowsPayload => ({
  folders: [],
  requests: [],
  environments: [],
  cases: [],
  scenarios: [],
  suites: [],
  artifacts: [],
});

async function loadState(
  localProjectId: string,
  cloudProjectId: number,
): Promise<CrdtSyncState | null> {
  const raw = await crdtDocStore.load(localProjectId);
  if (!raw || typeof raw.cloudProjectId !== "number") return null;
  if (raw.cloudProjectId !== cloudProjectId) return null;
  return normalizeCrdtState(raw.state, cloudProjectId);
}

async function saveState(
  localProjectId: string,
  cloudProjectId: number,
  state: CrdtSyncState,
): Promise<void> {
  await crdtDocStore.save(localProjectId, {
    cloudProjectId,
    state: state as unknown as Record<string, unknown>,
  });
}

/** 解绑 / 换服务端 / 换空间时作废本地 CRDT 副本，避免把旧空间的变更投到新空间。 */
export function clearCrdtState(localProjectId: string): void {
  void crdtDocStore.remove(localProjectId);
}

/** 换服务端：所有项目的 v2 状态一起作废（与 v1 的 clearAllSyncBaselines 对齐）。 */
export function clearAllCrdtStates(): void {
  void crdtDocStore.clearAll();
}

function countRows(rows: WorkspaceRowsPayload): number {
  return CRDT_ROW_DOMAINS.reduce(
    (total, domain) =>
      total + ((rows[domain] as unknown[] | undefined) ?? []).filter(
        (row) => !(row as { deleted?: boolean }).deleted,
      ).length,
    0,
  );
}

function redactedRows(snapshot: WorkspaceSnapshot): WorkspaceRowsPayload {
  const rows = snapshotToRows(stripForUpload(snapshot) as unknown as WorkspaceSnapshot);
  return sanitizeRowsForUpload(rows).payload;
}

/**
 * 尝试用 v2 完成这一轮同步。
 * @returns true = 已由 v2 处理（调用方直接 return）；false = 服务端不支持，走 v1。
 */
export async function runCrdtCloudImport(
  ctx: StoreContext,
  target: CloudProjectRef,
  localProjectId: string,
  downloadOnly: boolean,
): Promise<boolean> {
  const { get, set, persistFull, cloudView, cloudConflictsView } = ctx;
  const transport = createCloudCrdtTransport(target.id);
  // 探测是唯一允许「静默回退」的地方：旧服务端没有这个路由。
  const probe = await transport.bootstrap();
  if (!probe) return false;

  const state = await loadState(localProjectId, target.id);
  // 仅下载：本地行集一律按空处理，绝不把旧空间的残留数据/墓碑推上新空间。
  // CRDT diff 对「doc 有而 desired 没有」保持远端权威，因此数据照样能拉下来。
  const desired = downloadOnly ? emptyRows() : redactedRows(get().snapshot);
  const outcome: CrdtSyncOutcome = await runCrdtSync({
    state,
    cloudProjectId: target.id,
    desired,
    transport,
  });
  if (!outcome.supported || !outcome.rows) return false;

  // 投影写回本地：先按本机行回填凭据，再用当前快照作 base 保留 history/trash
  // /settings 等本机域。墓碑只在服务端确认删除后清，未 ack 的删除留待重放。
  const localRows = snapshotToRows(get().snapshot);
  const restored = restoreRowsCredentials(outcome.rows, localRows);
  const merged = rowsToSnapshot(restored, get().snapshot);
  if (outcome.deletionsAcknowledged) merged.tombstones = [];
  set({ snapshot: merged });
  persistFull();

  await saveState(localProjectId, target.id, outcome.state);
  const entries = crdtConflictsToEntries(outcome.conflicts);
  if (entries.length) {
    await saveSyncConflicts(localProjectId, target.id, entries);
  } else {
    await clearSyncConflicts(localProjectId);
  }

  setCloudImportResult({
    at: Date.now(),
    version: outcome.stats.version,
    projectId: target.id,
    projectName: target.name,
    localProjectId,
  });

  const localProjectName =
    get().projectsState?.projects.find((project) => project.active)?.name ??
    t("store.cloud.defaultProject");
  const space = target.name || target.slug;
  const justBound = get().cloudJustBound;
  const reuseHint =
    justBound === "created"
      ? t("store.cloud.justCreated")
      : justBound === "bound"
        ? t("store.cloud.justBound")
        : "";
  const conflictHint = entries.length
    ? t("store.cloud.conflictHint", { count: entries.length })
    : "";
  const notice = downloadOnly
    ? t("store.cloud.downloadDone", {
        space,
        project: localProjectName,
        rows: countRows(outcome.rows),
        version: outcome.stats.version,
      })
    : t("store.cloud.syncDone", {
        project: localProjectName,
        space,
        rows: outcome.stats.put + outcome.stats.remove + outcome.stats.restored,
        chunks: "",
        blobs: "",
        version: outcome.stats.version,
        reuse: reuseHint,
        sanitize: "",
        conflicts: conflictHint,
      });

  set({
    cloudBusy: false,
    cloudJustBound: null,
    cloudNotice: notice,
    ...cloudView(),
    ...(await cloudConflictsView()),
  });
  return true;
}

/**
 * v2 模式下的冲突裁决。返回 false 表示当前项目不在 v2（调用方走 v1 裁决）。
 *
 * `useLocal=true` → 保留冲突里的 live / 本地候选；`false` → 删除或采用远端候选。
 * 裁决结果是一笔新 change，会经日志投递给所有副本，不会在下一轮复活。
 */
export interface CrdtResolutionRequest {
  localProjectId: string;
  domain: string;
  id: string;
  /** local = 保留本地/复活侧；remote = 采用远端/删除侧；row = 字段级合成行；delete = 显式删除。 */
  choice: "local" | "remote" | "row" | "delete";
  row?: Record<string, unknown> | null;
  localRow?: Record<string, unknown> | null;
}

export async function resolveCrdtConflictIfActive(
  request: CrdtResolutionRequest,
): Promise<boolean> {
  const { localProjectId, domain, id, choice, row, localRow } = request;
  const target = cloudProjectFor(localProjectId);
  if (!target) return false;
  const state = await loadState(localProjectId, target.id);
  if (!state?.doc) return false;
  if (!CRDT_ROW_DOMAINS.includes(domain as CrdtRowDomain)) return false;

  const doc = loadCrdtDoc(base64ToBytes(state.doc), state.actorId);
  const bucket = doc.domains[domain as CrdtRowDomain];
  const live = bucket[id];

  let resolution: CrdtResolution;
  if (choice === "delete") {
    resolution = { type: "delete" };
  } else if (choice === "row") {
    resolution = row ? { type: "row", row } : { type: "delete" };
  } else if (choice === "local") {
    const kept = localRow ?? (live ? { ...live } : null);
    resolution = kept ? { type: "row", row: kept } : { type: "delete" };
  } else {
    // 用云端 = 放弃本地这一侧。delete-vs-edit 里「删除」就是远端侧；
    // 并发双改时若没有明确的远端候选行，则保留 CRDT 胜出的值并结案。
    const isDeleteConflict = doc.tombstones[id] !== undefined && live !== undefined;
    resolution = isDeleteConflict
      ? { type: "delete" }
      : live
        ? { type: "row", row: { ...live } }
        : { type: "delete" };
  }

  // 直接调用纯裁决函数，再自己投递：这样即使 postChanges 失败，新的 doc
  // 与 pending 也会一起落盘，下一轮重放；不会「裁决了但没上传」。
  const result = resolveCrdtConflict(
    doc,
    domain as CrdtRowDomain,
    id,
    resolution,
    state.actorId,
  );
  const nextState: CrdtSyncState = {
    ...state,
    doc: bytesToBase64(saveCrdtDoc(result.doc)),
    heads: crdtHeads(result.doc),
    // 裁决改写了 doc，投影基准必须同步推进，否则下一轮会把裁决前的旧行
    // 当成「本地新编辑」重新 put 回去。
    projected: stableJson(projectRows(result.doc)),
    pending: [
      ...state.pending,
      ...result.changes.map((change) => bytesToBase64(change)),
    ],
  };
  await saveState(localProjectId, target.id, nextState);
  try {
    const transport = createCloudCrdtTransport(target.id);
    await transport.postChanges(result.changes);
    await saveState(localProjectId, target.id, { ...nextState, pending: [] });
  } catch {
    // 留在 pending，下一轮同步自动重放；裁决本身不回滚。
  }
  // 只移除本条冲突由调用方 finishResolution 负责（可能还有其它待裁决条目）。
  return true;
}

/** 供诊断/测试读取当前 v2 状态（不触发网络）。 */
export async function readCrdtState(
  localProjectId: string,
  cloudProjectId: number,
): Promise<CrdtSyncState | null> {
  return loadState(localProjectId, cloudProjectId);
}
