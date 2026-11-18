/**
 * Collaboration-space sync helpers.
 *
 * The desktop app syncs the shared workspace row by row (`cloudImport` in
 * store/workspace.ts): local rows are merged with the server's full row set by
 * `mergeRows`, only local-winning rows are uploaded, and the server's merged
 * rows are applied back. Local-only domains (history, trash, dbConnections,
 * mcpServers, theme) and per-machine settings never enter the protocol.
 *
 * `stripForUpload()` is the redaction gate for every outgoing row: it removes
 * local-only fields and recursively blanks credentials. It runs on a deep copy
 * (see lib/redact.ts) and must never mutate the in-memory snapshot — otherwise
 * `persist()` would write blanked tokens back to disk. Winning remote rows are
 * rehydrated locally with `restoreRedacted` (lib/workspaceRows.ts), so a sync
 * never wipes this machine's real tokens.
 */

import { t } from "../i18n/index.ts";
import { redactSnapshot } from "./redact.ts";
import { syncBaselineStore, syncConflictStore } from "./syncStateStore.ts";
import type { WorkspaceRowsPayload } from "./workspaceRows.ts";
import type { WorkspaceSnapshot } from "../types.ts";

/** Top-level fields that stay on this machine. */
export const LOCAL_ONLY_FIELDS = [
  "history",
  "trash",
  "dbConnections",
  "mcpServers",
  "theme",
] as const;

/** history/trash stay as empty arrays so old readers see a valid v1 shape. */
const DROPPED_ON_UPLOAD = LOCAL_ONLY_FIELDS.filter(
  (key) => key !== "history" && key !== "trash",
);

/** Settings that carry local credentials or per-machine connection info. */
export const LOCAL_ONLY_SETTINGS = [
  "cloudBaseUrl",
  "cloudProjectId",
  "aiApiKey",
  "aiBaseUrl",
  "aiModel",
  "proxyUrl",
  // 本机偏好：自动同步频率不随协作空间走。
  "autoSyncMinutes",
  // Global scripts are machine-local and may embed a hard-coded credential.
  "globalPreScript",
  "globalPostScript",
] as const;

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AnyRecord)
    : {};
}

/** 参与行级同步的共享数据域（与上传/合并协议一致，不含本机专属域）。 */
const SHAREABLE_ROW_DOMAINS = [
  "folders",
  "requests",
  "environments",
  "cases",
  "scenarios",
  "suites",
  "artifacts",
] as const;

/**
 * 本地是否没有任何可共享的实体行（墓碑不算：没有实体就没有可上传的东西）。
 * 「数据目录是空的」用内存快照的行集判断，而不是查磁盘——初始化后内存快照
 * 就是目录内容，且对浏览器/测试环境同样成立。
 */
export function isShareableRowsEmpty(rows: WorkspaceRowsPayload): boolean {
  return SHAREABLE_ROW_DOMAINS.every(
    (domain) => ((rows[domain] as unknown[] | undefined) ?? []).length === 0,
  );
}

// ------------------------------------------------ 同步基线（三方合并） ----

/**
 * 同步基线：上次成功同步后的服务端行集，是三方合并的共同祖先。
 * 桌面端持久化在项目 SQLite（syncBaselineStore），浏览器/测试降级
 * localStorage。按本地项目 id 记忆；换绑后 cloudProjectId 不匹配即失效。
 * 清 WebView 缓存不再丢基线；真丢了一次也只是退化为全量拉取 + LWW。
 */
export interface SyncBaseline {
  /** 基线所属的协作空间；换绑后 id 不匹配即视为失效。 */
  cloudProjectId: number;
  savedAt: number;
  rows: WorkspaceRowsPayload;
  /**
   * 增量拉取游标 = 保存基线时服务端 meta.version。之后的同步用
   * GET /rows?since=cursor 只拉变更行；缺省（旧基线）按 0 处理 = 全量。
   * 丢失是良性的：下一轮退化为全量拉取重建基线。
   */
  cursor?: number;
}

