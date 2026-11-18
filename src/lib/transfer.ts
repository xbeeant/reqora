/**
 * 自包含的导入/导出转换库（纯函数、无副作用、零新增依赖）。
 *
 * - 导入：Postman Collection v2.x（变量写法归一化：{{name}} / ::name / :name 路径
 *   变量 / {{$动态变量}} 映射）/ Postman 环境文件 /
 *   OpenAPI 3.0.x（JSON 与常见 YAML 子集）/ HAR 1.2 / cURL 命令
 * - 导出：OpenAPI 3.0 JSON / Markdown 接口文档
 * - 检测：detectFormat 启发式判断输入格式
 * - 预览：previewImport 纯函数只读解析，供 UI 在用户确认前展示摘要
 *
 * 所有导入函数返回统一结构 ImportResult；无法识别的字段宽容处理并记入 warnings，
 * 致命问题（无法解析）抛出带中文说明的 Error。
 */
import type {
  AuthSpec,
  BodySpec,
  Collection,
  Environment,
  FormPart,
  HttpMethod,
  KeyValue,
  ParamMeta,
  RequestDoc,
  RequestDraft,
  ResponseExample,
  ResponseParam,
  WorkspaceSnapshot,
} from "../types";
import { HTTP_METHODS } from "../types.ts";
// 显式 .ts 扩展名：与 defaults.ts 一致，Node 原生 TS 剥离（bun run test）需要真实路径，
// Vite/tsc bundler 解析同样接受。
import { uid } from "./id.ts";
import { DYNAMIC_VARIABLES } from "./dynamic.ts";
import {
  responseParamsToHeaders,
  responseParamsToSchema,
  schemaToResponseParams,
} from "./responseParams.ts";
import { requestBodyFieldTreeRows, responseParamTreeRows, TREE_INDENT } from "./responseParamTree.ts";
import { resolveRequestAuth } from "./auth.ts";
import { isPrivateVariable, maskPrivateText, privateContext } from "./privateValues.ts";
import {
  buildDocSitePayload,
  folderGroups,
  folderOutline,
  type DocSiteParamRow,
  type DocSiteRequest,
} from "./docSitePayload.ts";
import { decodeTestAssets } from "./testAssets.ts";
import type { TestAssetsDocument } from "./testAssets.ts";

/** 统一的导入结果：集合/环境均不带 id（由调用方生成），warnings 为中文提示。 */
export interface ImportResult {
  collections: Omit<Collection, "id">[];
  environments: Omit<Environment, "id">[];
  warnings: string[];
  /** T2.1：原生测试资产导入时的只读附加载荷；既有导入器不填。 */
  testAssets?: TestAssetsDocument;
}

// ------------------------------------------------------------ 小工具 ----

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** Postman 的 description 可能是字符串，也可能是 { content } 对象。 */
function postmanDescription(v: unknown): string {
  if (typeof v === "string") return v;
  const rec = asRecord(v);
  return rec && typeof rec.content === "string" ? rec.content : "";
}

function row(key: string, value: string, enabled = true): KeyValue {
  return { id: uid(), key, value, enabled };
}

/**
 * Postman 的变量写法不止一种，导入时统一归一化为 Reqora 的 “{{name}}”：
 *
 * 1. 标准写法 “{{name}}” 原样保留；
 * 2. 部分集合 / 导出会写成 “::name”，归一化为 “{{name}}”（标识符约束 +
 *    lookbehind 用于避开 http:// 、IPv6 [::1] 与单冒号路径变量 :id）；
 * 3. Postman 专有动态变量 “{{$randomXxx}}” 大多已是 Reqora 内置变量，原样
 *    保留；仅语义不同的少数 token 走 POSTMAN_DYNAMIC_MAP 改写，没有等价实现
 *    的保留原样并在导入结果里给出 warning。
 * 4. 单冒号路径变量 “:id” 只在其名称出现在 Postman 的变量声明
 *    （url.variable 或集合 / 分组 variable）里时才转为 “{{id}}”，
 *    见 convertPostmanPathParams。
 */
const POSTMAN_COLON_VAR = /(?<!:)::([A-Za-z_$][A-Za-z0-9_.$-]*)/g;

