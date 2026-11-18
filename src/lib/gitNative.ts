/**
 * Git-native 双向同步的纯逻辑层（桌面端、CLI、单测共用，零 Node / Tauri 依赖）。
 *
 * 与「服务端协作」通道的关系：
 * - 两者共享同一套 7 域行模型（lib/workspaceRows.ts）与同一套三方合并
 *   （threeWayMerge）：基线是上次成功同步后的**脱敏行集 + 文件内容**，
 *   仅本地变 → 写回文件；仅 Git 变 → 合并回工作区；双方都变 → 冲突，
 *   保留本地版本并交给用户裁决，绝不静默覆盖。
 * - 凭据边界与导出 / 云同步完全一致：文件里只写脱敏行集，本机真实凭据
 *   永不进 Git；Git 侧获胜的行用 restoreRowsCredentials 从本机回填。
 * - 单向镜像（reqora.git-mirror.v1）仍只写不读；本模块只认
 *   reqora.git-sync.v1（可反向导入），同时兼容把旧镜像文件当作「首次导入」
 *   的素材（缺 updatedAt / position 时按缺省值处理并给出 warning）。
 *
 * 通道转换（两种方式互转）也落在这里，CLI 与设置页调用的是同一组纯函数：
 * - 服务端 → Git：serverRowsToGitFiles(rows) 把服务端行集渲染成同步文件；
 * - Git → 服务端：gitFilesToServerRows(files) 解析文件并加盖迁移时间戳，
 *   得到可直接 POST /rows/sync 的脱敏行集（本地行因此在 LWW 中获胜）。
 */

import type { WorkspaceSnapshot } from "../types.ts";
import {
  GIT_MIRROR_DOMAINS,
  GIT_MIRROR_MANIFEST_FILE,
  GIT_MIRROR_SCHEMA,
  GIT_SYNC_SCHEMA,
  canonicalGitSyncRows,
  normalizeGitSyncRowsShape,
  projectGitSyncRows,
  renderGitSyncFilesFromRows,
} from "./gitMirror.ts";
import {
  restoreRowsCredentials,
  rowsToSnapshot,
  threeWayMerge,
} from "./workspaceRows.ts";
import type { WorkspaceRowsPayload } from "./workspaceRows.ts";
import { snapshotToRows } from "./workspaceRows.ts";
import {
  GIT_CRDT_FILE,
  createCrdtFileFromRows,
  hasCrdtFile,
  planGitCrdtSync,
} from "./gitCrdt.ts";

export const SYNC_ROW_DOMAINS = [
  "folders",
  "requests",
  "environments",
  "cases",
  "scenarios",
  "suites",
  "artifacts",
] as const;
export type SyncRowDomain = (typeof SYNC_ROW_DOMAINS)[number];

export type GitSyncFileSet = Record<string, string>;

export interface GitSyncConflict {
  domain: string;
  id: string;
  name: string;
  /** 基线 / 本地 / Git 三份完整行，供字段级裁决 UI 使用。 */
  base: Record<string, unknown> | null;
  local: Record<string, unknown> | null;
  remote: Record<string, unknown> | null;
}

/** 保存在项目 SQLite 的同步基线（本机专属，绝不写进 Git 仓库）。 */
export interface GitSyncBaseline {
  /** 绑定的目录；换目录后基线失效。 */
  dir: string;
  files: GitSyncFileSet;
  rows: WorkspaceRowsPayload;
  conflicts: GitSyncConflict[];
  at: number;
}

export interface GitSyncStatus {
  repo: boolean;
  branch: string;
  dirty: boolean;
  changedFiles: string[];
  available: boolean;
}

export interface GitSyncActionResult {
  ok: boolean;
  action: string;
  stdout: string;
  stderr: string;
  code: number;
}

