/**
 * graphql.ts 测试：introspection 响应解析——类型签名（NON_NULL/LIST 嵌套）、
 * 参数、内置类型与空类型过滤、GraphQL errors 抛错、非法响应报错。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { INTROSPECTION_QUERY, parseIntrospection } from "../src/lib/graphql.ts";

function response(body) {
  return {
    requestId: "t", status: 200, statusText: "OK", ok: true, timeMs: 1, size: 1,
    url: "https://x/gql", resolvedUrl: "https://x/gql", missingVariables: [],
    headers: [], body, bodyKind: "json", truncated: false,
  };
}

const SCHEMA = {
  data: {
    __schema: {
      queryType: { name: "Query" },
      mutationType: { name: "Mutation" },
      types: [
        {
          name: "Query", kind: "OBJECT", description: "",
          fields: [
            {
              name: "user", description: "按 ID 查用户",
              type: { name: "User", kind: "OBJECT" },
              args: [{ name: "id", type: { name: null, kind: "NON_NULL", ofType: { name: "Int", kind: "SCALAR" } } }],
            },
            {
              name: "users", description: "",
              type: { name: null, kind: "NON_NULL", ofType: { name: null, kind: "LIST", ofType: { name: "User", kind: "OBJECT" } } },
              args: [{ name: "page", type: { name: "Int", kind: "SCALAR" } }],
            },
          ],
        },
        { name: "Mutation", kind: "OBJECT", description: "", fields: [{ name: "login", type: { name: "String", kind: "SCALAR" }, args: [] }] },
        { name: "__Schema", kind: "OBJECT", description: "", fields: [{ name: "types", type: { name: "Int", kind: "SCALAR" }, args: [] }] },
        { name: "String", kind: "SCALAR", description: "", fields: null },
        { name: "Empty", kind: "OBJECT", description: "", fields: [] },
      ],
    },
  },
};

test("INTROSPECTION_QUERY 是合法的 __schema 查询", () => {
  assert.ok(INTROSPECTION_QUERY.includes("__schema"));
  assert.ok(INTROSPECTION_QUERY.includes("queryType"));
});

test("解析类型签名：NON_NULL / LIST 嵌套与参数", () => {
  const schema = parseIntrospection(response(JSON.stringify(SCHEMA)));
  assert.equal(schema.queryType, "Query");
  assert.equal(schema.mutationType, "Mutation");
  const query = schema.types.find((t) => t.name === "Query");
  assert.deepEqual(query.fields[0].args, [{ name: "id", type: "Int!" }]);
  assert.equal(query.fields[1].type, "[User]!");
});

test("过滤内置 __ 类型、纯 SCALAR 与空类型，并按名称排序", () => {
  const schema = parseIntrospection(response(JSON.stringify(SCHEMA)));
  assert.deepEqual(schema.types.map((t) => t.name), ["Mutation", "Query"]);
});

test("GraphQL errors 抛中文错误；非法响应报缺 __schema", () => {
  assert.throws(
    () => parseIntrospection(response(JSON.stringify({ errors: [{ message: "not authorized" }] }))),
    /not authorized/,
  );
  assert.throws(
    () => parseIntrospection(response(JSON.stringify({ data: {} }))),
    /data\.__schema/,
  );
  assert.throws(() => parseIntrospection(response("not json")), /合法 JSON/);
});
