import type { KeyValue } from "../types.ts";
import { uid } from "./id.ts";

/**
 * Bulk parameter editing — pure functions only, so the parser can be unit
 * tested with `node --test` without mounting React.
 *
 * Three input formats (matching the dialog tabs):
 *   kv   — one `key:value` / `key=value` / `key<TAB>value` pair per line
 *   json — a JSON document, flattened into dotted / indexed paths
 *   desc — `key:value:description`, or three tab-separated columns
 *
 * The result is always a plain `KeyValue[]` compatible with the request
 * draft (query / headers / form-urlencoded / form-data rows all share it).
 */

export type BulkFormat = "kv" | "json" | "desc";
export type CaseStyle = "as-is" | "camel" | "pascal" | "snake";
export type BulkMode = "append" | "replace";

export interface BulkRow {
  key: string;
  value: string;
  description: string;
}

export interface BulkParseResult {
  rows: BulkRow[];
  /** Human-readable parse error; null when the text is valid. */
  error: string | null;
  /** True when the input exceeded MAX_BULK_ROWS and was cut off. */
  truncated: boolean;
}

export const MAX_BULK_ROWS = 500;
const MAX_CELL_LENGTH = 4096;
const MAX_JSON_DEPTH = 6;

const cap = (text: string): string =>
  text.length > MAX_CELL_LENGTH ? text.slice(0, MAX_CELL_LENGTH) : text;

function row(key: string, value: string, description = ""): BulkRow {
  return { key: cap(key.trim()), value: cap(value.trim()), description: cap(description.trim()) };
}

/**
 * Split a line on `separator`, honouring double-quoted cells (a doubled quote
 * is an escaped quote). Mirrors `splitCsvLine` in scenario.ts but works for
 * `:` / `=` / tab as well.
 */
function splitQuoted(line: string, separator: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === separator) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** Trim a wrapping pair of quotes left over from a pasted JSON snippet. */
function unquote(cell: string): string {
  if (cell.length >= 2 && cell.startsWith('"') && cell.endsWith('"')) {
    return cell.slice(1, -1).replace(/""/g, '"');
  }
  return cell;
}

function nonEmptyLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("//"));
}

/** First `:` / `=` outside a quoted cell, so `"a:b": 1` splits on the colon after the quote. */
function firstSeparator(line: string): string | null {
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (char === ":" || char === "=")) return char;
  }
  return null;
}

function bounded(rows: BulkRow[]): { rows: BulkRow[]; truncated: boolean } {
  return rows.length > MAX_BULK_ROWS
    ? { rows: rows.slice(0, MAX_BULK_ROWS), truncated: true }
    : { rows, truncated: false };
}

function parseKeyValueText(text: string): BulkParseResult {
  const rows: BulkRow[] = [];
  for (const line of nonEmptyLines(text)) {
    const tab = line.includes("\t");
    const separator = tab ? "\t" : (firstSeparator(line) ?? ":");
    const cells = tab || firstSeparator(line) ? splitQuoted(line, separator) : [line];
    const key = unquote(cells[0] ?? "");
    if (!key.trim()) continue; // a bare "value" line carries no parameter name
    const value = cells.length > 1 ? cells.slice(1).join(separator) : "";
    rows.push(row(key, value));
  }
  const result = bounded(rows);
  return { ...result, error: null };
}

function flattenJson(value: unknown, path: string, depth: number, rows: BulkRow[]): void {
  if (rows.length >= MAX_BULK_ROWS) return;
  if (depth > MAX_JSON_DEPTH) {
    rows.push(row(path || "value", compact(value)));
    return;
  }
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        rows.push(row(path || "value", "[]"));
        return;
      }
      value.forEach((item, index) => {
        flattenJson(item, path ? `${path}[${index}]` : `[${index}]`, depth + 1, rows);
      });
    } else {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) {
        rows.push(row(path || "value", "{}"));
        return;
      }
      for (const [key, child] of entries) {
        flattenJson(child, path ? `${path}.${key}` : key, depth + 1, rows);
      }
    }
    return;
  }
  rows.push(row(path || "value", value === null || value === undefined ? "" : String(value)));
}

function compact(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseJsonText(text: string): BulkParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { rows: [], error: null, truncated: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "无效 JSON";
    return { rows: [], error: `JSON 解析失败：${message}`, truncated: false };
  }
  const rows: BulkRow[] = [];
  flattenJson(parsed, "", 0, rows);
  const result = bounded(rows);
  return { ...result, error: null };
}

/**
 * `key:value:description` — the LAST column is always the description, so a
 * value containing colons (URLs, timestamps) survives intact. Three
 * tab-separated columns work too and need no quoting.
 */
function parseWithDescription(text: string): BulkParseResult {
  const rows: BulkRow[] = [];
  for (const line of nonEmptyLines(text)) {
    const separator = line.includes("\t") ? "\t" : ":";
    const cells = splitQuoted(line, separator);
    const key = cells[0] ?? "";
    if (!key.trim()) continue;
    if (cells.length === 1) {
      rows.push(row(key, ""));
    } else if (cells.length === 2) {
      rows.push(row(key, cells[1]));
    } else {
      rows.push(row(key, cells.slice(1, -1).join(separator), cells[cells.length - 1]));
    }
  }
  const result = bounded(rows);
  return { ...result, error: null };
}