const POSTMAN_DYNAMIC_TOKEN = /\{\{\s*\$([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Postman → Reqora 动态变量映射。Reqora 现已原生支持 Postman 的动态变量目录
 * （见 `src/lib/dynamicPostman.ts`），所以这里只改写语义确实不同的 token，
 * 其余一律保留原写法，导入后仍可直接使用。
 */
const POSTMAN_DYNAMIC_MAP: Record<string, string> = {
  // Postman 的 {{$timestamp}} 是毫秒级 Unix 时间戳，Reqora 的 $timestamp 是秒级。
  timestamp: "timestampMs",
};

/** Reqora 内置动态变量的名字集合（去掉参数括号部分），用于未知 token 警告。 */
const REQORA_DYNAMIC_NAMES = new Set(
  DYNAMIC_VARIABLES.map((item) => item.key.replace(/\(.*$/, "")),
);

function normalizePostmanVar(s: string): string {
  return s
    .replace(POSTMAN_COLON_VAR, "{{$1}}")
    .replace(POSTMAN_DYNAMIC_TOKEN, (whole, name: string) => {
      const mapped = POSTMAN_DYNAMIC_MAP[name];
      return mapped ? `{{$${mapped}}}` : whole;
    });
}

/** 检查导入内容里是否有 Reqora 不认识的 “{{$token}}”，统一提示一次。 */
function warnUnknownDynamicTokens(text: string, warnings: string[]): void {
  const unknown = new Set<string>();
  for (const match of text.matchAll(POSTMAN_DYNAMIC_TOKEN)) {
    if (!REQORA_DYNAMIC_NAMES.has(`$${match[1]}`) && !(match[1] in POSTMAN_DYNAMIC_MAP)) {
      unknown.add(`{{$${match[1]}}}`);
    }
  }
  if (unknown.size > 0) {
    warnings.push(
      `Postman 动态变量 ${[...unknown].join("、")} 在 Reqora 中没有等价实现，已原样保留；` +
        "可改为 Reqora 内置动态变量（如 {{$randomInt}}、{{$guid}}）或环境变量",
    );
  }
}

/** 递归把导入结果里所有字符串的 “::name” 统一成 “{{name}}”。 */
function normalizeImportedStrings<T>(value: T): T {
  if (typeof value === "string") return normalizePostmanVar(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => normalizeImportedStrings(item)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = normalizeImportedStrings(child);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * 收集 Postman 集合的 `variable` 或环境文件的 `values`：
 * [{ key, value, disabled?, type? }]。同名变量后出现的（更内层作用域）覆盖。
 */
function collectPostmanVariables(entries: unknown, out: KeyValue[]): void {
  for (const entry of asArray(entries)) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const key = asString(rec.key);
    if (isBlank(key)) continue;
    const next = row(key, normalizePostmanVar(asString(rec.value)), rec.disabled !== true);
    const existing = out.findIndex((item) => item.key === key);
    if (existing >= 0) out[existing] = next;
    else out.push(next);
  }
}

/** 组装一份完整的 RequestDraft（不产生占位空行，字段全部显式给出）。 */
function newDraft(partial: Partial<RequestDraft> & { name: string }): RequestDraft {
  return {
    id: uid(),
    name: partial.name,
    description: partial.description ?? "",
    folder: partial.folder ?? "",
    method: partial.method ?? "GET",
    url: partial.url ?? "",
    headers: partial.headers ?? [],
    query: partial.query ?? [],
    body: partial.body ?? { type: "none" },
    auth: partial.auth ?? { type: "none" },
    doc: partial.doc,
    updatedAt: 0,
  };
}

function baseDoc(): RequestDoc {
  return {
    summary: "",
    description: "",
    owner: "",
    status: "开发中",
    tags: [],
    paramMeta: {},
    responses: [],
    updatedAt: 0,
  };
}

/** 安全地 decodeURIComponent，失败时原样返回。 */
function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/** 解析 a=1&b=2 形式的串（容错：无等号的片段视为空值）。 */
function parseUrlEncodedPairs(s: string): KeyValue[] {
  const out: KeyValue[] = [];
  for (const part of s.split("&")) {
    if (part === "") continue;
    const idx = part.indexOf("=");
    if (idx === -1) out.push(row(decodeSafe(part), ""));
    else
      out.push(row(decodeSafe(part.slice(0, idx)), decodeSafe(part.slice(idx + 1))));
  }
  return out;
}

// ------------------------------------------------------- importPostman ----

/**
 * 解析 Postman Collection v2.1（尽量兼容 v2.0）。
 *
 * - item 树中的嵌套 folder 转成 “父/子” 形式的 folder 路径字符串；
 * - 支持 raw / urlencoded / formdata / graphql / file 请求体（file 只记文件名并给 warning）；
 * - 请求级 auth 优先，集合级 auth 作为兜底；
 * - 集合 / 分组级 `variable` 汇总成一份 Environment；变量写法归一化为 `{{name}}`
 *   （含 ::name、已声明默认值的 :name 路径变量与 {{$动态变量}} 映射）。
 *
 * @throws 内容不是合法 JSON 时抛出中文 Error。
 */
export function importPostman(json: string): ImportResult {
  const warnings: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("无法解析 Postman 集合：内容不是合法 JSON");
  }
  const root = asRecord(data);
  if (!root) throw new Error("无法解析 Postman 集合：根节点不是对象");
  const info = asRecord(root.info);
  const schema = asString(info?.schema);
  if (!schema) warnings.push("缺少 info.schema 字段，已按 Postman v2.x 兼容方式解析");
  else if (!schema.includes("postman"))
    warnings.push(`info.schema 不是 Postman 格式（${schema}），仍尝试按 Postman 解析`);

  const name = asString(info?.name) || "导入的 Postman 集合";
  const rootAuth = parsePostmanAuth(asRecord(root.auth));
  const items: RequestDraft[] = [];
  const variables: KeyValue[] = [];
  // Postman 把 baseUrl 等环境变量放在集合 / 分组的 `variable` 里，这里统一收进
  // 一份 Environment，否则导入后 {{baseUrl}} 会变成未定义变量。
  collectPostmanVariables(root.variable, variables);
  walkPostmanItems(asArray(root.item), "", rootAuth, items, warnings, variables);
  if (items.length === 0) warnings.push("集合中没有找到可导入的请求");

  const environments: Omit<Environment, "id">[] = [];
  if (variables.length > 0) {
    environments.push({ name: `${name} 变量`, variables });
  } else if (items.some((item) => JSON.stringify(item).includes("{{"))) {
    warnings.push(
      "集合中的 {{变量}} 没有对应的变量声明；导入后请在「环境」里补充取值，或单独导入 Postman 环境文件",
    );
  }
  warnUnknownDynamicTokens(JSON.stringify(items), warnings);
  return { collections: [{ name, items }], environments, warnings };
}

function walkPostmanItems(
  items: unknown[],
  folderPath: string,
  fallbackAuth: AuthSpec | null,
  out: RequestDraft[],
  warnings: string[],
  variables: KeyValue[],
): void {
  for (const entry of items) {
    const item = asRecord(entry);
    if (!item) {
      warnings.push("Postman item 树中存在无法识别的条目，已跳过");
      continue;
    }
    if (Array.isArray(item.item)) {
      // folder：继续下钻，拼接 folder 路径；分组也可声明变量
      const folderName = asString(item.name) || "未命名分组";
      const childPath = folderPath ? `${folderPath}/${folderName}` : folderName;
      collectPostmanVariables(item.variable, variables);
      const folderAuth = parsePostmanAuth(asRecord(item.auth)) ?? fallbackAuth;
      walkPostmanItems(item.item, childPath, folderAuth, out, warnings, variables);
      continue;
    }
    if (item.request !== undefined) {
      out.push(parsePostmanRequest(item, folderPath, fallbackAuth, warnings, variables));
    }
  }
}

function parsePostmanRequest(
  item: Record<string, unknown>,
  folderPath: string,
  fallbackAuth: AuthSpec | null,
  warnings: string[],
  variables: KeyValue[],
): RequestDraft {
  const requestRec = asRecord(item.request);
  const requestUrl =
    requestRec !== null ? requestRec.url : typeof item.request === "string" ? item.request : "";
  const method = requestRec ? asString(requestRec.method) : "GET";
  let resolvedMethod = method.trim().toUpperCase();
  if (resolvedMethod === "") resolvedMethod = "GET";
  if (!(HTTP_METHODS as readonly string[]).includes(resolvedMethod)) {
    warnings.push(`不支持的 HTTP 方法 “${method}”，已按 GET 导入（请求：${asString(item.name)}）`);
    resolvedMethod = "GET";
  }

  const { url, query, pathVars } = parsePostmanUrl(requestUrl);
  const headers: KeyValue[] = asArray(requestRec?.header)
    .map((h) => asRecord(h))
    .filter((h): h is Record<string, unknown> => h !== null && !isBlank(h.key))
    .map((h) => row(asString(h.key), asString(h.value), h.disabled !== true));

  const body = requestRec ? parsePostmanBody(requestRec, headers, warnings) : { type: "none" as const };
  const auth = parsePostmanAuth(requestRec ? asRecord(requestRec.auth) : null, warnings) ?? fallbackAuth ?? { type: "none" as const };
  const description = requestRec ? postmanDescription(requestRec.description) : "";

  const doc = baseDoc();
  doc.description = description;
  // 统一把 URL / 头 / 参数 / 请求体 / 鉴权里可能出现的 “::name” 与 Postman
  // 动态变量转成 Reqora 写法；再把已声明且有默认值的 “:name” 路径变量转成
  // “{{name}}”（默认值登记进环境变量）。
  const draft = normalizeImportedStrings(
    newDraft({
      name: asString(item.name) || `${resolvedMethod} ${url}`,
      description,
      folder: folderPath,
      method: resolvedMethod as HttpMethod,
      url,
      headers,
      query,
      body,
      auth,
      doc,
    }),
  );
  // 集合 / 分组变量里声明过的名字也算「已声明」（部分集合把 baseUrl 写成
  // “:baseUrl”），因此 declared = url.variable ∪ 已收集的变量（含当前值）。
  const declared = new Map(pathVars.map((entry) => [entry.key, entry.value]));
  for (const entry of variables) {
    if (!declared.has(entry.key)) declared.set(entry.key, entry.value);
  }
  const convertedUrl = convertPostmanPathParams(draft.url, declared, variables);
  return convertedUrl === draft.url ? draft : { ...draft, url: convertedUrl };
}

/** Postman 的 url 可能是字符串，也可能是 { raw, query, host, path, variable } 对象。 */
function parsePostmanUrl(v: unknown): {
  url: string;
  query: KeyValue[];
  /** url.variable 里声明的路径变量 [{ key, value }]（:name 写法的默认值）。 */
  pathVars: { key: string; value: string }[];
} {
  const hashIdxOf = (s: string) => {
    const i = s.indexOf("#");
    return i === -1 ? s : s.slice(0, i);
  };
  const rec = asRecord(v);
  if (!rec) {
    // 字符串 URL：把 query 部分拆出来
    const raw = asString(v);
    const qIdx = raw.indexOf("?");
    if (qIdx === -1) return { url: hashIdxOf(raw), query: [], pathVars: [] };
    return {
      url: hashIdxOf(raw.slice(0, qIdx)),
      query: parseUrlEncodedPairs(raw.slice(qIdx + 1)),
      pathVars: [],
    };
  }
  // Postman 把 ":id" 形式的路径变量与默认值放在 url.variable 里。
  const pathVars = asArray(rec.variable)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null && !isBlank(entry.key))
    .map((entry) => ({ key: asString(entry.key).trim(), value: asString(entry.value) }));
  const raw = asString(rec.raw);
  if (raw) {
    const qIdx = raw.indexOf("?");
    if (qIdx === -1) return { url: hashIdxOf(raw), query: [], pathVars };
    // raw 已含 query：以 raw 为准，避免与 query 数组重复
    return {
      url: hashIdxOf(raw.slice(0, qIdx)),
      query: parseUrlEncodedPairs(raw.slice(qIdx + 1)),
      pathVars,
    };
  }
  const host = asArray(rec.host).map(asString).join(".");
  const path = asArray(rec.path).map(asString).join("/");
  const url = host && path ? `${host}/${path}` : host || `/${path}`;
  const query = asArray(rec.query)
    .map((q) => asRecord(q))
    .filter((q): q is Record<string, unknown> => q !== null && !isBlank(q.key))
    .map((q) => row(asString(q.key), asString(q.value), q.disabled !== true));
  return { url: hashIdxOf(url), query, pathVars };
}

const PATH_PARAM_BOUNDARY = "(^|[^A-Za-z0-9_$-])";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把 URL 里声明的 Postman 路径变量 “:name” 转成 Reqora 的 “{{name}}”：
 * 只转换「名称已声明且有默认值」的变量（默认值同时登记进环境变量，否则
 * 导入后是未定义变量）；无默认值的 “:name” 保留原样，继续作为 Reqora 的
 * 路径参数（在 Params → 路径参数 里填写）。集合 / 分组变量里已声明的名字
 * （如把 baseUrl 写成 “:baseUrl”）同样转换。
 */
function convertPostmanPathParams(
  url: string,
  declared: Map<string, string>,
  variables: KeyValue[],
): string {
  let out = url;
  for (const [key, value] of declared) {
    if (!value.trim()) continue;
    const pattern = new RegExp(
      `${PATH_PARAM_BOUNDARY}:${escapeRegExp(key)}(?=$|[^A-Za-z0-9_$-])`,
      "g",
    );
    const replaced = out.replace(pattern, (_whole, lead: string) => `${lead}{{${key}}}`);
    if (replaced === out) continue;
    out = replaced;
    if (!variables.some((item) => item.key === key)) {
      variables.push(row(key, normalizePostmanVar(value)));
    }
  }
  return out;
}

function parsePostmanBody(
  request: Record<string, unknown>,
  headers: KeyValue[],
  warnings: string[],
): BodySpec {
  const body = asRecord(request.body);
  if (!body) return { type: "none" };
  const contentTypeHeader = headers
    .find((h) => h.key.toLowerCase() === "content-type")
    ?.value.toLowerCase();
  const mode = asString(body.mode);

  if (mode === "raw") {
    const content = asString(body.raw);
    const language = asString(asRecord(asRecord(body.options)?.raw)?.language);
    if (language === "json") return { type: "json", content };
    try {
      JSON.parse(content);
      return { type: "json", content };
    } catch {
      return { type: "raw", content, contentType: contentTypeHeader || "text/plain" };
    }
  }
  if (mode === "urlencoded") {
    const items = asArray(body.urlencoded)
      .map((kv) => asRecord(kv))
      .filter((kv): kv is Record<string, unknown> => kv !== null && !isBlank(kv.key))
      .map((kv) => row(asString(kv.key), asString(kv.value), kv.disabled !== true));
    return { type: "formUrlEncoded", items };
  }
  if (mode === "formdata") {
    const items: FormPart[] = [];
    for (const entry of asArray(body.formdata)) {
      const kv = asRecord(entry);
      if (!kv || isBlank(kv.key)) continue;
      if (asString(kv.type) === "file") {
        const src = asArray(kv.src).map(asString).find((s) => s !== "") ?? asString(kv.src);
        items.push({
          ...row(asString(kv.key), ""),
          file: true,
          fileName: src ? src.split(/[\\/]/).pop() : "",
        });
        warnings.push(`multipart 文件 “${asString(kv.key)}” 的内容无法内嵌，仅保留文件名（${src || "未知"}）`);
      } else {
        items.push(row(asString(kv.key), asString(kv.value), kv.disabled !== true));
      }
    }
    return { type: "formData", items };
  }
  if (mode === "graphql") {
    const g = asRecord(body.graphql);
    const vars = g?.variables;
    return {
      type: "graphql",
      query: asString(g?.query),
      variables:
        vars === undefined || vars === null
          ? ""
          : typeof vars === "string"
            ? vars
            : JSON.stringify(vars, null, 2),
    };
  }
  if (mode === "file") {
    warnings.push("Postman 二进制（file）请求体无法导入文件内容，已置为空请求体");
    return { type: "none" };
  }
  warnings.push(`未识别的 Postman body mode “${mode}”，已置为空请求体`);
  return { type: "none" };
}

function parsePostmanAuth(auth: Record<string, unknown> | null, warnings?: string[]): AuthSpec | null {
  if (!auth) return null;
  const type = asString(auth.type);
  const pick = (list: unknown, key: string): string => {
    for (const entry of asArray(list)) {
      const rec = asRecord(entry);
      if (rec && asString(rec.key) === key) return asString(rec.value);
    }
    return "";
  };
  if (type === "bearer") return { type: "bearer", token: pick(auth.bearer, "token") };
  if (type === "basic")
    return { type: "basic", username: pick(auth.basic, "username"), password: pick(auth.basic, "password") };
  if (type === "apikey") {
    const loc = pick(auth.apikey, "in");
    return {
      type: "apiKey",
      key: pick(auth.apikey, "key"),
      value: pick(auth.apikey, "value"),
      location: loc === "query" ? "query" : "header",
    };
  }
  if (type === "noauth" || type === "") return null;
  warnings?.push("未识别的鉴权方案（OAuth2 / AWS SigV4 / mTLS 等）：已降级为 none，密钥不会写入工作区");
  return null; // 未知类型宽容处理：视为未配置
}

/**
 * 解析单独导出的 Postman 环境文件（*.postman_environment.json）。
 *
 * 结构：{ name, values: [{ key, value, enabled, type }], _postman_variable_scope }。
 * Postman 的集合与环境变量是分两个文件导出的，因此这里只生成 Environment、
 * 不生成集合；导入后按变量名与集合里的 {{baseUrl}} 等占位符对应。
 *
 * @throws 非合法 JSON / 没有可用变量时抛出中文 Error。
 */
export function importPostmanEnvironment(json: string): ImportResult {
  const warnings: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("无法解析 Postman 环境文件：内容不是合法 JSON");
  }
  const root = asRecord(data);
  if (!root) throw new Error("无法解析 Postman 环境文件：根节点不是对象");
  const values = asArray(root.values);
  if (values.length === 0) throw new Error("Postman 环境文件中没有 values 变量");

  const variables: KeyValue[] = [];
  collectPostmanVariables(values, variables);
  if (variables.length === 0) throw new Error("Postman 环境文件中没有可用的变量");

  const hiddenSecrets = values.filter((entry) => {
    const rec = asRecord(entry);
    return rec !== null && asString(rec.type) === "secret" && isBlank(rec.value);
  }).length;
  if (hiddenSecrets > 0) {
    warnings.push(`${hiddenSecrets} 个 secret 变量的值未随环境文件导出，导入后请手动填写`);
  }
  return {
    collections: [],
    environments: [{ name: asString(root.name) || "Postman 环境", variables }],
    warnings,
  };
}

// ----------------------------------------------- 极简 YAML 解析器 ----

interface YLine {
  line: number; // 原始行号（1 起）
  indent: number;
  content: string;
}

/**
 * 极简 YAML 解析器：支持缩进映射、块列表（含 “- key: value” 起始项）、
 * 单/双引号字符串、数字/布尔/null、字面量块 | 与折叠块 >、流式 {} []。
 * 不支持锚点/别名/多文档/复杂键——遇到解析不了的结构直接抛错。
 */
function parseMinimalYaml(text: string): unknown {
  const all: YLine[] = [];
  const rawLines = text.split(/\r?\n/);
  for (let idx = 0; idx < rawLines.length; idx++) {
    const raw = rawLines[idx];
    if (/^\s*---\s*(#.*)?$/.test(raw)) {
      if (all.some((l) => l.content !== "")) break; // 第二个文档开始，忽略余下内容
      continue;
    }
    if (/^\s*\.\.\.\s*$/.test(raw)) break;
    const noIndent = raw.replace(/^[ ]+/, "");
    const indent = raw.length - noIndent.length;
    if (noIndent.includes("\t")) {
      throw new Error(`YAML 解析失败：第 ${idx + 1} 行使用了 Tab 缩进，请改为空格缩进`);
    }
    const content = noIndent.replace(/\r$/, "");
    if (content.trim() === "") continue;
    if (content.trimStart().startsWith("#")) continue;
    all.push({ line: idx + 1, indent, content });
  }
  const first = all[0];
  if (!first) throw new Error("YAML 解析失败：没有可解析的内容");
  const [value, next] = parseYamlBlock(all, 0, first.indent);
  if (next < all.length) {
    throw new Error(`YAML 解析失败：第 ${all[next].line} 行附近结构无法识别（缩进或语法有误）`);
  }
  return value;
}

function isDashItem(content: string): boolean {
  return content === "-" || content.startsWith("- ");
}

function parseYamlBlock(items: YLine[], i: number, indent: number): [unknown, number] {
  const line = items[i];
  if (!line || line.indent < indent) return [null, i];
  return isDashItem(line.content) ? parseYamlSeq(items, i, indent) : parseYamlMap(items, i, indent);
}

function parseYamlSeq(items: YLine[], i: number, indent: number): [unknown[], number] {
  const out: unknown[] = [];
  while (i < items.length && items[i].indent === indent && isDashItem(items[i].content)) {
    const it = items[i];
    const restOffset = it.content.length - it.content.slice(1).trimStart().length; // “-”+空格数
    const rest = it.content.slice(restOffset);
    if (rest.trim() === "") {
      // “-” 后无内容：值为后续缩进的块
      if (i + 1 < items.length && items[i + 1].indent > indent) {
        const [v, ni] = parseYamlBlock(items, i + 1, items[i + 1].indent);
        out.push(v);
        i = ni;
      } else {
        out.push(null);
        i++;
      }
      continue;
    }
    const innerIndent = indent + restOffset;
    // 把 “- xxx” 重写为一个以 xxx 开头、缩进为 innerIndent 的行，再按块解析
    const rewritten = items.slice();
    rewritten[i] = { ...it, indent: innerIndent, content: rest };
    const [v, ni] = parseYamlBlock(rewritten, i, innerIndent);
    out.push(v);
    i = ni;
  }
  return [out, i];
}

/** 找到 key 后的 “:”（冒号后必须是结尾或空格），返回冒号下标；找不到返回 -1。 */
function findKeySeparator(s: string): number {
  if (s.startsWith("'") || s.startsWith('"')) {
    const quote = s[0];
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "\\" && quote === '"') i++;
      else if (s[i] === quote) {
        let j = i + 1;
        while (j < s.length && s[j] === " ") j++;
        return s[j] === ":" ? j : -1;
      }
    }
    return -1;
  }
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ":" && (i + 1 === s.length || s[i + 1] === " ")) return i;
  }
  return -1;
}

function parseYamlMap(items: YLine[], i: number, indent: number): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  while (i < items.length) {
    const it = items[i];
    if (it.indent !== indent || isDashItem(it.content)) break;
    const sep = findKeySeparator(it.content);
    if (sep === -1) {
      throw new Error(`YAML 解析失败：第 ${it.line} 行无法识别（缺少 “key:” 形式的冒号）`);
    }
    const rawKey = it.content.slice(0, sep).trim();
    const key =
      (rawKey.startsWith("'") && rawKey.endsWith("'")) || (rawKey.startsWith('"') && rawKey.endsWith('"'))
        ? rawKey.slice(1, -1)
        : rawKey;
    const valueRaw = it.content.slice(sep + 1).trim();
    i++;
    if (valueRaw === "") {
      if (i < items.length && items[i].indent > indent) {
        const [v, ni] = parseYamlBlock(items, i, items[i].indent);
        out[key] = v;
        i = ni;
      } else {
        out[key] = null;
      }
    } else if (/^[|>][+-]?$/.test(valueRaw)) {
      // 块标量：收集后续所有更深缩进的行
      const parts: string[] = [];
      while (i < items.length && items[i].indent > indent) {
        parts.push(items[i].content);
        i++;
      }
      out[key] = valueRaw.startsWith(">") ? parts.join(" ") : parts.join("\n");
    } else {
      out[key] = parseYamlScalar(valueRaw);
    }
  }
  return [out, i];
}

