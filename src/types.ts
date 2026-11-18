export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Request transport protocol. WS requests use ws:// or wss:// URLs. TCP uses host:port. */
export type RequestProtocol = "http" | "ws" | "tcp" | "mqtt" | "soap";

export interface KeyValue {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  /**
   * Upload-redaction override (tri-state):
   * `true` = never share this value, `false` = explicitly share it even when
   * the key looks sensitive, `undefined` = decide from the key name.
   * Only meaningful for variables / headers / query / form rows.
   */
  secret?: boolean;
}

export interface FormPart extends KeyValue {
  /** When true, `value` holds base64-encoded file bytes and `fileName` is the original name. */
  file?: boolean;
  /** Original file name; used as the multipart `filename` directive. */
  fileName?: string;
  /** Per-part Content-Type, mainly meaningful for file parts. */
  contentType?: string;
}

export interface NoneBody {
  type: "none";
}
export interface JsonBody {
  type: "json";
  content: string;
}
export interface RawBody {
  type: "raw";
  content: string;
  contentType: string;
}
export interface FormUrlEncodedBody {
  type: "formUrlEncoded";
  items: KeyValue[];
}
export interface FormDataBody {
  type: "formData";
  items: FormPart[];
}
export interface BinaryBody {
  type: "binary";
  /** base64 of the file bytes. */
  data: string;
  fileName: string;
  contentType: string;
}
export interface GraphQLBody {
  type: "graphql";
  query: string;
  variables: string;
}

export type BodySpec =
  | NoneBody
  | JsonBody
  | RawBody
  | FormUrlEncodedBody
  | FormDataBody
  | BinaryBody
  | GraphQLBody;

export type OAuth2Grant = "authorizationCode" | "clientCredentials" | "password" | "implicit";

export interface OAuth2Auth {
  type: "oauth2";
  grant: OAuth2Grant;
  authUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  audience?: string;
  redirectUri?: string;
  state?: string;
  username?: string;
  password?: string;
  pkce?: boolean;
  codeVerifier?: string;
  code?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: number;
  tokenPrefix?: string;
  clientAuth?: "body" | "basic";
}

export interface AwsSigV4Auth {
  type: "awsSigV4";
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
  signQuery?: boolean;
  expiresIn?: number;
  unsignedPayload?: boolean;
}

export interface MtlsAuth {
  type: "mtls";
  certPem?: string;
  keyPem?: string;
  caPem?: string;
  p12Base64?: string;
  passphrase?: string;
  minTlsVersion?: "1.2" | "1.3";
  serverName?: string;
}

export type HttpVersion = "auto" | "http1" | "http2" | "http3";

export type AuthSpec =
  | OAuth2Auth
  | AwsSigV4Auth
  | MtlsAuth
  | { type: "none" }
  /**
   * Frontend-only marker: use `Collection.auth` for this request. It MUST be
   * resolved by lib/auth.ts before a request reaches Rust — `RequestSpec.auth`
   * is an internally-tagged serde enum that rejects unknown variants.
   */
  | { type: "inherit" }
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | {
      type: "apiKey";
      key: string;
      value: string;
      location: "header" | "query";
    };

/** Declarative response checks. Evaluated after the post-response script. */
export interface AssertionSpec {
  id: string;
  enabled: boolean;
  name: string;
  source: "status" | "json" | "header" | "text" | "latency";
  path: string;
  op:
    | "eq"
    | "ne"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "contains"
    | "matches"
    | "exists";
  value: string;
}

export interface ScriptTest {
  name: string;
  ok: boolean;
  message: string;
  origin: "script" | "assertion";
}

export interface AssertionResult extends ScriptTest {
  source: string;
  path: string;
  op: string;
  expected: string;
  actual: string;
}

/** Everything the Script Logs / Tests / Assertions response tabs render. */
export interface ScriptOutcome {
  logs: string[];
  tests: ScriptTest[];
  mutations: string[];
  assertions: AssertionResult[];
  error: string | null;
  durationMs: number;
  preError: string | null;
}

export interface RequestDraft {
  id: string;
  name: string;
  description?: string;
  folder?: string;
  /** Transport protocol; defaults to "http" for legacy snapshots. */
  protocol?: RequestProtocol;
  httpVersion?: HttpVersion;
  mqtt?: MqttSpec;
  soap?: SoapSpec;
  method: HttpMethod;
  url: string;
  /**
   * Values for `:name` / `{name}` path variables in `url`. The keys are
   * derived from the URL at edit/render time; this list only persists the
   * values the user typed, so renaming a placeholder keeps the value when
   * the name matches again.
   */
  pathVariables?: KeyValue[];
  headers: KeyValue[];
  query: KeyValue[];
  body: BodySpec;
  auth: AuthSpec;
  /** Runs before the request is handed to Rust; may mutate headers/query/body/URL/variables. */
  preScript?: string;
  /** Runs against the redacted-in-memory response; may call test()/assert()/log(). */
  postScript?: string;
  assertions?: AssertionSpec[];
  /** How this request should be opened: auto-detect SSE, force streaming, or force buffered. */
  stream?: StreamMode;
  /** API documentation. A projection of this same request — never a second source of truth. */
  doc?: RequestDoc;
  /**
   * 行级同步版本：任何字段（含改名 / 移动 / 文档）变化都会刷新，用于 LWW。
   * 不要用它判断“用例是否过期”，那个语义属于 {@link contentUpdatedAt}。
   */
  updatedAt?: number;
  /**
   * 接口内容（方法 / URL / 参数 / 请求体 / 脚本 / 断言）最后修改时间。
   * 重命名、移动文件夹、编辑文档不刷新它，因此不会把用例误判成“接口已变更”。
   * 缺省时回退到 `updatedAt`，兼容旧快照。
   */
  contentUpdatedAt?: number;
}

