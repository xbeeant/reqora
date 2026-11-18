/**
 * Git-native 通道接入协议 v2 的 CRDT（见 docs/SYNC_PROTOCOL_V2.md 第 3.3 节）。
 *
 * 文件名刻意取 `reqora.crdt.yaml`：它同时满足前端 isGitSyncFileName、
 * CLI readFiles/writeFiles 与 Rust is_allowed_file 的既有白名单（reqora.*.yaml），
 * 因此不需要改动任何一条写盘校验，也不影响现有 8 份 YAML 文件。
 * 文件内容是 YAML 外壳 + base64 的 A.save(doc) 字节，人可读结构、机器可无损还原。
 *
 * 启用方式：目录里出现该文件即进入 CRDT 分支（由 snapshotToGitFiles(snap, true)
 * 或云 v2 导出链路生成）。没有它的仓库继续走原来的三方行合并，行为逐字不变。
 * 一旦启用，分支合并用 A.merge() 而不是 threeWayMerge，YAML 降为只读投影。
 */
import {
  applyLocalRows,
  base64ToBytes,
  bytesToBase64,
  collectCrdtConflicts,
  computeLocalEdits,
  createGenesis,
  initFromGenesis,
  loadCrdtDoc,
  mergeCrdtDocs,
  newActorId,
  projectRows,
  resolveCrdtConflict,
  saveCrdtDoc,
  stableJson,
  type CrdtDocHandle,
} from "./crdtDoc.ts";
import {
  projectGitSyncRows,
  renderGitSyncFilesFromRows,
} from "./gitMirror.ts";
import {
  restoreRowsCredentials,
  rowsToSnapshot,
  snapshotToRows,
  type WorkspaceRowsPayload,
} from "./workspaceRows.ts";
import type { WorkspaceSnapshot } from "../types.ts";
import type {
  GitSyncConflict,
  GitSyncFileSet,
  GitSyncPlan,
  GitSyncPlanOptions,
} from "./gitNative.ts";

export const GIT_CRDT_FILE = "reqora.crdt.yaml";
export const GIT_CRDT_SCHEMA = "reqora.git-crdt.v1";

/** 同步文件集里是否已经带 CRDT 文档（决定是否走 CRDT 合并分支）。 */
export function hasCrdtFile(files: GitSyncFileSet | null | undefined): boolean {
  return typeof files?.[GIT_CRDT_FILE] === "string" && files[GIT_CRDT_FILE].trim() !== "";
}

export function renderCrdtFile(bytes: Uint8Array): string {
  return [
    `schema: "${GIT_CRDT_SCHEMA}"`,
    `encoding: "base64"`,
    `doc: "${bytesToBase64(bytes)}"`,
    "",
  ].join("\n");
}

/** 解析失败（缺字段 / 坏 base64）返回 null，让调用方安全退回 v1 合并。 */
export function parseCrdtFile(text: string | null | undefined): Uint8Array | null {
  if (typeof text !== "string" || !text.includes(GIT_CRDT_SCHEMA)) return null;
  const match = /^doc:\s*"([A-Za-z0-9+/=]+)"\s*$/m.exec(text);
  if (!match) return null;
  try {
    const bytes = base64ToBytes(match[1]);
    // 用 A.load 做一次真实校验，坏字节绝不进入合并。
    loadCrdtDoc(bytes, newActorId());
    return bytes;
  } catch {
    return null;
  }
}

/** 从一批脱敏行集创建全新的 CRDT 文件（首次启用 / 通道转换）。 */
export function createCrdtFileFromRows(rows: WorkspaceRowsPayload): string {
  const actorId = newActorId();
  let doc = initFromGenesis(createGenesis(actorId), actorId);
  doc = applyLocalRows(doc, rows, actorId).doc;
  return renderCrdtFile(saveCrdtDoc(doc));
}

/** 本地行集 = Git 通道既有脱敏行集 + 快照里显式登记的删除墓碑行。 */
function localRowsWithTombstones(snapshot: WorkspaceSnapshot): WorkspaceRowsPayload {
  const rows = projectGitSyncRows(snapshot) as WorkspaceRowsPayload;
  const full = snapshotToRows(snapshot);
  const domains = [
    "folders", "requests", "environments", "cases", "scenarios", "suites", "artifacts",
  ] as const;
  for (const domain of domains) {
    const live = new Set(
      ((rows[domain] as unknown[] | undefined) ?? []).map(
        (row) => String((row as { id?: string }).id ?? ""),
      ),
    );
    const deleted = ((full[domain] as unknown[] | undefined) ?? []).filter((row) => {
      const item = row as { id?: string; deleted?: boolean };
      return item.deleted === true && !live.has(String(item.id ?? ""));
    });
    if (deleted.length) {
      (rows as unknown as Record<string, unknown[]>)[domain] = [
        ...((rows[domain] as unknown[] | undefined) ?? []),
        ...deleted.map((row) => ({ ...(row as object), id: String((row as { id: string }).id) })),
      ];
    }
  }
  return rows;
}

