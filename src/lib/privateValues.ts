/**
 * 「私密」变量的单一策略来源 —— 桌面端 (TS) 与 MCP 服务 (.mjs) 共用。
 *
 * 存储表示复用既有的 `KeyValue.secret === true`（见 types.ts 的三态注释）：
 * `true` = 值仅本机，`false` = 显式共享，`undefined` = 按名称自动判断。
 * 不新增字段，行模型 / 同步协议 / 后端 / SQLite 都不需要改动：
 * 云同步早已通过 `stripForUpload → redactSnapshot` 把 secret:true 的值置空，
 * 并在下载时用 `restoreRowsCredentials` 回填本机真实值，所以「变量名同步、
 * 值仅本机」这条语义天然成立。
 *
 * 本模块负责把同一语义推广到其余外发出口（文档站 / HTML / Markdown 导出、
 * 网页版 payload、MCP 工具与资源、脚本日志文本）。私密标记是用户的显式意图，
 * 优先级高于 `--reveal-secrets` 之类的全局开关：即使开启全局明文，私密值也不放行。
 */
import type { KeyValue } from "../types";
import { variablesFrom } from "./template.ts";

/** 与 MCP maskValue、redactSnapshot 一致的占位符。 */
export const PRIVATE_MASK = "***";

export function isPrivateVariable(row: KeyValue | null | undefined): boolean {
  return row?.secret === true;
}

/**
 * 对外渲染用的变量表：剔除私密行。`{{password}}` 这类模板会保持字面量，
 * 文档读者仍能看到「这里需要填什么」，但拿不到值。
 */
export function shareableVariables(rows: readonly KeyValue[] | undefined): Record<string, string> {
  return variablesFrom(
    (rows ?? []).filter((row) => !isPrivateVariable(row)) as KeyValue[],
  );
}

/**
 * 需要保留行结构的导出（如分享给同事的工作区片段）：保留 id / key /
 * enabled / secret 标记，只把值置空。与云同步的 blank-not-drop 约定一致。
 */
export function blankPrivateRows<T extends KeyValue>(rows: readonly T[] | undefined): T[] {
  return (rows ?? []).map((row) =>
    isPrivateVariable(row) ? ({ ...row, value: "" } as T) : row,
  );
}

/** 与具体快照类型解耦，MCP 侧的普通对象也能直接传入。 */
export interface SnapshotLike {
  environments?: Array<{ variables?: KeyValue[] }> | null;
}

export interface PrivateContext {
  /** 私密变量名，用于给「按 key 索引的变量表」兜底。 */
  keys: Set<string>;
  /** 私密变量的真实值，长到短排序，用于清洗自由文本（URL / 日志 / 响应体）。 */
  values: string[];
}

/**
 * 收集一个快照里所有环境变量的私密项。禁用行也收集：值可能曾被使用过，
 * 出现在历史 / 日志里仍需遮蔽。
 */
export function privateContext(snapshot: SnapshotLike | null | undefined): PrivateContext {
  const keys = new Set<string>();
  const values = new Set<string>();
  for (const environment of snapshot?.environments ?? []) {
    for (const row of environment.variables ?? []) {
      if (!isPrivateVariable(row)) continue;
      const key = String(row.key ?? "").trim();
      if (key) keys.add(key);
      // 过短的值（"1" / "a"）几乎必然出现在正常文本里，替换会造成大面积误伤。
      if (
        typeof row.value === "string" &&
        row.value.length >= 4 &&
        !row.value.includes(PRIVATE_MASK)
      ) {
        values.add(row.value);
      }
    }
  }
  return { keys, values: [...values].sort((a, b) => b.length - a.length) };
}

function maskScalar(value: unknown): string {
  if (typeof value !== "string") return typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
  if (!value || value.includes(PRIVATE_MASK)) return value;
  return value.length <= 8
    ? PRIVATE_MASK
    : `${value.slice(0, 3)}${PRIVATE_MASK}${value.slice(-2)}`;
}

/** 把自由文本里出现的私密值替换成占位符（幂等）。 */
export function maskPrivateText(text: string, ctx: PrivateContext): string {
  let out = text;
  for (const value of ctx.values) {
    if (value && out.includes(value)) out = out.split(value).join(PRIVATE_MASK);
  }
  return out;
}

/**
 * 出口兜底：递归清洗任意工具 / 资源返回值。
 * - 带 `private` 或 `secret: true` 标记的行，其 `value` / `expected` 强制打码；
 * - 键名命中私密变量名的字符串字段强制打码；
 * - 所有自由文本里出现的私密值替换为 `***`。
 * 无论调用方是否要求 reveal 都执行。
 */
export function enforcePrivate(value: unknown, ctx: PrivateContext): unknown {
  if (typeof value === "string") return maskPrivateText(value, ctx);
  if (Array.isArray(value)) return value.map((item) => enforcePrivate(item, ctx));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const rowPrivate = record.private === true || record.secret === true;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      const protectedField =
        (rowPrivate && (key === "value" || key === "expected")) ||
        ctx.keys.has(key.trim());
      out[key] =
        protectedField && typeof child === "string"
          ? maskScalar(child)
          : enforcePrivate(child, ctx);
    }
    return out;
  }
  return value;
}
