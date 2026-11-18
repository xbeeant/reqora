import type { ResponseParam, ResponseParamLocation } from "../types";
import { uid } from "./id.ts";

/**
 * 响应参数定义（文档增量）的纯函数层。
 *
 * 请求参数是请求行的实时投影，响应参数则必须人工书写：一个状态码示例对应一套
 * 字段表，字段可以是响应体里的 JSON 路径，也可以是响应头。这里集中实现：
 *   - 从保存的示例 body 自动派生初始字段行（省去手敲字段名）
 *   - 增量合并（用户写的说明 / 类型不会被「重新生成」覆盖）
 *   - OpenAPI Schema ↔ 字段表 双向转换（导入 / 导出不丢文档）
 *   - 按字段定义做宽松响应校验所需的路径取值与类型匹配
 *
 * 只依赖 types / id，桌面端、CLI 测试、网页版文档站都能安全复用。
 */

/** 单个响应示例允许定义的字段上限，防止快照与文档站被撑爆。 */
export const MAX_RESPONSE_PARAMS = 200;

const MAX_TEXT = 2000;
const MAX_NAME = 300;
const MAX_TYPE = 120;
const MAX_EXAMPLE = 1000;
const MAX_EXAMPLE_CHARS = 300;
const MAX_DEPTH = 8;

/** 字段名命中凭据类关键词时不把示例值写进文档表，避免二次扩散。 */
const SENSITIVE_FIELD =
  /(token|secret|password|passwd|authorization|api[-_]?key|credential|cookie|session|private[-_]?key)/i;

function text(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function emptyResponseParam(location: ResponseParamLocation = "body"): ResponseParam {
  return {
    id: uid(),
    name: "",
    location,
    type: "string",
    required: false,
    example: "",
    description: "",
  };
}

/** 旧快照 / 不可信 payload 的有界归一化：缺字段补默认，多余字段丢弃。 */
export function normalizeResponseParams(raw: unknown): ResponseParam[] {
  if (!Array.isArray(raw)) return [];
  const out: ResponseParam[] = [];
  // 缺失 id 时用稳定序号补齐：归一化会在渲染路径反复调用，随机 id 会让
  // React 每次重建行、导致输入框失焦，也会让快照指纹不稳定。
  for (const [index, entry] of raw.slice(0, MAX_RESPONSE_PARAMS).entries()) {
    const item = asRecord(entry);
    if (!item) continue;
    out.push({
      id: typeof item.id === "string" && item.id
        ? item.id.slice(0, 128)
        : `rparam-${index + 1}`,
      name: text(item.name, MAX_NAME),
      location: item.location === "header" ? "header" : "body",
      type: text(item.type, MAX_TYPE) || "string",
      required: item.required === true,
      example: text(item.example, MAX_EXAMPLE),
      description: text(item.description),
    });
  }
  return out;
}

export function inferResponseType(value: unknown): string {
  if (value === null || value === undefined) return "any";
  if (Array.isArray(value)) {
    return value.length > 0 ? `array<${inferResponseType(value[0])}>` : "array";
  }
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "object";
  return "string";
}

function formatExample(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.slice(0, MAX_EXAMPLE_CHARS);
  try {
    return (JSON.stringify(value) ?? "").slice(0, MAX_EXAMPLE_CHARS);
  } catch {
    return "";
  }
}

function sensitiveExample(path: string): boolean {
  const leaf = path.split(".").pop() ?? path;
  return SENSITIVE_FIELD.test(leaf.replace(/\[\d+\]$/, ""));
}

function leafRow(path: string, type: string, example: string): ResponseParam {
  return {
    id: uid(),
    name: path,
    location: "body",
    type,
    required: false,
    example: sensitiveExample(path) ? "" : example.slice(0, MAX_EXAMPLE),
    description: "",
  };
}

function isContainer(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.length > 0 && isContainer(value[0]);
  return Object.keys(value as Record<string, unknown>).length > 0;
}

function flatten(value: unknown, path: string, depth: number, rows: ResponseParam[]): void {
  if (rows.length >= MAX_RESPONSE_PARAMS || depth > MAX_DEPTH) return;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      rows.push(leafRow(path, "array", "[]"));
      return;
    }
    if (isContainer(value[0])) {
      flatten(value[0], `${path}[0]`, depth + 1, rows);
    } else {
      rows.push(leafRow(path, inferResponseType(value), formatExample(value)));
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) {
      rows.push(leafRow(path, "object", "{}"));
      return;
    }
    for (const key of keys) {
      if (rows.length >= MAX_RESPONSE_PARAMS) return;
      const child = (value as Record<string, unknown>)[key];
      flatten(child, path ? `${path}.${key}` : key, depth + 1, rows);
    }
    return;
  }
  rows.push(leafRow(path || "(根)", inferResponseType(value), formatExample(value)));
}