// --------------------------------------------------- API documentation ----

/** Workspace-level reusable data model: a named JSON Schema document. */
export interface DataModel {
  id: string;
  name: string;
  description: string;
  /** JSON Schema (subset) source text. Refs may point at `model://<Name>`. */
  schemaText: string;
  updatedAt: number;
}

export type DocStatus = "开发中" | "联调中" | "已完成" | "已废弃";

/** Documentation-only metadata for one parameter row / body field. */
export interface ParamMeta {
  type: string;
  required: boolean;
  description: string;
  example: string;
}

/** Where a documented response parameter lives. */
export type ResponseParamLocation = "body" | "header";

/**
 * Documentation for ONE response field. Unlike request parameters (which are a
 * live projection of the request rows), response fields are hand-authored doc
 * increments: they can be seeded from a saved example body and then annotated
 * with type / required / example / description, one set per status example.
 */
export interface ResponseParam {
  id: string;
  /** Dotted JSON path for body fields (`data.list[0].id`), or header name. */
  name: string;
  location: ResponseParamLocation;
  type: string;
  required: boolean;
  example: string;
  description: string;
}

/** A saved response example, shown in the doc and used as the Mock template. */
export interface ResponseExample {
  id: string;
  name: string;
  status: number;
  contentType: string;
  body: string;
  description: string;
  /** Optional bound data model; validation/mock may derive the body from its schema. */
  modelId?: string;
  /** Per-example response field definitions (body fields + response headers). */
  params?: ResponseParam[];
}

/**
 * 保存响应示例的结果：
 * - `added`     新写入一条示例
 * - `duplicate` 数据与已有示例完全一致（状态码 + key/value 都相同），未新增
 * - `missing`   当前没有可用的响应
 */
export type SaveResponseExampleResult = "added" | "duplicate" | "missing";

export interface RequestDoc {
  /** One-line summary shown next to the interface name. */
  summary: string;
  /** Markdown body. Rendered without innerHTML. */
  description: string;
  owner: string;
  status: DocStatus;
  tags: string[];
  /** Doc increments keyed by `q:<rowId>` / `h:<rowId>` / `b:<jsonPath>`. */
  paramMeta: Record<string, ParamMeta>;
  responses: ResponseExample[];
  /** Optional data model bound to the request body (documentation + Mock derivation). */
  requestModelId?: string;
  updatedAt: number;
}

// ------------------------------------------------------------- cases ----

/** Apifox-style case grouping by test intent. */
export type CaseGroup = "正向" | "负向" | "边界值" | "安全性" | "其他";

export const CASE_GROUPS: CaseGroup[] = ["正向", "负向", "边界值", "安全性", "其他"];

export interface CaseRunResult {
  at: number;
  status: number | null;
  ok: boolean;
  timeMs: number;
  passed: number;
  failed: number;
  error?: string;
}

/**
 * One case = one scenario of an interface. It stores an editable snapshot of
 * the interface request plus test intent; `syncedAt` lets the UI hint when the
 * interface changed afterwards ("从接口同步" re-copies the request part).
 */
export interface ApiCase {
  id: string;
  requestId: string;
  name: string;
  group: CaseGroup;
  description?: string;
  enabled: boolean;
  /** Editable copy of the interface request at `syncedAt` time. */
  request: RequestDraft;
  expectedStatus?: number;
  syncedAt: number;
  createdAt: number;
  updatedAt: number;
  lastRun?: CaseRunResult;
  /** Full execution history, newest first (capped; see pushCaseRun). */
  runHistory?: CaseRunResult[];
}

/** Kinds of items that can occupy a centre tab. */
export type OpenTab =
  | { kind: "request"; id: string }
  | { kind: "case"; id: string }
  | { kind: "scenario"; id: string }
  | { kind: "suite"; id: string }
  /** Frozen snapshot of one execution-history run: display only, but sendable. */
  | { kind: "history"; id: string }
  /** Frozen snapshot of one saved request revision: display only, but sendable. */
  | { kind: "revision"; id: string };

// -------------------------------------------------------- suites ----

/** 套件成员：引用一个用例或一个场景。 */
export interface SuiteItem {
  id: string;
  kind: "case" | "scenario";
  refId: string;
}

/** 套件单个成员的运行结果（聚合自用例 lastRun 或场景 lastRun）。 */
export interface SuiteItemResult {
  itemId: string;
  kind: "case" | "scenario";
  refId: string;
  name: string;
  ok: boolean;
  skipped: boolean;
  passed: number;
  failed: number;
  timeMs: number;
  error?: string;
}

export interface SuiteRunSummary {
  at: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  timeMs: number;
  items: SuiteItemResult[];
}

/** 测试套件（P0-4）：把多个用例 / 场景组合成一次批量回归。 */
export interface TestSuite {
  id: string;
  name: string;
  description?: string;
  items: SuiteItem[];
  createdAt: number;
  updatedAt: number;
  lastRun?: SuiteRunSummary;
}

/** Apifox-style interface detail sub-tabs. */
export type DetailTab =
  | "docs"
  | "edit"
  | "debug"
  | "cases"
  | "mock"
  | "history"
  | "revisions"
  | "benchmark";

export interface ResponseHeader {
  name: string;
  value: string;
}

