// Reqora request executor — the out-of-app twin of the desktop pipeline.
//
// The desktop app sends every request from Rust (`reqwest`) so it can honour
// proxies, self-signed certs and redirect policy. Out of process (CLI + MCP
// server) we now send through the SAME Rust engine via the `reqora-send`
// NDJSON sidecar (src-tauri/crates/reqora-core). Only the JS-only concerns stay
// here: environment lookup, pre/post scripts and declarative assertions, all
// using the production `src/lib/*.ts` modules so automation cannot drift.
//
// When the sidecar binary is not shipped (plain npm install, single-file MCP
// bundle), the legacy Node fetch path runs in EXPLICIT DIAGNOSTIC MODE: it is
// not feature-equivalent to the Rust engine, so every run reports the
// capability differences and reqora.run.v1 must declare engine.transport as
// node-fetch instead of claiming parity with the desktop.

import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import process from "node:process";
import { applyAuthHeaders, applyAuthQuery, signAwsSigV4, tokenNeedsRefresh } from "../src/lib/authProviders.ts";
import { evaluateAssertions } from "../src/lib/scripts.ts";
import { applyPathVariables, missingVariables, substitute, variablesFrom } from "../src/lib/template.ts";
import { resolveRequestAuth } from "../src/lib/auth.ts";
import { toWireSpec } from "../src/lib/wireSpec.ts";
import { runCliScript } from "./cliScriptRuntime.mjs";
import { getEngine } from "./engineClient.mjs";

/**
 * P0: machine-readable capability gap of the Node fetch fallback.
 * Kept here (next to both execution paths) so CLI, MCP, evidence and docs
 * all consume one list instead of drifting into different claims.
 */
export const NODE_FALLBACK_DIFFERENCES = Object.freeze([
  {
    capability: "proxy",
    desktop: "reqora-core 按桌面端代理设置发请求",
    nodeFetch: "不复用桌面代理设置，只遵循 Node / 系统环境",
  },
  {
    capability: "tls",
    desktop: "支持 verifyTls 与自签证书信任",
    nodeFetch: "不复用桌面自签证书信任；mTLS 路径用 node:https 且不自动跟随重定向",
  },
  {
    capability: "cookies",
    desktop: "复用同一 Cookie Jar",
    nodeFetch: "不复用桌面 Cookie Jar，跨请求 Cookie 行为可能不同",
  },
  {
    capability: "mtls",
    desktop: "引擎内建客户端证书通道",
    nodeFetch: "需 REQORA_TLS_CERT / REQORA_TLS_KEY / REQORA_TLS_CA，且该路径不自动重定向",
  },
  {
    capability: "sigv4",
    desktop: "service/auth.rs 内建 presign",
    nodeFetch: "走 JS 侧 applyAuthQueryAsync presign，实现不同",
  },
  {
    capability: "bodyTypes",
    desktop: "ENGINE_BODIES 全集",
    nodeFetch: "仅 SUPPORTED_BODIES 子集",
  },
  {
    capability: "dbSteps",
    desktop: "由 dbTransport 注入数据库驱动",
    nodeFetch: "无驱动，数据库步骤明确失败并在报告标注（不静默通过）",
  },
  {
    capability: "wire",
    desktop: "分段计时与原始报文重建与桌面一致",
    nodeFetch: "计时与原始报文由 fetch 路径近似重建，不可当作同一条执行链的证据",
  },
]);

/** Structured diagnostic payload for the fallback path. */
export function nodeFallbackDiagnostics() {
  return {
    mode: "diagnostic",
    transport: "node-fetch",
    engine: "none",
    summary:
      "Node fetch 降级（显式诊断模式）：以下能力与 Rust 引擎 / 桌面端不一致；reqora.run.v1 的 engine.transport 必须如实标为 node-fetch。",
    differences: NODE_FALLBACK_DIFFERENCES.map((item) => ({ ...item })),
  };
}

/** Add the capability gap to a run's note array, once. */
export function pushNodeFallbackDiagnostics(note) {
  if (!Array.isArray(note)) return note;
  if (note.some((line) => String(line).includes("显式诊断模式"))) return note;
  const diagnostic = nodeFallbackDiagnostics();
  note.push(
    `${diagnostic.summary} ${diagnostic.differences
      .map((item) => `[${item.capability}] ${item.nodeFetch}`)
      .join("；")}`,
  );
  return note;
}

