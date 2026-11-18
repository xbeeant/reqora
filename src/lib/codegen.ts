import type { RequestDraft } from "../types";
import { substitute } from "./template.ts";

/** 支持的代码生成目标语言。 */
export type CodeLanguage = "curl" | "fetch" | "python" | "go";

export const CODE_LANGUAGES: { id: CodeLanguage; label: string }[] = [
  { id: "curl", label: "cURL" },
  { id: "fetch", label: "JavaScript fetch" },
  { id: "python", label: "Python requests" },
  { id: "go", label: "Go net/http" },
];

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** JSON.stringify 的输出既是合法 JS 字面量，也几乎总是合法 Python 字面量。 */
function pyQuote(value: string): string {
  return JSON.stringify(value);
}

/** Go raw string（body 用）：内容里出现反引号时拆串转义。 */
function goRaw(value: string): string {
  return `\`${value.replace(/`/g, "` + \"`\" + `")}\``;
}

/** Go 普通字符串（JSON.stringify 的双引号形式就是合法 Go 字面量）。 */
const goQuote = JSON.stringify;

function jsQuote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
}

export interface EffectiveRequest {
  method: string;
  url: string;
  headers: [string, string][];
  /** 已序列化好的请求体文本；null 表示无请求体。 */
  body: string | null;
  /** 请求体说明（用于不支持形态的注释）。 */
  bodyNote: string | null;
}

/** 把 draft 归一成「方法 + URL + 头列表 + 体文本」，query 行拼回 URL。 */
export function effectiveRequest(
  request: RequestDraft,
  variables: Record<string, string>,
  resolvedUrl?: string,
): EffectiveRequest {
  const sub = (value: string) => substitute(value, variables);
  const method = request.method.toUpperCase();

  // URL：环境变量替换后拼上启用的 query 行（与 Rust 发送行为一致）。
  let url = resolvedUrl || sub(request.url);
  const queryPairs = request.query
    .filter((item) => item.enabled && item.key.trim() !== "")
    .map((item) => [sub(item.key), sub(item.value)] as [string, string]);
  const search = new URLSearchParams();
  for (const [key, value] of queryPairs) search.append(key, value);
  const encoded = search.toString();
  if (encoded !== "") {
    url += (url.includes("?") ? "&" : "?") + encoded;
  }

  const headers: [string, string][] = [];
  const seen = new Set<string>();
  const pushHeader = (key: string, value: string) => {
    const lower = key.toLowerCase();
    // 用户显式头优先：已存在的同名头不再叠加默认值。
    if (seen.has(lower)) return;
    seen.add(lower);
    headers.push([key, value]);
  };
  for (const header of request.headers) {
    if (!header.enabled || header.key.trim() === "") continue;
    if (!seen.has(header.key.toLowerCase())) {
      seen.add(header.key.toLowerCase());
      headers.push([header.key, sub(header.value)]);
    }
  }

  if (request.auth.type === "bearer") {
    pushHeader("Authorization", `Bearer ${sub(request.auth.token)}`);
  } else if (request.auth.type === "basic") {
    const raw = `${sub(request.auth.username)}:${sub(request.auth.password)}`;
    // btoa 只收 Latin-1：先经 TextEncoder 走一遍 UTF-8 → 二进制串。
    const bytes = new TextEncoder().encode(raw);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encodedAuth = btoa(binary);
    pushHeader("Authorization", `Basic ${encodedAuth}`);
  } else if (request.auth.type === "apiKey" && request.auth.location === "header") {
    pushHeader(request.auth.key, sub(request.auth.value));
  } else if (request.auth.type === "apiKey" && request.auth.location === "query") {
    if (request.auth.key.trim() !== "") {
      url += (url.includes("?") ? "&" : "?") + `${encodeURIComponent(request.auth.key)}=${encodeURIComponent(sub(request.auth.value))}`;
    }
  }

  let body: string | null = null;
  let bodyNote: string | null = null;
  const bodySpec = request.body;
  if (bodySpec.type === "json") {
    pushHeader("Content-Type", "application/json");
    body = sub(bodySpec.content);
  } else if (bodySpec.type === "raw") {
    pushHeader("Content-Type", bodySpec.contentType || "text/plain");
    body = sub(bodySpec.content);
  } else if (bodySpec.type === "formUrlEncoded") {
    pushHeader("Content-Type", "application/x-www-form-urlencoded");
    body = bodySpec.items
      .filter((item) => item.enabled && item.key.trim() !== "")
      .map((item) => `${encodeURIComponent(item.key)}=${encodeURIComponent(sub(item.value))}`)
      .join("&");
  } else if (bodySpec.type === "formData") {
    pushHeader("Content-Type", "multipart/form-data");
    const fields = bodySpec.items
      .filter((item) => item.enabled && item.key.trim() !== "" && !item.file)
      .map((item) => `${item.key}=${sub(item.value)}`);
    const files = bodySpec.items.filter((item) => item.enabled && item.file);
    body = fields.join("&") || null;
    if (files.length > 0) {
      bodyNote = `multipart 含文件字段（${files.map((f) => f.fileName || f.key).join("、")}），请用各语言的 multipart/form-data API 补充`;
    }
  } else if (bodySpec.type === "graphql") {
    pushHeader("Content-Type", "application/json");
    let graphqlVars: unknown = {};
    try {
      graphqlVars = bodySpec.variables.trim() === "" ? {} : JSON.parse(sub(bodySpec.variables));
    } catch {
      graphqlVars = {};
    }
    body = JSON.stringify({ query: sub(bodySpec.query), variables: graphqlVars });
  } else if (bodySpec.type === "binary") {
    bodyNote = `二进制文件体（${bodySpec.fileName || "未命名"}，${bodySpec.contentType || "application/octet-stream"}），请用各语言的文件上传 API 补充`;
  }

  const authNote = authFallbackNote(request.auth);
  if (authNote) bodyNote = [bodyNote, authNote].filter(Boolean).join("；");

  return { method, url, headers, body, bodyNote };
}