export interface ParsedGitFiles {
  /** null = 目录里没有任何可识别的同步文件（首次推送 / 空仓库）。 */
  rows: WorkspaceRowsPayload | null;
  /** 是否含旧版单向镜像 schema（缺行协议标量列）。 */
  legacy: boolean;
  missing: string[];
  warnings: string[];
}

export interface GitSyncPlanOptions {
  baseline?: GitSyncBaseline | null;
  /** 用户对冲突行的裁决：key = `${domain}:${id}`，值 = 采用哪一侧。 */
  resolutions?: Record<string, "local" | "git">;
  skipIds?: Set<string>;
  /** CRDT 分支使用的 actor id；省略时生成本次会话的临时 id。 */
  actorId?: string;
  /** 首次导出时是否同时生成 `reqora.crdt.yaml`（启用 CRDT 合并）。 */
  withCrdt?: boolean;
}

export interface GitSyncPlan {
  /** 已合并、已回填本机凭据的工作区快照（可直接写回 store）。 */
  snapshot: WorkspaceSnapshot;
  /** 合并后的脱敏行集，作为新基线。 */
  rows: WorkspaceRowsPayload;
  /** 全部同步文件（渲染自合并后的行集）。 */
  files: GitSyncFileSet;
  /** 与磁盘现有内容不同的文件，供原子写盘 / git add。 */
  changedFiles: GitSyncFileSet;
  conflicts: GitSyncConflict[];
  /** Git 侧这次贡献的变更行数（收敛后与本地不同的行）。 */
  gitChanges: number;
  /** 本地侧这次写回文件的行数。 */
  localChanges: number;
  remoteFound: boolean;
  legacy: boolean;
  warnings: string[];
}

/** Rust / CLI 写盘前共用的文件名校验：只接受 reqora.*.yaml 与 MANIFEST.md。 */
export function isGitSyncFileName(name: string): boolean {
  if (!name || name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  return (
    name === GIT_MIRROR_MANIFEST_FILE ||
    /^reqora\.[A-Za-z0-9._-]+\.yaml$/.test(name)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ------------------------------------------- 确定性 YAML 子集解析器 ----
/**
 * 只解析 gitMirror.ts 发射器产出的 YAML 子集：缩进映射 / 块序列
 * （含 `- key: value` 起始项）/ JSON 双引号字符串 / 数字 / 布尔 / null /
 * 空容器。刻意不复用 transfer.ts 的通用 import 解析器——后者面向外部
 * OpenAPI / 测试资产，处理不了「对象数组里再嵌对象数组」这一结构，且改它
 * 会波及所有导入格式。这里遇到任何不认识的结构直接抛错，绝不猜测。
 */
interface YLine {
  line: number;
  indent: number;
  content: string;
}

function lexYaml(text: string): YLine[] {
  const out: YLine[] = [];
  const rawLines = text.split(/\r?\n/);
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index];
    const content = raw.replace(/^ +/, "");
    const indent = raw.length - content.length;
    if (content.includes("\t")) throw new Error(`第 ${index + 1} 行使用了 Tab 缩进`);
    if (content.trim() === "" || content.trimStart().startsWith("#")) continue;
    out.push({ line: index + 1, indent, content });
  }
  return out;
}

const isDash = (content: string): boolean => content === "-" || content.startsWith("- ");

/** 找 key 后的冒号（冒号后必须是结尾或空格）；兼容 JSON 双引号 key。 */
function keySeparator(content: string): number {
  if (content.startsWith('"')) {
    for (let i = 1; i < content.length; i += 1) {
      if (content[i] === "\\") i += 1;
      else if (content[i] === '"') {
        let j = i + 1;
        while (j < content.length && content[j] === " ") j += 1;
        return j < content.length && content[j] === ":" ? j : -1;
      }
    }
    return -1;
  }
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === ":" && (i + 1 === content.length || content[i + 1] === " ")) return i;
  }
  return -1;
}

function yamlKey(raw: string): string {
  return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
}

