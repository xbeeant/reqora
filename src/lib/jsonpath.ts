/**
 * A small, dependency-free JSONPath evaluator for the response Tree view.
 *
 * Supported: `$.a.b`, `['a']`, `[0]`, `[0,2]`, `.*` / `[*]`, `..name`,
 * `..*`, `[1:5]`, `[?(@.id == 3)]`, `[?(@.active)]`, and any combination.
 * There is deliberately no `eval` / `new Function` — response bodies are
 * untrusted data, and the WebView CSP forbids dynamic code generation.
 */

export interface JsonPathMatch {
  /** Canonical path, e.g. `$['items'][0]['name']`. */
  path: string;
  value: unknown;
}

export interface JsonPathQuery {
  ok: boolean;
  error: string | null;
  matches: JsonPathMatch[];
  /** True when MAX_MATCHES was hit; the UI shows a "+" hint. */
  truncated: boolean;
}

const MAX_MATCHES = 2000;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

type Step =
  | { kind: "child"; keys: string[] }
  | { kind: "wildcard" }
  | { kind: "index"; indices: number[] }
  | { kind: "slice"; start?: number; end?: number; step?: number }
  | { kind: "recursive"; key: string | null }
  | { kind: "filter"; key: string; op: string | null; literal: unknown };

/** Parse a JSONPath expression into steps. Throws with a readable message. */
export function parseJsonPath(expression: string): Step[] {
  const raw = expression.trim();
  if (!raw) throw new Error("请输入 JSONPath 表达式");
  let source = raw;
  if (!source.startsWith("$")) source = `$${source.startsWith(".") ? "" : "."}${source}`;
  let cursor = 1;
  const steps: Step[] = [];

  const readName = (): string => {
    const start = cursor;
    while (cursor < source.length && !/[.[\]]/.test(source[cursor])) cursor++;
    const name = source.slice(start, cursor).trim();
    if (!name) throw new Error(`第 ${cursor + 1} 个字符附近缺少字段名`);
    return name;
  };

  while (cursor < source.length) {
    const char = source[cursor];
    if (char === ".") {
      if (source[cursor + 1] === ".") {
        cursor += 2;
        if (source[cursor] === "*") {
          steps.push({ kind: "recursive", key: null });
          cursor++;
        } else if (source[cursor] === "[") {
          steps.push({ kind: "recursive", key: null });
        } else {
          steps.push({ kind: "recursive", key: readName() });
        }
      } else {
        cursor++;
        if (source[cursor] === "*") {
          steps.push({ kind: "wildcard" });
          cursor++;
        } else {
          steps.push({ kind: "child", keys: [readName()] });
        }
      }
      continue;
    }
    if (char === "[") {
      const close = findClosingBracket(source, cursor);
      const inner = source.slice(cursor + 1, close).trim();
      cursor = close + 1;
      if (!inner) throw new Error("[] 中不能为空");
      steps.push(parseBracket(inner));
      continue;
    }
    throw new Error(`第 ${cursor + 1} 个字符「${char}」无法解析`);
  }
  return steps;
}

function findClosingBracket(source: string, open: number): number {
  let quote: string | null = null;
  for (let i = open + 1; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "]") return i;
  }
  throw new Error("缺少右方括号 ]");
}

function parseBracket(inner: string): Step {
  if (inner === "*") return { kind: "wildcard" };
  if (inner.startsWith("?(")) {
    if (!inner.endsWith(")")) throw new Error("过滤器需要以 ) 结束");
    return parseFilter(inner.slice(2, -1));
  }
  // Quoted key list: 'a', "b"
  if (inner.startsWith("'") || inner.startsWith('"')) {
    const keys = splitTopLevel(inner, ",").map((part) => {
      const value = part.trim();
      const quote = value[0];
      if (!value.endsWith(quote) || value.length < 2) {
        throw new Error(`字段名引号不匹配：${value}`);
      }
      return value.slice(1, -1).replace(/\\(.)/g, "$1");
    });
    return { kind: "child", keys };
  }
  // Slice: [start:end] or [start:end:step]
  if (inner.includes(":")) {
    const parts = inner.split(":");
    if (parts.length > 3) throw new Error("切片最多支持 start:end:step");
    const number = (text: string): number | undefined => {
      const trimmed = text.trim();
      if (!trimmed) return undefined;
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed)) throw new Error(`切片索引不合法：${trimmed}`);
      return parsed;
    };
    return {
      kind: "slice",
      start: number(parts[0]),
      end: number(parts[1]),
      step: number(parts[2] ?? ""),
    };
  }
  // Index list
  const indices = splitTopLevel(inner, ",").map((part) => {
    const parsed = Number(part.trim());
    if (!Number.isInteger(parsed)) throw new Error(`数组下标不合法：${part.trim()}`);
    return parsed;
  });
  return { kind: "index", indices };
}

