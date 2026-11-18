/**
 * 版本化集合导出器 —— 所有外发文件的唯一出口。
 *
 * 设计约束（对应 docs/api-client-comparison-2026-reqora.html 第 10.5 节 P0）：
 * 1. 用户可以把整个工作区（请求 / 文件夹 / 变量 / 脚本注释）以通用集合格式
 *    整体迁出，覆盖 Postman v2.1 / v2.0 + 环境文件、OpenAPI 3.0.3 / 3.1.0
 *    （JSON / YAML）、Swagger 2.0、Insomnia v4 / v5、HAR 1.2、cURL，以及
 *    既有的 Markdown / 文档站 HTML / TS·Python SDK。
 * 2. **每个导出器都必须复用 `redact.ts` 的脱敏出口**：`renderExport` /
 *    `renderExportAsync` 是仅有的公开渲染入口，入口内先对快照执行
 *    `redactSnapshot`（结构化凭据置空、保留形状、返回全新深拷贝），序列化完成后
 *    再对最终文本执行一次 `redactFreeText`（自由文本凭据兜底）。所有格式渲染器
 *    都是本模块私有函数，只接收脱敏后的快照，外部无法绕过这道闸门。
 *
 * 纯函数、零新增依赖；Node 22 原生 TS 类型剥离与 Vite/tsc 均可直接加载。
 */
import { resolveRequestAuth } from "./auth.ts";
import { docPagesToMarkdown } from "./docPages.ts";
import { exportDocSiteHtml, exportEncryptedDocSiteHtml } from "./docsite.ts";
import { generatePythonSdk, generateTsSdk } from "./sdk.ts";
import { shellQuote } from "./codegen.ts";
import { redactFreeText, redactSnapshot, SENSITIVE_NAME } from "./redact.ts";
import { shareableVariables } from "./privateValues.ts";
import { exportMarkdown, exportOpenApi } from "./transfer.ts";
import { buildTestAssets, omitUndefined } from "./testAssets.ts";
import type {
  AssertionSpec,
  AuthSpec,
  BodySpec,
  Collection,
  Environment,
  KeyValue,
  RequestDraft,
  WorkspaceSnapshot,
} from "../types";

// ------------------------------------------------------------ 格式注册表 ----

/**
 * 格式族的封闭取值，注册表唯一事实源。新增族必须同时补齐本数组、
 * EXPORT_FORMAT_GROUPS、EXPORT_FORMATS 与 UI 侧 FAMILY_SHORT_LABEL；
 * 缺任何一处都会由 `Record<ExportFamily, string>` 在 tsc 阶段直接报错。
 */
export const KNOWN_EXPORT_FAMILIES = [
  "postman", "openapi", "swagger", "insomnia", "har", "curl", "doc", "sdk",
  "test-assets", "bruno", "opencollection",
] as const;

export type ExportFamily = typeof KNOWN_EXPORT_FAMILIES[number];

export type ExportFormatId =
  | "postman-v21"
  | "postman-v20"
  | "postman-env"
  | "openapi-303-json"
  | "openapi-303-yaml"
  | "openapi-310-json"
  | "openapi-310-yaml"
  | "swagger-20-json"
  | "swagger-20-yaml"
  | "insomnia-v4"
  | "insomnia-v5"
  | "har-12"
  | "curl"
  | "markdown"
  | "docsite"
  | "docsite-encrypted"
  | "sdk-ts"
  | "sdk-python"
  | "test-assets-v1"
  | "bruno-collection"
  | "opencollection-v1";

export interface ExportFormatSpec {
  id: ExportFormatId;
  family: ExportFamily;
  /** 该格式的版本标识，写进导出文件自身（info.schema / openapi / log.version ...）。 */
  version: string;
  label: string;
  variant: string;
  description: string;
  fileName: string;
  extension: string;
  mediaType: string;
  /** 需要密码且渲染为异步（目前只有加密文档站）。 */
  encrypted?: boolean;
}

export const EXPORT_FORMAT_GROUPS: ReadonlyArray<{ family: ExportFamily; label: string }> = [
  { family: "postman", label: "Postman 集合 / 环境" },
  { family: "openapi", label: "OpenAPI" },
  { family: "swagger", label: "Swagger" },
  { family: "insomnia", label: "Insomnia 集合" },
  { family: "har", label: "HAR 归档" },
  { family: "curl", label: "cURL 命令" },
  { family: "doc", label: "接口文档" },
  { family: "sdk", label: "SDK 客户端" },
  { family: "test-assets", label: "测试资产 · reqora.test.v1" },
  { family: "bruno", label: "Bruno 集合（多文件清单）" },
  { family: "opencollection", label: "OpenCollection" },
];