function indexOfComment(s: string): number {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "#" && (i === 0 || s[i - 1] === " ")) {
      return i;
    }
  }
  return -1;
}

function parseYamlScalar(input: string): unknown {
  let s = input.trim();
  if (s === "") return null;
  if (s !== "''" && s !== '""' && s[0] !== "'" && s[0] !== '"') {
    const cIdx = indexOfComment(s);
    if (cIdx !== -1) s = s.slice(0, cIdx).trim();
    if (s === "") return null;
  }
  if (s === "null" || s === "Null" || s === "~") return null;
  if (s === "true" || s === "True") return true;
  if (s === "false" || s === "False") return false;
  if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10);
  if (/^[+-]?\d*\.\d+$/.test(s)) return parseFloat(s);
  if (s === "[]") return [];
  if (s === "{}") return {};
  if (s[0] === "[" || s[0] === "{") return parseYamlFlow(s);
  if (s.startsWith("'")) {
    // 单引号：'' 转义为 '
    let out = "";
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        break;
      }
      out += s[i];
    }
    return out;
  }
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

/** 流式集合解析：{a: 1, b: [x, y]} / [1, 2, {k: v}]。 */
function parseYamlFlow(input: string): unknown {
  let i = 0;
  const fail = (): Error => new Error(`YAML 解析失败：流式集合 “${input}” 语法有误`);
  const skipWs = () => {
    while (i < input.length && /\s/.test(input[i])) i++;
  };
  const parseKey = (): string => {
    skipWs();
    const c = input[i];
    if (c === "'" || c === '"') {
      i++;
      const start = i;
      while (i < input.length && input[i] !== c) i++;
      const key = input.slice(start, i);
      i++;
      return key;
    }
    const start = i;
    while (i < input.length && !/[:},\]]/.test(input[i])) i++;
    return input.slice(start, i).trim();
  };
  const parseQuoted = (quote: string): string => {
    i++;
    let out = "";
    while (i < input.length && input[i] !== quote) {
      if (input[i] === "\\" && quote === '"' && i + 1 < input.length) {
        out += input[i + 1];
        i += 2;
      } else {
        out += input[i];
        i++;
      }
    }
    i++;
    return out;
  };
  const parseValue = (): unknown => {
    skipWs();
    if (i >= input.length) throw fail();
    const c = input[i];
    if (c === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      skipWs();
      if (input[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        const key = parseKey();
        skipWs();
        if (input[i] !== ":") throw fail();
        i++;
        obj[key] = parseValue();
        skipWs();
        if (input[i] === ",") {
          i++;
          continue;
        }
        if (input[i] === "}") {
          i++;
          return obj;
        }
        throw fail();
      }
    }
    if (c === "[") {
      i++;
      const arr: unknown[] = [];
      skipWs();
      if (input[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue());
        skipWs();
        if (input[i] === ",") {
          i++;
          continue;
        }
        if (input[i] === "]") {
          i++;
          return arr;
        }
        throw fail();
      }
    }
    if (c === "'" || c === '"') return parseQuoted(c);
    const start = i;
    while (i < input.length && !/[,}\]]/.test(input[i])) i++;
    return parseYamlScalar(input.slice(start, i));
  };
  const value = parseValue();
  skipWs();
  if (i < input.length) throw fail();
  return value;
}

// ------------------------------------------------------ importOpenApi ----

/** 解析 OpenAPI 3.0.x（JSON 或常见 YAML 子集）为请求集合。 */
export function importOpenApi(jsonOrYaml: string): ImportResult {
  const text = jsonOrYaml.trim();
  if (text === "") throw new Error("无法解析 OpenAPI：内容为空");
  let data: unknown;
  if (text.startsWith("{")) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("无法解析 OpenAPI：内容以 “{” 开头但不是合法 JSON");
    }
  } else {
    try {
      data = parseMinimalYaml(text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `无法解析 OpenAPI 文本：${msg}。当前仅支持 JSON 与常见 YAML 子集，建议先把文档转换为 JSON 再导入`,
      );
    }
  }
  const root = asRecord(data);
  if (!root) throw new Error("无法解析 OpenAPI：根节点不是对象");

  const warnings = new Set<string>();
  const openapi = asString(root.openapi);
  if (openapi && !openapi.startsWith("3.")) {
    warnings.add(`OpenAPI 版本为 ${openapi}，本工具仅针对 3.0.x 设计，可能解析不完整`);
  }
  if (!openapi && asString(root.swagger)) {
    warnings.add("检测到 Swagger 2.0 文档，仅做尽力解析，建议先用工具转换为 OpenAPI 3.0");
  }

  const info = asRecord(root.info);
  const title = asString(info?.title) || "导入的 OpenAPI 接口";

  // servers[0].url → baseUrl 环境变量
  const environments: Omit<Environment, "id">[] = [];
  const serverUrl = asString(asRecord(asArray(root.servers)[0])?.url);
  if (serverUrl) {
    environments.push({
      name: `${title} 环境`,
      variables: [row("baseUrl", serverUrl)],
    });
  }

  const schemes = asRecord(root.components ? asRecord(root.components)?.securitySchemes : null);
  const rootSecurity = Array.isArray(root.security) ? root.security : null;

  const items: RequestDraft[] = [];
  const paths = asRecord(root.paths);
  if (!paths) warnings.add("文档中没有 paths 节点，未导入任何接口");
  else {
    for (const path of Object.keys(paths)) {
      const pathItem = asRecord(paths[path]);
      if (!pathItem) continue;
      for (const methodKey of ["get", "post", "put", "patch", "delete", "head", "options", "trace", "connect"]) {
        const op = asRecord(pathItem[methodKey]);
        if (!op) continue;
        if (methodKey === "trace" || methodKey === "connect") {
          warnings.add(`路径 ${path} 的 ${methodKey.toUpperCase()} 方法不受支持，已跳过`);
          continue;
        }
        items.push(
          parseOpenApiOperation(root, path, methodKey, op, pathItem, {
            serverUrl,
            schemes,
            rootSecurity,
            warnings,
          }),
        );
      }
    }
  }
  if (items.length === 0) warnings.add("没有从文档中导入任何接口");
  return { collections: [{ name: title, items }], environments, warnings: [...warnings] };
}

interface OpenApiOpContext {
  serverUrl: string;
  schemes: Record<string, unknown> | null;
  rootSecurity: unknown[] | null;
  warnings: Set<string>;
}

function parseOpenApiOperation(
  root: Record<string, unknown>,
  path: string,
  methodKey: string,
  op: Record<string, unknown>,
  pathItem: Record<string, unknown>,
  ctx: OpenApiOpContext,
): RequestDraft {
  const { warnings } = ctx;
  const method = methodKey.toUpperCase() as HttpMethod;
  const url = (ctx.serverUrl ? "{{baseUrl}}" : "") + path; // {param} 保留原样

  // parameters：pathItem 级 + operation 级
  const query: KeyValue[] = [];
  const headers: KeyValue[] = [];
  const paramMeta: Record<string, ParamMeta> = {};
  for (const p of [...asArray(pathItem.parameters), ...asArray(op.parameters)]) {
    const param = asRecord(p);
    if (!param) continue;
    const loc = asString(param.in);
    const name = asString(param.name);
    if (!name) continue;
    if (loc !== "query" && loc !== "header") {
      warnings.add(`路径 ${path} 的参数 ${name} 位于 ${loc}，Reqora 暂不支持，已跳过`);
      continue;
    }
    const kv = row(name, "");
    (loc === "query" ? query : headers).push(kv);
    const schema = resolveRef(root, param.schema);
    const schemaRec = asRecord(schema);
    const example = param.example !== undefined ? param.example : schemaRec?.example;
    const meta: ParamMeta = {
      type: asString(schemaRec?.type) || "string",
      required: param.required === true,
      description: asString(param.description),
      example: example === undefined ? "" : asString(example),
    };
    if (meta.description || meta.example || meta.required || meta.type !== "string") {
      paramMeta[`${loc === "query" ? "q" : "h"}:${kv.id}`] = meta;
    }
  }

  // requestBody → body
  const body = parseOpenApiRequestBody(root, op, path, warnings);

  // security → auth
  const security = Array.isArray(op.security) ? op.security : ctx.rootSecurity;
  const auth = securityToAuth(security, ctx.schemes, warnings, path);

  // 文档
  const description = asString(op.description);
  const doc = baseDoc();
  doc.summary = asString(op.summary);
  doc.description = description;
  doc.paramMeta = paramMeta;
  doc.responses = parseOpenApiResponses(root, op, warnings);

  const tags = asArray(op.tags).map(asString).filter((t) => t !== "");
  return newDraft({
    name: asString(op.summary) || asString(op.operationId) || `${method} ${path}`,
    description,
    folder: tags[0] ?? "",
    method,
    url,
    headers,
    query,
    body,
    auth,
    doc,
  });
}

/** 解析本地 $ref（#/components/schemas/...），最多 5 层。 */
function resolveRef(root: Record<string, unknown>, schema: unknown, depth = 0): unknown {
  const rec = asRecord(schema);
  if (!rec || typeof rec.$ref !== "string" || depth > 5) return schema;
  const ref = rec.$ref;
  if (!ref.startsWith("#/")) return schema;
  let cur: unknown = root;
  for (const seg of ref.slice(2).split("/")) {
    cur = asRecord(cur)?.[seg.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (cur === undefined) return schema;
  }
  return resolveRef(root, cur, depth + 1);
}

/** 取 media type 上的示例：example > schema.example > examples[*].value。 */
function mediaExample(root: Record<string, unknown>, mediaType: Record<string, unknown>): unknown | undefined {
  if (mediaType.example !== undefined) return mediaType.example;
  const schema = resolveRef(root, mediaType.schema);
  const schemaRec = asRecord(schema);
  if (schemaRec && schemaRec.example !== undefined) return schemaRec.example;
  const examples = asRecord(mediaType.examples);
  if (examples) {
    for (const key of Object.keys(examples)) {
      const ex = asRecord(examples[key]);
      if (ex && ex.value !== undefined) return ex.value;
    }
  }
  return undefined;
}

/** 按 required 属性合成一个空示例对象。 */
function exampleFromSchema(schema: unknown): unknown {
  const rec = asRecord(schema);
  if (!rec) return {};
  const type = asString(rec.type) || (rec.properties ? "object" : "");
  if (type === "object" || rec.properties) {
    const props = asRecord(rec.properties) ?? {};
    const required = Array.isArray(rec.required) ? rec.required.map(String) : [];
    const keys = required.length > 0 ? required : Object.keys(props);
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const prop = resolveRef(rec, props[k]);
      const propRec = asRecord(prop);
      if (propRec?.example !== undefined) out[k] = propRec.example;
      else if (propRec?.default !== undefined) out[k] = propRec.default;
      else out[k] = exampleFromSchema(prop);
    }
    return out;
  }
  if (type === "array") return [exampleFromSchema(rec.items)];
  if (type === "string") return "";
  if (type === "number" || type === "integer") return 0;
  if (type === "boolean") return false;
  return {};
}

function parseOpenApiRequestBody(
  root: Record<string, unknown>,
  op: Record<string, unknown>,
  path: string,
  warnings: Set<string>,
): BodySpec {
  const rb = asRecord(op.requestBody);
  if (!rb) return { type: "none" };
  const content = asRecord(rb.content);
  if (!content) return { type: "none" };

  const jsonKey = Object.keys(content).find((k) => k.toLowerCase().includes("json"));
  if (jsonKey) {
    const mediaType = asRecord(content[jsonKey]) ?? {};
    let example = mediaExample(root, mediaType);
    if (example === undefined) {
      const schema = resolveRef(root, mediaType.schema);
      example = exampleFromSchema(schema);
    }
    let content2: string;
    try {
      content2 = JSON.stringify(example, null, 2) ?? "";
    } catch {
      content2 = "";
    }
    return { type: "json", content: content2 };
  }

  const formKey = Object.keys(content).find((k) => /x-www-form-urlencoded/.test(k));
  if (formKey) {
    const schema = asRecord(resolveRef(root, asRecord(content[formKey])?.schema));
    const props = asRecord(schema?.properties) ?? {};
    return {
      type: "formUrlEncoded",
      items: Object.keys(props).map((k) => row(k, asString(asRecord(props[k])?.example))),
    };
  }

  const multipartKey = Object.keys(content).find((k) => /multipart\/form-data/.test(k));
  if (multipartKey) {
    const schema = asRecord(resolveRef(root, asRecord(content[multipartKey])?.schema));
    const props = asRecord(schema?.properties) ?? {};
    const items: FormPart[] = Object.keys(props).map((k) => {
      const prop = asRecord(resolveRef(root, props[k])) ?? {};
      if (asString(prop.format) === "binary") {
        return { ...row(k, ""), file: true, fileName: "", contentType: "" };
      }
      return row(k, asString(prop.example));
    });
    return { type: "formData", items };
  }

  const firstKey = Object.keys(content)[0];
  if (firstKey) {
    warnings.add(`路径 ${path} 的请求体类型 ${firstKey} 不常见，已按 raw 文本导入`);
    const mediaType = asRecord(content[firstKey]) ?? {};
    const example = mediaExample(root, mediaType);
    return {
      type: "raw",
      content: example === undefined ? "" : typeof example === "string" ? example : JSON.stringify(example, null, 2),
      contentType: firstKey,
    };
  }
  return { type: "none" };
}

