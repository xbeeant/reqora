import type {
  AssertionResult,
  AssertionSpec,
  RequestDraft,
  ResponseData,
} from "../types";

/** structuredClone is missing on older WKWebView builds; keep a JSON fallback. */
function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Script execution for the desktop client.
 *
 * Why a Blob Worker instead of eval/new Function:
 *  - CSP keeps `script-src 'self'` (only `worker-src blob:` is added), so the
 *    WebView never gains `unsafe-eval`.
 *  - The user's code is spliced into the Worker source as a normal function
 *    body, so it is parsed statically — no dynamic evaluation at all.
 *  - A Worker has no `window`, no DOM and no `__TAURI_INTERNALS__`, and runs on
 *    its own thread, so `while(true){}` can be killed with terminate() instead
 *    of freezing the whole window.
 *
 * Scripts are trusted project code written by the user (same trust model as a
 * shell alias), not a sandbox for untrusted third-party input.
 */

export interface ScriptRunOptions {
  code: string;
  phase: "pre" | "post";
  request: RequestDraft;
  variables: Record<string, string>;
  response?: ResponseData | null;
  /** Post scripts of an SSE stream can read the already-merged text here. */
  sse?: { mergedText: string; reasoningText: string; frames: number } | null;
  timeoutMs?: number;
}

export interface ScriptRunResult {
  request: RequestDraft;
  variables: Record<string, string>;
  logs: string[];
  tests: { name: string; ok: boolean; message: string }[];
  mutations: string[];
  error: string | null;
  durationMs: number;
}

interface WorkerResult {
  request: RequestDraft;
  variables: Record<string, string>;
  logs: string[];
  tests: { name: string; ok: boolean; message: string }[];
  mutations: string[];
  error: string | null;
}

/**
 * Helper definitions live INSIDE the Worker. No `${}` anywhere below.
 * Exported so the CLI can execute the exact same helper source in a Node vm.
 */
