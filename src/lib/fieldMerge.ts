/**
 * 结构化字段级三方合并（冲突裁决用）。
 *
 * 与行级 LWW 的区别：以「基线行 B」为共同祖先，递归比较本地 L / 云端 R：
 * - L == R              → 收敛，直接采用；
 * - L == B              → 只有云端改了，采用云端；
 * - R == B              → 只有本地改了，采用本地；
 * - 三者都不同且是对象  → 逐字段递归；
 * - 三者都不同且是数组  → 按元素稳定 id（或元素值）做集合三方合并：
 *                          双方各自新增的条目都保留，单方修改/删除自动采用，
 *                          仅「同一条目双方都改」才下钻到条目内部逐字段；
 * - 其余（标量、文本、类型不同的子树）→ 生成一个「选择点」交给用户。
 *
 * 设计要点：
 * - 纯函数。`planFieldMerge()` 产出选择点清单，`composeMergedRow()` 用同一套
 *   合并树 + 用户选择重算出最终行，因此预览永远等于真正落库的结果。
 * - 结构字段（id / updatedAt / folderId / position …）不开放选择，一律采用
 *   本地值：选错会破坏引用关系，而且合成行本来就是「本地的一次新编辑」。
 * - 删除 vs 修改、大对象（__blob 引用）不适合逐字段，退化为整行二选一。
 * - 不 import 任何运行时依赖，便于 Node 单测直接加载。
 */
import type { ThreeWayConflict } from "./workspaceRows.ts";

export type AnyRow = Record<string, unknown>;
export type FieldSource = "local" | "remote" | "custom";

export interface FieldChoice {
  /** 稳定路径，同时作为选择状态的 key，如 `data.headers[hv1].value`。 */
  path: string;
  /** 中文展示名，如「请求头 X-Trace · 参数值」。 */
  label: string;
  kind: "scalar" | "text" | "blob" | "delete-vs-edit" | "row";
  /** 三方值；undefined 表示该侧没有这个字段 / 条目。 */
  base: unknown;
  local: unknown;
  remote: unknown;
  /** 默认来源。冲突保留本地是既有语义，不因弹窗改变。 */
  defaultSource: FieldSource;
}

export interface FieldSelection {
  source: FieldSource;
  /** source === "custom" 时的用户编辑文本（仅 text 类选择点可用）。 */
  custom?: string;
}

export type FieldSelections = Record<string, FieldSelection>;

export interface FieldMergePlan {
  domain: string;
  id: string;
  name: string;
  /** fields = 逐字段合并；whole-row = 删除 vs 修改 / 缺基线，整行二选一。 */
  mode: "fields" | "whole-row";
  /** whole-row 模式的原因，UI 上解释为什么不能逐字段。 */
  wholeRowReason: string | null;
  base: AnyRow | null;
  local: AnyRow;
  remote: AnyRow | null;
  choices: FieldChoice[];
  /** 自动采用的叶子字段数量（展示「已自动合并 N 处」）。 */
  autoFields: number;
  /** 自动采用本地值的结构字段，UI 上一句提示即可。 */
  structural: string[];
}

/** 「字段不存在」与 undefined 等价，但必须与 null / 空串区分。 */
const MISSING = Symbol("missing");
type Maybe = unknown | typeof MISSING;

function stable(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}

const norm = (value: Maybe): string => (value === MISSING ? "\u0000missing" : stable(value));
const eq = (a: Maybe, b: Maybe): boolean => norm(a) === norm(b);

const isRecord = (value: unknown): value is AnyRow =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const present = (value: Maybe): unknown => (value === MISSING ? undefined : value);
const maybe = (value: unknown): Maybe => (value === undefined ? MISSING : value);

function get(container: Maybe, key: string | number): Maybe {
  if (!isRecord(container) && !Array.isArray(container)) return MISSING;
  const record = container as Record<string | number, unknown>;
  return Object.prototype.hasOwnProperty.call(record, key) ? maybe(record[key]) : MISSING;
}

