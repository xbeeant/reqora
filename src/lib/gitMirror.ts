/**
 * Git 文件渲染器：把工作区 7 个共享域序列化成稳定、可 diff 的 YAML 文本。
 *
 * 两套 schema 共用同一个发射器与脱敏出口：
 * - `reqora.git-mirror.v1`（renderGitMirror）：**单向镜像，只写不读**。SQLite
 *   是唯一真相源，文件仅用于审计与 PR 评论；刻意不提供 importer。
 * - `reqora.git-sync.v1`（renderGitSyncFiles / projectGitSyncRows）：**Git-native
 *   双向同步通道**使用，保留行协议标量列以便解析回行模型做三方合并。反向
 *   解析与合并在 lib/gitNative.ts，用户可在设置页选择同步通道。
 *
 * 单向镜像的设计约束：
 * - **只写不读**：renderGitMirror 只从 WorkspaceSnapshot 产出文本，不提供
 *   importer / 反向同步；SQLite 永远是唯一真相源，Git 只用于审计与 PR 评论。
 * - **零 Node 依赖**：纯逻辑，前端 TS 可直接调用；不读写文件、不调用
 *   Date.now / Math.random、不发起任何网络 / 同步请求。
 * - **脱敏**：进 Git 的内容复用 redact.ts 的 redactSnapshot / redactFreeText，
 *   且私密变量只写变量名，绝不把私密变量值 / token / Cookie 写进 YAML。
 *   刻意不在本模块另造一套脱敏规则（避免脱敏逻辑分叉）：自由文本凭据的
 *   保证边界与项目统一出口一致（redactFreeText 的 fail-closed 层），结构化
 *   凭据（auth / KeyValue / Cookie / token）由 redactSnapshot 兜底。镜像在
 *   此之上**额外**丢弃私密 KeyValue 的 value 字段（比云同步更严格，详见
 *   canonicalize 注释）。
 * - **稳定**：按 id 排序、字段顺序固定、不含生成时间戳与随机值，同一输入
 *   连续两次 render 字节一致；不修改输入（不写 updatedAt）。单向镜像还会
 *   剔除实体内的易变字段减少 diff 噪声，双向同步文件则保留它们，避免
 *   合并回工作区时静默丢失本机内容。
 *
 * 域划分直接取自 workspaceRows.ts 的 7 个行域（folders / requests /
 * environments / cases / scenarios / suites / artifacts）。文件名沿用快照语义：
 * folders 行域输出为 reqora.collections.yaml（集合），其下的接口单独落在
 * reqora.requests.yaml 并以 folderId 关联。
 */

import type { WorkspaceSnapshot } from "../types.ts";
import { redactFreeText, redactSnapshot, SENSITIVE_NAME } from "./redact.ts";
import { snapshotToRows } from "./workspaceRows.ts";
import type { WorkspaceRowsPayload } from "./workspaceRows.ts";

/** 镜像文件里的 schema 标记。固定字符串，不含生成时间戳 / 随机值。 */
export const GIT_MIRROR_SCHEMA = "reqora.git-mirror.v1";

/**
 * 双向 Git-native 同步文件的 schema 标记（与单向镜像同一套文件名 / 发射器）。
 * v2 与 v1 的区别：保留 updatedAt / position / deleted 三个行协议标量列，
 * 因此文件可以被解析回 WorkspaceRowsPayload 做三方合并；v1 仍保持只写不读。
 */
export const GIT_SYNC_SCHEMA = "reqora.git-sync.v1";

export interface GitMirrorDomain {
  /** workspaceRows.ts 里的行域 key。 */
  readonly rowDomain:
    | "folders"
    | "requests"
    | "environments"
    | "cases"
    | "scenarios"
    | "suites"
    | "artifacts";
  /** 输出的相对文件名。 */
  readonly file: string;
  /** YAML 里的域标签。 */
  readonly label: string;
}

/** 7 个共享域 → 输出文件名。顺序即产出顺序（稳定）。 */
export const GIT_MIRROR_DOMAINS: readonly GitMirrorDomain[] = [
  { rowDomain: "folders", file: "reqora.collections.yaml", label: "collections" },
  { rowDomain: "requests", file: "reqora.requests.yaml", label: "requests" },
  { rowDomain: "environments", file: "reqora.environments.yaml", label: "environments" },
  { rowDomain: "cases", file: "reqora.cases.yaml", label: "cases" },
  { rowDomain: "scenarios", file: "reqora.scenarios.yaml", label: "scenarios" },
  { rowDomain: "suites", file: "reqora.suites.yaml", label: "suites" },
  { rowDomain: "artifacts", file: "reqora.artifacts.yaml", label: "artifacts" },
];

