import type { CodeTemplate, RequestDraft } from "../types.ts";
import { effectiveRequest, shellQuote } from "./codegen.ts";
import { schemaFromExample } from "./jsonschema.ts";
import { tsTypeFromSchema } from "./sdk.ts";
import { uid } from "./id.ts";

/** 模板渲染上下文：所有字段都可以用 {{name}} 或 {{{name}}} 引用。 */
export interface CodeTemplateContext {
  method: string;
  methodLower: string;
  url: string;
  /** JSON.stringify(url)：安全的字符串字面量，适合直接放进 fetch(...)。 */
  urlJson: string;
  /**
   * 带 ${变量} 插值的 JS/TS 模板字面量（含反引号）。把 URL 里残留的
   * {{baseUrl}} 等标记转成 ${baseUrl}，供「环境变量在运行时注入」的代码。
   * 例：`${baseUrl}/polaris/api/edit`。无变量标记时退化为 urlJson 的双引号字面量。
   */
  urlExpr: string;
  /** 同 urlExpr，但不含两端反引号，方便用户自行拼接。 */
  urlTemplate: string;
  /** URL 里出现的变量标记名（去掉花括号），去重，如 ["baseUrl"]。 */
  urlVariables: string[];
  name: string;
  nameCamel: string;
  namePascal: string;
  nameSnake: string;
  /** 有效请求头（含鉴权与 Content-Type），供 {{#each headers}} 遍历。 */
  headers: { key: string; value: string }[];
  headersJson: string;
  headersJs: string;
  headersPy: string;
  headersGo: string;
  headersCurl: string;
  body: string;
  /** JSON.stringify(body)：带引号的字符串字面量。 */
  bodyJson: string;
  /** 尽量渲染成对象/数组字面量，失败时退化为字符串字面量。 */
  bodyLiteral: string;
  bodyPretty: string;
  hasBody: boolean;
  bodyNote: string;
  hasBodyNote: boolean;
  /** 由请求体 / 响应示例推导的 TypeScript 类型定义（整段可粘贴的声明）。 */
  requestType: string;
  responseType: string;
  /** 类型名（大驼峰），供用户在别处引用，如 EditSpecRequest / EditSpecResponse。 */
  requestTypeName: string;
  responseTypeName: string;
  /** 是否成功推导出至少一个类型，供 UI 提示。 */
  hasTypes: boolean;
}

export interface RenderResult {
  code: string;
  /** 模板里引用了但上下文不存在的变量，供 UI 提示拼写错误。 */
  unknownTokens: string[];
}

const pyQuote = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const jsQuote = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;

function wordsOf(name: string): string[] {
  return name.match(/[A-Za-z0-9]+/g) ?? ["request"];
}

function nameVariants(name: string) {
  const words = wordsOf(name).map((word) => word.toLowerCase());
  const pascal = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
  return {
    nameCamel: pascal.charAt(0).toLowerCase() + pascal.slice(1),
    namePascal: pascal,
    nameSnake: words.join("_"),
  };
}

/**
 * 把 URL 里残留的 {{baseUrl}} / {{token}} 标记转成 JS 模板字符串插值 ${...}。
 * - 已展开的真实值（如 https://x.com）不含 {{}}，原样输出；
 * - 仅有变量标记时生成反引号字面量，使 ${baseUrl} 在运行时求值；
 * - 反引号与字面 ${ 做转义，避免破坏生成代码的语法。
 */
function buildUrlExpression(url: string): {
  expr: string;
  template: string;
  variables: string[];
} {
  const variables: string[] = [];
  const template = url
    // {{baseUrl}} → ${baseUrl}；保持与环境变量标记一致的捕获范围。
    .replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_match, key: string) => {
      if (!variables.includes(key)) variables.push(key);
      return `\${${key}}`;
    })
    // URL 中真实的反引号 / ${ 只在转成模板字面量时需要转义。
    .replace(/`/g, "\\`")
    .replace(/\$\{(?!([A-Za-z_][A-Za-z0-9_]*)\})/g, "\\${");
  if (variables.length === 0) {
    // 没有残留变量：用安全双引号字面量，避免无谓的反引号。
    return { expr: JSON.stringify(url), template: url, variables };
  }
  return { expr: `\`${template}\``, template, variables };
}

/** 从一段 JSON 文本推导 TS 类型声明；失败返回 null。 */
function tsTypeFromJsonText(text: string): string | null {
  try {
    const example = JSON.parse(text);
    return tsTypeFromSchema(schemaFromExample(example), new Map());
  } catch {
    return null;
  }
}