/** 顶层与任意层级的记账 / 身份字段：不允许用户挑选，一律用本地值。 */
const TOP_LEVEL_STRUCTURAL = new Set([
  "id",
  "updatedAt",
  "deleted",
  "folderId",
  "folderPath",
  "position",
  "requestId",
  "caseGroup",
  "kind",
  "contentUpdatedAt",
  "syncedAt",
  "createdAt",
  "lastRun",
]);
const ANY_LEVEL_STRUCTURAL = new Set([
  "id",
  "updatedAt",
  "createdAt",
  "syncedAt",
  "lastRun",
  "contentUpdatedAt",
]);

const FIELD_LABELS: Record<string, string> = {
  name: "名称",
  method: "请求方法",
  url: "请求地址",
  protocol: "协议",
  description: "描述",
  auth: "鉴权",
  data: "行内数据",
  headers: "请求头",
  query: "查询参数",
  pathVariables: "路径变量",
  variables: "环境变量",
  body: "请求体",
  preScript: "前置脚本",
  postScript: "后置脚本",
  assertions: "断言",
  stream: "流式模式",
  doc: "文档",
  folders: "子文件夹",
  enabled: "启用状态",
  folderId: "所属集合",
  folderPath: "文件夹路径",
  position: "排序位置",
  updatedAt: "更新时间",
  deleted: "删除标记",
  requestId: "关联接口",
  caseGroup: "用例分组",
  contentUpdatedAt: "内容更新时间",
  syncedAt: "同步时间",
  createdAt: "创建时间",
  lastRun: "最近运行",
  key: "参数名",
  value: "参数值",
  secret: "脱敏标记",
  raw: "正文",
  text: "正文",
  kind: "类型",
  mode: "模式",
  contentType: "内容类型",
  steps: "场景步骤",
  items: "套件成员",
  request: "用例请求快照",
  expectedStatus: "期望状态码",
  dataSet: "数据集",
  schemaText: "Schema 文本",
  group: "分组",
  refId: "引用",
  source: "来源",
  op: "比较操作",
  path: "路径",
  title: "标题",
  status: "状态",
};

const TEXT_LEAVES = new Set([
  "raw",
  "text",
  "body",
  "preScript",
  "postScript",
  "schemaText",
  "description",
  "doc",
  "content",
  "value",
  "url",
]);

const labelOf = (field: string): string => FIELD_LABELS[field] ?? field;
const isTextual = (value: Maybe): boolean =>
  typeof value === "string" && (value.length > 100 || value.includes("\n") || value.includes("{"));

/** 大字段外置后的引用对象：内容不在行里，只能按引用整体二选一。 */
function isBlobRef(value: Maybe): boolean {
  return isRecord(value) && typeof value.__blob === "string";
}

/** 数组元素的稳定身份。只有「全部元素都有 id/key」或「全部是原始值」才可做集合合并。 */
function arrayKeyMode(values: Maybe[]): "id" | "value" | "opaque" {
  const flat = values.flatMap((value) => (Array.isArray(value) ? value : []));
  if (flat.length === 0) return "value";
  if (flat.every((item) => item === null || typeof item !== "object")) return "value";
  if (
    flat.every(
      (item) =>
        isRecord(item) &&
        (typeof item.id === "string" || typeof item.key === "string" || typeof item.refId === "string"),
    )
  ) {
    return "id";
  }
  return "opaque";
}

function elementKey(item: unknown, mode: "id" | "value"): string {
  if (mode === "id" && isRecord(item)) {
    if (typeof item.id === "string" && item.id) return `id:${item.id}`;
    if (typeof item.key === "string" && item.key) return `key:${item.key}`;
    if (typeof item.refId === "string" && item.refId) return `ref:${item.refId}`;
  }
  return `v:${stable(item)}`;
}

function elementLabel(item: unknown): string {
  if (isRecord(item)) {
    const name = item.key ?? item.name ?? item.id ?? item.refId;
    if (typeof name === "string" && name) return name;
  }
  if (typeof item === "string" || typeof item === "number") return String(item);
  return "条目";
}

interface BuildContext {
  choices: FieldChoice[];
  autoFields: number;
  structural: Set<string>;
  selections: FieldSelections | null;
}

