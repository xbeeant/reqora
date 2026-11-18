import type { RequestDraft, RequestDoc, WorkspaceSnapshot } from "../types";
import { emptyDoc } from "./docDefaults.ts";
import { deriveParamSections } from "./docs.ts";
import { responseParamTables } from "./responseParams.ts";
import { substitute } from "./template.ts";
import { enforcePrivate, privateContext, shareableVariables } from "./privateValues.ts";
import { CODE_LANGUAGES, generateCode } from "./codegen.ts";
import { buildCodeTemplateContext, renderCodeTemplate } from "./codeTemplate.ts";
import {
  DOC_SITE_ERROR_CODE_COLUMNS,
  docPageGroupLabel,
  errorCodeRowsForTable,
  normalizeDocPages,
} from "./docPages.ts";

/**
 * 文档站规范化层 —— 桌面端预览、单文件 HTML 导出、Markdown 导出、网页版
 * 共用同一份 DocSitePayload。网页版不跑 Tauri、不读 useWorkspace，只拿这份
 * JSON 交给 DocSiteViewer；因此后端不需要任何 HTML 渲染逻辑。
 *
 * 安全边界在这里一次收口：凭据类环境变量不参与替换，鉴权头不进入代码片段，
 * 脚本 / 断言 / 本地专属字段从不进入 payload。
 */

export interface DocSiteParamRow {
  name: string;
  type: string;
  required: boolean;
  example: string;
  description: string;
  /**
   * 字段所在位置（query / header / body）。响应 Header 表靠它走「平铺行」
   * 分支，不再被误当 body 字段树嵌套；旧 payload 缺该字段时为空串。
   */
  location?: string;
}

export interface DocSiteTable {
  label: string;
  rows: DocSiteParamRow[];
}

export interface DocSiteSnippet {
  id: string;
  label: string;
  code: string;
}

export interface DocSiteBody {
  label: string;
  text: string;
  lang: string;
}

export interface DocSiteResponse {
  id: string;
  name: string;
  status: number;
  description: string;
  text: string;
  lang: string;
  /** Per-example response field tables (Body / Header). Empty for legacy payloads. */
  tables: DocSiteTable[];
}

export interface DocSiteRequest {
  id: string;
  name: string;
  method: string;
  url: string;
  /** 集合内的文件夹路径（"父/子"）；"" 表示集合根。仅用于分组排序与展示。 */
  folder: string;
  summary: string;
  description: string;
  tables: DocSiteTable[];
  body: DocSiteBody | null;
  responses: DocSiteResponse[];
  snippets: DocSiteSnippet[];
}

export interface DocSiteCollection {
  id: string;
  name: string;
  requests: DocSiteRequest[];
}

export interface DocSiteChapter {
  id: string;
  slug: string;
  title: string;
  group: string;
  groupLabel: string;
  body: string;
  errorCodes: { columns: readonly string[]; rows: string[][] };
}

export interface DocSitePayload {
  version: 1;
  title: string;
  generatedAt: string;
  chapters: DocSiteChapter[];
  collections: DocSiteCollection[];
  totalRequests: number;
}

const SENSITIVE_VARIABLE =
  /(token|secret|password|passwd|pwd|api[-_]?key|credential|authorization|cookie|private)/i;

const SENSITIVE_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|x-csrf-token|token)$/i;

/**
 * 只保留可以安全公开的 {{变量}}。命中敏感词的不替换，模板字面量原样留在
 * 文档里，读者仍能看出「这里要填令牌」，但不会拿到真实值。
 */
export function publicVariables(variables: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(variables ?? {})) {
    if (!SENSITIVE_VARIABLE.test(key)) out[key] = value;
  }
  return out;
}

/** 变量替换后的 URL（含启用的 query 行）。静态 HTML 导出复用同一函数。 */
export function resolveRequestUrl(
  request: RequestDraft,
  variables: Record<string, string>,
  resolvedUrl?: string,
): string {
  let url = resolvedUrl || substitute(request.url, variables);
  const search = new URLSearchParams();
  for (const row of request.query ?? []) {
    if (!row.enabled || !row.key.trim()) continue;
    const key = substitute(row.key, variables);
    // 查询参数里的凭据同样不能进公开文档：保留参数名，值换成占位符。
    const value = SENSITIVE_VARIABLE.test(key)
      ? "<请自行填写>"
      : substitute(row.value, variables);
    search.append(key, value);
  }
  const encoded = search.toString();
  if (encoded) url += (url.includes("?") ? "&" : "?") + encoded;
  return url;
}

