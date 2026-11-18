// Node-side script runtime for the CLI.
//
// The desktop app runs user scripts inside a Blob Worker (CSP stays
// `script-src 'self'`, no unsafe-eval). The CLI cannot create that Worker, so it
// runs the *same helper source* in a `node:vm` context instead. There is no
// second copy of the helpers: WORKER_HELPERS_SOURCE is imported straight from
// src/lib/scripts.ts, which is also what the app splices into the Worker.
//
// Trust model is unchanged: scripts are trusted project code written by the
// user (same as a shell alias), not a sandbox for untrusted third-party input.
// A vm context is not a security boundary against malicious code.

import vm from "node:vm";

import { RESPONSE_VIEW_SOURCE, WORKER_HELPERS_SOURCE } from "../src/lib/scripts.ts";

/**
 * Build the response view the post script sees. Uses the exact same source
 * string the desktop Worker splices in — no mirrored copy.
 */
const responseView = new Function(`${RESPONSE_VIEW_SOURCE}; return __responseView;`)();

function nodeSource(code) {
  return [
    WORKER_HELPERS_SOURCE,
    "async function __main() {",
    code,
    "}",
    "async function __execute(payload) {",
    "  request = payload.request;",
    "  variables = payload.variables || {};",
    "  response = payload.response;",
    "  __logs = []; __tests = []; __mutations = []; __pending = [];",
    "  var error = null;",
    "  try { await __main(); await Promise.all(__pending); }",
    "  catch (e) { error = String((e && e.message) || e); }",
    "  return { request: request, variables: variables, logs: __logs, tests: __tests, mutations: __mutations, error: error };",
    "}",
  ].join("\n");
}

/**
 * Execute one script phase. Never throws: failures come back in `error`.
 * The synchronous part of the user code is bounded by vm's execution timeout;
 * asynchronous helpers (sha256 / hmac / test) resolve afterwards.
 */
export async function runCliScript({
  code,
  request,
  variables = {},
  response = null,
  sse = null,
  timeoutMs = 2000,
}) {
  const fallback = {
    request,
    variables: { ...variables },
    logs: [],
    tests: [],
    mutations: [],
    error: null,
    durationMs: 0,
  };
  if (!code || !code.trim()) return fallback;

  const started = Date.now();
  try {
    const context = vm.createContext({
      self: { crypto: globalThis.crypto },
      crypto: globalThis.crypto,
      TextEncoder,
      btoa,
      unescape,
      encodeURIComponent,
      console,
    });
    const source = nodeSource(code);
    new vm.Script(source, { filename: "reqora-user-script.js" }).runInContext(context, {
      timeout: timeoutMs,
    });

    let view = responseView(response);
    if (sse && view) view.sse = sse;
    context.__payload = {
      request: structuredClone(request),
      variables: { ...variables },
      response: view,
    };

    const result = await new vm.Script("__execute(__payload)", {
      filename: "reqora-script-run.js",
    }).runInContext(context, { timeout: timeoutMs });

    return {
      request: result?.request ?? fallback.request,
      variables: result?.variables ?? fallback.variables,
      // logs / tests / mutations are created inside the vm realm; copy them
      // into the host realm so callers (and Node's assert.deepStrictEqual)
      // see ordinary arrays instead of cross-realm exotics.
      logs: Array.from(result?.logs ?? []),
      tests: Array.from(result?.tests ?? []),
      mutations: Array.from(result?.mutations ?? []),
      error: result?.error ?? null,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const message =
      error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
        ? `脚本执行超过 ${timeoutMs}ms，已强制终止`
        : `脚本执行失败：${error instanceof Error ? error.message : String(error)}`;
    return { ...fallback, error: message, durationMs: Date.now() - started };
  }
}
