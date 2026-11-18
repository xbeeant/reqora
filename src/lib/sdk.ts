// Collection-level SDK code generation (P2-12).
//
// Turns the whole workspace (collections × folders × requests, plus bound
// data models) into a ready-to-use client file: TypeScript (fetch) or Python
// (requests). Pure data-in/data-out so it is unit-testable like the other
// export modules.
//
// What gets derived:
//   - path params: `{id}` / `{{id}}` templates in the URL become arguments
//   - query params: enabled query rows become optional arguments
//   - body: bound data model → typed interface (TS) / sample JSON (Python);
//     otherwise the type is inferred from the literal JSON body
//   - auth: bearer / apiKey(header) flows become a `token` argument

import { resolveRequestAuth } from "./auth.ts";
import type { DataModel, RequestDraft, WorkspaceSnapshot } from "../types";
import {
  generateFromSchema,
  parseSchemaText,
  schemaFromExample,
  type JsonSchemaValue,
} from "./jsonschema.ts";

export interface SdkFile {
  fileName: string;
  content: string;
}

interface SdkParam {
  /** Generated argument name. */
  name: string;
  /** Original template / query key in the definition. */
  source: string;
  description: string;
}

interface SdkEntry {
  collection: string;
  folder: string;
  fnName: string;
  summary: string;
  method: string;
  /** URL with templates intact ({{baseUrl}} / {id} / {{id}} / {{envVar}}). */
  url: string;
  pathParams: SdkParam[];
  queryParams: SdkParam[];
  /** Static headers (key, value); may contain {{var}} templates. */
  headers: [string, string][];
  /** "bearer" | "apiKey:<header key>" | null — becomes a `token` argument. */
  auth: string | null;
  /** TS type text of the JSON body; null when the request has no body. */
  bodyType: string | null;
  /** Interface name when the body is a bound data model. */
  bodyTypeName: string | null;
  /** True when the body is sent as raw text (not JSON.stringify'd). */
  bodyRaw: boolean;
  /** Sample JSON (model-derived) shown in the Python docstring. */
  bodySample: string | null;
  /** Non-JSON bodies (multipart/binary) get a note instead of a body arg. */
  bodyNote: string | null;
}

// ------------------------------------------------------------ naming ----

export function pascalName(input: string): string {
  const parts = input.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "Model";
  const text = parts.map((part) => part[0].toUpperCase() + part.slice(1)).join("");
  return /^[0-9]/.test(text) ? `M${text}` : text;
}

export function camelName(input: string): string {
  const pascal = pascalName(input);
  return pascal[0].toLowerCase() + pascal.slice(1);
}

function snakeName(input: string): string {
  const parts = input.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "model";
  const text = parts.map((part) => part.toLowerCase()).join("_");
  return /^[0-9]/.test(text) ? `m${text}` : text;
}

function unique(base: string, used: Set<string>): string {
  let name = base || "request";
  let counter = 2;
  while (used.has(name)) {
    name = `${base}${counter}`;
    counter += 1;
  }
  used.add(name);
  return name;
}

// --------------------------------------------------- schema → TS type ----

const MAX_TYPE_DEPTH = 6;

/** JSON schema (subset) → TS type text. `modelTypes` resolves $ref targets. */
export function tsTypeFromSchema(
  schema: JsonSchemaValue,
  modelTypes: Map<string, string>,
  depth = 0,
): string {
  if (depth > MAX_TYPE_DEPTH) return "unknown";
  const ref = typeof schema.$ref === "string" ? schema.$ref : null;
  if (ref) {
    const modelName = ref.startsWith("model://") ? ref.slice("model://".length) : ref.split("/").pop() ?? "";
    return modelTypes.get(modelName) ?? pascalName(modelName);
  }
  const type = schema.type;
  const typeList = Array.isArray(type) ? type : [typeof type === "string" ? type : "any"];
  const nullable = schema.nullable === true || typeList.includes("null");
  const primary = typeList.find((item) => item !== "null") ?? "any";
  let text: string;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    text = schema.enum
      .map((value) => (typeof value === "string" ? JSON.stringify(value) : String(value)))
      .join(" | ");
  } else if (primary === "string") {
    text = "string";
  } else if (primary === "integer" || primary === "number") {
    text = "number";
  } else if (primary === "boolean") {
    text = "boolean";
  } else if (primary === "array") {
    const items = (schema.items ?? {}) as JsonSchemaValue;
    text = `Array<${tsTypeFromSchema(items, modelTypes, depth + 1)}>`;
  } else if (primary === "object") {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchemaValue>;
    const required = Array.isArray(schema.required) ? schema.required : [];
    const keys = Object.keys(properties);
    if (keys.length === 0) return "Record<string, unknown>";
    const lines = keys.map((key) => {
      const optional = required.includes(key) ? "" : "?";
      const description =
        typeof properties[key].description === "string"
          ? ` /** ${properties[key].description} */`
          : "";
      return `    ${JSON.stringify(key)}${optional}:${description} ${tsTypeFromSchema(
        properties[key],
        modelTypes,
        depth + 1,
      )};`;
    });
    text = `{\n${lines.join("\n")}\n  }`;
  } else {
    text = "unknown";
  }
  return nullable ? `${text} | null` : text;
}