export const EXPORT_FORMATS: readonly ExportFormatSpec[] = [
  {
    id: "postman-v21", family: "postman", version: "v2.1",
    label: "Postman 集合", variant: "v2.1 · JSON",
    description: "请求 / 文件夹 / 集合变量 / 脚本以注释降级，可直接导入 Postman 或 Newman",
    fileName: "reqora-postman-v2.1.json", extension: "json", mediaType: "application/json",
  },
  {
    id: "postman-v20", family: "postman", version: "v2.0",
    label: "Postman 集合", variant: "v2.0 · JSON",
    description: "兼容旧版 Postman / 第三方工具的 v2.0 schema",
    fileName: "reqora-postman-v2.0.json", extension: "json", mediaType: "application/json",
  },
  {
    id: "postman-env", family: "postman", version: "环境文件",
    label: "Postman 环境", variant: "环境 · JSON",
    description: "活动环境的变量名；私密值按脱敏出口置空并标记为 secret 类型",
    fileName: "reqora.postman_environment.json", extension: "json", mediaType: "application/json",
  },
  {
    id: "openapi-303-json", family: "openapi", version: "3.0.3",
    label: "OpenAPI", variant: "3.0.3 · JSON",
    description: "Swagger / Apifox / Postman 通用导入格式",
    fileName: "reqora-openapi-3.0.3.json", extension: "json", mediaType: "application/json",
  },
  {
    id: "openapi-303-yaml", family: "openapi", version: "3.0.3",
    label: "OpenAPI", variant: "3.0.3 · YAML",
    description: "与 JSON 版同构，便于 Git diff / 手工编辑",
    fileName: "reqora-openapi-3.0.3.yaml", extension: "yaml", mediaType: "application/yaml",
  },
  {
    id: "openapi-310-json", family: "openapi", version: "3.1.0",
    label: "OpenAPI", variant: "3.1.0 · JSON",
    description: "带 jsonSchemaDialect，面向 JSON Schema 2020-12 的工具链",
    fileName: "reqora-openapi-3.1.0.json", extension: "json", mediaType: "application/json",
  },
  {
    id: "openapi-310-yaml", family: "openapi", version: "3.1.0",
    label: "OpenAPI", variant: "3.1.0 · YAML",
    description: "3.1.0 的 YAML 形式",
    fileName: "reqora-openapi-3.1.0.yaml", extension: "yaml", mediaType: "application/yaml",
  },
  {
    id: "swagger-20-json", family: "swagger", version: "2.0",
    label: "Swagger", variant: "2.0 · JSON",
    description: "由 3.0.3 文档降级转换（requestBody → body/formData 参数）",
    fileName: "reqora-swagger-2.0.json", extension: "json", mediaType: "application/json",
  },
  {
    id: "swagger-20-yaml", family: "swagger", version: "2.0",
    label: "Swagger", variant: "2.0 · YAML",
    description: "Swagger 2.0 的 YAML 形式",
    fileName: "reqora-swagger-2.0.yaml", extension: "yaml", mediaType: "application/yaml",
  },
  {
    id: "insomnia-v4", family: "insomnia", version: "v4",
    label: "Insomnia 集合", variant: "v4 · JSON",
    description: "__export_format 4 / resources[] 扁平表，兼容旧版 Insomnia",
    fileName: "reqora-insomnia-v4.json", extension: "json", mediaType: "application/json",
  },
  {
    id: "insomnia-v5", family: "insomnia", version: "v5",
    label: "Insomnia 集合", variant: "v5 · JSON",
    description: "collection.insomnia.rest/5.0 层级集合格式",
    fileName: "reqora-insomnia-v5.json", extension: "json", mediaType: "application/json",
  },
  {
    id: "har-12", family: "har", version: "1.2",
    label: "HAR 归档", variant: "1.2 · JSON",
    description: "log.entries 抓包归档，可被 DevTools / 抓包工具读取",
    fileName: "reqora-requests.har", extension: "har", mediaType: "application/json",
  },
  {
    id: "curl", family: "curl", version: "命令集",
    label: "cURL 命令", variant: "多请求 · sh",
    description: "每个接口一条命令，鉴权值统一以 {{占位符}} 表示",
    fileName: "reqora-requests.sh", extension: "sh", mediaType: "text/x-shellscript",
  },
  {
    id: "markdown", family: "doc", version: "—",
    label: "Markdown 接口文档", variant: "Markdown · md",
    description: "公共章节 + 全部接口的参数表与响应示例",
    fileName: "reqora-api-docs.md", extension: "md", mediaType: "text/markdown",
  },
  {
    id: "docsite", family: "doc", version: "HTML",
    label: "文档站", variant: "单文件 HTML",
    description: "含页内在线调试的单文件静态站点",
    fileName: "reqora-api-docs.html", extension: "html", mediaType: "text/html",
  },
  {
    id: "docsite-encrypted", family: "doc", version: "HTML · AES-GCM",
    label: "加密文档站", variant: "单文件 HTML · 需密码",
    description: "AES-GCM 加密，凭密码在浏览器解锁",
    fileName: "reqora-api-docs-encrypted.html", extension: "html", mediaType: "text/html",
    encrypted: true,
  },
  {
    id: "sdk-ts", family: "sdk", version: "TypeScript",
    label: "TypeScript SDK", variant: "fetch 客户端",
    description: "全集合 fetch 客户端与派生数据模型类型",
    fileName: "reqora-api-client.ts", extension: "ts", mediaType: "text/typescript",
  },
  {
    id: "sdk-python", family: "sdk", version: "Python",
    label: "Python SDK", variant: "requests 客户端",
    description: "全集合 requests 客户端，含请求体示例",
    fileName: "reqora-api-client.py", extension: "py", mediaType: "text/x-python",
  },
  {
    id: "test-assets-v1", family: "test-assets", version: "1",
    label: "测试资产", variant: "reqora.test.v1 · YAML",
    description: "用例 / 场景 / 套件 / 断言 / 脚本 / Mock / CSV / 变量名清单；可 diff、可往返导入；私密值不带出",
    fileName: "reqora.test.v1.yaml", extension: "yaml", mediaType: "application/yaml",
  },
  {
    id: "bruno-collection", family: "bruno", version: "v1",
    label: "Bruno 集合", variant: "文件清单 · JSON",
    description: "返回确定的 JSON 文件清单（schema: reqora.bruno.v1 + files{相对路径:内容} + warnings[]），不是单文件 .bru；export --all 落盘时展开成目录",
    fileName: "reqora-bruno.json", extension: "json", mediaType: "application/json",
  },
  {
    id: "opencollection-v1", family: "opencollection", version: "1.0.0",
    label: "OpenCollection", variant: "单文件 · YAML",
    description: "单文件 YAML（opencollection / info / requests / variables / warnings[]），含不可表达部分的降级报告",
    fileName: "reqora-opencollection.yaml", extension: "yaml", mediaType: "application/yaml",
  },
];

const SPEC_BY_ID = new Map<ExportFormatId, ExportFormatSpec>(
  EXPORT_FORMATS.map((spec) => [spec.id, spec]),
);

export function isExportFormatId(value: string): value is ExportFormatId {
  return SPEC_BY_ID.has(value as ExportFormatId);
}

export function exportFormatSpec(id: ExportFormatId): ExportFormatSpec {
  const spec = SPEC_BY_ID.get(id);
  if (!spec) throw new Error(`未知的导出格式：${id}`);
  return spec;
}

export function formatsOfFamily(family: ExportFamily): ExportFormatSpec[] {
  return EXPORT_FORMATS.filter((spec) => spec.family === family);
}

// -------------------------------------------------------------- 脱敏闸门 ----

export interface ExportOptions {
  /** 加密文档站密码。 */
  password?: string;
  /** 文档标题。 */
  title?: string;
}

/** 所有导出器共用的输入构造：结构化脱敏 + 全新深拷贝，绝不改动工作区快照。 */
export function redactedExportSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return redactSnapshot(snapshot) as unknown as WorkspaceSnapshot;
}

/** 文本兜底：即使某个渲染器漏过了字段，最终外发字符串仍过一遍 redact.ts。 */
function egressText(content: string): string {
  return redactFreeText(content);
}

type Renderer = (safe: WorkspaceSnapshot, options: ExportOptions) => string;

/** 私有派发表：只有脱敏后的快照才能到达这里。 */
const RENDERERS: Partial<Record<ExportFormatId, Renderer>> = {
  "postman-v21": (safe) => renderPostmanCollection(safe, "2.1"),
  "postman-v20": (safe) => renderPostmanCollection(safe, "2.0"),
  "postman-env": (safe) => renderPostmanEnvironment(safe),
  "openapi-303-json": (safe) => renderOpenApi(safe, "3.0.3", "json"),
  "openapi-303-yaml": (safe) => renderOpenApi(safe, "3.0.3", "yaml"),
  "openapi-310-json": (safe) => renderOpenApi(safe, "3.1.0", "json"),
  "openapi-310-yaml": (safe) => renderOpenApi(safe, "3.1.0", "yaml"),
  "swagger-20-json": (safe) => renderSwagger(safe, "json"),
  "swagger-20-yaml": (safe) => renderSwagger(safe, "yaml"),
  "insomnia-v4": (safe) => renderInsomnia(safe, "v4"),
  "insomnia-v5": (safe) => renderInsomnia(safe, "v5"),
  "har-12": (safe) => renderHar(safe),
  curl: (safe) => renderCurl(safe),
  markdown: (safe) => [
    docPagesToMarkdown(safe.docPages ?? []),
    exportMarkdown(safe),
  ].filter((part) => part.trim() !== "").join("\n\n"),
  docsite: (safe, options) => exportDocSiteHtml(safe, options.title ?? "API 文档", {
    debug: true,
    variables: shareableVariables(activeEnvironment(safe)?.variables ?? []),
  }),
  "sdk-ts": (safe) => generateTsSdk(safe).content,
  "sdk-python": (safe) => generatePythonSdk(safe).content,
  "test-assets-v1": (safe) => renderTestAssets(safe),
  "bruno-collection": (safe) => renderBruno(safe),
  "opencollection-v1": (safe) => renderOpenCollection(safe),
};

/**
 * 同步导出入口。加密文档站请用 `renderExportAsync`。
 * 所有格式都经过 `redactSnapshot`（结构化）+ `redactFreeText`（文本）两道
 * redact.ts 脱敏出口，调用方无法拿到未脱敏的渲染结果。
 */