/**
 * 本机专属 / 不参与镜像的域与字段。这些要么含凭据 / 私密值，要么是本机
 * 历史 / 同步基线 / UI 偏好，绝不能进 Git。
 */
export const GIT_MIRROR_UNSYNCED = [
  "history", // 本机请求历史（含响应体 / Cookie）
  "trash", // 回收站（本机删除缓冲）
  "revisions", // 接口修订历史（本机）
  "dbConnections", // 命名数据库连接（含连接串）
  "mcpServers", // MCP 连接配置（含 env / headers 凭据）
  "tombstones", // 同步墓碑
  "syncBaseline", // 同步基线（三方合并共同祖先）
  "theme", // 本机主题
  "settings", // 本机偏好 + 凭据字段（aiApiKey / cloudToken / proxyUrl ...）
  "activeEnvironmentId", // 本机当前激活环境
  "seeded", // 本机初始化标记
  "cookies", // Cookie jar（StoredCookie.value）
  "secretVariableValues", // 私密变量值（只镜像变量名）
] as const;

/** 每个不镜像项的说明，供 MANIFEST / 代码评审使用。 */
export const GIT_MIRROR_UNSYNCED_NOTES: Record<string, string> = {
  history: "本机请求历史，含响应体与 Cookie，属本机运行态",
  trash: "回收站，本机删除缓冲，不是共享内容",
  revisions: "接口修订历史，本机保存",
  dbConnections: "命名数据库连接含连接串 / 口令",
  mcpServers: "MCP 连接配置含 env / headers 凭据",
  tombstones: "行同步墓碑，仅同步协议内部使用",
  syncBaseline: "上一轮成功同步的服务端行集（基线），非内容",
  theme: "本机 UI 主题偏好",
  settings: "本机偏好 + 凭据字段（aiApiKey / 云端地址 / 代理等）",
  activeEnvironmentId: "本机当前激活环境，非内容",
  seeded: "本机初始化标记",
  cookies: "跨请求 Cookie jar，值属凭据",
  secretVariableValues: "私密变量只镜像变量名，值一律不写",
};

/** 伴随镜像产出的 MANIFEST 文件名（由 CLI 一并写入 / 比对）。 */
export const GIT_MIRROR_MANIFEST_FILE = "reqora.MANIFEST.md";

/** 双向同步目录允许出现的文件名白名单（Rust 侧按同一规则校验）。 */
export const GIT_SYNC_FILE_NAMES: readonly string[] = [
  ...GIT_MIRROR_DOMAINS.map((domain) => domain.file),
  GIT_MIRROR_MANIFEST_FILE,
];

/** 双向同步目录的 MANIFEST：明确「文件可被反向导入」，与单向镜像区分。 */
export const GIT_SYNC_MANIFEST = `# Reqora Git-native 同步 · MANIFEST

本目录由 Reqora 的 **Git-native 同步通道**维护，是工作区共享数据的双向真相源。

- **可双向**：桌面端与 \`bin/git-sync.mjs\` 会把这些文件解析回行模型，
  以上次成功同步的文件内容为基线做三方合并；本地改动写回文件，
  文件改动（含 PR / 手工编辑 / 其他克隆）合并回本地工作区。
- 格式 \`${GIT_SYNC_SCHEMA}\`：保留 \`updatedAt\` / \`position\` / \`deleted\`，
  删除以墓碑行（\`deleted: true\`）表达，保证删除能传播到其他副本。
- 覆盖 7 个共享域：${GIT_MIRROR_DOMAINS.map((domain) => `\`${domain.file}\``).join("、")}。
- **脱敏**：与导出 / 云同步共用 \`src/lib/redact.ts\`；私密变量只保留变量名，
  token / Cookie / 凭据值不写入。凭据按本机保留，切换通道不会带走。
- **稳定**：按 \`id\` 排序、字段顺序固定、不含生成时间戳与随机值；
  实体自身的 \`updatedAt\` 是行协议版本，只在实体变化时改变，可 diff。
- **不参与同步的本机专属域**：${GIT_MIRROR_UNSYNCED.join("、")}。
- 同步由用户显式触发或按设置页间隔自动执行；\`git commit/push\` 为显式操作。
`;