// ------------------------------------------------------- entry collection ----

function collectModels(snapshot: WorkspaceSnapshot): DataModel[] {
  return snapshot.dataModels ?? [];
}

function modelRefResolver(models: DataModel[]) {
  const cache = new Map<string, JsonSchemaValue | null>();
  return (ref: string): JsonSchemaValue | null => {
    if (!ref.startsWith("model://")) return null;
    const name = ref.slice("model://".length);
    if (cache.has(name)) return cache.get(name) ?? null;
    const model = models.find((item) => item.name === name);
    const parsed = model ? parseSchemaText(model.schemaText) : null;
    cache.set(name, parsed?.schema ?? null);
    return parsed?.schema ?? null;
  };
}

/** Extract `{param}` / `{{param}}` templates from a URL (excluding baseUrl). */
function extractPathParams(url: string): string[] {
  const names = new Set<string>();
  for (const match of url.matchAll(/\{\{?([A-Za-z_][A-Za-z0-9_]*)\}?\}/g)) {
    if (match[1].toLowerCase() !== "baseurl") names.add(match[1]);
  }
  return [...names];
}

function authKind(request: RequestDraft): string | null {
  const auth = request.auth;
  // 新鉴权变体的密钥不进入 SDK 产物：仅保留方案名占位，令牌 / 证书由调用方注入。
  if (auth.type === "oauth2" || auth.type === "awsSigV4" || auth.type === "mtls") return null;
  if (auth.type === "bearer" && auth.token.trim() !== "") return "bearer";
  if (auth.type === "apiKey" && auth.location === "header" && auth.key.trim() !== "") {
    return `apiKey:${auth.key.trim()}`;
  }
  return null;
}

function bodyNote(request: RequestDraft): string | null {
  if (request.body.type === "formData") {
    const files = request.body.items.filter((item) => item.enabled && item.file);
    if (files.length > 0) {
      return `multipart 含文件字段（${files
        .map((item) => item.fileName || item.key)
        .join("、")}），请用 FormData 上传`;
    }
  }
  if (request.body.type === "binary") return "二进制文件体，请用对应语言的文件上传 API";
  return null;
}

