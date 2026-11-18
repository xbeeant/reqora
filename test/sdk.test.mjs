/**
 * SDK 代码生成（P2-12）的纯逻辑测试。
 * Run with `bun run test` — Node 22 native TS, same as the other suites.
 * 注意：.mjs 里不能有 TS 语法（import type / as 断言都不行）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  camelName,
  generatePythonSdk,
  generateTsSdk,
  pascalName,
  tsTypeFromSchema,
} from "../src/lib/sdk.ts";

function emptyDoc() {
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

function request(overrides = {}) {
  return {
    id: "r1",
    collectionId: "c1",
    name: "创建用户",
    method: "POST",
    url: "{{baseUrl}}/api/users",
    query: [],
    headers: [],
    body: { type: "none" },
    auth: { type: "none" },
    protocol: "http",
    createdAt: 0,
    updatedAt: 0,
    doc: emptyDoc(),
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    collections: [],
    environments: [],
    activeEnvironmentId: null,
    dataModels: [],
    ...overrides,
  };
}

test("naming helpers slugify mixed input", () => {
  assert.equal(pascalName("create-user"), "CreateUser");
  assert.equal(camelName("user list v2"), "userListV2");
  assert.equal(pascalName("123abc"), "M123abc");
});

test("tsTypeFromSchema maps the supported subset", () => {
  const modelTypes = new Map([["User", "User"]]);
  assert.equal(tsTypeFromSchema({ type: "string" }, modelTypes), "string");
  assert.equal(tsTypeFromSchema({ type: ["string", "null"] }, modelTypes), "string | null");
  assert.equal(tsTypeFromSchema({ enum: ["a", "b", 1] }, modelTypes), '"a" | "b" | 1');
  assert.equal(
    tsTypeFromSchema({ type: "array", items: { type: "integer" } }, modelTypes),
    "Array<number>",
  );
  assert.equal(tsTypeFromSchema({ $ref: "model://User" }, modelTypes), "User");
  const object = tsTypeFromSchema(
    {
      type: "object",
      properties: {
        name: { type: "string", description: "姓名" },
        age: { type: "integer" },
      },
      required: ["name"],
    },
    modelTypes,
  );
  assert.match(object, /"name": \/\*\* 姓名 \*\/ string;/);
  assert.match(object, /"age"\?: number;/);
});

test("generateTsSdk builds functions, path/query params and bound model types", () => {
  const snap = snapshot({
    dataModels: [
      {
        id: "m1",
        name: "UserCreate",
        description: "用户创建参数",
        schemaText: JSON.stringify({
          type: "object",
          properties: { username: { type: "string" }, password: { type: "string" } },
          required: ["username", "password"],
        }),
        updatedAt: 0,
      },
    ],
    collections: [
      {
        id: "c1",
        name: "用户中心",
        items: [
          request({
            id: "r1",
            name: "create-user",
            method: "POST",
            url: "{{baseUrl}}/api/users/{orgId}",
            headers: [{ id: "h1", key: "X-Trace", value: "abc", enabled: true }],
            auth: { type: "bearer", token: "{{token}}" },
            body: { type: "json", content: '{"username": "a", "password": "b"}' },
            doc: { ...emptyDoc(), summary: "创建用户", requestModelId: "m1" },
          }),
          request({
            id: "r2",
            name: "list-users",
            method: "GET",
            url: "{{baseUrl}}/api/users",
            query: [
              { id: "q1", key: "page", value: "1", enabled: true },
              { id: "q2", key: "size", value: "20", enabled: true },
            ],
            body: { type: "none" },
            auth: { type: "none" },
          }),
        ],
      },
    ],
  });

  const file = generateTsSdk(snap);
  // 绑定模型的类型接口已生成
  assert.match(file.content, /export interface UserCreate/);
  assert.match(file.content, /"username": string/);
  // 函数签名：路径参数 + token + body + query + options
  assert.match(file.content, /export async function createUser\(/);
  assert.match(file.content, /orgId: string,/);
  assert.match(file.content, /token: string,/);
  assert.match(file.content, /body: UserCreate,/);
  assert.match(file.content, /query: \{ page\?: string; size\?: string \} = \{\},/);
  // Authorization 头由 token 参数拼出
  assert.match(file.content, /Authorization: `Bearer \$\{token\}`/);
  // query 映射进 call()
  assert.match(file.content, /"page": page,/);
  // BASE_URL 来自环境变量（此处无环境 → 占位符）
  assert.match(file.content, /export const BASE_URL = "https:\/\/your-api-host";/);
  assert.equal(file.fileName, "api-client.ts");
});

test("a bound model drives the SDK body even when the request body is empty", () => {
  // Regression: the bound model used to be read only inside the
  // `body.type === "json" && content !== ""` branch, so a freshly created
  // request (body: none) silently lost its binding on export.
  const snap = snapshot({
    dataModels: [
      {
        id: "m1",
        name: "UserCreate",
        description: "",
        schemaText: JSON.stringify({
          type: "object",
          properties: { username: { type: "string" } },
          required: ["username"],
        }),
        updatedAt: 0,
      },
    ],
    collections: [
      {
        id: "c1",
        name: "Demo",
        items: [
          request({
            name: "create-user",
            method: "POST",
            url: "https://api.example.com/users",
            body: { type: "none" },
            doc: { ...emptyDoc(), requestModelId: "m1" },
          }),
        ],
      },
    ],
  });

  const ts = generateTsSdk(snap);
  assert.match(ts.content, /export interface UserCreate/);
  assert.match(ts.content, /body: UserCreate,/);
  assert.match(ts.content, /请求体示例/);

  const py = generatePythonSdk(snap);
  assert.match(py.content, /body: Any/);
  assert.match(py.content, /请求体示例/);
});

test("generateTsSdk infers body type from literal JSON when no model is bound", () => {
  const snap = snapshot({
    collections: [
      {
        id: "c1",
        name: "Demo",
        items: [
          request({
            name: "ping",
            method: "PUT",
            url: "https://api.example.com/ping",
            body: { type: "json", content: '{"text": "hi", "retry": 1}' },
            doc: { ...emptyDoc(), summary: "ping" },
          }),
        ],
      },
    ],
  });
  const file = generateTsSdk(snap);
  assert.match(file.content, /body: \{/);
  assert.match(file.content, /"text": string/);
  assert.match(file.content, /"retry": number/);
  // 绝对 URL 不再拼接 BASE_URL
  assert.match(file.content, /`https:\/\/api\.example\.com\/ping`/);
});

test("generatePythonSdk builds requests client with f-string URLs and docstrings", () => {
  const snap = snapshot({
    environments: [
      {
        id: "e1",
        name: "dev",
        variables: [
          { id: "v1", key: "baseUrl", value: "http://127.0.0.1:8000", enabled: true },
        ],
      },
    ],
    activeEnvironmentId: "e1",
    collections: [
      {
        id: "c1",
        name: "订单",
        items: [
          request({
            id: "r1",
            name: "get-order",
            method: "GET",
            url: "{{baseUrl}}/orders/{orderId}",
            query: [{ id: "q1", key: "detail", value: "true", enabled: true }],
            body: { type: "none" },
            auth: { type: "none" },
          }),
        ],
      },
    ],
  });
  const file = generatePythonSdk(snap);
  assert.equal(file.fileName, "api_client.py");
  assert.match(file.content, /BASE_URL = "http:\/\/127\.0\.0\.1:8000"/);
  assert.match(file.content, /def get_order\(/);
  assert.match(file.content, /orderId: str,/);
  assert.match(file.content, /f"\{base_url\}\/orders\/\{orderId\}"/);
  assert.match(file.content, /query=query,/);
  assert.match(file.content, /def _request\(/);
});

test("ws and tcp requests are skipped; multipart bodies become notes", () => {
  const snap = snapshot({
    collections: [
      {
        id: "c1",
        name: "Mixed",
        items: [
          request({ name: "wsThing", protocol: "ws", url: "wss://x" }),
          request({ name: "tcpThing", protocol: "tcp", url: "127.0.0.1:9" }),
          request({
            name: "upload",
            method: "POST",
            url: "{{baseUrl}}/upload",
            body: {
              type: "formData",
              items: [
                { id: "f1", key: "file", value: "", enabled: true, file: true, fileName: "a.zip" },
              ],
            },
          }),
        ],
      },
    ],
  });
  const ts = generateTsSdk(snap);
  assert.doesNotMatch(ts.content, /wsThing|tcpThing/);
  assert.match(ts.content, /upload\(/);
  assert.match(ts.content, /请用 FormData 上传/);
  const py = generatePythonSdk(snap);
  assert.doesNotMatch(py.content, /wsThing|tcpThing/);
});
