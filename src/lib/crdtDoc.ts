/**
 * Automerge CRDT 文档核心（同步协议 v2，见 docs/SYNC_PROTOCOL_V2.md）。
 *
 * 这个模块只做纯逻辑：文档结构、快照编解码、本地 diff → change、远端 change
 * 幂等应用、冲突检测与裁决。它不碰网络、不碰 localStorage、不碰 i18n，
 * 因此可以在 Node 测试、浏览器预览和 Tauri WebView 里得到完全一致的行为。
 *
 * 三条设计约束（都是实测过的 Automerge 3 行为，别「优化」掉）：
 *  1. 所有副本必须 A.load() 同一份 genesis。各自 A.from() 会产生各自的
 *     init change，merge 后 root map 分叉、数据直接变空。
 *  2. 产生 change 前必须 A.clone()：Automerge 不允许对「还有旧指针」的
 *     document 做 mutating change（Attempting to change an out of date document）。
 *  3. map key 的删除是 add-wins 的反面：并发的 delete 与 put 合并后 key 会
 *     复活。所以删除额外写 tombstones 台账，冲突检测才能识别 delete-vs-edit。
 *
 * 值一律先过 plain()：Automerge 不接受 undefined / NaN / 函数，本地行对象里
 * 这些值必须被清洗成 JSON 兼容形态，否则 change 会写入失败或产生假差异。
 */
import * as Automerge from "@automerge/automerge";
import type { WorkspaceRowsPayload } from "./workspaceRows.ts";

export const CRDT_SCHEMA = "reqora.crdt.v1";

/** 与统一行模型、上传分块顺序完全一致的 7 个共享域。 */
export const CRDT_ROW_DOMAINS = [
  "folders",
  "requests",
  "environments",
  "cases",
  "scenarios",
  "suites",
  "artifacts",
] as const;
export type CrdtRowDomain = (typeof CRDT_ROW_DOMAINS)[number];

/** 一行 = 一个 JSON 对象；id 是 map key，不重复存进值里也没关系（保留原样）。 */
export type CrdtRow = Record<string, unknown>;

export interface CrdtTombstone {
  domain: CrdtRowDomain;
  /** 删除发生时的本地墙钟时间，仅用于展示与审计，不参与裁决。 */
  at: number;
  actor: string;
}

/**
 * 文档结构。刻意用 type alias 而不是 interface：Automerge 的
 * `from<T extends Record<string, unknown>>` 约束不接受没有索引签名的 interface。
 */
export type ReqoraCrdtDoc = {
  schema: string;
  domains: {
    folders: Record<string, CrdtRow>;
    requests: Record<string, CrdtRow>;
    environments: Record<string, CrdtRow>;
    cases: Record<string, CrdtRow>;
    scenarios: Record<string, CrdtRow>;
    suites: Record<string, CrdtRow>;
    artifacts: Record<string, CrdtRow>;
  };
  /** 删除台账永久保留；它是 delete-vs-edit 冲突检测的唯一依据。 */
  tombstones: Record<string, CrdtTombstone>;
  /**
   * 预留：共享设置。当前阶段 **不参与同步** —— 本地 settings 含大量本机项，
   * 由 rowsToSnapshot(rows, currentSnapshot) 原样保留，避免协作把本机偏好洗掉。
   */
  meta: { settings: Record<string, unknown> };
};

export type CrdtDocHandle = Automerge.Doc<ReqoraCrdtDoc>;
export type CrdtChange = Uint8Array;

// ------------------------------------------------------------ 基础工具 ----

/** 生成 Automerge 要求的偶数长度 hex actor id（不得跨线程并发使用同一个）。 */
export function newActorId(): string {
  const bytes = new Uint8Array(8);
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** JSON 兼容化：去 undefined / 函数，NaN·Infinity → null，并剥掉 Automerge 代理。 */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

/** 稳定序列化：对象键顺序不同不产生假 diff（v1 用过同一思路）。 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 极老运行时（没有 btoa/atob，且没有 Node Buffer 类型）的纯 JS 兜底。 */
function base64EncodeFallback(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : BASE64_ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : BASE64_ALPHABET[b2 & 63];
  }
  return out;
}