function recordChoice(
  ctx: BuildContext,
  path: string,
  label: string,
  base: Maybe,
  local: Maybe,
  remote: Maybe,
): Maybe {
  const kind: FieldChoice["kind"] =
    local === MISSING || remote === MISSING
      ? "delete-vs-edit"
      : isBlobRef(local) || isBlobRef(remote)
        ? "blob"
        : isTextual(local) || isTextual(remote) || TEXT_LEAVES.has(path.split(".").pop() ?? "")
          ? "text"
          : "scalar";
  const choice: FieldChoice = {
    path,
    label,
    kind,
    base: present(base),
    local: present(local),
    remote: present(remote),
    defaultSource: "local",
  };
  ctx.choices.push(choice);
  if (!ctx.selections) return local;

  const selection = ctx.selections[path];
  const source = selection?.source ?? choice.defaultSource;
  if (source === "custom") {
    const raw = selection?.custom ?? "";
    const example = local !== MISSING ? local : remote;
    if (typeof example === "string") return raw;
    try {
      return maybe(JSON.parse(raw));
    } catch {
      return example;
    }
  }
  return source === "remote" ? remote : local;
}

function mergeNode(
  ctx: BuildContext,
  path: string,
  field: string,
  label: string,
  base: Maybe,
  local: Maybe,
  remote: Maybe,
): Maybe {
  // 1) 收敛 / 单方改动：无需用户决策。
  if (eq(local, remote)) {
    ctx.autoFields += 1;
    return local;
  }
  if (eq(local, base)) {
    ctx.autoFields += 1;
    return remote;
  }
  if (eq(remote, base)) {
    ctx.autoFields += 1;
    return local;
  }

  // 2) 双方都改：结构字段一律采用本地，绝不开放给用户。
  if (
    ANY_LEVEL_STRUCTURAL.has(field) ||
    (path === field && TOP_LEVEL_STRUCTURAL.has(field))
  ) {
    ctx.structural.add(label);
    return local;
  }

  // 3) 对象：逐字段递归（某一侧缺失时按 {} 参与，等价于「新增/删除整棵子树」）。
  if (
    (isRecord(base) || base === MISSING) &&
    (isRecord(local) || local === MISSING) &&
    (isRecord(remote) || remote === MISSING) &&
    (isRecord(base) || isRecord(local) || isRecord(remote))
  ) {
    // 只要有一侧不是对象（例如对象 vs 字符串），就别拆了，整体二选一。
    if (base !== MISSING && !isRecord(base)) return recordChoice(ctx, path, label, base, local, remote);
    if (local !== MISSING && !isRecord(local)) return recordChoice(ctx, path, label, base, local, remote);
    if (remote !== MISSING && !isRecord(remote)) return recordChoice(ctx, path, label, base, local, remote);
    if (isBlobRef(base) || isBlobRef(local) || isBlobRef(remote)) {
      return recordChoice(ctx, path, label, base, local, remote);
    }
    const keys = new Set<string>([
      ...(isRecord(base) ? Object.keys(base) : []),
      ...(isRecord(local) ? Object.keys(local) : []),
      ...(isRecord(remote) ? Object.keys(remote) : []),
    ]);
    const result: AnyRow = {};
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      const child = mergeNode(
        ctx,
        childPath,
        key,
        path ? `${label} · ${labelOf(key)}` : labelOf(key),
        get(base, key),
        get(local, key),
        get(remote, key),
      );
      if (child !== MISSING) result[key] = child;
    }
    return result;
  }

  // 4) 数组：按元素稳定身份做集合三方合并。
  if (
    (base === MISSING || Array.isArray(base)) &&
    (local === MISSING || Array.isArray(local)) &&
    (remote === MISSING || Array.isArray(remote)) &&
    (Array.isArray(base) || Array.isArray(local) || Array.isArray(remote))
  ) {
    if (
      (base !== MISSING && !Array.isArray(base)) ||
      (local !== MISSING && !Array.isArray(local)) ||
      (remote !== MISSING && !Array.isArray(remote))
    ) {
      return recordChoice(ctx, path, label, base, local, remote);
    }
    const mode = arrayKeyMode([base, local, remote]);
    if (mode === "opaque") return recordChoice(ctx, path, label, base, local, remote);
    return mergeArray(ctx, path, label, base, local, remote, mode);
  }

  // 5) 标量 / 文本 / 类型冲突：交给用户选。
  return recordChoice(ctx, path, label, base, local, remote);
}