function parseOpenApiResponses(
  root: Record<string, unknown>,
  op: Record<string, unknown>,
  warnings: Set<string>,
): ResponseExample[] {
  const responses = asRecord(op.responses);
  if (!responses) return [];
  const out: ResponseExample[] = [];
  for (const statusKey of Object.keys(responses)) {
    const rec = asRecord(responses[statusKey]);
    if (!rec) continue;
    const status = statusKey === "default" ? 200 : parseInt(statusKey, 10);
    if (Number.isNaN(status)) {
      warnings.add(`响应状态码 “${statusKey}” 无法识别，已按 200 处理`);
    }
    const content = asRecord(rec.content);
    let contentType = "application/json";
    let body = "";
    let params: ResponseParam[] = [];
    if (content) {
      const key = Object.keys(content)[0];
      if (key) {
        contentType = key;
        const mediaType = asRecord(content[key]) ?? {};
        const example = mediaExample(root, mediaType);
        if (example !== undefined) {
          body = typeof example === "string" ? example : JSON.stringify(example, null, 2);
        }
        // 把 OpenAPI response schema / headers 还原成可编辑的响应字段文档。
        params = schemaToResponseParams(resolveRef(root, mediaType.schema), rec.headers);
      }
    }
    out.push({
      id: uid(),
      name: asString(rec.summary) || (statusKey === "default" ? "默认响应" : `响应 ${statusKey}`),
      status: Number.isNaN(status) ? 200 : status,
      contentType,
      body,
      description: asString(rec.description),
      params,
    });
  }
  return out;
}

function securityToAuth(
  security: unknown[] | null,
  schemes: Record<string, unknown> | null,
  warnings: Set<string>,
  path: string,
): AuthSpec {
  for (const entry of security ?? []) {
    const rec = asRecord(entry);
    if (!rec) continue;
    for (const name of Object.keys(rec)) {
      const scheme = asRecord(schemes?.[name]);
      if (!scheme) {
        warnings.add(`路径 ${path} 引用了未定义的 securityScheme “${name}”，已忽略`);
        continue;
      }
      const type = asString(scheme.type);
      if (type === "http") {
        const s = asString(scheme.scheme).toLowerCase();
        if (s === "basic") return { type: "basic", username: "", password: "" };
        if (s === "bearer") return { type: "bearer", token: "" };
        warnings.add(`路径 ${path} 的 HTTP 安全方案 “${s}” 不受支持，已忽略`);
      } else if (type === "apiKey") {
        const loc = asString(scheme.in);
        if (loc !== "header" && loc !== "query") {
          warnings.add(`路径 ${path} 的 apiKey 位于 ${loc}，暂不支持，已忽略`);
          continue;
        }
        return { type: "apiKey", key: asString(scheme.name), value: "", location: loc };
      } else {
        warnings.add(`路径 ${path} 的安全方案类型 “${type}” 不受支持，已忽略`);
      }
    }
  }
  return { type: "none" };
}

// ------------------------------------------------------- importCurl ----

const CURL_VALUE_FLAGS = new Set([
  "-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary",
  "--data-ascii", "--data-urlencode", "-F", "--form", "--form-string", "-u", "--user",
  "--url", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-o", "--output",
  "-m", "--max-time", "--connect-timeout", "--proxy", "-x", "--cacert", "--cert", "--key",
  "--json",
]);

const CURL_BOOL_FLAGS = new Set([
  "-s", "-S", "-k", "-L", "-v", "-i", "-G", "-f", "-#", "-0", "-4", "-6", "-g", "--compressed",
  "--insecure", "--location", "--silent", "--verbose", "--include", "--head", "--fail",
  "--http1.1", "--http2", "--no-buffer", "--progress-bar", "--raw", "--tr-encoding",
]);

/**
 * 解析 cURL 命令文本。支持：
 * -X/--request、-H/--header、-d/--data/--data-raw/--data-binary/--data-urlencode、
 * -F/--form、-u/--user、--url、位置参数 URL；单双引号与转义、$'...' 基本支持、
 * 多行反斜杠续行、短参数合写与紧跟值（如 -XPOST、-H"..."）。
 *
 * method 缺省规则：有请求体视为 POST，否则 GET；-G 时把 -d 数据转为 query 并强制 GET。
 *
 * @throws 找不到 URL 或命令为空时抛出中文 Error。
 */
export function importCurl(command: string): ImportResult {
  const warnings: string[] = [];
  const text = command.trim();
  if (text === "") throw new Error("无法解析 cURL：命令为空");
  const tokens = tokenizeCurl(text);
  if (tokens.length === 0) throw new Error("无法解析 cURL：命令为空");

  let start = 0;
  if (/^curl(\.exe)?$/i.test(tokens[0])) start = 1;
  else if (/^curl/i.test(tokens[0]) && tokens[0].length > 4) start = 1;

  let url = "";
  let method = "";
  let user = "";
  let getWithQuery = false;
  const headers: KeyValue[] = [];
  const dataFlags: string[] = [];
  const formFlags: string[] = [];
  let jsonFlag = false;
  const sink: CurlFlagSink = {
    headers,
    dataFlags,
    formFlags,
    setMethod: (m) => { method = m; },
    setUser: (u) => { user = u; },
    setUrl: (u) => { url = u; },
    markJson: () => { jsonFlag = true; },
    markGet: () => { getWithQuery = true; },
  };

  let i = start;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === "--") {
      i++;
      continue;
    }
    if (tok === "-G") {
      // -G：把 -d 数据转为 query 并强制 GET（无取值参数）
      sink.markGet();
      i++;
      continue;
    }
    if (CURL_VALUE_FLAGS.has(tok)) {
      const value = tokens[i + 1];
      if (value === undefined) {
        warnings.push(`参数 ${tok} 缺少取值，已忽略`);
        i++;
        continue;
      }
      applyCurlValueFlag(tok, value, sink, warnings);
      i += 2;
      continue;
    }
    if (tok.startsWith("--")) {
      // 未知长参数：有下一个非 “-” 开头的 token 就当作它的值吞掉
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
        warnings.push(`未识别的 cURL 参数 ${tok}，已连同其取值一起忽略`);
        i += 2;
      } else {
        warnings.push(`未识别的 cURL 参数 ${tok}，已忽略`);
        i++;
      }
      continue;
    }
    if (tok.startsWith("-") && tok.length > 1) {
      // 短参数（可能合写或紧跟值，如 -XPOST / -H"..."）
      const flag = "-" + tok[1];
      if (CURL_VALUE_FLAGS.has(flag)) {
        if (tok.length > 2) {
          applyCurlValueFlag(flag, tok.slice(2), sink, warnings);
        } else {
          const value = tokens[i + 1];
          if (value === undefined) {
            warnings.push(`参数 ${tok} 缺少取值，已忽略`);
            i++;
            continue;
          }
          applyCurlValueFlag(flag, value, sink, warnings);
          i++;
        }
        i++;
        continue;
      }
      for (const c of tok.slice(1)) {
        if (c === "G") sink.markGet();
        else if (!CURL_BOOL_FLAGS.has("-" + c)) warnings.push(`未识别的 cURL 参数 -${c}，已忽略`);
      }
      i++;
      continue;
    }
    // 位置参数：URL
    if (url === "") url = tok;
    else warnings.push(`忽略多余的裸参数 “${tok}”`);
    i++;
  }

  if (url === "") throw new Error("无法解析 cURL：命令中没有找到 URL");
  if (method === "") {
    method = getWithQuery || dataFlags.length === 0 && formFlags.length === 0 ? "GET" : "POST";
  }
  if (jsonFlag && !headers.some((h) => h.key.toLowerCase() === "content-type")) {
    headers.push(row("Content-Type", "application/json"));
  }
  if (!(HTTP_METHODS as readonly string[]).includes(method.trim().toUpperCase())) {
    warnings.push(`不支持的 HTTP 方法 “${method}”，已按 GET 导入`);
    method = "GET";
  }
  const resolvedMethod = method.trim().toUpperCase() as HttpMethod;

  // URL 上的 query 拆出来
  let urlPath = url;
  let query: KeyValue[] = [];
  const qIdx = url.indexOf("?");
  if (qIdx !== -1) {
    urlPath = url.slice(0, qIdx);
    query = parseUrlEncodedPairs(url.slice(qIdx + 1));
  }

  // -G：把 -d 数据并入 query
  if (getWithQuery) {
    for (const data of dataFlags) query.push(...parseUrlEncodedPairs(data));
    dataFlags.length = 0;
  }

  // 请求体
  let body: BodySpec = { type: "none" };
  if (formFlags.length > 0) {
    const items: FormPart[] = formFlags.map((f) => parseCurlFormPart(f, warnings));
    body = { type: "formData", items };
  } else if (dataFlags.length > 0) {
    const contentType = (headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "").toLowerCase();
    const joined = dataFlags.join("&");
    if (contentType.includes("json")) {
      try {
        JSON.parse(joined);
        body = { type: "json", content: joined };
      } catch {
        body = { type: "raw", content: joined, contentType: headers.find((h) => h.key.toLowerCase() === "content-type")!.value };
      }
    } else if (
      contentType.includes("x-www-form-urlencoded") ||
      dataFlags.length > 1 ||
      dataFlags.every((d) => /^[^=]+=.*/.test(d) && !d.trimStart().startsWith("{") && !d.trimStart().startsWith("["))
    ) {
      const items = parseUrlEncodedPairs(joined);
      body = items.length > 0 ? { type: "formUrlEncoded", items } : { type: "raw", content: joined, contentType: "text/plain" };
    } else {
      try {
        JSON.parse(joined);
        body = { type: "json", content: joined };
      } catch {
        body = { type: "raw", content: joined, contentType: "text/plain" };
      }
    }
  }

  // -u/--user → basic auth
  let auth: AuthSpec = { type: "none" };
  if (user !== "") {
    const sep = user.indexOf(":");
    auth = { type: "basic", username: sep === -1 ? user : user.slice(0, sep), password: sep === -1 ? "" : user.slice(sep + 1) };
  }

  const doc = baseDoc();
  return {
    collections: [
      {
        name: "cURL 导入",
        items: [
          newDraft({
            name: `${resolvedMethod} ${urlPath}`,
            method: resolvedMethod,
            url: urlPath,
            headers,
            query,
            body,
            auth,
            doc,
          }),
        ],
      },
    ],
    environments: [],
    warnings,
  };
}

interface CurlFlagSink {
  headers: KeyValue[];
  dataFlags: string[];
  formFlags: string[];
  setMethod: (m: string) => void;
  setUser: (u: string) => void;
  setUrl: (u: string) => void;
  markJson: () => void;
  markGet: () => void;
}

function applyCurlValueFlag(flag: string, value: string, sink: CurlFlagSink, warnings: string[]): void {
  switch (flag) {
    case "-X":
    case "--request":
      sink.setMethod(value.trim());
      break;
    case "-H":
    case "--header": {
      const sep = value.indexOf(":");
      if (sep === -1) {
        if (value.trimEnd().endsWith(";")) {
          sink.headers.push(row(value.trimEnd().slice(0, -1).trim(), ""));
        } else {
          warnings.push(`无法识别的请求头 “${value}”，已忽略`);
        }
        break;
      }
      sink.headers.push(row(value.slice(0, sep).trim(), value.slice(sep + 1).trim()));
      break;
    }
    case "-d":
    case "--data":
    case "--data-raw":
    case "--data-binary":
    case "--data-ascii":
      if (value.startsWith("@")) {
        warnings.push(`请求体引用了文件 ${value.slice(1)}，无法读取文件内容，已原样保留占位`);
      }
      sink.dataFlags.push(value);
      break;
    case "--data-urlencode":
      sink.dataFlags.push(value.includes("=") ? value : `=${value}`);
      break;
    case "--json":
      sink.markJson();
      sink.dataFlags.push(value);
      break;
    case "-F":
    case "--form":
    case "--form-string":
      sink.formFlags.push(value);
      break;
    case "-u":
    case "--user":
      sink.setUser(value);
      break;
    case "--url":
      sink.setUrl(value);
      break;
    default:
      // 其余取值型参数（-A、-m、--proxy 等）与请求语义无关，忽略并提示
      warnings.push(`参数 ${flag} 的取值不影响请求定义，已忽略`);
      break;
  }
}

/** 解析 -F 的 key=value / key=@file / key=<file。 */
function parseCurlFormPart(entry: string, warnings: string[]): FormPart {
  const sep = entry.indexOf("=");
  if (sep === -1) {
    warnings.push(`无法识别的 form 字段 “${entry}”，已忽略取值`);
    return row(entry, "");
  }
  const key = entry.slice(0, sep);
  const value = entry.slice(sep + 1);
  if (value.startsWith("@")) {
    const fileName = value.slice(1).split(/[\\/]/).pop() ?? "";
    warnings.push(`multipart 文件 “${key}” 引用了 ${value.slice(1)}，无法内嵌文件内容，仅保留文件名`);
    return { ...row(key, ""), file: true, fileName };
  }
  if (value.startsWith("<")) {
    warnings.push(`multipart 字段 “${key}” 引用了文件 ${value.slice(1)}，无法读取，已置为空值`);
    return row(key, "");
  }
  return row(key, value);
}

/** cURL 命令分词：支持单双引号、转义、$'...'、行 continuation。 */
function tokenizeCurl(input: string): string[] {
  const text = input.replace(/\\\r?\n/g, " ");
  const tokens: string[] = [];
  let token = "";
  let hasToken = false;
  const push = () => {
    if (hasToken) {
      tokens.push(token);
      token = "";
      hasToken = false;
    }
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      push();
      i++;
      continue;
    }
    hasToken = true;
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) {
        token += text.slice(i + 1);
        i = text.length;
      } else {
        token += text.slice(i + 1, end);
        i = end + 1;
      }
      continue;
    }
    if (c === "$" && text[i + 1] === "'") {
      // $'...'：ANSI-C 引用，仅做基本转义支持
      i += 2;
      while (i < text.length && text[i] !== "'") {
        if (text[i] === "\\" && i + 1 < text.length) {
          const n = text[i + 1];
          token += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n;
          i += 2;
        } else {
          token += text[i];
          i++;
        }
      }
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) {
          const n = text[i + 1];
          if (n === '"' || n === "\\" || n === "$" || n === "`") {
            token += n;
            i += 2;
          } else if (n === "\n") {
            i += 2;
          } else {
            token += text[i];
            i++;
          }
        } else {
          token += text[i];
          i++;
        }
      }
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < text.length) {
      token += text[i + 1];
      i += 2;
      continue;
    }
    token += c;
    i++;
  }
  push();
  return tokens;
}

