import type { KeyValue } from "../types";
import { dynamicValue } from "./dynamic.ts";

const PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

function has(map: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}

export function variablesFrom(items: KeyValue[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const item of items) {
    const key = item.key.trim();
    if (item.enabled && key) map[key] = item.value;
  }
  return map;
}

export function missingVariables(
  text: string,
  variables: Record<string, string>,
): string[] {
  const missing = new Set<string>();
  for (const match of text.matchAll(PATTERN)) {
    const key = match[1].trim();
    // {{$uuid}}-style built-ins are always resolvable; unknown $tokens are
    // kept verbatim but never reported as missing (mirrors the Rust side).
    if (!key || key.startsWith("$") || has(variables, key)) continue;
    missing.add(key);
  }
  return [...missing];
}

/**
 * Frontend preview only — the desktop app's authoritative substitution
 * happens in Rust (`service::template` + `service::dynamic`). The CLI uses
 * this exact function as its authoritative path, so dynamic variables must
 * be resolved here too. User-defined variables win over built-ins.
 */
export function substitute(text: string, variables: Record<string, string>): string {
  return text.replace(PATTERN, (original, rawKey: string) => {
    const key = rawKey.trim();
    if (!key) return original;
    if (has(variables, key)) return variables[key];
    if (key.startsWith("$")) return dynamicValue(key) ?? original;
    return original;
  });
}

// ------------------------------------------------------- path variables ----

/**
 * A path variable is `:name` (Postman / Express style) or `{name}` (OpenAPI
 * style) inside the URL **path**. Only the path is scanned, so `https://`,
 * `:8080` ports, IPv6 `[::1]`, basic-auth `user:pass` and `{{template}}`
 * placeholders can never be mistaken for one.
 *
 * The name charset intentionally excludes `.` so that `/users/:id.json`
 * yields `id` with a literal `.json` suffix rather than swallowing it.
 */
const PATH_VAR_NAME = "[A-Za-z_$][A-Za-z0-9_$-]*";
const PATH_VAR_PATTERN = new RegExp(
  `:(${PATH_VAR_NAME})|\\{(${PATH_VAR_NAME})\\}`,
  "g",
);
const TEMPLATE_MASK = /\{\{\s*[^{}]+?\s*\}\}/g;

interface PathSpan {
  start: number;
  end: number;
}

/** The `[start, end)` range of the URL that holds the path (no query/hash). */
function pathSpan(url: string): PathSpan {
  let end = url.length;
  for (const marker of ["?", "#"]) {
    const index = url.indexOf(marker);
    if (index >= 0 && index < end) end = index;
  }
  let start = 0;
  const scheme = url.indexOf("://");
  if (scheme >= 0) {
    const authorityStart = scheme + 3;
    const slash = url.indexOf("/", authorityStart);
    start = slash >= 0 && slash < end ? slash : end;
  }
  return { start, end };
}

interface PathMatch {
  start: number;
  end: number;
  key: string;
  original: string;
}

function findPathVariables(url: string): PathMatch[] {
  const { start, end } = pathSpan(url);
  if (start >= end) return [];
  // Mask {{...}} with an equal-length run of NULs so indices stay aligned
  // while single-brace `{id}` placeholders remain visible to the scanner.
  const masked = url.replace(TEMPLATE_MASK, (match) => "\u0000".repeat(match.length));
  const path = masked.slice(start, end);
  const out: PathMatch[] = [];
  const scanner = new RegExp(PATH_VAR_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(path)) !== null) {
    const key = match[1] ?? match[2];
    const from = start + match.index;
    const to = from + match[0].length;
    out.push({ start: from, end: to, key, original: url.slice(from, to) });
  }
  return out;
}

/** Ordered, de-duplicated path variable names found in `url`. */
export function pathVariableKeys(url: string): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const item of findPathVariables(url)) {
    if (!seen.has(item.key)) {
      seen.add(item.key);
      keys.push(item.key);
    }
  }
  return keys;
}

/**
 * Replace `:name` / `{name}` with the supplied values. Empty / undefined
 * values keep the placeholder visible so an unfilled path parameter is
 * obvious in the URL preview and in the request that is finally sent.
 *
 * Values are inserted verbatim (no URL-encoding) and may themselves contain
 * `{{variables}}` — those are resolved later by Rust (or by the CLI's
 * `substitute`), so pre-scripts and dynamic tokens keep working.
 */
export function applyPathVariables(
  url: string,
  variables: Record<string, string>,
): string {
  const matches = findPathVariables(url);
  if (matches.length === 0) return url;
  let out = "";
  let cursor = 0;
  for (const item of matches) {
    out += url.slice(cursor, item.start);
    const value = variables[item.key];
    out += value === undefined || value === "" ? item.original : value;
    cursor = item.end;
  }
  out += url.slice(cursor);
  return out;
}

/** Preview helper: apply path variables first, then resolve `{{...}}`. */
export function resolveRequestUrl(
  url: string,
  pathVariables: KeyValue[],
  variables: Record<string, string>,
): string {
  return substitute(applyPathVariables(url, variablesFrom(pathVariables)), variables);
}