function parseFilter(body: string): Step {
  const match = /^\s*@\.([A-Za-z_$][A-Za-z0-9_$]*)\s*(==|!=|>=|<=|>|<)?\s*([\s\S]*?)\s*$/.exec(body);
  if (!match) throw new Error("过滤器格式应为 @.字段 == 值，或 @.字段（存在性）");
  const [, key, op, literalText] = match;
  if (!op) {
    if (literalText.trim()) throw new Error("存在性过滤器不能带比较值");
    return { kind: "filter", key, op: null, literal: undefined };
  }
  return { kind: "filter", key, op, literal: parseLiteral(literalText) };
}

function parseLiteral(text: string): unknown {
  const value = text.trim();
  if (!value) throw new Error("比较运算符后缺少值");
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  const number = Number(value);
  if (!Number.isNaN(number)) return number;
  throw new Error(`无法识别的比较值：${value}`);
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === separator) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

function entriesOf(value: unknown): [string, unknown][] {
  if (Array.isArray(value)) return value.map((item, index) => [String(index), item]);
  if (isContainer(value)) return Object.entries(value as Record<string, unknown>);
  return [];
}

function getChild(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < value.length
      ? value[index]
      : undefined;
  }
  if (isContainer(value)) return (value as Record<string, unknown>)[key];
  return undefined;
}

function hasChild(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < value.length;
  }
  return isContainer(value) && Object.prototype.hasOwnProperty.call(value, key);
}

/** Canonical child path. Exported so the tree and the evaluator stay in sync. */
export function childPath(parent: string, key: string): string {
  if (IDENT.test(key)) return `${parent}.${key}`;
  if (/^(0|[1-9]\d*)$/.test(key)) return `${parent}[${key}]`;
  return `${parent}[${JSON.stringify(key)}]`;
}

/** Split `$['items'][0].name` into its canonical prefixes (excluding `$`). */
export function pathPrefixes(path: string): string[] {
  const prefixes: string[] = [];
  let current = "$";
  let i = 1;
  while (i < path.length) {
    if (path[i] === ".") {
      i++;
      const start = i;
      while (i < path.length && path[i] !== "." && path[i] !== "[") i++;
      current += `.${path.slice(start, i)}`;
    } else if (path[i] === "[") {
      const start = i;
      i++;
      let quote: string | null = null;
      while (i < path.length) {
        const char = path[i];
        if (quote) {
          if (char === "\\") i += 2;
          else { if (char === quote) quote = null; i++; }
          continue;
        }
        if (char === '"' || char === "'") { quote = char; i++; continue; }
        if (char === "]") { i++; break; }
        i++;
      }
      current += path.slice(start, i);
    } else {
      i++;
      continue;
    }
    prefixes.push(current);
  }
  return prefixes;
}

/** Exact match paths plus every ancestor, for highlighting a JSON tree. */
export function collectPaths(matches: JsonPathMatch[]): {
  exact: Set<string>;
  ancestors: Set<string>;
} {
  const exact = new Set<string>();
  const ancestors = new Set<string>();
  for (const match of matches) {
    exact.add(match.path);
    for (const prefix of pathPrefixes(match.path)) ancestors.add(prefix);
  }
  for (const path of exact) ancestors.delete(path);
  return { exact, ancestors };
}