// ------------------------------------------------------ exportOpenApi ----

function findBaseUrl(snapshot: WorkspaceSnapshot): string {
  for (const env of snapshot.environments ?? []) {
    for (const v of env.variables ?? []) {
      if (v.key === "baseUrl" && v.enabled && v.value.trim() !== "") return v.value.trim();
    }
  }
  return "";
}

function rowParam(r: KeyValue, loc: "query" | "header", meta: ParamMeta | undefined): Record<string, unknown> {
  const param: Record<string, unknown> = {
    name: r.key,
    in: loc,
    schema: { type: meta && meta.type !== "" ? meta.type : "string" },
  };
  const description = meta?.description ?? "";
  if (description) param.description = description;
  if (meta?.required) param.required = true;
  // 私密行（secret === true）连文档元数据里的 example 都不带出去，
  // 只保留参数名，让协作者自己填。
  const example = isPrivateVariable(r) ? "" : meta?.example || r.value;
  if (example) param.example = example;
  return param;
}

function authToSecurity(
  auth: AuthSpec,
  securitySchemes: Record<string, unknown>,
): Array<Record<string, string[]>> | null {
  if (auth.type === "basic") {
    if (!securitySchemes.basicAuth) securitySchemes.basicAuth = { type: "http", scheme: "basic" };
    return [{ basicAuth: [] }];
  }
  if (auth.type === "bearer") {
    if (!securitySchemes.bearerAuth) securitySchemes.bearerAuth = { type: "http", scheme: "bearer" };
    return [{ bearerAuth: [] }];
  }
  if (auth.type === "apiKey") {
    const id = `apiKey_${(auth.key || "key").replace(/[^A-Za-z0-9_.-]/g, "_")}`;
    if (!securitySchemes[id])
      securitySchemes[id] = { type: "apiKey", name: auth.key, in: auth.location };
    return [{ [id]: [] }];
  }
  if (auth.type === "oauth2") {
    if (!securitySchemes.oauth2Auth)
      securitySchemes.oauth2Auth = {
        type: "oauth2",
        description: "OAuth 2.0（凭据已省略）",
        flows: {
          authorizationCode: {
            authorizationUrl: auth.authUrl || "<authUrl>",
            tokenUrl: auth.tokenUrl || "<tokenUrl>",
            scopes: {},
          },
        },
      };
    return [{ oauth2Auth: [] }];
  }
  if (auth.type === "awsSigV4") {
    if (!securitySchemes.awsSigV4)
      securitySchemes.awsSigV4 = {
        type: "apiKey",
        name: "Authorization",
        in: "header",
        description: `AWS SigV4 region=${auth.region} service=${auth.service}（密钥已省略）`,
      };
    return [{ awsSigV4: [] }];
  }
  if (auth.type === "mtls") {
    if (!securitySchemes.mtls)
      securitySchemes.mtls = { type: "mutualTLS", description: "mTLS 客户端证书已省略" };
    return [{ mtls: [] }];
  }
  return null;
}

