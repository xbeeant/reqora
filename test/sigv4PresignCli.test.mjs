// CLI / MCP 的 Node fetch 兜底路径：awsSigV4 + signQuery 必须真正预签名。
// Rust engine 路径有自己的预签名实现（service/auth.rs），这里只覆盖 JS 兜底。
// 凭据全部是运行时拼接的假值，断言失败文案不回显任何值。

import test from "node:test";
import assert from "node:assert/strict";

import { applyAuthQueryAsync } from "../bin/requester.mjs";
import { applyAuthHeaders } from "../src/lib/authProviders.ts";

const URL_BASE = "https://example.test/bucket/key";
const fakeKeyId = "AKIA" + "0".repeat(16);
const fakeSecret = "s".repeat(32);

const presignAuth = () => ({
  type: "awsSigV4",
  accessKeyId: fakeKeyId,
  secretAccessKey: fakeSecret,
  region: "us-east-1",
  service: "s3",
  signQuery: true,
  expiresIn: 3600,
  unsignedPayload: false,
});

const context = { method: "GET", body: "", headers: {} };

test("awsSigV4 + signQuery：产出完整的 X-Amz-* 预签名参数", async () => {
  const url = await applyAuthQueryAsync(presignAuth(), URL_BASE, context);
  const q = new URL(url).searchParams;
  assert.match(q.get("X-Amz-Signature") ?? "", /^[0-9a-f]{64}$/, "签名应为 64 位 hex");
  assert.equal(q.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.match(q.get("X-Amz-Credential") ?? "", /us-east-1\/s3/);
  assert.ok(q.get("X-Amz-Date"), "缺少 X-Amz-Date");
  assert.equal(q.get("X-Amz-Expires"), "3600");
  assert.ok(q.get("X-Amz-SignedHeaders"), "缺少 X-Amz-SignedHeaders");
});

test("预签名不重复追加同名参数，并保留业务 query", async () => {
  const withQuery = `${URL_BASE}?prefix=a&X-Amz-Signature=stale`;
  const url = await applyAuthQueryAsync(presignAuth(), withQuery, context);
  const q = new URL(url).searchParams;
  assert.equal(q.get("prefix"), "a");
  assert.equal(q.getAll("X-Amz-Signature").length, 1, "同名参数被重复追加");
  assert.notEqual(q.get("X-Amz-Signature"), "stale", "旧的签名值未被替换");
  assert.match(q.get("X-Amz-Signature") ?? "", /^[0-9a-f]{64}$/);
});

test("signQuery:false：query 不含 X-Amz-*，改由 header 签名", async () => {
  const auth = { ...presignAuth(), signQuery: false };
  const url = await applyAuthQueryAsync(auth, URL_BASE, context);
  assert.equal(new URL(url).searchParams.get("X-Amz-Signature"), null);
  const headers = await applyAuthHeaders(auth, {}, { url, method: "GET", body: "" });
  const authorization = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === "authorization",
  )?.[1];
  assert.match(String(authorization ?? ""), /^AWS4-HMAC-SHA256 /);
});

test("signQuery:true：header 侧不重复加 Authorization（避免双重签名）", async () => {
  const url = await applyAuthQueryAsync(presignAuth(), URL_BASE, context);
  const headers = await applyAuthHeaders(presignAuth(), {}, { url, method: "GET", body: "" });
  const hasAuthorization = Object.keys(headers ?? {}).some(
    (key) => key.toLowerCase() === "authorization",
  );
  assert.equal(hasAuthorization, false);
});

test("非预签名认证仍委托同步 applyAuthQuery（apiKey in query）", async () => {
  const auth = { type: "apiKey", key: "k", value: "v", location: "query" };
  const url = await applyAuthQueryAsync(auth, URL_BASE, context);
  assert.equal(new URL(url).searchParams.get("k"), "v");
  assert.equal(new URL(url).searchParams.get("X-Amz-Signature"), null);
});
