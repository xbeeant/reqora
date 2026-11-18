import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  BenchmarkReport,
  BodyInfo,
  BodyLines,
  BodySlice,
  DbQueryResult,
  GrpcFileRef,
  GrpcInvokeResult,
  GrpcInvokeSpec,
  GrpcSchema,
  GrpcStreamSpec,
  GrpcTlsOptions,
  HistoryListQuery,
  HistoryRunPage,
  HistoryRunRecord,
  HistoryRunSummary,
  HistoryStats,
  McpCallOutcome,
  McpConnectResult,
  McpServerConfig,
  MockRule,
  MockStartInfo,
  MockStatus,
  TcpDebugResult,
  TcpDebugSpec,
  RequestDraft,
  ProjectsState,
  ResponseData,
  RuntimeInfo,
  SseMessage,
  StoredCookie,
  WorkspaceSettings,
  WorkspaceSnapshot,
  WsClientMessage,
  UpdateCheckResult,
} from "../types";
import { t } from "../i18n/index.ts";
import { toWireSpec } from "./wireSpec.ts";
import type { GitSyncActionResult, GitSyncFileSet, GitSyncStatus } from "./gitNative.ts";

export interface ErrorEnvelope {
  code: string;
  message: string;
  requestId: string;
  retryable: boolean;
}

/** Shared optimistic-lock counter of the project's workspace.db. */
export interface WorkspaceRevInfo {
  rev: number;
  writer: string;
  updatedAt: number;
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly retryable: boolean;

  constructor(payload: ErrorEnvelope) {
    super(payload.message);
    this.name = "ApiClientError";
    this.code = payload.code;
    this.requestId = payload.requestId;
    this.retryable = payload.retryable;
  }
}

function friendly(raw: string): string {
  if (/lookup|dns|name resolution|nodename/i.test(raw)) {
    return t("cloud.api.dnsFailed");
  }
  if (/connection refused|actively refused/i.test(raw)) {
    return t("cloud.api.connectionRefused");
  }
  if (/timed?\s?out|timeout/i.test(raw)) {
    return t("cloud.api.timeout");
  }
  if (/certificate|tls|ssl/i.test(raw)) {
    return t("cloud.api.tlsFailed");
  }
  return t("cloud.api.callFailed", { raw });
}

function normalize(error: unknown): ApiClientError {
  if (error instanceof ApiClientError) return error;

  if (typeof error === "object" && error !== null) {
    const candidate = error as Record<string, unknown>;
    if (
      typeof candidate.code === "string" &&
      typeof candidate.message === "string"
    ) {
      return new ApiClientError({
        code: candidate.code,
        message: candidate.message,
        requestId:
          typeof candidate.requestId === "string" ? candidate.requestId : "-",
        retryable: candidate.retryable === true,
      });
    }
  }

  const raw =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : t("cloud.api.unknownError");
  return new ApiClientError({
    code: "UNKNOWN",
    message: friendly(raw),
    requestId: "-",
    retryable: false,
  });
}

/**
 * Commands whose own failure must not be appended again — otherwise a broken
 * log would recursively log its own failure forever.
 */
const ERROR_LOG_COMMANDS = new Set(["append_error_log"]);

/**
 * Every failed IPC call leaves a line in ~/.reqora/logs/errors.log. Installed
 * builds have no visible stdout/WebView console, so without this a user who
 * sees "写数据失败：无权限" has nothing to inspect or send to support. The
 * write is fire-and-forget and must never replace or delay the real error.
 */
function recordIpcError(command: string, error: ApiClientError, cause: unknown): void {
  // Keep the original backend text too: `friendly()` may reword an IPC error
  // for the toast, while the log needs the literal SQLite / OS message.
  const raw =
    typeof cause === "string"
      ? cause
      : cause instanceof Error
        ? cause.message
        : typeof cause === "object" && cause !== null && "message" in cause
          ? String((cause as { message: unknown }).message ?? "")
          : "";
  const entry = JSON.stringify({
    at: Date.now(),
    source: "desktop",
    command,
    code: error.code,
    requestId: error.requestId,
    message: error.message,
    ...(raw && raw !== error.message ? { raw } : {}),
  });
  // Direct invoke (not `call`) keeps this path free of recursion.
  void invoke<string>("append_error_log", { entry }).catch(() => {});
}

/** Single typed boundary for all Tauri commands. */
async function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    const normalized = normalize(error);
    if (!ERROR_LOG_COMMANDS.has(command)) recordIpcError(command, normalized, error);
    throw normalized;
  }
}