function mergeArray(
  ctx: BuildContext,
  path: string,
  label: string,
  base: Maybe,
  local: Maybe,
  remote: Maybe,
  mode: "id" | "value",
): Maybe {
  const B = Array.isArray(base) ? base : [];
  const L = Array.isArray(local) ? local : [];
  const R = Array.isArray(remote) ? remote : [];
  const byKey = (list: unknown[]): Map<string, unknown> => {
    const map = new Map<string, unknown>();
    for (const item of list) {
      const key = elementKey(item, mode);
      if (!map.has(key)) map.set(key, item);
    }
    return map;
  };
  const bMap = byKey(B);
  const lMap = byKey(L);
  const rMap = byKey(R);
  const at = (map: Map<string, unknown>, key: string): Maybe =>
    map.has(key) ? maybe(map.get(key)) : MISSING;

  // 顺序：以本地为基准，追加云端新增；基线里被双方保留的旧项也按本地顺序。
  const order: string[] = [];
  for (const item of L) {
    const key = elementKey(item, mode);
    if (!order.includes(key)) order.push(key);
  }
  for (const item of R) {
    const key = elementKey(item, mode);
    if (!order.includes(key)) order.push(key);
  }
  for (const item of B) {
    const key = elementKey(item, mode);
    if (!order.includes(key)) order.push(key);
  }

  const result: unknown[] = [];
  for (const key of order) {
    const b = at(bMap, key);
    const l = at(lMap, key);
    const r = at(rMap, key);
    const sample = l !== MISSING ? l : (r !== MISSING ? r : b);
    const childLabel = `${label}「${elementLabel(sample)}」`;
    const childPath = `${path}[${key}]`;
    if (eq(l, r)) {
      ctx.autoFields += 1;
      if (l !== MISSING) result.push(l);
      continue;
    }
    if (eq(l, b)) {
      ctx.autoFields += 1;
      if (r !== MISSING) result.push(r);
      continue;
    }
    if (eq(r, b)) {
      ctx.autoFields += 1;
      if (l !== MISSING) result.push(l);
      continue;
    }
    // 同一条目双方都改：删除 vs 修改 / 都是对象则下钻到条目字段。
    if (l === MISSING || r === MISSING) {
      const chosen = recordChoice(ctx, childPath, childLabel, b, l, r);
      if (chosen !== MISSING) result.push(chosen);
      continue;
    }
    if (isRecord(l) && isRecord(r) && (b === MISSING || isRecord(b))) {
      const merged = mergeNode(ctx, childPath, "", childLabel, b, l, r);
      if (merged !== MISSING) result.push(merged);
      continue;
    }
    const chosen = recordChoice(ctx, childPath, childLabel, b, l, r);
    if (chosen !== MISSING) result.push(chosen);
  }
  return result;
}

export const ROW_CHOICE_PATH = "__row__";