/** 包一层可粘贴的 type 声明；没有可用样本时给出 unknown 占位与说明。 */
function typeDeclaration(typeName: string, body: string | null, note: string): string {
  if (!body) return `/** ${note}：无可用样本，需按实际结构补全 */\nexport type ${typeName} = unknown;`;
  return `/** ${note} */\nexport type ${typeName} = ${body};`;
}

/**
 * 从请求体 JSON 与首个响应示例推导请求/响应 TS 类型。
 * 只依赖 RequestDraft 自身携带的 doc，无需快照上下文。
 */
function buildTypes(request: RequestDraft, namePascal: string): {
  requestType: string;
  responseType: string;
  requestTypeName: string;
  responseTypeName: string;
  hasTypes: boolean;
} {
  // 纯中文名会被 wordsOf 回退成 "request"，直接用会得到 RequestRequest 这种
  // 冗余名字；此时改用 Api 前缀，类型名更可读，也不会撞 import 的 request。
  const fallback = /\p{Script=Han}/u.test(request.name || "") && namePascal === "Request";
  const prefix = fallback || !namePascal ? "Api" : namePascal;
  const requestTypeName = `${prefix}Request`;
  const responseTypeName = `${prefix}Response`;

  let requestBody: string | null = null;
  if (request.body.type === "json" && request.body.content.trim()) {
    requestBody = tsTypeFromJsonText(request.body.content);
  } else if (request.body.type === "raw" && request.body.content.trim()) {
    requestBody = "string";
  }

  let responseBody: string | null = null;
  const sample = request.doc?.responses?.find((item) => item.body && item.body.trim());
  if (sample) responseBody = tsTypeFromJsonText(sample.body);

  return {
    requestType: typeDeclaration(requestTypeName, requestBody, `${request.name || "请求"} 请求体`),
    responseType: typeDeclaration(responseTypeName, responseBody, `${request.name || "请求"} 响应体`),
    requestTypeName,
    responseTypeName,
    hasTypes: requestBody !== null || responseBody !== null,
  };
}

/** 依据当前请求与环境生成模板上下文（与内置代码生成共用 effectiveRequest）。 */
export function buildCodeTemplateContext(
  request: RequestDraft,
  variables: Record<string, string> = {},
  resolvedUrl?: string,
): CodeTemplateContext {
  const effective = effectiveRequest(request, variables, resolvedUrl);
  const headers = effective.headers.map(([key, value]) => ({ key, value }));
  const headerObject = Object.fromEntries(effective.headers);
  const body = effective.body ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const bodyLiteral =
    parsed === undefined ? JSON.stringify(body) : JSON.stringify(parsed, null, 2);
  const headersJson = JSON.stringify(headerObject, null, 2);
  const headersJs = `{\n${effective.headers
    .map(([key, value]) => `  ${jsQuote(key)}: ${jsQuote(value)},`)
    .join("\n")}\n}`;
  const headersPy = `{ ${effective.headers
    .map(([key, value]) => `${pyQuote(key)}: ${pyQuote(value)}`)
    .join(", ")} }`;
  const headersGo = `map[string]string{ ${effective.headers
    .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
    .join(", ")} }`;
  const headersCurl = effective.headers
    .map(([key, value]) => `-H ${shellQuote(`${key}: ${value}`)}`)
    .join(" \\\n  ");

  // URL 插值表达式基于原始 URL（保留 {{baseUrl}} 标记），并拼上未展开的
  // query 行——与 effective.url 的「已展开」语义互补，供运行时注入变量。
  let rawUrl = request.url || "";
  const rawQuery = request.query
    .filter((item) => item.enabled && item.key.trim() !== "")
    .map((item) => [item.key.trim(), item.value] as const);
  if (rawQuery.length) {
    // 编码时保护 {{变量}} 标记：先换成哨兵，编码后还原，避免 { } 被转义成 %7B。
    const encodeKeepingVars = (text: string) => {
      const vars: string[] = [];
      const marked = text.replace(/\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/g, (m) => {
        vars.push(m);
        return `\u0000${vars.length - 1}\u0000`;
      });
      return encodeURIComponent(marked).replace(/%00(\d+)%00/g, (_m, i: string) => vars[Number(i)]);
    };
    rawUrl += (rawUrl.includes("?") ? "&" : "?") + rawQuery
      .map(([key, value]) => `${encodeKeepingVars(key)}=${encodeKeepingVars(value)}`)
      .join("&");
  }
  const urlExprInfo = buildUrlExpression(rawUrl);
  const types = buildTypes(request, nameVariants(request.name || "").namePascal);

  return {
    method: effective.method,
    methodLower: effective.method.toLowerCase(),
    url: effective.url,
    urlJson: JSON.stringify(effective.url),
    urlExpr: urlExprInfo.expr,
    urlTemplate: urlExprInfo.template,
    urlVariables: urlExprInfo.variables,
    name: request.name || "未命名请求",
    ...nameVariants(request.name || ""),
    headers,
    headersJson,
    headersJs,
    headersPy,
    headersGo,
    headersCurl,
    body,
    bodyJson: JSON.stringify(body),
    bodyLiteral,
    bodyPretty: parsed === undefined ? body : JSON.stringify(parsed, null, 2),
    hasBody: effective.body !== null,
    bodyNote: effective.bodyNote ?? "",
    hasBodyNote: !!effective.bodyNote,
    requestType: types.requestType,
    responseType: types.responseType,
    requestTypeName: types.requestTypeName,
    responseTypeName: types.responseTypeName,
    hasTypes: types.hasTypes,
  };
}