export function renderExport(
  snapshot: WorkspaceSnapshot,
  format: ExportFormatId,
  options: ExportOptions = {},
): string {
  if (format === "docsite-encrypted") {
    throw new Error("加密文档站是异步导出，请使用 renderExportAsync");
  }
  const renderer = RENDERERS[format];
  if (!renderer) throw new Error(`未知的导出格式：${format}`);
  const safe = redactedExportSnapshot(snapshot);
  return egressText(renderer(safe, options));
}

/** 异步导出入口（加密文档站需要 WebCrypto）。脱敏闸门与同步入口完全一致。 */
export async function renderExportAsync(
  snapshot: WorkspaceSnapshot,
  format: ExportFormatId,
  options: ExportOptions = {},
): Promise<string> {
  const safe = redactedExportSnapshot(snapshot);
  const content = format === "docsite-encrypted"
    ? await exportEncryptedDocSiteHtml(safe, options.password ?? "", options.title ?? "API 文档")
    : (RENDERERS[format] ?? (() => {
        throw new Error(`未知的导出格式：${format}`);
      }))(safe, options);
  return egressText(content);
}

// ---------------------------------------------------------------- 小工具 ----

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function activeEnvironment(safe: WorkspaceSnapshot): Environment | undefined {
  return (safe.environments ?? []).find((env) => env.id === safe.activeEnvironmentId)
    ?? safe.environments?.[0];
}

/** 环境行（Postman 变量 / Insomnia environment 用）：保留形状，值已由脱敏出口置空。 */
function environmentRows(safe: WorkspaceSnapshot): KeyValue[] {
  const env = activeEnvironment(safe);
  if (env) return usableRows(env.variables);
  const merged: KeyValue[] = [];
  const seen = new Set<string>();
  for (const item of safe.environments ?? []) {
    for (const row of usableRows(item.variables)) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      merged.push(row);
    }
  }
  return merged;
}

function usableRows(rows: readonly KeyValue[] | undefined, enabledOnly = false): KeyValue[] {
  return (rows ?? []).filter(
    (row) => row.key.trim() !== "" && (!enabledOnly || row.enabled !== false),
  );
}

function allRequests(safe: WorkspaceSnapshot): Array<{ collection: Collection; request: RequestDraft }> {
  const out: Array<{ collection: Collection; request: RequestDraft }> = [];
  for (const collection of safe.collections ?? []) {
    for (const request of collection.items ?? []) {
      if (request.url.trim() !== "") out.push({ collection, request });
    }
  }
  return out;
}

/** 保留 {{模板}} 的 query 拼接：{} 不转义，其它字符按 URL 规则编码。 */
function encodeQueryPart(value: string): string {
  return encodeURIComponent(value).replace(/%7B/gi, "{").replace(/%7D/gi, "}");
}

function queryPairs(request: RequestDraft): Array<[string, string]> {
  return usableRows(request.query, true).map((row) => [row.key, row.value] as [string, string]);
}

function fullUrl(request: RequestDraft): string {
  let url = request.url.trim();
  const search = queryPairs(request)
    .map(([key, value]) => `${encodeQueryPart(key)}=${encodeQueryPart(value)}`)
    .join("&");
  if (search !== "") url += `${url.includes("?") ? "&" : "?"}${search}`;
  return url;
}

function headerRows(request: RequestDraft): KeyValue[] {
  return usableRows(request.headers);
}

/** 鉴权值一律用占位符外发，真实 token / 密码不进入任何集合格式。 */
function shareableAuth(auth: AuthSpec): AuthSpec {
  switch (auth.type) {
    case "oauth2":
      return { type: "oauth2", grant: auth.grant, tokenUrl: auth.tokenUrl, scope: auth.scope, clientId: auth.clientId, accessToken: "{{token}}" };
    case "awsSigV4":
      return { type: "awsSigV4", accessKeyId: "<redacted>", secretAccessKey: "<redacted>", region: auth.region, service: auth.service };
    case "mtls":
      return { type: "mtls", serverName: auth.serverName, minTlsVersion: auth.minTlsVersion };
    case "bearer":
      return { type: "bearer", token: "{{token}}" };
    case "basic":
      return { type: "basic", username: auth.username || "{{username}}", password: "{{password}}" };
    case "apiKey":
      return { type: "apiKey", key: auth.key, value: "{{apiKey}}", location: auth.location };
    default:
      return auth;
  }
}

function resolvedAuth(safe: WorkspaceSnapshot, request: RequestDraft): AuthSpec {
  return shareableAuth(resolveRequestAuth(request, safe.collections).auth);
}

function bodyContentType(body: BodySpec): string {
  switch (body.type) {
    case "json": return "application/json";
    case "raw": return body.contentType || "text/plain";
    case "formUrlEncoded": return "application/x-www-form-urlencoded";
    case "formData": return "multipart/form-data";
    case "graphql": return "application/json";
    case "binary": return body.contentType || "application/octet-stream";
    default: return "";
  }
}

function bodyText(body: BodySpec): string {
  switch (body.type) {
    case "json":
    case "raw":
      return body.content;
    case "formUrlEncoded":
      return usableRows(body.items, true)
        .map((row) => `${encodeQueryPart(row.key)}=${encodeQueryPart(row.value)}`)
        .join("&");
    case "formData":
      return usableRows(body.items, true)
        .filter((row) => !(row as { file?: boolean }).file)
        .map((row) => `${encodeQueryPart(row.key)}=${encodeQueryPart(row.value)}`)
        .join("&");
    case "graphql": {
      let variables: unknown = {};
      try { variables = body.variables.trim() === "" ? {} : JSON.parse(body.variables); }
      catch { variables = {}; }
      return JSON.stringify({ query: body.query, variables });
    }
    default:
      return "";
  }
}

function folderParts(folder: string | undefined): string[] {
  return (folder ?? "").split("/").map((part) => part.trim()).filter(Boolean);
}

/** Postman 用 `item`，Insomnia v5 用 `children`；由调用方决定文件夹节点形状。 */
function folderChildren(folder: Json): Json[] {
  return (Array.isArray(folder.item) ? folder.item : folder.children) as Json[];
}

/** 把接口按 folder 路径挂到层级 item 树下，同时登记集合里显式创建的空文件夹。 */
function buildItemTree(
  root: Json[],
  collection: Collection,
  makeRequest: (request: RequestDraft) => Json,
  makeFolder: (name: string) => Json = (name) => ({ name, item: [] }),
): void {
  const ensure = (path: string[]): Json[] => {
    let level = root;
    for (const part of path) {
      let folder = level.find(
        (item) => (Array.isArray(item.item) || Array.isArray(item.children))
          && item.name === part && item.request === undefined,
      );
      if (!folder) {
        folder = makeFolder(part);
        level.push(folder);
      }
      level = folderChildren(folder);
    }
    return level;
  };
  for (const path of collection.folders ?? []) ensure(folderParts(path));
  for (const request of collection.items ?? []) {
    if (request.url.trim() === "") continue;
    ensure(folderParts(request.folder)).push(makeRequest(request));
  }
}

function exportMeta(format: string, version: string): Json {
  return { generator: "Reqora", format, version };
}

// ------------------------------------------------------------ Postman 集合 ----

const POSTMAN_SCHEMAS = {
  "2.1": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  "2.0": "https://schema.getpostman.com/json/collection/v2.0.0/collection.json",
} as const;