/** Per-phase timings measured on the real request path (Rust side). */
export interface ResponseTimings {
  dnsMs: number;
  /** TCP handshake; on HTTPS this also includes the TLS handshake. */
  tcpMs: number;
  tlsMs: number;
  /** True when the TLS handshake is folded into tcpMs. */
  tlsMerged: boolean;
  /** TTFB minus local connection work: server processing + network RTT. */
  serverMs: number;
  transferMs: number;
  totalMs: number;
  reused: boolean;
  protocol: string;
}

export interface ResponseData {
  requestId: string;
  status: number;
  statusText: string;
  ok: boolean;
  timeMs: number;
  size: number;
  url: string;
  resolvedUrl: string;
  missingVariables: string[];
  headers: ResponseHeader[];
  body: string;
  bodyKind: "json" | "text" | "binary" | "empty";
  truncated: boolean;
  /** Absent on SSE / streamed responses, which are assembled on the frontend. */
  timings?: ResponseTimings;
  /** Request line + headers + body, as handed to reqwest. */
  rawRequest?: string;
  /** Status line + headers + body, as received. */
  rawResponse?: string;
  /** Spill id on disk used by the read_response_* commands. */
  bodyRef?: string;
  /** Raw decoded bytes covered by `body` (the inline preview). */
  inlineBytes?: number;
  /** Exact line count of the decoded body, split on newlines (at least 1). */
  totalLines?: number;
  /** Applied decoding chain, e.g. "gzip, br"; omitted when nothing was decoded. */
  contentEncoding?: string;
}

/** A byte slice of a spilled body returned by `read_response_body`. */
export interface BodySlice {
  bodyId: string;
  offset: number;
  length: number;
  total: number;
  encoding: "utf8" | "base64";
  data: string;
}

/** A window of decoded lines returned by `read_response_lines` (0-based). */
export interface BodyLines {
  bodyId: string;
  startLine: number;
  lineCount: number;
  totalLines: number;
  lines: string[];
}

/** Metadata for a spilled body; `null` when the id was already evicted. */
export interface BodyInfo {
  bodyId: string;
  size: number;
  totalLines: number;
  bodyKind: ResponseData["bodyKind"];
  contentEncoding?: string;
}

/** Outcome of a "send and download" run: the full body written to a local file. */
export interface DownloadResult {
  fileName: string;
  path: string;
  size: number;
}

export interface Collection {
  id: string;
  name: string;
  items: RequestDraft[];
  /**
   * 显式创建的（可能为空的）文件夹路径，如 ["用户", "用户/订单"]。文件夹
   * 主要仍由 `RequestDraft.folder` 路径派生；这里只登记「尚无接口的空文件夹」，
   * 让「新建文件夹」无需先建接口。含接口的文件夹不依赖此列表（列表里多留
   * 一份无害，删除文件夹时会一并清理）。
   */
  folders?: string[];
  /**
   * 行级同步的合并依据；由同步层在写回时维护，编辑操作可缺省
   * （拆行时以当前时间兑底，首次同步后即稳定）。
   */
  updatedAt?: number;
  /**
   * Shared auth for requests whose `auth.type === "inherit"`. Optional for
   * backwards compatibility with every existing snapshot. `inherit` is not a
   * valid value here — a collection has no parent to inherit from.
   */
  auth?: AuthSpec;
}

export interface Environment {
  id: string;
  name: string;
  variables: KeyValue[];
  /** 环境级全局 Header：对该环境下所有请求自动生效，请求内同名头优先。 */
  headers?: KeyValue[];
  /** 行级同步的合并依据；由同步层维护，可缺省。 */
  updatedAt?: number;
}

export interface HistoryEntry {
  id: string;
  at: number;
  name: string;
  method: HttpMethod;
  url: string;
  status: number | null;
  timeMs: number;
  error?: string;
  request: RequestDraft;
}

// ------------------------------------------------------- 执行历史 ----
//
// 与上面的 `HistoryEntry`（工作区快照里的轻量「请求草稿」历史）不同，下面的
// 类型是「历史」菜单的统一执行历史：接口直发 / 用例运行 / 场景运行 / 压测
// 都写入一个独立的、本地加密的 SQLite 数据库，包含完整响应信息。它不进入
// 工作区快照，因此永不参与云同步、git 镜像或导出。

/** 统一执行历史的四种主体。 */
export type HistoryRunKind = "api" | "case" | "scenario" | "benchmark";

/** 列表摘要：Rust 侧解密 envelope 后返回，不落任何明文描述列。 */
export interface HistoryRunSummary {
  id: string;
  kind: HistoryRunKind;
  at: number;
  projectId: string;
  projectName: string;
  subjectId: string;
  subjectName: string;
  name: string;
  method: string;
  url: string;
  ok: boolean;
  status: number | null;
  timeMs: number;
  size: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  error: string;
  stepCount: number;
  /** 压测专属：列表直接显示吞吐与 P95，无需再解密详情。 */
  rps?: number;
  p95Ms?: number;
}

/**
 * 压测执行快照。Rust 侧并发引擎只产出聚合报告（状态分布、延迟分位、
 * 错误样本），刻意不保留逐请求的 headers / body，所以这里记录聚合结果
 * 与压测参数，而不是伪造一份单次响应。
 */
export interface BenchmarkHistorySnapshot {
  total: number;
  concurrency: number;
  /** IPC 抛错或压测未返回报告时为 null。 */
  report: BenchmarkReport | null;
}

/** 场景里的一个折叠步骤及其响应。循环步骤可带多份迭代响应。 */
export interface HistoryRunStep {
  seq: number;
  name: string;
  ok: boolean;
  skipped?: boolean;
  status: number | null;
  timeMs: number;
  passed: number;
  failed: number;
  error?: string;
  note?: string;
  stepResult?: ScenarioStepResult;
  request: RequestDraft | null;
  requestTemplate?: RequestDraft | null;
  response: ResponseData | null;
  outcome: ScriptOutcome | null;
  iterations?: Array<{
    label?: string;
    request: RequestDraft | null;
    response: ResponseData | null;
    outcome: ScriptOutcome | null;
    error?: string;
  }>;
}