export const WORKER_HELPERS_SOURCE = [
  '"use strict";',
  "let request = null, variables = {}, response = null;",
  "let __logs = [], __tests = [], __mutations = [], __pending = [];",
  "",
  "function __str(value) {",
  "  if (value === undefined) return 'undefined';",
  "  if (value === null) return 'null';",
  "  try { return typeof value === 'string' ? value : JSON.stringify(value); }",
  "  catch (e) { return String(value); }",
  "}",
  "// Disabled rows are never sent, so reads must not see them either.",
  "function __row(list, key, includeDisabled) {",
  "  return (list || []).find(function (r) {",
  "    return r && (includeDisabled || r.enabled !== false) && String(r.key).toLowerCase() === String(key).toLowerCase();",
  "  });",
  "}",
  "function __setRow(list, key, value) {",
  "  var found = __row(list, key);",
  "  if (found) { found.value = String(value); found.enabled = true; }",
  "  else list.push({ id: 'script-' + Math.random().toString(36).slice(2), key: String(key), value: String(value), enabled: true });",
  "}",
  "function __requireRequest() { if (!request) throw new Error('该阶段没有可用的请求对象'); }",
  "",
  "function getVar(name) { return variables[String(name)]; }",
  "function setVar(name, value) { variables[String(name)] = String(value); __mutations.push('var:' + name); return variables[String(name)]; }",
  "function unsetVar(name) { delete variables[String(name)]; __mutations.push('var:' + name); }",
  "function getHeader(name) { __requireRequest(); var r = __row(request.headers, name); return r ? r.value : null; }",
  "function setHeader(name, value) { __requireRequest(); request.headers = request.headers || []; __setRow(request.headers, name, value); __mutations.push('header:' + name); }",
  "function unsetHeader(name) { __requireRequest(); request.headers = (request.headers || []).filter(function (r) { return String(r.key).toLowerCase() !== String(name).toLowerCase(); }); __mutations.push('header:' + name); }",
  "function getQuery(name) { __requireRequest(); var r = __row(request.query, name); return r ? r.value : null; }",
  "function setQuery(name, value) { __requireRequest(); request.query = request.query || []; __setRow(request.query, name, value); __mutations.push('query:' + name); }",
  "function unsetQuery(name) { __requireRequest(); request.query = (request.query || []).filter(function (r) { return String(r.key).toLowerCase() !== String(name).toLowerCase(); }); __mutations.push('query:' + name); }",
  "function setUrl(url) { __requireRequest(); request.url = String(url); __mutations.push('url'); }",
  "function setBody(value) {",
  "  __requireRequest();",
  "  if (typeof value === 'string') {",
  "    var trimmed = value.trim();",
  "    request.body = /^[{[]/.test(trimmed) ? { type: 'json', content: value } : { type: 'raw', content: value, contentType: 'text/plain' };",
  "  } else { request.body = { type: 'json', content: JSON.stringify(value, null, 2) }; }",
  "  __mutations.push('body');",
  "}",
  "function log() { __logs.push(Array.prototype.map.call(arguments, __str).join(' ')); }",
  "function assert(condition, message) { if (!condition) throw new Error(message || '断言失败'); }",
  "function test(name, fn) {",
  "  var pending = (async function () {",
  "    try { await fn(); __tests.push({ name: String(name), ok: true, message: '' }); }",
  "    catch (e) { __tests.push({ name: String(name), ok: false, message: String((e && e.message) || e) }); }",
  "  })();",
  "  __pending.push(pending);",
  "  return pending;",
  "}",
  "function uuid() {",
  "  if (self.crypto && self.crypto.randomUUID) return self.crypto.randomUUID();",
  "  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {",
  "    var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8); return v.toString(16);",
  "  });",
  "}",
  "function now() { return Date.now(); }",
  "function timestamp() { return new Date().toISOString(); }",
  "function randomHex(length) {",
  "  var n = Math.max(1, Math.min(256, Number(length) || 16));",
  "  var bytes = new Uint8Array(n);",
  "  if (self.crypto && self.crypto.getRandomValues) self.crypto.getRandomValues(bytes);",
  "  else for (var i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);",
  "  return Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');",
  "}",
  "function base64(text) { return btoa(unescape(encodeURIComponent(String(text)))); }",
  "function base64url(text) { return base64(text).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''); }",
  "async function sha256(text) {",
  "  var data = new TextEncoder().encode(String(text));",
  "  var digest = await self.crypto.subtle.digest('SHA-256', data);",
  "  return Array.prototype.map.call(new Uint8Array(digest), function (b) { return b.toString(16).padStart(2, '0'); }).join('');",
  "}",
  "async function hmac(algorithm, key, text) {",
  "  var name = /^(sha-?1|sha-?256|sha-?384|sha-?512)$/i.test(String(algorithm))",
  "    ? 'SHA-' + String(algorithm).replace(/\\D/g, '') : 'SHA-256';",
  "  var cryptoKey = await self.crypto.subtle.importKey('raw', new TextEncoder().encode(String(key)), { name: 'HMAC', hash: name }, false, ['sign']);",
  "  var signature = await self.crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(String(text)));",
  "  return Array.prototype.map.call(new Uint8Array(signature), function (b) { return b.toString(16).padStart(2, '0'); }).join('');",
  "}",
  "function header(name) { return response && response.headers ? (response.headers[String(name).toLowerCase()] ?? null) : null; }",
  "function json(path) {",
  "  var value = response ? response.body : undefined;",
  "  if (typeof value === 'string') { try { value = JSON.parse(value); } catch (e) { /* keep text */ } }",
  "  if (!path || path === '$') return value;",
  "  var parts = String(path).replace(/^\\$\\.?/, '').replace(/\\[(\\d+)\\]/g, '.$1').split('.').filter(Boolean);",
  "  for (var i = 0; i < parts.length; i++) {",
  "    if (value === null || value === undefined) return undefined;",
  "    value = value[parts[i]];",
  "  }",
  "  return value;",
  "}",
  "",
].join("\n");

/**
 * Response view builder shared by the desktop Worker and the CLI vm runtime.
 * Exported as source (not a function) so both sides execute the exact same
 * code — there is no second implementation to drift.
 */