/**
 * 对外参数表只描述真正会发送的行：禁用的 query / header / form 行不进文档站，
 * 与 URL、请求体投影、代码片段的口径保持一致。编辑器内的文档视图仍展示全部行，
 * 便于给历史字段补写说明。
 */
function onlyEnabledRows(request: RequestDraft): RequestDraft {
  const next: RequestDraft = {
    ...request,
    query: (request.query ?? []).filter((row) => row.enabled !== false),
    headers: (request.headers ?? []).filter((row) => row.enabled !== false),
  };
  const body = request.body;
  if (body.type === "formUrlEncoded") {
    next.body = { ...body, items: body.items.filter((item) => item.enabled !== false) };
  } else if (body.type === "formData") {
    next.body = { ...body, items: body.items.filter((item) => item.enabled !== false) };
  }
  return next;
}

/** 生成代码片段时用的脱敏副本：不带鉴权、不带敏感请求头。 */
function safeForCode(request: RequestDraft): RequestDraft {
  return {
    ...request,
    auth: { type: "none" },
    headers: (request.headers ?? []).filter(
      (row) => !SENSITIVE_HEADER.test(row.key.trim()),
    ),
  };
}

function bodyProjection(request: RequestDraft, variables: Record<string, string>): DocSiteBody | null {
  const body = request.body;
  switch (body.type) {
    case "none":
      return null;
    case "json":
      return { label: "请求体（JSON）", text: substitute(body.content, variables), lang: "json" };
    case "raw":
      return {
        label: "请求体",
        text: substitute(body.content, variables),
        lang: body.contentType.includes("json") ? "json" : "",
      };
    case "formUrlEncoded":
      return {
        label: "请求体（表单）",
        text: body.items
          .filter((row) => row.enabled && row.key.trim())
          .map((row) => `${row.key}=${row.value}`)
          .join("\n"),
        lang: "",
      };
    case "formData":
      return {
        label: "请求体（form-data）",
        text: body.items
          .filter((row) => row.enabled && row.key.trim())
          .map((row) => (row.file ? `${row.key}=(文件 ${row.fileName || "?"})` : `${row.key}=${row.value}`))
          .join("\n"),
        lang: "",
      };
    case "graphql":
      return {
        label: "请求体（GraphQL）",
        text: `${body.query}\n# variables: ${body.variables}`,
        lang: "graphql",
      };
    case "binary":
      return {
        label: "请求体（二进制文件）",
        text: `(二进制文件：${body.fileName}，${body.contentType})`,
        lang: "",
      };
  }
}

function requestProjection(
  request: RequestDraft,
  variables: Record<string, string>,
  templates: { name: string; content: string }[],
): DocSiteRequest {
  const doc: RequestDoc = request.doc ?? emptyDoc();
  const safe = safeForCode(request);
  // 代码片段刻意用空变量表：URL 里的 {{baseUrl}}、体里的 {{token}} 保留为模板，
  // 既不泄露当前环境，也便于读者直接复制后自行填值。
  const context = buildCodeTemplateContext(safe, {});
  const snippets: DocSiteSnippet[] = CODE_LANGUAGES.map((item) => ({
    id: `builtin:${item.id}`,
    label: item.label,
    code: generateCode(safe, item.id, {}),
  }));
  for (const template of templates) {
    if (!template.content.trim()) continue;
    snippets.push({
      id: `tpl:${template.name}`,
      label: template.name,
      code: renderCodeTemplate(template.content, context).code,
    });
  }

  return {
    id: request.id,
    name: request.name || "未命名请求",
    method: request.method.toUpperCase(),
    url: resolveRequestUrl(request, variables),
    folder: (request.folder ?? "").trim(),
    summary: doc.summary ?? "",
    description: doc.description?.trim() ? doc.description : (request.description ?? ""),
    tables: deriveParamSections(onlyEnabledRows(request), doc)
      .filter((section) => section.rows.length > 0)
      .map((section) => ({
        label: section.label,
        rows: section.rows.map((row) => ({
          name: row.name,
          type: row.meta.type || "string",
          required: row.meta.required,
          // 文档仍需展示「要带 Authorization」，但不能把真实令牌值发布出去。
          example:
            row.location === "header" && SENSITIVE_HEADER.test(row.name.trim())
              ? "<请自行填写>"
              : row.meta.example ?? "",
          description: row.meta.description ?? "",
          location: row.location,
        })),
      })),
    body: bodyProjection(request, variables),
    responses: (doc.responses ?? []).map((example) => ({
      id: example.id,
      name: example.name,
      status: example.status,
      description: example.description ?? "",
      text: example.body ?? "",
      lang: (example.contentType ?? "").includes("json") ? "json" : "",
      tables: responseParamTables(example.params).map((table) => ({
        label: table.label,
        rows: table.rows.map((row) => ({
          name: row.name,
          type: row.type || "string",
          required: row.required,
          // 响应头示例值可能是凭据：只保留字段名，值留给读者自行填写。
          example:
            table.location === "header" &&
            row.example.trim() !== "" &&
            SENSITIVE_HEADER.test(row.name.trim())
              ? "<请自行填写>"
              : row.example,
          description: row.description,
          // 响应 Header 行保留 location，网页版据此按平铺行渲染而非 body 字段树。
          location: row.location,
        })),
      })),
    })),
    snippets,
  };
}