/**
 * 一条完整执行记录。明文只存在于 WebView 与 Rust 进程内存中；写入 SQLite
 * 前由 Rust 用 AES-256-GCM 整条加密。响应包含 headers / body / timings /
 * rawRequest / rawResponse / 断言结果，超长部分按有界截断并登记到 `truncated`。
 */
export interface HistoryRunRecord {
  id: string;
  kind: HistoryRunKind;
  at: number;
  projectId: string;
  projectName: string;
  subjectId: string;
  subjectName: string;
  name: string;
  method: string;
  url: string;
  ok: boolean;
  status: number | null;
  timeMs: number;
  size: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  error: string;
  /** 请求快照（含 headers / auth / body），参数值已替换为实际发送的值。 */
  request: RequestDraft | null;
  /** 发送时的原始模板，供只读标签页重新发送，避免对已替换的值二次解析。 */
  requestTemplate?: RequestDraft | null;
  /** 完整响应信息。 */
  response: ResponseData | null;
  /** pre/post 脚本日志、test() 结果、断言与变量写入。 */
  outcome: ScriptOutcome | null;
  /** 用例 / 场景原有的运行摘要。 */
  summary: CaseRunResult | ScenarioRunSummary | null;
  /** 压测专属聚合指标；其它类型（以及升级前写入的旧记录）没有此字段。 */
  benchmark?: BenchmarkHistorySnapshot | null;
  /** 场景步骤明细；接口、用例与压测为空数组。 */
  steps: HistoryRunStep[];
  /** 被截断的字段说明，便于在详情里如实标注。 */
  truncated: string[];
}

/**
 * 游标分页：指向上一页「最后检查」的一行，而不是最后一条命中记录。
 * 排序固定为 (at DESC, id DESC)，因此滚动期间新增的记录不会被重复取出，
 * 搜索时被跳过的行也不会丢失。
 */
export interface HistoryCursor {
  at: number;
  id: string;
}

export interface HistoryRunPage {
  items: HistoryRunSummary[];
  /** null 表示已经到底，没有下一页。 */
  nextCursor: HistoryCursor | null;
}

export interface HistoryListQuery {
  scope?: "project" | "all";
  projectId?: string | null;
  kind?: HistoryRunKind | "all" | null;
  search?: string | null;
  limit?: number;
  cursor?: HistoryCursor | null;
}

export interface HistoryStats {
  runs: number;
  steps: number;
  bytes: number;
  encrypted: boolean;
  keyId: string;
  keyMismatch: boolean;
  schemaVersion: number;
  /** 本地数据库绝对路径，仅用于界面展示。 */
  path: string;
}

export interface WorkspaceSettings {
  httpVersion?: HttpVersion;
  timeoutSecs: number;
  followRedirects: boolean;
  verifyTls: boolean;
  /** Cross-request cookie jar (defaults to on). */
  manageCookies?: boolean;
  scriptTimeoutMs?: number;
  /** How SSE event fragments are merged into readable text. */
  sseMerge?: SseMergeConfig;
  /** 全局前置脚本：每次请求在请求级 pre 脚本之前执行（P1-8）。 */
  globalPreScript?: string;
  /** 全局后置脚本：每次请求在请求级 post 脚本之后执行（P1-8）。 */
  globalPostScript?: string;
  /** HTTP(S) 代理地址（P2-14）：如 http://127.0.0.1:7890，空 = 系统默认。 */
  proxyUrl?: string;
  /** 引擎与存储上限（字节）：设置页配置，随请求 spec.limits 下发。 */
  maxResponseBytes?: number;
  maxRequestBodyBytes?: number;
  inlineBodyBytes?: number;
  maxBodySpoolBytes?: number;
  /** 快照存储上限（字节）：由 updateSettings 同步到本地 SQLite 存储层。 */
  maxWorkspaceBytes?: number;
  /** AI 助手：OpenAI 兼容服务地址（/chat/completions 会自动追加）。 */
  aiBaseUrl?: string;
  aiApiKey?: string;
  aiModel?: string;
  /**
   * @deprecated 旧版把云端连接写进快照。现在地址 / token / 协作空间统一放在
   * WebView localStorage（见 lib/cloudConnection.ts），启动时会一次性迁移。
   * 保留字段仅为兼容旧快照，且上传前会被 stripForUpload 剔除。
   */
  cloudBaseUrl?: string;
  /** @deprecated 同上；令牌与协作空间 id 现在由 cloudConnection.ts 持久化。 */
  cloudProjectId?: string;
  /** 自动同步间隔（分钟）；0 = 关闭，缺省 = 5。本机偏好，不上传。 */
  autoSyncMinutes?: number;
}

/** 脚本库片段（P1-8）：命名的可复用脚本代码，编辑器一键插入。 */
export interface ScriptSnippet {
  id: string;
  name: string;
  description: string;
  code: string;
  /** 行级同步的合并依据；由同步层维护，可缺省。 */
  updatedAt?: number;
}

/** 错误码表的一行；公共文档章节可附带结构化错误码，供网页版渲染成可搜索表格。 */
export interface ErrorCodeRow {
  id: string;
  code: string;
  /** HTTP 状态码，允许写 "400" 或 "4xx" 这类区间。 */
  httpStatus: string;
  message: string;
  description: string;
  solution: string;
}