function postmanAuth(auth: AuthSpec): Json | null {
  switch (auth.type) {
    case "oauth2":
      return { type: "oauth2", grant: auth.grant, tokenUrl: auth.tokenUrl || "<tokenUrl>", note: "accessToken: <redacted>" };
    case "awsSigV4":
      return { type: "awsSigV4", region: auth.region, service: auth.service, note: "secretAccessKey: <redacted>" };
    case "mtls":
      return { type: "mtls", serverName: auth.serverName || "<serverName>", note: "client certificate: <redacted>" };
    case "bearer":
      return { type: "bearer", bearer: [{ key: "token", value: auth.token, type: "string" }] };
    case "basic":
      return {
        type: "basic",
        basic: [
          { key: "username", value: auth.username, type: "string" },
          { key: "password", value: auth.password, type: "string" },
        ],
      };
    case "apiKey":
      return {
        type: "apikey",
        apikey: [
          { key: "key", value: auth.key, type: "string" },
          { key: "value", value: auth.value, type: "string" },
          { key: "in", value: auth.location, type: "string" },
        ],
      };
    default:
      return null;
  }
}

function postmanBody(body: BodySpec): Json | null {
  switch (body.type) {
    case "json":
      return { mode: "raw", raw: body.content, options: { raw: { language: "json" } } };
    case "raw":
      return {
        mode: "raw",
        raw: body.content,
        options: { raw: { language: body.contentType.includes("xml") ? "xml" : "text" } },
      };
    case "formUrlEncoded":
      return {
        mode: "urlencoded",
        urlencoded: usableRows(body.items).map((row) => ({
          key: row.key, value: row.value, type: "text", disabled: row.enabled === false,
        })),
      };
    case "formData":
      return {
        mode: "formdata",
        formdata: usableRows(body.items).map((row) => {
          const part = row as KeyValue & { file?: boolean; fileName?: string };
          return part.file
            ? { key: row.key, type: "file", src: part.fileName || row.key, disabled: row.enabled === false }
            : { key: row.key, value: row.value, type: "text", disabled: row.enabled === false };
        }),
      };
    case "graphql": {
      let variables: unknown = {};
      try { variables = body.variables.trim() === "" ? {} : JSON.parse(body.variables); }
      catch { variables = {}; }
      return { mode: "graphql", graphql: { query: body.query, variables } };
    }
    case "binary":
      return { mode: "file", file: { src: (body as { fileName?: string }).fileName || "file.bin" } };
    default:
      return null;
  }
}

/** 脚本 / 断言降级为注释，避免把本机脚本方言假装成可执行的 pm.* 代码。 */
function postmanEvents(request: RequestDraft): Json[] {
  const events: Json[] = [];
  const asComments = (text: string, note: string): string[] => [
    `// ${note}`,
    ...text.split(/\r?\n/).map((line) => `// ${line}`),
  ];
  if (request.preScript?.trim()) {
    events.push({
      listen: "prerequest",
      script: { type: "text/javascript", exec: asComments(request.preScript.trim(), "Reqora 前置脚本（请人工核对后启用）") },
    });
  }
  if (request.postScript?.trim() || (request.assertions ?? []).length > 0) {
    const lines = request.postScript?.trim()
      ? asComments(request.postScript.trim(), "Reqora 后置脚本（请人工核对后启用）")
      : [];
    for (const assertion of request.assertions ?? []) {
      lines.push(`// pm.test 等价断言：${JSON.stringify(assertion)}`);
    }
    events.push({ listen: "test", script: { type: "text/javascript", exec: lines } });
  }
  return events;
}

function renderPostmanCollection(safe: WorkspaceSnapshot, version: "2.1" | "2.0"): string {
  const collections = safe.collections ?? [];
  const single = collections.length === 1;
  const name = single ? collections[0].name : "Reqora Export";
  const items: Json[] = [];

  for (const collection of collections) {
    const target: Json[] = single
      ? items
      : (() => {
          const folder: Json = { name: collection.name, item: [] };
          items.push(folder);
          return folder.item as Json[];
        })();
    buildItemTree(target, collection, (request) => {
      const headers: Json[] = headerRows(request).map((row) => ({
        key: row.key, value: row.value, type: "text", disabled: row.enabled === false,
      }));
      const contentType = bodyContentType(request.body);
      if (contentType !== "" && !headers.some((h) => String(h.key).toLowerCase() === "content-type")) {
        headers.unshift({ key: "Content-Type", value: contentType, type: "text" });
      }
      const url: Json = { raw: fullUrl(request) };
      const query = queryPairs(request);
      if (query.length > 0) {
        url.query = usableRows(request.query).map((row) => ({
          key: row.key, value: row.value, disabled: row.enabled === false,
        }));
      }
      const requestObject: Json = {
        method: request.method,
        header: headers,
        url,
        description: request.description || request.doc?.description || "",
      };
      const body = postmanBody(request.body);
      if (body) requestObject.body = body;
      const auth = postmanAuth(resolvedAuth(safe, request));
      if (auth) requestObject.auth = auth;
      const item: Json = { name: request.name, request: requestObject, response: [] };
      const events = postmanEvents(request);
      if (events.length > 0) item.event = events;
      return item;
    });
  }

  const root: Json = {
    info: {
      name,
      schema: POSTMAN_SCHEMAS[version],
      description: `由 Reqora 导出（Postman v${version}）`,
      "x-reqora-export": exportMeta("postman", `v${version}`),
    },
    item: items,
  };
  const variables = environmentRows(safe);
  if (variables.length > 0) {
    root.variable = variables.map((row) => ({
      key: row.key,
      value: row.value,
      type: row.secret === true ? "secret" : "string",
    }));
  }
  return JSON.stringify(root, null, 2);
}

function renderPostmanEnvironment(safe: WorkspaceSnapshot): string {
  const env = activeEnvironment(safe);
  const variables = environmentRows(safe);
  const values = (variables.length > 0
    ? variables
    : [{ id: "baseUrl", key: "baseUrl", value: "", enabled: true } as KeyValue]
  ).map((row) => ({
    key: row.key,
    value: row.value,
    enabled: row.enabled !== false,
    type: row.secret === true ? "secret" : "default",
  }));
  return JSON.stringify({
    id: "reqora-environment",
    name: env?.name || "Reqora 环境",
    values,
    _postman_variable_scope: "environment",
    _exporter_id: "reqora",
    "x-reqora-export": exportMeta("postman", "environment"),
  }, null, 2);
}

// --------------------------------------------------------------- OpenAPI ----

function openApiDocument(safe: WorkspaceSnapshot, version: "3.0.3" | "3.1.0"): Json {
  const document = JSON.parse(exportOpenApi(safe)) as Json;
  const info: Json = isRecord(document.info) ? { ...document.info } : {};
  info["x-reqora-export"] = exportMeta("openapi", version);
  document.info = info;
  if (version === "3.1.0") {
    document.openapi = "3.1.0";
    document.jsonSchemaDialect = "https://json-schema.org/draft/2020-12/schema";
  }
  return document;
}

// ------------------------------------------------- 极简 YAML 序列化器 ----
// 与 transfer.ts 的 parseMinimalYaml 互为逆运算：块映射 / 块列表（- key: value）/
// 双引号标量（JSON.parse 还原转义）/ 流式标量（数组元素全是标量时）。

const PLAIN_YAML_KEY = /^[A-Za-z0-9_./{}$-]+$/;

function yamlKey(key: string): string {
  return PLAIN_YAML_KEY.test(key) && !key.includes(":") ? key : JSON.stringify(key);
}

function isNonEmptyObject(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

function yamlInline(value: unknown): string | null {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    // 极简解析器不支持「纯标量序列项」，这类数组改用流式表示。
    if (value.every(isNonEmptyObject)) return null;
    return JSON.stringify(value);
  }
  if (isRecord(value)) return Object.keys(value).length === 0 ? "{}" : null;
  return JSON.stringify(String(value));
}

