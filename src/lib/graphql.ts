import type { ResponseData } from "../types";

/**
 * GraphQL introspection：标准 __schema 查询 + 结果解析为可读的类型大纲。
 * 只依赖一次普通的 GraphQL HTTP 请求（application/json），零额外依赖。
 */

/** 标准 introspection 查询（GraphQL Introspection 规范子集）。 */
export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      name
      kind
      description
      fields {
        name
        description
        type { name kind ofType { name kind ofType { name kind } } }
        args { name type { name kind ofType { name kind ofType { name kind } } } }
      }
    }
  }
}`;

export interface GqlField {
  name: string;
  description: string;
  /** 渲染用的类型签名，如 `String` / `[User!]!`。 */
  type: string;
  args: { name: string; type: string }[];
}

export interface GqlType {
  name: string;
  kind: string;
  description: string;
  fields: GqlField[];
}

export interface GqlSchema {
  queryType: string;
  mutationType: string | null;
  types: GqlType[];
}

/** 内置元类型与纯标量不需要展示在大纲里。 */
const BUILTIN_PREFIX = "__";
const BUILTIN_KINDS = new Set(["SCALAR"]);

function typeName(type: unknown): string {
  if (type === null || typeof type !== "object") return "?";
  const record = type as Record<string, unknown>;
  if (typeof record.name === "string") return record.name;
  const inner = typeName(record.ofType);
  switch (record.kind) {
    case "NON_NULL":
      return `${inner}!`;
    case "LIST":
      return `[${inner}]`;
    default:
      return inner;
  }
}

/**
 * 解析 introspection 响应为类型大纲。
 * @throws 响应不是 GraphQL JSON（缺 data.__schema）或 errors 非空时抛中文错误。
 */
export function parseIntrospection(response: ResponseData): GqlSchema {
  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new Error("GraphQL 响应不是合法 JSON");
  }
  const record = payload as Record<string, unknown>;
  const errors = record.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as Record<string, unknown>;
    const message = typeof first?.message === "string" ? first.message : "introspection 失败";
    throw new Error(`GraphQL 错误：${message}`);
  }
  const schema = (record.data as Record<string, unknown> | undefined)?.__schema as
    | Record<string, unknown>
    | undefined;
  if (!schema) {
    throw new Error("响应中没有 data.__schema，请确认目标是一个 GraphQL 端点");
  }

  const queryType = (schema.queryType as Record<string, unknown> | null)?.name;
  const mutationType = (schema.mutationType as Record<string, unknown> | null)?.name;
  const rawTypes = Array.isArray(schema.types) ? schema.types : [];

  const types: GqlType[] = rawTypes
    .map((raw) => {
      const type = raw as Record<string, unknown>;
      const fields = Array.isArray(type.fields) ? type.fields : [];
      return {
        name: String(type.name ?? ""),
        kind: String(type.kind ?? ""),
        description: typeof type.description === "string" ? type.description : "",
        fields: fields.map((rawField) => {
          const field = rawField as Record<string, unknown>;
          const args = Array.isArray(field.args) ? field.args : [];
          return {
            name: String(field.name ?? ""),
            description: typeof field.description === "string" ? field.description : "",
            type: typeName(field.type),
            args: args.map((rawArg) => {
              const arg = rawArg as Record<string, unknown>;
              return { name: String(arg.name ?? ""), type: typeName(arg.type) };
            }),
          };
        }),
      };
    })
    // 只留对象/接口/联合类型，跳过内置 __meta 类型。
    .filter(
      (type) =>
        !type.name.startsWith(BUILTIN_PREFIX) &&
        !BUILTIN_KINDS.has(type.kind) &&
        type.fields.length > 0,
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    queryType: typeof queryType === "string" ? queryType : "?",
    mutationType: typeof mutationType === "string" ? mutationType : null,
    types,
  };
}