function base64DecodeFallback(encoded: string): Uint8Array {
  const clean = encoded.replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let position = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_ALPHABET.indexOf(clean[i]);
    const c1 = BASE64_ALPHABET.indexOf(clean[i + 1]);
    const c2 = BASE64_ALPHABET.indexOf(clean[i + 2]);
    const c3 = BASE64_ALPHABET.indexOf(clean[i + 3]);
    if (position < bytes.length) bytes[position++] = ((c0 << 2) | (c1 >> 4)) & 255;
    if (c2 >= 0 && position < bytes.length) bytes[position++] = ((c1 << 4) | (c2 >> 2)) & 255;
    if (c3 >= 0 && position < bytes.length) bytes[position++] = ((c2 << 6) | c3) & 255;
  }
  return bytes.subarray(0, position);
}

/** 大数组不能一次性 fromCharCode（会爆栈），分块拼字符串。 */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "function") return base64EncodeFallback(bytes);
  let binary = "";
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(encoded: string): Uint8Array {
  if (typeof atob !== "function") return base64DecodeFallback(encoded);
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// -------------------------------------------------------- 文档生命周期 ----

export function emptyCrdtShape(): ReqoraCrdtDoc {
  return {
    schema: CRDT_SCHEMA,
    domains: {
      folders: {},
      requests: {},
      environments: {},
      cases: {},
      scenarios: {},
      suites: {},
      artifacts: {},
    },
    tombstones: {},
    meta: { settings: {} },
  };
}

/** 共享 genesis 字节。一个协作空间只生成一次，之后所有副本都 load 这一份。 */
export function createGenesis(actorId: string): Uint8Array {
  return Automerge.save(Automerge.from(emptyCrdtShape(), actorId));
}

/** 从快照字节恢复可写文档（load 之后可直接 change，已实测）。 */
export function loadCrdtDoc(bytes: Uint8Array, actorId: string): CrdtDocHandle {
  return Automerge.load<ReqoraCrdtDoc>(bytes, actorId);
}

/** 从共享 genesis 起一个新副本（新设备 / 解绑后重绑）。 */
export function initFromGenesis(genesis: Uint8Array, actorId: string): CrdtDocHandle {
  return loadCrdtDoc(genesis, actorId);
}

export function saveCrdtDoc(doc: CrdtDocHandle): Uint8Array {
  return Automerge.save(doc);
}

export function crdtHeads(doc: CrdtDocHandle): string[] {
  return Automerge.getHeads(doc);
}

export function changeHash(change: CrdtChange): string {
  return Automerge.decodeChange(change).hash;
}

export function changeDeps(change: CrdtChange): string[] {
  return [...Automerge.decodeChange(change).deps];
}

/** 提取文档里尚未投递的全部历史（bootstrap / Git 通道用）。 */
export function allChangeBytes(doc: CrdtDocHandle): CrdtChange[] {
  return Automerge.getAllChanges(doc);
}

// ------------------------------------------------------------ 变更应用 ----

/**
 * 应用远端 change。Automerge 对已见 hash 是 no-op（heads 不变），
 * 所以重复同步 / 重放 / 多端并发投递同一 change 天然幂等。
 *
 * 这里必须先 clone：change/merge/applyChanges 都会让调用方手上还持有的旧 doc
 * 指针变成「outdated」，直接对它 applyChanges 会抛 RangeError。clone 不产生
 * change，heads 与内容完全不变。
 */
export function applyRemoteChanges(
  doc: CrdtDocHandle,
  changes: CrdtChange[],
  actorId: string = newActorId(),
): CrdtDocHandle {
  if (changes.length === 0) return doc;
  const [next] = Automerge.applyChanges(Automerge.clone(doc, actorId), changes);
  return next;
}

/**
 * 两个分支直接 CRDT 合并（Git-native 通道用，取代三方行合并）。
 * 同样 clone 两侧，避免 merge 把传入的分支指针变成 outdated。
 */
export function mergeCrdtDocs(
  left: CrdtDocHandle,
  right: CrdtDocHandle,
): CrdtDocHandle {
  return Automerge.merge(
    Automerge.clone(left, newActorId()),
    Automerge.clone(right, newActorId()),
  );
}

// -------------------------------------------------------------- 投影 ----

/** CRDT 文档 → 脱敏统一行集。meta 故意不带，由调用方用本地快照保留。 */
export function projectRows(doc: CrdtDocHandle): WorkspaceRowsPayload {
  const rows = {} as WorkspaceRowsPayload;
  for (const domain of CRDT_ROW_DOMAINS) {
    const bucket = doc.domains[domain];
    (rows as unknown as Record<string, unknown[]>)[domain] = Object.keys(bucket)
      .sort()
      .map((id) => plain(bucket[id]))
      .filter((row) => row && typeof row === "object" && !row.deleted);
  }
  return rows;
}

// ------------------------------------------------- 本地 diff → change ----

/** 空行集（与统一行模型同形）。 */
export function emptyCrdtRows(): WorkspaceRowsPayload {
  return {
    folders: [],
    requests: [],
    environments: [],
    cases: [],
    scenarios: [],
    suites: [],
    artifacts: [],
  };
}

/**
 * 只挑出「相对上次投影真正发生的本地编辑」。
 *
 * 这一步是删除不复活的关键。若在每轮同步都把本地完整行集 diff 到 doc，
 * 副本 B 收到 A 的删除 change 后，仍会用自己缓存的旧行把该 key put 回去
 * ——删除被无声撤销，正是 v1 的病根换了个地方复发。
 *
 * 比较基准必须是**上一轮写回本地的脱敏投影**，而不是服务端当前状态：
 * 只有「本地确实改了/删了」才产生 change；本地没动时 edits 恒为空，
 * 远端的删除才能原样生效。
 *
 * @param before 上次写回本地的脱敏行集；null = 首次同步，整份 desired 视为本地编辑。
 */
export function computeLocalEdits(
  before: WorkspaceRowsPayload | null,
  desired: WorkspaceRowsPayload,
): WorkspaceRowsPayload {
  if (!before) return desired;
  const edits = emptyCrdtRows();
  const beforeRows = before as unknown as Record<string, CrdtRow[]>;
  const desiredRows = desired as unknown as Record<string, CrdtRow[]>;
  const editRows = edits as unknown as Record<string, CrdtRow[]>;

  for (const domain of CRDT_ROW_DOMAINS) {
    const prior = new Map<string, string>();
    for (const row of beforeRows[domain] ?? []) {
      const id = String(row.id ?? "");
      if (id && !row.deleted) prior.set(id, stableJson(row));
    }
    const desiredLive = new Map<string, CrdtRow>();
    const desiredDeleted = new Map<string, CrdtRow>();
    for (const row of desiredRows[domain] ?? []) {
      const id = String(row?.id ?? "");
      if (!id) continue;
      if (row.deleted === true) desiredDeleted.set(id, row);
      else desiredLive.set(id, row);
    }
    for (const [id, row] of desiredLive) {
      if (prior.get(id) !== stableJson(row)) editRows[domain].push(row);
    }
    for (const [id, row] of desiredDeleted) {
      // 墓碑只在基线里确实有过这一行时才需要传播；否则是无意义的重复删除。
      if (prior.has(id)) editRows[domain].push(row);
    }
    // 「before 有、desired 没有」刻意不推断为删除：删除必须由墓碑显式表达，
    // 绝不能因为本地快照漏了一行就抹掉协作方的数据。
  }
  return edits;
}

export interface CrdtLocalOps {
  put: number;
  remove: number;
  restored: number;
}

export interface LocalDiffResult {
  doc: CrdtDocHandle;
  /** 本次新产生的 change（自 headsBefore 起），可直接 POST /crdt/changes。 */
  changes: CrdtChange[];
  headsBefore: string[];
  ops: CrdtLocalOps;
}

interface DiffOperation {
  domain: CrdtRowDomain;
  id: string;
  kind: "put" | "remove" | "restore";
  row?: CrdtRow;
  tombstone?: CrdtTombstone;
}

/**
 * 把本地脱敏行集写成一笔 CRDT change。
 *
 * 关键取舍：**只有 desired 里明确出现 `deleted: true` 的墓碑行才触发删除**。
 * 「doc 有而 desired 既没有活行也没有墓碑」一律视为远端新增并保留 ——
 * 本地快照不该因为一次漏写就抹掉协作方的数据。这正是 v1
 * `!L && R` 复活分支的反面：删除必须显式表达，绝不由「缺席」推断。
 */
export function applyLocalRows(
  doc: CrdtDocHandle,
  desired: WorkspaceRowsPayload,
  actorId: string,
  now: number = Date.now(),
): LocalDiffResult {
  const ops: DiffOperation[] = [];
  const desiredByDomain = desired as unknown as Record<string, CrdtRow[]>;

  for (const domain of CRDT_ROW_DOMAINS) {
    const bucket = doc.domains[domain];
    const live = new Map<string, CrdtRow>();
    const deleted = new Set<string>();
    for (const raw of desiredByDomain[domain] ?? []) {
      const id = String(raw?.id ?? "");
      if (!id) continue;
      if (raw.deleted === true) deleted.add(id);
      else live.set(id, plain(raw));
    }

    for (const [id, row] of live) {
      const current = bucket[id];
      if (current === undefined || stableJson(plain(current)) !== stableJson(row)) {
        ops.push({ domain, id, kind: doc.tombstones[id] ? "restore" : "put", row });
      } else if (doc.tombstones[id]) {
        // 值已经一致但台账还在（并发编辑把 key 复活过）：清台账让它彻底收敛。
        ops.push({ domain, id, kind: "restore", row });
      }
    }
    for (const id of deleted) {
      if (bucket[id] !== undefined || !doc.tombstones[id]) {
        ops.push({
          domain,
          id,
          kind: "remove",
          tombstone: { domain, at: now, actor: actorId },
        });
      }
    }
  }

  const headsBefore = crdtHeads(doc);
  if (ops.length === 0) {
    return {
      doc,
      changes: [],
      headsBefore,
      ops: { put: 0, remove: 0, restored: 0 },
    };
  }

  // clone 是必须的：保留旧 doc 指针（headsBefore / 调用方回滚）时直接 change 会抛错。
  const writable = Automerge.clone(doc, actorId);
  const next = Automerge.change(writable, (d) => {
    for (const op of ops) {
      const bucket = d.domains[op.domain];
      if (op.kind === "remove") {
        delete bucket[op.id];
        d.tombstones[op.id] = plain(op.tombstone) as CrdtTombstone;
      } else {
        // 先 delete 再 put：同一个 change 内产生的新 op 能覆盖全部并发候选值，
        // 保证裁决后 getConflicts 立即消失（而不是留下旧的并发值）。
        delete bucket[op.id];
        bucket[op.id] = plain(op.row) as CrdtRow;
        delete d.tombstones[op.id];
      }
    }
  });

  return {
    doc: next,
    changes: Automerge.getChangesSince(next, headsBefore),
    headsBefore,
    ops: {
      put: ops.filter((op) => op.kind === "put").length,
      remove: ops.filter((op) => op.kind === "remove").length,
      restored: ops.filter((op) => op.kind === "restore").length,
    },
  };
}

// ------------------------------------------------------------ 冲突检测 ----

export type CrdtConflictKind = "concurrent-edit" | "delete-vs-edit";

export interface CrdtConflict {
  domain: CrdtRowDomain;
  id: string;
  name: string;
  kind: CrdtConflictKind;
  /** 全部并发候选行（已转成纯对象），无候选值表示「删除」这一侧。 */
  candidates: CrdtRow[];
  /** 复活的行（delete-vs-edit 时存在）。 */
  live: CrdtRow | null;
  tombstone: CrdtTombstone | null;
}

function rowName(row: CrdtRow | null): string {
  if (!row) return "";
  const value = row.name ?? row.title ?? row.id;
  return typeof value === "string" ? value : String(value ?? "");
}

/**
 * 冲突的定义被收窄为「同一 key 存在两个无因果关系的并发值」：
 *  - 并发双改：Automerge 的 getConflicts 直接给出所有候选；
 *  - 删除 vs 编辑：add-wins 让被删的 key 复活，靠 tombstones 台账识别。
 *
 * 与「点过几次同步」「时间戳谁大」「基线是否新鲜」完全无关 ——
 * 这就是重复点击不再产生假冲突的根本原因。
 */
export function collectCrdtConflicts(doc: CrdtDocHandle): CrdtConflict[] {
  const conflicts: CrdtConflict[] = [];
  const reported = new Set<string>();

  for (const domain of CRDT_ROW_DOMAINS) {
    const bucket = doc.domains[domain];
    for (const id of Object.keys(bucket)) {
      const raw = Automerge.getConflicts(
        bucket as unknown as Automerge.Doc<Record<string, CrdtRow>>,
        id,
      );
      if (!raw || Object.keys(raw).length < 2) continue;
      const candidates = Object.values(raw)
        .map((value) => plain(value) as CrdtRow)
        .filter((value) => value && typeof value === "object");
      if (candidates.length < 2) continue;
      reported.add(`${domain}:${id}`);
      conflicts.push({
        domain,
        id,
        name: rowName(candidates[0] ?? null),
        kind: "concurrent-edit",
        candidates,
        live: plain(bucket[id]) as CrdtRow,
        tombstone: null,
      });
    }
  }

  for (const [id, tombstone] of Object.entries(doc.tombstones)) {
    const domain = tombstone?.domain;
    if (!domain || !CRDT_ROW_DOMAINS.includes(domain)) continue;
    const live = doc.domains[domain][id];
    if (live === undefined || reported.has(`${domain}:${id}`)) continue;
    conflicts.push({
      domain,
      id,
      name: rowName(plain(live) as CrdtRow),
      kind: "delete-vs-edit",
      // 「删除」侧没有候选值，UI 用空数组表示；live 是并发编辑复活的那一侧。
      candidates: [plain(live) as CrdtRow],
      live: plain(live) as CrdtRow,
      tombstone: plain(tombstone) as CrdtTombstone,
    });
  }
  return conflicts;
}

// ---------------------------------------------------------------- 裁决 ----

export type CrdtResolution =
  | { type: "row"; row: CrdtRow }
  | { type: "delete" };

export interface ResolutionResult {
  doc: CrdtDocHandle;
  changes: CrdtChange[];
}

/**
 * 裁决 = 产生一笔因果上晚于所有 heads 的新 change，显式覆盖并发候选值。
 * 它不是「本地改个时间戳再上传」，因此不会在下一轮被重新判成冲突。
 */
export function resolveCrdtConflict(
  doc: CrdtDocHandle,
  domain: CrdtRowDomain,
  id: string,
  resolution: CrdtResolution,
  actorId: string,
  now: number = Date.now(),
): ResolutionResult {
  const headsBefore = crdtHeads(doc);
  const writable = Automerge.clone(doc, actorId);
  const next = Automerge.change(writable, (d) => {
    const bucket = d.domains[domain];
    delete bucket[id];
    if (resolution.type === "row") {
      bucket[id] = plain(resolution.row) as CrdtRow;
      delete d.tombstones[id];
    } else {
      d.tombstones[id] = { domain, at: now, actor: actorId };
    }
  });
  return { doc: next, changes: Automerge.getChangesSince(next, headsBefore) };
}