function yamlMapLines(object: Json, indent: number): string[] {
  const pad = " ".repeat(indent);
  const out: string[] = [];
  for (const [key, value] of Object.entries(object)) {
    const inline = yamlInline(value);
    if (inline !== null) out.push(`${pad}${yamlKey(key)}: ${inline}`);
    else {
      out.push(`${pad}${yamlKey(key)}:`);
      out.push(...yamlBlockLines(value, indent + 2));
    }
  }
  return out;
}

function yamlBlockLines(value: unknown, indent: number): string[] {
  const pad = " ".repeat(indent);
  if (isRecord(value)) return yamlMapLines(value, indent);
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      const inline = yamlInline(item);
      if (inline !== null) {
        out.push(`${pad}- ${inline}`);
        continue;
      }
      if (Array.isArray(item)) {
        out.push(`${pad}-`);
        out.push(...yamlBlockLines(item, indent + 2));
        continue;
      }
      const entries = Object.entries(item as Json);
      const [firstKey, firstValue] = entries[0];
      const firstInline = yamlInline(firstValue);
      if (firstInline !== null) out.push(`${pad}- ${yamlKey(firstKey)}: ${firstInline}`);
      else {
        out.push(`${pad}- ${yamlKey(firstKey)}:`);
        out.push(...yamlBlockLines(firstValue, indent + 4));
      }
      for (const [key, child] of entries.slice(1)) {
        const childInline = yamlInline(child);
        if (childInline !== null) out.push(`${" ".repeat(indent + 2)}${yamlKey(key)}: ${childInline}`);
        else {
          out.push(`${" ".repeat(indent + 2)}${yamlKey(key)}:`);
          out.push(...yamlBlockLines(child, indent + 4));
        }
      }
    }
    return out;
  }
  return [`${pad}${yamlInline(value) ?? "null"}`];
}

function toYaml(document: Json): string {
  return `${yamlMapLines(document, 0).join("\n")}\n`;
}

// ------------------------------------------------- OpenAPI 3.0 → Swagger 2 ----

const HTTP_METHOD_WORDS = new Set([
  "get", "put", "post", "delete", "options", "head", "patch", "trace",
]);

function swaggerOperation(operation: Json): Json {
  const out: Json = {};
  for (const key of ["summary", "description", "tags", "operationId", "deprecated"]) {
    if (operation[key] !== undefined) out[key] = operation[key];
  }
  const parameters: Json[] = [];
  const consumes = new Set<string>();
  const produces = new Set<string>();

  for (const raw of Array.isArray(operation.parameters) ? operation.parameters : []) {
    if (!isRecord(raw)) continue;
    if (raw.in === "body") {
      parameters.push(raw);
      continue;
    }
    const schema = isRecord(raw.schema) ? raw.schema : {};
    parameters.push(omitUndefined({
      name: raw.name,
      in: raw.in,
      type: schema.type || "string",
      required: raw.required === true || raw.in === "path" ? true : undefined,
      description: raw.description,
      "x-example": raw.example,
    }));
  }

  const requestBody = isRecord(operation.requestBody) ? operation.requestBody : null;
  if (requestBody && isRecord(requestBody.content)) {
    for (const [mime, rawMedia] of Object.entries(requestBody.content)) {
      consumes.add(mime);
      const media = isRecord(rawMedia) ? rawMedia : {};
      const schema = isRecord(media.schema) ? media.schema : {};
      if (mime.includes("x-www-form-urlencoded") || mime.includes("multipart/form-data")) {
        const properties = isRecord(schema.properties) ? schema.properties : {};
        for (const [name, rawProperty] of Object.entries(properties)) {
          const property = isRecord(rawProperty) ? rawProperty : {};
          parameters.push(omitUndefined({
            name,
            in: "formData",
            type: property.format === "binary" ? "file" : property.type || "string",
            required: Array.isArray(schema.required) && schema.required.includes(name) ? true : undefined,
            description: property.description,
            "x-example": property.example,
          }));
        }
      } else {
        parameters.push({
          name: "body",
          in: "body",
          required: requestBody.required === true,
          schema: media.schema ?? { type: "object" },
        });
      }
    }
  }
  if (parameters.length > 0) out.parameters = parameters;
  if (consumes.size > 0) out.consumes = [...consumes];

  const responses: Json = {};
  const sourceResponses = isRecord(operation.responses) ? operation.responses : {};
  for (const [status, rawResponse] of Object.entries(sourceResponses)) {
    const response = isRecord(rawResponse) ? rawResponse : {};
    const entry: Json = { description: response.description ?? "" };
    const examples: Json = {};
    if (isRecord(response.content)) {
      for (const [mime, rawMedia] of Object.entries(response.content)) {
        produces.add(mime);
        const media = isRecord(rawMedia) ? rawMedia : {};
        if (entry.schema === undefined && media.schema !== undefined) entry.schema = media.schema;
        if (media.example !== undefined) examples[mime] = media.example;
      }
    }
    if (Object.keys(examples).length > 0) entry.examples = examples;
    if (isRecord(response.headers)) entry.headers = response.headers;
    responses[status] = entry;
  }
  out.responses = responses;
  if (produces.size > 0) out.produces = [...produces];
  if (Array.isArray(operation.security)) out.security = operation.security;
  return out;
}

function toSwagger2(document: Json): Json {
  const out: Json = { swagger: "2.0" };
  const info: Json = isRecord(document.info) ? { ...document.info } : { title: "Reqora Export", version: "1.0.0" };
  info["x-reqora-export"] = exportMeta("swagger", "2.0");
  out.info = info;

  const servers = Array.isArray(document.servers) ? document.servers : [];
  const first = servers.find(isRecord);
  if (first && typeof first.url === "string") {
    try {
      const parsed = new URL(first.url);
      out.host = parsed.host;
      if (parsed.pathname && parsed.pathname !== "/") out.basePath = parsed.pathname;
      out.schemes = [parsed.protocol.replace(/:$/, "")];
    } catch {
      // {{baseUrl}} 这类模板不是绝对 URL，留给扩展字段。
      out["x-reqora-server"] = first.url;
    }
  }

  const paths: Json = {};
  const sourcePaths = isRecord(document.paths) ? document.paths : {};
  for (const [path, rawPathItem] of Object.entries(sourcePaths)) {
    if (!isRecord(rawPathItem)) continue;
    const pathItem: Json = {};
    for (const [method, rawOperation] of Object.entries(rawPathItem)) {
      if (!HTTP_METHOD_WORDS.has(method.toLowerCase()) || !isRecord(rawOperation)) continue;
      pathItem[method] = swaggerOperation(rawOperation);
    }
    paths[path] = pathItem;
  }
  out.paths = paths;

  const components = isRecord(document.components) ? document.components : {};
  const schemes = isRecord(components.securitySchemes) ? components.securitySchemes : {};
  if (Object.keys(schemes).length > 0) {
    const definitions: Json = {};
    for (const [name, rawScheme] of Object.entries(schemes)) {
      const scheme = isRecord(rawScheme) ? rawScheme : {};
      if (scheme.type === "http") {
        definitions[name] = scheme.scheme === "basic"
          ? { type: "basic" }
          : { type: "apiKey", name: "Authorization", in: "header", description: "Bearer <token>" };
      } else if (scheme.type === "apiKey") {
        definitions[name] = { type: "apiKey", name: scheme.name, in: scheme.in };
      }
    }
    if (Object.keys(definitions).length > 0) out.securityDefinitions = definitions;
  }
  return out;
}