function jsonOrString(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * 把工作区全部接口导出为 OpenAPI 3.0 JSON（paths 平铺、{{baseUrl}} 前缀剥离、
 * JSON 请求体尝试 JSON.parse 后作为 schema.example、doc.paramMeta 写入 parameter
 * description、doc.responses 写入 responses 示例）。
 */
export function exportOpenApi(snapshot: WorkspaceSnapshot): string {
  const paths: Record<string, Record<string, unknown>> = {};
  const securitySchemes: Record<string, unknown> = {};
  // 私密变量的值可能在请求里被硬编码（而不只是 {{模板}}），所以导出的
  // 自由文本也过一遍同样的策略。没有私密变量时原样返回，输出不变。
  const privateCtx = privateContext(snapshot);
  const safeText = (text: string) => maskPrivateText(text, privateCtx);

  for (const collection of snapshot.collections ?? []) {
    for (const item of collection.items ?? []) {
      const rawUrl = item.url.trim();
      if (rawUrl === "") continue;
      let path = safeText(rawUrl.replace(/^\{\{baseUrl\}\}/, ""));
      if (!path.startsWith("/")) path = `/${path}`;
      const pathObj = (paths[path] ??= {});
      const method = item.method.toLowerCase();
      const doc = item.doc;

      const operation: Record<string, unknown> = {};
      if (doc?.summary) operation.summary = safeText(doc.summary);
      const description = doc?.description || item.description;
      if (description) operation.description = safeText(description);
      operation.tags = [collection.name];

      const parameters: Record<string, unknown>[] = [];
      for (const q of item.query ?? []) {
        if (q.key.trim() === "") continue;
        parameters.push(rowParam(q, "query", doc?.paramMeta?.[`q:${q.id}`]));
      }
      for (const h of item.headers ?? []) {
        const lower = h.key.trim().toLowerCase();
        if (lower === "" || lower === "content-type" || lower === "accept") continue;
        parameters.push(rowParam(h, "header", doc?.paramMeta?.[`h:${h.id}`]));
      }
      // OpenAPI 要求 path 参数显式声明
      const declared = new Set(parameters.map((p) => String(p.name)));
      for (const match of path.matchAll(/\{([^{}]+)\}/g)) {
        if (!declared.has(match[1])) {
          parameters.push({ name: match[1], in: "path", required: true, schema: { type: "string" } });
        }
      }
      if (parameters.length > 0) operation.parameters = parameters;

      // `inherit` is a frontend-only marker: resolve it against the collection
      // so the exported document describes the auth actually used at runtime.
      const security = authToSecurity(
        resolveRequestAuth(item, snapshot.collections).auth,
        securitySchemes,
      );
      if (security) operation.security = security;

      const body = item.body;
      if (body.type === "json") {
        operation.requestBody = {
          content: {
            "application/json": {
              schema: { type: Array.isArray(jsonOrString(safeText(body.content))) ? "array" : "object", example: jsonOrString(safeText(body.content)) },
            },
          },
        };
      } else if (body.type === "raw") {
        operation.requestBody = { content: { [body.contentType || "text/plain"]: { example: body.content } } };
      } else if (body.type === "formUrlEncoded") {
        const properties: Record<string, unknown> = {};
        for (const kv of body.items) {
          if (kv.key.trim() === "") continue;
          properties[kv.key] = {
            type: "string",
            example: isPrivateVariable(kv) ? "" : safeText(kv.value),
          };
        }
        operation.requestBody = {
          content: { "application/x-www-form-urlencoded": { schema: { type: "object", properties } } },
        };
      } else if (body.type === "formData") {
        const properties: Record<string, unknown> = {};
        for (const part of body.items) {
          if (part.key.trim() === "") continue;
          properties[part.key] = part.file
            ? { type: "string", format: "binary" }
            : { type: "string", example: isPrivateVariable(part) ? "" : safeText(part.value) };
        }
        operation.requestBody = {
          content: { "multipart/form-data": { schema: { type: "object", properties } } },
        };
      } else if (body.type === "binary") {
        operation.requestBody = { content: { [body.contentType || "application/octet-stream"]: { schema: { type: "string", format: "binary" } } } };
      } else if (body.type === "graphql") {
        operation.requestBody = {
          content: { "application/json": { example: { query: body.query, variables: jsonOrString(body.variables) } } },
        };
      }

      if ((doc?.responses ?? []).length > 0) {
        const responses: Record<string, unknown> = {};
        for (const res of doc!.responses) {
          const entry: Record<string, unknown> = {
            description: res.description ? `${res.name} — ${res.description}` : res.name,
          };
          // 响应字段定义写进 OpenAPI schema / headers，导出后仍可再导入回来。
          const schema = responseParamsToSchema(res.params);
          const headers = responseParamsToHeaders(res.params);
          if (schema) {
            // schema 描述字段结构，example 保留原始响应样例，两者并存。
            const media: Record<string, unknown> = { schema };
            if (res.body.trim() !== "") media.example = jsonOrString(res.body);
            entry.content = { [res.contentType || "application/json"]: media };
          } else if (res.body.trim() !== "") {
            entry.content = { [res.contentType || "application/json"]: { example: jsonOrString(res.body) } };
          }
          if (headers) entry.headers = headers;
          responses[String(res.status)] = entry;
        }
        operation.responses = responses;
      }

      pathObj[method] = operation;
    }
  }

  const result: Record<string, unknown> = {
    openapi: "3.0.3",
    info: { title: "Reqora Export", version: "1.0.0" },
  };
  const baseUrl = findBaseUrl(snapshot);
  if (baseUrl) result.servers = [{ url: baseUrl }];
  result.paths = paths;
  if (Object.keys(securitySchemes).length > 0) result.components = { securitySchemes };
  return JSON.stringify(result, null, 2);
}

// ----------------------------------------------------- exportMarkdown ----

function mdEscape(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** 参数表格式化器：直接消费 DocSitePayload 的 DocSiteParamRow[]。 */
function mdParamTable(rows: DocSiteParamRow[]): string[] {
  const out: string[] = [];
  out.push("| 参数 | 位置 | 类型 | 必填 | 说明 | 示例 |");
  out.push("| --- | --- | --- | --- | --- | --- |");
  for (const r of rows) {
    out.push(
      `| ${mdEscape(r.name)} | ${mdEscape(r.location ?? "")} | ${mdEscape(r.type || "string")} | ${r.required ? "是" : "否"} | ${mdEscape(r.description ?? "")} | ${mdEscape(r.example)} |`,
    );
  }
  out.push("");
  return out;
}

/**
 * JSON 请求体字段表：与响应字段表一致，按对象层级缩进（specValueList → array
 * → bid），下标折叠进父级。Query / Header 仍走平铺的 mdParamTable。
 */
function mdBodyParamTable(rows: DocSiteParamRow[]): string[] {
  const out: string[] = [];
  out.push("| 参数 | 位置 | 类型 | 必填 | 说明 | 示例 |");
  out.push("| --- | --- | --- | --- | --- | --- |");
  for (const node of requestBodyFieldTreeRows(rows)) {
    const name = `${"　".repeat(node.depth)}${node.leafName}`;
    if (node.isGroup) {
      const item = node.item;
      out.push(
        `| **${mdEscape(name)}** | body | ${mdEscape(node.containerType)} | ${item && item.required ? "是" : "否"} | ${mdEscape(item ? item.description : "")} | ${mdEscape(item ? item.example : "")} |`,
      );
      continue;
    }
    const item = node.item;
    out.push(
      `| ${mdEscape(name)} | body | ${mdEscape(item ? item.type || "string" : "string")} | ${item && item.required ? "是" : "否"} | ${mdEscape(item ? item.description : "")} | ${mdEscape(item ? item.example : "")} |`,
    );
  }
  out.push("");
  return out;
}

/** 与既有 Markdown 标题保持一致（payload 里该表叫 "Header 参数"）。 */
function mdTableLabel(label: string): string {
  return label === "Header 参数" ? "请求头" : label;
}

/**
 * Markdown exports are shareable artifacts: never write live tokens or
 * passwords into the file. Only the scheme and non-secret key names appear;
 * every credential value is a placeholder the reader must fill in.
 */
function mdAuthLine(auth: AuthSpec): string {
  switch (auth.type) {
    case "oauth2":
      return `- 鉴权：OAuth 2.0（${auth.grant}），tokenUrl \`${auth.tokenUrl || "<tokenUrl>"}\`，访问令牌 \`{{token}}\`（值请自行填写）`;
    case "awsSigV4":
      return `- 鉴权：AWS SigV4，region \`${auth.region}\`、service \`${auth.service}\`，密钥 \`<redacted>\`（值请自行填写）`;
    case "mtls":
      return "- 鉴权：mTLS，客户端证书与私钥 `<redacted>`（值请自行填写）";
    case "bearer":
      return "- 鉴权：Bearer，Header `Authorization: Bearer {{token}}`（值请自行填写）";
    case "basic":
      return `- 鉴权：Basic，用户名 \`${auth.username || "{{username}}"}\`、密码 \`{{password}}\`（值请自行填写）`;
    case "apiKey":
      return auth.location === "header"
        ? `- 鉴权：API Key，Header \`${auth.key}: {{apiKey}}\`（值请自行填写）`
        : `- 鉴权：API Key，Query 参数 \`${auth.key}={{apiKey}}\`（值请自行填写）`;
    default:
      return "";
  }
}

/**
 * 单个接口的 Markdown 格式化器。heading / resHeading 由文件夹层级决定：
 * 集合根级接口用 `##`（响应示例 `###`），文件夹内降一级（`###` / `####`）。
 *
 * 结构、分组、Query/Header 参数表、响应示例与响应字段表都来自
 * buildDocSitePayload 的 DocSiteRequest，避免与网页版 / HTML 导出重复投影。
 * 仍从原始 RequestDraft 取的三项属于 Markdown 特有格式、不在共享 payload 里：
 * - 标题里的 URL 模板字面量（{{baseUrl}}，导出是可分享模板而非解析后的地址）；
 * - 请求体的富布局（表单表 / GraphQL 分块 / 文件占位）与 paramMeta 注解的 Body 字段表；
 * - 鉴权说明（auth 由集合继承解析而来，DocSitePayload 刻意不含）。
 */
function pushRequestMarkdown(
  out: string[],
  req: DocSiteRequest,
  raw: RequestDraft | undefined,
  collections: Collection[],
  heading: string,
  resHeading: string,
): void {
  const url = (raw?.url || req.url) || "（未填写 URL）";
  out.push(`${heading} ${req.method} ${url} ${req.name}`, "");
  if (req.summary) out.push(`**${req.summary}**`, "");
  if (req.description) out.push(req.description, "");

  if (raw) {
    const authLine = mdAuthLine(resolveRequestAuth(raw, collections).auth);
    if (authLine) out.push(authLine, "");
  }

  // Query / Header 参数表直接消费 payload 的 request.tables（Body 字段表由请求体段产出）。
  for (const table of req.tables) {
    if (table.rows.length === 0 || table.label === "Body 字段") continue;
    out.push(`**${mdTableLabel(table.label)}**`, "");
    out.push(...mdParamTable(table.rows));
  }

  // 请求体富布局：按原始行还原 Markdown 特有的表格 / 代码块 / 文件占位。
  const body = raw?.body;
  const doc = raw?.doc;
  if (body && body.type === "json") {
    const bodyMetaRows: DocSiteParamRow[] = Object.entries(doc?.paramMeta ?? {})
      .filter(([k]) => k.startsWith("b:"))
      .map(([k, meta]) => ({
        name: k.slice(2),
        type: meta.type || "string",
        required: !!meta.required,
        example: meta.example ?? "",
        description: meta.description ?? "",
        location: "body",
      }));
    if (bodyMetaRows.length > 0) {
      out.push("**Body 字段**", "");
      out.push(...mdBodyParamTable(bodyMetaRows));
    }
    out.push("**请求体**（JSON）", "", "```json", body.content, "```", "");
  } else if (body && body.type === "raw") {
    out.push(`**请求体**（${body.contentType || "text/plain"}）`, "", "```", body.content, "```", "");
  } else if (body && body.type === "formUrlEncoded") {
    const rows: DocSiteParamRow[] = body.items
      .filter((kv) => kv.key.trim() !== "")
      .map((kv) => ({ name: kv.key, type: "string", required: false, example: kv.value, description: "", location: "body" }));
    out.push("**请求体**（form-urlencoded）", "");
    out.push(...mdParamTable(rows));
  } else if (body && body.type === "formData") {
    const rows: DocSiteParamRow[] = body.items
      .filter((p) => p.key.trim() !== "")
      .map((p) => ({
        name: p.key,
        type: "string",
        required: false,
        example: p.file ? `（文件 ${p.fileName || "?"}）` : p.value,
        description: "",
        location: "body",
      }));
    out.push("**请求体**（multipart/form-data）", "");
    out.push(...mdParamTable(rows));
  } else if (body && body.type === "binary") {
    out.push(`**请求体**（二进制文件：${body.fileName || "未命名"}，${body.contentType || "application/octet-stream"}）`, "");
  } else if (body && body.type === "graphql") {
    out.push("**请求体**（GraphQL）", "", "```graphql", body.query, "```", "");
    if (body.variables.trim() !== "") out.push("变量：", "```json", body.variables, "```", "");
  }

  // 响应示例：消费 payload 的 request.responses 与各自的 Body / Header 字段表。
  if (req.responses.length > 0) {
    out.push("**响应示例**", "");
    for (const res of req.responses) {
      const desc = res.description ? `：${res.description}` : "";
      out.push(`${resHeading} ${res.name}（${res.status}）${desc}`, "");
      for (const table of res.tables) {
        out.push(`**${table.label}**`, "");
        out.push("| 参数 | 类型 | 必填 | 说明 | 示例 |");
        out.push("| --- | --- | --- | --- | --- |");
        // 字段按对象层级缩进；父级判定 / 缩进层级 / 显示名统一取树行契约字段。
        for (const node of responseParamTreeRows(table.rows)) {
          const name = `${"　".repeat(node.indent / TREE_INDENT)}${node.leafName}`;
          if (node.isGroup) {
            out.push(`| **${mdEscape(name)}** | ${mdEscape(node.containerType)} | 否 |  |  |`);
            continue;
          }
          const item = node.item;
          out.push(
            `| ${mdEscape(name)} | ${mdEscape(item ? item.type || "string" : "string")} | ${item && item.required ? "是" : "否"} | ${mdEscape(item ? item.description : "")} | ${mdEscape(item ? item.example : "")} |`,
          );
        }
        out.push("");
      }
      if (res.text.trim() !== "") {
        out.push("```" + res.lang, res.text, "```", "");
      }
    }
  }
}

/**
 * 把工作区全部接口导出为 Markdown 接口文档。
 * 先 buildDocSitePayload(snapshot) 拿到唯一一份投影，再按文件夹分组
 * （与侧边栏一致：根级接口在前、文件夹按路径字母序）交给 Markdown 格式化器。
 * 公共章节由调用方 docPagesToMarkdown 前置拼接，这里只渲染集合内容。
 */
export function exportMarkdown(snapshot: WorkspaceSnapshot): string {
  const payload = buildDocSitePayload(snapshot, { variables: {} });
  const collections = snapshot.collections ?? [];
  const rawById = new Map<string, RequestDraft>();
  for (const collection of collections) {
    for (const item of collection.items ?? []) rawById.set(item.id, item);
  }
  const out: string[] = [];
  if (payload.collections.length === 0) {
    out.push("# API 文档", "", "（空工作区：没有可导出的接口）", "");
  }
  for (const collection of payload.collections) {
    out.push(`# ${collection.name}`, "");
    // 多级文件夹按层级展开标题：一级文件夹 ##，其下接口 ###；
    // 二级文件夹 ###，其下接口 ####，依此类推（响应示例再降一级）。
    for (const node of folderOutline(folderGroups(collection.requests))) {
      if (node.path === "") {
        for (const req of node.requests) {
          pushRequestMarkdown(out, req, rawById.get(req.id), collections, "##", "###");
        }
      } else if (node.requests.length === 0) {
        out.push(`${"#".repeat(node.depth + 1)} ${node.name}`, "");
      } else {
        const heading = "#".repeat(node.depth + 2);
        for (const req of node.requests) {
          pushRequestMarkdown(out, req, rawById.get(req.id), collections, heading, "#".repeat(node.depth + 3));
        }
      }
    }
  }
  return out.join("\n");
}

// ------------------------------------------------------------ importHar ----

/** 单次导入的 entry 上限：HAR 动辄数千条，防止一次灌爆集合树。 */
const MAX_HAR_ENTRIES = 200;

/**
 * 解析 HAR 1.2（HTTP Archive）——浏览器 DevTools / 抓包工具导出的通用格式。
 *
 * - 每个 entry 的 request 转成一个接口；响应侧不导入（响应示例走文档编辑器）；
 * - URL 的 query 拆到可编辑的参数表（Rust 发送时会重新拼接）；
 * - postData：application/json → JSON 体，x-www-form-urlencoded → 表单，
 *   multipart/form-data → form-data 文本字段，其余 → raw（保留 mimeType）；
 * - cookies 转成 Cookie 请求头（仅当请求头里没有显式 Cookie 时）；
 * - name 取「METHOD 路径」，重名自动追加序号。
 *
 * @throws 没有 log.entries 或不是合法 JSON 时抛出中文 Error。
 */
export function importHar(json: string): ImportResult {
  const warnings: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("HAR 内容不是合法 JSON");
  }
  const log = asRecord(asRecord(data)?.log);
  const entries = asArray(log?.entries);
  if (entries.length === 0) {
    throw new Error("HAR 中没有找到 log.entries 请求条目");
  }
  if (entries.length > MAX_HAR_ENTRIES) {
    warnings.push(`共 ${entries.length} 条请求，仅导入前 ${MAX_HAR_ENTRIES} 条`);
  }

  const items: RequestDraft[] = [];
  const nameCount = new Map<string, number>();
  let skipped = 0;

  for (const entry of entries.slice(0, MAX_HAR_ENTRIES)) {
    const request = asRecord(asRecord(entry)?.request);
    if (!request) {
      skipped += 1;
      continue;
    }
    const methodRaw = asString(request.method).toUpperCase();
    const method = (HTTP_METHODS as readonly string[]).includes(methodRaw)
      ? (methodRaw as RequestDraft["method"])
      : "GET";
    const rawUrl = asString(request.url);
    if (rawUrl === "") {
      skipped += 1;
      continue;
    }

    // Query 拆表：URL 只留 origin+path，参数进 query 行。
    let url = rawUrl;
    let query: KeyValue[] = [];
    try {
      const parsed = new URL(rawUrl);
      url = parsed.origin + parsed.pathname;
      query = [...parsed.searchParams.entries()].map(([key, value]) => row(key, value));
    } catch {
      // 相对路径或非法 URL：原样保留，query 不拆。
    }
    if (query.length === 0) {
      // HAR 的 queryString 与 URL 互补；上面拆不到时兜底读一遍。
      query = asArray(request.queryString)
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null)
        .filter((item) => asString(item.name) !== "")
        .map((item) => row(asString(item.name), asString(item.value)));
    }

    const headers = asArray(request.headers)
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null)
      .filter((item) => asString(item.name) !== "")
      .map((item) => row(asString(item.name), asString(item.value)));

    // Cookies → Cookie 头（显式头优先，不重复注入）。
    const hasCookieHeader = headers.some(
      (item) => item.key.toLowerCase() === "cookie",
    );
    if (!hasCookieHeader) {
      const cookiePairs = asArray(request.cookies)
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null)
        .filter((item) => asString(item.name) !== "")
        .map((item) => `${asString(item.name)}=${asString(item.value)}`);
      if (cookiePairs.length > 0) headers.push(row("Cookie", cookiePairs.join("; ")));
    }

    // postData → BodySpec。
    const postData = asRecord(request.postData);
    let body: RequestDraft["body"] = { type: "none" };
    if (postData) {
      const mimeType = asString(postData.mimeType).toLowerCase();
      const text = asString(postData.text);
      const params = asArray(postData.params)
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null)
        .filter((item) => asString(item.name) !== "");
      if (mimeType.includes("application/json")) {
        body = text !== "" ? { type: "json", content: text } : { type: "none" };
      } else if (mimeType.includes("x-www-form-urlencoded")) {
        body = {
          type: "formUrlEncoded",
          items:
            params.length > 0
              ? params.map((item) => row(asString(item.name), asString(item.value)))
              : parseUrlEncodedPairs(text),
        };
      } else if (mimeType.includes("multipart/form-data")) {
        if (params.some((item) => asRecord(item)?.fileName !== undefined && asRecord(item)?.fileName !== null)) {
          warnings.push("multipart 中含文件字段，已按文本导入（文件内容不随 HAR 保存）");
        }
        body = {
          type: "formData",
          items: params.map((item) => row(asString(item.name), asString(item.value))),
        };
      } else if (text !== "") {
        body = {
          type: "raw",
          content: text,
          contentType: mimeType || "text/plain",
        };
      }
    }

    // name：METHOD + 路径，重名追加序号。
    let pathname = rawUrl;
    try {
      pathname = new URL(rawUrl).pathname || "/";
    } catch {
      // 保持原串
    }
    const base = `${method} ${pathname}`;
    const seen = nameCount.get(base) ?? 0;
    nameCount.set(base, seen + 1);
    const name = seen === 0 ? base : `${base} (${seen + 1})`;

    items.push(newDraft({ name, method, url, headers, query, body }));
  }

  if (skipped > 0) {
    warnings.push(`${skipped} 条 entry 缺少 request 或 URL，已跳过`);
  }
  if (items.length === 0) {
    throw new Error("HAR 中没有可导入的请求");
  }
  return {
    collections: [{ name: "HAR 导入", items }],
    environments: [],
    warnings,
  };
}

// ------------------------------------------------------ importInsomnia ----

/**
 * Insomnia 导入：v4（`__export_format: 4` / `resources[]`）与 v5
 * （`collection.insomnia.rest/5.0` / `collection[]`）。
 *
 * 上游 Yaak 在 Insomnia 导入上反复出过的问题，这里从一开始就规避：
 * - #290 / #291：v4、v5 的 `parameters` 都要导入；变量/标签转换必须覆盖 URL、
 *   header、query、body、form、auth、环境等**所有**字符串（递归一次完成）。
 * - #507：XML、`+json`、未知文本 body 不能静默丢弃，要保留原 Content-Type；
 *   v4 与 v5 共用同一份 body/header 映射，不做两份实现。
 * - #693 / #712：Nunjucks 标签不能原样当文本悄悄发出去；只做精确等价转换，
 *   其余保留并在 warnings 里显式列明。GraphQL envelope 拆成可发送的
 *   query/variables，variables 保留原始 JSON 类型，Content-Type 固定为
 *   application/json；v4 的 request 允许没有 authentication。
 * - feedback「大集合卡死」「zip 一直 loading」：单次线性解析、明确体积上限与
 *   zip 中文错误，不把大文件/压缩包丢给 cURL 解析器空转。
 */
const INSOMNIA_MAX_CHARS = 20 * 1024 * 1024;

/** 输入级问题：返回中文原因，调用方应直接拒绝而不是继续解析。 */
export function insomniaInputError(content: string): string | null {
  if (content.length > INSOMNIA_MAX_CHARS) {
    return `导入内容过大（约 ${Math.round(content.length / 1024 / 1024)} MB）；请在 Insomnia 中按 workspace 分批导出后分别导入`;
  }
  if (content.startsWith("PK\u0003\u0004") || content.trimStart().startsWith("PK\u0003\u0004")) {
    return "检测到 ZIP 压缩包；请解压后选择单个 workspace 的 .json / .yaml 导出文件（多 workspace 的 zip 暂不支持）";
  }
  return null;
}

