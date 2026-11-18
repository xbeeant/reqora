// JSON Schema subset engine for the data-model layer (P0-1).
//
// Supports the draft-07 keywords Apifox-style modelling actually needs:
//   type (string | array of strings), properties, required, items, enum,
//   example / default / description, nullable, and $ref — both local JSON
//   Pointers ("#/definitions/Foo") and workspace model references
//   ("model://User") resolved through a callback.
//
// Three operations, all pure:
//   parseSchemaText   — text → schema object (or a parse error)
//   schemaFromExample — infer a schema from a JSON value
//   validateJsonSchema— value vs schema → findings
//   generateFromSchema— schema → representative sample value

export type JsonSchemaValue = Record<string, unknown>;

export interface SchemaParseResult {
  schema: JsonSchemaValue | null;
  error: string | null;
}

export function parseSchemaText(text: string): SchemaParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { schema: null, error: "Schema 内容为空" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { schema: null, error: `Schema 不是合法 JSON：${(error as Error).message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { schema: null, error: "Schema 根节点必须是对象" };
  }
  return { schema: parsed as JsonSchemaValue, error: null };
}

/** Infers a JSON Schema object from an arbitrary JSON value. */
export function schemaFromExample(value: unknown): JsonSchemaValue {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return {
      type: "array",
      items: value.length > 0 ? schemaFromExample(value[0]) : {},
    };
  }
  if (typeof value === "object") {
    const properties: Record<string, JsonSchemaValue> = {};
    const required: string[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      properties[key] = schemaFromExample(child);
      required.push(key);
    }
    return { type: "object", properties, required };
  }
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  return { type: "string" };
}

export interface SchemaFinding {
  /** Dotted JSON path of the offending node, "" = root. */
  path: string;
  level: "error" | "warning";
  message: string;
}

export type RefResolver = (ref: string) => JsonSchemaValue | null;

const MAX_DEPTH = 8;
const MAX_FINDINGS = 24;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "object";
  return "string";
}

/** type keyword may be one string or a list; integer accepts number values. */
function typeMatches(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  if (expected === "number" && actual === "integer") return true;
  return false;
}

function resolvePointer(ref: string, root: JsonSchemaValue): JsonSchemaValue | null {
  if (!ref.startsWith("#/")) return null;
  let node: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[segment];
  }
  return node !== null && typeof node === "object" && !Array.isArray(node)
    ? (node as JsonSchemaValue)
    : null;
}

/**
 * Validates `value` against `schema`. `resolveRef` is consulted for refs the
 * local document cannot satisfy (i.e. `model://Name` workspace references);
 * returning null produces a warning instead of an error.
 */
export function validateJsonSchema(
  value: unknown,
  schema: JsonSchemaValue,
  resolveRef?: RefResolver,
): SchemaFinding[] {
  const findings: SchemaFinding[] = [];
  walk(value, schema, "", resolveRef ?? (() => null), schema, 0, findings);
  return findings;
}

function walk(
  value: unknown,
  schema: JsonSchemaValue,
  path: string,
  resolveRef: RefResolver,
  root: JsonSchemaValue,
  depth: number,
  findings: SchemaFinding[],
): void {
  if (findings.length >= MAX_FINDINGS) return;
  if (depth > MAX_DEPTH) {
    findings.push({
      path,
      level: "warning",
      message: `嵌套超过 ${MAX_DEPTH} 层，停止深入校验（${path || "(根)"}）`,
    });
    return;
  }

  // $ref — local pointer or external model reference.
  const ref = typeof schema.$ref === "string" ? schema.$ref : null;
  if (ref) {
    const resolved = ref.startsWith("#/")
      ? resolvePointer(ref, root)
      : resolveRef(ref);
    if (resolved) {
      walk(value, resolved, path, resolveRef, root, depth + 1, findings);
    } else {
      findings.push({
        path,
        level: "warning",
        message: `引用 ${ref} 无法解析，跳过该节点校验`,
      });
    }
    return;
  }

  // type keyword (single or union), `nullable: true` admits null.
  const typeRaw = schema.type;
  const expectedTypes = Array.isArray(typeRaw)
    ? typeRaw.filter((item): item is string => typeof item === "string")
    : typeof typeRaw === "string"
      ? [typeRaw]
      : [];
  const nullable = schema.nullable === true;
  const actualType = typeOf(value);

  if (expectedTypes.length > 0) {
    if (value === null && nullable) return;
    const matched = expectedTypes.some((expected) => typeMatches(expected, actualType));
    if (!matched) {
      findings.push({
        path,
        level: "error",
        message: `${path || "(根)"} 期望类型 ${expectedTypes.join(" | ")}，实际 ${actualType}`,
      });
      return;
    }
  }

  // enum — strict equality against one of the listed values.
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const hit = schema.enum.some((option) => option === value);
    if (!hit) {
      findings.push({
        path,
        level: "error",
        message: `${path || "(根)"} 的值 ${JSON.stringify(value)} 不在枚举 [${schema.enum
          .map((option) => JSON.stringify(option))
          .join(", ")}] 中`,
      });
      return;
    }
  }

  if (actualType === "object") {
    const properties =
      schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
        ? (schema.properties as Record<string, JsonSchemaValue>)
        : {};
    const record = value as Record<string, unknown>;

    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (findings.length >= MAX_FINDINGS) return;
        if (typeof name !== "string") continue;
        if (!(name in record)) {
          findings.push({
            path: path ? `${path}.${name}` : name,
            level: "error",
            message: `缺少必填字段 ${path ? `${path}.${name}` : name}`,
          });
        }
      }
    }

    for (const [key, childSchema] of Object.entries(properties)) {
      if (findings.length >= MAX_FINDINGS) return;
      if (!(key in record)) continue;
      walk(record[key], childSchema, path ? `${path}.${key}` : key, resolveRef, root, depth + 1, findings);
    }

    // additionalProperties: false → unknown keys are flagged.
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (findings.length >= MAX_FINDINGS) return;
        if (!(key in properties)) {
          findings.push({
            path: path ? `${path}.${key}` : key,
            level: "warning",
            message: `多余字段 ${path ? `${path}.${key}` : key}（additionalProperties: false）`,
          });
        }
      }
    }
  }

  if (actualType === "array") {
    const items = value as unknown[];
    const itemSchema = schema.items;
    if (itemSchema && typeof itemSchema === "object" && !Array.isArray(itemSchema)) {
      for (let index = 0; index < Math.min(items.length, 8); index += 1) {
        if (findings.length >= MAX_FINDINGS) return;
        walk(items[index], itemSchema as JsonSchemaValue, `${path}[${index}]`, resolveRef, root, depth + 1, findings);
      }
    }
  }
}

