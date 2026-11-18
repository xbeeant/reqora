/**
 * 保存响应示例时的两条纯逻辑（不发请求、不碰 store）：
 *
 * 1. 去重：同一个接口下，状态码 + 解析后的 key / value 完全一致的响应不再重复入档，
 *    避免连点两次「保存」就把文档撑出两条一模一样的示例。
 * 2. 继承：新增示例的字段说明 / 必填沿用同接口其它示例已经写好的定义，
 *    用户只需要为这次响应里真正新增的字段补说明。
 */
import type {
  RequestDoc,
  ResponseData,
  ResponseExample,
  ResponseParam,
  SaveResponseExampleResult,
} from "../types";
import { uid } from "./id.ts";
import { deriveResponseParams, normalizeResponseParams } from "./responseParams.ts";

const MAX_DEPTH = 16;

/**
 * 响应示例正文的可读化：能按 JSON 解析就输出带缩进的版本，否则原样返回。
 *
 * 纯文本、二进制、被截断的半截 JSON 都会解析失败并保留原文，避免把不可解析
 * 的内容改坏。函数幂等，既用于保存时写入示例，也用于展示历史示例中已经存成
 * 一行的 JSON。
 */
export function formatResponseExampleBody(body: string): string {
  const text = body ?? "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** 稳定化 JSON：对象键排序、去掉空白，用来判断「key 和 value 都一样」。 */
function canonical(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) return "null";
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "number") return Number.isFinite(value as number) ? JSON.stringify(value) : "null";
  if (type === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  }
  if (type === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`)
      .join(",")}}`;
  }
  // undefined / function / symbol 在 JSON 里不存在
  return "null";
}

/**
 * 响应「数据指纹」：状态码 + 稳定化的响应体。
 * 可解析的 JSON 按 key 排序后比较（键顺序不同但内容一致视为相同），
 * 非 JSON 则退化成去首尾空白的原文比较。
 */
export function responseBodySignature(status: number, body: string): string {
  const text = (body ?? "").trim();
  if (text === "") return `${status}|`;
  try {
    return `${status}|${canonical(JSON.parse(text))}`;
  } catch {
    return `${status}|${text}`;
  }
}

/** 该响应是否和已有示例的数据完全一样（key 与 value 都相同）。 */
export function isDuplicateResponseExample(
  examples: readonly { status: number; body: string }[],
  status: number,
  body: string,
): boolean {
  const signature = responseBodySignature(status, body);
  return examples.some((item) => responseBodySignature(item.status, item.body) === signature);
}

/**
 * 新示例的字段表：内容（字段名 / 类型 / 示例值）按本次响应重新派生，
 * 说明与必填标记沿用同接口其它示例里最新的非默认值。
 *
 * @param derived  按本次响应体派生的字段（`deriveResponseParams` 的结果）
 * @param previous 同接口已有示例的字段表，按文档顺序（越靠后越新）
 */
export function inheritResponseParams(
  derived: ResponseParam[],
  previous: readonly (readonly ResponseParam[])[],
): ResponseParam[] {
  if (previous.length === 0) return derived;
  const inherited = new Map<string, ResponseParam>();
  // 从新到旧扫一遍，同一路径只认最新的那条定义。
  for (let index = previous.length - 1; index >= 0; index -= 1) {
    for (const row of previous[index]) {
      const key = `${row.location}:${row.name}`;
      if (!inherited.has(key)) inherited.set(key, row);
    }
  }
  if (inherited.size === 0) return derived;
  return derived.map((row) => {
    const previousRow = inherited.get(`${row.location}:${row.name}`);
    if (!previousRow) return row;
    return {
      ...row,
      description: previousRow.description.trim() !== "" ? previousRow.description : row.description,
      required: previousRow.required || row.required,
    };
  });
}

/** `buildResponseExample` 的结果：命中去重时不产出 doc / example。 */
export type BuiltResponseExample =
  | { result: "duplicate"; doc: null; example: null }
  | { result: "added"; doc: RequestDoc; example: ResponseExample };

/**
 * 保存响应示例的共享规则（不发请求、不碰 store）：
 * 数据去重 → 派生字段表并继承说明 / 必填 → 组装成新的 RequestDoc。
 *
 * 两个写回入口（接口文档 / 用例）复用这一份逻辑，只保留各自差异：
 * 写回目标 id、name / description、末尾 draft 同步。
 *
 * @param base 目标接口当前的文档（其 `responses` 即已有的示例），用于去重、
 *             字段继承，以及 `...base` 保留 summary / paramMeta 等文档元数据。
 */
export function buildResponseExample(
  response: ResponseData,
  base: RequestDoc,
  options: { name: string; description: string },
): BuiltResponseExample {
  if (isDuplicateResponseExample(base.responses, response.status, response.body)) {
    return { result: "duplicate", doc: null, example: null };
  }
  const contentType =
    response.headers.find((header) => header.name.toLowerCase() === "content-type")?.value ??
    "application/json";
  const example: ResponseExample = {
    id: uid(),
    name: options.name,
    status: response.status,
    contentType,
    // JSON 正文保存时就格式化成缩进形式，文档视图 / 文档站 / Markdown 导出
    // 直接复用 example.body，无需各自再格式化一次。解析失败（纯文本、二进制、
    // 被截断的半截 JSON）保持原文。去重走 responseBodySignature（先 parse 再
    // 比较），格式化不影响判重。
    body: response.truncated ? response.body : formatResponseExampleBody(response.body),
    description: options.description,
    // 保存示例时顺带把响应体扁平成字段表，用户只需补类型 / 必填 / 说明。
    // 只取 body，不自动写入响应头值（Set-Cookie 等可能是凭据）。
    // 新增示例沿用同接口已有示例写好的字段说明 / 必填，不必重复填写。
    params: inheritResponseParams(
      deriveResponseParams(response.body, contentType),
      base.responses.map((item) => normalizeResponseParams(item.params)),
    ),
  };
  const doc: RequestDoc = {
    ...base,
    responses: [...base.responses, example],
    updatedAt: Date.now(),
  };
  return { result: "added", doc, example };
}

/**
 * 保存结果 → 中文提示文案。文档视图 / 用例视图共用同一套结果映射，
 * 仅因上下文不同（用例示例写入所属接口）而保留不同措辞。
 */
export function responseExampleHint(
  result: SaveResponseExampleResult,
  variant: "doc" | "case",
): string {
  if (result === "added") {
    return variant === "case"
      ? "已新增一条返回示例，可在所属接口的「文档」标签查看与编辑（字段说明沿用了之前的示例）"
      : "已新增一条返回示例，并按响应体生成响应参数表（字段说明沿用已有示例）";
  }
  if (result === "duplicate") {
    return variant === "case"
      ? "这条响应与已有示例的数据完全一致，没有重复保存"
      : "当前响应与已有示例的数据完全一致，没有重复保存";
  }
  return variant === "case"
    ? "保存失败：没有可用的响应或找不到所属接口"
    : "先发送一次请求再保存示例";
}
