/**
 * 云同步状态机（协议 v2 的纯逻辑层，见 docs/SYNC_PROTOCOL_V2.md）。
 *
 * 这里没有 fetch、没有 localStorage、没有 i18n：transport 由 cloudCrdt.ts 注入，
 * 本地状态由调用方读写。因此测试可以用内存假服务端把「离线、重放、并发、
 * 重复点击、旧服务端」全部跑一遍，而不需要浏览器或后端。
 *
 * 收敛的三条规则：
 *  - 拉取游标只推进到 **GET /changes 返回的 cursor**，不用 POST 返回的 cursor。
 *    后者可能已经包含协作方在拉取之后写入的变更，直接跳过去会漏投。
 *  - 未 ack 的 change 存在 state.pending，下一轮连同新的本地 change 一起重放；
 *    hash 唯一约束让重放只被记一次。
 *  - 本地 diff 为空 + 远端 change 全为已见 hash = 收敛，冲突集合恒为空。
 */
import type { WorkspaceRowsPayload } from "./workspaceRows.ts";
import {
  applyLocalRows,
  applyRemoteChanges,
  base64ToBytes,
  bytesToBase64,
  changeHash,
  collectCrdtConflicts,
  computeLocalEdits,
  crdtHeads,
  createGenesis,
  initFromGenesis,
  loadCrdtDoc,
  newActorId,
  projectRows,
  resolveCrdtConflict,
  saveCrdtDoc,
  stableJson,
  type CrdtChange,
  type CrdtConflict,
  type CrdtDocHandle,
  type CrdtResolution,
  type CrdtRowDomain,
} from "./crdtDoc.ts";
import type { SyncConflictEntry } from "./cloudSync.ts";

// ------------------------------------------------------------ 传输契约 ----

export interface CrdtSnapshotRef {
  /** A.save(doc) 的 base64；包含到 seq 为止的全部历史。 */
  doc: string;
  seq: number;
}

export interface CrdtBootstrap {
  /** null 表示这个协作空间还没有建立 genesis，由首个客户端 POST 建立。 */
  genesis: string | null;
  snapshot: CrdtSnapshotRef | null;
  heads: string[];
  cursor: number;
  version: number;
}

export interface CrdtChangeRecord {
  seq: number;
  hash: string;
  /** Automerge change 字节的 base64。 */
  payload: string;
}

export interface CrdtChangesPage {
  changes: CrdtChangeRecord[];
  /** 本次拉取见到的最大 seq；下一轮的 since。 */
  cursor: number;
  version: number;
}

export interface CrdtPostResult {
  accepted: string[];
  duplicates: string[];
  cursor: number;
  version: number;
}

/**
 * 服务端能力边界。bootstrap() 返回 null 表示旧服务端（没有 v2 端点），
 * 调用方必须原样回退 legacy 的 threeWayMerge 全链路。
 */
export interface CrdtTransport {
  bootstrap(): Promise<CrdtBootstrap | null>;
  createGenesis(genesis: string): Promise<CrdtBootstrap>;
  changes(since: number, limit?: number): Promise<CrdtChangesPage>;
  postChanges(changes: CrdtChange[]): Promise<CrdtPostResult>;
  /**
   * 可选：上传压缩快照以加速后续副本 bootstrap，失败不影响同步。
   * `seq` 必须是「这份 doc 确实包含到的服务端游标」（本轮拉取的 cursor），
   * 否则分页拉取未完成时上传的快照会让新副本漏掉后续 change。
   */
  postSnapshot?(doc: string, heads: string[], seq: number): Promise<void>;
}

// -------------------------------------------------------------- 本地状态 ----

export const CRDT_STATE_VERSION = 1;

