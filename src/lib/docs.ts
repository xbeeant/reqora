import type {
  BodySpec,
  ParamMeta,
  RequestDoc,
  RequestDraft,
  ResponseExample,
} from "../types";
import { emptyParamMeta } from "./docDefaults.ts";
import { formatResponseExampleBody } from "./responseExamples.ts";

/**
 * The interface documentation is a projection of the interface definition:
 * parameter rows are derived from the request's own query / header / body
 * rows, and `doc.paramMeta` only stores the doc-specific increments (type,
 * required, description, example) keyed by a stable row key. Editing either
 * side updates one source of truth.
 */

export type ParamLocation = "query" | "header" | "body";

export interface ParamRow {
  /** Stable key into `doc.paramMeta`. */
  key: string;
  location: ParamLocation;
  name: string;
  value: string;
  meta: ParamMeta;
}

export interface ParamSection {
  location: ParamLocation;
  label: string;
  rows: ParamRow[];
}

function metaFor(doc: RequestDoc, key: string, value?: string): ParamMeta {
  const stored = doc.paramMeta[key];
  const meta = { ...emptyParamMeta(), ...(stored ?? {}) };
  if (!meta.example && value && value !== "") meta.example = value;
  return meta;
}

/** Flatten a JSON example into leaf paths like `a.b[0].c` (arrays capped at 3). */
function flattenJson(value: unknown, prefix: string, out: { path: string; name: string; value: string; type: string }[]) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push({ path: prefix, name: prefix, value: "[]", type: "array" });
      return;
    }
    value.slice(0, 3).forEach((element, index) => {
      flattenJson(element, `${prefix}[${index}]`, out);
    });
    if (value.length > 3) {
      out.push({ path: `${prefix}[…]`, name: `${prefix}[…]`, value: `共 ${value.length} 项`, type: "array" });
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      out.push({ path: prefix, name: prefix, value: "{}", type: "object" });
      return;
    }
    for (const [key, child] of entries) {
      flattenJson(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  out.push({
    path: prefix,
    name: prefix,
    value: value === undefined ? "" : String(value),
    type: value === null ? "null" : typeof value,
  });
}

export function bodyFieldRows(body: BodySpec): { path: string; name: string; value: string; type: string }[] {
  switch (body.type) {
    case "none":
      return [];
    case "json": {
      const out: { path: string; name: string; value: string; type: string }[] = [];
      try {
        flattenJson(JSON.parse(body.content), "", out);
      } catch {
        out.push({ path: "body", name: "body", value: body.content, type: "invalid json" });
      }
      return out;
    }
    case "raw":
      return [{ path: "content", name: "content", value: body.content, type: body.contentType || "text" }];
    // form 行的 path 保留行 id（paramMeta 稳定键，改名不丢注释），name 才是展示用的字段名。
    case "formUrlEncoded":
      return body.items
        .filter((item) => item.key.trim())
        .map((item) => ({ path: item.id, name: item.key, value: item.value, type: "string" }));
    case "formData":
      return body.items
        .filter((item) => item.key.trim())
        .map((item) => ({
          path: item.id,
          name: item.key,
          value: item.file ? `<file:${item.fileName || "binary"}>` : item.value,
          type: item.file ? "file" : "string",
        }));
    case "binary":
      return [{ path: "file", name: "file", value: `<file:${body.fileName}>`, type: body.contentType || "binary" }];
    case "graphql":
      return [
        { path: "query", name: "query", value: body.query, type: "graphql" },
        { path: "variables", name: "variables", value: body.variables, type: "json" },
      ];
  }
}

/**
 * 从 JSON Body 的扁平叶子路径推导「容器字段」行（array / object）。
 *
 * `flattenJson` 只产出叶子（如 `specValueList[0].bid`），容器本身没有独立行，
 * 导致文档表格里 `productBidList` 只能是只读分组、无法填写示例值与说明。
 * 这里为每个中间层级合成一行，稳定 key 用无下标的容器路径（`b:specValueList`），
 * 追加在 body rows 末尾——树形投影时容器行会覆盖下标叶子成为分组行的 item，
 * 从而可编辑，同时叶子行的 key 与既有文档元数据保持兼容。
 */
export function containerFieldRows(
  fields: readonly { path: string; name: string; type: string }[],
): { path: string; name: string; value: string; type: string }[] {
  const containers = new Map<string, "array" | "object">();
  for (const field of fields) {
    const parts = field.path.split(".");
    let prefix = "";
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const bracket = part.indexOf("[");
      const base = bracket === -1 ? part : part.slice(0, bracket);
      if (base === "") continue;
      prefix = prefix === "" ? base : `${prefix}.${base}`;
      const hasIndex = bracket !== -1;
      const isLast = i === parts.length - 1;
      // 带数组下标的分段是数组容器；非末级分段是对象/数组容器；末级普通分段是叶子。
      if (!hasIndex && isLast) continue;
      const kind: "array" | "object" = hasIndex ? "array" : "object";
      if (!containers.has(prefix) || kind === "array") containers.set(prefix, kind);
    }
  }
  return [...containers].map(([path, type]) => ({ path, name: path, value: "", type }));
}

