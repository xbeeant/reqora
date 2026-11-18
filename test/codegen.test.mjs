/**
 * codegen.ts 纯逻辑测试：cURL / fetch / python / go 四语言生成，
 * 覆盖 query 拼接、auth 展开与 body 形态。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { generateCode } from "../src/lib/codegen.ts";

function draft(overrides = {}) {
  return {
    id: "r1",
    name: "示例",
    method: "POST",
    url: "https://api.example.com/login",
    headers: [
      { id: "h1", key: "X-Trace", value: "t-1", enabled: true },
      { id: "h2", key: "X-Off", value: "off", enabled: false },
    ],
    query: [{ id: "q1", key: "src", value: "cli", enabled: true }],
    body: { type: "json", content: '{"user":"a"}' },
    auth: { type: "none" },
    updatedAt: 0,
    ...overrides,
  };
}

test("cURL：query 拼接、启用头、JSON 体与 Content-Type", () => {
  const code = generateCode(draft(), "curl");
  assert.ok(code.startsWith("curl -X POST 'https://api.example.com/login?src=cli'"));
  assert.ok(code.includes("-H 'X-Trace: t-1'"));
  assert.ok(!code.includes("X-Off"));
  assert.ok(code.includes("-H 'Content-Type: application/json'"));
  assert.ok(code.includes("-d '{\"user\":\"a\"}'"));
});

test("cURL：bearer/basic/apiKey(auth) 展开且不与用户头重复", () => {
  const bearer = generateCode(draft({ auth: { type: "bearer", token: "tk" } }), "curl");
  assert.ok(bearer.includes("-H 'Authorization: Bearer tk'"));

  const basic = generateCode(
    draft({ auth: { type: "basic", username: "u", password: "p" } }),
    "curl",
  );
  // base64("u:p") === "dTpw"
  assert.ok(basic.includes("Basic dTpw"));

  const apiKey = generateCode(
    draft({
      auth: { type: "apiKey", key: "api-key", value: "v", location: "header" },
      headers: [{ id: "h1", key: "api-key", value: "explicit", enabled: true }],
    }),
    "curl",
  );
  assert.ok(apiKey.includes("'api-key: explicit'"));
  assert.ok(!apiKey.includes("'api-key: v'"));
});

test("fetch：结构完整且 method/headers/body 正确", () => {
  const code = generateCode(draft(), "fetch");
  assert.ok(code.includes("await fetch("));
  assert.ok(code.includes("method: 'POST',"));
  assert.ok(code.includes("'X-Trace': 't-1',"));
  assert.ok(code.includes("body: '{\"user\":\"a\"}',"));
  assert.ok(code.includes("const data = await response.text();"));
});

test("python：requests 调用与 headers 字典", () => {
  const code = generateCode(draft(), "python");
  assert.ok(code.includes("import requests"));
  assert.ok(code.includes("resp = requests.post("));
  assert.ok(code.includes('"X-Trace": "t-1",'));
  assert.ok(code.includes('data="{\\"user\\":\\"a\\"}",'));
  assert.ok(code.includes("print(resp.status_code)"));
});

test("go：无体 GET 用 nil，有体用 strings.NewReader 且 import 正确", () => {
  const get = generateCode(draft({ method: "GET", body: { type: "none" } }), "go");
  assert.ok(get.includes("http.NewRequest(\"GET\", \"https://api.example.com/login?src=cli\", nil)"));
  assert.ok(!get.includes('"strings"'));

  const post = generateCode(draft(), "go");
  assert.ok(post.includes("body := strings.NewReader(`{\"user\":\"a\"}`)"));
  assert.ok(post.includes('\t"net/http"'));
  assert.ok(post.includes('req.Header.Set("Content-Type", "application/json")'));
  assert.ok(post.includes("fmt.Println(resp.Status, string(data))"));
});

test("变量替换 + resolvedUrl 优先 + 二进制体给注释", () => {
  const withVar = draft({
    url: "{{base}}/login",
    headers: [{ id: "h1", key: "Authorization", value: "Bearer {{token}}", enabled: true }],
  });
  const code = generateCode(withVar, "curl", { base: "https://real.com", token: "tk" });
  assert.ok(code.includes("'https://real.com/login?src=cli'"));
  assert.ok(code.includes("Bearer tk"));

  const resolved = generateCode(draft(), "curl", {}, "https://after-redirect.com/x");
  assert.ok(resolved.includes("'https://after-redirect.com/x?src=cli'"));

  const binary = generateCode(draft({ body: { type: "binary", data: "", fileName: "a.zip", contentType: "application/zip" } }), "python");
  assert.ok(binary.includes("# 二进制文件体"));
});