export interface CrdtSyncState {
  version: number;
  cloudProjectId: number;
  /** 稳定 actor id：同一台机器对同一空间复用，保证 change 序号单调。 */
  actorId: string;
  /** A.save(doc) 的 base64；null 表示还没有本地副本。 */
  doc: string | null;
  genesis: string | null;
  cursor: number;
  heads: string[];
  /** 已写入本地 doc 但尚未被服务端确认的 change（base64）。 */
  pending: string[];
  /**
   * 上一轮写回本地的脱敏投影（stableJson）。它是下一轮识别「本地是否真的
   * 编辑过」的唯一基准；缺了它就会把缓存的旧行重新 put 回去，让远端删除复活。
   */
  projected: string | null;
}

export function createCrdtState(cloudProjectId: number): CrdtSyncState {
  return {
    version: CRDT_STATE_VERSION,
    cloudProjectId,
    actorId: newActorId(),
    doc: null,
    genesis: null,
    cursor: 0,
    heads: [],
    pending: [],
    projected: null,
  };
}

/** 兼容残缺/旧记录：任何字段不合法都退回全新状态，绝不带着坏 cursor 同步。 */
export function normalizeCrdtState(
  raw: unknown,
  cloudProjectId: number,
): CrdtSyncState {
  const fresh = createCrdtState(cloudProjectId);
  if (!raw || typeof raw !== "object") return fresh;
  const value = raw as Partial<CrdtSyncState>;
  const actorId =
    typeof value.actorId === "string" && /^[0-9a-f]{8,}$/.test(value.actorId)
      ? value.actorId
      : fresh.actorId;
  const cursor =
    typeof value.cursor === "number" && Number.isFinite(value.cursor) && value.cursor >= 0
      ? Math.floor(value.cursor)
      : 0;
  return {
    version: CRDT_STATE_VERSION,
    cloudProjectId,
    actorId,
    doc: typeof value.doc === "string" && value.doc ? value.doc : null,
    genesis: typeof value.genesis === "string" && value.genesis ? value.genesis : null,
    cursor,
    heads: Array.isArray(value.heads) ? value.heads.filter((h) => typeof h === "string") : [],
    pending: Array.isArray(value.pending)
      ? value.pending.filter((item): item is string => typeof item === "string")
      : [],
    projected: typeof value.projected === "string" && value.projected ? value.projected : null,
  };
}

// ---------------------------------------------------------------- 结果 ----

export interface CrdtSyncStats {
  pulled: number;
  pushed: number;
  duplicates: number;
  put: number;
  remove: number;
  restored: number;
  conflicts: number;
  version: number;
}

export interface CrdtSyncOutcome {
  /** false = 服务端不支持 v2，调用方走 legacy；其余字段均无意义。 */
  supported: boolean;
  state: CrdtSyncState;
  /** 脱敏行集；调用方需 restoreRowsCredentials + rowsToSnapshot 再写回快照。 */
  rows: WorkspaceRowsPayload | null;
  conflicts: CrdtConflict[];
  stats: CrdtSyncStats;
  /** true 表示本地删除已被服务端确认，调用方可以安全清 snapshot.tombstones。 */
  deletionsAcknowledged: boolean;
}

const emptyStats = (): CrdtSyncStats => ({
  pulled: 0,
  pushed: 0,
  duplicates: 0,
  put: 0,
  remove: 0,
  restored: 0,
  conflicts: 0,
  version: 0,
});

// ------------------------------------------------------------ 主状态机 ----

export interface RunCrdtSyncParams {
  state: CrdtSyncState | null;
  cloudProjectId: number;
  /** 本地脱敏行集（stripForUpload → snapshotToRows），含 deleted:true 墓碑行。 */
  desired: WorkspaceRowsPayload;
  transport: CrdtTransport;
  /** 是否在收敛后上传快照；默认每轮都传，便于新设备快速 bootstrap。 */
  uploadSnapshot?: boolean;
}

/**
 * 一次「与云端协作」的完整往返。任何一步抛错都由调用方捕获：state 不会被
 * 部分推进（只有全部成功后才返回新 state），未 ack 的 change 保留在旧 state
 * 的 pending 里，下一轮重放即可。
 */