function buildEntries(snapshot: WorkspaceSnapshot): SdkEntry[] {
  const models = collectModels(snapshot);
  const resolver = modelRefResolver(models);
  const modelTypes = new Map<string, string>();
  for (const model of models) modelTypes.set(model.name, pascalName(model.name));

  const entries: SdkEntry[] = [];
  const usedNames = new Set<string>();

  for (const collection of snapshot.collections) {
    for (const request of collection.items) {
      if (request.protocol === "ws" || request.protocol === "tcp") continue;
      const fnName = unique(camelName(request.name || request.method.toLowerCase()), usedNames);
      const usedParams = new Set<string>(["options", "query", "token", "body"]);

      const takeParam = (base: string): string => {
        let name = camelName(base) || "param";
        let counter = 2;
        while (usedParams.has(name)) {
          name = `${camelName(base)}${counter}`;
          counter += 1;
        }
        usedParams.add(name);
        return name;
      };

      const pathParams: SdkParam[] = extractPathParams(request.url).map((source) => ({
        name: takeParam(source),
        source,
        description: `URL 路径参数 ${source}`,
      }));
      const queryParams: SdkParam[] = request.query
        .filter((item) => item.enabled && item.key.trim() !== "")
        .map((item) => ({
          name: takeParam(item.key.trim()),
          source: item.key.trim(),
          description: `query 参数 ${item.key.trim()}`,
        }));

      // A bound data model defines the request body even when the literal body
      // is empty (new requests default to `body: none`). It takes precedence
      // over inferring a type from a literal JSON body.
      const boundModel = request.doc?.requestModelId
        ? models.find((model) => model.id === request.doc?.requestModelId)
        : undefined;
      let bodyType: string | null = null;
      let bodyTypeName: string | null = null;
      let bodyRaw = false;
      let bodySample: string | null = null;
      const note = boundModel ? null : bodyNote(request);

      if (boundModel) {
        const parsed = parseSchemaText(boundModel.schemaText);
        if (parsed.schema) {
          bodyType = tsTypeFromSchema(parsed.schema, modelTypes);
          bodyTypeName = pascalName(boundModel.name);
          bodySample = JSON.stringify(
            generateFromSchema(parsed.schema, resolver),
            null,
            2,
          );
        }
      }

      if (bodyType === null && !note) {
        if (request.body.type === "json" && request.body.content.trim() !== "") {
          try {
            const example: unknown = JSON.parse(request.body.content);
            bodyType = tsTypeFromSchema(schemaFromExample(example), modelTypes);
            bodySample = JSON.stringify(example, null, 2);
          } catch {
            bodyType = "unknown";
            bodySample = null;
          }
        } else if (request.body.type === "raw" && request.body.content.trim() !== "") {
          bodyType = "string";
          bodyRaw = true;
          bodySample = request.body.content;
        }
      }

      entries.push({
        collection: collection.name,
        folder: request.folder?.trim() ?? "",
        fnName,
        summary: request.doc?.summary || request.description || request.name,
        method: request.method.toUpperCase(),
        url: request.url.trim(),
        pathParams,
        queryParams,
        headers: request.headers
          .filter((item) => item.enabled && item.key.trim() !== "")
          .map((item) => [item.key.trim(), item.value] as [string, string]),
        auth: authKind(resolveRequestAuth(request, snapshot.collections)),
        bodyType,
        bodyTypeName,
        bodyRaw,
        bodySample,
        bodyNote: note,
      });
    }
  }
  return entries;
}

/** Base URL preference: `baseUrl` variable of the active environment, else a placeholder. */
function resolveBaseUrl(snapshot: WorkspaceSnapshot): string {
  const environment = snapshot.environments.find(
    (item) => item.id === snapshot.activeEnvironmentId,
  );
  const variable = environment?.variables.find(
    (item) => item.enabled && item.key.trim().toLowerCase() === "baseurl",
  );
  return variable?.value.trim() || "https://your-api-host";
}

// ------------------------------------------------------------ TypeScript ----