function renderOpenApi(
  safe: WorkspaceSnapshot,
  version: "3.0.3" | "3.1.0",
  style: "json" | "yaml",
): string {
  const document = openApiDocument(safe, version);
  return style === "yaml" ? toYaml(document) : JSON.stringify(document, null, 2);
}

function renderSwagger(safe: WorkspaceSnapshot, style: "json" | "yaml"): string {
  const document = toSwagger2(openApiDocument(safe, "3.0.3"));
  return style === "yaml" ? toYaml(document) : JSON.stringify(document, null, 2);
}

// -------------------------------------------------------------- Insomnia ----

function insomniaRows(rows: readonly KeyValue[] | undefined): Json[] {
  return usableRows(rows).map((row) => ({
    name: row.key, value: row.value, disabled: row.enabled === false,
  }));
}

function insomniaBody(body: BodySpec): Json | null {
  switch (body.type) {
    case "json":
      return { mimeType: "application/json", text: body.content };
    case "raw":
      return { mimeType: body.contentType || "text/plain", text: body.content };
    case "formUrlEncoded":
      return { mimeType: "application/x-www-form-urlencoded", params: insomniaRows(body.items) };
    case "formData":
      return {
        mimeType: "multipart/form-data",
        params: usableRows(body.items).map((row) => {
          const part = row as KeyValue & { file?: boolean; fileName?: string };
          return {
            name: row.key,
            value: part.file ? "" : row.value,
            disabled: row.enabled === false,
            ...(part.file ? { fileName: part.fileName || row.key } : {}),
          };
        }),
      };
    case "graphql": {
      let variables: unknown = {};
      try { variables = body.variables.trim() === "" ? {} : JSON.parse(body.variables); }
      catch { variables = {}; }
      return { mimeType: "application/graphql", text: JSON.stringify({ query: body.query, variables }) };
    }
    case "binary":
      return { mimeType: "application/octet-stream", fileName: (body as { fileName?: string }).fileName || "file.bin" };
    default:
      return null;
  }
}

function insomniaAuth(auth: AuthSpec): Json | null {
  switch (auth.type) {
    case "oauth2":
      return { type: "oauth2", grant: auth.grant, tokenUrl: auth.tokenUrl || "<tokenUrl>", note: "accessToken: <redacted>" };
    case "awsSigV4":
      return { type: "awsSigV4", region: auth.region, service: auth.service, note: "secretAccessKey: <redacted>" };
    case "mtls":
      return { type: "mtls", serverName: auth.serverName || "<serverName>", note: "client certificate: <redacted>" };
    case "bearer":
      return { type: "bearer", token: auth.token, prefix: "Bearer", disabled: false };
    case "basic":
      return { type: "basic", username: auth.username, password: auth.password, disabled: false };
    case "apiKey":
      return {
        type: "apikey", key: auth.key, value: auth.value,
        addTo: auth.location === "query" ? "query" : "header", disabled: false,
      };
    default:
      return null;
  }
}

function insomniaRequest(safe: WorkspaceSnapshot, request: RequestDraft): Json {
  const body = insomniaBody(request.body);
  const authentication = insomniaAuth(resolvedAuth(safe, request));
  return {
    name: request.name,
    url: fullUrl(request),
    method: request.method,
    description: request.description || "",
    headers: insomniaRows(request.headers),
    parameters: [],
    ...(body ? { body } : {}),
    ...(authentication ? { authentication } : {}),
  };
}

function environmentData(safe: WorkspaceSnapshot): Json {
  const data: Json = {};
  for (const row of environmentRows(safe)) data[row.key] = row.value;
  return data;
}

function renderInsomnia(safe: WorkspaceSnapshot, version: "v4" | "v5"): string {
  const collections = safe.collections ?? [];
  const name = collections.length === 1 ? collections[0].name : "Reqora Export";

  if (version === "v4") {
    const resources: Json[] = [
      { _id: "reqora_wrk", _type: "workspace", name, parentId: null },
      {
        _id: "reqora_env", _type: "environment", parentId: "reqora_wrk",
        name: activeEnvironment(safe)?.name || "Reqora 变量",
        data: environmentData(safe), isPrivate: false,
      },
    ];
    const folderIds = new Map<string, string>();
    let counter = 0;
    const ensureFolder = (path: string[], parentId: string): string => {
      let current = parentId;
      let prefix = `${parentId}/`;
      for (const part of path) {
        const key = `${prefix}${part}`;
        let id = folderIds.get(key);
        if (!id) {
          id = `reqora_grp_${++counter}`;
          folderIds.set(key, id);
          resources.push({
            _id: id, _type: "request_group", name: part, parentId: current,
            environment: {}, meta: { sortKey: counter },
          });
        }
        current = id;
        prefix = `${key}/`;
      }
      return current;
    };
    for (const collection of collections) {
      let parentId = "reqora_wrk";
      if (collections.length > 1) parentId = ensureFolder([collection.name], parentId);
      for (const path of collection.folders ?? []) {
        ensureFolder(folderParts(path), parentId);
      }
      for (const request of collection.items ?? []) {
        if (request.url.trim() === "") continue;
        const id = `reqora_req_${++counter}`;
        resources.push({
          _id: id,
          _type: "request",
          parentId: ensureFolder(folderParts(request.folder), parentId),
          meta: { sortKey: counter },
          ...insomniaRequest(safe, request),
        });
      }
    }
    return JSON.stringify({
      __export_format: 4,
      __export_source: "reqora",
      "x-reqora-export": exportMeta("insomnia", "v4"),
      resources,
    }, null, 2);
  }

  const root: Json[] = [];
  for (const collection of collections) {
    const target: Json[] = collections.length === 1
      ? root
      : (() => {
          const folder: Json = { name: collection.name, type: "folder", meta: { id: `reqora_col_${root.length}` }, children: [] };
          root.push(folder);
          return folder.children as Json[];
        })();
    buildItemTree(
      target,
      collection,
      (request) => ({
        type: "request",
        meta: { id: `reqora_req_${request.id}` },
        ...insomniaRequest(safe, request),
      }),
      (name) => ({
        name,
        type: "folder",
        meta: { id: `reqora_folder_${name}` },
        children: [],
      }),
    );
  }
  return JSON.stringify({
    type: "collection.insomnia.rest/5.0",
    name,
    meta: { id: "reqora_collection", description: "由 Reqora 导出" },
    collection: root,
    environments: [{
      name: activeEnvironment(safe)?.name || "Reqora 变量",
      data: environmentData(safe),
      isPrivate: false,
    }],
    "x-reqora-export": exportMeta("insomnia", "v5"),
  }, null, 2);
}

// -------------------------------------------------------------------- HAR ----

function harPostData(body: BodySpec): Json | null {
  switch (body.type) {
    case "json":
      return { mimeType: "application/json", text: body.content };
    case "raw":
      return { mimeType: body.contentType || "text/plain", text: body.content };
    case "formUrlEncoded":
      return {
        mimeType: "application/x-www-form-urlencoded",
        text: bodyText(body),
        params: usableRows(body.items).map((row) => ({ name: row.key, value: row.value })),
      };
    case "formData":
      return {
        mimeType: "multipart/form-data",
        params: usableRows(body.items).map((row) => {
          const part = row as KeyValue & { file?: boolean; fileName?: string };
          return { name: row.key, value: part.file ? "" : row.value, ...(part.file ? { fileName: part.fileName || row.key } : {}) };
        }),
      };
    case "graphql":
      return { mimeType: "application/json", text: bodyText(body) };
    case "binary":
      return { mimeType: body.contentType || "application/octet-stream", text: "" };
    default:
      return null;
  }
}