export const api = {
  // ---- OAuth 2.0 / MQTT / gRPC streaming ----
  oauth2Authorize: (config: unknown) =>
    call<Record<string, unknown>>("oauth2_authorize", { config }),
  mqttConnect: (
    spec: unknown,
    sessionId: string,
    onMessage: (message: unknown) => void,
  ) => {
    const channel = new Channel<unknown>();
    channel.onmessage = onMessage;
    return call<void>("mqtt_connect", { spec, sessionId, channel });
  },
  mqttSubscribe: (sessionId: string, topics: Array<{ topic: string; qos: number }>) =>
    call<void>("mqtt_subscribe", { sessionId, topics }),
  mqttUnsubscribe: (sessionId: string, topics: string[]) =>
    call<void>("mqtt_unsubscribe", { sessionId, topics }),
  mqttPublish: (
    sessionId: string,
    topic: string,
    payload: string,
    qos: number,
    retain: boolean,
  ) => call<void>("mqtt_publish", { sessionId, topic, payload, qos, retain }),
  mqttDisconnect: (sessionId: string) =>
    call<void>("mqtt_disconnect", { sessionId }),
  grpcStreamStart: (
    spec: GrpcStreamSpec,
    sessionId: string,
    onMessage: (message: unknown) => void,
  ) => {
    const channel = new Channel<unknown>();
    channel.onmessage = onMessage;
    return call<void>("grpc_stream_start", { spec, sessionId, channel });
  },
  grpcStreamSend: (sessionId: string, messageJson: string) =>
    call<void>("grpc_stream_send", { sessionId, messageJson }),
  grpcStreamClose: (sessionId: string) =>
    call<void>("grpc_stream_close", { sessionId }),
  grpcStreamCancel: (sessionId: string) =>
    call<void>("grpc_stream_cancel", { sessionId }),
  // ---- 本地加密执行历史 ----
  // 单独的 ~/.reqora/history.db；记录含完整响应，只在 Rust 边界加密后落盘，
  // 不进入工作区快照，因此不会被云同步 / git 镜像 / 导出带走。
  historyAppend: (record: HistoryRunRecord) =>
    call<HistoryRunSummary>("history_append", { record }),
  // One keyset page at a time. Rust decrypts only that page's small summary
  // envelopes, so the full response bodies are never read while scrolling.
  historyList: (query: HistoryListQuery = {}) =>
    call<HistoryRunPage>("history_list", {
      scope: query.scope ?? "project",
      projectId: query.projectId ?? null,
      kind: query.kind ?? null,
      search: query.search ?? null,
      limit: query.limit ?? 30,
      cursor: query.cursor ?? null,
    }),
  historyGet: (runId: string) => call<HistoryRunRecord>("history_get", { runId }),
  historyDelete: (runId: string) => call<void>("history_delete", { runId }),
  historyClear: (scope: "project" | "all", projectId: string | null) =>
    call<number>("history_clear", { scope, projectId }),
  historyStats: () => call<HistoryStats>("history_stats"),
  runtimeInfo: () => call<RuntimeInfo>("get_runtime_info"),
  loadWorkspace: () => call<WorkspaceSnapshot>("load_workspace"),
  loadWorkspaceRev: () => call<WorkspaceRevInfo>("load_workspace_rev"),
  /** External incremental refresh: only the entity rows changed since
   * `fromRev`, assembled into ready-to-merge entries. `reset: true` means a
   * full reload is required. */
  loadWorkspaceDelta: (fromRev: number) =>
    call<import("../store/workspace/externalMerge.ts").ExternalDeltaPayload>(
      "load_workspace_delta",
      { fromRev },
    ),
  /** 按需读取单个实体的完整详情（密钥已解密），供详情缓存 / 懒加载使用。 */
  getEntity: (kind: string, id: string) =>
    call<Record<string, unknown>>("get_entity", { kind, id }),
  /** User-readable error log, shared with the MCP service's logs directory. */
  errorLogPath: () => call<string>("error_log_path"),
  readErrorLog: (limit = 100) =>
    call<{ path: string; lines: string[] }>("read_error_log", { limit }),
  /** Auto-save with optimistic locking. Omit `expectedRev` for unchecked
   * writes (import, project switch, seed); pass the revision read at load
   * time to detect out-of-process MCP / CLI writes, or `force: true` after
   * taking a backup to overwrite them explicitly. */
  saveWorkspace: (
    snapshot: WorkspaceSnapshot,
    options?: { expectedRev?: number | null; force?: boolean },
  ) =>
    call<WorkspaceRevInfo>("save_workspace", {
      snapshot,
      expectedRev: options?.expectedRev ?? null,
      force: options?.force ?? false,
    }),
  /** Row-level incremental auto-save: only the rows the edit touched. Same
   * CAS / conflict semantics as `saveWorkspace`, payload proportional to the
   * edit instead of the workspace size. */
  saveWorkspaceRows: (
    delta: import("./workspaceRows.ts").WorkspaceDeltaPayload,
    options?: { expectedRev?: number | null },
  ) =>
    call<WorkspaceRevInfo>("save_workspace_rows", {
      delta,
      expectedRev: options?.expectedRev ?? null,
    }),
  backupWorkspace: (reason: string) => call<string>("backup_workspace", { reason }),
  resetWorkspace: () => call<WorkspaceSnapshot>("reset_workspace"),
  // ---- Sync baseline (persisted in the project's SQLite, not WebView cache) ----
  loadSyncBaseline: (projectKey: string) =>
    call<unknown>("load_sync_baseline", { projectKey }),
  saveSyncBaseline: (projectKey: string, payload: unknown) =>
    call<void>("save_sync_baseline", { projectKey, payload }),
  clearSyncBaseline: (projectKey: string) =>
    call<void>("clear_sync_baseline", { projectKey }),
  clearAllSyncBaselines: () => call<void>("clear_all_sync_baselines"),
  // ---- Local projects & data root ----
  listProjects: () => call<ProjectsState>("list_projects"),
  createProject: (name: string) => call<ProjectsState>("create_project", { name }),
  switchProject: (id: string) => call<ProjectsState>("switch_project", { id }),
  renameProject: (id: string, name: string) =>
    call<ProjectsState>("rename_project", { id, name }),
  setDataRoot: (root: string | null) => call<ProjectsState>("set_data_root", { root }),
  pickDirectory: () => call<string | null>("pick_directory"),
  cancelStream: (requestId: string) =>
    call<void>("cancel_stream", { requestId }),
  // ---- WebSocket ----
  wsConnect: (
    request: RequestDraft,
    options: SendOptions,
    sessionId: string,
    onMessage: (message: WsClientMessage) => void,
  ) => {
    const channel = new Channel<WsClientMessage>();
    channel.onmessage = onMessage;
    return call<void>("ws_connect", {
      spec: toSpec(request, options),
      sessionId,
      channel,
    });
  },
  wsSend: (sessionId: string, message: string) =>
    call<number>("ws_send", { sessionId, message }),
  wsClose: (sessionId: string) => call<void>("ws_close", { sessionId }),
  // ---- TCP raw socket ----
  tcpDebug: (spec: TcpDebugSpec) => call<TcpDebugResult>("tcp_debug", { spec }),
  // ---- Mock server ----
  mockStart: (port: number, rules: MockRule[]) =>
    call<MockStartInfo>("mock_start", { port, rules }),
  mockStop: () => call<void>("mock_stop"),
  mockStatus: () => call<MockStatus>("mock_status"),
  // ---- Cookie jar ----
  cookieList: () => call<StoredCookie[]>("cookie_list"),
  cookieClear: () => call<void>("cookie_clear"),
  benchmarkRun: (
    request: RequestDraft,
    options: SendOptions,
    total: number,
    concurrency: number,
  ) =>
    call<BenchmarkReport>("benchmark_run", {
      spec: toSpec(request, options),
      total,
      concurrency,
    }),
  // ---- Files (import / export) ----
  pickAndReadText: () => call<{ name: string; content: string }>("pick_and_read_text"),
  pickProtoFiles: () => call<GrpcFileRef[]>("pick_proto_files"),
  saveTextFile: (fileName: string, contents: string) =>
    call<string>("save_text_file", { fileName, contents }),
  // ---- Git-native sync (user-picked directory only; paths validated in Rust) ----
  gitSyncReadFiles: (dir: string) =>
    call<GitSyncFileSet>("git_sync_read_files", { dir }),
  gitSyncWriteFiles: (dir: string, files: GitSyncFileSet) =>
    call<string[]>("git_sync_write_files", { dir, files }),
  gitSyncStatus: (dir: string) => call<GitSyncStatus>("git_sync_status", { dir }),
  gitSyncRun: (
    dir: string,
    action: "init" | "pull" | "commit" | "push",
    message?: string,
  ) => call<GitSyncActionResult>("git_sync_run", { dir, action, message: message ?? null }),
  /** Binary-safe copy of a spooled response body into a user-chosen file. */
  saveResponseBody: (bodyId: string, fileName: string) =>
    call<{ path: string; size: number }>("save_response_body", { bodyId, fileName }),
  // ---- MCP (Model Context Protocol) ----
  mcpConnect: (config: McpServerConfig) =>
    call<McpConnectResult>("mcp_connect", { config }),
  mcpDisconnect: (name: string) => call<boolean>("mcp_disconnect", { name }),
  mcpCall: (name: string, tool: string, args: Record<string, unknown>) =>
    call<McpCallOutcome>("mcp_call", { name, tool, arguments: args }),
  // ---- External URL launcher ----
  openUrl: (url: string) => call<void>("open_url", { url }),
  // ---- Update check ----
  /** 不传 endpoint 时使用服务端配置的 REQORA_UPDATE_MANIFEST_URL。 */
  checkUpdate: (endpoint?: string) =>
    call<UpdateCheckResult>("check_update", { endpoint: endpoint ?? null }),
  // ---- AI (OpenAI-compatible) ----
  grpcCompile: (files: GrpcFileRef[]) => call<GrpcSchema>("grpc_compile", { files }),
  grpcReflect: (address: string, tls?: GrpcTlsOptions) =>
    call<GrpcSchema>("grpc_reflect", {
      address,
      headers: {},
      timeoutMs: 15000,
      verifyTls: tls?.verifyTls ?? true,
      caPem: tls?.caPem || null,
    }),
  dbQuery: (spec: { url: string; sql: string; mode: "query" | "execute"; maxRows?: number }) =>
    call<DbQueryResult>("db_query", { spec }),
  grpcInvoke: (spec: GrpcInvokeSpec) => call<GrpcInvokeResult>("grpc_invoke", { spec }),
  // ---- App-level config (~/.reqora/config.json, consumed by lib/appConfig.ts) ----
  loadAppConfig: () => call<string | null>("load_app_config", {}),
  saveAppConfig: (json: string) => call<void>("save_app_config", { json }),
  // Snapshot storage cap sync (Settings → local SQLite layer; callers treat
  // failures as best-effort, e.g. browser/test environments without Tauri).
  setWorkspaceLimit: (limit: number) => call<void>("set_workspace_limit", { limit }),
  aiChat: (input: { baseUrl: string; apiKey: string; model: string; system: string; user: string }) =>
    call<string>("ai_chat", {
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      system: input.system,
      user: input.user,
    }),
  // ---- Spilled response bodies: chunked reads for the virtual code view ----
  readResponseBody: (bodyId: string, offset: number, length: number) =>
    call<BodySlice>("read_response_body", { bodyId, offset, length }),
  readResponseLines: (bodyId: string, startLine: number, lineCount: number) =>
    call<BodyLines>("read_response_lines", { bodyId, startLine, lineCount }),
  responseBodyInfo: (bodyId: string) =>
    call<BodyInfo | null>("response_body_info", { bodyId }),
  releaseResponseBody: (bodyId: string) =>
    call<void>("release_response_body", { bodyId }),
};