/** Derive the doc parameter tables from the live request rows. */
export function deriveParamSections(request: RequestDraft, doc: RequestDoc): ParamSection[] {
  const query: ParamRow[] = request.query
    .filter((row) => row.key.trim())
    .map((row) => ({
      key: `q:${row.id}`,
      location: "query" as const,
      name: row.key,
      value: row.value,
      meta: metaFor(doc, `q:${row.id}`, row.value),
    }));
  const headers: ParamRow[] = request.headers
    .filter((row) => row.key.trim())
    .map((row) => ({
      key: `h:${row.id}`,
      location: "header" as const,
      name: row.key,
      value: row.value,
      meta: metaFor(doc, `h:${row.id}`, row.value),
    }));
  const bodyFields = bodyFieldRows(request.body);
  const body: ParamRow[] = [...bodyFields, ...(request.body.type === "json" ? containerFieldRows(bodyFields) : [])].map(
    (field) => ({
      key: `b:${field.path}`,
      location: "body" as const,
      name: field.name,
      value: field.value,
      meta: { ...metaFor(doc, `b:${field.path}`, field.value), type: field.type },
    }),
  );

  return [
    { location: "query", label: "Query 参数", rows: query },
    { location: "header", label: "Header 参数", rows: headers },
    { location: "body", label: "Body 字段", rows: body },
  ];
}

// ------------------------------------------------------------- markdown ----

export type MarkdownBlock =
  | { kind: "h1" | "h2" | "h3" | "p"; text: string }
  | { kind: "li"; text: string }
  | { kind: "code"; text: string };

/** Minimal line-based Markdown parser (headings, lists, fenced code, paragraphs). */
export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let code: string[] | null = null;
  for (const rawLine of (markdown ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    if (line.trim().startsWith("```")) {
      if (code) {
        blocks.push({ kind: "code", text: code.join("\n") });
        code = null;
      } else {
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(rawLine);
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push({ kind: (level === 1 ? "h1" : level === 2 ? "h2" : "h3") as "h1" | "h2" | "h3", text: heading[2] });
      continue;
    }
    const list = /^[-*]\s+(.*)$/.exec(line.trim());
    if (list) {
      blocks.push({ kind: "li", text: list[1] });
      continue;
    }
    if (line.trim() === "") continue;
    blocks.push({ kind: "p", text: line.trim() });
  }
  if (code && code.length) blocks.push({ kind: "code", text: code.join("\n") });
  return blocks;
}

/** Split a paragraph into plain text / `code` / **bold** inline tokens. */
export function parseInline(text: string): { text: string; bold?: boolean; code?: boolean }[] {
  const tokens: { text: string; bold?: boolean; code?: boolean }[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) tokens.push({ text: text.slice(last, match.index) });
    const token = match[0];
    if (token.startsWith("**")) tokens.push({ text: token.slice(2, -2), bold: true });
    else tokens.push({ text: token.slice(1, -1), code: true });
    last = pattern.lastIndex;
  }
  if (last < text.length) tokens.push({ text: text.slice(last) });
  return tokens;
}

// ----------------------------------------------------------------- mock ----

const FAKE_BY_NAME: { pattern: RegExp; value: () => string }[] = [
  { pattern: /e-?mail/i, value: () => "user@example.com" },
  { pattern: /phone|mobile/i, value: () => "13800001234" },
  { pattern: /token|secret|api[-_]?key/i, value: () => "mock-token-3f9a" },
  { pattern: /password|passwd|pwd/i, value: () => "••••••••" },
  { pattern: /name|title|nick/i, value: () => "示例名称" },
  { pattern: /url|link|href/i, value: () => "https://example.com/mock" },
  { pattern: /id$|[_-]id/i, value: () => "1001" },
  { pattern: /time|date|at$/i, value: () => "2026-01-01 00:00:00" },
  { pattern: /count|total|size|age|num|page/i, value: () => "1" },
];

function fakeFor(path: string): string {
  for (const rule of FAKE_BY_NAME) {
    if (rule.pattern.test(path)) return rule.value();
  }
  return "mock";
}

function mockValue(field: { path: string; type: string; value: string }): unknown {
  const metaHint = field.value && field.value !== "" ? field.value : fakeFor(field.path);
  if (field.type === "number") {
    const numeric = Number(metaHint.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(numeric) && metaHint.match(/[0-9]/) ? numeric : 1;
  }
  if (field.type === "boolean") return metaHint === "true";
  if (field.type === "null") return null;
  return metaHint;
}

function buildFromFields(request: RequestDraft): unknown {
  const fields = bodyFieldRows(request.body).filter((field) => field.path && field.path !== "body");
  const root: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.path === "content" || field.path === "query" || field.path === "variables" || field.path === "file") {
      continue;
    }
    // form 行 path 是行 id，展示/生成用 name（真实字段名）；JSON 行 name === path。
    const path = field.name.replace(/\[\d+\]/g, "");
    const parts = path.split(".");
    let cursor: Record<string, unknown> = root;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (index === parts.length - 1) {
        cursor[part] = mockValue(field);
      } else {
        if (typeof cursor[part] !== "object" || cursor[part] === null) cursor[part] = {};
        cursor = cursor[part] as Record<string, unknown>;
      }
    }
  }
  for (const row of request.query) {
    if (!row.enabled || !row.key.trim()) continue;
    root[row.key] = mockValue({ path: row.key, type: "string", value: row.value });
  }
  return root;
}

/**
 * Mock preview: prefer a saved response example, otherwise synthesise a JSON
 * document from the interface definition (body fields + query params).
 */
export function generateMockBody(request: RequestDraft, doc: RequestDoc, exampleId?: string): string {
  const example: ResponseExample | undefined = exampleId
    ? doc.responses.find((item) => item.id === exampleId)
    : doc.responses[0];
  if (example?.body?.trim()) {
    return formatResponseExampleBody(example.body);
  }
  const generated = buildFromFields(request);
  return JSON.stringify(generated, null, 2);
}
