// Reqora MCP server — exposes the workbench to an AI agent over the Model
// Context Protocol (stdio transport, JSON-RPC 2.0, newline-delimited).
//
// What the agent can do:
//   • 读：项目概览、接口树、接口详情与文档、用例、场景、套件、环境
//   • 跑：临时请求、已保存接口、单条/批量用例、场景编排（条件/循环/等待/
//        提取/失败中断）、套件
//   • 写（需 --allow-write）：新建/修改接口、用例、场景
//
// Design notes:
//   • Reads go through `workspaceStore.mjs`, which rebuilds the same snapshot
//     the desktop WebView sees (SQLite row model, JSON fallback).
//   • Execution reuses the production TS modules (`src/lib/*.ts`) through
//     `requester.mjs` + `scenarioRunner.ts`, so assertions, extraction and
//     orchestration behave exactly like the app.
//   • Secrets stay local by default: auth values, sensitive headers and
//     environment variable values come back masked unless the client passes
//     `revealSecrets: true`. Variables explicitly marked 私密 (`secret: true`)
//     in the desktop UI are never revealed, even with that flag.

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { AUTH_SECRET_FIELDS } from "../src/lib/authProviders.ts";
import { newCaseFromRequest } from "../src/lib/cases.ts";
import { emptyRequest, normalizeRequest } from "../src/lib/defaults.ts";
import { uid } from "../src/lib/id.ts";
import { newScenario, newWaitStep, stepFromCase, stepFromRequest } from "../src/lib/scenario.ts";
import { runScenario } from "../src/lib/scenarioRunner.ts";
import { MCP_TOOL_SUMMARY, MCP_WRITE_TOOL_NAMES } from "../src/lib/mcpToolCatalog.ts";
import { diffEvidence, explainFailure, validateEvidence } from "../src/lib/runEvidence.ts";
import { buildHistory, failureFrequency, passRateTrend, queryHistory } from "../src/lib/runHistory.ts";
import { createEvidenceCollector } from "../src/lib/evidenceCollector.ts";
import { writeEvidenceFile } from "./evidenceFs.mjs";
import { enforcePrivate, isPrivateVariable, privateContext } from "../src/lib/privateValues.ts";
import {
  createRequester, toAssertions, toRows, toVariableTable, nodeFallbackDiagnostics,
} from "./requester.mjs";
import { discoverEngineBin } from "./engineClient.mjs";
import { mcpLogPath } from "./mcpLogger.mjs";

const SERVER_INFO = { name: "reqora", title: "Reqora（驿）API 工作台", version: "0.0.1" };
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL = PROTOCOL_VERSIONS[0];
const CASE_GROUPS = ["正向", "负向", "边界值", "安全性", "其他"];

