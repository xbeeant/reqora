import type { KeyValue } from "../types.ts";
import { uid } from "./id.ts";

/**
 * 合并环境级全局 Header。请求里已显式声明同名头时以请求为准（与
 * `effectiveRequest` 里「用户显式头优先」的规则一致），只追加启用的、
 * 键非空的全局行。返回新数组；没有可追加项时原样返回入参，方便调用方
 * 判断是否需要重建 request 对象。
 */
export function mergeGlobalHeaders(
  requestHeaders: KeyValue[],
  globalHeaders: KeyValue[] | undefined,
): KeyValue[] {
  if (!globalHeaders || globalHeaders.length === 0) return requestHeaders;
  const base = requestHeaders ?? [];
  const seen = new Set(
    base
      .filter((item) => item.enabled && item.key.trim())
      .map((item) => item.key.trim().toLowerCase()),
  );
  const additions: KeyValue[] = [];
  for (const header of globalHeaders) {
    if (!header.enabled || !header.key.trim()) continue;
    const key = header.key.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push({ ...header, id: uid(), enabled: true });
  }
  return additions.length > 0 ? [...base, ...additions] : base;
}

export type EnvDiffStatus = "only-source" | "only-target" | "different" | "same";

export interface EnvDiffRow {
  /** 已按比较规则归一化过的 key，同时也是合并时的选中标识。 */
  key: string;
  /** 展示用原始 key（取 source，没有则取 target）。 */
  label: string;
  status: EnvDiffStatus;
  sourceValue: string | null;
  targetValue: string | null;
}

interface IndexedRow {
  key: string;
  label: string;
  value: string;
  enabled: boolean;
  /** Upload-redaction override; carried across an environment merge. */
  secret?: boolean;
}

function indexRows(rows: KeyValue[] | undefined, caseInsensitive: boolean): IndexedRow[] {
  const out: IndexedRow[] = [];
  const seen = new Map<string, number>();
  for (const row of rows ?? []) {
    const label = row.key.trim();
    if (!label) continue;
    const key = caseInsensitive ? label.toLowerCase() : label;
    const existing = seen.get(key);
    const indexed: IndexedRow = {
      key,
      label,
      value: row.value,
      enabled: row.enabled !== false,
      ...(row.secret === undefined ? {} : { secret: row.secret }),
    };
    if (existing === undefined) {
      seen.set(key, out.length);
      out.push(indexed);
    } else if (indexed.enabled) {
      // 后出现的启用行覆盖同名的禁用/占位行。
      out[existing] = indexed;
    }
  }
  return out;
}

/**
 * 对比两组键值（变量或全局 Header）。只比较键非空的有效行；
 * 结果顺序为「源独有 / 双方都有」在前，目标独有在后。
 */
export function diffKeyValueLists(
  source: KeyValue[] | undefined,
  target: KeyValue[] | undefined,
  caseInsensitive = false,
): EnvDiffRow[] {
  const src = indexRows(source, caseInsensitive);
  const dst = indexRows(target, caseInsensitive);
  const dstByKey = new Map(dst.map((row) => [row.key, row]));
  const rows: EnvDiffRow[] = [];
  for (const row of src) {
    const other = dstByKey.get(row.key);
    if (!other) {
      rows.push({ key: row.key, label: row.label, status: "only-source", sourceValue: row.value, targetValue: null });
    } else {
      const same = other.value === row.value && other.enabled === row.enabled;
      rows.push({
        key: row.key,
        label: row.label,
        status: same ? "same" : "different",
        sourceValue: row.value,
        targetValue: other.value,
      });
    }
  }
  for (const row of dst) {
    if (!src.some((item) => item.key === row.key)) {
      rows.push({ key: row.key, label: row.label, status: "only-target", sourceValue: null, targetValue: row.value });
    }
  }
  return rows;
}

/**
 * 把源环境中选中的键合并进目标环境。同名项默认保留目标值；
 * `overwrite` 为真时用源值覆盖。返回新的键值数组。
 */
export function applyEnvMerge(
  target: KeyValue[] | undefined,
  source: KeyValue[] | undefined,
  selectedKeys: string[],
  overwrite: boolean,
  caseInsensitive = false,
): KeyValue[] {
  const result = [...(target ?? [])];
  if (selectedKeys.length === 0) return result;
  const wanted = new Set(selectedKeys);
  const srcByKey = new Map(
    indexRows(source, caseInsensitive)
      .filter((row) => row.enabled)
      .map((row) => [row.key, row]),
  );
  const positionOf = (key: string) =>
    result.findIndex((row) => {
      const label = row.key.trim();
      if (!label) return false;
      return (caseInsensitive ? label.toLowerCase() : label) === key;
    });

  for (const key of wanted) {
    const src = srcByKey.get(key);
    if (!src) continue;
    const at = positionOf(key);
    if (at < 0) {
      result.push({
        id: uid(),
        key: src.label,
        value: src.value,
        enabled: true,
        ...(src.secret === undefined ? {} : { secret: src.secret }),
      });
      continue;
    }
    if (overwrite || !result[at].enabled || !result[at].key.trim()) {
      // The value now comes from the source row, so its redaction override must
      // travel with it — otherwise a source value marked "hide" could become
      // "share" just because the target row had a different setting.
      result[at] = {
        ...result[at],
        key: src.label,
        value: src.value,
        enabled: true,
        ...(src.secret === undefined ? {} : { secret: src.secret }),
      };
    }
  }
  return result;
}