/**
 * Query-side auth injection, including async SigV4 presigning.
 *
 * `applyAuthQuery` is synchronous and can only append apiKey-in-query params,
 * while `signAwsSigV4` is async. Without this wrapper an `awsSigV4` request
 * with `signQuery: true` would leave the Node fetch fallback completely
 * unsigned: no X-Amz-* params AND no Authorization header. The Rust engine
 * path has its own presigning (`service/auth.rs`), so this only covers the
 * JS-only fallback.
 *
 * The HMAC is computed from the untouched URL (before X-Amz-* is appended)
 * and from the finalised method / headers / body; existing X-Amz-* params are
 * replaced rather than duplicated.
 */
export async function applyAuthQueryAsync(auth, urlString, { method, body, headers } = {}) {
  if (auth?.type !== "awsSigV4" || !auth.signQuery) {
    return applyAuthQuery(auth, urlString);
  }
  const signed = await signAwsSigV4({
    ...auth,
    method: method ?? "GET",
    url: urlString,
    headers: headers ?? {},
    body: typeof body === "string" ? body : "",
  });
  const target = new URL(urlString);
  for (const [key, value] of Object.entries(signed?.query ?? {})) {
    target.searchParams.delete(key);
    target.searchParams.append(key, String(value));
  }
  return target.toString();
}

const SUPPORTED_BODIES = new Set(["none", "json", "raw", "formUrlEncoded", "graphql"]);
// reqwest-side BodySpec variants (models.rs, serde tag = "type").
const ENGINE_BODIES = new Set([
  "none", "json", "raw", "formUrlEncoded", "formData", "binary", "graphql",
]);

/** Accept `{ "X-Token": "abc" }` or `[{ key, value, enabled }]`; always rows. */
export function toRows(input, prefix = "row") {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input
      .filter((row) => row && typeof row === "object")
      .map((row, index) => ({
        id: row.id ?? `${prefix}-${index}`,
        key: String(row.key ?? ""),
        value: String(row.value ?? ""),
        enabled: row.enabled !== false,
        ...(row.description ? { description: String(row.description) } : {}),
      }));
  }
  if (typeof input === "object") {
    return Object.entries(input).map(([key, value], index) => ({
      id: `${prefix}-${index}`,
      key,
      value: String(value ?? ""),
      enabled: true,
    }));
  }
  return [];
}

/**
 * Normalize declarative assertions to the app's `AssertionSpec` shape.
 * AI clients naturally write `{source, path, op, expected}`; the app stores
 * `{id, enabled, name, source, path, op, value}`, so accept both.
 */
export function toAssertions(input) {
  if (!Array.isArray(input)) return [];
  return input.map((item, index) => ({
    id: item.id ?? `assert-${index}`,
    enabled: item.enabled !== false,
    name: item.name ?? "",
    source: item.source ?? "status",
    path: item.path ?? "",
    op: item.op ?? "eq",
    value: String(item.value ?? item.expected ?? ""),
  }));
}

/** MCP / CLI variable overrides (`{"baseUrl":"https://…"}` or `[{key,value}]`). */
export function toVariableTable(input) {
  if (!input) return {};
  if (Array.isArray(input)) return variablesFrom(toRows(input, "var"));
  if (typeof input === "object") {
    const out = {};
    for (const [key, value] of Object.entries(input)) out[key] = String(value ?? "");
    return out;
  }
  return {};
}

/**
 * Build the request body for a body spec, without running the whole pipeline.
 * Extracted verbatim from `send()` so CLI/MCP callers can prepare a body for
 * reuse (previews, codegen, dry-runs). `substituteFn` is injectable for tests;
 * it defaults to the production `substitute` imported above.
 *
 * Only the body + Content-Type are produced: the caller is responsible for
 * applying `contentType` to its headers (keeping any explicitly set value) and
 * for appending `notes` to its run note list — exactly like the inline code
 * used to.
 *
 * @param {{ type?: string, [key: string]: any }} spec
 * @param {Record<string, string>} variables
 * @param {(text: string, vars: object) => string} [substituteFn]
 * @returns {{ body: string | undefined, contentType: string | undefined, notes: string[] }}
 */