const INSTRUCTIONS = `Reqora 是本机 API 工作台。先用 reqora_workspace_overview 了解项目规模，
再用 reqora_list_requests / reqora_get_request 找到接口，reqora_list_cases 看用例，
reqora_run_cases / reqora_run_scenario 执行并读报告。
跑完留下的 reqora.run.v1 证据可用 reqora_list_runs / reqora_get_evidence /
reqora_diff_runs / reqora_explain_failure 读取与归因（只读，无需 --allow-write）。
写入类工具（create/update/delete）需要服务以 --allow-write 启动；每次写入递增共享工作区版本号，桌面端打开同一项目时会自动检测冲突并提示刷新或备份后覆盖，不会再静默覆盖本次写入。
环境变量勾选「私密」后，值只保存在本机：revealSecrets / --reveal-secrets 也不能取到，
请让用户在桌面端自行填写。`;

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i;
const SECRET_NAME = /(token|secret|password|passwd|credential|api[-_]?key|auth)/i;
const SECRET_ASSIGNMENT = /(["']?[\w.-]*(?:token|secret|password|passwd|credential|api[-_]?key|auth)[\w.-]*["']?\s*[:=]\s*["'])([^"'\s,}]{3,})(["'])/gi;

// ------------------------------------------------------------- helpers ----
//
// One masking policy for the whole server. `maskDeep` runs again at the tool
// and resource boundary, so a newly added tool cannot leak a credential just
// because it forgot to call a masker. Masking is idempotent: values already
// containing `***` are left untouched.

const j = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const fail = (message) => ({
  content: [{ type: "text", text: String(message) }],
  isError: true,
});

/**
 * Turn a raw failure into something the agent/user can act on. A bare
 * "attempt to write a readonly database" used to be the only clue, with no
 * log file to inspect; every tool failure now carries a classified cause,
 * the fix and the exact log path.
 */
function explainToolFailure(error, tool, logPath) {
  const message = error?.message ?? String(error);
  const lower = String(message).toLowerCase();
  const readOnly = /readonly|read-only|permission denied|eacces|无权限|只读/.test(lower);
  const reason = readOnly
    ? "MCP 服务以只读方式运行（或工作区目录不可写）"
    : message;
  const advice = readOnly
    ? "请为工作区目录授予写权限，或让服务以 --allow-write 启动后重试。"
    : "请检查工作区路径与下方日志后重试；写入类工具需要以 --allow-write 启动。";
  return [
    `调用 ${tool ?? "工具"} 失败：${message}`,
    `原因：${reason}`,
    `处理建议：${advice}`,
    `错误日志：${logPath}`,
  ].join("\n");
}

/** Header allow-list OR secret-looking variable name — one rule everywhere. */
const isSensitiveKey = (key) =>
  SENSITIVE_HEADER.test(String(key ?? "")) || SECRET_NAME.test(String(key ?? ""));

function maskValue(value, reveal) {
  if (reveal || typeof value !== "string") return value;
  if (!value || value.includes("***")) return value;
  return value.length <= 8 ? "***" : `${value.slice(0, 3)}***${value.slice(-2)}`;
}

/** Mask secrets inside free text: JSON bodies, URL queries, scripts, logs. */
function maskText(text, reveal) {
  if (reveal || typeof text !== "string" || !text || text.includes("***")) return text;
  if (!SECRET_NAME.test(text)) return text;
  if (/^\s*[{[]/.test(text)) {
    try {
      return JSON.stringify(maskDeep(JSON.parse(text), reveal), null, 2);
    } catch {
      // Not JSON — fall through to the inline patterns below.
    }
  }
  if (text.includes("?")) {
    return text.replace(/([?&])([^=&#\s]+)=([^&#\s]+)/g, (match, sep, key, value) =>
      isSensitiveKey(key) ? `${sep}${key}=${maskValue(value, reveal)}` : match,
    );
  }
  return text.replace(SECRET_ASSIGNMENT, (match, prefix, secret, suffix) =>
    `${prefix}${maskValue(secret, reveal)}${suffix}`,
  );
}

/** Recursively mask any tool/resource payload (including nested inline requests). */
function maskDeep(value, reveal, key = "") {
  if (reveal) return value;
  if (typeof value === "string") return isSensitiveKey(key) ? maskValue(value, reveal) : maskText(value, reveal);
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, reveal));
  if (value && typeof value === "object") {
    const rowSensitive = typeof value.key === "string" && isSensitiveKey(value.key);
    const out = {};
    for (const [childKey, child] of Object.entries(value)) {
      out[childKey] = rowSensitive && childKey === "value"
        ? maskValue(child, reveal)
        : maskDeep(child, reveal, childKey);
    }
    return out;
  }
  return value;
}

function maskRows(rows, reveal, { maskAllValues = false } = {}) {
  return (rows ?? []).map((row) => ({
    key: row.key,
    value: maskAllValues || isSensitiveKey(row.key) ? maskValue(row.value, reveal) : row.value,
    enabled: row.enabled !== false,
    ...(row.description ? { description: row.description } : {}),
  }));
}

/** 归一化 authProviders 声明的密钥字段（兼容数组 / Set / 可迭代 / 记录对象）。 */
function authSecretFieldList(fields) {
  if (!fields) return [];
  if (Array.isArray(fields)) return fields;
  if (typeof fields === "string") return [fields];
  if (typeof fields[Symbol.iterator] === "function") return [...fields];
  if (typeof fields === "object") return Object.keys(fields);
  return [];
}

// 原硬编码字段 + authProviders 声明的全部新变体密钥字段，统一打码，确保
// clientSecret / secretAccessKey / sessionToken / accessToken / refreshToken /
// code / codeVerifier / keyPem / certPem / caPem / p12Base64 / passphrase 不泄露。
const AUTH_MASK_FIELDS = new Set([
  "token", "password", "username", "value",
  ...authSecretFieldList(AUTH_SECRET_FIELDS),
]);

function maskAuth(auth, reveal) {
  if (!auth || auth.type === "none" || auth.type === undefined) return { type: "none" };
  const copy = { ...auth };
  for (const key of AUTH_MASK_FIELDS) {
    if (typeof copy[key] === "string" && copy[key]) copy[key] = maskValue(copy[key], reveal);
  }
  return copy;
}

/** Request payload for the agent: full structure, secrets masked. */
function presentRequest(request, { reveal = false } = {}) {
  return {
    id: request.id,
    name: request.name,
    method: request.method,
    url: maskText(request.url, reveal),
    protocol: request.protocol ?? "http",
    folder: request.folder ?? "",
    description: maskText(request.description ?? "", reveal),
    pathVariables: maskRows(request.pathVariables, reveal),
    headers: maskRows(request.headers, reveal),
    query: maskRows(request.query, reveal),
    body: maskDeep(request.body ?? { type: "none" }, reveal),
    auth: maskAuth(request.auth, reveal),
    preScript: maskText(request.preScript ?? "", reveal),
    postScript: maskText(request.postScript ?? "", reveal),
    assertions: (request.assertions ?? []).map((item) => ({
      source: item.source,
      path: item.path,
      op: item.op,
      expected: maskDeep(item.value, reveal),
      enabled: item.enabled !== false,
    })),
    stream: request.stream ?? "auto",
    updatedAt: request.updatedAt ?? 0,
    contentUpdatedAt: request.contentUpdatedAt ?? request.updatedAt ?? 0,
  };
}

function allRequests(snapshot) {
  const out = [];
  for (const collection of snapshot.collections ?? []) {
    for (const request of collection.items ?? []) {
      out.push({ request, collection });
    }
  }
  return out;
}

function refSearch(candidates, ref, describe) {
  if (!ref) throw new Error("缺少 ref 参数（接口/用例/场景的 id 或名称）");
  const needle = String(ref).trim();
  const byId = candidates.find((item) => item.id === needle);
  if (byId) return byId;
  const lower = needle.toLowerCase();
  const exact = candidates.filter((item) => String(item.name ?? "").toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const partial = candidates.filter((item) => String(item.name ?? "").toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(
      `「${needle}」匹配到多个对象，请改用 id：\n${partial
        .slice(0, 12)
        .map((item) => `- ${item.id}  ${describe(item)}`)
        .join("\n")}`,
    );
  }
  throw new Error(`找不到「${needle}」。可用：\n${candidates.slice(0, 20).map((item) => `- ${item.id}  ${describe(item)}`).join("\n") || "（空）"}`);
}

function findRequest(snapshot, ref) {
  const entries = allRequests(snapshot);
  const found = refSearch(
    entries.map((entry) => ({ ...entry.request, __collection: entry.collection })),
    ref,
    (item) => `${item.method} ${item.name}`,
  );
  return { request: found, collection: found.__collection };
}

function truncate(text, limit) {
  const value = String(text ?? "");
  if (value.length <= limit) return { body: value, truncated: false };
  return { body: value.slice(0, limit), truncated: true };
}

/**
 * Scenario steps carry their response body only when the runner was asked to
 * capture it. Apply the same masking + ceiling as `presentRun` before exposing
 * it to an MCP client: raw bodies must never reach the wire unmasked.
 */
function presentStepBody(step, reveal) {
  if (step.body == null) return {};
  const clipped = truncate(maskText(step.body, reveal), 16_384);
  return {
    body: clipped.body,
    bodyTruncated: clipped.truncated || Boolean(step.bodyTruncated),
  };
}

function presentStep(step, index, reveal) {
  const { body, bodyTruncated, ...rest } = step;
  return { index: index + 1, ...rest, ...presentStepBody(step, reveal) };
}

/** One execution result → compact report for the agent. */
function presentRun(result, request, { maxBody = 16_384, reveal = false, expectedStatus } = {}) {
  const response = result.response;
  if (!response) {
    return {
      ok: false,
      error: result.error ?? "请求未发出",
      notes: result.note ?? [],
      timeMs: result.timeMs ?? 0,
    };
  }
  const body = truncate(response.body, maxBody);
  const assertions = (result.assertions ?? []).map((item) => ({
    ok: item.ok,
    message: item.message,
    source: item.source,
    path: item.path,
    op: item.op,
    expected: item.expected,
    actual: item.actual,
  }));
  const tests = (result.tests ?? []).map((item) => ({ ok: item.ok, name: item.name, message: item.message }));
  const statusOk = expectedStatus === undefined ? response.ok : response.status === expectedStatus;
  return {
    ok: statusOk && assertions.every((item) => item.ok) && tests.every((item) => item.ok) && !result.error,
    status: response.status,
    statusText: response.statusText,
    timeMs: response.timeMs,
    size: response.size,
    url: maskText(response.url, reveal),
    headers: (response.headers ?? []).map((header) => ({
      name: header.name,
      value: isSensitiveKey(header.name) ? maskValue(header.value, reveal) : maskText(header.value, reveal),
    })),
    body: maskText(body.body, reveal),
    bodyTruncated: body.truncated,
    assertions,
    tests,
    scriptLogs: maskDeep((result.scripts?.post?.logs ?? result.logs ?? []).slice(0, 50), reveal),
    error: maskText(result.error ?? undefined, reveal),
    notes: maskDeep(result.note ?? [], reveal),
    request: request
      ? { id: request.id, name: request.name, method: request.method, url: maskText(request.url, reveal) }
      : undefined,
  };
}

function maskVariableTable(vars, reveal) {
  const out = {};
  for (const [key, value] of Object.entries(vars ?? {})) {
    out[key] = isSensitiveKey(key) ? maskValue(value, reveal) : value;
  }
  return out;
}

// --------------------------------------------------------------- server ----

/**
 * Build the MCP handler set for one project.
 * @param {{store: import("./workspaceStore.mjs").WorkspaceStore, allowWrite?: boolean, defaults?: {environment?: string, maxBodyBytes?: number, revealSecrets?: boolean}, logger?: ReturnType<typeof import("./mcpLogger.mjs").createMcpLogger>}} options
 */
export function createMcpServer({ store, allowWrite = false, defaults = {}, logger }) {
  const maxBody = defaults.maxBodyBytes ?? 16_384;
  // Library consumers (tests, embedding) may omit the logger. Keep the same
  // error text with the default log path, but never write files behind their
  // back; the stdio entry point always passes a real logger.
  const log = logger ?? {
    path: mcpLogPath(),
    error() {},
    warn() {},
    info() {},
  };

  // Snapshot-derived 私密 policy, shared with the desktop (privateValues.ts).
  // Refreshed on every read; invalidated after a write so a newly marked
  // variable is protected by the very next response.
  let privateCache = null;
  const privateOf = (snapshot) => {
    privateCache = privateContext(snapshot);
    return privateCache;
  };
  const currentPrivate = async () =>
    privateCache ?? privateOf(await store.readSnapshot());
  // `--reveal-secrets` is a server-wide default; a per-call flag can only turn
  // masking off for that call, never back on when the server already reveals.
  const defaultReveal = defaults.revealSecrets === true;
  const revealFor = (args) => args?.revealSecrets === true || defaultReveal;
  const clampLimit = (value, fallback = 100) => Math.min(500, Math.max(1, Number(value) || fallback));

  // ------------------------------------------------------- evidence files ----
  // reqora.run.v1 documents are plain JSON files, produced by
  // `node bin/evidence.mjs`. These readers are read-only: they never write to
  // the workspace and never need --allow-write.

  const evidenceCandidates = (explicit) => {
    if (explicit) return [resolve(String(explicit))];
    if (process.env.REQORA_EVIDENCE_DIR) return [resolve(process.env.REQORA_EVIDENCE_DIR)];
    const candidates = [];
    if (typeof store.path === "string" && store.path) candidates.push(resolve(join(store.path, "evidence")));
    candidates.push(resolve("artifacts"));
    return candidates;
  };

  const readRuns = async (explicit) => {
    for (const dir of evidenceCandidates(explicit)) {
      let names;
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      const out = [];
      for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
        const path = join(dir, name);
        try {
          const evidence = JSON.parse(await readFile(path, "utf8"));
          if (validateEvidence(evidence).ok) out.push({ evidence, path });
        } catch {
          // ignore unrelated / partial JSON files
        }
      }
      if (out.length > 0) return out;
    }
    return [];
  };

  /** Every execution tool lands an evidence file through the same shared
   * builder as the CLI. Evidence I/O must never break a run. */
  const emitRunEvidence = (name, report) => {
    const rows = report?.steps ?? report?.results ?? report?.items;
    if (!Array.isArray(rows)) return null;
    try {
      const kind = name === "reqora_run_suite" ? "suite" : name === "reqora_run_cases" ? "case" : "scenario";
      const subjectRecord = report?.scenario ?? report?.suite ?? report?.case ?? {};
      // Use the same discovery order as the actual executor (including
      // dist-engine/<platform>-<arch>/), otherwise a shipped sidecar would be
      // mislabelled as "unknown" in the evidence.
      const sidecarBin = discoverEngineBin();
      const hasSidecar = Boolean(sidecarBin);
      const forcedNode = process.env.REQORA_ENGINE === "node";
      const diagnostic = nodeFallbackDiagnostics();
      const collector = createEvidenceCollector({
        runId: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        startedAt: new Date().toISOString(),
        engine: {
          transport: forcedNode || !hasSidecar ? "node-fetch" : "sidecar",
          declared_by: "environment",
          note: forcedNode
            ? `MCP：REQORA_ENGINE=node 回落 Node fetch；${diagnostic.summary}`
            : hasSidecar
              ? `MCP：检测到 reqora-send sidecar（${sidecarBin}）`
              : `MCP：未检测到 sidecar，回落 Node fetch 显式诊断模式；${diagnostic.summary}`,
        },
        subject: {
          kind,
          id: String(subjectRecord.id ?? "unknown"),
          name: String(subjectRecord.name ?? "未命名运行"),
        },
        envName: String(report?.environment ?? ""),
        envVariableNames: [],
      });
      for (const row of rows) collector.onStep(row);
      const evidence = collector.finish();
      const path = join(evidenceCandidates()[0], `${evidence.run_id}.json`);
      writeEvidenceFile(path, evidence);
      return { path, run_id: evidence.run_id };
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  };

  const findRun = async (args) => {
    if (args?.path) {
      const path = resolve(String(args.path));
      const evidence = JSON.parse(await readFile(path, "utf8"));
      const check = validateEvidence(evidence);
      if (!check.ok) throw new Error(`证据文件不符合 reqora.run.v1：${check.errors.join("；")}`);
      return { evidence, path };
    }
    const runId = String(args?.runId ?? "");
    const runs = await readRuns(args?.evidenceDir);
    const found = runId
      ? runs.find((item) => item.evidence.run_id === runId)
      : runs[runs.length - 1];
    if (!found) throw new Error(`找不到运行证据${runId ? ` ${runId}` : ""}；请先用 bin/evidence.mjs 产出证据，或设置 REQORA_EVIDENCE_DIR`);
    return found;
  };

  /** One execution + one report: replaces four copies of send/outcome/presentRun. */
  const presentFrom = (requester, request, result, { reveal = false, expectedStatus } = {}) => {
    const scored = requester.outcome(request, result, expectedStatus);
    return presentRun(
      { ...result, assertions: scored.assertions, tests: result.scripts?.post?.tests ?? [] },
      request,
      { maxBody, reveal, expectedStatus },
    );
  };

  const withSnapshot = async (fn) => {
    const snapshot = await store.readSnapshot();
    privateOf(snapshot);
    const requester = createRequester(snapshot);
    return fn(snapshot, requester);
  };

  const transportOf = (requester) => async (request, variables, ownerRequestId) => {
    const result = await requester.send(request, variables, ownerRequestId);
    const scored = requester.outcome(request, result);
    return {
      response: result.response,
      timeMs: result.timeMs,
      error: result.error,
      preError: result.preError,
      tests: result.scripts?.post?.tests ?? [],
      assertions: scored.assertions ?? [],
      activeVariables: result.activeVariables,
      note: result.note,
    };
  };

  const tools = [];
  const read = (spec) => tools.push({ ...spec, write: false });
  // Permission is enforced once, at registration, instead of repeating
  // assertWritable() in every write handler.
  const write = (spec) => tools.push({
    ...spec,
    write: true,
    handler: async (args) => {
      if (!allowWrite) {
        throw new Error("写入未开启。请以 --allow-write 启动 MCP 服务（或在客户端配置里加该参数）后再试。");
      }
      privateCache = null;
      // Surface the shared optimistic-lock revision on every write: callers
      // (and the desktop app) can see that an external mutation happened and
      // which revision the database is now at.
      const before = await store.readRev();
      const result = await spec.handler(args);
      const after = await store.readRev();
      const body =
        result && typeof result === "object" && !Array.isArray(result)
          ? { ...result }
          : { result };
      body.workspaceRev = {
        before: before.rev,
        after: after.rev,
        writer: after.writer,
        note:
          "写入递增共享版本号；桌面端自动保存携带 expectedRev，版本落后时返回 WORKSPACE_CONFLICT 并停止写入。",
      };
      body.writeHint =
        "写入已更新工作区版本号；桌面端若打开同一项目，会提示刷新（保留外部改动）或备份后覆盖。";
      return body;
    },
  });

  // ------------------------------------------------------------- reads ----

  read({
    name: "reqora_workspace_overview",
    title: "项目概览",
    description:
      "查看当前项目：数据位置、接口/用例/场景/套件/环境数量、超时与重定向设置、是否允许写入。建议作为第一次调用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () =>
      withSnapshot(async (snapshot) => {
        const requests = allRequests(snapshot);
        const docPages = snapshot.docPages ?? [];
        return {
          project: {
            id: store.projectId,
            name: store.projectName,
            path: store.path,
            format: store.kind,
          },
          counts: {
            collections: (snapshot.collections ?? []).length,
            requests: requests.length,
            cases: (snapshot.cases ?? []).length,
            scenarios: (snapshot.scenarios ?? []).length,
            suites: (snapshot.suites ?? []).length,
            environments: (snapshot.environments ?? []).length,
            docPages: docPages.length,
            dataModels: (snapshot.dataModels ?? []).length,
          },
          settings: {
            timeoutSecs: snapshot.settings?.timeoutSecs ?? 30,
            followRedirects: snapshot.settings?.followRedirects !== false,
            manageCookies: snapshot.settings?.manageCookies !== false,
          },
          writeEnabled: allowWrite,
          activeEnvironment:
            (snapshot.environments ?? []).find((item) => item.id === snapshot.activeEnvironmentId)?.name ?? null,
          collections: (snapshot.collections ?? []).map((collection) => ({
            id: collection.id,
            name: collection.name,
            requests: (collection.items ?? []).length,
          })),
        };
      }),
  });

  read({
    name: "reqora_list_projects",
    title: "列出本机项目",
    description: "列出桌面端登记的所有本地项目及其数据目录，可配合 --workspace 切换到其它项目。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const { listProjects } = await import("./workspaceStore.mjs");
      const result = listProjects();
      return {
        activeProjectId: result.activeProjectId,
        current: store.projectId,
        projects: result.projects,
      };
    },
  });

  read({
    name: "reqora_list_requests",
    title: "搜索接口",
    description:
      "按关键字 / 集合 / 协议过滤接口，返回 id、方法、URL、所属集合、文档摘要与用例数量。用于定位接口后调用 reqora_get_request。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "按名称 / URL / 方法模糊匹配" },
        collection: { type: "string", description: "集合名称或 id" },
        protocol: { type: "string", description: "http / grpc / ws / tcp 等" },
        limit: { type: "number", description: "最多返回条数，默认 100" },
        offset: { type: "number", description: "跳过条数，默认 0" },
      },
      additionalProperties: false,
    },
    handler: async (args) =>
      withSnapshot(async (snapshot) => {
        const caseCount = new Map();
        for (const item of snapshot.cases ?? []) {
          caseCount.set(item.requestId, (caseCount.get(item.requestId) ?? 0) + 1);
        }
        let entries = allRequests(snapshot);
        if (args.collection) {
          const needle = String(args.collection).toLowerCase();
          entries = entries.filter(
            (entry) =>
              entry.collection.id === args.collection ||
              String(entry.collection.name).toLowerCase().includes(needle),
          );
        }
        if (args.protocol) {
          const protocol = String(args.protocol).toLowerCase();
          entries = entries.filter((entry) => (entry.request.protocol ?? "http") === protocol);
        }
        if (args.query) {
          const needle = String(args.query).toLowerCase();
          entries = entries.filter((entry) => {
            const request = entry.request;
            return [request.name, request.url, request.method, request.folder, request.doc?.summary]
              .filter(Boolean)
              .some((field) => String(field).toLowerCase().includes(needle));
          });
        }
        const total = entries.length;
        const offset = Math.max(0, Number(args.offset) || 0);
        const limit = clampLimit(args.limit);
        return {
          total,
          offset,
          limit,
          items: entries.slice(offset, offset + limit).map((entry) => ({
            id: entry.request.id,
            name: entry.request.name,
            method: entry.request.method,
            url: entry.request.url,
            protocol: entry.request.protocol ?? "http",
            collectionId: entry.collection.id,
            collectionName: entry.collection.name,
            folder: entry.request.folder || "",
            docSummary: entry.request.doc?.summary ?? "",
            docStatus: entry.request.doc?.status ?? "",
            cases: caseCount.get(entry.request.id) ?? 0,
          })),
        };
      }),
  });

  read({
    name: "reqora_get_request",
    title: "接口详情",
    description:
      "按 id 或名称取接口完整定义（参数、请求体、脚本、断言、文档），并附上所属集合、关联用例与引用它的场景。",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "接口 id 或名称（支持唯一子串匹配）" },
        revealSecrets: { type: "boolean", description: "返回真实的鉴权/敏感 Header 值（默认打码）" },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    handler: async (args) =>
      withSnapshot(async (snapshot) => {
        const { request, collection } = findRequest(snapshot, args.ref);
        const cases = (snapshot.cases ?? []).filter((item) => item.requestId === request.id);
        const scenarios = (snapshot.scenarios ?? []).filter((scenario) =>
          (scenario.steps ?? []).some(
            (step) => step.source?.kind === "case" && cases.some((item) => item.id === step.source.caseId),
          ),
        );
        return {
          request: presentRequest(request, { reveal: revealFor(args) }),
          collection: { id: collection.id, name: collection.name, auth: maskAuth(collection.auth, revealFor(args)) },
          doc: request.doc
            ? {
                summary: request.doc.summary,
                description: request.doc.description,
                owner: request.doc.owner,
                status: request.doc.status,
                tags: request.doc.tags ?? [],
                responseExamples: (request.doc.responses ?? []).map((example) => ({
                  name: example.name,
                  status: example.status,
                  contentType: example.contentType,
                  bodyPreview: truncate(example.body, 2_000).body,
                })),
                requestModelId: request.doc.requestModelId ?? null,
              }
            : null,
          cases: cases.map((item) => ({
            id: item.id,
            name: item.name,
            group: item.group,
            enabled: item.enabled !== false,
            expectedStatus: item.expectedStatus ?? null,
            lastRun: item.lastRun ?? null,
          })),
          usedByScenarios: scenarios.map((scenario) => ({ id: scenario.id, name: scenario.name })),
        };
      }),
  });

  read({
    name: "reqora_list_cases",
    title: "列出用例",
    description: "按接口 / 分组 / 关键字列出用例，含最近一次运行结果。",
    inputSchema: {
      type: "object",
      properties: {
        requestRef: { type: "string", description: "只看某个接口（id 或名称）的用例" },
        group: { type: "string", description: `用例分组：${CASE_GROUPS.join(" / ")}` },
        query: { type: "string", description: "按用例名模糊匹配" },
        limit: { type: "number", description: "最多返回条数，默认 100" },
      },
      additionalProperties: false,
    },
    handler: async (args) =>
      withSnapshot(async (snapshot) => {
        let cases = [...(snapshot.cases ?? [])];
        if (args.requestRef) {
          const { request } = findRequest(snapshot, args.requestRef);
          cases = cases.filter((item) => item.requestId === request.id);
        }
        if (args.group) cases = cases.filter((item) => item.group === args.group);
        if (args.query) {
          const needle = String(args.query).toLowerCase();
          cases = cases.filter((item) => String(item.name).toLowerCase().includes(needle));
        }
        const limit = clampLimit(args.limit);
        return {
          total: cases.length,
          items: cases.slice(0, limit).map((item) => ({
            id: item.id,
            name: item.name,
            group: item.group,
            requestId: item.requestId,
            enabled: item.enabled !== false,
            expectedStatus: item.expectedStatus ?? null,
            method: item.request?.method,
            url: item.request?.url,
            lastRun: item.lastRun ?? null,
          })),
        };
      }),
  });

  read({
    name: "reqora_get_case",
    title: "用例详情",
    description: "取单条用例的完整请求快照、期望状态码与最近运行结果。",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "用例 id 或名称" },
        revealSecrets: { type: "boolean", description: "返回真实鉴权值（默认打码）" },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    handler: async (args) =>
      withSnapshot(async (snapshot) => {
        const caseItem = refSearch(
          snapshot.cases ?? [],
          args.ref,
          (item) => `${item.group} ${item.name}`,
        );
        return {
          id: caseItem.id,
          name: caseItem.name,
          group: caseItem.group,
          description: caseItem.description ?? "",
          enabled: caseItem.enabled !== false,
          expectedStatus: caseItem.expectedStatus ?? null,
          requestId: caseItem.requestId,
          syncedAt: caseItem.syncedAt,
          updatedAt: caseItem.updatedAt,
          lastRun: caseItem.lastRun ?? null,
          request: presentRequest(caseItem.request, { reveal: revealFor(args) }),
        };
      }),
  });

  read({
    name: "reqora_list_scenarios",
    title: "列出场景",
    description: "列出跨接口测试场景及其步骤概览（类型、条件、循环、提取）。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "按名称模糊匹配" },
        limit: { type: "number", description: "最多返回条数，默认 50" },
      },
      additionalProperties: false,
    },
    handler: async (args) =>
      withSnapshot(async (snapshot) => {
        let scenarios = [...(snapshot.scenarios ?? [])];
        if (args.query) {
          const needle = String(args.query).toLowerCase();
          scenarios = scenarios.filter((item) => String(item.name).toLowerCase().includes(needle));
        }
        const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
        return {
          total: scenarios.length,
          items: scenarios.slice(0, limit).map((scenario) => ({
            id: scenario.id,
            name: scenario.name,
            description: scenario.description ?? "",
            steps: (scenario.steps ?? []).length,
            dataRows: scenario.dataSet?.rows?.length ?? 0,
            stepOverview: (scenario.steps ?? []).map((step, index) => ({
              index: index + 1,
              name: step.name,
              kind: step.source?.kind,
              enabled: step.enabled !== false,
              condition: step.condition ?? null,
              repeat: step.repeat ?? null,
            })),
            lastRun: scenario.lastRun
              ? {
                  at: scenario.lastRun.at,
                  total: scenario.lastRun.total,
                  passed: scenario.lastRun.passed,
                  failed: scenario.lastRun.failed,
                  skipped: scenario.lastRun.skipped,
                  timeMs: scenario.lastRun.timeMs,
                }
              : null,
          })),
        };
      }),
  });

  read({
    name: "reqora_get_scenario",
    title: "场景详情",
    description: "取场景完整定义：每一步的来源（用例 / 内联请求 / 等待 / 数据库）、提取规则、条件与循环配置、数据集。",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string", description: "场景 id 或名称" } },
      required: ["ref"],
      additionalProperties: false,
    },
    handler: async (args) =>
      withSnapshot(async (snapshot) => {
        const scenario = refSearch(snapshot.scenarios ?? [], args.ref, (item) => item.name);
        return {
          id: scenario.id,
          name: scenario.name,
          description: scenario.description ?? "",
          dataSet: scenario.dataSet ?? null,
          steps: (scenario.steps ?? []).map((step, index) => ({
            index: index + 1,
            id: step.id,
            name: step.name,
            enabled: step.enabled !== false,
            source:
              step.source?.kind === "case"
                ? {
                    kind: "case",
                    caseId: step.source.caseId,
                    caseName:
                      (snapshot.cases ?? []).find((item) => item.id === step.source.caseId)?.name ?? "（已删除）",
                  }
                : step.source?.kind === "inline"
                  ? { kind: "inline", request: presentRequest(step.source.request) }
                  : step.source,
            extracts: step.extracts ?? [],
            condition: step.condition ?? null,
            repeat: step.repeat ?? null,
            continueOnFailure: Boolean(step.continueOnFailure),
          })),
          lastRun: scenario.lastRun ?? null,
        };
      }),
  });

  read({
    name: "reqora_list_suites",
    title: "列出套件",
    description: "列出测试套件（用例 + 场景的组合）及其成员与最近一次批量结果。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () =>
      withSnapshot(async (snapshot) => ({
        total: (snapshot.suites ?? []).length,
        items: (snapshot.suites ?? []).map((suite) => ({
          id: suite.id,
          name: suite.name,
          description: suite.description ?? "",
          items: (suite.items ?? []).map((item) => ({
            kind: item.kind,
            refId: item.refId,
            name:
              item.kind === "case"
                ? (snapshot.cases ?? []).find((candidate) => candidate.id === item.refId)?.name ?? "（已删除）"
                : (snapshot.scenarios ?? []).find((candidate) => candidate.id === item.refId)?.name ?? "（已删除）",
          })),
          lastRun: suite.lastRun
            ? {
                at: suite.lastRun.at,
                total: suite.lastRun.total,
                passed: suite.lastRun.passed,
                failed: suite.lastRun.failed,
                skipped: suite.lastRun.skipped,
                timeMs: suite.lastRun.timeMs,
              }
            : null,
        })),
      })),
  });

  read({
    name: "reqora_list_environments",
    title: "列出环境",
    description:
      "列出环境及其变量名；变量值默认打码，需要真实值（例如给 AI 拼请求）可传 revealSecrets。桌面端勾选「私密」的变量例外：即使 revealSecrets 也只返回打码值。",
    inputSchema: {
      type: "object",
      properties: { revealSecrets: { type: "boolean", description: "返回真实变量值（默认打码）" } },
      additionalProperties: false,
    },
    handler: async (args) =>
      withSnapshot(async (snapshot) => ({
        activeEnvironmentId: snapshot.activeEnvironmentId ?? null,
        items: (snapshot.environments ?? []).map((environment) => ({
          id: environment.id,
          name: environment.name,
          active: environment.id === snapshot.activeEnvironmentId,
          variables: (environment.variables ?? []).map((row) => {
            const isPrivate = isPrivateVariable(row);
            return {
              key: row.key,
              // 显式私密标记优先于全局 revealSecrets / --reveal-secrets。
              value: maskValue(row.value, isPrivate ? false : revealFor(args)),
              enabled: row.enabled !== false,
              ...(isPrivate ? { private: true } : {}),
            };
          }),
          headers: maskRows(environment.headers, revealFor(args)),
        })),
      })),
  });

  // --------------------------------------------------------- execution ----

  read({
    name: "reqora_send_request",
    title: "发送临时请求",
    description:
      "直接用 Node 发送一次 HTTP 请求（不需要先建接口），支持环境变量、鉴权、断言脚本，返回状态码、耗时、响应头与响应体。",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", description: "HTTP 方法，默认 GET" },
        url: { type: "string", description: "完整 URL，可用 {{变量}}" },
        headers: { type: "object", description: "请求头键值对" },
        query: { type: "object", description: "查询参数键值对" },
        json: { description: "JSON 请求体（对象或字符串）" },
        raw: { type: "string", description: "原始文本请求体" },
        contentType: { type: "string", description: "raw 请求体的 Content-Type" },
        auth: {
          type: "object",
          description:
            '鉴权：{type:"bearer",token} / {type:"basic",username,password} / {type:"apiKey",key,value,location} / ' +
            '{type:"oauth2",accessToken,…}（CLI 用已持久化的访问令牌，不自动刷新，过期请在桌面端重新授权） / ' +
            '{type:"awsSigV4",accessKeyId,secretAccessKey,region,service,…} / ' +
            '{type:"mtls",certPem,keyPem,caPem,passphrase,minTlsVersion}（或 REQORA_TLS_CERT/KEY/CA 环境变量）',
        },
        assertions: { type: "array", description: "声明式断言：{source,path,op,expected}" },
        preScript: { type: "string", description: "前置脚本（可 setUrl/setHeader/setVar…）" },
        postScript: { type: "string", description: "后置脚本（可 test()/expect()/log()）" },
        environment: { type: "string", description: "环境名称或 id，用于 {{变量}} 替换" },
        variables: { type: "object", description: "一次性变量覆盖" },
        revealSecrets: { type: "boolean", description: "响应头/日志中的敏感值不打码" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    handler: async (args) =>
      withSnapshot(async (snapshot, requester) => {
        if (args.environment && !requester.pickEnvironment(args.environment)) {
          throw new Error(
            `找不到环境「${args.environment}」。可用：${(snapshot.environments ?? [])
              .map((item) => item.name)
              .join(", ") || "（无）"}`,
          );
        }
        const { request, result } = await requester.adHoc(args);
        return presentFrom(requester, request, result, { reveal: revealFor(args) });
      }),
  });

  read({
    name: "reqora_run_request",
    title: "运行已保存接口",
    description: "按 id / 名称运行已保存接口（含其前置后置脚本与断言），可指定环境。",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "接口 id 或名称" },
        environment: { type: "string", description: "环境名称或 id" },
        variables: { type: "object", description: "变量覆盖" },
        expectedStatus: { type: "number", description: "期望状态码（给出时按它判定成败）" },
        revealSecrets: { type: "boolean" },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    handler: async (args) =>
      withSnapshot(async (snapshot, requester) => {
        const { request } = findRequest(snapshot, args.ref);
        const { variables: base } = requester.baseVariables(args.environment ?? defaults.environment);
        const vars = { ...base, ...toVariableTable(args.variables) };
        const result = await requester.send(request, vars, request.id);
        return presentFrom(requester, request, result, {
          reveal: revealFor(args),
          expectedStatus: args.expectedStatus,
        });
      }),
  });

  read({
    name: "reqora_run_cases",
    title: "运行用例",
    description:
      "运行一条或多条用例：可传用例 id/名称列表，也可给接口引用跑它的全部用例（可按分组过滤）。返回逐条结果与汇总。",
    inputSchema: {
      type: "object",
      properties: {
        refs: { type: "array", items: { type: "string" }, description: "用例 id / 名称列表" },
        requestRef: { type: "string", description: "运行某接口下的全部用例" },
        group: { type: "string", description: `只跑某个分组：${CASE_GROUPS.join(" / ")}` },
        environment: { type: "string" },
        variables: { type: "object" },
        revealSecrets: { type: "boolean" },
      },
      additionalProperties: false,
    },
    handler: async (args) =>
      withSnapshot(async (snapshot, requester) => {
        const all = snapshot.cases ?? [];
        let selected = [];
        if (args.refs?.length) {
          selected = args.refs.map((ref) => refSearch(all, ref, (item) => `${item.group} ${item.name}`));
        } else if (args.requestRef) {
          const { request } = findRequest(snapshot, args.requestRef);
          selected = all.filter((item) => item.requestId === request.id);
        } else {
          throw new Error("需要 refs 或 requestRef 之一");
        }
        if (args.group) selected = selected.filter((item) => item.group === args.group);
        selected = selected.filter((item) => item.enabled !== false);
        if (!selected.length) throw new Error("没有可运行的用例（可能被停用或已删除）");

        const { environment, variables: base } = requester.baseVariables(
          args.environment ?? defaults.environment,
        );
        const vars = { ...base, ...toVariableTable(args.variables) };
        const results = [];
        for (const caseItem of selected) {
          const result = await requester.send(caseItem.request, vars, caseItem.requestId);
          const report = presentFrom(requester, caseItem.request, result, {
            reveal: revealFor(args),
            expectedStatus: caseItem.expectedStatus,
          });
          results.push({
            caseId: caseItem.id,
            name: caseItem.name,
            group: caseItem.group,
            expectedStatus: caseItem.expectedStatus ?? null,
            ...report,
          });
        }
        return {
          environment: environment?.name ?? null,
          summary: {
            total: results.length,
            passed: results.filter((item) => item.ok).length,
            failed: results.filter((item) => !item.ok).length,
            timeMs: results.reduce((sum, item) => sum + (item.timeMs ?? 0), 0),
          },
          results,
        };
      }),
  });

  read({
    name: "reqora_run_scenario",
    title: "运行场景编排",
    description:
      "运行跨接口测试场景，完整执行条件门、循环（次数/遍历数组）、等待、步骤提取与失败中断，按数据行多轮执行并返回逐步报告。",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "场景 id 或名称" },
        environment: { type: "string" },
        variables: { type: "object", description: "场景变量覆盖" },
        dataCsv: { type: "string", description: "临时 CSV 数据集（首行表头），覆盖场景内置数据集" },
        dataRows: { type: "array", items: { type: "object" }, description: "临时数据集行（对象数组）" },
        maxSteps: { type: "number", description: "单次执行步数上限，默认 100" },
        revealSecrets: { type: "boolean" },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    handler: async (args) =>
      withSnapshot(async (snapshot, requester) => {
        const scenario = refSearch(snapshot.scenarios ?? [], args.ref, (item) => item.name);
        const { environment, variables: base } = requester.baseVariables(
          args.environment ?? defaults.environment,
        );
        let dataRows = args.dataRows;
        if (!dataRows && args.dataCsv) {
          const { parseCsvDataset } = await import("../src/lib/scenario.ts");
          const parsed = parseCsvDataset(String(args.dataCsv));
          if (parsed.error && !parsed.rows.length) throw new Error(parsed.error);
          dataRows = parsed.rows;
        }
        const run = await runScenario(scenario, {
          cases: snapshot.cases ?? [],
          transport: transportOf(requester),
          baseVariables: { ...base, ...toVariableTable(args.variables) },
          dataRows,
          maxSteps: clampLimit(args.maxSteps),
          captureBody: true,
        });
        return {
          scenario: { id: scenario.id, name: scenario.name },
          environment: environment?.name ?? null,
          rounds: run.rounds.length,
          summary: {
            ok: run.ok,
            total: run.summary.total,
            passed: run.summary.passed,
            failed: run.summary.failed,
            skipped: run.summary.skipped,
            timeMs: run.summary.timeMs,
          },
          steps: run.steps.map((step, index) => presentStep(step, index, revealFor(args))),
          variables: maskVariableTable(run.variables, revealFor(args)),
        };
      }),
  });

  read({
    name: "reqora_run_suite",
    title: "运行套件",
    description: "运行测试套件（按成员顺序执行用例与场景），返回逐成员结果与汇总。",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "套件 id 或名称" },
        environment: { type: "string" },
        variables: { type: "object" },
        revealSecrets: { type: "boolean" },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    handler: async (args) =>
      withSnapshot(async (snapshot, requester) => {
        const suite = refSearch(snapshot.suites ?? [], args.ref, (item) => item.name);
        if (!(suite.items ?? []).length) throw new Error(`套件「${suite.name}」没有成员`);
        const { environment, variables: base } = requester.baseVariables(
          args.environment ?? defaults.environment,
        );
        const vars = { ...base, ...toVariableTable(args.variables) };
        const items = [];
        for (const member of suite.items) {
          if (member.kind === "case") {
            const caseItem = (snapshot.cases ?? []).find((item) => item.id === member.refId);
            if (!caseItem) {
              items.push({ kind: "case", refId: member.refId, name: "（已删除）", ok: false, error: "用例已删除" });
              continue;
            }
            const result = await requester.send(caseItem.request, vars, caseItem.requestId);
            const report = presentFrom(requester, caseItem.request, result, {
              reveal: revealFor(args),
              expectedStatus: caseItem.expectedStatus,
            });
            items.push({ kind: "case", refId: caseItem.id, name: caseItem.name, ...report });
          } else {
            const scenario = (snapshot.scenarios ?? []).find((item) => item.id === member.refId);
            if (!scenario) {
              items.push({ kind: "scenario", refId: member.refId, name: "（已删除）", ok: false, error: "场景已删除" });
              continue;
            }
            const run = await runScenario(scenario, {
              cases: snapshot.cases ?? [],
              transport: transportOf(requester),
              baseVariables: vars,
              maxSteps: 200,
              captureBody: true,
            });
            items.push({
              kind: "scenario",
              refId: scenario.id,
              name: scenario.name,
              ok: run.ok,
              summary: {
                total: run.summary.total,
                passed: run.summary.passed,
                failed: run.summary.failed,
                skipped: run.summary.skipped,
                timeMs: run.summary.timeMs,
              },
              failingSteps: run.steps.filter((step) => !step.ok && !step.skipped).map((step) => ({
                name: step.name,
                status: step.status,
                error: step.error,
                ...presentStepBody(step, revealFor(args)),
              })),
            });
          }
        }
        return {
          suite: { id: suite.id, name: suite.name },
          environment: environment?.name ?? null,
          summary: {
            total: items.length,
            passed: items.filter((item) => item.ok).length,
            failed: items.filter((item) => !item.ok).length,
          },
          items,
        };
      }),
  });

  /** Build one scenario step from a compact spec (`caseRef` / `requestRef` / `waitMs`). */
  const stepFromSpec = (snapshot, entry = {}) => {
    let step;
    if (entry.waitMs !== undefined) {
      step = newWaitStep(Number(entry.waitMs) || 0);
    } else if (entry.caseRef) {
      const caseItem = refSearch(
        snapshot.cases ?? [],
        entry.caseRef,
        (item) => `${item.group} ${item.name}`,
      );
      step = stepFromCase(caseItem, entry.name);
    } else if (entry.requestRef) {
      const { request } = findRequest(snapshot, entry.requestRef);
      step = stepFromRequest(request, entry.name);
    } else {
      throw new Error("步骤缺少 caseRef / requestRef / waitMs");
    }
    if (entry.name && entry.waitMs === undefined) step.name = String(entry.name);
    if (entry.enabled !== undefined) step.enabled = Boolean(entry.enabled);
    if (entry.continueOnFailure !== undefined) step.continueOnFailure = Boolean(entry.continueOnFailure);
    if (entry.extracts) {
      step.extracts = entry.extracts.map((extract, index) => ({
        id: `extract-${index}`,
        varName: String(extract.varName ?? ""),
        source: extract.source ?? "json",
        path: String(extract.path ?? ""),
      }));
    }
    if (entry.condition) step.condition = entry.condition;
    if (entry.repeat) step.repeat = entry.repeat;
    return step;
  };

  // ------------------------------------------------------------- writes ----

  const resolveCollection = (snapshot, ref) => {
    if (!ref) {
      const first = (snapshot.collections ?? [])[0];
      if (first) return first;
      return null;
    }
    return refSearch(snapshot.collections ?? [], ref, (item) => item.name);
  };

  /** Apply `overrides` / body shortcuts onto a request draft. */
  const applyRequestPatch = (draft, patch = {}) => {
    const next = { ...draft };
    if (patch.name !== undefined) next.name = String(patch.name);
    if (patch.method !== undefined) next.method = String(patch.method).toUpperCase();
    if (patch.url !== undefined) next.url = String(patch.url);
    if (patch.description !== undefined) next.description = String(patch.description);
    if (patch.folder !== undefined) next.folder = String(patch.folder);
    if (patch.headers !== undefined) next.headers = toRows(patch.headers, "hdr");
    if (patch.query !== undefined) next.query = toRows(patch.query, "qry");
    if (patch.pathVariables !== undefined) next.pathVariables = toRows(patch.pathVariables, "path");
    if (patch.auth !== undefined) next.auth = patch.auth;
    if (patch.preScript !== undefined) next.preScript = String(patch.preScript);
    if (patch.postScript !== undefined) next.postScript = String(patch.postScript);
    if (patch.assertions !== undefined) {
      next.assertions = toAssertions(patch.assertions);
    }
    if (patch.json !== undefined) {
      next.body = {
        type: "json",
        content: typeof patch.json === "string" ? patch.json : JSON.stringify(patch.json, null, 2),
      };
    } else if (patch.raw !== undefined) {
      next.body = {
        type: "raw",
        content: String(patch.raw),
        contentType: patch.contentType ?? "text/plain",
      };
    } else if (patch.body !== undefined) {
      next.body = patch.body;
    }
    return next;
  };

  write({
    name: "reqora_create_request",
    title: "新建接口",
    description:
      "在集合（不存在则新建）里创建接口。可一次给出方法、URL、参数、请求体与文档摘要。需要 --allow-write。",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "集合名称或 id；省略则用第一个集合" },
        name: { type: "string", description: "接口名称" },
        method: { type: "string", description: "HTTP 方法，默认 GET" },
        url: { type: "string", description: "接口地址，可用 {{变量}}" },
        folder: { type: "string", description: "子目录路径" },
        headers: { type: "object" },
        query: { type: "object" },
        json: { description: "JSON 请求体" },
        raw: { type: "string" },
        auth: { type: "object" },
        description: { type: "string" },
        docSummary: { type: "string", description: "文档一行摘要" },
      },
      required: ["name", "url"],
      additionalProperties: false,
    },
    handler: async (args) => {      return withSnapshot(async (snapshot) => {
        let collection = resolveCollection(snapshot, args.collection);
        if (!collection) {
          collection = { id: uid(), name: args.collection || "AI 导入", items: [] };
          await store.putCollection(collection);
        }
        const draft = applyRequestPatch(
          { ...emptyRequest(args.name), id: uid(), folder: args.folder ?? "" },
          args,
        );
        const now = Date.now();
        const request = normalizeRequest({
          ...draft,
          updatedAt: now,
          contentUpdatedAt: now,
          doc: {
            ...(draft.doc ?? {}),
            summary: args.docSummary ?? "",
            updatedAt: now,
          },
        });
        await store.putRequest(collection.id, request);
        return {
          created: true,
          collection: { id: collection.id, name: collection.name },
          request: presentRequest(request),
          hint: "写入已递增工作区版本号；桌面端打开同一项目时会提示刷新（保留外部改动）或备份后覆盖。",
        };
      });
    },
  });

  write({
    name: "reqora_update_request",
    title: "修改接口",
    description: "修改已保存接口的字段（名称、URL、参数、请求体、脚本、断言、文档摘要）。需要 --allow-write。",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "接口 id 或名称" },
        patch: {
          type: "object",
          description:
            "要改的字段：name / method / url / folder / headers / query / pathVariables / auth / preScript / postScript / assertions / json / raw / body / description",
        },
        docSummary: { type: "string" },
      },
      required: ["ref", "patch"],
      additionalProperties: false,
    },
    handler: async (args) => {      return withSnapshot(async (snapshot) => {
        const { request, collection } = findRequest(snapshot, args.ref);
        const patched = applyRequestPatch(request, args.patch);
        const now = Date.now();
        const next = {
          ...patched,
          updatedAt: now,
          contentUpdatedAt: now,
          doc: args.docSummary !== undefined ? { ...(patched.doc ?? {}), summary: args.docSummary, updatedAt: now } : patched.doc,
        };
        await store.putRequest(collection.id, next);
        return { updated: true, request: presentRequest(next) };
      });
    },
  });

  write({
    name: "reqora_delete_request",
    title: "删除接口",
    description: "删除接口（软删，可被云同步传播；本机可从回收站语义恢复需在应用内操作）。需要 --allow-write。",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string", description: "接口 id 或名称" } },
      required: ["ref"],
      additionalProperties: false,
    },
    handler: async (args) => {      return withSnapshot(async (snapshot) => {
        const { request } = findRequest(snapshot, args.ref);
        await store.deleteEntity(request.id);
        return { deleted: true, id: request.id, name: request.name };
      });
    },
  });

  write({
    name: "reqora_create_case",
    title: "新建用例",
    description:
      "基于接口创建用例（默认复制接口请求快照），可覆盖 URL / 参数 / 请求体 / 断言并指定期望状态码。需要 --allow-write。",
    inputSchema: {
      type: "object",
      properties: {
        requestRef: { type: "string", description: "所属接口 id 或名称" },
        name: { type: "string", description: "用例名称" },
        group: { type: "string", description: `分组：${CASE_GROUPS.join(" / ")}，默认正向` },
        description: { type: "string" },
        expectedStatus: { type: "number" },
        overrides: {
          type: "object",
          description: "覆盖项：url / headers / query / pathVariables / auth / json / raw / body / assertions / preScript / postScript",
        },
      },
      required: ["requestRef", "name"],
      additionalProperties: false,
    },
    handler: async (args) => {      return withSnapshot(async (snapshot) => {
        const { request } = findRequest(snapshot, args.requestRef);
        const group = CASE_GROUPS.includes(args.group) ? args.group : "正向";
        const caseItem = newCaseFromRequest(request, args.name, group);
        if (args.description) caseItem.description = args.description;
        if (args.expectedStatus !== undefined) caseItem.expectedStatus = Number(args.expectedStatus);
        if (args.overrides) caseItem.request = applyRequestPatch(caseItem.request, args.overrides);
        caseItem.updatedAt = Date.now();
        await store.putCase(caseItem);
        return {
          created: true,
          case: {
            id: caseItem.id,
            name: caseItem.name,
            group: caseItem.group,
            requestId: caseItem.requestId,
            expectedStatus: caseItem.expectedStatus ?? null,
            request: presentRequest(caseItem.request),
          },
        };
      });
    },
  });

  write({
    name: "reqora_update_case",
    title: "修改用例",
    description: "修改用例的名称、分组、启用状态、期望状态码或请求覆盖项。需要 --allow-write。",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "用例 id 或名称" },
        name: { type: "string" },
        group: { type: "string" },
        enabled: { type: "boolean" },
        description: { type: "string" },
        expectedStatus: { type: "number" },
        overrides: { type: "object" },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    handler: async (args) => {      return withSnapshot(async (snapshot) => {
        const caseItem = refSearch(snapshot.cases ?? [], args.ref, (item) => `${item.group} ${item.name}`);
        const next = { ...caseItem, request: { ...caseItem.request } };
        if (args.name !== undefined) next.name = String(args.name);
        if (args.group !== undefined && CASE_GROUPS.includes(args.group)) next.group = args.group;
        if (args.enabled !== undefined) next.enabled = Boolean(args.enabled);
        if (args.description !== undefined) next.description = String(args.description);
        if (args.expectedStatus !== undefined) next.expectedStatus = Number(args.expectedStatus);
        if (args.overrides) next.request = applyRequestPatch(next.request, args.overrides);
        next.updatedAt = Date.now();
        await store.putCase(next);
        return { updated: true, case: { id: next.id, name: next.name, group: next.group, enabled: next.enabled !== false } };
      });
    },
  });

  write({
    name: "reqora_create_scenario",
    title: "新建场景",
    description:
      "创建跨接口测试场景。步骤可引用用例、内联请求或等待，并支持提取变量、条件门、循环与失败继续。需要 --allow-write。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        steps: {
          type: "array",
          description:
            "步骤数组。每项：{caseRef?|requestRef?|waitMs?, name?, enabled?, continueOnFailure?, extracts?:[{varName,source,path}], condition?:{varName,op,value}, repeat?:{count?|over?,itemVar?,indexVar?}}",
          items: { type: "object" },
        },
      },
      required: ["name", "steps"],
      additionalProperties: false,
    },
    handler: async (args) => {      return withSnapshot(async (snapshot) => {
        const scenario = newScenario(args.name);
        scenario.description = args.description ?? "";
        scenario.steps = (args.steps ?? []).map((entry) => stepFromSpec(snapshot, entry));
        scenario.updatedAt = Date.now();
        await store.putScenario(scenario);
        return {
          created: true,
          scenario: { id: scenario.id, name: scenario.name, steps: scenario.steps.length },
        };
      });
    },
  });

  write({
    name: "reqora_update_scenario",
    title: "修改场景",
    description: "改名 / 改描述 / 追加步骤（appendSteps 与 create_scenario 的 steps 同构），或整体替换步骤（steps）。需要 --allow-write。",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        appendSteps: { type: "array", items: { type: "object" } },
        steps: { type: "array", items: { type: "object" }, description: "整体替换步骤" },
      },
      required: ["ref"],
      additionalProperties: false,
    },
    handler: async (args) => {      return withSnapshot(async (snapshot) => {
        const existing = refSearch(snapshot.scenarios ?? [], args.ref, (item) => item.name);
        const next = { ...existing, steps: [...(existing.steps ?? [])] };
        if (args.name !== undefined) next.name = String(args.name);
        if (args.description !== undefined) next.description = String(args.description);
        if (args.steps) {
          next.steps = args.steps.map((entry) => stepFromSpec(snapshot, entry));
        }
        if (args.appendSteps) {
          next.steps = [
            ...next.steps,
            ...args.appendSteps.map((entry) => stepFromSpec(snapshot, entry)),
          ];
        }
        next.updatedAt = Date.now();
        await store.putScenario(next);
        return { updated: true, scenario: { id: next.id, name: next.name, steps: next.steps.length } };
      });
    },
  });

  // --------------------------------------------- evidence chain (read-only) --
  // Four tools make failures attributable to an agent without granting write
  // access. They read the same reqora.run.v1 files that CI commits.

  read({
    name: "reqora_list_runs",
    title: "列出运行证据",
    description:
      "列出本机 reqora.run.v1 证据文件（最近 N 次）：通过/失败/跳过、证据路径、通过率趋势与失败步骤频次。只读，无需 --allow-write。",
    inputSchema: {
      type: "object",
      properties: {
        subjectId: { type: "string", description: "按用例 / 场景 / 套件 id 过滤" },
        limit: { type: "number", description: "最多返回几条，默认 20" },
        evidenceDir: { type: "string", description: "覆盖默认证据目录（也可设 REQORA_EVIDENCE_DIR）" },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const runs = await readRuns(args.evidenceDir);
      const evidences = runs.map((item) => item.evidence);
      const history = buildHistory(runs);
      return {
        total: history.length,
        runs: queryHistory(history, {
          subjectId: args.subjectId,
          limit: clampLimit(args.limit, 20),
        }),
        pass_rate_trend: passRateTrend(history),
        failure_frequency: failureFrequency(evidences),
      };
    },
  });

  read({
    name: "reqora_get_evidence",
    title: "读取运行证据",
    description:
      "按 run_id 或文件路径读取完整 reqora.run.v1 证据：逐步断言、四段计时、提取的变量名、跳过原因、失败分类与 baseline diff。默认返回最近一次运行。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        path: { type: "string", description: "证据 JSON 的绝对路径" },
        evidenceDir: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const found = await findRun(args);
      return { path: found.path, evidence: found.evidence };
    },
  });

  read({
    name: "reqora_diff_runs",
    title: "比对两次运行",
    description:
      "把一次运行与基线证据比对，输出新增失败 / 已修复 / 波动（flaky）/ 契约漂移（字段消失、类型变化、新增必填），并定位到具体步骤与断言。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        path: { type: "string" },
        baselineRunId: { type: "string" },
        baselinePath: { type: "string" },
        evidenceDir: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const current = await findRun(args);
      let previous;
      if (args.baselinePath || args.baselineRunId) {
        previous = await findRun({
          path: args.baselinePath,
          runId: args.baselineRunId,
          evidenceDir: args.evidenceDir,
        });
      } else {
        const runs = await readRuns(args.evidenceDir);
        const index = runs.findIndex((item) => item.path === current.path);
        previous = index > 0 ? runs[index - 1] : null;
      }
      if (!previous) throw new Error("找不到基线证据；请用 baselinePath / baselineRunId 指定");
      return {
        run_id: current.evidence.run_id,
        baseline_run_id: previous.evidence.run_id,
        diff: diffEvidence(current.evidence, previous.evidence),
      };
    },
  });

  read({
    name: "reqora_explain_failure",
    title: "解释失败原因",
    description:
      "面向 agent 的失败归因：指出第几步、哪条断言失败、失败分类（断言 / 异常 / 网络）、错误文本，以及基线里新增的失败与契约漂移。跳过步骤单独列出，不计入通过。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        path: { type: "string" },
        evidenceDir: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const found = await findRun(args);
      return { run_id: found.evidence.run_id, path: found.path, ...explainFailure(found.evidence) };
    },
  });

  // ------------------------------------------------------------- router ----

  const toolIndex = new Map(tools.map((tool) => [tool.name, tool]));

  function listTools() {
    return tools
      .filter((tool) => !tool.write || allowWrite)
      .map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: !tool.write,
          destructiveHint: tool.write && /delete/.test(tool.name),
          idempotentHint: !tool.write,
          openWorldHint: !tool.write,
        },
      }));
  }

  async function callTool(name, args) {
    const tool = toolIndex.get(name);
    if (!tool) throw new Error(`未知工具：${name}`);
    if (tool.write && !allowWrite) {
      throw new Error(`工具 ${name} 需要 --allow-write 才能使用`);
    }
    const raw = await tool.handler(args ?? {});
    // Execution tools land the same reqora.run.v1 document as the CLI, so the
    // four read-only evidence tools have something to read right after a run.
    if (["reqora_run_cases", "reqora_run_scenario", "reqora_run_suite"].includes(name) && raw && typeof raw === "object") {
      const emitted = emitRunEvidence(name, raw);
      if (emitted) raw.evidence = emitted;
    }
    // Last line of defence, in two layers: maskDeep applies the general
    // credential policy, then enforcePrivate removes any value the user has
    // explicitly marked 私密 — even when the server runs with revealSecrets.
    const payload = maskDeep(raw, revealFor(args));
    return enforcePrivate(payload, await currentPrivate());
  }

  async function listResources() {
    const snapshot = await store.readSnapshot();
    const resources = [];
    for (const { request, collection } of allRequests(snapshot)) {
      resources.push({
        uri: `reqora://request/${request.id}`,
        name: `${request.method} ${request.name}`,
        title: `${collection.name} / ${request.name}`,
        mimeType: "application/json",
        description: `${request.method} ${request.url}`,
      });
    }
    for (const caseItem of snapshot.cases ?? []) {
      resources.push({
        uri: `reqora://case/${caseItem.id}`,
        name: caseItem.name,
        title: `用例 · ${caseItem.name}`,
        mimeType: "application/json",
        description: `分组 ${caseItem.group}`,
      });
    }
    for (const scenario of snapshot.scenarios ?? []) {
      resources.push({
        uri: `reqora://scenario/${scenario.id}`,
        name: scenario.name,
        title: `场景 · ${scenario.name}`,
        mimeType: "application/json",
        description: `${(scenario.steps ?? []).length} 步`,
      });
    }
    return enforcePrivate(
      maskDeep(resources.slice(0, 500), defaultReveal),
      privateOf(snapshot),
    );
  }

  async function readResource(uri) {
    const match = /^reqora:\/\/(request|case|scenario)\/(.+)$/.exec(uri ?? "");
    if (!match) throw new Error(`不支持的资源地址：${uri}`);
    const [, kind, id] = match;
    const snapshot = await store.readSnapshot();
    let payload;
    if (kind === "request") {
      const { request, collection } = findRequest(snapshot, id);
      payload = { kind, collection: collection.name, request: presentRequest(request, { reveal: defaultReveal }) };
    } else if (kind === "case") {
      const caseItem = (snapshot.cases ?? []).find((item) => item.id === id);
      if (!caseItem) throw new Error(`找不到用例 ${id}`);
      payload = { kind, case: { ...caseItem, request: presentRequest(caseItem.request, { reveal: defaultReveal }) } };
    } else {
      const scenario = (snapshot.scenarios ?? []).find((item) => item.id === id);
      if (!scenario) throw new Error(`找不到场景 ${id}`);
      payload = { kind, scenario: maskDeep(scenario, defaultReveal) };
    }
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(
            enforcePrivate(maskDeep(payload, defaultReveal), privateOf(snapshot)),
            null,
            2,
          ),
        },
      ],
    };
  }

  /** Handle one JSON-RPC message; returns the response object or null (notification). */
  async function handle(message) {
    const { id, method } = message ?? {};
    const isNotification = id === undefined || id === null;
    try {
      switch (method) {
        case "initialize": {
          const requested = message.params?.protocolVersion;
          const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL;
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion,
              capabilities: {
                tools: { listChanged: false },
                resources: { listChanged: false, subscribe: false },
              },
              serverInfo: SERVER_INFO,
              instructions: INSTRUCTIONS,
            },
          };
        }
        case "notifications/initialized":
        case "notifications/cancelled":
          return null;
        case "ping":
          return { jsonrpc: "2.0", id, result: {} };
        case "tools/list":
          return { jsonrpc: "2.0", id, result: { tools: listTools() } };
        case "tools/call": {
          const name = message.params?.name;
          try {
            const payload = await callTool(name, message.params?.arguments);
            return { jsonrpc: "2.0", id, result: j(payload) };
          } catch (error) {
            const raw = error?.message ?? String(error);
            log.error("tool.failed", raw, { tool: name });
            return {
              jsonrpc: "2.0",
              id,
              result: fail(explainToolFailure(error, name, log.path)),
            };
          }
        }
        case "resources/list":
          return { jsonrpc: "2.0", id, result: { resources: await listResources() } };
        case "resources/read":
          return { jsonrpc: "2.0", id, result: await readResource(message.params?.uri) };
        case "resources/templates/list":
          return {
            jsonrpc: "2.0",
            id,
            result: {
              resourceTemplates: [
                {
                  uriTemplate: "reqora://request/{id}",
                  name: "接口详情",
                  mimeType: "application/json",
                },
                { uriTemplate: "reqora://case/{id}", name: "用例详情", mimeType: "application/json" },
                {
                  uriTemplate: "reqora://scenario/{id}",
                  name: "场景详情",
                  mimeType: "application/json",
                },
              ],
            },
          };
        case "prompts/list":
          return { jsonrpc: "2.0", id, result: { prompts: [] } };
        default:
          if (isNotification) return null;
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `不支持的方法：${method}` },
          };
      }
    } catch (error) {
      if (isNotification) return null;
      const raw = error?.message ?? String(error);
      log.error("handler.failed", raw, { method });
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: explainToolFailure(error, method, log.path),
        },
      };
    }
  }

  // Fail fast if the tool catalog and the shared counts ever drift apart.
  const writeTools = tools.filter((tool) => tool.write);
  if (tools.length !== MCP_TOOL_SUMMARY.total || writeTools.length !== MCP_TOOL_SUMMARY.write) {
    throw new Error(
      `MCP 工具目录与 mcpToolCatalog 不一致：注册 ${tools.length} 个（写 ${writeTools.length} 个），` +
        `声明 ${MCP_TOOL_SUMMARY.total} 个（写 ${MCP_TOOL_SUMMARY.write} 个）`,
    );
  }
  if (MCP_WRITE_TOOL_NAMES.some((name) => !toolIndex.get(name)?.write)) {
    throw new Error("MCP 写工具名单与注册结果不一致");
  }
  return { handle, listTools, callTool, toolCount: tools.length };
}