export async function runCrdtSync(params: RunCrdtSyncParams): Promise<CrdtSyncOutcome> {
  const { cloudProjectId, desired, transport } = params;
  const state = normalizeCrdtState(params.state, cloudProjectId);
  const stats = emptyStats();

  let bootstrap = await transport.bootstrap();
  if (!bootstrap) {
    return {
      supported: false,
      state,
      rows: null,
      conflicts: [],
      stats,
      deletionsAcknowledged: false,
    };
  }
  // 并发首次 bootstrap：服务端只认第一条 genesis，后来者必须用服务端那份。
  if (!bootstrap.genesis) {
    bootstrap = await transport.createGenesis(bytesToBase64(createGenesis(state.actorId)));
  }
  if (!bootstrap.genesis) {
    throw new Error("crdt bootstrap returned no genesis");
  }
  const genesisB64 = bootstrap.genesis;
  const genesisBytes = base64ToBytes(genesisB64);
  stats.version = bootstrap.version;

  // 1) 恢复副本：genesis 变了（换绑/重装）→ 从服务端快照或全量历史重建。
  let doc: CrdtDocHandle;
  let cursor = state.cursor;
  const genesisChanged = state.genesis !== null && state.genesis !== genesisB64;
  const freshReplica = state.doc === null || genesisChanged;
  if (freshReplica) {
    if (bootstrap.snapshot) {
      doc = loadCrdtDoc(base64ToBytes(bootstrap.snapshot.doc), state.actorId);
      cursor = bootstrap.snapshot.seq;
    } else {
      doc = initFromGenesis(genesisBytes, state.actorId);
      cursor = 0;
    }
    state.genesis = genesisB64;
  } else {
    doc = loadCrdtDoc(base64ToBytes(state.doc as string), state.actorId);
  }

  // 2) 增量拉取并幂等应用（含自己上一轮已 ack 的 change，applyChanges 是 no-op）。
  const page = await transport.changes(cursor);
  const pulled = page.changes
    .slice()
    .sort((left, right) => left.seq - right.seq)
    .map((record) => base64ToBytes(record.payload));
  if (pulled.length) doc = applyRemoteChanges(doc, pulled, state.actorId);
  stats.pulled = pulled.length;
  stats.version = page.version || stats.version;
  const pullCursor = Math.max(cursor, page.cursor);

  // 3) 本地 diff → 一笔 change。只投「相对上次投影真正发生的本地编辑」：
  //    本地没动时 edits 恒为空（重复点击收敛点），远端的删除也不会被旧行撤销。
  let previousProjection: WorkspaceRowsPayload | null = null;
  if (state.projected) {
    try {
      previousProjection = JSON.parse(state.projected) as WorkspaceRowsPayload;
    } catch {
      previousProjection = null;
    }
  }
  const edits = computeLocalEdits(previousProjection, desired);
  const diff = applyLocalRows(doc, edits, state.actorId);
  doc = diff.doc;
  stats.put = diff.ops.put;
  stats.remove = diff.ops.remove;
  stats.restored = diff.ops.restored;

  // 4) 冲突检测：只认真正的并发值，不看点击次数 / 时间戳 / 基线新鲜度。
  const conflicts = collectCrdtConflicts(doc);
  stats.conflicts = conflicts.length;

  // 5) 推送：pending（上次未 ack）+ 本轮新 change。按 hash 去重，避免同一笔
  //    change 因重放被重复提交。
  const toPush: CrdtChange[] = [];
  const seen = new Set<string>();
  for (const encoded of state.pending) {
    try {
      const bytes = base64ToBytes(encoded);
      const hash = changeHash(bytes);
      if (!seen.has(hash)) {
        seen.add(hash);
        toPush.push(bytes);
      }
    } catch {
      // 损坏的 pending 项直接丢弃，不能让它卡住整个队列。
    }
  }
  for (const change of diff.changes) {
    const hash = changeHash(change);
    if (!seen.has(hash)) {
      seen.add(hash);
      toPush.push(change);
    }
  }

  let post: CrdtPostResult | null = null;
  if (toPush.length) post = await transport.postChanges(toPush);
  stats.pushed = post ? post.accepted.length : 0;
  stats.duplicates = post ? post.duplicates.length : 0;
  if (post) stats.version = post.version || stats.version;

  // 6) 只有 POST 成功（或没有待推送内容）才清 pending、推进游标。
  const acknowledged = toPush.length === 0 || post !== null;
  const nextState: CrdtSyncState = {
    ...state,
    doc: bytesToBase64(saveCrdtDoc(doc)),
    genesis: genesisB64,
    cursor: pullCursor,
    heads: crdtHeads(doc),
    pending: acknowledged ? [] : state.pending,
    projected: stableJson(projectRows(doc)),
  };

  if (params.uploadSnapshot !== false && transport.postSnapshot) {
    try {
      await transport.postSnapshot(nextState.doc as string, nextState.heads, pullCursor);
    } catch {
      // 快照只是加速手段，失败不影响收敛。
    }
  }

  return {
    supported: true,
    state: nextState,
    rows: projectRows(doc),
    conflicts,
    stats,
    deletionsAcknowledged: acknowledged,
  };
}