function diffFiles(before: GitSyncFileSet, after: GitSyncFileSet): GitSyncFileSet {
  const out: GitSyncFileSet = {};
  for (const [name, text] of Object.entries(after)) {
    if (before[name] !== text) out[name] = text;
  }
  return out;
}

/**
 * CRDT 版同步计划。与 planGitSync 的返回结构完全一致，调用方（桌面端 / CLI）
 * 不需要区分自己走的是哪条合并路径。
 *
 * 关键差异：删除是一等 CRDT 操作（写 tombstones 台账），不会因为「本地行集里
 * 没有这一行」被三方合并判成「Git 侧新增」而复活；重复同步时本地 diff 为空、
 * merge 不改变 heads，因此不存在反复出现的假冲突。
 */
export function planGitCrdtSync(
  snapshot: WorkspaceSnapshot,
  files: GitSyncFileSet,
  options: GitSyncPlanOptions = {},
): GitSyncPlan {
  const actorId = options.actorId ?? newActorId();
  const localRows = localRowsWithTombstones(snapshot);
  const baselineBytes = parseCrdtFile(options.baseline?.files?.[GIT_CRDT_FILE]);
  const remoteBytes = parseCrdtFile(files[GIT_CRDT_FILE]);

  // 起点必须是「共同祖先」：优先上次同步的 CRDT 文件，其次 Git 侧的文件，
  // 都没有才新建 genesis。绝不让本地和 Git 各自 A.from() 出私有 root change。
  const seed = baselineBytes ?? remoteBytes ?? createGenesis(actorId);
  // 与云通道同一条不变量：只投「相对上次基线真正发生的本地编辑」。
  // 全量 diff 会把 Git 侧刚删除的行用本地缓存重新 put 回去。
  const beforeRows = baselineBytes
    ? projectRows(loadCrdtDoc(baselineBytes, actorId))
    : null;
  const edits = computeLocalEdits(beforeRows, localRows);
  let localDoc: CrdtDocHandle = loadCrdtDoc(seed, actorId);
  localDoc = applyLocalRows(localDoc, edits, actorId).doc;

  let doc: CrdtDocHandle = localDoc;
  if (remoteBytes) {
    doc = mergeCrdtDocs(localDoc, loadCrdtDoc(remoteBytes, actorId));
  }

  // 用户裁决：产生一笔因果上晚于双方的新 change，而不是改时间戳再上传。
  let conflicts = collectCrdtConflicts(doc);
  for (const [key, choice] of Object.entries(options.resolutions ?? {})) {
    const conflict = conflicts.find((item) => `${item.domain}:${item.id}` === key);
    if (!conflict) continue;
    const alternative =
      conflict.candidates.find((row) => stableJson(row) !== stableJson(conflict.live)) ?? null;
    const chosen = choice === "git" ? alternative : conflict.live;
    doc = resolveCrdtConflict(
      doc,
      conflict.domain,
      conflict.id,
      chosen ? { type: "row", row: chosen } : { type: "delete" },
      actorId,
    ).doc;
  }
  conflicts = collectCrdtConflicts(doc);

  const mappedConflicts: GitSyncConflict[] = conflicts.map((conflict) => ({
    domain: conflict.domain,
    id: conflict.id,
    name: conflict.name,
    base: null,
    local: (conflict.live ?? null) as Record<string, unknown> | null,
    remote: (conflict.kind === "delete-vs-edit"
      ? null
      : (conflict.candidates.find((row) => stableJson(row) !== stableJson(conflict.live)) ??
        null)) as Record<string, unknown> | null,
  }));

  const converged: WorkspaceRowsPayload = projectRows(doc);
  const restored = restoreRowsCredentials(converged, snapshotToRows(snapshot));
  const merged = rowsToSnapshot(restored, snapshot);
  const filesToWrite = renderGitSyncFilesFromRows(converged);
  filesToWrite[GIT_CRDT_FILE] = renderCrdtFile(saveCrdtDoc(doc));
  const changedFiles = mappedConflicts.length > 0 ? {} : diffFiles(files, filesToWrite);

  const localById = new Map<string, string>();
  for (const domain of [
    "folders", "requests", "environments", "cases", "scenarios", "suites", "artifacts",
  ] as const) {
    for (const row of (localRows[domain] ?? []) as unknown as Record<string, unknown>[]) {
      if ((row as { deleted?: boolean }).deleted) continue;
      localById.set(`${domain}:${String(row.id)}`, stableJson(row));
    }
  }
  let gitChanges = 0;
  for (const domain of [
    "folders", "requests", "environments", "cases", "scenarios", "suites", "artifacts",
  ] as const) {
    for (const row of (converged[domain] ?? []) as unknown as Record<string, unknown>[]) {
      const key = `${domain}:${String(row.id)}`;
      if (localById.get(key) !== stableJson(row)) gitChanges += 1;
    }
  }

  return {
    snapshot: merged,
    rows: converged,
    files: filesToWrite,
    changedFiles,
    conflicts: mappedConflicts,
    gitChanges,
    localChanges: 0,
    remoteFound: true,
    legacy: false,
    warnings: [],
  };
}