export function generateTsSdk(snapshot: WorkspaceSnapshot): SdkFile {
  const entries = buildEntries(snapshot);
  const baseUrl = resolveBaseUrl(snapshot);
  const models = collectModels(snapshot);
  const modelTypes = new Map<string, string>();
  for (const model of models) modelTypes.set(model.name, pascalName(model.name));

  const lines: string[] = [
    `/**`,
    ` * ${snapshot.collections.map((item) => item.name).join("、") || "API"} 客户端 —— 由 Reqora 自动生成（TypeScript / fetch）。`,
    " * 重新生成会覆盖本文件；请勿手工改动生成的函数体。",
    " */",
    "",
    `export const BASE_URL = ${JSON.stringify(baseUrl)};`,
    "",
  ];

  // Named body interfaces from bound data models actually referenced.
  const emittedInterfaces = new Set<string>();
  for (const model of models) {
    const interfaceName = pascalName(model.name);
    if (emittedInterfaces.has(interfaceName)) continue;
    if (!entries.some((entry) => entry.bodyTypeName === interfaceName)) continue;
    const parsed = parseSchemaText(model.schemaText);
    if (!parsed.schema) continue;
    emittedInterfaces.add(interfaceName);
    const typeText = tsTypeFromSchema(parsed.schema, modelTypes);
    if (typeText.startsWith("{")) {
      lines.push(
        `/** 数据模型：${model.description || model.name} */`,
        `export interface ${interfaceName} ${typeText}`,
        "",
      );
    } else {
      lines.push(
        `/** 数据模型：${model.description || model.name} */`,
        `export type ${interfaceName} = ${typeText};`,
        "",
      );
    }
  }

  lines.push(
    "export interface SdkOptions {",
    "    /** 覆盖 BASE_URL。 */",
    "    baseUrl?: string;",
    "    /** 额外请求头。 */",
    "    headers?: Record<string, string>;",
    "    /** 注入自定义 fetch（测试 / 代理）。 */",
    "    fetchImpl?: typeof fetch;",
    "}",
    "",
    "async function call(",
    "    method: string,",
    "    url: string,",
    "    query: Record<string, string>,",
    "    headers: Record<string, string>,",
    "    body: string | undefined,",
    "    fetchImpl: typeof fetch,",
    "): Promise<unknown> {",
    "    const search = new URLSearchParams(query);",
    "    const searchPart = [...search.keys()].length > 0 ? `?${search.toString()}` : \"\";",
    "    const response = await fetchImpl(`${url}${searchPart}`, { method, headers, body });",
    "    const text = await response.text();",
    "    if (!response.ok) {",
    "        throw new Error(`${response.status} ${response.statusText}: ${text}`);",
    "    }",
    "    try {",
    "        return JSON.parse(text) as unknown;",
    "    } catch {",
    "        return text;",
    "    }",
    "}",
    "",
  );

  let currentGroup = "";
  for (const entry of entries) {
    const group = entry.folder ? `${entry.collection} / ${entry.folder}` : entry.collection;
    if (group !== currentGroup) {
      currentGroup = group;
      lines.push(`// ---- ${group} ----`, "");
    }

    // Function signature.
    const params: string[] = entry.pathParams.map((param) => `    ${param.name}: string,`);
    if (entry.auth) params.push("    token: string,");
    if (entry.bodyType !== null && !entry.bodyNote) {
      params.push(`    body: ${entry.bodyTypeName ?? entry.bodyType},`);
    }
    if (entry.queryParams.length > 0) {
      const fields = entry.queryParams.map((param) => `${param.name}?: string`).join("; ");
      params.push(`    query: { ${fields} } = {},`);
    }
    params.push("    options: SdkOptions = {},");

    const docLines = [`/** ${entry.summary} — ${entry.method} ${entry.url}`];
    if (entry.bodySample) docLines.push(` *  请求体示例：${entry.bodySample.replace(/\s+/g, " ").slice(0, 120)}`);
    if (entry.bodyNote) docLines.push(` *  ${entry.bodyNote}`);
    docLines.push(" */");

    // URL template: {{baseUrl}} → ${baseUrl}; {id}/{{id}} → ${paramName}.
    let urlText = entry.url.replace(/\{\{baseUrl\}\}/gi, "\u0000BASE\u0000");
    urlText = urlText.replace(/\{\{?([A-Za-z_][A-Za-z0-9_]*)\}?\}/g, (_match, name: string) => {
      const param = entry.pathParams.find((item) => item.source === name);
      return `\${${param?.name ?? camelName(name)}}`;
    });
    urlText = urlText.replace("\u0000BASE\u0000", "${options.baseUrl ?? BASE_URL}");
    const absolute = /^https?:\/\//i.test(urlText) && !urlText.startsWith("${options.baseUrl");
    if (!absolute && !urlText.startsWith("${options.baseUrl")) {
      urlText = `\${options.baseUrl ?? BASE_URL}${urlText.startsWith("/") ? "" : "/"}${urlText}`;
    }

    // Query mapping: source key → argument (single line keeps the call tidy).
    const queryObject =
      entry.queryParams.length > 0
        ? `{ ${entry.queryParams
            .map((param) => `${JSON.stringify(param.source)}: ${param.name}`)
            .join(", ")} }`
        : "{}";

    const headerEntries: string[] = [];
    for (const [key, value] of entry.headers) {
      headerEntries.push(`        ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
    }
    if (entry.auth === "bearer") headerEntries.push('        Authorization: `Bearer ${token}`,');
    else if (entry.auth?.startsWith("apiKey:")) {
      const key = entry.auth.slice("apiKey:".length);
      headerEntries.push(`        ${JSON.stringify(key)}: token,`);
    }
    if (entry.bodyType !== null && !entry.bodyNote && !entry.bodyRaw) {
      headerEntries.push('        "Content-Type": "application/json",');
    }

    const bodyArg = entry.bodyNote
      ? "undefined"
      : entry.bodyType === null
        ? "undefined"
        : entry.bodyRaw
          ? "body"
          : "JSON.stringify(body)";

    lines.push(
      ...docLines,
      `export async function ${entry.fnName}(`,
      params.join("\n"),
      "): Promise<unknown> {",
      "    return call(",
      `        ${JSON.stringify(entry.method)},`,
      `        \`${urlText}\`,`,
      `        ${queryObject},`,
      `        {\n${headerEntries.join("\n")}\n        },`,
      `        ${bodyArg},`,
      "        options.fetchImpl ?? fetch,",
      "    );",
      "}",
      "",
    );
  }

  return { fileName: "api-client.ts", content: `${lines.join("\n")}\n` };
}

// -------------------------------------------------------------- Python ----

export function generatePythonSdk(snapshot: WorkspaceSnapshot): SdkFile {
  const entries = buildEntries(snapshot);
  const baseUrl = resolveBaseUrl(snapshot);

  const lines: string[] = [
    `"""${snapshot.collections.map((item) => item.name).join("、") || "API"} 客户端 —— 由 Reqora 自动生成（Python / requests）。`,
    "",
    "BASE_URL 取自活动环境的 baseUrl 变量，可按需修改；也可通过 base_url 参数覆盖。",
    '"""',
    "",
    "from __future__ import annotations",
    "",
    "from typing import Any, Dict, Optional",
    "",
    "import requests",
    "",
    `BASE_URL = ${JSON.stringify(baseUrl)}`,
    "",
    "",
    "def _request(",
    "    method: str,",
    "    url: str,",
    "    headers: Optional[Dict[str, str]] = None,",
    "    body: Any = None,",
    "    query: Optional[Dict[str, str]] = None,",
    ") -> Any:",
    '    """发送一次请求；非 2xx 抛 RuntimeError，返回 JSON 或文本。"""',
    "    response = requests.request(method, url, headers=headers, json=body, params=query, timeout=30)",
    "    if not response.ok:",
    '        raise RuntimeError(f"{response.status_code} {response.reason}: {response.text}")',
    "    try:",
    "        return response.json()",
    "    except ValueError:",
    "        return response.text",
    "",
    "",
  ];

  let currentGroup = "";
  for (const entry of entries) {
    const pyName = entry.fnName.replace(/([A-Z0-9])/g, "_$1").toLowerCase();
    const group = entry.folder ? `${entry.collection} / ${entry.folder}` : entry.collection;
    if (group !== currentGroup) {
      currentGroup = group;
      lines.push(`# ---- ${group} ----`, "");
    }

    const args: string[] = entry.pathParams.map((param) => `${param.name}: str`);
    if (entry.auth) args.push("token: str");
    if (entry.bodyType !== null && !entry.bodyNote) args.push("body: Any");
    if (entry.queryParams.length > 0) args.push("query: Optional[Dict[str, str]] = None");
    args.push("base_url: str = BASE_URL");

    // Docstring with summary, params and an optional body sample.
    const docLines = [`    """${entry.summary} — ${entry.method} ${entry.url}`];
    for (const param of [...entry.pathParams, ...entry.queryParams]) {
      docLines.push(`    ${param.name}: ${param.description}`);
    }
    if (entry.bodySample) {
      docLines.push("    请求体示例：");
      for (const sampleLine of entry.bodySample.split("\n")) {
        docLines.push(`      ${sampleLine}`);
      }
    }
    if (entry.bodyNote) docLines.push(`    ${entry.bodyNote}`);
    docLines.push('    """');

    // URL f-string: {{baseUrl}} → {base_url}; {id}/{{id}} → {param}.
    const urlText = entry.url
      .replace(/\{\{baseUrl\}\}/gi, "{base_url}")
      .replace(/\{\{?([A-Za-z_][A-Za-z0-9_]*)\}?\}/g, (_match, name: string) => {
        const param = entry.pathParams.find((item) => item.source === name);
        return `{${param?.name ?? snakeName(name)}}`;
      });
    const fUrl =
      /^https?:\/\//i.test(entry.url) || urlText.includes("{base_url}")
        ? `f"${urlText}"`
        : `f"{base_url}${urlText.startsWith("/") ? "" : "/"}${urlText}"`;

    const headerEntries: string[] = [];
    for (const [key, value] of entry.headers) {
      headerEntries.push(`            ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
    }
    if (entry.auth === "bearer") headerEntries.push('            "Authorization": f"Bearer {token}",');
    else if (entry.auth?.startsWith("apiKey:")) {
      const key = entry.auth.slice("apiKey:".length);
      headerEntries.push(`            ${JSON.stringify(key)}: token,`);
    }
    const headersArg =
      headerEntries.length > 0
        ? `{\n${headerEntries.join("\n")}\n        }`
        : "None";

    const requestArgs = [
      `        ${JSON.stringify(entry.method)},`,
      `        ${fUrl},`,
      `        headers=${headersArg},`,
      entry.bodyType !== null && !entry.bodyNote
        ? "        body=body,"
        : "        body=None,",
      entry.queryParams.length > 0 ? "        query=query," : "        query=None,",
    ];

    lines.push(
      `def ${pyName}(`,
      ...args.map((arg) => `    ${arg},`),
      ") -> Any:",
      ...docLines,
      "    return _request(",
      ...requestArgs,
      "    )",
      "",
    );
  }

  return { fileName: "api_client.py", content: `${lines.join("\n")}\n` };
}