export type DocPageGroup = "guide" | "reference" | "changelog";

/**
 * 工作区级公共文档章节：鉴权逻辑、接入流程、错误码、更新日志等。
 * 与单接口 RequestDoc 并列，随工作区持久化并参与云同步，
 * 桌面端「文档站预览」、单文件 HTML 导出、网页版共用同一份数据。
 */
export interface DocPage {
  id: string;
  title: string;
  /** URL 锚点，如 auth → #page-auth。 */
  slug: string;
  group: DocPageGroup;
  /** Markdown 正文，复用 lib/docs.ts 的 parseMarkdownBlocks 子集。 */
  body: string;
  errorCodes?: ErrorCodeRow[];
  /** 行级同步的合并依据；由同步层维护，可缺省。 */
  updatedAt?: number;
}

/**
 * 自定义「复制代码」模板：用项目自己的封装类生成请求代码。
 * 支持 {{token}}、{{{token}}}、{{#each headers}}…{{/each}}、{{#if hasBody}}…{{/if}}。
 */
export interface CodeTemplate {
  id: string;
  name: string;
  description: string;
  /** 模板正文。 */
  content: string;
  /** 仅用于列表展示（如 TypeScript / Python），不参与渲染。 */
  language?: string;
  /** 行级同步的合并依据；由同步层维护，可缺省。 */
  updatedAt?: number;
}

/** One cookie stored in the shared jar (mirrors Rust StoredCookie). */
export interface StoredCookie {
  domain: string;
  hostOnly: boolean;
  path: string;
  name: string;
  value: string;
  secure: boolean;
  /** Unix millis; null = session cookie. */
  expiresAtMs: number | null;
}

export type Theme = "light" | "dark";

/** gRPC：单个 .proto 文件引用（含磁盘路径，protox 以此解析 import）。 */
export interface GrpcFileRef {
  name: string;
  path: string;
  content: string;
}

/** gRPC：proto 里声明的 service / method（编译产物）。 */
export interface GrpcMethod {
  name: string;
  path: string;
  inputType: string;
  outputType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
}

export interface GrpcService {
  name: string;
  methods: GrpcMethod[];
}

export interface GrpcSchema {
  descriptorId: string;
  files: string[];
  services: GrpcService[];
}

/** gRPC TLS 选项：默认校验服务端证书；关闭仅限调试自签名的内网服务。 */
export interface GrpcTlsOptions {
  /** false = 跳过证书校验。省略 / null 均视为 true（安全默认）。 */
  verifyTls?: boolean;
  /** 追加到根证书库的 PEM CA 证书。 */
  caPem?: string;
}

export interface GrpcInvokeSpec extends GrpcTlsOptions {
  descriptorId: string;
  address: string;
  service: string;
  method: string;
  messageJson: string;
  headers: Record<string, string>;
  timeoutMs?: number;
}

export interface GrpcStreamSpec extends GrpcTlsOptions {
  descriptorId: string;
  address: string;
  service: string;
  method: string;
  headers: Record<string, string>;
  timeoutMs?: number;
  initialMessages?: string[];
}

export interface GrpcInvokeResult {
  status: string;
  message: string;
  responses: unknown[];
  elapsedMs: number;
  truncated: boolean;
}

/** MCP 服务器连接配置（随工作区持久化）。 */
export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
}

/** MCP 服务器在 tools/list 里声明的工具。 */
export interface McpTool {
  name: string;
  description?: string | null;
  inputSchema?: unknown;
}

export interface McpConnectResult {
  serverInfo: string;
  tools: McpTool[];
}

export interface McpContent {
  type: string;
  text: string;
}

export interface McpCallOutcome {
  isError: boolean;
  content: McpContent[];
  text: string;
}

export interface WorkspaceSnapshot {
  version: 1;
  seeded: boolean;
  collections: Collection[];
  environments: Environment[];
  activeEnvironmentId: string | null;
  history: HistoryEntry[];
  /** Single-interface test cases, flat list keyed by requestId. */
  cases: ApiCase[];
  /** Cross-interface test scenarios: ordered steps that share a variable table. */
  scenarios: TestScenario[];
  /** Recently deleted items, oldest first, capped by the storage layer. */
  trash: TrashEntry[];
  /** MCP 服务器配置（连接状态不持久化，应用重启后需重连）。 */
  mcpServers?: McpServerConfig[];
  /** 可复用数据模型（JSON Schema），供文档 / 校验 / Mock 引用。 */
  dataModels?: DataModel[];
  /** 测试套件：用例 / 场景的批量组合回归。 */
  suites?: TestSuite[];
  /** 接口变更历史（P1-7）：requestId → 旧版本快照（新在前，每接口上限 20）。 */
  revisions?: Record<string, RequestRevision[]>;
  /** 脚本库（P1-8）：命名脚本片段，脚本编辑器一键插入。 */
  scriptLibrary?: ScriptSnippet[];
  /** 自定义代码复制模板（项目封装类）。 */
  codeTemplates?: CodeTemplate[];
  /** 工作区级公共文档章节：鉴权 / 流程 / 错误码 / 更新日志。 */
  docPages?: DocPage[];
  /** 全局命名数据库连接（P2-13）：场景 DB 步骤按 id 引用。 */
  dbConnections?: NamedDbConnection[];
  /**
   * 行级同步的删除墓碑：本机删除的实体在同步成功前保留在此，保证删除能
   * 传播到其他副本。只参与同步协议，不进入 UI / 导出。
   */
  tombstones?: WorkspaceTombstone[];
  settings: WorkspaceSettings;
  theme?: Theme;
}