const INSOMNIA_BRACKET_VAR = /\{\{\s*_\s*\[\s*['"]([^'"]+)['"]\s*\]\s*\}\}/g;
const INSOMNIA_DOT_VAR = /\{\{\s*_\s*\.\s*([^{}]+?)\s*\}\}/g;
const INSOMNIA_PLAIN_VAR = /\{\{\s*(?!\$)([^{}]+?)\s*\}\}/g;
const INSOMNIA_UUID_TAG = /\{%\s*uuid\s*(?:['"]v4['"])?\s*%\}/gi;
const INSOMNIA_LEGACY_TIMESTAMP = /\{%\s*timestamp\s*%\}/gi;
const INSOMNIA_NOW_TAG = /\{%\s*now\s*(?:,\s*)?(?:['"]([^'"]+)['"])?\s*%\}/gi;
const INSOMNIA_ANY_TAG = /\{%\s*([A-Za-z0-9_]+)[^%]*?%\}/g;

/** 把 Insomnia 的 Nunjucks 变量/标签转成 Reqora 可执行或至少**可见**的写法。 */
function normalizeInsomniaText(input: string, unsupported: Set<string>): string {
  let out = input
    .replace(INSOMNIA_BRACKET_VAR, (_m, name: string) => `{{${name.trim()}}}`)
    .replace(INSOMNIA_DOT_VAR, (_m, name: string) => `{{${name.trim()}}}`)
    .replace(INSOMNIA_PLAIN_VAR, (_m, name: string) => `{{${name.trim()}}}`)
    .replace(INSOMNIA_UUID_TAG, "{{$guid}}")
    .replace(INSOMNIA_LEGACY_TIMESTAMP, "{{$timestampMs}}");
  // 只转换语义完全一致的 now 参数；custom 格式 token 与 Reqora 不兼容，保留并告警。
  out = out.replace(INSOMNIA_NOW_TAG, (whole, format: string | undefined) => {
    const kind = (format ?? "iso-8601").toLowerCase();
    if (kind === "unix" || kind === "seconds" || kind === "s") return "{{$timestamp}}";
    if (kind === "millis" || kind === "ms") return "{{$timestampMs}}";
    if (kind === "iso-8601") return "{{$isoDate}}";
    return whole;
  });
  // 其余标签一律保留原文并登记，绝不静默当成普通文本发送（#712 的核心教训）。
  return out.replace(INSOMNIA_ANY_TAG, (whole, tag: string) => {
    unsupported.add(tag.toLowerCase());
    return whole;
  });
}

/** #291：递归覆盖结果里的每一个字符串，而不是只处理 URL/body。 */
function normalizeInsomniaStrings<T>(value: T, unsupported: Set<string>): T {
  if (typeof value === "string") return normalizeInsomniaText(value, unsupported) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((item) => normalizeInsomniaStrings(item, unsupported)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = normalizeInsomniaStrings(child, unsupported);
    }
    return out as unknown as T;
  }
  return value;
}

/** headers / parameters 共用：`disabled` 是 Insomnia 的禁用标记。 */
function insomniaRows(entries: unknown): KeyValue[] {
  const out: KeyValue[] = [];
  for (const entry of asArray(entries)) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const key = asString(rec.name ?? rec.key);
    const value = asString(rec.value);
    if (key.trim() === "" && value.trim() === "") continue;
    out.push(row(key, value, rec.disabled !== true && rec.enabled !== false));
  }
  return out;
}

/** 表单行：文件名只作标记，导出的 JSON 不含文件内容，必须显式提示。 */
function insomniaFormParts(entries: unknown, warnings: string[]): FormPart[] {
  const parts: FormPart[] = [];
  for (const entry of asArray(entries)) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const key = asString(rec.name ?? rec.key);
    if (key.trim() === "") continue;
    const fileName = asString(rec.fileName ?? rec.file);
    const base = row(key, asString(rec.value), rec.disabled !== true && rec.enabled !== false);
    parts.push({ ...base, file: fileName !== "", fileName } as FormPart);
    if (fileName !== "") {
      warnings.push(`表单字段「${key}」引用了本地文件「${fileName}」，导出不含其内容，导入后请重新选择文件`);
    }
  }
  return parts;
}

/** 扫描顶层成员，值保留原始文本（含模板标签），不做 JSON 解析。 */
function insomniaTopLevelMembers(text: string): Map<string, string> | null {
  const s = text.trim();
  if (!s.startsWith("{")) return null;
  const out = new Map<string, string>();
  let i = 1;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (s[i] === "}") return out;
    if (s[i] !== '"') return null;
    const keyEnd = insomniaScanString(s, i);
    if (keyEnd === null) return null;
    let key: unknown;
    try {
      key = JSON.parse(s.slice(i, keyEnd));
    } catch {
      return null;
    }
    if (typeof key !== "string") return null;
    i = keyEnd;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] !== ":") return null;
    i++;
    while (i < s.length && /\s/.test(s[i])) i++;
    const valueEnd = insomniaScanValue(s, i);
    if (valueEnd === null) return null;
    out.set(key, s.slice(i, valueEnd).trim());
    i = valueEnd;
  }
  return null;
}

function insomniaScanString(s: string, start: number): number | null {
  if (s[start] !== '"') return null;
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return i + 1;
  }
  return null;
}

function insomniaScanValue(s: string, start: number): number | null {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      const end = insomniaScanString(s, i);
      if (end === null) return null;
      i = end - 1;
      if (depth === 0) return i + 1;
    } else if (c === "{" || c === "[") {
      depth++;
    } else if (c === "}" || c === "]") {
      if (depth === 0) return i;
      depth--;
      if (depth === 0) return i + 1;
    } else if (depth === 0 && c === ",") {
      return i;
    }
  }
  return null;
}

/**
 * GraphQL envelope：合法 JSON 走结构化拆分，含模板标签的非法 JSON 走原始文本
 * 提取。**variables 绝不逐字段类型改写**（数字/布尔/数组保持原样），这是
 * 上游 #693 review 指出的 P1 问题。
 */
function insomniaGraphQLEnvelope(text: string, warnings: string[]): { query: string; variables: string } {
  try {
    const parsed = asRecord(JSON.parse(text));
    if (parsed && typeof parsed.query === "string") {
      if (typeof parsed.operationName === "string" && parsed.operationName.trim() !== "") {
        warnings.push(`GraphQL operationName「${parsed.operationName}」暂不支持，已省略`);
      }
      const variables = parsed.variables;
      return {
        query: parsed.query,
        variables:
          typeof variables === "string"
            ? variables
            : variables === null || variables === undefined
              ? ""
              : JSON.stringify(variables, null, 2),
      };
    }
  } catch {
    // envelope 里写了模板标签，不是合法 JSON：按原始文本恢复各成员。
  }
  const members = insomniaTopLevelMembers(text);
  if (members) {
    const rawQuery = members.get("query");
    if (rawQuery && rawQuery.startsWith('"')) {
      try {
        const query: unknown = JSON.parse(rawQuery);
        if (typeof query === "string") {
          if (members.has("operationName")) {
            warnings.push("含模板标签的 GraphQL envelope 中的 operationName 暂不支持，已省略");
          }
          const variables = members.get("variables") ?? "";
          return { query, variables: variables === "null" ? "" : variables };
        }
      } catch {
        // 落到整体保留
      }
    }
  }
  warnings.push("GraphQL 请求体含模板标签且无法拆分 envelope，已整体保留为 query，请手动检查 variables");
  return { query: text, variables: "" };
}

/** v4 / v5 共用的 body 映射（#507）：MIME 归类，未知文本一律保留为 raw。 */
function insomniaBody(raw: unknown, warnings: string[]): { body: BodySpec; contentType: string | null } {
  const rec = asRecord(raw);
  if (!rec) return { body: { type: "none" }, contentType: null };
  const mime = asString(rec.mimeType).trim();
  const normalized = mime.split(";")[0].trim().toLowerCase();
  const text = typeof rec.text === "string" ? rec.text : "";
  const params = rec.params;

  if (normalized === "application/octet-stream" || normalized === "") {
    const fileName = asString(rec.fileName ?? rec.name);
    if (fileName !== "") {
      warnings.push(`请求体引用本地文件「${fileName}」，导出不含其内容，导入后请重新选择文件`);
    }
    return {
      body: text ? { type: "raw", content: text, contentType: mime || "application/octet-stream" } : { type: "none" },
      contentType: mime || null,
    };
  }
  if (normalized === "application/x-www-form-urlencoded") {
    return { body: { type: "formUrlEncoded", items: insomniaFormParts(params, warnings) }, contentType: mime };
  }
  if (normalized === "multipart/form-data") {
    return { body: { type: "formData", items: insomniaFormParts(params, warnings) }, contentType: mime };
  }
  if (normalized === "application/graphql") {
    const envelope = insomniaGraphQLEnvelope(text, warnings);
    // Insomnia 用 application/graphql 作编辑器标记，实际发送的是 JSON envelope。
    return { body: { type: "graphql", query: envelope.query, variables: envelope.variables }, contentType: "application/json" };
  }
  if (normalized === "application/json" || normalized.endsWith("+json")) {
    return { body: { type: "json", content: text }, contentType: mime };
  }
  // text/xml、application/xml、*+xml 以及任何其它文本都保留（#507）。
  return { body: { type: "raw", content: text, contentType: mime }, contentType: mime };
}

/** 只映射精确等价的鉴权；其它类型显式告警，绝不假装已导入。 */
function insomniaAuth(raw: unknown, fallback: AuthSpec | null, warnings: string[]): AuthSpec {
  const rec = asRecord(raw);
  if (!rec) return fallback ?? { type: "none" };
  if (rec.disabled === true || rec.enabled === false) return fallback ?? { type: "none" };
  const type = asString(rec.type).toLowerCase();
  if (type === "" || type === "none") return fallback ?? { type: "none" };
  if (type === "bearer") return { type: "bearer", token: asString(rec.token) };
  if (type === "basic") return { type: "basic", username: asString(rec.username), password: asString(rec.password) };
  if (type === "apikey" || type === "api_key" || type === "api-key") {
    const addTo = asString(rec.addTo ?? rec.location).toLowerCase();
    return {
      type: "apiKey",
      key: asString(rec.key),
      value: asString(rec.value),
      location: addTo === "query" ? "query" : "header",
    };
  }
  warnings.push(`鉴权类型「${type}」在 Reqora 中没有等价实现，已按无鉴权导入`);
  return { type: "none" };
}

interface InsomniaContext {
  warnings: string[];
  items: RequestDraft[];
}

function insomniaSortKey(rec: Record<string, unknown>): number {
  const meta = asRecord(rec.meta);
  const value = rec.metaSortKey ?? meta?.sortKey;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * 拆 URL 自带的 query。这里**不做** decodeURIComponent：Insomnia 的 URL 里常写
 * `{% ... %}` 标签（内含 `%`），通用解析会把它当百分号编码而抛错/改写，
 * 属于上游 #712 那类「导入后静默变值」问题。保持原始文本，交给模板层处理。
 */
function insomniaUrlPairs(raw: string): KeyValue[] {
  const out: KeyValue[] = [];
  for (const part of raw.split("&")) {
    if (part === "") continue;
    const at = part.indexOf("=");
    out.push(row(at === -1 ? part : part.slice(0, at), at === -1 ? "" : part.slice(at + 1)));
  }
  return out;
}

/** 单个请求（v4 / v5 完全共用，避免两份实现漂移）。 */
function insomniaRequest(
  rec: Record<string, unknown>,
  folderPath: string,
  fallbackAuth: AuthSpec | null,
  ctx: InsomniaContext,
): RequestDraft {
  const meta = asRecord(rec.meta);
  const rawUrl = asString(rec.url);
  const qIdx = rawUrl.indexOf("?");
  const url = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  // #290：URL 自带的 query 与独立的 parameters 都要导入。
  const query: KeyValue[] = [
    ...(qIdx >= 0 ? insomniaUrlPairs(rawUrl.slice(qIdx + 1)) : []),
    ...insomniaRows(rec.parameters ?? rec.query),
  ];
  const headers = insomniaRows(rec.headers);
  const { body, contentType } = insomniaBody(rec.body, ctx.warnings);
  // #693 review P1：body 有 MIME 且请求没显式声明时补 Content-Type；
  // GraphQL 必须声明 application/json（发送的是 JSON envelope）。
  if (contentType && !headers.some((item) => item.key.toLowerCase() === "content-type")) {
    headers.unshift(row("Content-Type", contentType));
  }
  const methodRaw = (asString(rec.method) || "GET").toUpperCase();
  const method: HttpMethod = (HTTP_METHODS as readonly string[]).includes(methodRaw)
    ? (methodRaw as HttpMethod)
    : "GET";
  return newDraft({
    name: asString(rec.name) || asString(meta?.name) || "未命名请求",
    description: asString(rec.description) || asString(meta?.description) || "",
    folder: folderPath,
    method,
    url,
    headers,
    query,
    body,
    // #693：v4 的 request 可以完全没有 authentication，缺省回退到文件夹级鉴权。
    auth: insomniaAuth(rec.authentication ?? rec.auth, fallbackAuth, ctx.warnings),
  });
}

function insomniaEnvironments(entries: unknown[], defaultName: string): Omit<Environment, "id">[] {
  const out: Omit<Environment, "id">[] = [];
  for (const entry of entries) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const meta = asRecord(rec.meta);
    const data = asRecord(rec.data ?? rec.environment ?? rec.variables);
    if (!data) continue;
    const privateEnv = rec.isPrivate === true || rec.private === true;
    const variables: KeyValue[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (key.trim() === "") continue;
      const item = row(key, typeof value === "string" ? value : JSON.stringify(value), true);
      if (privateEnv) (item as KeyValue & { secret?: boolean }).secret = true;
      variables.push(item);
    }
    if (variables.length > 0) {
      out.push({ name: asString(rec.name) || asString(meta?.name) || defaultName, variables });
    }
  }
  return out;
}

function isInsomniaV4(root: Record<string, unknown>): boolean {
  return (
    Array.isArray(root.resources) ||
    asString(root._type) === "export" ||
    asString(root.__export_format).startsWith("4")
  );
}

function isInsomniaV5(root: Record<string, unknown>): boolean {
  const type = asString(root.type);
  return (
    type.startsWith("collection.insomnia.rest/5") ||
    (type.startsWith("collection.insomnia.rest") && Array.isArray(root.collection))
  );
}