export interface CodeTemplateTokenHint {
  token: string;
  description: string;
  /** 点击「插入」时实际写入模板的内容；缺省时写入 token 本身。 */
  insert?: string;
}

/** 变量速查表，模板管理界面点击即可插入。 */
export const CODE_TEMPLATE_TOKENS: CodeTemplateTokenHint[] = [
  { token: "{{method}}", description: "大写方法，如 POST" },
  { token: "{{methodLower}}", description: "小写方法，如 post" },
  { token: "{{url}}", description: "变量已展开、含 query 的最终 URL" },
  { token: "{{urlJson}}", description: "带引号的 URL 字符串字面量（双引号）" },
  {
    token: "{{urlExpr}}",
    description: "运行时变量版 URL：{{baseUrl}} 转 ${baseUrl}，输出带反引号的 TS 模板字面量",
  },
  { token: "{{urlTemplate}}", description: "同 urlExpr 但不含反引号，自行包裹 ${...} 用" },
  { token: "{{#each urlVariables}}…{{/each}}", insert: "{{#each urlVariables}}", description: "URL 中残留的变量名（如 baseUrl）" },
  { token: "{{name}}", description: "请求名称" },
  { token: "{{nameCamel}}", description: "小驼峰函数名" },
  { token: "{{namePascal}}", description: "大驼峰函数名" },
  { token: "{{nameSnake}}", description: "下划线函数名" },
  { token: "{{headersJson}}", description: "美化 JSON 对象（也是合法 JS 字面量）" },
  { token: "{{headersJs}}", description: "单引号风格的 JS 对象" },
  { token: "{{headersPy}}", description: "Python dict 字面量" },
  { token: "{{headersGo}}", description: "Go map[string]string" },
  { token: "{{headersCurl}}", description: "多行 -H 'k: v' 片段" },
  { token: "{{body}}", description: "原始请求体文本" },
  { token: "{{bodyJson}}", description: "带引号的请求体字符串字面量" },
  { token: "{{bodyLiteral}}", description: "JSON 解析成对象字面量，失败则退化为字符串" },
  { token: "{{bodyPretty}}", description: "美化后的请求体文本" },
  { token: "{{bodyNote}}", description: "无法生成代码时的说明（如 multipart 文件）" },
  {
    token: "{{requestType}}",
    description: "由请求体示例推导的 TS 请求类型声明（export type …）",
  },
  {
    token: "{{responseType}}",
    description: "由首个响应示例推导的 TS 响应类型声明（export type …）",
  },
  { token: "{{requestTypeName}}", description: "请求类型名，如 EditSpecRequest" },
  { token: "{{responseTypeName}}", description: "响应类型名，如 EditSpecResponse" },
  {
    token: "{{#each headers}}…{{/each}}",
    insert: "{{#each headers}}\n  {{key}}: {{value}},\n{{/each}}",
    description: "遍历请求头，内部可用 key / value / index / first / last",
  },
  {
    token: "{{#if hasBody}}…{{/if}}",
    insert: "{{#if hasBody}}\n  body: {{{bodyJson}}},\n{{/if}}",
    description: "有请求体时才输出；也可判断 hasBodyNote / headers",
  },
];

// ---------------------------------------------------------- 模板引擎 ----

type TemplateNode =
  | { type: "text"; value: string }
  | { type: "var"; name: string }
  | { type: "block"; kind: "each" | "if"; name: string; children: TemplateNode[] };

interface TemplateToken {
  text?: string;
  tag?: string;
}