/** 墓碑覆盖的实体类型（与行协议里的域一一对应）。 */
export type TombstoneKind =
  | "folder"
  | "request"
  | "environment"
  | "case"
  | "scenario"
  | "suite"
  | "docPage"
  | "dataModel"
  | "scriptSnippet"
  | "codeTemplate";

/** 一行删除墓碑：`updatedAt` 必须晚于被删版本，才能赢过后者的 LWW。 */
export interface WorkspaceTombstone {
  kind: TombstoneKind;
  id: string;
  updatedAt: number;
}

/** 一个接口的历史版本：保存时被替换下来的旧内容快照。 */
export interface RequestRevision {
  id: string;
  /** 该版本被覆盖（即新版本保存）的时间。 */
  at: number;
  snapshot: RequestDraft;
}

/** What a trash entry holds: the deleted item plus enough context to restore it. */
export type TrashPayload =
  | { kind: "request"; request: RequestDraft; collectionId: string; collectionName: string }
  | { kind: "case"; caseItem: ApiCase }
  | { kind: "scenario"; scenario: TestScenario };

export interface TrashEntry {
  id: string;
  deletedAt: number;
  payload: TrashPayload;
}

/** 并发压测的延迟统计（毫秒）。 */
export interface BenchmarkLatency {
  minMs: number;
  avgMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

/** 并发压测聚合报告。 */
export interface BenchmarkReport {
  total: number;
  success: number;
  failed: number;
  timeMs: number;
  rps: number;
  latency: BenchmarkLatency;
  /** 状态码 → 次数；传输层失败记为 "0"。 */
  statuses: Record<string, number>;
  /** 去重后的错误样本（最多 5 条）。 */
  errors: string[];
  errorCount: number;
}

// -------------------------------------------------------- scenarios ----

/** Where a scenario step's request comes from. */
/** db_query 结果（Rust DbQueryResult 镜像）。 */
export interface DbQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowsAffected: number;
  elapsedMs: number;
  truncated: boolean;
}

/** 数据库步骤提取：取指定行指定列的值写入场景变量。 */
export interface ScenarioDbExtract {
  id: string;
  varName: string;
  column: string;
  /** 行号（从 0 开始）。 */
  row: number;
}

/** 数据库步骤断言：行数或指定单元格。 */
export interface ScenarioDbAssert {
  id: string;
  target: "rows" | "cell";
  row: number;
  column: string;
  op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains";
  value: string;
}

/** 数据库步骤配置（仅 MySQL / PostgreSQL）。 */
export interface ScenarioDbConfig {
  /** 直连 URL；填写 `connectionId` 时由命名连接提供，此字段忽略。 */
  url: string;
  /** 引用全局命名数据库连接（P2-13）。 */
  connectionId?: string;
  sql: string;
  /** "query" 返回行；"execute" 返回受影响行数。 */
  mode: "query" | "execute";
  maxRows?: number;
  extracts: ScenarioDbExtract[];
  asserts: ScenarioDbAssert[];
}

/** 全局命名数据库连接：场景 DB 步骤通过 connectionId 引用。 */
export interface NamedDbConnection {
  id: string;
  name: string;
  url: string;
  description: string;
}

export type ScenarioStepSource =
  | { kind: "case"; caseId: string }
  | { kind: "inline"; request: RequestDraft }
  | { kind: "db"; db: ScenarioDbConfig }
  | { kind: "wait"; ms: number };

/**
 * 步骤级循环控制（P0-2 场景编排）：不填 = 只跑一次；
 * `count` = 固定次数；`over` = 遍历场景变量中的 JSON 数组，
 * 每轮把元素绑定到 `itemVar`（默认 item）、下标绑定到 `indexVar`（可选）。
 */
export interface ScenarioStepRepeat {
  count?: number;
  over?: string;
  itemVar?: string;
  indexVar?: string;
}

/**
 * 步骤级条件门（P0-2 场景编排）：条件不满足时该步骤整体跳过
 * （skipped），不计失败、不中断链路。
 */
export interface ScenarioStepCondition {
  varName: string;
  op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "exists";
  value: string;
}

/** Pull values out of a step's response into the scenario variable table. */
export interface ScenarioExtract {
  id: string;
  /** Variable name usable as {{name}} in later steps. */
  varName: string;
  source: "json" | "header" | "status";
  /** JSONPath for json, header name for header. */
  path: string;
}

export interface ScenarioStep {
  id: string;
  name: string;
  enabled: boolean;
  source: ScenarioStepSource;
  extracts: ScenarioExtract[];
  /** Keep running the scenario even when this step fails. */
  continueOnFailure: boolean;
  /** 循环控制：固定次数或遍历数组变量（默认只跑一次）。 */
  repeat?: ScenarioStepRepeat;
  /** 条件门：不满足时跳过本步骤。 */
  condition?: ScenarioStepCondition;
}

export interface ScenarioStepResult {
  stepId: string;
  name: string;
  status: number | null;
  ok: boolean;
  skipped: boolean;
  timeMs: number;
  passed: number;
  failed: number;
  error?: string;
  /** Variables extracted by this step (name → value). */
  extracted: Record<string, string>;
  /** UTF-8 文本响应体（仅 `captureBody` 开启时填充，且已按上限截断）。 */
  body?: string;
  /** 原始响应体超过上限被截断。 */
  bodyTruncated?: boolean;
  /** 附加说明（循环次数、跳过原因等）。 */
  note?: string;
  /** 证据链采集用：Rust 引擎的分段计时（Node fetch 兜底时缺失）。 */
  timings?: ResponseTimings;
  /** 证据链采集用：逐条断言 / 脚本 test() 结果，不只留 passed / failed 计数。 */
  assertions?: {
    id?: string;
    name?: string;
    ok: boolean;
    source?: string;
    message?: string;
  }[];
  /** 证据链采集用：请求方法与 URL（写盘前由 safeUrl 去掉 query 与凭据）。 */
  method?: string;
  url?: string;
  /** 证据链采集用：跳过原因与 note 分离，避免把展示文案当原因。 */
  skipReason?: string;
}