/**
 * Generates a representative sample value from a schema. Objects emit every
 * property; arrays one item. `example` / `default` / first `enum` win when
 * present; strings fall back to a few format heuristics.
 */
export function generateFromSchema(
  schema: JsonSchemaValue,
  resolveRef?: RefResolver,
  depth = 0,
  root: JsonSchemaValue = schema,
): unknown {
  const resolve = resolveRef ?? (() => null);

  const ref = typeof schema.$ref === "string" ? schema.$ref : null;
  if (ref && depth <= MAX_DEPTH) {
    const resolved = ref.startsWith("#/") ? resolvePointer(ref, root) : resolve(ref);
    if (resolved) return generateFromSchema(resolved, resolveRef, depth + 1, root);
    return null;
  }

  if (schema.example !== undefined) return cloneJson(schema.example);
  if (schema.default !== undefined) return cloneJson(schema.default);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return cloneJson(schema.enum[0]);

  const types = Array.isArray(schema.type)
    ? schema.type.filter((item): item is string => typeof item === "string")
    : typeof schema.type === "string"
      ? [schema.type]
      : [];
  const type = types[0] ?? "object";
  if (type === "null") return null;

  if (type === "object") {
    const result: Record<string, unknown> = {};
    const properties =
      schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
        ? (schema.properties as Record<string, JsonSchemaValue>)
        : {};
    for (const [key, child] of Object.entries(properties)) {
      result[key] = generateFromSchema(child, resolveRef, depth + 1, root);
    }
    return result;
  }

  if (type === "array") {
    const itemSchema = schema.items;
    if (itemSchema && typeof itemSchema === "object" && !Array.isArray(itemSchema)) {
      return [generateFromSchema(itemSchema as JsonSchemaValue, resolveRef, depth + 1, root)];
    }
    return [];
  }

  if (type === "integer") return 1;
  if (type === "number") return 1.5;
  if (type === "boolean") return true;

  // string — format / description-aware placeholder.
  const format = typeof schema.format === "string" ? schema.format : "";
  if (format === "email") return "user@example.com";
  if (format === "date") return "2026-01-01";
  if (format === "date-time") return "2026-01-01T00:00:00Z";
  if (format === "uuid") return "00000000-0000-4000-8000-000000000000";
  if (format === "uri" || format === "url") return "https://example.com";
  if (format === "ipv4") return "127.0.0.1";
  return "string";
}

function cloneJson(value: unknown): unknown {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Builds a resolver for `model://Name` refs against a workspace model list.
 * Returns null for anything it cannot satisfy, so `validateJsonSchema` can
 * downgrade to a warning.
 */
export function modelRefResolver(
  models: { name: string; schemaText: string }[],
): RefResolver {
  const cache = new Map<string, JsonSchemaValue | null>();
  return (ref: string): JsonSchemaValue | null => {
    if (!ref.startsWith("model://")) return null;
    const name = ref.slice("model://".length);
    if (cache.has(name)) return cache.get(name)!;
    const found = models.find((model) => model.name === name) ?? null;
    let resolved: JsonSchemaValue | null = null;
    if (found) {
      const parsed = parseSchemaText(found.schemaText);
      resolved = parsed.schema;
    }
    cache.set(name, resolved);
    return resolved;
  };
}

/** Human-readable field table for docs UI: rows of name / type / required. */
export interface SchemaFieldRow {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export function schemaFieldRows(schema: JsonSchemaValue): SchemaFieldRow[] {
  const properties =
    schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, JsonSchemaValue>)
      : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [],
  );
  return Object.entries(properties).map(([name, child]) => ({
    name,
    type: Array.isArray(child.type) ? (child.type as string[]).join(" | ") : String(child.type ?? "any"),
    required: required.has(name),
    description: typeof child.description === "string" ? child.description : "",
  }));
}