export async function loadSyncBaseline(
  localProjectId: string,
): Promise<SyncBaseline | null> {
  const value = await syncBaselineStore.load(localProjectId);
  if (!value || typeof value.cloudProjectId !== "number" || !value.rows) return null;
  const cursor =
    typeof value.cursor === "number" && Number.isFinite(value.cursor)
      ? value.cursor
      : undefined;
  return {
    cloudProjectId: value.cloudProjectId,
    savedAt: typeof value.savedAt === "number" ? value.savedAt : 0,
    rows: value.rows as WorkspaceRowsPayload,
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

export async function saveSyncBaseline(
  localProjectId: string,
  cloudProjectId: number,
  rows: WorkspaceRowsPayload,
  cursor?: number,
): Promise<void> {
  const record: SyncBaseline = {
    cloudProjectId,
    savedAt: Date.now(),
    rows,
    ...(typeof cursor === "number" && Number.isFinite(cursor) ? { cursor } : {}),
  };
  await syncBaselineStore.save(
    localProjectId,
    record as unknown as Record<string, unknown>,
  );
}

export const clearSyncBaseline = (localProjectId: string): Promise<void> =>
  syncBaselineStore.remove(localProjectId);

export const clearAllSyncBaselines = (): Promise<void> =>
  syncBaselineStore.clearAll();

// ------------------------------------------------ 冲突记录（提醒 + 裁决） ----

export interface SyncConflictEntry {
  domain: string;
  id: string;
  name: string;
  /** 基线行：字段级三方合并的共同祖先（旧记录没有时按 null 处理）。 */
  base: Record<string, unknown> | null;
  local: Record<string, unknown> | null;
  remote: Record<string, unknown> | null;
}

export interface SyncConflictRecord {
  cloudProjectId: number;
  entries: SyncConflictEntry[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 冲突明细（base + local + remote 三份完整行）与基线一起存在项目 SQLite，
 * 浏览器 / 测试环境降级 localStorage。旧版本写在 localStorage 的记录会由
 * 通用仓储首次读取时迁移；缺 base 的旧条目补 null，字段级合并会安全地
 * 退化为整行二选一。
 */
export async function loadSyncConflicts(
  localProjectId: string,
): Promise<SyncConflictRecord | null> {
  const parsed = await syncConflictStore.load(localProjectId);
  if (
    !parsed ||
    typeof parsed.cloudProjectId !== "number" ||
    !Array.isArray(parsed.entries)
  ) {
    return null;
  }
  const entries: SyncConflictEntry[] = parsed.entries.filter(isObject).map((entry) => ({
    domain: String(entry.domain ?? ""),
    id: String(entry.id ?? ""),
    name: String(entry.name ?? ""),
    base: isObject(entry.base) ? entry.base : null,
    local: isObject(entry.local) ? entry.local : null,
    remote: isObject(entry.remote) ? entry.remote : null,
  }));
  return { cloudProjectId: parsed.cloudProjectId, entries };
}

export function saveSyncConflicts(
  localProjectId: string,
  cloudProjectId: number,
  entries: SyncConflictRecord["entries"],
): Promise<void> {
  return syncConflictStore.save(localProjectId, {
    cloudProjectId,
    entries: entries as unknown as Record<string, unknown>[],
  });
}

export function clearSyncConflicts(localProjectId: string): Promise<void> {
  return syncConflictStore.remove(localProjectId);
}

export function clearAllSyncConflicts(): Promise<void> {
  return syncConflictStore.clearAll();
}

/**
 * Produce a shareable snapshot: no local-only data, no credentials.
 * `redactSnapshot` returns a fresh deep copy, so the caller's workspace is
 * never touched. Credentials are blanked rather than dropped, which keeps the
 * shape intact and makes it obvious to collaborators what they must fill in.
 */
export function stripForUpload(snapshot: WorkspaceSnapshot): AnyRecord {
  const result = asRecord(redactSnapshot(snapshot));
  result.history = [];
  result.trash = [];
  for (const key of DROPPED_ON_UPLOAD) delete result[key];

  const settings: AnyRecord = { ...asRecord(result.settings) };
  for (const key of LOCAL_ONLY_SETTINGS) delete settings[key];
  result.settings = settings;
  return result;
}

/**
 * 上传前的数据规整：把非有限数字（NaN / Infinity）显式转成 null ——
 * JSON.stringify 本身也会这么做，但先清洗可以在同步通知里报出「哪一行哪一列
 * 被脚本/导入污染」，而不是让脏值静默变成 null。顺带把协议标量列
 * （updatedAt / position）收敛为非负整数。
 *
 * 注意：这不是 HttpMessageNotReadableException 的修复 —— 该异常来自服务端
 * 反序列化（DTO 不匹配 / 请求体缺失 / Jackson 读取约束），且 JSON.stringify
 * 不会产生非法 JSON，真正原因要看服务端日志里的 Jackson 具体消息。
 */
export function sanitizeRowsForUpload(
  payload: WorkspaceRowsPayload,
): { payload: WorkspaceRowsPayload; fixed: string[] } {
  const fixed: string[] = [];

  /**
   * 递归清洗容器（对象 / 数组）里的非有限数字。只在**叶子位置**把
   * NaN / Infinity 替换为 null：子对象 / 子数组原地清洗后原样保留，
   * 绝不能因"子树里有脏数"就把整个子节点抹掉。
   */
  const clean = (container: AnyRecord | unknown[], key: string | number, path: string): void => {
    const value = (container as AnyRecord)[key];
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        (container as AnyRecord)[key] = null;
        fixed.push(path);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) clean(value, i, `${path}[${i}]`);
      return;
    }
    if (value && typeof value === "object") {
      for (const inner of Object.keys(value as AnyRecord)) {
        clean(value as AnyRecord, inner, `${path}.${inner}`);
      }
    }
  };

  const fixRow = (domain: string, row: AnyRecord, scalarPaths: string[]) => {
    const rowId = row.id ?? "?";
    for (const path of scalarPaths) {
      const value = row[path];
      if (typeof value === "number" && (!Number.isInteger(value) || value < 0)) {
        row[path] = Math.max(0, Math.floor(value));
        fixed.push(`${domain}#${rowId} ${path}→${row[path]}`);
      }
    }
    for (const key of Object.keys(row)) {
      if (["id", "updatedAt", "position", "deleted"].includes(key)) continue;
      clean(row, key, `${domain}#${rowId} ${key}`);
    }
  };

  const domains: Array<[string, unknown[] | undefined]> = [
    ["folders", payload.folders],
    ["requests", payload.requests],
    ["environments", payload.environments],
    ["cases", payload.cases],
    ["scenarios", payload.scenarios],
    ["suites", payload.suites],
    ["artifacts", payload.artifacts],
  ];
  const scalarByDomain: Record<string, string[]> = {
    folders: ["updatedAt", "position"],
    requests: ["updatedAt", "position"],
    environments: ["updatedAt", "position"],
    cases: ["updatedAt"],
    scenarios: ["updatedAt", "position"],
    suites: ["updatedAt", "position"],
    artifacts: ["updatedAt", "position"],
  };
  for (const [domain, rows] of domains) {
    for (const row of rows ?? []) {
      fixRow(domain, row as AnyRecord, scalarByDomain[domain] ?? ["updatedAt"]);
    }
  }
  if (payload.meta?.settings) {
    clean({ settings: payload.meta.settings }, "settings", "meta.settings");
  }

  return { payload, fixed };
}

/** Stable serialization so object key order never creates a fake diff. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = asRecord(value);
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

// ------------------------------------------------ 分块上传（按字节预算） ----

/**
 * 单块字节预算。服务端对一次 sync 请求的全部行 data 求和，超过
 * workspace.maxBytes（默认 5 MiB）就返回 1010 / 413；客户端在这里按更小的
 * 预算把变更行切成多块逐次上传，让项目总大小不再被单次请求封顶。
 * 预算低于 5 MiB 留出 JSON 序列化与标量列的余量。
 */
export const SYNC_CHUNK_BYTES = 4 * 1024 * 1024;

/** 行域上传顺序：与 rowsToSnapshot / 服务端 collect 顺序一致。 */
const CHUNK_DOMAINS = [
  "folders",
  "requests",
  "environments",
  "cases",
  "scenarios",
  "suites",
  "artifacts",
] as const;

/** 一行的线上体积（UTF-8 字节数）；调用前 payload 已经过 sanitizeRowsForUpload。 */
function rowBytes(row: unknown): number {
  return new TextEncoder().encode(JSON.stringify(row ?? null)).length;
}

export interface OversizedRow {
  domain: string;
  id: string;
  name: string;
  bytes: number;
}

/**
 * 找出单行体积就超过整块预算的行。分块解决的是「总量超限」，救不了
 * 「单行超限」——服务端 validateRow 对单行 data 有同样的 maxBytes 检查，
 * 超限行必须先瘦身（通常是接口里嵌了超大响应体/数据集）。
 */
export function findOversizedRows(
  payload: WorkspaceRowsPayload,
  maxBytes: number = SYNC_CHUNK_BYTES,
): OversizedRow[] {
  const oversized: OversizedRow[] = [];
  for (const domain of CHUNK_DOMAINS) {
    for (const row of ((payload[domain] as unknown[] | undefined) ?? []) as Array<
      Record<string, unknown>
    >) {
      const bytes = rowBytes(row);
      if (bytes > maxBytes) {
        oversized.push({
          domain,
          id: String(row.id ?? "?"),
          name: String(row.name ?? ""),
          bytes,
        });
      }
    }
  }
  return oversized;
}

/**
 * 把待上传行按字节预算贪心打包成若干块（预算内尽量装满，行不跨块）。
 * 域与行保持稳定顺序，同一份数据重复调用得到相同的分块结果；空 payload
 * 返回空数组（调用方应跳过上传直接拉取全量）。单行超预算的行独立成块，
 * 由 findOversizedRows 负责提前报告，这里不做静默丢弃。
 */
export function chunkRowsForUpload(
  payload: WorkspaceRowsPayload,
  maxBytes: number = SYNC_CHUNK_BYTES,
): WorkspaceRowsPayload[] {
  const emptyChunk = (): WorkspaceRowsPayload => ({
    folders: [],
    requests: [],
    environments: [],
    cases: [],
    scenarios: [],
    suites: [],
    artifacts: [],
  });
  const chunks: WorkspaceRowsPayload[] = [];
  let current: WorkspaceRowsPayload | null = null;
  let currentBytes = 0;
  let total = 0;

  const push = (domain: string, row: unknown): void => {
    const bytes = rowBytes(row);
    if (current === null || (total > 0 && currentBytes + bytes > maxBytes)) {
      current = emptyChunk();
      chunks.push(current);
      currentBytes = 0;
    }
    (current as unknown as Record<string, unknown[]>)[domain].push(row);
    currentBytes += bytes;
    total += bytes;
  };

  for (const domain of CHUNK_DOMAINS) {
    for (const row of (payload[domain] as unknown[] | undefined) ?? []) {
      push(domain, row);
    }
  }
  return chunks;
}

// ------------------------------------------------ 增量拉取（游标 delta） ----

/**
 * 把增量 delta 覆盖到基线上，构造「服务端当前视图」：基线行 + 游标之后的
 * 变更行。三类调用方语义都成立——
 * - 新服务端：delta 只含 row_version > cursor 的行，overlay = 基线之上的增量；
 * - 旧服务端（忽略 since 参数）：delta 即全量，overlay = 全量视图；
 * - 无基线（首次同步）：cursor=0，delta 本身就是全量。
 * delta.full=true（服务端明确声明完整行集，含墓碑回收水位的退化全量）时
 * 直接返回 delta：叠加基线会让「已删除且墓碑已回收」的行复活。
 * overlay 结果可直接作为 threeWayMerge 的 remote（完整覆盖所有 id，不会漏行），
 * 也可作为新基线保存（它就是服务端行集的近似真值）。
 */
export function overlayRows(
  base: WorkspaceRowsPayload | null,
  delta: WorkspaceRowsPayload,
  full = false,
): WorkspaceRowsPayload {
  if (full || !base) return delta;
  const merged = {
    folders: [...base.folders],
    requests: [...base.requests],
    environments: [...base.environments],
    cases: [...base.cases],
    scenarios: [...base.scenarios],
    suites: [...base.suites],
    artifacts: [...base.artifacts],
  } as WorkspaceRowsPayload;
  for (const domain of CHUNK_DOMAINS) {
    const list = merged[domain] as unknown as Array<{ id: string }>;
    const index = new Map(list.map((row, position) => [row.id, position]));
    for (const row of (delta[domain] as unknown[] | undefined) ?? []) {
      const id = (row as { id: string }).id;
      const existing = index.get(id);
      if (existing === undefined) {
        index.set(id, list.length);
        list.push(row as { id: string });
      } else {
        list[existing] = row as { id: string };
      }
    }
  }
  merged.meta = delta.meta ?? base.meta;
  return merged;
}

// ------------------------------------------------ 大字段内容寻址旁路 ----

/**
 * 行 data 超过该阈值时外置为对象：行内只留引用，行恒小，单行体积不再受
 * 同步请求上限约束。阈值之下直接内联（普通行不值得多一次对象往返）。
 */
export const BLOB_THRESHOLD_BYTES = 512 * 1024;

export interface BlobUpload {
  hash: string;
  bytes: Uint8Array;
  domain: string;
  id: string;
  name: string;
}

export interface BlobExtractResult {
  payload: WorkspaceRowsPayload;
  blobs: BlobUpload[];
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 上传方向：把超过阈值的行 data 序列化成 JSON 字节、计算 sha256，行内
 * data 替换为引用 { __blob, size, encoding: "json" }。就地修改 payload
 * （调用方传入的已经是脱敏/清洗后的工作副本）。墓碑行 data 为空，跳过。
 */
export async function extractBlobRefs(
  payload: WorkspaceRowsPayload,
  threshold: number = BLOB_THRESHOLD_BYTES,
): Promise<BlobExtractResult> {
  const blobs: BlobUpload[] = [];
  for (const domain of CHUNK_DOMAINS) {
    for (const row of ((payload[domain] as unknown[] | undefined) ?? []) as Array<{
      id: string;
      name?: string;
      deleted?: boolean;
      data?: unknown;
    }>) {
      if (row.deleted) continue;
      const dataJson = JSON.stringify(row.data ?? {});
      const bytes = new TextEncoder().encode(dataJson);
      if (bytes.length <= threshold) continue;
      const hash = await sha256Hex(bytes);
      row.data = { __blob: hash, size: bytes.length, encoding: "json" };
      blobs.push({ hash, bytes, domain, id: row.id, name: row.name ?? "" });
    }
  }
  return { payload, blobs };
}

/**
 * 下载方向：把行内的 blob 引用水合回真实 data。任一对象缺失/损坏都视为
 * 同步失败（宁可整体重试，也不能把引用当内容写进本地快照）。
 */
export async function hydrateBlobRows<T extends WorkspaceRowsPayload>(
  rows: T,
  fetchObject: (hash: string) => Promise<Uint8Array>,
): Promise<T> {
  for (const domain of CHUNK_DOMAINS) {
    for (const row of ((rows[domain] as unknown[] | undefined) ?? []) as Array<{
      id: string;
      data?: unknown;
    }>) {
      const data = row.data as { __blob?: unknown; encoding?: unknown } | undefined;
      if (!data || typeof data.__blob !== "string") continue;
      if (data.encoding !== undefined && data.encoding !== "json") {
        throw new Error(
          t("cloud.sync.unknownEncoding", {
            id: row.id,
            encoding: String(data.encoding),
          }),
        );
      }
      const bytes = await fetchObject(data.__blob as string);
      const text = new TextDecoder().decode(bytes);
      try {
        row.data = JSON.parse(text);
      } catch {
        throw new Error(
          t("cloud.sync.blobNotJson", { hash: data.__blob as string, id: row.id }),
        );
      }
    }
  }
  return rows;
}