export interface BuildDocSiteOptions {
  title?: string;
  /** 覆盖环境变量；缺省取活动环境。敏感变量会被 publicVariables 过滤。 */
  variables?: Record<string, string>;
  /** 便于测试固定时间戳。 */
  now?: Date;
}

/** 把工作区投影成唯一一份文档数据。桌面端与网页版都从这里出发。 */
export function buildDocSitePayload(
  snapshot: WorkspaceSnapshot,
  options: BuildDocSiteOptions = {},
): DocSitePayload {
  const environment = snapshot.environments?.find(
    (item) => item.id === snapshot.activeEnvironmentId,
  );
  // 私密变量（secret === true）的值绝不进入文档：网页版 payload、HTML /
  // Markdown 导出都从这里出发。调用方显式传入的 variables 也按私密变量名
  // 再过滤一次，避免本地调试导出绕过这层收口。{{模板}} 会保持字面量，
  // 读者仍能看到需要填写的变量名。
  const privateCtx = privateContext(snapshot);
  const sourceVariables =
    options.variables ?? shareableVariables(environment?.variables ?? []);
  const variables = publicVariables(
    Object.fromEntries(
      Object.entries(sourceVariables).filter(
        ([key]) => !privateCtx.keys.has(key.trim()),
      ),
    ),
  );
  const templates = (snapshot.codeTemplates ?? []).map((item) => ({
    name: item.name,
    content: item.content,
  }));

  const chapters: DocSiteChapter[] = normalizeDocPages(snapshot.docPages).map((page) => ({
    id: page.id,
    slug: page.slug,
    title: page.title,
    group: page.group,
    groupLabel: docPageGroupLabel(page.group),
    body: page.body,
    errorCodes: {
      columns: DOC_SITE_ERROR_CODE_COLUMNS,
      rows: errorCodeRowsForTable(page),
    },
  }));

  const collections: DocSiteCollection[] = (snapshot.collections ?? []).map((collection) => ({
    id: collection.id,
    name: collection.name,
    requests: (collection.items ?? []).map((request) =>
      requestProjection(request, variables, templates),
    ),
  }));

  const payload: DocSitePayload = {
    version: 1,
    title: options.title ?? "API 文档",
    generatedAt: (options.now ?? new Date()).toISOString(),
    chapters,
    collections,
    totalRequests: collections.reduce((sum, item) => sum + item.requests.length, 0),
  };
  // 出口兜底：请求定义里直接硬编码（而非 {{模板}}）的私密值、参数表示例、
  // 文档正文同样不能进入公开文档。无私密变量时逐字段原样复制，输出不变。
  return enforcePrivate(payload, privateCtx) as DocSitePayload;
}

// ---------------------------------------------------- 文件夹分组 ----

export interface DocSiteFolderGroup<T> {
  /** 完整文件夹路径；"" 表示集合根（未放入文件夹的接口）。 */
  folder: string;
  /** 展示名：路径最后一段。 */
  name: string;
  /** 路径深度：根组为 0，"a" 为 1，"a/b" 为 2。 */
  depth: number;
  requests: T[];
}