export function bodyFromSpec(spec, variables, substituteFn = substitute) {
  const notes = [];
  let body;
  let contentType;
  switch (spec?.type) {
    case "json":
      contentType = "application/json";
      body = substituteFn(spec.content, variables);
      break;
    case "raw":
      contentType = substituteFn(spec.contentType, variables) || "text/plain";
      body = substituteFn(spec.content, variables);
      break;
    case "formUrlEncoded": {
      contentType = "application/x-www-form-urlencoded";
      const params = new URLSearchParams();
      for (const row of spec.items ?? []) {
        if (row.enabled && row.key.trim()) {
          params.append(substituteFn(row.key, variables), substituteFn(row.value, variables));
        }
      }
      body = params.toString();
      break;
    }
    case "graphql": {
      contentType = "application/json";
      let variablesPart = {};
      try {
        variablesPart = JSON.parse(substituteFn(spec.variables ?? "", variables) || "{}");
      } catch {
        notes.push("GraphQL variables 不是合法 JSON，按空对象发送");
      }
      body = JSON.stringify({ query: substituteFn(spec.query ?? "", variables), variables: variablesPart });
      break;
    }
    default:
      break;
  }
  return { body, contentType, notes };
}

/**
 * Perform one HTTP round-trip, returning either a response or the thrown error.
 * A thin seam over global `fetch` (injectable via `fetchImpl`) so callers can
 * swap in a proxy/mock without duplicating the try/catch.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ response: Response | null, error: unknown | null }>}
 */
export async function transport(url, init, fetchImpl = fetch) {
  try {
    return { response: await fetchImpl(url, init), error: null };
  } catch (error) {
    return { response: null, error };
  }
}

/** 令牌 / 密钥 / PEM 里也可能引用 {{变量}}，注入 auth 前统一做变量替换。 */
function substituteAuth(auth, variables) {
  if (!auth || typeof auth !== "object") return auth;
  const out = {};
  for (const [key, value] of Object.entries(auth)) {
    if (typeof value === "string") out[key] = substitute(value, variables);
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = substituteAuth(value, variables);
    } else out[key] = value;
  }
  return out;
}

/** 读取 REQORA_TLS_* 环境变量指向的 PEM 文件；缺失或读失败返回 undefined。 */
function readTlsFile(envName) {
  const filePath = process.env[envName];
  if (!filePath) return undefined;
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * 汇总 mTLS 客户端证书选项：优先用 auth spec 内联的 certPem/keyPem/caPem，
 * 否则回退到 REQORA_TLS_CERT / REQORA_TLS_KEY / REQORA_TLS_CA 指向的 PEM 文件。
 * 缺少 cert 或 key 时返回 null，由调用方给出明确中文错误（禁止静默忽略）。
 */
function resolveMtlsOptions(auth) {
  const cert = auth.certPem || readTlsFile("REQORA_TLS_CERT");
  const key = auth.keyPem || readTlsFile("REQORA_TLS_KEY");
  const ca = auth.caPem || readTlsFile("REQORA_TLS_CA");
  if (!cert || !key) return null;
  const options = { cert, key };
  if (ca) options.ca = ca;
  if (auth.passphrase) options.passphrase = auth.passphrase;
  if (auth.minTlsVersion) options.minVersion = auth.minTlsVersion;
  return options;
}

/**
 * Node fetch 没有客户端证书通道，改用 node:https / node:http 的 request() 发
 * 等价请求并带上 cert/key/ca/passphrase/minVersion。返回值适配 transport()
 * 的 { response, error } 形状；response 为鸭子类型，具备 send() 后续使用的
 * .text() / .headers.get() / .headers.entries() / .status 等成员。
 * 注：Node 的 http.request 不自动跟随重定向，mTLS 场景一般也不跨主机跳转。
 */
function mtlsTransport(urlString, init, tlsOptions) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(urlString);
    } catch (error) {
      resolve({ response: null, error });
      return;
    }
    const isTls = target.protocol === "https:";
    const lib = isTls ? httpsRequest : httpRequest;
    const requestOptions = {
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      ...(isTls ? tlsOptions : {}),
    };
    let req;
    try {
      req = lib(target, requestOptions, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const entries = [];
          for (const [name, value] of Object.entries(res.headers ?? {})) {
            if (Array.isArray(value)) for (const item of value) entries.push([name, item]);
            else if (value != null) entries.push([name, String(value)]);
          }
          const status = res.statusCode ?? 0;
          resolve({
            response: {
              status,
              statusText: res.statusMessage ?? "",
              ok: status >= 200 && status < 300,
              headers: {
                get: (name) => {
                  const value = res.headers?.[String(name).toLowerCase()];
                  return Array.isArray(value) ? value.join(", ") : value == null ? null : String(value);
                },
                entries: () => entries[Symbol.iterator](),
              },
              text: async () => raw.toString("utf8"),
            },
            error: null,
          });
        });
      });
    } catch (error) {
      resolve({ response: null, error });
      return;
    }
    req.on("error", (error) => resolve({ response: null, error }));
    if (init.signal) {
      if (init.signal.aborted) req.destroy(init.signal.reason);
      else init.signal.addEventListener("abort", () => req.destroy(init.signal.reason), { once: true });
    }
    if (init.body !== undefined && init.body !== null) req.write(init.body);
    req.end();
  });
}