export interface ScenarioRunSummary {
  at: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  timeMs: number;
  steps: ScenarioStepResult[];
}

/**
 * 数据驱动测试（P0-3）：场景级数据集。`rows` 每行是一轮执行，
 * 行内键值作为场景变量注入（覆盖环境变量，不覆盖步骤提取结果）。
 */
export interface ScenarioDataSet {
  /** 变量名列表（CSV 表头）。 */
  columns: string[];
  /** 每行一轮：变量名 → 值。 */
  rows: Record<string, string>[];
}

export interface TestScenario {
  id: string;
  name: string;
  description?: string;
  steps: ScenarioStep[];
  /** 可选数据集：配置后场景按行多轮执行。 */
  dataSet?: ScenarioDataSet;
  createdAt: number;
  updatedAt: number;
  lastRun?: ScenarioRunSummary;
  /** 完整执行历史，最新在前（封顶截断）。 */
  runHistory?: ScenarioRunSummary[];
}

export interface RuntimeInfo {
  status: string;
  version: string;
  timeoutSecs: number;
  maxResponseBytes: number;
  logLevel: string;
  workspacePath: string;
}

// --------------------------------------------------- Update check ----

/** 由 Rust 侧 `check_update` 命令验签并解析更新清单后返回。 */
export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  downloadUrl?: string;
  notes?: string;
  pubDate?: string;
  /** true = 清单 Ed25519 验签通过；false = 未配置清单地址时的本地占位结果。 */
  signatureVerified?: boolean;
}

// --------------------------------------------------- Local projects ----

/** One local project owns exactly one workspace directory under the data root. */
export interface ProjectInfo {
  id: string;
  name: string;
  /** Absolute path of the project's data directory (`<dataRoot>/projects/<id>`). */
  dataDirectory: string;
  active: boolean;
}

export interface ProjectsState {
  activeProjectId: string;
  projects: ProjectInfo[];
  /** The single data root every project directory lives under. */
  dataRoot: string;
  /** Absolute data directory of the active project. */
  dataDirectory: string;
}

// ------------------------------------------------------------- SSE ----

export type StreamMode = "auto" | "on" | "off";

export type SseMergeMode = "auto" | "jsonPath" | "rawText" | "off";

export type SseFormat =
  | "openai"
  | "gemini"
  | "claude"
  | "genericJson"
  | "plainText"
  | "custom"
  | "unknown";

export interface SseMergeConfig {
  mode: SseMergeMode;
  /** Used when mode === "jsonPath". e.g. $.choices[0].message.content */
  jsonPath: string;
  /** Optional separate path for reasoning / thinking fragments. */
  reasoningPath: string;
}

export interface SseFrame {
  seq: number;
  atMs: number;
  event: string;
  id: string;
  data: string;
  raw: string;
}

export interface SseMeta {
  status: number;
  statusText: string;
  ok: boolean;
  url: string;
  resolvedUrl: string;
  headers: ResponseHeader[];
  contentType: string;
  missingVariables: string[];
  /** Connection + TTFB checkpoints known when headers arrived. */
  timings?: ResponseTimings;
  rawRequest?: string;
}

export interface SseDone {
  frames: number;
  bytes: number;
  elapsedMs: number;
  truncated: boolean;
  cancelled: boolean;
  /** Final breakdown including the whole stream's transfer time. */
  timings?: ResponseTimings;
  /** Status line + headers + every received byte. */
  rawResponse?: string;
}

/** Wire shape of the `stream_request` Channel (serde internally-tagged enum). */
export type SseMessage =
  | { kind: "meta"; meta: SseMeta }
  | { kind: "frame"; frame: SseFrame }
  | ({ kind: "done" } & SseDone)
  | { kind: "nonSse"; response: ResponseData }
  | { kind: "error"; code: string; message: string };

export interface SseState {
  /** The most recent response was (or is) an event stream. */
  active: boolean;
  streaming: boolean;
  meta: SseMeta | null;
  frames: SseFrame[];
  done: SseDone | null;
  error: string | null;
  format: SseFormat;
  /** Text merged so far — updated on every frame, before the stream ends. */
  mergedText: string;
  reasoningText: string;
  /** Per-frame extracted snippet, parallel to `frames`. */
  snippets: string[];
}

// ----------------------------------------------------- WebSocket ----

/** Wire shape of the `ws_connect` Channel (serde internally-tagged enum). */
export type WsClientMessage =
  | {
      kind: "open";
      sessionId: string;
      url: string;
      status: number;
      headers: ResponseHeader[];
    }
  | { kind: "message"; data: string; atMs: number; binary: boolean }
  | { kind: "closed"; code: number | null; reason: string | null }
  | { kind: "error"; code: string; message: string };

export interface WsTimelineEntry {
  id: string;
  /** "in" = received from server, "out" = sent by us, "sys" = lifecycle. */
  direction: "in" | "out" | "sys";
  data: string;
  atMs: number;
  binary?: boolean;
  /** Wall-clock ms timestamp, for sys entries and out messages. */
  at?: number;
  label?: string;
  error?: boolean;
}