/** 从示例 body 派生字段行；非 JSON 或解析失败返回空数组（不覆盖已有定义）。 */
export function deriveResponseParams(body: string, contentType = "application/json"): ResponseParam[] {
  const trimmed = (body ?? "").trim();
  if (trimmed === "") return [];
  if (!/json/i.test(contentType) && !trimmed.startsWith("{") && !trimmed.startsWith("[")) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const rows: ResponseParam[] = [];
  flatten(parsed, "", 0, rows);
  return rows;
}

/**
 * 重新生成时保留用户已写的行（按 location:name 匹配），只追加示例里新出现的
 * 字段；手工添加的字段 / 响应头即使不在示例里也保留。
 */
export function mergeResponseParams(
  existing: ResponseParam[],
  derived: ResponseParam[],
): ResponseParam[] {
  const keyOf = (row: ResponseParam) => `${row.location}:${row.name}`;
  const buckets = new Map<string, ResponseParam[]>();
  for (const row of existing) {
    const key = keyOf(row);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  const appended = new Set<ResponseParam>();
  const out: ResponseParam[] = [];
  for (const row of derived) {
    if (out.length >= MAX_RESPONSE_PARAMS) break;
    const old = buckets.get(keyOf(row))?.find((item) => !appended.has(item));
    if (old) {
      out.push(old);
      appended.add(old);
    } else {
      out.push(row);
    }
  }
  for (const row of existing) {
    if (out.length >= MAX_RESPONSE_PARAMS) break;
    if (!appended.has(row)) out.push(row);
  }
  return out;
}

/** 把 `data.list[0].id` 拆成 `["data","list","[]","id"]`。 */
export function responsePathTokens(path: string): string[] {
  const tokens: string[] = [];
  const pattern = /([^.\[\]]+)|\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(path)) !== null) {
    tokens.push(match[1] !== undefined ? match[1] : "[]");
    if (tokens.length >= MAX_DEPTH) break;
  }
  return tokens;
}

/** 按文档字段定义取值，用于响应自动校验。 */
export function resolveResponsePath(
  root: unknown,
  path: string,
): { found: boolean; value: unknown } {
  let current = root;
  for (const token of responsePathTokens(path)) {
    if (current === null || current === undefined) return { found: false, value: undefined };
    if (token === "[]") {
      if (!Array.isArray(current) || current.length === 0) {
        return { found: false, value: undefined };
      }
      current = current[0];
    } else {
      const record = asRecord(current);
      if (!record || !(token in record)) return { found: false, value: undefined };
      current = record[token];
    }
  }
  return { found: true, value: current };
}

const TYPE_ALIASES: Record<string, string> = {
  string: "string", str: "string", text: "string", char: "string",
  date: "string", datetime: "string", time: "string", email: "string",
  url: "string", uuid: "string", enum: "string", binary: "string", byte: "string",
  integer: "integer", int: "integer", int32: "integer", int64: "integer", long: "integer",
  number: "number", float: "number", double: "number", decimal: "number",
  boolean: "boolean", bool: "boolean",
  object: "object", map: "object", dict: "object",
  array: "array", list: "array",
  null: "null", any: "any", mixed: "any", unknown: "any", "": "any",
};

function canonicalType(type: string): string {
  const value = type.trim().toLowerCase();
  const arrayMatch = /^array<(.+)>$/.exec(value) ?? /^(.+)\[\]$/.exec(value);
  if (arrayMatch) return `array<${canonicalType(arrayMatch[1])}>`;
  return TYPE_ALIASES[value] ?? value;
}

