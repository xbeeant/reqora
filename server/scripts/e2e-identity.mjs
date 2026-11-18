#!/usr/bin/env node
/**
 * 可选：对真实运行的 Reqora 协作后端跑身份/审计契约冒烟。
 *
 * 与 test/e2e-identity.test.mjs（本地 mock IdP + mock 后端）互补：这里不 mock
 * 任何东西，直接打真实 Spring Boot + MySQL 部署，验证端点形状与审计留存配置。
 * 需要后端已启动并按 docs/IDENTITY_AND_AUDIT.md 配好环境变量。
 *
 * 用法：
 *   REQORA_E2E_BASE_URL=http://127.0.0.1:8080 \
 *   REQORA_E2E_TOKEN=<登录态 JWT> \
 *   node server/scripts/e2e-identity.mjs
 *
 * 可选：REQORA_E2E_PAT（PAT 换发检查）、REQORA_E2E_SCIM_TOKEN（SCIM 端点检查）。
 * 未设置 REQORA_E2E_BASE_URL 时跳过并以 0 退出，便于 CI 无条件调用。
 */
import assert from "node:assert/strict";

const base = process.env.REQORA_E2E_BASE_URL?.replace(/\/+$/, "");
if (!base) {
  console.log("[e2e-identity] REQORA_E2E_BASE_URL 未设置，跳过真实后端契约检查。");
  console.log("[e2e-identity] 协议契约级 E2E 请跑：node --test test/e2e-identity.test.mjs");
  process.exit(0);
}

const token = process.env.REQORA_E2E_TOKEN ?? "";
const pat = process.env.REQORA_E2E_PAT ?? "";
const scimToken = process.env.REQORA_E2E_SCIM_TOKEN ?? "";
const results = [];

function endpoint(path) {
  return base + path;
}

async function call(path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(endpoint(path), {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ok  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.error(`  FAIL ${name}: ${error.message}`);
  }
}

console.log(`[e2e-identity] 目标 ${base}`);

const ready = await call("/ready");
check("健康检查 /ready", () => assert.equal(ready.status, 200));

const providers = await call("/api/v1/auth/providers");
check("能力发现端点返回标准 envelope", () => {
  assert.equal(providers.status, 200);
  assert.equal(providers.body.code, 0);
  assert.ok(Array.isArray(providers.body.data.methods));
  assert.ok(providers.body.data.methods.some((m) => m.type === "local"));
});
console.log(`[e2e-identity] 已启用登录方式：${(providers.body?.data?.methods ?? []).map((m) => m.type).join(", ")}`);

const unauthScim = await call("/scim/v2/ServiceProviderConfig");
check("SCIM 端点在无 Bearer token 时被拒绝", () => {
  assert.ok([401, 404].includes(unauthScim.status),
    `期望 401（已启用）或 404（未启用），实际 ${unauthScim.status}`);
});

if (scimToken) {
  const config = await call("/scim/v2/ServiceProviderConfig", {
    headers: { Authorization: `Bearer ${scimToken}` },
  });
  check("SCIM ServiceProviderConfig 可被合法 token 读取", () => {
    assert.equal(config.status, 200);
    assert.equal(config.body.bulk.supported, false);
    assert.equal(config.body.etag.supported, false);
  });
}

if (token) {
  const policy = await call("/api/v1/audit/retention", {
    headers: { Authorization: `Bearer ${token}` },
  });
  check("审计留存策略端点", () => {
    assert.equal(policy.status, 200);
    assert.equal(policy.body.code, 0);
    assert.equal(typeof policy.body.data.retentionDays, "number");
    assert.equal(typeof policy.body.data.legalHold, "boolean");
    assert.equal(typeof policy.body.data.hashChain, "boolean");
  });

  const exportResult = await call("/api/v1/audit/export?format=jsonl&limit=200", {
    headers: { Authorization: `Bearer ${token}` },
  });
  check("审计 JSONL 导出行结构", () => {
    assert.equal(exportResult.status, 200);
    const lines = String(exportResult.body).trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const row = JSON.parse(line);
      assert.ok("action" in row && "createdAt" in row, "导出行缺少 action/createdAt");
    }
  });

  const chain = await call("/api/v1/audit/chain/verify", {
    headers: { Authorization: `Bearer ${token}` },
  });
  check("审计哈希链核验端点", () => {
    assert.equal(chain.status, 200);
    assert.equal(typeof chain.body.data.intact, "boolean");
    assert.equal(typeof chain.body.data.checked, "number");
  });
} else {
  console.log("  skip 需要 REQORA_E2E_TOKEN 的审计端点检查");
}

if (pat) {
  const exchanged = await call("/api/v1/auth/pat/exchange", {
    method: "POST",
    body: { token: pat },
  });
  check("PAT 换发本地 JWT", () => {
    assert.equal(exchanged.status, 200);
    assert.equal(exchanged.body.code, 0);
    assert.ok(exchanged.body.data.accessToken);
  });
} else {
  console.log("  skip 需要 REQORA_E2E_PAT 的 PAT 换发检查");
}

const failed = results.filter((r) => !r.ok);
console.log(`[e2e-identity] ${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.error(JSON.stringify(failed, null, 2));
  process.exit(1);
}