function build(conflict: ThreeWayConflict, selections: FieldSelections | null) {
  const base = (conflict.base ?? null) as AnyRow | null;
  const local = (conflict.local ?? {}) as AnyRow;
  const remote = (conflict.remote ?? null) as AnyRow | null;
  const ctx: BuildContext = {
    choices: [],
    autoFields: 0,
    structural: new Set(),
    selections,
  };

  const wholeRowReason =
    !remote
      ? "云端已删除该行，只能选择保留本地版本或跟随删除"
      : local.deleted === true || remote.deleted === true
        ? "其中一侧是删除操作，逐字段合并没有意义"
        : !base
          ? "缺少基线行，无法判断哪些字段是各自修改的"
          : null;

  if (wholeRowReason) {
    const choice: FieldChoice = {
      path: ROW_CHOICE_PATH,
      label: "整行版本",
      kind: "row",
      base: base ? `基线版本 · ${base.name ?? conflict.id}` : null,
      local: `本地版本 · ${local.name ?? conflict.id}`,
      remote: remote ? `云端版本 · ${remote.name ?? conflict.id}` : "（已删除）",
      defaultSource: "local",
    };
    ctx.choices.push(choice);
    let row: AnyRow | null = { ...local };
    if (selections) {
      const source = selections[ROW_CHOICE_PATH]?.source ?? "local";
      if (source === "remote") {
        if (!remote || remote.deleted === true) row = null;
        else row = { ...remote };
      }
    }
    return {
      row,
      plan: {
        domain: conflict.domain,
        id: conflict.id,
        name: conflict.name,
        mode: "whole-row" as const,
        wholeRowReason,
        base,
        local,
        remote,
        choices: ctx.choices,
        autoFields: 0,
        structural: [],
      } satisfies FieldMergePlan,
    };
  }

  const keys = new Set<string>([
    ...Object.keys(base ?? {}),
    ...Object.keys(local),
    ...Object.keys(remote ?? {}),
  ]);
  const result: AnyRow = {};
  for (const key of keys) {
    const value = mergeNode(
      ctx,
      key,
      key,
      labelOf(key),
      get(base, key),
      get(local, key),
      get(remote, key),
    );
    if (value !== MISSING) result[key] = value;
  }
  // 身份列必须存在，否则合成行会被当成新行 / 引用丢失。
  if (result.id === undefined) result.id = local.id ?? conflict.id;
  return {
    row: result as AnyRow | null,
    plan: {
      domain: conflict.domain,
      id: conflict.id,
      name: conflict.name,
      mode: "fields" as const,
      wholeRowReason: null,
      base,
      local,
      remote,
      choices: ctx.choices,
      autoFields: ctx.autoFields,
      structural: [...ctx.structural],
    } satisfies FieldMergePlan,
  };
}

/** 分析一条冲突，产出选择点清单（供弹窗渲染）。 */
export function planFieldMerge(conflict: ThreeWayConflict): FieldMergePlan {
  return build(conflict, null).plan;
}

/**
 * 按用户选择重算最终行。返回 null 表示「删除该行」（整行模式下跟随云端删除）。
 * 与 planFieldMerge 走同一棵合并树，因此预览 === 落库结果。
 */
export function composeMergedRow(
  plan: FieldMergePlan,
  selections: FieldSelections,
): AnyRow | null {
  return build(
    {
      domain: plan.domain as ThreeWayConflict["domain"],
      id: plan.id,
      name: plan.name,
      base: plan.base,
      local: plan.local,
      remote: plan.remote,
    },
    selections,
  ).row;
}

/** 默认选择：全部保留本地（与既有「冲突时保留本地」语义一致）。 */
export function defaultSelections(plan: FieldMergePlan): FieldSelections {
  const result: FieldSelections = {};
  for (const choice of plan.choices) result[choice.path] = { source: choice.defaultSource };
  return result;
}

/** 一键「全用本地」/「全用云端」。 */
export function uniformSelections(plan: FieldMergePlan, source: "local" | "remote"): FieldSelections {
  const result: FieldSelections = {};
  for (const choice of plan.choices) result[choice.path] = { source };
  return result;
}

/**
 * 合成行是一次新的本地编辑：时间戳必须严格晚于远端版本，否则服务端 LWW
 * 不会采纳（相等时间戳按服务端接收序裁决，也不保证覆盖）。
 */
export function stampMergedRow(
  row: AnyRow,
  remoteUpdatedAt: unknown,
  now = Date.now(),
): AnyRow {
  const localAt = typeof row.updatedAt === "number" ? row.updatedAt : 0;
  const remoteAt = typeof remoteUpdatedAt === "number" ? remoteUpdatedAt : 0;
  const next = Math.max(localAt, remoteAt, now - 1) + 1;
  // 不改 deleted：whole-row 模式下「保留本地删除」需要把墓碑一并上传。
  return { ...row, updatedAt: next };
}