/**
 * 分别匹配三花括号与双花括号，避免 `{{token}}}` 这类写法里
 * 可选的第三个 `}` 被贪婪地吞掉（会破坏生成代码的花括号配对）。
 */
const TAG = /\{\{\{\s*([^{}]*?)\s*\}\}\}|\{\{\s*([^{}]*?)\s*\}\}/g;

function tokenize(source: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  let last = 0;
  for (const match of source.matchAll(TAG)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ text: source.slice(last, index) });
    tokens.push({ tag: (match[1] ?? match[2] ?? "").trim() });
    last = index + match[0].length;
  }
  if (last < source.length) tokens.push({ text: source.slice(last) });
  return tokens;
}

function parseNodes(
  tokens: TemplateToken[],
  start: number,
  stop?: string,
): { nodes: TemplateNode[]; next: number } {
  const nodes: TemplateNode[] = [];
  let cursor = start;
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token.text !== undefined) {
      nodes.push({ type: "text", value: token.text });
      cursor += 1;
      continue;
    }
    const tag = token.tag ?? "";
    if (tag.startsWith("/")) {
      // 未匹配的闭合标签直接丢弃，避免把控制语法泄漏进生成的代码。
      if (stop && tag.slice(1).trim() === stop) return { nodes, next: cursor + 1 };
      cursor += 1;
      continue;
    }
    if (tag.startsWith("#")) {
      const [head, ...rest] = tag.slice(1).trim().split(/\s+/);
      const name = rest.join(" ");
      if ((head === "each" || head === "if") && name) {
        const inner = parseNodes(tokens, cursor + 1, head);
        nodes.push({ type: "block", kind: head, name, children: inner.nodes });
        cursor = inner.next;
        continue;
      }
      nodes.push({ type: "text", value: `{{${tag}}}` });
      cursor += 1;
      continue;
    }
    nodes.push({ type: "var", name: tag });
    cursor += 1;
  }
  return { nodes, next: cursor };
}

function lookup(name: string, scope: Record<string, unknown>): unknown {
  let current: unknown = scope;
  for (const part of name.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function truthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return true;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/** 渲染自定义模板。未知变量渲染为空并收集到 unknownTokens。 */
export function renderCodeTemplate(source: string, context: CodeTemplateContext): RenderResult {
  const nodes = parseNodes(tokenize(source), 0).nodes;
  const unknown = new Set<string>();

  const render = (list: TemplateNode[], scope: Record<string, unknown>): string =>
    list
      .map((node): string => {
        if (node.type === "text") return node.value;
        if (node.type === "var") {
          const value = lookup(node.name, scope);
          if (value === undefined) {
            unknown.add(node.name);
            return "";
          }
          return stringify(value);
        }
        const value = lookup(node.name, scope);
        if (node.kind === "if") {
          return truthy(value) ? render(node.children, scope) : "";
        }
        if (!Array.isArray(value)) return "";
        return value
          .map((item, index) =>
            render(node.children, {
              ...scope,
              ...(item !== null && typeof item === "object"
                ? (item as Record<string, unknown>)
                : { item }),
              index,
              first: index === 0,
              last: index === value.length - 1,
            }),
          )
          .join("");
      })
      .join("");

  return {
    code: render(nodes, context as unknown as Record<string, unknown>),
    unknownTokens: [...unknown],
  };
}

/** 首次启动写入工作区的示例模板，可自由编辑或删除。 */
export function builtinCodeTemplates(): CodeTemplate[] {
  return [
    {
      id: uid(),
      name: "TypeScript · 项目 http 封装",
      language: "TypeScript",
      description: "把 import 路径换成团队自己的客户端即可复用拦截器、鉴权与错误处理",
      content: `import { http } from "@/utils/http";

/** {{name}} */
export function {{nameCamel}}() {
  return http.request({
    method: "{{methodLower}}",
    url: "{{url}}",
    headers: {{{headersJson}}},{{#if hasBody}}
    data: {{{bodyLiteral}}},{{/if}}
  });
}
`,
    },
    {
      id: uid(),
      name: "Python · 项目 api_client 封装",
      language: "Python",
      description: "复用团队封装的 api_client，自动生成 headers 与 json 请求体",
      content: `from client import api_client


def {{nameSnake}}():
    """{{name}}"""
    return api_client.request(
        method="{{methodLower}}",
        url="{{url}}",
        headers={{{headersPy}}},{{#if hasBody}}
        json={{{bodyLiteral}}},{{/if}}
    )
`,
    },
  ];
}