/** MANIFEST 文本：固定内容，不含时间戳 / git hash / 随机值。 */
export const GIT_MIRROR_MANIFEST = `# Reqora Git 镜像 · MANIFEST

本目录由 \`bin/git-mirror.mjs\` 生成，是工作区快照的**单向镜像**。

- **只写不读**：这些文件只读地由 SQLite 快照导出，供 Git 审计与 PR 评论。
  **SQLite 仍是唯一真相源**；本镜像刻意**不提供 importer / 反向同步**，
  请勿手工编辑后回写，也不要基于它做双向同步。
- 覆盖 7 个共享域：${GIT_MIRROR_DOMAINS.map((domain) => `\`${domain.file}\``).join("、")}。
  folders 行域输出为 \`reqora.collections.yaml\`，接口单独落在
  \`reqora.requests.yaml\` 并以 \`folderId\` 关联。
- **脱敏**：进 Git 前统一走 \`src/lib/redact.ts\` 的 \`redactSnapshot\` /
  \`redactFreeText\`；私密变量只保留变量名，token / Cookie / 凭据值不写入。
- **稳定**：按 \`id\` 排序、字段顺序固定、不含生成时间戳与随机值；同一快照
  连续两次镜像产生相同字节，\`git diff\` 可定位「哪个实体的哪个字段变了」。
- **不镜像的本机专属域**：${GIT_MIRROR_UNSYNCED.join("、")}。
- 镜像过程不触发云同步、不调用任何同步 API、不修改 \`updatedAt\`。
`;

// ------------------------------------------------------------- 规范化 ----

type RowLike = { id: string; deleted?: boolean; [key: string]: unknown };

/**
 * 从输出里剔除的字段：时间戳 / 运行态结果 / 软删标记 / UI 顺序。
 * 这些值要么易变（每次保存都刷新 → diff 噪声），要么本机专属，不能进 Git。
 */
const VOLATILE_KEYS = new Set([
  "updatedAt",
  "contentUpdatedAt",
  "createdAt",
  "syncedAt",
  "deletedAt",
  "at",
  "expiresAt",
  "expiresAtMs",
  "startedAt",
  "connectedAt",
  "closedAt",
  "lastRun",
  "deleted",
  "position",
]);

/** YAML 里不能作裸键的保留字。 */
const YAML_RESERVED = new Set([
  "true", "false", "null", "yes", "no", "on", "off", "~",
]);

/** 稳定键序：id 恒排第一（便于 diff 定位实体），其余按码位字典序。 */
function stableKeyOrder(a: string, b: string): number {
  const rank = (key: string): number => (key === "id" ? 0 : 1);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 递归规范化：
 * - 字符串先过 redactFreeText（与 redactSnapshot 叠加，幂等，双保险）；
 * - 对象键按 stableKeyOrder 排序，剔除 VOLATILE_KEYS 与 undefined；
 * - **私密变量只写变量名**：KeyValue 行（含 id/key/value）在 secret===true
 *   或键名命中 SENSITIVE_NAME 时，单向镜像直接丢弃 value 字段（更严格），
 *   双向同步文件把 value 置空以保留字段位置——合并回本机时
 *   restoreRedacted 才能把真实值填回来。两种口径都保证值不进 Git。
 */
function canonicalize(value: unknown, syncMeta = false): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return redactFreeText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, syncMeta));
  if (isRecord(value)) {
    const keyValue =
      typeof value.id === "string" &&
      typeof value.key === "string" &&
      typeof value.value === "string";
    const isSecret =
      keyValue &&
      (value.secret === true || SENSITIVE_NAME.test(value.key as string));
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value)
      // 单向镜像剔除易变字段减少 diff 噪声；双向同步文件是真相源，
      // 所有字段一律保留（否则每次合并都会把本机字段静默丢掉）。
      .filter((key) => syncMeta || !VOLATILE_KEYS.has(key))
      // 单向镜像彻底删掉私密 value；双向文件改成置空，保留字段位置，
      // 三方合并获胜时 restoreRedacted 才能从本机行回填真实值（否则会丢数据）。
      .filter((key) => !(isSecret && key === "value" && !syncMeta))
      .filter((key) => value[key] !== undefined)
      .sort(stableKeyOrder);
    for (const key of keys) {
      out[key] = canonicalize(value[key], syncMeta);
      if (syncMeta && isSecret && key === "value") out[key] = "";
    }
    return out;
  }
  return String(value);
}

/**
 * 按 id 稳定排序 → 规范化；单向镜像同时过滤墓碑行。不改动输入数组。
 * syncMeta=true 时保留 updatedAt / position / deleted，用于 Git-native 文件。
 */