/**
 * 按文件夹路径把接口分组，顺序与侧边栏一致：未入文件夹的接口排最前，
 * 文件夹按路径 `localeCompare` 字母序（与 Sidebar.buildFolderTree 相同），
 * 组内保持原有数组顺序。分组与文件夹顺序对齐后，文档站预览 / 网页版 /
 * 单文件 HTML 导出 / Markdown 导出共用这一个排序实现，避免四处漂移。
 */
export function folderGroups<T extends { folder?: string | undefined }>(
  requests: T[],
): DocSiteFolderGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const request of requests) {
    const folder = (request.folder ?? "").trim();
    const list = map.get(folder) ?? [];
    list.push(request);
    map.set(folder, list);
  }
  const paths = [...map.keys()].sort((a, b) => {
    if (a === "") return -1;
    if (b === "") return 1;
    return a.localeCompare(b);
  });
  return paths.map((folder) => {
    const segments = folder.split("/").map((segment) => segment.trim()).filter(Boolean);
    return {
      folder,
      name: segments[segments.length - 1] ?? "",
      depth: segments.length,
      requests: map.get(folder) as T[],
    };
  });
}

export interface FolderOutlineNode<T> {
  /** 完整文件夹路径；"" 表示集合根（未放入文件夹的接口）。 */
  path: string;
  /** 展示名：路径最后一段（根节点为 ""）。 */
  name: string;
  /** 路径深度：根节点为 0，"a" 为 1，"a/b" 为 2。 */
  depth: number;
  /**
   * 该节点子树内的接口总数（含自身叶子）。HTML / Markdown / 网页版正文的
   * 「N 个接口」标签直接取它，避免三处各写一遍子树计数。
   */
  count: number;
  /** 挂在该节点下的接口；纯父级标题节点为 []。 */
  requests: T[];
}

/**
 * 把 folderGroups 的平铺分组展开成**层级大纲**：多级文件夹路径（如 "a/b/c"）
 * 会逐级生成父级标题节点（"a"、"a/b"），兄弟分组共享的父级只生成一次，
 * 叶子节点携带该文件夹下的接口。渲染层据此画多级缩进的文件夹标题。
 *
 * 依赖 folderGroups 的排序保证：同前缀的子文件夹在序列中相邻（字典序），
 * 因此父级标题总是出现在其所有子级之前。
 */
export function folderOutline<T extends { folder?: string | undefined }>(
  groups: DocSiteFolderGroup<T>[],
): FolderOutlineNode<T>[] {
  const emitted = new Set<string>();
  const nodes: FolderOutlineNode<T>[] = [];
  for (const group of groups) {
    if (group.folder === "") {
      nodes.push({ path: "", name: "", depth: 0, count: 0, requests: group.requests });
      continue;
    }
    const segments = group.folder.split("/").map((segment) => segment.trim()).filter(Boolean);
    for (let index = 1; index <= segments.length; index += 1) {
      const path = segments.slice(0, index).join("/");
      if (emitted.has(path)) continue;
      emitted.add(path);
      nodes.push({ path, name: segments[index - 1], depth: index, count: 0, requests: [] });
    }
    const path = segments.join("/");
    nodes.push({
      path,
      name: segments[segments.length - 1] ?? "",
      depth: segments.length,
      count: 0,
      requests: group.requests,
    });
  }
  // 子树计数一次算好：标题节点统计所有路径等于它或以它为前缀的叶子接口。
  // 渲染层（HTML 正文 / 网页版正文）直接读 node.count，不再各自 filter 一遍。
  const leaves = nodes
    .filter((node) => node.requests.length > 0)
    .map((node) => ({ path: node.path, count: node.requests.length }));
  for (const node of nodes) {
    node.count = leaves.reduce(
      (sum, leaf) =>
        sum +
        (leaf.path === node.path ||
        (node.path !== "" && leaf.path.startsWith(`${node.path}/`))
          ? leaf.count
          : 0),
      0,
    );
  }
  return nodes;
}

/**
 * 判断某路径是否有祖先被折叠（用于可折叠文件夹视图）：
 * "a/b/c" 的祖先前缀是 "a" 与 "a/b"，任一在 collapsed 集合中即被隐藏。
 */