/** 宽松类型匹配：null / any 一律放行，integer 与 number 互相兼容。 */
export function matchesResponseType(value: unknown, type: string): boolean {
  const expected = canonicalType(type);
  if (expected === "any" || expected === "" || value === null || value === undefined) return true;
  if (expected === "null") return value === null;
  if (Array.isArray(value)) {
    const inner = /^array<(.+)>$/.exec(expected);
    if (!inner && expected !== "array" && expected !== "list") return false;
    if (inner && value.length > 0 && canonicalType(inner[1]) !== "any") {
      return matchesResponseType(value[0], inner[1]);
    }
    return true;
  }
  const actual =
    typeof value === "number" ? "number" :
    typeof value === "boolean" ? "boolean" :
    typeof value === "object" ? "object" : "string";
  if (expected === actual) return true;
  if ((expected === "integer" || expected === "number") && actual === "number") return true;
  return false;
}

interface SchemaNode {
  type?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: string[];
  description?: string;
  example?: unknown;
  [key: string]: unknown;
}

function schemaForType(type: string): Record<string, unknown> {
  const value = type.trim().toLowerCase();
  const arrayMatch = /^array<(.+)>$/.exec(value) ?? /^(.+)\[\]$/.exec(value);
  if (arrayMatch) return { type: "array", items: schemaForType(arrayMatch[1]) };
  const canonical = canonicalType(value);
  if (canonical === "any" || canonical === "") return {};
  if (canonical === "array" || canonical === "list") {
    return { type: "array", items: { type: "string" } };
  }
  if (canonical === "null") return { nullable: true };
  return { type: canonical };
}

function coerceSchemaExample(value: string, type: string): unknown {
  const canonical = canonicalType(type);
  if (canonical === "object" || canonical === "array" || canonical === "any" || canonical.startsWith("array<")) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (canonical === "integer" || canonical === "number") {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (canonical === "boolean") return value.trim().toLowerCase() === "true";
  return value;
}

/** 字段表 → OpenAPI 3.0 response schema（嵌套 properties / array items / required）。 */
export function responseParamsToSchema(params: unknown): Record<string, unknown> | null {
  const rows = normalizeResponseParams(params).filter(
    (row) => row.location === "body" && row.name.trim() !== "",
  );
  if (rows.length === 0) return null;
  const root: SchemaNode = { type: "object", properties: {} };
  for (const row of rows) {
    const tokens = responsePathTokens(row.name.trim());
    if (tokens.length === 0) continue;
    let node = root;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === "[]") {
        node.type = "array";
        delete node.properties;
        node.items ??= { type: "object", properties: {} };
        node = node.items;
        continue;
      }
      node.type ??= "object";
      node.properties ??= {};
      const child: SchemaNode = node.properties[token] ?? {};
      node.properties[token] = child;
      if (index === tokens.length - 1) {
        // 末段即叶子：以字段定义为准重写类型，避免中间节点残留旧结构。
        for (const key of Object.keys(child)) delete child[key];
        Object.assign(child, schemaForType(row.type));
        const description = row.description.trim();
        if (description) child.description = description.slice(0, MAX_TEXT);
        const example = row.example.trim();
        if (example) child.example = coerceSchemaExample(example, row.type);
        if (row.required) {
          const list = node.required ?? [];
          if (!list.includes(token)) list.push(token);
          node.required = list;
        }
      } else {
        node = child;
      }
    }
  }
  return root as unknown as Record<string, unknown>;
}

/** 字段表中的响应头 → OpenAPI `headers`。 */
export function responseParamsToHeaders(params: unknown): Record<string, unknown> | null {
  const rows = normalizeResponseParams(params).filter(
    (row) => row.location === "header" && row.name.trim() !== "",
  );
  if (rows.length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const name = row.name.trim().slice(0, MAX_NAME);
    const entry: Record<string, unknown> = { schema: schemaForType(row.type) };
    if (row.description.trim()) entry.description = row.description.trim().slice(0, MAX_TEXT);
    if (row.example.trim() && !SENSITIVE_FIELD.test(name)) {
      entry.example = coerceSchemaExample(row.example.trim(), row.type);
    }
    if (row.required) entry.required = true;
    out[name] = entry;
  }
  return out;
}

function typeFromSchema(node: unknown): string {
  const record = asRecord(node);
  if (!record) return "string";
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (type === "array" || record.items !== undefined) {
    return `array<${typeFromSchema(record.items)}>`;
  }
  return type || "any";
}