export function parseBulkText(text: string, format: BulkFormat): BulkParseResult {
  if (format === "json") return parseJsonText(text);
  if (format === "desc") return parseWithDescription(text);
  return parseKeyValueText(text);
}

// ------------------------------------------------------------- naming ----

function words(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

/**
 * Rename parameter keys. Non-ASCII keys (e.g. Chinese names) are left alone —
 * splitting them on `[^A-Za-z0-9]` would silently erase the name.
 */
export function applyCaseStyle(key: string, style: CaseStyle): string {
  if (style === "as-is" || !key.trim() || /[^\x00-\x7F]/.test(key)) return key;
  const parts = words(key);
  if (parts.length === 0) return key;
  const pascal = parts.map((part) => part[0].toUpperCase() + part.slice(1)).join("");
  switch (style) {
    case "camel":
      return pascal[0].toLowerCase() + pascal.slice(1);
    case "pascal":
      return pascal;
    case "snake":
      return parts.join("_");
    default:
      return key;
  }
}

// -------------------------------------------------------- serialization ----

/** Quote a cell when it contains one of the delimiters, a quote or a line break. */
function escapeCell(value: string, delimiters: string): string {
  const needsQuote =
    [...delimiters].some((char) => value.includes(char)) ||
    value.includes('"') ||
    /[\r\n]/.test(value);
  return needsQuote ? `"${value.replace(/"/g, '""')}"` : value;
}

export function serializeBulkRows(rows: BulkRow[], format: BulkFormat): string {
  if (format === "json") {
    const object: Record<string, string> = {};
    for (const item of rows) {
      if (item.key.trim()) object[item.key.trim()] = item.value;
    }
    return JSON.stringify(object, null, 2);
  }
  // In kv mode the parser splits on the FIRST delimiter, so colons inside a
  // value are safe and stay readable. In desc mode the last column is the
  // description, so a value containing ":" must be quoted.
  const valueDelimiters = format === "desc" ? ":" : "";
  return rows
    .filter((item) => item.key.trim())
    .map((item) => {
      const key = escapeCell(item.key.trim(), ":");
      const value = escapeCell(item.value, valueDelimiters);
      if (format === "desc" && item.description.trim()) {
        return `${key}: ${value}: ${escapeCell(item.description.trim(), ":")}`;
      }
      return `${key}: ${value}`;
    })
    .join("\n");
}

/** Seed the dialog with the parameters already in the table. */
export function itemsToBulkText(items: KeyValue[]): string {
  return serializeBulkRows(
    items
      .filter((item) => item.key.trim())
      .map((item) => ({ key: item.key, value: item.value, description: "" })),
    "kv",
  );
}

// -------------------------------------------------------------- applying ----

export interface BulkApplyOptions {
  existing: KeyValue[];
  rows: BulkRow[];
  caseStyle: CaseStyle;
  mode: BulkMode;
}

export interface BulkApplyResult {
  items: KeyValue[];
  /** row.id → description; only rows with a non-empty description appear. */
  descriptions: Record<string, string>;
}

/**
 * Turn parsed rows into request rows.
 *
 * - Existing rows with the same key keep their `id` (and `enabled` / `secret`
 *   overrides), so `doc.paramMeta` entries keyed by `q:<id>` / `h:<id>` /
 *   `b:<id>` stay attached to the parameter they describe.
 * - `replace` keeps only the pasted rows; `append` additionally keeps existing
 *   rows that were not touched.
 * - Trailing blank rows are dropped; the table itself renders its own
 *   empty add-row, so no explicit blank row is needed.
 */
export function applyBulkEdit(options: BulkApplyOptions): BulkApplyResult {
  const clean = options.existing.filter((item) => item.key.trim() !== "");
  const usedIds = new Set<string>();
  const built: KeyValue[] = [];
  const descriptions: Record<string, string> = {};

  for (const entry of options.rows.slice(0, MAX_BULK_ROWS)) {
    const sourceKey = entry.key.trim();
    if (!sourceKey) continue;
    const key = applyCaseStyle(sourceKey, options.caseStyle).trim();
    if (!key) continue;
    const description = entry.description.trim();
    const lowerKey = key.toLowerCase();
    const lowerSource = sourceKey.toLowerCase();

    // A repeated key in the pasted text updates the row built above instead of
    // producing two rows with the same name.
    const duplicate = built.find((item) => item.key.trim().toLowerCase() === lowerKey);
    if (duplicate) {
      duplicate.value = entry.value;
      if (description) descriptions[duplicate.id] = description;
      continue;
    }

    const match = clean.find(
      (item) =>
        !usedIds.has(item.id) &&
        (item.key.trim().toLowerCase() === lowerSource ||
          item.key.trim().toLowerCase() === lowerKey),
    );
    let item: KeyValue;
    if (match) {
      usedIds.add(match.id);
      item = { ...match, key, value: entry.value };
    } else {
      item = { id: uid(), key, value: entry.value, enabled: true };
    }
    built.push(item);
    if (description) descriptions[item.id] = description;
  }

  const items =
    options.mode === "replace"
      ? built
      : [...clean.filter((item) => !usedIds.has(item.id)), ...built];
  return { items, descriptions };
}