function projectRows(list: RowLike[], syncMeta = false): unknown[] {
  return list
    .filter((row) => row && (syncMeta || row.deleted !== true))
    .sort((a, b) => {
      const left = String(a.id);
      const right = String(b.id);
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .map((row) => canonicalize(row, syncMeta));
}

// ------------------------------------------------------- 稳定 YAML 输出 ----

function yamlKey(key: string): string {
  const plain =
    /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) &&
    !YAML_RESERVED.has(key.toLowerCase());
  return plain ? key : JSON.stringify(key);
}

function isInline(value: unknown): boolean {
  if (value === null || value === undefined || typeof value !== "object") return true;
  if (Array.isArray(value)) return value.length === 0;
  return Object.keys(value as Record<string, unknown>).length === 0;
}

/** 只用于标量 / 空容器；非空容器走块级输出。 */
function inline(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return "[]";
  return "{}";
}

function sortedKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort(stableKeyOrder);
}

function emitBlock(value: unknown, indent: number, lines: string[]): void {
  if (Array.isArray(value)) emitSeq(value, indent, lines);
  else emitMap(value as Record<string, unknown>, indent, lines);
}

function emitMap(obj: Record<string, unknown>, indent: number, lines: string[]): void {
  const pad = " ".repeat(indent);
  for (const key of sortedKeys(obj)) {
    const value = obj[key];
    if (isInline(value)) {
      lines.push(`${pad}${yamlKey(key)}: ${inline(value)}`);
    } else {
      lines.push(`${pad}${yamlKey(key)}:`);
      emitBlock(value, indent + 2, lines);
    }
  }
}

function emitSeq(arr: unknown[], indent: number, lines: string[]): void {
  const pad = " ".repeat(indent);
  const childPad = " ".repeat(indent + 2);
  for (const item of arr) {
    if (isInline(item)) {
      lines.push(`${pad}- ${inline(item)}`);
    } else if (Array.isArray(item)) {
      lines.push(`${pad}-`);
      emitSeq(item, indent + 2, lines);
    } else {
      const record = item as Record<string, unknown>;
      const keys = sortedKeys(record);
      if (keys.length === 0) {
        lines.push(`${pad}- {}`);
        continue;
      }
      const [first, ...rest] = keys;
      const firstValue = record[first];
      if (isInline(firstValue)) {
        lines.push(`${pad}- ${yamlKey(first)}: ${inline(firstValue)}`);
      } else {
        lines.push(`${pad}- ${yamlKey(first)}:`);
        emitBlock(firstValue, indent + 4, lines);
      }
      for (const key of rest) {
        const value = record[key];
        if (isInline(value)) {
          lines.push(`${childPad}${yamlKey(key)}: ${inline(value)}`);
        } else {
          lines.push(`${childPad}${yamlKey(key)}:`);
          emitBlock(value, indent + 4, lines);
        }
      }
    }
  }
}