function renderHar(safe: WorkspaceSnapshot): string {
  const entries = allRequests(safe).map(({ request }) => {
    const postData = harPostData(request.body);
    return {
      startedDateTime: "1970-01-01T00:00:00.000Z",
      time: 0,
      request: {
        method: request.method,
        url: fullUrl(request),
        httpVersion: "HTTP/1.1",
        headers: usableRows(request.headers).map((row) => ({ name: row.key, value: row.value })),
        queryString: usableRows(request.query).map((row) => ({ name: row.key, value: row.value })),
        cookies: [],
        headersSize: -1,
        bodySize: -1,
        ...(postData ? { postData } : {}),
      },
      response: {
        status: 0,
        statusText: "",
        httpVersion: "HTTP/1.1",
        headers: [],
        cookies: [],
        content: { size: 0, mimeType: "" },
        redirectURL: "",
        headersSize: -1,
        bodySize: -1,
      },
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
    };
  });
  return JSON.stringify({
    log: {
      version: "1.2",
      creator: { name: "Reqora", version: "1.0" },
      pages: [],
      entries,
      "x-reqora-export": exportMeta("har", "1.2"),
    },
  }, null, 2);
}

// ------------------------------------------------------------------- cURL ----

function curlCommand(safe: WorkspaceSnapshot, request: RequestDraft): string {
  let url = fullUrl(request);
  const auth = resolvedAuth(safe, request);
  if (auth.type === "apiKey" && auth.location === "query") {
    url += `${url.includes("?") ? "&" : "?"}${encodeQueryPart(auth.key)}=${encodeQueryPart(auth.value)}`;
  }
  const lines = [`curl -X ${request.method} ${shellQuote(url)}`];
  for (const row of headerRows(request)) {
    if (row.enabled === false) continue;
    lines.push(`  -H ${shellQuote(`${row.key}: ${row.value}`)}`);
  }
  if (auth.type === "bearer") {
    lines.push(`  -H ${shellQuote(`Authorization: Bearer ${auth.token}`)}`);
  } else if (auth.type === "basic") {
    lines.push(`  -u ${shellQuote(`${auth.username}:${auth.password}`)}`);
  } else if (auth.type === "apiKey" && auth.location === "header") {
    lines.push(`  -H ${shellQuote(`${auth.key}: ${auth.value}`)}`);
  }
  const contentType = bodyContentType(request.body);
  const text = bodyText(request.body);
  if (contentType !== "") {
    if (!headerRows(request).some((row) => row.key.toLowerCase() === "content-type")) {
      lines.push(`  -H ${shellQuote(`Content-Type: ${contentType}`)}`);
    }
    if (text !== "") lines.push(`  -d ${shellQuote(text)}`);
  }
  if (auth.type === "oauth2") {
    lines.push("  # OAuth 2.0：使用 ${REQORA_TOKEN} 变量，密钥已省略");
  } else if (auth.type === "awsSigV4") {
    lines.push(`  # AWS SigV4：--aws-sigv4 "aws:amz:${auth.region}:${auth.service}"，密钥已省略`);
  } else if (auth.type === "mtls") {
    lines.push("  # mTLS：--cert <client.pem> --key <client.key>，证书已省略");
  }
  return lines.join(" \\\n");
}

function renderCurl(safe: WorkspaceSnapshot): string {
  const blocks = allRequests(safe).map(({ collection, request }) => {
    const location = [collection.name, request.folder, request.name]
      .filter((part) => !!part && String(part).trim() !== "")
      .join(" / ");
    return `# ${location}\n${curlCommand(safe, request)}`;
  });
  return blocks.length > 0
    ? `${blocks.join("\n\n")}\n`
    : "# 工作区中没有可导出的接口\n";
}

// --------------------------------------------- T2.1 · reqora.test.v1 ----

function renderTestAssets(safe: WorkspaceSnapshot): string {
  return toYaml(buildTestAssets(safe) as Json);
}

// ----------------------------------------- T2.2 · Bruno / OpenCollection ----
//
// 两个格式共用一份「降级报告」：脚本方言差异、Reqora 特有断言运算符、
// 非 HTTP 协议（GraphQL / gRPC / MQTT / SOAP / WS / TCP）无法表达的部分
// 一律显式列出，绝不静默丢弃。

const BRUNO_ASSERT_OPS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "contains"]);
const BRUNO_MANIFEST_SCHEMA = "reqora.bruno.v1";

/** 降级报告：每条都说明「具体丢了什么」，供人工核对，不做静默降级。 */
function degradationWarnings(safe: WorkspaceSnapshot): string[] {
  const warnings: string[] = [];
  const scripts: Array<{ owner: string; text: string }> = [];
  for (const { request } of allRequests(safe)) {
    if (request.preScript?.trim()) {
      scripts.push({ owner: `接口「${request.name}」前置脚本`, text: request.preScript });
    }
    if (request.postScript?.trim()) {
      scripts.push({ owner: `接口「${request.name}」后置脚本`, text: request.postScript });
    }
  }
  for (const snippet of safe.scriptLibrary ?? []) {
    if (snippet.code?.trim()) scripts.push({ owner: `脚本片段「${snippet.name}」`, text: snippet.code });
  }
  for (const { owner, text } of scripts) {
    const pm = [...new Set(text.match(/\bpm\.[A-Za-z_$][\w$]*/g) ?? [])];
    if (pm.length > 0) {
      warnings.push(`${owner}含 Postman 方言 ${pm.join(", ")}；Bruno / OpenCollection 无 pm.* 运行时，这些调用不可执行，原文保留供人工改写为 bru.* / 目标工具 API。`);
    }
    const bru = [...new Set(text.match(/\bbru\.[A-Za-z_$][\w$]*/g) ?? [])];
    if (bru.length > 0) {
      warnings.push(`${owner}含 Bruno 方言 ${bru.join(", ")}；与 Reqora / Postman 的 pm.* 运行时不兼容，导入其它工具会失效。`);
    }
  }

  const reqoraOnlyOps = new Set<string>();
  const reqoraOnlySources = new Set<string>();
  for (const { request } of allRequests(safe)) {
    for (const assertion of request.assertions ?? []) {
      if (!BRUNO_ASSERT_OPS.has(assertion.op)) reqoraOnlyOps.add(assertion.op);
      if (assertion.source === "latency" || assertion.source === "text") {
        reqoraOnlySources.add(assertion.source);
      }
    }
  }
  if (reqoraOnlyOps.size > 0) {
    warnings.push(`Reqora 特有断言运算符 ${[...reqoraOnlyOps].sort().join(", ")} 在 Bruno assert / OpenCollection 中没有等价表达，这些断言未带走。`);
  }
  if (reqoraOnlySources.size > 0) {
    warnings.push(`断言来源 ${[...reqoraOnlySources].sort().join(", ")}（耗时 / 全文匹配）无法在目标格式表达，这些断言未带走。`);
  }

  const protocols = new Set<string>();
  let graphql = false;
  for (const { request } of allRequests(safe)) {
    const protocol = request.protocol ?? "http";
    if (protocol !== "http") protocols.add(protocol);
    if (request.body.type === "graphql") graphql = true;
    if (request.mqtt) protocols.add("mqtt 订阅 / 发布语义");
    if (request.soap) protocols.add("SOAP 信封 / WS-Security");
  }
  if (protocols.size > 0 || graphql) {
    warnings.push(`非 HTTP 协议能力未带走：${[...protocols].sort().join("、") || "（无）"}${graphql ? "、GraphQL query/variables 降级为普通 body" : ""}。Bruno .bru 与 OpenCollection 只表达 HTTP 请求；GraphQL / gRPC / MQTT / SOAP / WS / TCP 的请求体、订阅、信封、流式语义无法表达。`);
  }
  warnings.push("集合级继承鉴权、环境级全局 Header、双轨断言中的脚本 test() 结果与运行历史无法在 .bru / OpenCollection 表达，未带走；鉴权值一律以 {{占位符}} 或 <redacted> 表示。");
  return [...new Set(warnings)];
}