/**
 * Project the Rust `ResponsePayload` onto the compact shape scripts/assertions
 * consume. That shape is intentionally identical to the legacy fetch path, so
 * switching engines never changes what a post-script or a JUnit report sees.
 * Engine-only metadata (raw wire with auth headers, timings, spool refs) is
 * dropped here on purpose — it must not leak into MCP / CI output.
 */
export function normalizeEngineResponse(payload) {
  return {
    requestId: payload?.requestId ?? "cli",
    status: payload?.status ?? 0,
    statusText: payload?.statusText ?? "",
    ok: Boolean(payload?.ok),
    timeMs: Number(payload?.timeMs) || 0,
    size: Number(payload?.size) || 0,
    url: payload?.url ?? "",
    resolvedUrl: payload?.resolvedUrl ?? payload?.url ?? "",
    missingVariables: Array.isArray(payload?.missingVariables) ? payload.missingVariables : [],
    headers: Array.isArray(payload?.headers) ? payload.headers : [],
    body: typeof payload?.body === "string" ? payload.body : "",
    bodyKind: payload?.bodyKind ?? "text",
    truncated: Boolean(payload?.truncated),
  };
}

/**
 * Resolve a saved request reference (id or name) from a snapshot.
 *
 * Priority: exact id → exact name (unique) → unique case-insensitive name
 * substring. Ambiguous or missing references return `null`. Intended as a
 * shared primitive for CLI/MCP `ref` arguments in follow-up work.
 *
 * @param {{ collections?: Array<{ id: string, items: any[] }> }} snapshot
 * @param {string} ref
 * @returns {{ request: any, collection: any } | null}
 */
export function resolveRef(snapshot, ref) {
  const needle = String(ref ?? "").trim();
  if (!needle) return null;
  const entries = [];
  for (const collection of snapshot?.collections ?? []) {
    for (const request of collection?.items ?? []) {
      entries.push({ request, collection });
    }
  }
  const byId = entries.find((entry) => entry.request?.id === needle);
  if (byId) return byId;
  const byName = entries.filter((entry) => entry.request?.name === needle);
  if (byName.length === 1) return byName[0];
  const lower = needle.toLowerCase();
  const partial = entries.filter((entry) =>
    String(entry.request?.name ?? "").toLowerCase().includes(lower),
  );
  if (partial.length === 1) return partial[0];
  return null;
}

/**
 * Wrap a snapshot into a reusable executor.
 * `send()` mirrors the desktop pipeline: auth inheritance → global+request pre
 * script → variable substitution → fetch → post script → assertions.
 */
