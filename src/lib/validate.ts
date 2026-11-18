import type { DataModel, RequestDraft, ResponseData, ResponseParam } from "../types";
import { headerValue } from "./smartView.ts";
import { modelRefResolver, parseSchemaText, validateJsonSchema } from "./jsonschema.ts";
import {
  matchesResponseType,
  normalizeResponseParams,
  resolveResponsePath,
} from "./responseParams.ts";

// --------------------------------------------- response auto-validation ----
//
// Apifox-style "自动校验": when the request carries API documentation with
// saved response examples, every response is checked against that definition.
// The checks are intentionally LENIENT — the goal is to surface contract
// drift, not to reject unusual-but-valid responses:
//   • status      — must match one of the documented example statuses
//   • content-type— media-type family must match the matched example's
//   • json shape  — when the example has a bound data model, validate against
//                   its JSON Schema; otherwise, if the example has hand-written
//                   response parameter definitions, validate against that field
//                   table; otherwise fall back to comparing with the example
//                   body shape. EXTRA fields are always fine (forward-compatible),
//                   and `null` marks a field as "any type / optional".
//
// Pure functions only: no store access, no side effects, safe to call from
// the component render path or from tests.

export interface ValidationFinding {
  /** Stable machine name, e.g. "status" / "content-type" / "json-shape". */
  name: string;
  /** Human label of the check that produced the finding. */
  check: string;
  level: "error" | "warning" | "info";
  /** Chinese, user-facing detail. */
  message: string;
}

interface SchemaNode {
  type: "object" | "array" | "string" | "number" | "boolean" | "null";
  /** For objects: field name → child schema. */
  fields?: Record<string, SchemaNode>;
  /** For arrays: schema of a representative item (first item). */
  item?: SchemaNode;
}

function inferSchema(value: unknown): SchemaNode {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return { type: "array", item: value.length > 0 ? inferSchema(value[0]) : undefined };
  }
  if (typeof value === "object") {
    const fields: Record<string, SchemaNode> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      fields[key] = inferSchema(child);
    }
    return { type: "object", fields };
  }
  if (typeof value === "number") return { type: "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  return { type: "string" };
}

const MAX_FINDINGS = 24;

