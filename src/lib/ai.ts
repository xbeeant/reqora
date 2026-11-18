/**
 * AI 请求生成：提示词构建 + 模型输出解析。
 *
 * 设计要点：模型输出天然不可靠，所以解析层必须防御式——
 * 剥掉 Markdown 围栏、截取第一个平衡的 JSON 对象、逐字段校验类型。
 * 解析失败的输出绝不进入工作区，由调用方展示错误信息。
 */

import { emptyRequest } from "./defaults.ts";
import { uid } from "./id.ts";
import type { KeyValue, RequestDraft } from "../types.ts";

export const DRAFT_SYSTEM_PROMPT = [
  "你是 API 调试助手。根据用户的自然语言描述，生成一个 HTTP 请求的定义。",
  "只输出一个 JSON 对象，不要输出任何解释、Markdown 代码围栏或其他文字。",
  "JSON 格式：",
  '{"name": "接口名(中文)", "method": "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS", "url": "完整 URL",',
  ' "headers": [{"key": "Header 名", "value": "值"}],',
  ' "bodyType": "none|json|formUrlEncoded|raw",',
  ' "body": "请求体字符串（bodyType 为 json/formUrlEncoded/raw 时提供；json 用压缩后的合法 JSON 文本）",',
  ' "auth": "如何提供鉴权（如 Bearer token 放 header）或省略"}',
  "规则：",
  "- method 必须是标准 HTTP 方法之一",
  "- URL 必须完整（含协议），占位符用 {{variable}} 形式",
  "- 无法确定的值用合理的占位符，不要编造敏感信息",
].join("\n");

export function buildDraftPrompt(description: string): string {
  return [
    "请为以下 API 生成请求定义 JSON：",
    "",
    description.trim(),
    "",
    "再次强调：只输出 JSON 对象本身。",
  ].join("\n");
}

/** 从模型输出里截取第一个括号平衡的 JSON 对象文本。 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

const HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/**
 * 把模型输出解析成请求草稿；不合法时返回 null（附错误原因）。
 * 宽松策略：字段缺失给默认值，headers 忽略不合法的行。
 */
export function parseRequestDraft(
  output: string,
): { draft: RequestDraft | null; error: string | null } {
  const jsonText = extractJsonObject(output);
  if (!jsonText) {
    return { draft: null, error: "模型输出中没有找到 JSON 对象" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    return { draft: null, error: `JSON 解析失败：${(error as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { draft: null, error: "模型输出不是 JSON 对象" };
  }
  const record = parsed as Record<string, unknown>;

  const method = String(record.method ?? "GET").toUpperCase();
  if (!HTTP_METHODS.has(method)) {
    return { draft: null, error: `不支持的 HTTP 方法：${method}` };
  }
  const url = String(record.url ?? "").trim();
  if (!url) {
    return { draft: null, error: "缺少 url 字段" };
  }

  const headers: KeyValue[] = [];
  if (Array.isArray(record.headers)) {
    for (const entry of record.headers) {
      if (typeof entry !== "object" || entry === null) continue;
      const row = entry as Record<string, unknown>;
      const key = String(row.key ?? "").trim();
      if (!key) continue;
      headers.push({
        id: uid(),
        key,
        value: String(row.value ?? ""),
        enabled: row.enabled !== false,
      });
    }
  }

  const bodyTypeRaw = String(record.bodyType ?? "none").toLowerCase();
  const body = typeof record.body === "string" ? record.body : "";
  let bodySpec: RequestDraft["body"];
  if (bodyTypeRaw === "json") {
    bodySpec = { type: "json", content: body || "{}" };
  } else if (bodyTypeRaw === "formurlencoded") {
    // 模型可能给 "k=v&k2=v2" 或 [{"key","value"}] 两种形态。
    const items: KeyValue[] = [];
    if (Array.isArray(record.bodyItems)) {
      for (const entry of record.bodyItems) {
        if (typeof entry !== "object" || entry === null) continue;
        const row = entry as Record<string, unknown>;
        const key = String(row.key ?? "").trim();
        if (!key) continue;
        items.push({ id: uid(), key, value: String(row.value ?? ""), enabled: true });
      }
    } else if (body) {
      for (const pair of body.split("&")) {
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        items.push({
          id: uid(),
          key: pair.slice(0, eq),
          value: pair.slice(eq + 1),
          enabled: true,
        });
      }
    }
    bodySpec = { type: "formUrlEncoded", items };
  } else if (bodyTypeRaw === "raw" && body) {
    bodySpec = { type: "raw", content: body, contentType: "text/plain" };
  } else {
    bodySpec = { type: "none" };
  }

  const draft: RequestDraft = {
    ...emptyRequest(),
    id: uid(),
    name: String(record.name ?? "").trim() || "AI 生成的接口",
    method: method as RequestDraft["method"],
    url,
    headers,
    body: bodySpec,
    updatedAt: Date.now(),
  };
  return { draft, error: null };
}