export interface WsSessionState {
  sessionId: string;
  requestId: string;
  /** "connecting" | "open" | "closed" | "error" */
  status: "connecting" | "open" | "closed" | "error";
  url: string;
  /** WS handshake status (101 on success). */
  handshakeStatus?: number;
  headers: ResponseHeader[];
  messages: WsTimelineEntry[];
  connectedAt?: number;
  closedAt?: number;
  closeCode?: number | null;
  closeReason?: string | null;
  error: string | null;
}

// ----------------------------------------------------- TCP raw socket ----

/** One-shot raw TCP debug spec: connect → send → read until silence → close. */
export interface TcpDebugSpec {
  /** `host:port`; prefix `tls://` (or `https://`) for TLS. */
  address: string;
  /** `text` (UTF-8) or `hex` (hex-encoded bytes, spaces allowed). */
  encoding: "text" | "hex";
  payload: string;
  /** Appended to the payload: `none` / `lf` / `crlf`. */
  newline: "none" | "lf" | "crlf";
  connectTimeoutMs: number;
  /** Silence window: reading stops after this long without new bytes. */
  readTimeoutMs: number;
  variables: Record<string, string>;
}

export interface TcpDebugResult {
  sentBytes: number;
  receivedBytes: number;
  /** Lowercase hex of everything received. */
  dataHex: string;
  /** Lossy UTF-8 rendering of the received bytes. */
  dataText: string;
  elapsedMs: number;
  /** True when the server closed the connection before the silence window. */
  closedByServer: boolean;
  truncated: boolean;
  warnings: string[];
}

// ----------------------------------------------------- Mock server ----

/**
 * One request-matching condition for a smart mock rule. `source` picks where
 * the value comes from (`query` / `header` / `body`), `op` how it compares
 * (`eq` / `ne` / `exists` / `contains`). For `body`, `key` is a dotted JSON
 * path like `user.name` (optional leading `$.`).
 */
export interface MockCondition {
  source: "query" | "header" | "body";
  key: string;
  op: "eq" | "ne" | "exists" | "contains";
  value: string;
}

/** One Mock rule: serves `body` for `method path` on the local mock server. */
export interface MockRule {
  id: string;
  method: string;
  /** Path only, may contain {param} template segments. */
  path: string;
  status: number;
  contentType: string;
  body: string;
  delayMs: number;
  description: string;
  /** Render `@token` placeholders in the body before responding. */
  smart?: boolean;
  /** All conditions must pass for this rule to win over condition-less rules. */
  conditions?: MockCondition[];
}

export interface MockStartInfo {
  port: number;
  startedAt: number;
}

export interface MockAccessLogEntry {
  at: number;
  method: string;
  path: string;
  matchedId: string | null;
  status: number;
  durationMs: number;
}

export interface MockStatus {
  running: boolean;
  port: number | null;
  startedAt: number | null;
  requestsServed: number;
  log: MockAccessLogEntry[];
}

// ----------------------------------------------------- Console ----

/** Bottom console panel entry: runtime events across the whole app. */
export interface ConsoleEntry {
  id: string;
  at: number;
  level: "info" | "warn" | "error";
  source: "http" | "ws" | "mock" | "script" | "import" | "scenario" | "mqtt" | "soap" | "grpc";
  text: string;
}

export interface MqttSpec {
  url: string;
  clientId?: string;
  username?: string;
  password?: string;
  version: "3.1.1" | "5";
  keepAliveSecs: number;
  cleanSession: boolean;
  topic: string;
  qos: 0 | 1 | 2;
  retain: boolean;
  payload?: string;
  subscriptions?: Array<{ topic: string; qos: 0 | 1 | 2 }>;
}

export interface SoapSpec {
  version: "1.1" | "1.2";
  wsdlUrl?: string;
  operation?: string;
  namespace?: string;
  soapAction?: string;
  envelope?: string;
  wsSecurity?: boolean;
  username?: string;
  password?: string;
  endpoint?: string;
}

export interface MqttTimelineEntry {
  direction: "in" | "out" | "sys";
  topic?: string;
  data: string;
  at: number;
  atMs: number;
  qos?: 0 | 1 | 2;
  retain?: boolean;
  label?: string;
  error?: boolean;
}

export interface MqttSessionState {
  sessionId: string;
  status: "connecting" | "open" | "closed" | "error";
  messages: MqttTimelineEntry[];
  subscriptions: Array<{ topic: string; qos: 0 | 1 | 2 }>;
  error?: string;
  connectedAt?: number;
}

export type MqttClientMessage =
  | { kind: "open"; sessionId: string; protocol: string; atMs: number }
  | { kind: "subscribed"; topics: string[]; atMs: number }
  | { kind: "unsubscribed"; topics: string[]; atMs: number }
  | { kind: "message"; topic: string; payload: string; qos: number; retain: boolean; atMs: number }
  | { kind: "published"; topic: string; qos: number; retain: boolean; atMs: number }
  | { kind: "reconnecting"; attempt: number; atMs: number }
  | { kind: "closed"; reason: string; atMs: number }
  | { kind: "error"; code: string; message: string };

export type GrpcStreamMessage =
  | { kind: "open"; sessionId: string; methodPath: string; clientStreaming: boolean; serverStreaming: boolean; atMs: number }
  | { kind: "message"; direction: "in" | "out"; json: unknown; atMs: number }
  | { kind: "done"; status: number; message: string; atMs: number }
  | { kind: "error"; code: string; message: string };

export interface GrpcStreamState {
  sessionId: string;
  status: "idle" | "open" | "closed" | "error";
  messages: Array<{ direction: "in" | "out"; json: unknown; atMs: number }>;
  error?: string;
  statusCode?: number;
}