/** Structural diff. `path` is a dotted JSON path for messages. */
function diffSchema(
  expected: SchemaNode,
  actual: unknown,
  path: string,
  findings: ValidationFinding[],
  expectedName: string,
): void {
  if (findings.length >= MAX_FINDINGS) return;

  // `null` in the example means "no promise about this value" — accept anything.
  if (expected.type === "null") return;

  if (actual === null || actual === undefined) {
    findings.push({
      name: "json-shape",
      check: "响应结构",
      level: "warning",
      message: `字段 ${path || "(根)"} 在示例 ${expectedName} 中有定义，但响应中为 ${actual === undefined ? "缺失" : "null"}`,
    });
    return;
  }

  const actualType = Array.isArray(actual)
    ? "array"
    : actual === null
      ? "null"
      : typeof actual === "number"
        ? "number"
        : typeof actual === "boolean"
          ? "boolean"
          : typeof actual === "object"
            ? "object"
            : "string";

  if (actualType !== expected.type) {
    findings.push({
      name: "json-shape",
      check: "响应结构",
      level: "warning",
      message: `字段 ${path || "(根)"} 期望 ${expected.type}，实际 ${actualType}`,
    });
    return;
  }

  if (expected.type === "object" && expected.fields) {
    for (const [key, child] of Object.entries(expected.fields)) {
      if (findings.length >= MAX_FINDINGS) return;
      if (!(key in (actual as Record<string, unknown>))) {
        findings.push({
          name: "json-shape",
          check: "响应结构",
          level: "warning",
          message: `缺少字段 ${path ? `${path}.${key}` : key}（示例 ${expectedName} 中有定义）`,
        });
        continue;
      }
      diffSchema(
        child,
        (actual as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key,
        findings,
        expectedName,
      );
    }
  }

  if (expected.type === "array" && expected.item) {
    const items = actual as unknown[];
    if (items.length > 0) {
      diffSchema(expected.item, items[0], `${path}[0]`, findings, expectedName);
    }
  }
}

/** Strip parameters; keep the bare media type, lower-cased. */
function mediaType(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

/** Coarse family so `application/json; charset=utf-8` matches `application/json`. */
function mediaFamily(type: string): string {
  if (type.endsWith("/json") || type.endsWith("+json")) return "json";
  if (type.startsWith("text/")) return "text";
  if (type === "text/html") return "html";
  if (type.endsWith("/xml") || type.endsWith("+xml")) return "xml";
  return type;
}

/**
 * 按文档里的响应参数表比对响应体：只检查已定义的字段，多余字段一律放行。
 * `required` 由文档作者决定（自动生成的字段默认非必填），类型检查是宽松匹配。
 */
function documentedParamFindings(
  params: ResponseParam[],
  actualBody: unknown,
  exampleName: string,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  for (const param of params) {
    if (findings.length >= MAX_FINDINGS) break;
    if (param.location !== "body" || param.name.trim() === "") continue;
    const resolved = resolveResponsePath(actualBody, param.name);
    if (!resolved.found) {
      if (param.required) {
        findings.push({
          name: "response-param",
          check: "响应参数",
          level: "warning",
          message: `缺少字段 ${param.name}（示例 ${exampleName} 的响应参数定义标记为必填）`,
        });
      }
      continue;
    }
    if (!matchesResponseType(resolved.value, param.type)) {
      findings.push({
        name: "response-param",
        check: "响应参数",
        level: "warning",
        message: `字段 ${param.name} 期望 ${param.type}，实际 ${typeof resolved.value}（示例 ${exampleName}）`,
      });
    }
  }
  return findings;
}

/**
 * Validates an actual response against the request's documented examples.
 * When the matched example binds a data model (`modelId`), the JSON structure
 * check runs against that model's JSON Schema (required / type / enum / $ref)
 * instead of the example body shape; otherwise a hand-written `params` table
 * takes precedence, and the example body shape is only the final fallback.
 * Required response headers are checked for every response type. `models` is
 * the workspace model registry that resolves `model://Name` refs.
 * Returns an empty array when there is nothing to validate (no doc, no
 * examples, or a streaming response).
 */
export function validateResponse(
  draft: RequestDraft,
  response: ResponseData,
  models: DataModel[] = [],
): ValidationFinding[] {
  const examples = draft.doc?.responses ?? [];
  if (examples.length === 0) return [];

  const findings: ValidationFinding[] = [];

  // 1. Status code — must be one of the documented statuses.
  const statuses = examples.map((example) => example.status);
  const matched = examples.find((example) => example.status === response.status);
  if (!matched) {
    findings.push({
      name: "status",
      check: "状态码",
      level: "error",
      message: `响应状态 ${response.status} 不在文档定义的 [${statuses.join(", ")}] 中`,
    });
    return findings; // without a matched example the rest is guesswork
  }

  const params = normalizeResponseParams(matched.params).filter(
    (param) => param.name.trim() !== "",
  );
  const bodyParams = params.filter((param) => param.location === "body");

  // 2. Content-Type family.
  const expectedType = mediaFamily(mediaType(matched.contentType));
  const actualType = mediaFamily(mediaType(headerValue(response, "content-type")));
  if (actualType && expectedType && actualType !== expectedType) {
    findings.push({
      name: "content-type",
      check: "Content-Type",
      level: "warning",
      message: `Content-Type 期望 ${matched.contentType}，实际响应头不同（family: ${actualType} ≠ ${expectedType}）`,
    });
  }

  // 2.5 Documented response headers — presence only (wire values are strings,
  // so type-checking a header against "integer" would always be a false alarm).
  for (const param of params) {
    if (findings.length >= MAX_FINDINGS) break;
    if (param.location !== "header" || !param.required) continue;
    if (headerValue(response, param.name) === "") {
      findings.push({
        name: "response-param",
        check: "响应参数",
        level: "warning",
        message: `缺少响应头 ${param.name}（示例 ${matched.name} 的响应参数定义标记为必填）`,
      });
    }
  }

  // 3. JSON structure — model schema > response param table > example body shape.
  if (expectedType === "json") {
    const boundModel = matched.modelId
      ? models.find((model) => model.id === matched.modelId)
      : undefined;

    if (response.bodyKind !== "json") {
      findings.push({
        name: "json-shape",
        check: "响应结构",
        level: "warning",
        message: boundModel
          ? `数据模型 ${boundModel.name} 定义为 JSON，但响应 bodyKind 为 ${response.bodyKind}`
          : `示例 ${matched.name} 定义为 JSON，但响应 bodyKind 为 ${response.bodyKind}`,
      });
    } else {
      let actualBody: unknown;
      try {
        actualBody = JSON.parse(response.body);
      } catch {
        findings.push({
          name: "json-shape",
          check: "响应结构",
          level: "error",
          message: "响应 Content-Type 为 JSON 但 body 无法解析",
        });
        actualBody = undefined;
      }

      if (actualBody !== undefined) {
        if (boundModel) {
          const parsed = parseSchemaText(boundModel.schemaText);
          if (!parsed.schema) {
            findings.push({
              name: "json-shape",
              check: "响应结构",
              level: "warning",
              message: `数据模型 ${boundModel.name} 的 Schema 无法解析：${parsed.error}，跳过模型校验`,
            });
          } else {
            for (const finding of validateJsonSchema(
              actualBody,
              parsed.schema,
              modelRefResolver(models),
            )) {
              findings.push({
                name: "json-shape",
                check: "响应结构",
                level: finding.level,
                message: finding.path
                  ? `${finding.message}（模型 ${boundModel.name}）`
                  : `${finding.message}（模型 ${boundModel.name}）`,
              });
            }
          }
        } else if (bodyParams.length > 0) {
          // 文档作者手写了响应参数表：以它为准，不再重复比对示例结构。
          findings.push(...documentedParamFindings(bodyParams, actualBody, matched.name));
        } else {
          let exampleBody: unknown;
          try {
            exampleBody = JSON.parse(matched.body);
          } catch {
            findings.push({
              name: "json-shape",
              check: "响应结构",
              level: "info",
              message: `示例 ${matched.name} 的 body 不是合法 JSON，跳过结构校验`,
            });
            exampleBody = undefined;
          }
          if (exampleBody !== undefined) {
            diffSchema(inferSchema(exampleBody), actualBody, "", findings, matched.name);
          }
        }
      }
    }
  }

  return findings;
}