function compare(actual: unknown, op: string, expected: unknown): boolean {
  if (op === "==") return actual === expected;
  if (op === "!=") return actual !== expected;
  const left = typeof actual === "number" ? actual : Number(actual);
  const right = typeof expected === "number" ? expected : Number(expected);
  if (Number.isNaN(left) || Number.isNaN(right)) return false;
  switch (op) {
    case ">": return left > right;
    case "<": return left < right;
    case ">=": return left >= right;
    case "<=": return left <= right;
    default: return false;
  }
}

function walk(
  steps: Step[],
  index: number,
  value: unknown,
  path: string,
  out: JsonPathMatch[],
): boolean {
  if (out.length >= MAX_MATCHES) return true;
  if (index === steps.length) {
    out.push({ path, value });
    return out.length >= MAX_MATCHES;
  }
  const step = steps[index];
  const next = (child: unknown, childKey: string) =>
    walk(steps, index + 1, child, childPath(path, childKey), out);

  switch (step.kind) {
    case "child": {
      if (!isContainer(value)) return false;
      for (const key of step.keys) {
        if (hasChild(value, key) && next(getChild(value, key), key)) return true;
      }
      return false;
    }
    case "wildcard": {
      for (const [key, child] of entriesOf(value)) {
        if (next(child, key)) return true;
      }
      return false;
    }
    case "index": {
      if (!Array.isArray(value)) return false;
      for (const raw of step.indices) {
        const position = raw < 0 ? value.length + raw : raw;
        if (position >= 0 && position < value.length && next(value[position], String(position))) {
          return true;
        }
      }
      return false;
    }
    case "slice": {
      if (!Array.isArray(value)) return false;
      const stepSize = step.step ?? 1;
      if (stepSize === 0) return false;
      let start = step.start ?? (stepSize > 0 ? 0 : value.length - 1);
      let end = step.end ?? (stepSize > 0 ? value.length : -1);
      if (start < 0) start = Math.max(value.length + start, 0);
      if (end < 0 && step.end !== undefined) end = Math.max(value.length + end, 0);
      if (stepSize > 0) {
        for (let i = Math.max(start, 0); i < Math.min(end, value.length); i += stepSize) {
          if (next(value[i], String(i))) return true;
        }
      } else {
        for (let i = Math.min(start, value.length - 1); i > end; i += stepSize) {
          if (next(value[i], String(i))) return true;
        }
      }
      return false;
    }
    case "recursive": {
      const found: JsonPathMatch[] = [];
      const visit = (node: unknown, nodePath: string, depth: number) => {
        if (depth > 64 || found.length >= MAX_MATCHES) return;
        for (const [key, child] of entriesOf(node)) {
          const nextPath = childPath(nodePath, key);
          if (step.key === null || key === step.key) found.push({ path: nextPath, value: child });
          visit(child, nextPath, depth + 1);
        }
      };
      visit(value, path, 0);
      for (const match of found) {
        if (walk(steps, index + 1, match.value, match.path, out)) return true;
      }
      return false;
    }
    case "filter": {
      for (const [key, child] of entriesOf(value)) {
        if (!isContainer(child)) continue;
        const present = hasChild(child, step.key);
        const actual = present ? getChild(child, step.key) : undefined;
        const hit = step.op === null
          ? present && actual !== undefined && actual !== null
          : present && compare(actual, step.op, step.literal);
        if (hit && next(child, key)) return true;
      }
      return false;
    }
  }
}

/** Evaluate a JSONPath expression against a parsed JSON value. Never throws. */
export function queryJsonPath(root: unknown, expression: string): JsonPathQuery {
  try {
    const steps = parseJsonPath(expression);
    const matches: JsonPathMatch[] = [];
    const truncated = walk(steps, 0, root, "$", matches);
    return { ok: true, error: null, matches, truncated };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      matches: [],
      truncated: false,
    };
  }
}

/** Short, readable preview of a match value for the result list. */
export function formatMatchValue(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = JSON.stringify(value);
  else if (value === undefined) text = "undefined";
  else if (isContainer(value)) {
    text = Array.isArray(value) ? `Array(${value.length})` : `{${Object.keys(value).length} keys}`;
  } else {
    try { text = JSON.stringify(value); } catch { text = String(value); }
  }
  if (text === undefined) text = String(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}