export const RESPONSE_VIEW_SOURCE = [
  "function __responseView(raw) {",
  "  if (!raw) return null;",
  "  var headers = {};",
  "  for (var i = 0; i < (raw.headers || []).length; i++) headers[String(raw.headers[i].name).toLowerCase()] = raw.headers[i].value;",
  "  var parsed = raw.body;",
  "  if (raw.bodyKind === 'json') { try { parsed = JSON.parse(raw.body); } catch (e) { parsed = raw.body; } }",
  "  return {",
  "    status: raw.status, statusText: raw.statusText, ok: raw.ok,",
  "    timeMs: raw.timeMs, size: raw.size, url: raw.url, resolvedUrl: raw.resolvedUrl,",
  "    headers: headers, body: parsed, text: raw.body, bodyKind: raw.bodyKind,",
  "    timings: raw.timings || null, rawRequest: raw.rawRequest || '', rawResponse: raw.rawResponse || '',",
  "  };",
  "}",
].join("\n");

/** Builds one self-contained Worker source with the user code as a real function body. */
function workerSource(code: string): string {
  const responseObject = [
    RESPONSE_VIEW_SOURCE,
    "",
    "async function __main() {",
    code,
    "}",
    "",
    "self.onmessage = async function (event) {",
    "  var payload = event.data || {};",
    "  request = payload.request;",
    "  variables = payload.variables || {};",
  "  response = __responseView(payload.response);",
  "  if (payload.sse && response) response.sse = payload.sse;",
  "  __logs = []; __tests = []; __mutations = []; __pending = [];",
    "  var error = null;",
    "  try { await __main(); await Promise.all(__pending); }",
    "  catch (e) { error = String((e && e.message) || e); }",
    "  self.postMessage({ request: request, variables: variables, logs: __logs, tests: __tests, mutations: __mutations, error: error });",
    "};",
  ].join("\n");
  return WORKER_HELPERS_SOURCE + "\n" + responseObject;
}