/**
 * 扩展鉴权变体的安全回退：代码生成产物绝不写入任何密钥，
 * 只输出占位符注释提示使用者自行注入令牌 / 证书。
 */
function authFallbackNote(auth: RequestDraft["auth"]): string {
  switch (auth.type) {
    case "oauth2":
      return "OAuth 2.0：请在 Authorization 头使用 ${REQORA_TOKEN} 变量，密钥已省略";
    case "awsSigV4":
      return `AWS SigV4：--aws-sigv4 "aws:amz:${auth.region}:${auth.service}"，密钥已省略`;
    case "mtls":
      return "mTLS：--cert <client.pem> --key <client.key>，证书与私钥已省略";
    default:
      return "";
  }
}

function comment(language: CodeLanguage, text: string): string {
  if (language === "python") return `# ${text}`;
  if (language === "go") return `// ${text}`;
  return `// ${text}`;
}

/** 生成目标语言的请求代码。`resolvedUrl` 优先（发送后的最终 URL，含重定向）。 */
export function generateCode(
  request: RequestDraft,
  language: CodeLanguage,
  variables: Record<string, string> = {},
  resolvedUrl?: string,
): string {
  const request_ = effectiveRequest(request, variables, resolvedUrl);

  if (language === "curl") {
    const lines = [`curl -X ${request_.method} ${shellQuote(request_.url)}`];
    for (const [key, value] of request_.headers) {
      lines.push(`  -H ${shellQuote(`${key}: ${value}`)}`);
    }
    if (request_.body !== null) {
      lines.push(`  -d ${shellQuote(request_.body)}`);
    }
    if (request_.bodyNote) lines.push(`  # ${request_.bodyNote}`);
    return lines.join(" \\\n");
  }

  if (language === "fetch") {
    const lines: string[] = ["const response = await fetch(", `  ${jsQuote(request_.url)}`, "  {"];
    lines.push(`    method: ${jsQuote(request_.method)},`);
    if (request_.headers.length > 0) {
      lines.push("    headers: {");
      for (const [key, value] of request_.headers) {
        lines.push(`      ${jsQuote(key)}: ${jsQuote(value)},`);
      }
      lines.push("    },");
    }
    if (request_.body !== null) {
      lines.push(`    body: ${jsQuote(request_.body)},`);
    }
    lines.push("  }", ");", "", "const data = await response.text();", "console.log(data);");
    if (request_.bodyNote) lines.unshift(comment("fetch", request_.bodyNote));
    return lines.join("\n");
  }

  if (language === "python") {
    const lines: string[] = ["import requests", "", `resp = requests.${request_.method.toLowerCase()}(`];
    lines.push(`    ${pyQuote(request_.url)},`);
    if (request_.headers.length > 0) {
      lines.push("    headers={");
      for (const [key, value] of request_.headers) {
        lines.push(`        ${pyQuote(key)}: ${pyQuote(value)},`);
      }
      lines.push("    },");
    }
    if (request_.body !== null) {
      lines.push(`    data=${pyQuote(request_.body)},`);
    }
    lines.push(")", "print(resp.status_code)", "print(resp.text)");
    if (request_.bodyNote) lines.unshift(comment("python", request_.bodyNote));
    return lines.join("\n");
  }

  // Go net/http
  const lines: string[] = [
    "package main",
    "",
    "import (",
    '\t"fmt"',
    '\t"io"',
    '\t"net/http"',
    ...(request_.body !== null ? ['\t"strings"'] : []),
    ")",
    "",
    "func main() {",
  ];
  if (request_.body !== null) {
    lines.push(`\tbody := strings.NewReader(${goRaw(request_.body)})`);
    lines.push(`\treq, err := http.NewRequest(${goQuote(request_.method)}, ${goQuote(request_.url)}, body)`);
  } else {
    lines.push(`\treq, err := http.NewRequest(${goQuote(request_.method)}, ${goQuote(request_.url)}, nil)`);
  }
  lines.push("\tif err != nil {", "\t\tpanic(err)", "\t}");
  for (const [key, value] of request_.headers) {
    lines.push(`\treq.Header.Set(${goQuote(key)}, ${goQuote(value)})`);
  }
  lines.push(
    "\tresp, err := http.DefaultClient.Do(req)",
    "\tif err != nil {",
    "\t\tpanic(err)",
    "\t}",
    "\tdefer resp.Body.Close()",
    "\tdata, _ := io.ReadAll(resp.Body)",
    "\tfmt.Println(resp.Status, string(data))",
    "}",
  );
  if (request_.bodyNote) lines.unshift(comment("go", request_.bodyNote));
  return lines.join("\n");
}