/** 发射器的 inline() 只产出 JSON 字符串 / 数字 / 布尔 / null / [] / {}。 */
function yamlScalar(raw: string): unknown {
  const value = raw.trim();
  if (value.startsWith('"')) return JSON.parse(value) as string;
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "[]") return [];
  if (value === "{}") return {};
  if (/^[+-]?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^[+-]?\d*\.\d+$/.test(value)) return Number.parseFloat(value);
  throw new Error(`无法识别的标量：${value.slice(0, 80)}`);
}

function parseYamlNode(lines: YLine[], i: number, indent: number): [unknown, number] {
  if (i >= lines.length) return [null, i];
  return isDash(lines[i].content)
    ? parseYamlSeq(lines, i, indent)
    : parseYamlMap(lines, i, indent);
}

function parseYamlMap(lines: YLine[], i: number, indent: number): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  while (i < lines.length && lines[i].indent === indent && !isDash(lines[i].content)) {
    const current = lines[i];
    const sep = keySeparator(current.content);
    if (sep < 0) throw new Error(`第 ${current.line} 行缺少 “key:” 形式`);
    const key = yamlKey(current.content.slice(0, sep).trim());
    const rest = current.content.slice(sep + 1).trim();
    i += 1;
    if (rest === "") {
      if (i < lines.length && lines[i].indent > indent) {
        const [value, next] = parseYamlNode(lines, i, lines[i].indent);
        out[key] = value;
        i = next;
      } else {
        out[key] = null;
      }
    } else {
      out[key] = yamlScalar(rest);
    }
  }
  return [out, i];
}

function parseYamlSeq(lines: YLine[], i: number, indent: number): [unknown[], number] {
  const out: unknown[] = [];
  while (i < lines.length && lines[i].indent === indent && isDash(lines[i].content)) {
    const rest = lines[i].content.slice(1).trim();
    if (rest === "") {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const [value, next] = parseYamlNode(lines, i + 1, lines[i + 1].indent);
        out.push(value);
        i = next;
      } else {
        out.push(null);
        i += 1;
      }
      continue;
    }
    if (keySeparator(rest) >= 0) {
      // 把 “- key: value” 重写成同缩进的映射起始行，复用 parseYamlMap。
      const virtual = lines.slice();
      virtual[i] = { line: lines[i].line, indent: indent + 2, content: rest };
      const [value, next] = parseYamlMap(virtual, i, indent + 2);
      out.push(value);
      i = next;
    } else {
      out.push(yamlScalar(rest));
      i += 1;
    }
  }
  return [out, i];
}

function parseDeterministicYaml(text: string): unknown {
  const lines = lexYaml(text);
  if (lines.length === 0) throw new Error("空文件");
  const [value, next] = parseYamlNode(lines, 0, lines[0].indent);
  if (next < lines.length) {
    throw new Error(`第 ${lines[next].line} 行附近结构无法识别（缩进或语法有误）`);
  }
  return value;
}

function asRows(value: unknown, file: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`${file} 的 items 必须是数组`);
  }
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id) {
      throw new Error(`${file} 的 items[${index}] 缺少合法 id`);
    }
    return item;
  });
}

const emptyRows = (): WorkspaceRowsPayload => ({
  folders: [],
  requests: [],
  environments: [],
  cases: [],
  scenarios: [],
  suites: [],
  artifacts: [],
});

/**
 * 把同步目录里的 YAML 文件解析回行模型。
 *
 * 缺失的域文件**不会**被当成「该域全部删除」：优先沿用基线行集，没有基线时
 * 沿用调用方传入的本地行集（fallbackRows），并记入 warnings。这样用户误删
 * 单个文件或从旧版镜像升级时都不会发生批量数据丢失。
 */
