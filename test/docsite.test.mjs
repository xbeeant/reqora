/**
 * docsite.ts 测试：单文件 HTML 导出——目录、参数表、请求体、响应示例、
 * Markdown 渲染与 HTML 转义。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { exportDocSiteHtml } from "../src/lib/docsite.ts";
import { emptySnapshot } from "../src/lib/defaults.ts";

function snapshotWith(collections) {
  const snapshot = emptySnapshot();
  snapshot.collections = collections;
  return snapshot;
}

function requestDoc(overrides = {}) {
  return {
    summary: "登录并签发令牌",
    description: "## 详细说明\n\n支持 `Bearer` 令牌与 **重试**。\n\n- 参数一\n- 参数二\n\n```json\n{\"a\":1}\n```",
    owner: "",
    status: "联调中",
    tags: [],
    paramMeta: {
      // paramMeta 以行 id 为键（q:<rowId>），与「文档」标签一致。
      "q:q1": { type: "integer", required: true, example: "1", description: "页码" },
    },
    responses: [
      { id: "e1", name: "成功", status: 200, contentType: "application/json", body: '{"code":0}', description: "" },
    ],
    updatedAt: 0,
    ...overrides,
  };
}

function loginRequest() {
  return {
    id: "r1",
    name: "登录接口",
    method: "POST",
    url: "https://api.example.com/login",
    headers: [{ id: "h1", key: "X-Trace", value: "t-1", enabled: true }],
    query: [{ id: "q1", key: "page", value: "1", enabled: true }],
    body: { type: "json", content: '{"user":"a"}' },
    auth: { type: "none" },
    doc: requestDoc(),
    updatedAt: 0,
  };
}

test("导出单文件 HTML：结构完整（DOCTYPE / 样式 / 目录 / 内容）", () => {
  const html = exportDocSiteHtml(snapshotWith([{ id: "c1", name: "用户集合", items: [loginRequest()] }]));
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.ok(html.includes("<style>"));
  assert.ok(html.includes('href="#api-0"'));
  assert.ok(html.includes("用户集合"));
  assert.ok(html.includes("登录接口"));
  assert.ok(html.includes("1 个集合 · 1 个接口"));
  // 无外部资源：不引用任何 http(s) 链接资源（锚点除外）。
  assert.ok(!/<(script|link|img)[^>]+src=/i.test(html));
});

test("方法徽标着色 + URL 携带 query", () => {
  const html = exportDocSiteHtml(snapshotWith([{ id: "c1", name: "C", items: [loginRequest()] }]));
  assert.ok(html.includes('style="background:#c76e12"')); // POST
  assert.ok(html.includes("POST https://api.example.com/login?page=1"));
});

test("参数表由 paramMeta 派生（类型/必填/示例/说明）", () => {
  const html = exportDocSiteHtml(snapshotWith([{ id: "c1", name: "C", items: [loginRequest()] }]));
  assert.ok(html.includes("<th>参数</th>"));
  assert.ok(html.includes("integer"));
  assert.ok(html.includes("页码"));
  assert.ok(html.includes("X-Trace")); // header 参数区
});

test("请求体与响应示例渲染为代码块", () => {
  const html = exportDocSiteHtml(snapshotWith([{ id: "c1", name: "C", items: [loginRequest()] }]));
  assert.ok(html.includes("请求体（JSON）"));
  assert.ok(html.includes('{&quot;user&quot;:&quot;a&quot;}') || html.includes('{"user":"a"}'));
  assert.ok(html.includes("响应示例"));
  assert.ok(html.includes('{&quot;code&quot;:0}'));
});

test("描述 Markdown 渲染：标题/加粗/行内码/列表/代码块", () => {
  const html = exportDocSiteHtml(snapshotWith([{ id: "c1", name: "C", items: [loginRequest()] }]));
  assert.ok(html.includes("<h3>详细说明</h3>"));
  assert.ok(html.includes("<code>Bearer</code>"));
  assert.ok(html.includes("<strong>重试</strong>"));
  assert.ok(html.includes("<ul><li>参数一</li><li>参数二</li></ul>"));
  assert.ok(html.includes("<pre><code>{&quot;a&quot;:1}</code></pre>"));
});

test("HTML 转义：接口名/描述中的尖括号不产生标签", () => {
  const request = loginRequest();
  request.name = "<script>alert(1)</script>";
  request.doc.description = "安全说明：<img src=x onerror=alert(1)>";
  const html = exportDocSiteHtml(snapshotWith([{ id: "c1", name: "C", items: [request] }]));
  assert.ok(!html.includes("<script>alert(1)"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("空工作区给出空态提示", () => {
  const html = exportDocSiteHtml(emptySnapshot());
  assert.ok(html.includes("工作区还没有接口"));
});