function bruPlaceholder(key: string): string {
  const clean = String(key).replace(/[^A-Za-z0-9_]/g, "_");
  return `{{${clean || "secret"}}}`;
}

function bruLine(value: string): string {
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
}

/** 路径段清洗：去掉分隔符 / 控制字符 / 前导点，杜绝目录穿越。 */
function bruPathPart(value: string): string {
  return bruLine(value).replace(/[\\/\x00-\x1f]/g, "_").replace(/^\.+/, "_") || "unnamed";
}

function bruAssertPath(assertion: AssertionSpec): string {
  if (assertion.source === "status") return "res.status";
  if (assertion.source === "header") return `res.headers.${bruLine(assertion.path) || "value"}`;
  if (assertion.source === "latency") return "res.responseTime";
  return bruLine(assertion.path) || "res.body";
}

function bruAssertOp(op: string): string {
  return op === "ne" ? "neq" : op;
}

function bruRequestFile(safe: WorkspaceSnapshot, request: RequestDraft, seq: number): string {
  const blocks: string[] = [];
  blocks.push([
    "meta {",
    `  name: ${bruLine(request.name)}`,
    "  type: http",
    `  seq: ${seq}`,
    "}",
  ].join("\n"));
  blocks.push([
    `${request.method.toLowerCase()} {`,
    `  url: ${bruLine(fullUrl(request))}`,
    `  body: ${request.body.type === "none" ? "none" : "json"}`,
    "  auth: none",
    "}",
  ].join("\n"));
  const headers = headerRows(request);
  if (headers.length > 0) {
    blocks.push([
      "headers {",
      ...headers.map((row) => {
        const value = row.value === "" || SENSITIVE_NAME.test(row.key)
          ? bruPlaceholder(row.key)
          : bruLine(row.value);
        return `  ${row.enabled === false ? "~" : ""}${bruLine(row.key)}: ${value}`;
      }),
      "}",
    ].join("\n"));
  }
  const body = bodyText(request.body);
  if (body !== "") {
    blocks.push([
      "body:json {",
      ...body.split(/\r?\n/).map((line) => `  ${line}`),
      "}",
    ].join("\n"));
  }
  const vars = environmentRows(safe);
  if (vars.length > 0) {
    blocks.push([
      "vars:pre-request {",
      ...vars.map((row) => `  ${bruLine(row.key)}: ${bruPlaceholder(row.key)}`),
      "}",
    ].join("\n"));
  }
  const assertions = request.assertions ?? [];
  if (assertions.length > 0) {
    blocks.push([
      "assert {",
      ...assertions.map((assertion) =>
        `  ${bruAssertPath(assertion)}: ${bruAssertOp(assertion.op)} ${bruLine(assertion.value)}`),
      "}",
    ].join("\n"));
  }
  if (request.preScript?.trim()) {
    blocks.push([
      "script:pre-request {",
      ...request.preScript.split(/\r?\n/).map((line) => `  ${line}`),
      "}",
    ].join("\n"));
  }
  if (request.postScript?.trim()) {
    blocks.push([
      "tests {",
      ...request.postScript.split(/\r?\n/).map((line) => `  ${line}`),
      "}",
    ].join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}

/**
 * Bruno 是多文件目录格式，但渲染器只能返回 string：这里返回一个**确定的
 * JSON 文件清单**（files{相对路径:内容}），由 `reqora export --all` 展开成
 * 真实目录。降级报告同时写进 warnings[] 与 WARNINGS.md。
 */
function renderBruno(safe: WorkspaceSnapshot): string {
  const warnings = degradationWarnings(safe);
  const files: Record<string, string> = {};
  const used = new Set<string>();
  const addFile = (path: string, content: string): void => {
    let target = path;
    let suffix = 2;
    while (used.has(target)) {
      target = `${path.replace(/\.bru$/, "")}-${suffix}.bru`;
      suffix += 1;
    }
    used.add(target);
    files[target] = content;
  };

  const collections = safe.collections ?? [];
  const rootName = collections.length === 1 ? collections[0].name : "Reqora Export";
  files["bruno.json"] = `${JSON.stringify(
    { version: "1", name: rootName, type: "collection" }, null, 2,
  )}\n`;

  let seq = 0;
  for (const collection of collections) {
    const prefix = collections.length === 1 ? [] : [bruPathPart(collection.name)];
    const folderPaths = new Set<string>();
    for (const folder of collection.folders ?? []) folderPaths.add(folder);
    for (const request of collection.items ?? []) {
      if (request.url.trim() === "") continue;
      const parts = [...prefix, ...folderParts(request.folder).map(bruPathPart)];
      addFile(
        [...parts, `${bruPathPart(request.name)}.bru`].join("/"),
        bruRequestFile(safe, request, ++seq),
      );
      if (parts.length > 0) folderPaths.add(parts.join("/"));
    }
    for (const folder of [...folderPaths].sort()) {
      const path = `${folder}/folder.bru`;
      if (used.has(path)) continue;
      addFile(path, `meta {\n  name: ${bruLine(folder.split("/").pop() ?? folder)}\n  type: folder\n}\n`);
    }
  }
  files["WARNINGS.md"] = `# Reqora → Bruno 降级报告\n\n${warnings.map((line) => `- ${line}`).join("\n")}\n`;
  return JSON.stringify({ schema: BRUNO_MANIFEST_SCHEMA, files, warnings }, null, 2);
}

/** OpenCollection 是单文件 YAML，走常规 renderExport 返回字符串。 */
function renderOpenCollection(safe: WorkspaceSnapshot): string {
  const warnings = degradationWarnings(safe);
  const collections = safe.collections ?? [];
  const requests: Json[] = allRequests(safe).map(({ collection, request }) => omitUndefined({
    name: request.name,
    folder: [collection.name, request.folder]
      .filter((part) => !!part && String(part).trim() !== "").join(" / ") || undefined,
    method: request.method,
    url: fullUrl(request),
    protocol: request.protocol,
    headers: headerRows(request).map((row) => omitUndefined({
      key: row.key,
      value: row.value === "" || SENSITIVE_NAME.test(row.key) ? bruPlaceholder(row.key) : row.value,
      enabled: row.enabled,
    })),
    body: bodyText(request.body) || undefined,
    assertions: (request.assertions ?? []).map((assertion) => omitUndefined({
      name: assertion.name, source: assertion.source, path: assertion.path,
      op: assertion.op, value: assertion.value,
    })),
    preScript: request.preScript,
    postScript: request.postScript,
  }));
  return toYaml({
    opencollection: "1.0.0",
    info: {
      name: collections.length === 1 ? collections[0].name : "Reqora Export",
      summary: "由 Reqora 导出；warnings[] 列出未带走的降级项",
      "x-reqora-export": exportMeta("opencollection", "1.0.0"),
    },
    variables: environmentRows(safe).map((row) => ({
      key: row.key,
      value: bruPlaceholder(row.key),
      secret: row.secret === true,
    })),
    requests,
    warnings: warnings.map((message, index) => ({ code: `DEGRADE-${index + 1}`, message })),
  });
}