export function parseGitSyncFiles(
  files: GitSyncFileSet,
  fallbackRows?: WorkspaceRowsPayload | null,
): ParsedGitFiles {
  const parsed = emptyRows();
  const missing: string[] = [];
  const warnings: string[] = [];
  let legacy = false;
  let found = false;

  for (const domain of GIT_MIRROR_DOMAINS) {
    const text = files[domain.file];
    if (typeof text !== "string" || text.trim() === "") {
      missing.push(domain.file);
      const fallback = (fallbackRows?.[domain.rowDomain] ?? []) as unknown as Record<string, unknown>[];
      (parsed[domain.rowDomain] as unknown as Record<string, unknown>[]) = fallback.map((row) => ({
        ...row,
      }));
      if (fallback.length > 0) {
        warnings.push(`${domain.file} 缺失或为空，已沿用既有${fallbackRows ? "基线" : "本地"}行集`);
      }
      continue;
    }
    found = true;
    let document: unknown;
    try {
      document = parseDeterministicYaml(text);
    } catch (error) {
      throw new Error(`${domain.file} 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(document)) throw new Error(`${domain.file} 顶层必须是映射`);
    const schema = document.schema;
    if (schema !== GIT_SYNC_SCHEMA && schema !== GIT_MIRROR_SCHEMA) {
      throw new Error(`${domain.file} 的 schema 不受支持：${String(schema ?? "缺失")}`);
    }
    if (schema === GIT_MIRROR_SCHEMA) {
      legacy = true;
      warnings.push(`${domain.file} 是单向镜像 v1，缺少 updatedAt / position，已按缺省值导入`);
    }
    if (document.domain !== undefined && document.domain !== domain.label) {
      throw new Error(`${domain.file} 的 domain 应为 ${domain.label}，实际为 ${String(document.domain)}`);
    }
    const items = asRows(document.items, domain.file);
    if (typeof document.count === "number" && document.count !== items.length) {
      throw new Error(`${domain.file} 的 count=${document.count} 与 items 长度 ${items.length} 不一致`);
    }
    (parsed[domain.rowDomain] as unknown as Record<string, unknown>[]) = items;
  }

  return {
    rows: found ? canonicalGitSyncRows(parsed) : null,
    legacy,
    missing,
    warnings,
  };
}

/** 稳定字符串化，只用于「合并结果与本地是否不同」的计数，不参与合并判定。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function cloneRows(rows: WorkspaceRowsPayload): WorkspaceRowsPayload {
  const out = emptyRows();
  for (const domain of SYNC_ROW_DOMAINS) {
    (out[domain] as unknown as Record<string, unknown>[]) = (
      (rows[domain] ?? []) as unknown as Record<string, unknown>[]
    ).map((row) => ({ ...row }));
  }
  return out;
}

function replaceRow(
  rows: WorkspaceRowsPayload,
  domain: string,
  id: string,
  row: Record<string, unknown> | null,
): void {
  const pool = (rows as unknown as Record<string, Record<string, unknown>[]>)[domain];
  if (!pool) return;
  const index = pool.findIndex((item) => item.id === id);
  if (row === null) {
    if (index >= 0) pool.splice(index, 1);
  } else if (index >= 0) {
    pool[index] = { ...row };
  } else {
    pool.push({ ...row });
  }
}

function rowOf(
  rows: WorkspaceRowsPayload,
  domain: string,
  id: string,
): Record<string, unknown> | null {
  const pool = (rows as unknown as Record<string, Record<string, unknown>[]>)[domain] ?? [];
  const found = pool.find((row) => row.id === id);
  return found ? { ...found } : null;
}

/** 文件内容 diff：只返回新增 / 变化的文件，供写盘与 git add。 */
export function diffGitSyncFiles(before: GitSyncFileSet, after: GitSyncFileSet): GitSyncFileSet {
  const out: GitSyncFileSet = {};
  for (const [name, text] of Object.entries(after)) {
    if (!isGitSyncFileName(name)) throw new Error(`不允许写入的同步文件名：${name}`);
    if (before[name] !== text) out[name] = text;
  }
  return out;
}

/**
 * 生成一次 Git-native 同步计划（纯函数，不读盘、不写盘、不联网）。
 *
 * 冲突行保留本地版本且不写回文件：调用方必须先让用户裁决，再重跑本函数。
 * 裁决通过 resolutions 覆盖「对端行」实现——采用 Git 就把本地行替换成 Git
 * 行，采用本地就把 Git 行替换成本地行，两端相等后冲突自然消失。
 */
export function planGitSync(
  snapshot: WorkspaceSnapshot,
  files: GitSyncFileSet,
  options: GitSyncPlanOptions = {},
): GitSyncPlan {
  // 目录里出现 CRDT 文档即进入 v2：分支合并走 A.merge()，YAML 降为只读投影。
  // 没有它的仓库保持原来的三方行合并，逐字不变（灰度可控）。
  if (hasCrdtFile(files) || hasCrdtFile(options.baseline?.files)) {
    return planGitCrdtSync(snapshot, files, options);
  }
  const local = projectGitSyncRows(snapshot);
  const baseline = options.baseline ?? null;
  const parsed = parseGitSyncFiles(files, baseline?.rows ?? local);
  const remoteFound = parsed.rows !== null;

  // 空目录 / 首次推送：没有对端可合并，直接把本地行集写成文件。
  // 刻意不把「目录被清空」解释成删除全部数据（防误删）。
  if (!parsed.rows) {
    const filesToWrite = renderGitSyncFilesFromRows(local);
    if (options.withCrdt) {
      filesToWrite[GIT_CRDT_FILE] = createCrdtFileFromRows(canonicalGitSyncRows(local));
    }
    return {
      snapshot,
      rows: local,
      files: filesToWrite,
      changedFiles: diffGitSyncFiles(files, filesToWrite),
      conflicts: [],
      gitChanges: 0,
      localChanges: SYNC_ROW_DOMAINS.reduce(
        (total, domain) => total + ((local[domain] as unknown[]) ?? []).length,
        0,
      ),
      remoteFound: false,
      legacy: parsed.legacy,
      warnings: parsed.warnings,
    };
  }

  const remote = parsed.rows;
  const L = cloneRows(local);
  const R = cloneRows(remote);
  for (const [key, choice] of Object.entries(options.resolutions ?? {})) {
    const separator = key.indexOf(":");
    if (separator < 0) continue;
    const domain = key.slice(0, separator);
    const id = key.slice(separator + 1);
    if (!SYNC_ROW_DOMAINS.includes(domain as SyncRowDomain)) continue;
    if (choice === "git") replaceRow(L, domain, id, rowOf(R, domain, id));
    else replaceRow(R, domain, id, rowOf(L, domain, id));
  }

  const outcome = threeWayMerge(L, R, baseline?.rows ?? null, { skipIds: options.skipIds });
  const conflicts: GitSyncConflict[] = outcome.conflicts.map((conflict) => ({
    domain: conflict.domain as string,
    id: conflict.id,
    name: conflict.name,
    base: conflict.base,
    local: conflict.local,
    remote: conflict.remote,
  }));

  const converged: WorkspaceRowsPayload = { ...outcome.remote };
  delete (converged as { meta?: unknown }).meta;
  // 远端获胜的行把本机真实凭据回填（Git 文件里只有脱敏值）。
  const restored = restoreRowsCredentials(converged, snapshotToRows(snapshot));
  const merged = rowsToSnapshot(restored, snapshot);

  const filesToWrite = renderGitSyncFilesFromRows(converged);
  const changedFiles = conflicts.length > 0 ? {} : diffGitSyncFiles(files, filesToWrite);

  const localChanges = SYNC_ROW_DOMAINS.reduce(
    (total, domain) => total + ((outcome.localChanges[domain] as unknown[]) ?? []).length,
    0,
  );
  const localById = new Map<string, string>();
  for (const domain of SYNC_ROW_DOMAINS) {
    for (const row of (local[domain] ?? []) as unknown as Record<string, unknown>[]) {
      localById.set(`${domain}:${String(row.id)}`, stableStringify(row));
    }
  }
  let gitChanges = 0;
  for (const domain of SYNC_ROW_DOMAINS) {
    for (const row of (converged[domain] ?? []) as unknown as Record<string, unknown>[]) {
      const key = `${domain}:${String(row.id)}`;
      if (localById.get(key) !== stableStringify(row)) gitChanges += 1;
    }
  }

  return {
    snapshot: merged,
    rows: converged,
    files: filesToWrite,
    changedFiles,
    conflicts,
    gitChanges,
    localChanges,
    remoteFound,
    legacy: parsed.legacy,
    warnings: parsed.warnings,
  };
}

// ------------------------------------------------------------ 通道转换 ----

/**
 * 迁移时间戳：把整份行集标记为「刚刚由另一条通道转换而来」。
 *
 * Git → 服务端时，服务端可能已有同 id 的旧行；不加盖更新的时间戳，
 * 首次 cloudImport 的 LWW 会让旧行胜出，转换看起来「什么都没发生」。
 * 时间戳取 max(now, 行集最大 updatedAt + 1)，保证严格新于任何已有版本。
 * 显式传 now 使 CLI / 单测结果可复现。
 */
export function stampRowsForTransfer(
  rows: WorkspaceRowsPayload,
  now: number = Date.now(),
): WorkspaceRowsPayload {
  const out = cloneRows(rows);
  let maxAt = 0;
  for (const domain of SYNC_ROW_DOMAINS) {
    for (const row of (out[domain] ?? []) as unknown as Record<string, unknown>[]) {
      if (typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt)) {
        maxAt = Math.max(maxAt, row.updatedAt);
      }
    }
  }
  const stamp = Math.max(Math.floor(now), Math.floor(maxAt) + 1);
  for (const domain of SYNC_ROW_DOMAINS) {
    for (const row of (out[domain] ?? []) as unknown as Record<string, unknown>[]) {
      row.updatedAt = stamp;
    }
  }
  return out;
}

/**
 * Git → 服务端：把同步文件解析成可直接上传的脱敏行集。
 * 返回 null 表示目录里没有同步文件（调用方应先做一次 Git 导出）。
 */
export function gitFilesToServerRows(
  files: GitSyncFileSet,
  now?: number,
): WorkspaceRowsPayload | null {
  const parsed = parseGitSyncFiles(files);
  if (!parsed.rows) return null;
  return stampRowsForTransfer(parsed.rows, now);
}

/**
 * 服务端 → Git：把服务端行集（可来自 cloudGetRows 或本地快照）渲染成同步文件。
 * 统一走 canonicalGitSyncRows，因此脱敏 / 形状 / 排序与桌面端写出的文件一致。
 */
export function serverRowsToGitFiles(
  rows: WorkspaceRowsPayload,
  withCrdt = false,
): GitSyncFileSet {
  const normalized = emptyRows();
  for (const domain of SYNC_ROW_DOMAINS) {
    (normalized[domain] as unknown as Record<string, unknown>[]) = normalizeGitSyncRowsShape(
      domain,
      (rows[domain] ?? []) as unknown as Record<string, unknown>[],
    );
  }
  const files = renderGitSyncFilesFromRows(normalized);
  if (withCrdt) {
    files[GIT_CRDT_FILE] = createCrdtFileFromRows(canonicalGitSyncRows(normalized));
  }
  return files;
}

/**
 * 便捷入口：把本地工作区快照直接导出成 Git-native 同步文件。
 * `withCrdt=true` 额外写出 `reqora.crdt.yaml`，之后的同步自动走 CRDT 合并。
 */
export const snapshotToGitFiles = (
  snapshot: WorkspaceSnapshot,
  withCrdt = false,
): GitSyncFileSet => serverRowsToGitFiles(snapshotToRows(snapshot), withCrdt);