export function createRequester(snapshot, options = {}) {
  const collections = snapshot.collections ?? [];
  const cases = snapshot.cases ?? [];
  const settings = snapshot.settings ?? {};
  // `options.engine` accepts null (force Node fetch) or an EngineClient.
  // Default: share one sidecar per process when the binary is available.
  const engine = options.engine === undefined ? getEngine() : options.engine;
  const scriptTimeoutMs = Number(settings.scriptTimeoutMs) || 2000;
  const timeoutMs = Math.max(1, Number(settings.timeoutSecs) || 30) * 1000;
  const redirect = settings.followRedirects === false ? "manual" : "follow";
  const globalPreScript = settings.globalPreScript ?? "";
  const globalPostScript = settings.globalPostScript ?? "";

  /** Environment lookup by id or name; `undefined` = no environment. */
  function pickEnvironment(nameOrId) {
    if (!nameOrId) return null;
    const environments = snapshot.environments ?? [];
    return (
      environments.find((item) => item.id === nameOrId || item.name === nameOrId) ?? null
    );
  }

  /** Base variables: environment rows + environment-wide headers are separate. */
  function baseVariables(nameOrId) {
    // No explicit environment → the app's active one, exactly like the UI.
    const environment =
      pickEnvironment(nameOrId) ??
      (nameOrId ? null : pickEnvironment(snapshot.activeEnvironmentId));
    return {
      environment,
      variables: variablesFrom(environment?.variables ?? []),
    };
  }

  function buildFetch(request, variables, ownerRequestId) {
    // Cases and scenario steps carry request copies with fresh ids: map them
    // back to the owning interface so `inherit` auth resolves like the app.
    let resolved = resolveRequestAuth(request, collections, ownerRequestId, cases);
    const note = [];
    return (async () => {
      const preCode = [globalPreScript, resolved.preScript]
        .filter((item) => typeof item === "string" && item.trim())
        .join("\n\n");
      const pre = await runCliScript({
        code: preCode,
        request: resolved,
        variables,
        response: null,
        timeoutMs: scriptTimeoutMs,
      });
      resolved = pre.request ?? resolved;
      variables = pre.variables ?? variables;
      if (pre.error) note.push(`前置脚本失败：${pre.error}`);
      const supportedBodies = engine?.available ? ENGINE_BODIES : SUPPORTED_BODIES;
      if (!supportedBodies.has(resolved.body?.type ?? "none")) {
        note.push(`请求体类型 ${resolved.body?.type} 暂不支持，按 none 发送`);
      }
      return { request: resolved, variables, pre, note };
    })();
  }

  /**
   * Post-script + result envelope, shared by the Rust engine and the fetch
   * fallback so assertions, MCP output and JUnit/JSON reports see one shape.
   */
  async function finish(request, variables, pre, note, data, timeMs) {
    const postCode = [request.postScript, globalPostScript]
      .filter((item) => typeof item === "string" && item.trim())
      .join("\n\n");
    const post = await runCliScript({
      code: postCode,
      request,
      variables,
      response: data,
      timeoutMs: scriptTimeoutMs,
    });
    if (post.error) note.push(`后置脚本失败：${post.error}`);

    return {
      request,
      response: data,
      timeMs,
      error: null,
      preError: null,
      note,
      scripts: { pre, post },
      activeVariables: post.variables ?? variables,
    };
  }

  /**
   * Preferred path: hand the shared RequestSpec to reqora-core through the
   * sidecar. Returns a complete run result, or null when the caller should use
   * the legacy Node fetch path (binary missing / infrastructure failure).
   */
  async function enginePerform(request, variables, pre, note, startedAt) {
    if (!engine?.available) return null;
    let payload;
    try {
      const spec = toWireSpec(request, { variables, settings });
      payload = await engine.send(spec, {
        timeoutMs: Math.max(timeoutMs, 1000),
        requestId: request?.id,
      });
    } catch (error) {
      // A structured engine error is a REAL request failure (invalid URL,
      // timeout, TLS, proxy...). Do not retry on Node fetch: the desktop would
      // have failed too, and CI must agree with it.
      if (error?.code) {
        return {
          request,
          response: null,
          timeMs: Date.now() - startedAt,
          error: `请求失败：${error.message}`,
          preError: null,
          note,
          scripts: { pre, post: null },
        };
      }
      note.push(`请求引擎不可用，回退 Node fetch：${error?.message ?? error}`);
      return null;
    }
    const data = normalizeEngineResponse(payload);
    if (data.missingVariables.length) {
      note.push(`未定义变量：${data.missingVariables.map((key) => `{{${key}}}`).join("、")}`);
    }
    return finish(request, variables, pre, note, data, data.timeMs || Date.now() - startedAt);
  }

  async function send(request, variables, ownerRequestId) {
    const startedAt = Date.now();
    const prepared = await buildFetch(request, variables, ownerRequestId);
    request = prepared.request;
    variables = prepared.variables;
    const note = prepared.note;
    const pre = prepared.pre;

    if (pre.error) {
      return {
        request,
        response: null,
        timeMs: Date.now() - startedAt,
        error: `前置脚本阻断发送：${pre.error}`,
        preError: pre.error,
        note,
        scripts: { pre, post: null },
      };
    }

    const viaEngine = await enginePerform(request, variables, pre, note, startedAt);
    if (viaEngine) return viaEngine;
    // No sidecar (or infra failure): enter explicit diagnostic mode instead
    // of silently claiming parity with the desktop execution chain.
    pushNodeFallbackDiagnostics(note);

    const pathValues = variablesFrom(request.pathVariables ?? []);
    const rawUrl = substitute(applyPathVariables(request.url, pathValues), variables);
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      const missing = missingVariables(rawUrl, variables);
      return {
        request,
        response: null,
        timeMs: Date.now() - startedAt,
        error: missing.length
          ? `URL 无效：${rawUrl}（缺少变量 ${missing.map((key) => `{{${key}}}`).join("、")}，请指定 environment 或补 variables）`
          : `URL 无效：${rawUrl}`,
        preError: null,
        note,
        scripts: { pre, post: null },
      };
    }
    for (const row of request.query ?? []) {
      if (row.enabled && row.key.trim()) {
        url.searchParams.append(substitute(row.key, variables), substitute(row.value, variables));
      }
    }

    const headers = {};
    for (const row of request.headers ?? []) {
      if (row.enabled && row.key.trim()) {
        headers[substitute(row.key, variables)] = substitute(row.value, variables);
      }
    }
    // 先定稿 body 与 Content-Type / Accept 等 header：SigV4 签名必须在
    // headers 全部定稿之后计算，才能覆盖最终 URL、全部 headers 与 body。
    const { body, contentType: bodyContentType, notes } = bodyFromSpec(
      request.body ?? { type: "none" },
      variables,
    );
    if (bodyContentType !== undefined) {
      headers["Content-Type"] = headers["Content-Type"] ?? bodyContentType;
    }
    note.push(...notes);

    // 变量替换整个 auth 对象（token / 密钥 / PEM 里也可能含 {{变量}}）。
    const auth = substituteAuth(request.auth ?? { type: "none" }, variables);

    // OAuth2：CLI 不自动刷新，令牌过期或缺失时给出明确中文提示；
    // 绝不把 clientSecret / refreshToken 等写进 note 或任何日志。
    if (auth.type === "oauth2" && tokenNeedsRefresh(auth)) {
      return {
        request,
        response: null,
        timeMs: Date.now() - startedAt,
        error: "OAuth 2.0 访问令牌已过期或缺失：CLI 不会自动刷新令牌，请在桌面端重新授权后再试。",
        preError: null,
        note,
        scripts: { pre, post: null },
      };
    }

    // query 侧注入：apiKey(query) 走同步 applyAuthQuery；awsSigV4 +
    // signQuery 走异步预签名，签名覆盖此已定稿的 method / headers / body。
    // 只调用一次，X-Amz-* 同名参数在 helper 内先删后加，不会重复追加。
    const finalUrl = (await applyAuthQueryAsync(auth, url.toString(), {
      method: request.method,
      body,
      headers,
    })) ?? url.toString();

    // mTLS：Node fetch 无客户端证书通道，改走 node:https/http request()；
    // 没有可用证书时返回明确中文错误，禁止静默忽略。
    let mtlsOptions = null;
    if (auth.type === "mtls") {
      mtlsOptions = resolveMtlsOptions(auth);
      if (!mtlsOptions) {
        return {
          request,
          response: null,
          timeMs: Date.now() - startedAt,
          error: "mTLS 客户端证书请在桌面端执行；CLI 可设置 REQORA_TLS_CERT / REQORA_TLS_KEY / REQORA_TLS_CA 环境变量指向 PEM 文件",
          preError: null,
          note,
          scripts: { pre, post: null },
        };
      }
    }

    // header 侧注入：bearer / basic / apiKey(header) / oauth2 / awsSigV4。
    // 传入最终 URL、method、body，使 SigV4 签名覆盖最终请求。
    let authHeaders;
    try {
      authHeaders = await applyAuthHeaders(auth, headers, {
        url: finalUrl,
        method: request.method,
        body,
      });
    } catch (authError) {
      // authProviders 会在 OAuth2 令牌过期 / 缺失时抛错。统一转成清晰的中文
      // 结果：CLI 不自动刷新，提示在桌面端重新授权；错误里绝不带任何密钥。
      const message = auth.type === "oauth2"
        ? "OAuth 2.0 访问令牌已过期或缺失：CLI 不会自动刷新令牌，请在桌面端重新授权后再试。"
        : `鉴权失败：${authError?.message ?? authError}`;
      return {
        request,
        response: null,
        timeMs: Date.now() - startedAt,
        error: message,
        preError: null,
        note,
        scripts: { pre, post: null },
      };
    }
    // 兼容「返回新 headers 对象」的实现；原地修改实现会返回同一对象或 undefined。
    if (authHeaders && authHeaders !== headers && typeof authHeaders === "object") {
      Object.assign(headers, authHeaders);
    }

    const init = {
      method: request.method,
      headers,
      body,
      redirect,
      signal: AbortSignal.timeout(timeoutMs),
    };
    const { response, error: fetchError } = mtlsOptions
      ? await mtlsTransport(finalUrl, init, mtlsOptions)
      : await transport(finalUrl, init);
    const timeMs = Date.now() - startedAt;

    if (fetchError) {
      const detail = fetchError?.cause?.code ?? fetchError?.name ?? fetchError?.message ?? "unknown";
      return {
        request,
        response: null,
        timeMs,
        error: `请求失败：${detail}`,
        preError: null,
        note,
        scripts: { pre, post: null },
      };
    }

    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    const data = {
      requestId: "cli",
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      timeMs,
      size: text.length,
      url: finalUrl,
      resolvedUrl: finalUrl,
      missingVariables: [],
      headers: [...response.headers.entries()].map(([name, value]) => ({ name, value })),
      body: text,
      bodyKind: contentType.includes("json") ? "json" : text ? "text" : "empty",
      truncated: false,
    };

    return finish(request, variables, pre, note, data, timeMs);
  }

  /**
   * Score one response the way the app scores a scenario step: assertion- and
   * script-driven, status only counts when it was explicitly expected.
   */
  function outcome(request, result, expectedStatus) {
    if (result.error && !result.response) {
      return { passed: 0, failed: 1, error: result.error, ok: false };
    }
    const assertions = evaluateAssertions(request?.assertions ?? [], result.response);
    const tests = result.scripts?.post?.tests ?? [];
    const passed =
      assertions.filter((item) => item.ok).length + tests.filter((item) => item.ok).length;
    const failed =
      assertions.filter((item) => !item.ok).length + tests.filter((item) => !item.ok).length;
    const postError = result.scripts?.post?.error;
    const status = result.response?.status ?? null;
    const statusOk =
      expectedStatus === undefined ? Boolean(result.response?.ok) : status === expectedStatus;
    return {
      passed,
      failed,
      assertions,
      tests,
      statusOk,
      error: postError
        ? `后置脚本：${postError}`
        : statusOk
          ? undefined
          : expectedStatus === undefined
            ? `HTTP ${status ?? "ERR"}`
            : `HTTP ${status ?? "ERR"}（期望 ${expectedStatus}）`,
      ok: statusOk && failed === 0 && !postError,
    };
  }

  /**
   * One-off request for AI / scripting: no saved interface needed.
   * `spec` accepts `{ method, url, headers, query, body, json, raw, auth,
   * assertions, preScript, postScript, environment, variables }`.
   */
  async function adHoc(spec) {
    const { environment, variables } = baseVariables(spec.environment);
    const overlay = toVariableTable(spec.variables);
    let body = spec.body ?? { type: "none" };
    if (spec.json !== undefined) {
      body = {
        type: "json",
        content: typeof spec.json === "string" ? spec.json : JSON.stringify(spec.json, null, 2),
      };
    } else if (spec.raw !== undefined) {
      body = {
        type: "raw",
        content: String(spec.raw),
        contentType: spec.contentType ?? "text/plain",
      };
    }
    const request = {
      id: "reqora-adhoc",
      name: spec.name ?? `${(spec.method ?? "GET").toUpperCase()} ${spec.url}`,
      protocol: spec.protocol ?? "http",
      method: (spec.method ?? "GET").toUpperCase(),
      url: String(spec.url ?? ""),
      pathVariables: toRows(spec.pathVariables, "path"),
      headers: toRows(spec.headers, "hdr"),
      query: toRows(spec.query, "qry"),
      body,
      auth: spec.auth ?? { type: "none" },
      preScript: spec.preScript ?? "",
      postScript: spec.postScript ?? "",
      assertions: toAssertions(spec.assertions),
    };
    const result = await send(request, { ...variables, ...overlay }, undefined);
    return { request, result, environment, variables: { ...variables, ...overlay } };
  }

  return {
    send,
    outcome,
    adHoc,
    pickEnvironment,
    baseVariables,
    settings,
    engine: engine?.available ? "reqora-core" : "node-fetch",
  };
}