export function folderHiddenByAncestor(path: string, collapsed: ReadonlySet<string>): boolean {
  const segments = path.split("/");
  let prefix = "";
  for (let index = 0; index < segments.length - 1; index += 1) {
    prefix = prefix ? `${prefix}/${segments[index]}` : segments[index];
    if (collapsed.has(prefix)) return true;
  }
  return false;
}

// ------------------------------------------------ 公开 payload 校验 ----

const MAX_CHAPTERS = 200;
const MAX_REQUESTS = 1000;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 网页版从服务端拿到的是不可信 JSON：这里做有界归一化，
 * 既保证旧版本 payload 可读，也避免异常数据把渲染器撑爆。
 */
export function normalizeDocSitePayload(raw: unknown): DocSitePayload | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.collections)) return null;

  let remaining = MAX_REQUESTS;
  const collections: DocSiteCollection[] = value.collections
    .slice(0, 200)
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((collection) => {
      const requests = Array.isArray(collection.requests) ? collection.requests : [];
      const limited: DocSiteRequest[] = requests
        .slice(0, Math.max(0, remaining))
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
        .map((request) => {
          remaining -= 1;
          const tables = Array.isArray(request.tables) ? request.tables : [];
          const responses = Array.isArray(request.responses) ? request.responses : [];
          const responseRows = (value: Record<string, unknown>): DocSiteParamRow[] =>
            (Array.isArray(value.rows) ? value.rows : [])
              .slice(0, 200)
              .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
              .map((row) => ({
                name: text(row.name),
                type: text(row.type),
                required: row.required === true,
                example: text(row.example),
                description: text(row.description),
                // 与 buildDocSitePayload 对齐：保留 location 供网页版区分 Header 平铺行。
                location: text(row.location),
              }));
          const snippets = Array.isArray(request.snippets) ? request.snippets : [];
          const body = request.body as Record<string, unknown> | null;
          return {
            id: text(request.id),
            name: text(request.name) || "未命名请求",
            method: text(request.method) || "GET",
            url: text(request.url),
            folder: text(request.folder).trim(),
            summary: text(request.summary),
            description: text(request.description),
            tables: tables
              .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
              .map((table) => ({
                label: text(table.label),
                rows: responseRows(table),
              })),
            body:
              body && typeof body === "object"
                ? { label: text(body.label), text: text(body.text), lang: text(body.lang) }
                : null,
            responses: responses
              .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
              .map((response) => ({
                id: text(response.id),
                name: text(response.name),
                status: typeof response.status === "number" ? response.status : 0,
                description: text(response.description),
                text: text(response.text),
                lang: text(response.lang),
                tables: (Array.isArray(response.tables) ? response.tables : [])
                  .slice(0, 20)
                  .filter((table): table is Record<string, unknown> => !!table && typeof table === "object")
                  .map((table) => ({
                    label: text(table.label),
                    rows: responseRows(table),
                  })),
              })),
            snippets: snippets
              .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
              .map((snippet) => ({
                id: text(snippet.id),
                label: text(snippet.label),
                code: text(snippet.code),
              })),
          };
        });
      return { id: text(collection.id), name: text(collection.name), requests: limited };
    });

  const rawChapters = Array.isArray(value.chapters) ? value.chapters.slice(0, MAX_CHAPTERS) : [];
  const chapters: DocSiteChapter[] = rawChapters
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((chapter) => {
      const codes = chapter.errorCodes as Record<string, unknown> | null;
      return {
        id: text(chapter.id),
        slug: text(chapter.slug) || "section",
        title: text(chapter.title) || "未命名章节",
        group: text(chapter.group) || "guide",
        groupLabel: text(chapter.groupLabel) || "指南",
        body: text(chapter.body),
        errorCodes: {
          columns: DOC_SITE_ERROR_CODE_COLUMNS,
          rows:
            codes && Array.isArray(codes.rows)
              ? codes.rows.map((row: unknown) =>
                  Array.isArray(row) ? row.map((cell: unknown) => text(cell)) : [],
                )
              : [],
        },
      };
    });

  return {
    version: 1,
    title: text(value.title) || "API 文档",
    generatedAt: text(value.generatedAt),
    chapters,
    collections,
    totalRequests: collections.reduce((sum, item) => sum + item.requests.length, 0),
  };
}