export interface SendOptions {
  variables: Record<string, string>;
  settings: WorkspaceSettings;
  signal?: AbortSignal;
}

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_ATTEMPTS = 3;

function abortError(): DOMException {
  return new DOMException(t("cloud.api.cancelled"), "AbortError");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scripts and declarative assertions are frontend-only concerns: they run in
 * the WebView before/after the call. Build the IPC payload explicitly so the
 * Rust RequestSpec stays the network-only DTO it was designed to be.
 */
function toSpec(request: RequestDraft, options: SendOptions) {
  // The wire contract is shared with the CLI / MCP sidecar so a collection
  // cannot behave differently in CI. See src/lib/wireSpec.ts.
  return toWireSpec(request, options);
}

/**
 * Only idempotent methods are auto-retried (up to 3 attempts with backoff).
 * Replaying a POST/PUT could duplicate a side effect, so those surface the
 * error immediately and let the user decide. HTTP 4xx/5xx are real responses,
 * never exceptions — they are displayed, not retried.
 */
export async function sendRequest(
  request: RequestDraft,
  options: SendOptions,
): Promise<ResponseData> {
  const spec = toSpec(request, options);
  const attempts = IDEMPOTENT_METHODS.has(request.method) ? MAX_ATTEMPTS : 1;
  let lastError: ApiClientError | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) throw abortError();
    try {
      const result = await call<ResponseData>("send_request", { spec });
      if (options.signal?.aborted) throw abortError();
      return result;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      lastError = normalize(error);
      if (!lastError.retryable || attempt === attempts - 1) throw lastError;
      await sleep(250 * 2 ** attempt);
    }
  }

  throw (
    lastError ??
    new ApiClientError({
      code: "UNKNOWN",
      message: t("cloud.api.requestFailed"),
      requestId: "-",
      retryable: false,
    })
  );
}

export interface StreamOptions extends SendOptions {
  requestId: string;
  onMessage: (message: SseMessage) => void;
}

/**
 * Opens the request on Rust's streaming channel. Headers decide whether the
 * body is parsed into SSE frames or buffered as a normal response, so the
 * frontend never needs to guess the content type in advance.
 */
export async function streamRequest(
  request: RequestDraft,
  options: StreamOptions,
): Promise<void> {
  const channel = new Channel<SseMessage>();
  channel.onmessage = options.onMessage;
  if (options.signal?.aborted) throw abortError();
  await call<void>("stream_request", {
    spec: toSpec(request, options),
    requestId: options.requestId,
    channel,
  });
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