/** Runs one script phase. Never rejects: failures come back in `error`. */
export function runScript(options: ScriptRunOptions): Promise<ScriptRunResult> {
  const started = Date.now();
  const {
    code,
    request,
    variables,
    response = null,
    sse = null,
    timeoutMs = 2000,
  } = options;

  const empty = (error: string | null = null): ScriptRunResult => ({
    request: clone(request),
    variables: { ...variables },
    logs: [],
    tests: [],
    mutations: [],
    error,
    durationMs: Date.now() - started,
  });

  if (!code.trim()) return Promise.resolve(empty());

  return new Promise((resolve) => {
    let worker: Worker | null = null;
    let blobUrl = "";
    let settled = false;

    const finish = (result: ScriptRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker?.terminate();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ...empty(), error: `脚本执行超过 ${timeoutMs}ms，已强制终止` });
    }, timeoutMs);

    try {
      const blob = new Blob([workerSource(code)], { type: "text/javascript" });
      blobUrl = URL.createObjectURL(blob);
      worker = new Worker(blobUrl);

      worker.onmessage = (event: MessageEvent<WorkerResult>) => {
        const data = event.data;
        finish({
          request: data.request ?? clone(request),
          variables: data.variables ?? variables,
          logs: data.logs ?? [],
          tests: data.tests ?? [],
          mutations: data.mutations ?? [],
          error: data.error ?? null,
          durationMs: Date.now() - started,
        });
      };
      worker.onerror = (event: ErrorEvent) => {
        finish({ ...empty(), error: `脚本语法/运行错误：${event.message || "未知错误"}` });
      };
      worker.postMessage({
        request: clone(request),
        variables: { ...variables },
        response: response ? clone(response) : null,
        sse,
      });
    } catch (error) {
      finish({
        ...empty(),
        error: `无法启动脚本引擎：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}

// --------------------------------------------------------- assertions ----

export function selectPath(root: unknown, path: string): unknown {
  let value = root;
  if (!path || path === "$") return value;
  const parts = path
    .replace(/^\$\.?/, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  for (const part of parts) {
    if (value === null || value === undefined) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function compare(actual: unknown, op: AssertionSpec["op"], expected: string): boolean {
  const text = actual === undefined || actual === null ? "" : String(actual);
  const numeric = Number(actual);
  const target = Number(expected);
  switch (op) {
    case "eq":
      return text === expected || (Number.isFinite(numeric) && numeric === target);
    case "ne":
      return text !== expected && !(Number.isFinite(numeric) && numeric === target);
    case "gt":
      return Number.isFinite(numeric) && numeric > target;
    case "gte":
      return Number.isFinite(numeric) && numeric >= target;
    case "lt":
      return Number.isFinite(numeric) && numeric < target;
    case "lte":
      return Number.isFinite(numeric) && numeric <= target;
    case "contains":
      return text.includes(expected);
    case "matches":
      try {
        return new RegExp(expected).test(text);
      } catch {
        return false;
      }
    case "exists":
      return actual !== undefined && actual !== null;
    default:
      return false;
  }
}

/** Declarative checks are pure data — no code execution, no network. */
export function evaluateAssertions(
  list: AssertionSpec[] | undefined,
  response: ResponseData,
): AssertionResult[] {
  let parsedBody: unknown = response.body;
  if (response.bodyKind === "json") {
    try {
      parsedBody = JSON.parse(response.body);
    } catch {
      /* keep the raw text */
    }
  }
  const headers = Object.fromEntries(
    response.headers.map((item) => [item.name.toLowerCase(), item.value]),
  );

  return (list ?? [])
    .filter((rule) => rule.enabled)
    .map((rule) => {
      let actual: unknown;
      switch (rule.source) {
        case "status":
          actual = response.status;
          break;
        case "header":
          actual = headers[(rule.path || "").toLowerCase()];
          break;
        case "latency":
          actual = response.timeMs;
          break;
        case "text":
          actual = response.body;
          break;
        default:
          actual = selectPath(parsedBody, rule.path || "$");
      }
      const ok = compare(actual, rule.op, rule.value);
      return {
        name: rule.name || `${rule.source} ${rule.op} ${rule.value}`,
        ok,
        message: ok ? "" : `期望 ${rule.op} ${rule.value}，实际 ${String(actual)}`,
        origin: "assertion" as const,
        source: rule.source,
        path: rule.path || "$",
        op: rule.op,
        expected: rule.value,
        actual: actual === undefined ? "undefined" : String(actual),
      };
    });
}

export const SCRIPT_HELPERS: { signature: string; description: string }[] = [
  { signature: "getVar(name)", description: "读取环境变量" },
  { signature: "setVar(name, value)", description: "写变量，pre 中会影响 {{VAR}}" },
  { signature: "unsetVar(name)", description: "删除变量" },
  { signature: "getHeader(name)", description: "读取请求头" },
  { signature: "setHeader(name, value)", description: "注入 / 覆盖请求头" },
  { signature: "unsetHeader(name)", description: "删除请求头" },
  { signature: "getQuery(name)", description: "读取查询参数" },
  { signature: "setQuery(name, value)", description: "注入 / 覆盖查询参数" },
  { signature: "setUrl(url)", description: "改写请求 URL" },
  { signature: "setBody(value)", description: "改写请求体（对象自动转 JSON）" },
  { signature: "log(...values)", description: "写入 Script Logs" },
  { signature: "test(name, fn)", description: "命名测试，结果进 Tests 页" },
  { signature: "assert(cond, msg)", description: "断言，失败使 test 标红" },
  { signature: "response", description: "后置专用：status / body / headers / text" },
  { signature: "json(path)", description: "后置专用：$.data.items[0].id" },
  { signature: "header(name)", description: "后置专用：读响应头" },
  { signature: "uuid()", description: "生成 UUID" },
  { signature: "now()", description: "毫秒时间戳" },
  { signature: "timestamp()", description: "ISO 时间" },
  { signature: "randomHex(n)", description: "随机十六进制串" },
  { signature: "base64(text)", description: "Base64 编码" },
  { signature: "base64url(text)", description: "URL 安全 Base64" },
  { signature: "await sha256(text)", description: "SHA-256（异步）" },
  { signature: "await hmac(alg, key, text)", description: "HMAC 签名（异步）" },
];