function renderDomain(label: string, items: unknown[], schema: string = GIT_MIRROR_SCHEMA): string {
  const sync = schema === GIT_SYNC_SCHEMA;
  const lines: string[] = sync
    ? [
        `# ${GIT_SYNC_SCHEMA} — Git-native 双向同步`,
        "# 本文件可被 Reqora 反向导入：保留 updatedAt / position / deleted 供三方合并。",
        "# 内容已脱敏：私密变量只保留变量名，token / Cookie / 凭据不写入。",
        "# 稳定策略：按 id 排序、字段顺序固定、不含生成时间戳与随机值。",
      ]
    : [
        `# ${GIT_MIRROR_SCHEMA} — 单向镜像（只写不读）`,
        "# 本文件由 Reqora 从 SQLite 快照生成；SQLite 仍是唯一真相源。",
        "# Git 仅用于审计与 PR 评论；本镜像不实现 importer / 反向同步。",
        "# 内容已脱敏：私密变量只保留变量名，token / Cookie / 凭据不写入。",
        "# 稳定策略：按 id 排序、字段顺序固定、不含生成时间戳与随机值。",
      ];
  lines.push(`schema: ${inline(schema)}`);
  lines.push(`domain: ${inline(label)}`);
  lines.push(`count: ${items.length}`);
  if (items.length === 0) {
    lines.push("items: []");
  } else {
    lines.push("items:");
    emitSeq(items, 2, lines);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 把快照渲染成 7 份稳定 YAML 文本。
 *
 * 流程：snapshotToRows（7 域行模型）→ 过滤墓碑 / 按 id 排序 / 规范化 →
 * redactSnapshot（项目统一脱敏出口，深拷贝、不改输入）→ 稳定 YAML 序列化。
 * 返回 \`相对文件路径 → 文本\`，供 CLI 原子写盘与 --check 比对。
 */
export function renderGitMirror(snapshot: WorkspaceSnapshot): Record<string, string> {
  const rows = snapshotToRows(snapshot);
  const out: Record<string, string> = {};
  for (const domain of GIT_MIRROR_DOMAINS) {
    const list = (rows[domain.rowDomain] ?? []) as unknown as RowLike[];
    const projected = projectRows(list);
    const items = redactSnapshot(projected) as unknown[];
    out[domain.file] = renderDomain(domain.label, items);
  }
  return out;
}

/** 有限数字兜底（YAML 解析出来的 NaN / 字符串都收敛成非负数）。 */
function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * 行形状归一化：7 个域的行都补齐三方合并 / rowsToSnapshot 需要的标量列。
 * 渲染（本地行集）、解析（Git 文件）、转换（服务端行集）三条路径都走它，
 * 因此「补默认值」本身不会让同一份数据在两端看起来不一样。
 */
export function normalizeGitSyncRowsShape(domain: string, rows: unknown[]): RowLike[] {
  return rows.filter(isRecord).map((raw, index) => {
    const common: Record<string, unknown> = {
      ...raw,
      id: String(raw.id ?? ""),
      updatedAt: finiteNumber(raw.updatedAt),
      position: finiteNumber(raw.position, index),
      data: isRecord(raw.data) ? raw.data : {},
    };
    if (raw.deleted === true) common.deleted = true;
    else delete common.deleted;
    const text = (key: string) => (typeof raw[key] === "string" ? raw[key] : "");
    switch (domain) {
      case "folders":
        return { ...common, name: text("name"), auth: raw.auth ?? null };
      case "requests":
        return {
          ...common,
          folderId: text("folderId"),
          folderPath: text("folderPath"),
          name: text("name"),
          method: text("method"),
          url: text("url"),
          protocol: text("protocol") || "http",
        };
      case "environments":
      case "scenarios":
      case "suites":
        return { ...common, name: text("name") };
      case "cases":
        return {
          ...common,
          requestId: text("requestId"),
          caseGroup: text("caseGroup"),
          name: text("name"),
          enabled: raw.enabled === true,
        };
      case "artifacts":
        return {
          ...common,
          kind: ["docPage", "dataModel", "scriptSnippet", "codeTemplate"].includes(String(raw.kind))
            ? raw.kind
            : "docPage",
          name: text("name"),
        };
      default:
        return common;
    }
  }) as RowLike[];
}

/**
 * Git-native 同步的统一规范化管线：补齐形状 → 按 id 排序 / 保留行协议列 →
 * 项目统一脱敏出口（深拷贝，不改输入）。本地侧、文件侧、服务端转换侧必须
 * 全部经由它，否则三方合并会把脱敏口径差异误判成「双方都改过」。
 */
export function canonicalGitSyncRows(rows: WorkspaceRowsPayload): WorkspaceRowsPayload {
  const projected: Record<string, unknown> = {};
  for (const domain of GIT_MIRROR_DOMAINS) {
    const list = (rows[domain.rowDomain] ?? []) as unknown as unknown[];
    projected[domain.rowDomain] = projectRows(
      normalizeGitSyncRowsShape(domain.rowDomain, list),
      true,
    );
  }
  return redactSnapshot(projected) as WorkspaceRowsPayload;
}

/** 本地快照 → Git-native 同步用的脱敏行集（文件内容与之严格同源）。 */
export const projectGitSyncRows = (snapshot: WorkspaceSnapshot): WorkspaceRowsPayload =>
  canonicalGitSyncRows(snapshotToRows(snapshot));

/**
 * 行集 → 8 份 Git-native 同步文件（7 份 YAML + MANIFEST）。
 * 合并完成后直接用「合并后的行」渲染，保证写回文件的内容就是新基线。
 */
export function renderGitSyncFilesFromRows(rows: WorkspaceRowsPayload): Record<string, string> {
  const safe = canonicalGitSyncRows(rows);
  const out: Record<string, string> = {};
  for (const domain of GIT_MIRROR_DOMAINS) {
    const items = (safe[domain.rowDomain] ?? []) as unknown as unknown[];
    out[domain.file] = renderDomain(domain.label, items, GIT_SYNC_SCHEMA);
  }
  out[GIT_MIRROR_MANIFEST_FILE] = GIT_SYNC_MANIFEST;
  return out;
}

/** 快照 → 8 份 Git-native 同步文件（便捷入口）。 */
export const renderGitSyncFiles = (snapshot: WorkspaceSnapshot): Record<string, string> =>
  renderGitSyncFilesFromRows(snapshotToRows(snapshot));