function walkSchema(
  node: unknown,
  path: string,
  depth: number,
  required: Set<string>,
  rows: ResponseParam[],
): void {
  if (rows.length >= MAX_RESPONSE_PARAMS || depth > MAX_DEPTH) return;
  const record = asRecord(node);
  if (!record) return;
  const push = (name: string, type: string) => {
    rows.push({
      id: uid(),
      name,
      location: "body",
      type,
      required: required.has(name.split(".").pop() ?? name),
      example: record.example === undefined ? "" : formatExample(record.example),
      description: typeof record.description === "string" ? record.description.slice(0, MAX_TEXT) : "",
    });
  };
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const properties = asRecord(record.properties);
  if ((type === "object" || properties) && properties && Object.keys(properties).length > 0) {
    const ownRequired = new Set(
      (Array.isArray(record.required) ? record.required : [])
        .filter((item): item is string => typeof item === "string"),
    );
    for (const key of Object.keys(properties)) {
      if (rows.length >= MAX_RESPONSE_PARAMS) return;
      const child = asRecord(properties[key]);
      const childPath = path ? `${path}.${key}` : key;
      if (child && (asRecord(child.properties) || child.items !== undefined)) {
        // 嵌套对象自己带 required 列表，walkSchema 会重新读取；这里传空集合即可。
        walkSchema(child, childPath, depth + 1, new Set<string>(), rows);
      } else {
        rows.push({
          id: uid(),
          name: childPath,
          location: "body",
          type: typeFromSchema(child),
          required: ownRequired.has(key),
          example: child?.example === undefined ? "" : formatExample(child.example),
          description: typeof child?.description === "string" ? child.description.slice(0, MAX_TEXT) : "",
        });
      }
    }
    return;
  }
  if ((type === "array" || record.items !== undefined) && record.items !== undefined) {
    const items = asRecord(record.items);
    if (items && (asRecord(items.properties) || items.items !== undefined)) {
      walkSchema(items, `${path}[0]`, depth + 1, new Set(), rows);
    } else {
      push(path || "(根)", `array<${typeFromSchema(items)}>`);
    }
    return;
  }
  if (path || Object.keys(record).length > 0) push(path || "(根)", type || "any");
}

/** OpenAPI response schema + headers → 字段表（导入时补全响应参数文档）。 */
export function schemaToResponseParams(schema: unknown, headers?: unknown): ResponseParam[] {
  const rows: ResponseParam[] = [];
  const root = asRecord(schema);
  if (root) {
    const required = new Set(
      (Array.isArray(root.required) ? root.required : [])
        .filter((item): item is string => typeof item === "string"),
    );
    walkSchema(root, "", 0, required, rows);
  }
  const headerRecord = asRecord(headers);
  if (headerRecord) {
    for (const name of Object.keys(headerRecord).slice(0, MAX_RESPONSE_PARAMS)) {
      const entry = asRecord(headerRecord[name]);
      const inner = entry ? asRecord(entry.schema) : null;
      rows.push({
        id: uid(),
        name: name.slice(0, MAX_NAME),
        location: "header",
        type: typeFromSchema(inner),
        required: entry?.required === true,
        example:
          entry?.example === undefined
            ? inner?.example === undefined ? "" : formatExample(inner.example)
            : formatExample(entry.example),
        description: typeof entry?.description === "string" ? entry.description.slice(0, MAX_TEXT) : "",
      });
    }
  }
  return rows.slice(0, MAX_RESPONSE_PARAMS);
}

export interface ResponseParamTable {
  label: string;
  location: ResponseParamLocation;
  rows: ResponseParam[];
}

/** 按位置分组，供文档站 / 单文件 HTML / Markdown 渲染只读表格。 */
export function responseParamTables(params: unknown): ResponseParamTable[] {
  const rows = normalizeResponseParams(params).filter((row) => row.name.trim() !== "");
  const body = rows.filter((row) => row.location === "body");
  // 文档是对外产物：凭据类响应头只发布字段名，不发布示例值。
  const header = rows
    .filter((row) => row.location === "header")
    .map((row) =>
      row.example.trim() && SENSITIVE_FIELD.test(row.name.trim())
        ? { ...row, example: "<请自行填写>" }
        : row,
    );
  const tables: ResponseParamTable[] = [];
  if (body.length > 0) tables.push({ label: "响应参数（Body）", location: "body", rows: body });
  if (header.length > 0) tables.push({ label: "响应参数（Header）", location: "header", rows: header });
  return tables;
}