/** v4：resources[] 扁平表，用 Map 建索引，parent 链带缓存与环保护。 */
function insomniaV4(root: Record<string, unknown>, ctx: InsomniaContext): ImportResult {
  const resources = asArray(root.resources)
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== null);
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of resources) {
    const id = asString(item._id);
    if (id !== "") byId.set(id, item);
  }
  const workspace = resources.find((item) => asString(item._type) === "workspace");
  const name = asString(workspace?.name) || "导入的 Insomnia 集合";

  const pathCache = new Map<string, string>();
  const authCache = new Map<string, AuthSpec | null>();
  const pathOf = (id: string): string => {
    const cached = pathCache.get(id);
    if (cached !== undefined) return cached;
    const chain: string[] = [];
    const seen = new Set<string>();
    let cursor = id;
    while (cursor !== "" && byId.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      const node = byId.get(cursor)!;
      if (asString(node._type) === "request_group") {
        chain.unshift(asString(node.name) || "未命名分组");
      }
      cursor = asString(node.parentId);
    }
    const path = chain.join("/");
    pathCache.set(id, path);
    return path;
  };
  const authOf = (id: string): AuthSpec | null => {
    if (authCache.has(id)) return authCache.get(id)!;
    const seen = new Set<string>();
    let cursor = id;
    let found: AuthSpec | null = null;
    while (cursor !== "" && byId.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      const node = byId.get(cursor)!;
      const declared = asRecord(node.authentication);
      if (declared) {
        const parsed = insomniaAuth(declared, null, ctx.warnings);
        if (parsed.type !== "none") {
          found = parsed;
          break;
        }
      }
      cursor = asString(node.parentId);
    }
    authCache.set(id, found);
    return found;
  };

  const requests = resources
    .filter((item) => asString(item._type) === "request")
    .sort((a, b) => insomniaSortKey(a) - insomniaSortKey(b));
  for (const item of requests) {
    const parentId = asString(item.parentId);
    ctx.items.push(insomniaRequest(item, pathOf(parentId), authOf(parentId), ctx));
  }

  const environments = insomniaEnvironments(
    resources.filter((item) => asString(item._type) === "environment"),
    `${name} 变量`,
  );
  // v4 的文件夹级变量放在 request_group.environment 里，合并成一份环境。
  const folderVars: KeyValue[] = [];
  for (const item of resources) {
    if (asString(item._type) !== "request_group") continue;
    const data = asRecord(item.environment);
    if (!data) continue;
    for (const [key, value] of Object.entries(data)) {
      if (key.trim() === "") continue;
      const next = row(key, typeof value === "string" ? value : JSON.stringify(value), true);
      const at = folderVars.findIndex((existing) => existing.key === key);
      if (at >= 0) folderVars[at] = next;
      else folderVars.push(next);
    }
  }
  if (folderVars.length > 0) environments.push({ name: `${name} 文件夹变量`, variables: folderVars });
  return { collections: [{ name, items: ctx.items }], environments, warnings: ctx.warnings };
}

/** v5：层级 collection[]，folder 的鉴权与路径向下继承。 */
function insomniaV5(root: Record<string, unknown>, ctx: InsomniaContext): ImportResult {
  const meta = asRecord(root.meta);
  const name = asString(root.name) || asString(meta?.name) || "导入的 Insomnia 集合";
  const walk = (entries: unknown[], folderPath: string, fallbackAuth: AuthSpec | null): void => {
    const sorted = entries
      .map(asRecord)
      .filter((item): item is Record<string, unknown> => item !== null)
      .sort((a, b) => insomniaSortKey(a) - insomniaSortKey(b));
    for (const item of sorted) {
      const itemMeta = asRecord(item.meta);
      const itemName = asString(item.name) || asString(itemMeta?.name) || "未命名";
      const type = asString(item.type).toLowerCase();
      const declared = insomniaAuth(item.authentication ?? item.auth, fallbackAuth, ctx.warnings);
      const children = item.children ?? item.collection ?? item.items;
      if (type === "folder" || Array.isArray(children)) {
        walk(asArray(children), folderPath ? `${folderPath}/${itemName}` : itemName, declared);
        continue;
      }
      if (type === "request" || type === "http_request" || asString(item.url) !== "") {
        ctx.items.push(insomniaRequest(item, folderPath, fallbackAuth, ctx));
      } else {
        ctx.warnings.push(`暂不支持的 Insomnia 资源类型「${type || "未知"}」（${itemName}），已跳过`);
      }
    }
  };
  walk(asArray(root.collection ?? root.collections ?? root.items), "", null);
  const envEntries = [
    ...asArray(root.environments),
    ...(asRecord(root.environment) ? [root.environment] : []),
  ];
  const environments = insomniaEnvironments(envEntries, `${name} 变量`);
  return { collections: [{ name, items: ctx.items }], environments, warnings: ctx.warnings };
}

/**
 * 解析 Insomnia 导出（JSON 优先，YAML 尽力而为）。返回与其它 importer 相同的
 * ImportResult；所有字符串在返回前统一做一次模板转换（#291）。
 */
export function importInsomnia(content: string): ImportResult {
  const inputError = insomniaInputError(content);
  if (inputError) throw new Error(inputError);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim());
  } catch {
    try {
      parsed = parseMinimalYaml(content);
    } catch {
      throw new Error("无法解析 Insomnia 导出：内容不是合法 JSON / YAML，建议在 Insomnia 中导出为 JSON 后重试");
    }
  }
  const root = asRecord(parsed);
  if (!root) throw new Error("无法解析 Insomnia 导出：根节点不是对象");

  const ctx: InsomniaContext = { warnings: [], items: [] };
  let result: ImportResult;
  if (isInsomniaV5(root)) result = insomniaV5(root, ctx);
  else if (isInsomniaV4(root)) result = insomniaV4(root, ctx);
  else {
    throw new Error("无法识别 Insomnia 导出格式：既不是 v4（resources[]）也不是 v5（collection[]）；如为多 workspace 导出，请逐个 workspace 导出");
  }

  const unsupported = new Set<string>();
  const converted = normalizeInsomniaStrings(
    { collections: result.collections, environments: result.environments },
    unsupported,
  );
  const warnings = [...new Set(result.warnings)];
  if (unsupported.size > 0) {
    warnings.push(
      `以下 Insomnia 模板标签在 Reqora 中没有等价实现，已原样保留（发送请求前请手动替换）：` +
        [...unsupported].map((tag) => `{% ${tag} %}`).join("、"),
    );
  }
  if (result.collections.every((collection) => collection.items.length === 0)) {
    warnings.push("没有找到可导入的 HTTP 请求");
  }
  warnings.push(
    "重复导入：请在导入对话框选择已有集合作为目标，同一文件夹内方法+URL 相同的接口会被覆盖更新；若选择「新建集合」，每次都会创建一份新集合",
  );
  return {
    collections: converted.collections,
    environments: converted.environments,
    warnings,
  };
}

// ------------------------------------------ T2.1 · importTestAssets ----

/**
 * 解析 `reqora.test.v1` 测试资产（YAML / JSON），返回与既有导入器同形的
 * ImportResult。纯只读解析：不写工作区、不生成随机 id；collections /
 * environments 只用于导入弹窗的只读预览，真正的资产载荷放在 testAssets 里。
 */
export function importTestAssets(content: string): ImportResult {
  const text = content.trim();
  if (text === "") throw new Error("无法解析 reqora.test.v1：内容为空");
  let data: unknown;
  if (text.startsWith("{")) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("无法解析 reqora.test.v1：JSON 格式有误");
    }
  } else {
    data = parseMinimalYaml(text);
  }
  const assets = decodeTestAssets(data);

  const previewItems: RequestDraft[] = [];
  for (const caseItem of assets.cases) {
    const request = asRecord(caseItem.request);
    if (request) previewItems.push(request as unknown as RequestDraft);
  }
  const collections: Omit<Collection, "id">[] = previewItems.length > 0
    ? [{ name: "测试资产用例", items: previewItems }]
    : [];
  const environments: Omit<Environment, "id">[] = assets.environmentVariableNames.length > 0
    ? [{
        name: "导出资产中的环境变量名",
        variables: assets.environmentVariableNames.map((key, index) => ({
          id: `env-name-${index}`, key, value: "", enabled: true,
        })),
      }]
    : [];
  const warnings = [
    `测试资产：用例 ${assets.cases.length} / 场景 ${assets.scenarios.length} / 套件 ${assets.suites.length} / 断言规则 ${assets.assertionRules.length} / 脚本片段 ${assets.scriptLibrary.length} / Mock 规则 ${assets.mockRules.length} / CSV 数据集 ${assets.csvDataSets.length}`,
    `私密变量名（不含值）：${assets.privateVariableNames.length} 个；环境变量名：${assets.environmentVariableNames.length} 个`,
    "reqora.test.v1 只含变量名不含值；token / 口令 / API Key 以 {{占位符}} 表示，导入后需在本机重新填写。",
  ];
  return { collections, environments, warnings, testAssets: assets.document };
}

// -------------------------------------------------------- detectFormat ----

/**
 * 启发式判断内容格式：Postman 集合 / Postman 环境文件 / OpenAPI / HAR / 未知。
 * 优先 JSON.parse 后看 info.schema、openapi 字段、log.entries 与 values；再对纯文本做关键字匹配。
 */
export function detectFormat(
  content: string,
): "postman" | "postman-env" | "openapi" | "har" | "insomnia" | "test-assets" | "unknown" {
  const trimmed = content.trim();
  if (trimmed === "") return "unknown";
  try {
    const data: unknown = JSON.parse(trimmed);
    const rec = asRecord(data);
    if (rec) {
      if (asString(rec.schema) === "reqora.test.v1") return "test-assets";
      const schema = asString(asRecord(rec.info)?.schema);
      if (schema.toLowerCase().includes("postman")) return "postman";
      if (typeof rec.openapi === "string" || typeof rec.swagger === "string") return "openapi";
      if (asRecord(rec.log) !== null && Array.isArray(asRecord(rec.log)?.entries)) return "har";
      // 单独导出的 Postman 环境 / 全局变量文件：values[] 且每项都有 key。
      if (Array.isArray(rec.values) && rec.values.length > 0) {
        const looksLikeVars = rec.values.every((entry) => {
          const item = asRecord(entry);
          return item !== null && !isBlank(item.key);
        });
        if (
          looksLikeVars &&
          (typeof rec._postman_variable_scope === "string" ||
            (!asRecord(rec.info) && !asRecord(rec.log)))
        ) {
          return "postman-env";
        }
      }
      // Insomnia v5 / v4：放在 Postman / OpenAPI / HAR 之后，避免误伤。
      if (isInsomniaV5(rec) || isInsomniaV4(rec)) return "insomnia";
    }
  } catch {
    // 不是 JSON，继续文本启发式
  }
  // T2.1：原生测试资产 YAML，顶层 schema: reqora.test.v1。
  if (/^schema\s*:\s*["']?reqora\.test\.v1["']?\s*$/m.test(trimmed)) return "test-assets";
  const lower = trimmed.slice(0, 2000).toLowerCase();
  if (lower.includes("postman_collection") || /"info"\s*:\s*\{[^}]*"schema"\s*:\s*"[^"]*postman/.test(trimmed)) {
    return "postman";
  }
  if (/^openapi\s*:/m.test(trimmed) || /^swagger\s*:\s*["']?2/m.test(trimmed)) return "openapi";
  // Insomnia v5 的 YAML 导出 / v4 的 YAML 片段。
  if (/collection\.insomnia\.rest\/5/.test(lower) || /__export_format\s*:\s*4/.test(trimmed)) {
    return "insomnia";
  }
  return "unknown";
}

// ------------------------------------------------------- previewImport ----

/**
 * 导入格式标识：detectFormat 的全部返回值 + curl 兜底。新增分支会让 UI 侧
 * `Record<ImportFormat, string>` 标签表在 tsc 阶段报缺键，避免静默漏接。
 */
export type ImportFormat = ReturnType<typeof detectFormat> | "curl";

/** 只读解析后的摘要，供导入弹窗在用户确认之前展示。 */
export interface ImportPreview {
  format: ImportFormat;
  collectionNames: string[];
  requestCount: number;
  environmentNames: string[];
  /** 去重后的变量名，用来核对 {{变量}} 是否都能取到值。 */
  variableNames: string[];
  warnings: string[];
  /** 解析失败时的中文原因；非 null 时不应允许确认导入。 */
  error: string | null;
}

/**
 * 纯函数预览：按与 store.importContent 相同的分派逻辑解析一次，但**不写工作区**。
 * 未知格式按 cURL 尝试（与正式导入一致），解析失败通过 error 返回而非抛出。
 */
export function previewImport(content: string): ImportPreview {
  const detected = detectFormat(content);
  const format: ImportFormat = detected === "unknown" ? "curl" : detected;
  const empty: ImportPreview = {
    format,
    collectionNames: [],
    requestCount: 0,
    environmentNames: [],
    variableNames: [],
    warnings: [],
    error: null,
  };
  // zip / 超大文件必须先给出明确中文原因，不能落到 cURL 解析里空转（上游反馈）。
  const inputError = insomniaInputError(content);
  if (inputError) return { ...empty, error: inputError };
  let result: ImportResult;
  try {
    if (format === "postman") result = importPostman(content);
    else if (format === "postman-env") {
      result = importPostmanEnvironment(content);
      // 环境文件的 values 里同样可能引用 Postman 专有动态变量，统一提示。
      warnUnknownDynamicTokens(content, result.warnings);
    }
    else if (format === "openapi") result = importOpenApi(content);
    else if (format === "har") result = importHar(content);
    else if (format === "insomnia") result = importInsomnia(content);
    else if (format === "test-assets") result = importTestAssets(content);
    else result = importCurl(content);
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : "导入失败" };
  }
  return {
    ...empty,
    collectionNames: result.collections.map((collection) => collection.name),
    requestCount: result.collections.reduce((sum, collection) => sum + collection.items.length, 0),
    environmentNames: result.environments.map((environment) => environment.name),
    variableNames: [
      ...new Set(
        result.environments.flatMap((environment) =>
          environment.variables
            .filter((variable) => variable.key.trim() !== "")
            .map((variable) => variable.key),
        ),
      ),
    ],
    warnings: result.warnings,
  };
}