// ------------------------------------------------------ 裁决与 UI 映射 ----

/**
 * 把 CRDT 冲突映射成既有 SyncConflictEntry（cloudConflictsView / 裁决面板
 * 完全复用，不需要新 UI）。candidates[0] 作为「本地侧」，其余作为「远端侧」；
 * delete-vs-edit 的远端侧为 null，表达「删除」这一候选。
 */
export function crdtConflictsToEntries(conflicts: CrdtConflict[]): SyncConflictEntry[] {
  return conflicts.map((conflict) => {
    const local = conflict.live ?? conflict.candidates[0] ?? null;
    const remote =
      conflict.kind === "delete-vs-edit"
        ? null
        : (conflict.candidates.find((row) => stableKey(row) !== stableKey(local)) ??
          conflict.candidates[conflict.candidates.length - 1] ??
          null);
    return {
      domain: conflict.domain,
      id: conflict.id,
      name: conflict.name,
      // CRDT 不保留「共同祖先行」，字段级合并 UI 拿到 base=null 会安全退化为
      // 整行二选一；填台账对象反而会被当成祖先行合并出脏字段。
      base: null,
      local: (local ?? null) as Record<string, unknown> | null,
      remote: (remote ?? null) as Record<string, unknown> | null,
    };
  });
}

function stableKey(row: unknown): string {
  try {
    return JSON.stringify(row ?? null);
  } catch {
    return String(row);
  }
}

export interface ResolveCrdtParams {
  state: CrdtSyncState;
  domain: CrdtRowDomain;
  id: string;
  resolution: CrdtResolution;
  transport: CrdtTransport;
}

/**
 * 冲突裁决：在 doc 上产生一笔新 change 并立即投递。裁决结果因此会被日志
 * 送到所有副本，不会像 v1 那样在下一轮三方合并里被重新判成冲突。
 */
export async function resolveCrdtConflictRemote(
  params: ResolveCrdtParams,
): Promise<CrdtSyncState> {
  const { state, domain, id, resolution, transport } = params;
  if (!state.doc) throw new Error("crdt state has no local document");
  const doc = loadCrdtDoc(base64ToBytes(state.doc), state.actorId);
  const result = resolveCrdtConflict(doc, domain, id, resolution, state.actorId);
  const pending = [
    ...state.pending,
    ...result.changes.map((change) => bytesToBase64(change)),
  ];
  const next: CrdtSyncState = {
    ...state,
    doc: bytesToBase64(saveCrdtDoc(result.doc)),
    heads: crdtHeads(result.doc),
    pending,
    // 裁决改写了 doc，投影基准必须同步推进；否则下一轮会把裁决前的旧行
    // 当成「本地新编辑」重新 put 回去，冲突原地复活。
    projected: stableJson(projectRows(result.doc)),
  };
  await transport.postChanges(result.changes);
  return { ...next, pending: [] };
}
