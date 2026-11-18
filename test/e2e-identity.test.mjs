/**
 * 端到端：身份集成 + 审计留存 + 供应链产物的协议契约。
 *
 * 这里起一个本地 HTTP 服务，同时扮演 OIDC IdP（discovery / authorize / JWKS /
 * 签名 id_token）与 Reqora 协作后端（SSO 端点 / SCIM / 审计 / PAT / LDAP /
 * 可信头），然后用生产模块 src/lib/identity.ts 的客户端函数把整条链路跑完。
 * 断言覆盖：PKCE S256、state 一次性、JWKS 验签、nonce/iss/aud/exp、SCIM
 * 软停用、审计哈希链、先归档后清理、法务保全、PAT 与 LDAP 登录。
 *
 * 边界：这是协议契约级 E2E，不启动 MySQL / Spring；真实后端由 JUnit 单测与
 * server/scripts/smoke*.mjs（需真实 MySQL）覆盖。若配置了 REQORA_E2E_BASE_URL，
 * node server/scripts/e2e-identity.mjs 可对真实部署跑同一套契约。
 */
import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import {
  SUPPORTED_LOGIN_METHODS,
  buildAuthorizationUrl,
  completeOidcLogin,
  fetchAuditExport,
  fetchAuditPolicy,
  fetchProviders,
  generatePkcePair,
  parseAuthorizationCallback,
  planAuditRetention,
  scimDeactivatePayload,
  scimUserPayload,
  startOidcLogin,
} from "../src/lib/identity.ts";

// ------------------------------------------------------------------ mock harness ----

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "e2e-key-1", alg: "RS256", use: "sig" };
const SCIM_TOKEN = "e2e-scim-token";
const SCIM_HASH = sha256(SCIM_TOKEN);
const HEADER_SECRET = "e2e-header-secret-0123456789";
const ISSUER = () => `${baseUrl}/idp`;

let server;
let baseUrl;
let idpCalls = 0;

const sessions = new Map(); // state -> { providerId, nonce, verifier, challenge, redirectUri, used, expiresAt }
const codes = new Map(); // code -> { state, challenge, nonce }
const scimUsers = new Map();
const auditRows = [];
let auditSeq = 0;
let nextUserId = 1;
let lastHash = "0".repeat(64);

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function envelope(data, code = 0, message = "ok", status = 200) {
  return { status, body: { code, message, data, requestId: "e2e", timestamp: Date.now() } };
}

function send(res, payload, contentType = "application/json") {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.writeHead(payload.status ?? 200, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(typeof payload === "string" ? body : JSON.stringify(payload.body));
}

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function fail(res, status, message, scim = false) {
  if (scim) {
    json(res, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: String(status),
      scimType: "invalidValue",
      detail: message,
    }, status);
  } else {
    json(res, envelope(null, 1002, message, status).body, status);
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req) {
  const text = await readBody(req);
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function tokenResponse(user = "e2euser") {
  return {
    accessToken: "e2e-access-" + randomBytes(8).toString("hex"),
    refreshToken: "e2e-refresh-" + randomBytes(8).toString("hex"),
    tokenType: "Bearer",
    expiresIn: 900,
    user: { id: 1, username: user, email: "e2e@example.com", status: 1, roles: ["USER"] },
  };
}

function canonicalAudit(row) {
  return [
    row.prevHash, row.action, String(row.actorId), row.actorName, row.targetType,
    row.targetId, row.detail, row.requestId, row.ip, row.createdAt, row.provider,
  ].join("|");
}

function recordAudit(action, detail, provider = "local", createdAt = new Date().toISOString()) {
  const row = {
    id: ++auditSeq,
    action,
    actorId: 1,
    actorName: "e2e",
    actorType: action.startsWith("audit.retention") ? "system" : "user",
    provider,
    targetType: "user",
    targetId: "1",
    detail,
    requestId: "e2e-request",
    ip: "127.0.0.1",
    prevHash: lastHash,
    legalHold: 0,
    createdAt,
  };
  row.entryHash = sha256(canonicalAudit(row));
  lastHash = row.entryHash;
  auditRows.push(row);
  return row;
}

function scimResource(user) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: String(user.id),
    userName: user.userName,
    externalId: user.externalId,
    displayName: user.displayName,
    emails: [{ value: user.email, type: "work", primary: true }],
    active: user.active,
    meta: { resourceType: "User", location: `/scim/v2/Users/${user.id}` },
  };
}

function requireScim(req, res) {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ") || sha256(header.slice(7).trim()) !== SCIM_HASH) {
    fail(res, 401, "SCIM Bearer token 无效", true);
    return false;
  }
  return true;
}

async function handle(req, res) {
  const url = new URL(req.url, baseUrl);
  const path = url.pathname;
  const method = req.method;

  // ---- capability discovery ----
  if (path === "/api/v1/auth/providers" && method === "GET") {
    return json(res, envelope({
      enabled: true,
      methods: [
        { id: "local", type: "local", label: "本地账号口令", startPath: "/api/v1/auth/login" },
        { id: "okta", type: "oidc", label: "OIDC · Okta", startPath: "/api/v1/auth/sso/oidc/start" },
        { id: "entra", type: "saml", label: "SAML · Entra", startPath: "/api/v1/auth/sso/saml/entra/start" },
        { id: "ldap", type: "ldap", label: "LDAP / AD", startPath: "/api/v1/auth/sso/ldap" },
        { id: "header", type: "header", label: "反向代理可信头", startPath: "/api/v1/auth/sso/header" },
        { id: "pat", type: "pat", label: "个人访问令牌", startPath: "/api/v1/auth/pat/exchange" },
      ],
      scim: true,
      pat: true,
      jitProvisioning: true,
      linkByEmail: true,
    }).body);
  }

  // ---- OIDC start / callback ----
  if (path === "/api/v1/auth/sso/oidc/start" && method === "POST") {
    const body = await readJson(req);
    if (!body.providerId) return fail(res, 400, "providerId 必填");
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(16));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const redirectUri = body.redirectUri ?? `${baseUrl}/sso/callback.html`;
    sessions.set(state, {
      providerId: body.providerId,
      nonce,
      verifier,
      challenge,
      redirectUri,
      used: false,
      expiresAt: Date.now() + 300000,
    });
    const authorizationUrl = `${baseUrl}/idp/authorize?` + new URLSearchParams({
      client_id: "reqora-e2e",
      response_type: "code",
      scope: "openid profile email",
      redirect_uri: redirectUri,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    recordAudit("auth.sso.start", `启动 OIDC 登录 provider=${body.providerId}`, "oidc");
    return json(res, envelope({
      authorizationUrl,
      state,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      requestId: null,
    }).body);
  }

  if (path === "/idp/authorize" && method === "GET") {
    idpCalls++;
    const state = url.searchParams.get("state");
    const session = sessions.get(state);
    if (!session || session.used) return fail(res, 400, "未知 state");
    if (url.searchParams.get("code_challenge_method") !== "S256"
        || url.searchParams.get("code_challenge") !== session.challenge) {
      return fail(res, 400, "PKCE challenge 不匹配");
    }
    const code = b64url(randomBytes(18));
    codes.set(code, { state, challenge: session.challenge, nonce: session.nonce });
    const location = `${session.redirectUri}?` + new URLSearchParams({ code, state }).toString();
    res.writeHead(302, { Location: location });
    return res.end();
  }

  if (path === "/sso/callback.html" && method === "GET") {
    return send(res, "<!doctype html><title>SSO callback</title>", "text/html; charset=utf-8");
  }

  if (path === "/api/v1/auth/sso/oidc/callback" && method === "POST") {
    const body = await readJson(req);
    const session = sessions.get(body.state);
    if (!session || session.used || session.expiresAt < Date.now()
        || !body.code || !codes.has(body.code)) {
      return fail(res, 401, "SSO state 无效、已使用或已过期");
    }
    const grant = codes.get(body.code);
    if (grant.state !== body.state) return fail(res, 401, "code 与 state 不匹配");
    if (b64url(createHash("sha256").update(session.verifier).digest()) !== grant.challenge) {
      return fail(res, 401, "PKCE verifier 校验失败");
    }
    session.used = true;
    codes.delete(body.code);
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid }));
    const payload = b64url(JSON.stringify({
      iss: ISSUER(),
      aud: "reqora-e2e",
      sub: "e2e-subject-1",
      iat: now,
      exp: now + 300,
      nonce: session.nonce,
      preferred_username: "e2euser",
      email: "e2e@example.com",
      name: "E2E User",
      groups: ["developers"],
    }));
    const signingInput = `${header}.${payload}`;
    const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
    recordAudit("auth.sso.oidc", "OIDC 登录成功", "oidc");
    return json(res, envelope({
      ...tokenResponse(),
      // 测试专用自省字段：真实后端不返回 id_token（验签在服务端完成）。
      idToken: `${signingInput}.${signature}`,
      nonce: session.nonce,
    }).body);
  }

  if (path === "/idp/.well-known/openid-configuration" && method === "GET") {
    return json(res, {
      issuer: ISSUER(),
      authorization_endpoint: `${baseUrl}/idp/authorize`,
      token_endpoint: `${baseUrl}/idp/token`,
      jwks_uri: `${baseUrl}/idp/jwks`,
      userinfo_endpoint: `${baseUrl}/idp/userinfo`,
      id_token_signing_alg_values_supported: ["RS256"],
    });
  }

  if (path === "/idp/jwks" && method === "GET") {
    return json(res, { keys: [jwk] });
  }

  // ---- other login methods ----
  if (path === "/api/v1/auth/sso/ldap" && method === "POST") {
    const body = await readJson(req);
    if (body.username !== "e2euser" || body.password !== "e2e-password") {
      return fail(res, 401, "LDAP 绑定失败");
    }
    recordAudit("auth.sso.ldap", "LDAP 绑定成功", "ldap");
    return json(res, envelope(tokenResponse()).body);
  }

  if (path === "/api/v1/auth/pat/exchange" && method === "POST") {
    const body = await readJson(req);
    if (body.token !== "rq_pat_e2e") return fail(res, 401, "PAT 无效");
    recordAudit("auth.pat.exchange", "PAT 换取访问令牌", "pat");
    return json(res, envelope(tokenResponse()).body);
  }

  if (path === "/api/v1/auth/sso/header" && method === "GET") {
    const user = req.headers["x-forwarded-user"] ?? "";
    const timestamp = req.headers["x-forwarded-timestamp"] ?? "";
    const signature = req.headers["x-forwarded-signature"] ?? "";
    const expected = createHash("sha256")
      .update(HEADER_SECRET + "|" + timestamp + "|" + user)
      .digest("hex");
    if (!user || !timestamp || signature !== expected
        || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
      return fail(res, 401, "可信头签名校验失败");
    }
    recordAudit("auth.sso.header", "可信代理头换取本地令牌", "header");
    return json(res, envelope(tokenResponse(user)).body);
  }

  // ---- SCIM ----
  if (path === "/scim/v2/ServiceProviderConfig" && method === "GET") {
    if (!requireScim(req, res)) return;
    return json(res, {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 100 },
      etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken", name: "SCIM Bearer", primary: true }],
    }, 200);
  }

  if (path === "/scim/v2/Users" && method === "POST") {
    if (!requireScim(req, res)) return;
    const body = await readJson(req);
    if (!body.userName) return fail(res, 400, "userName 必填", true);
    if ([...scimUsers.values()].some((u) => u.userName === body.userName)) {
      return fail(res, 409, "userName 已存在", true);
    }
    const user = {
      id: nextUserId++,
      userName: body.userName,
      externalId: body.externalId ?? null,
      displayName: body.displayName ?? body.userName,
      email: body.emails?.[0]?.value ?? `${body.userName}@scim.local`,
      active: body.active ?? true,
    };
    scimUsers.set(user.id, user);
    recordAudit("scim.user.create", `SCIM 创建用户 ${user.userName}`, "scim");
    return json(res, scimResource(user), 201);
  }

  if (path === "/scim/v2/Users" && method === "GET") {
    if (!requireScim(req, res)) return;
    const filter = url.searchParams.get("filter");
    let found = [...scimUsers.values()];
    if (filter) {
      const match = /^\s*userName\s+eq\s+"([^"]*)"\s*$/i.exec(filter);
      if (match) found = found.filter((u) => u.userName === match[1]);
    }
    return json(res, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: found.length,
      startIndex: 1,
      itemsPerPage: found.length,
      Resources: found.map(scimResource),
    });
  }

  const userMatch = /^\/scim\/v2\/Users\/(\d+)$/.exec(path);
  if (userMatch) {
    if (!requireScim(req, res)) return;
    const user = scimUsers.get(Number(userMatch[1]));
    if (!user) return fail(res, 404, "User 不存在", true);
    if (method === "GET") return json(res, scimResource(user));
    if (method === "PATCH") {
      const body = await readJson(req);
      for (const op of body.Operations ?? []) {
        if (op.path === "active" && (op.op === "replace" || op.op === "add")) {
          user.active = Boolean(op.value);
        } else if (op.path === "displayName") {
          user.displayName = String(op.value);
        }
      }
      recordAudit("scim.user.patch", `SCIM 增量更新用户 ${user.userName}`, "scim");
      return json(res, scimResource(user));
    }
    if (method === "DELETE") {
      user.active = false; // 软停用，不删除
      recordAudit("scim.user.deactivate", `SCIM 软停用用户 ${user.userName}`, "scim");
      res.writeHead(204);
      return res.end();
    }
  }

  // ---- audit retention / export / chain ----
  if (path === "/api/v1/audit/retention" && method === "GET") {
    return json(res, envelope({
      retentionDays: 180,
      purgeEnabled: true,
      archiveEnabled: true,
      archiveDir: "./data/audit-archive",
      purgeBatchSize: 1000,
      legalHold: false,
      hashChain: true,
      purgeCron: "0 15 3 * * *",
      exportMaxRows: 50000,
      archiveCount: 0,
      archivedRows: 0,
    }).body);
  }

  if (path === "/api/v1/audit/export" && method === "GET") {
    const format = url.searchParams.get("format") ?? "jsonl";
    if (format === "csv") {
      const header = "id,createdAt,action,provider,prevHash,entryHash,legalHold\n";
      const lines = auditRows.map((r) => `${r.id},${r.createdAt},${r.action},${r.provider},${r.prevHash},${r.entryHash},${r.legalHold}`);
      return send(res, header + lines.join("\n") + "\n", "text/csv; charset=utf-8");
    }
    return send(res, auditRows.map((r) => JSON.stringify(r)).join("\n") + "\n", "application/x-ndjson");
  }

  if (path === "/api/v1/audit/chain/verify" && method === "GET") {
    let previous = null;
    let checked = 0;
    let firstBreak = null;
    for (const row of auditRows) {
      if (previous && row.prevHash !== previous && firstBreak === null) firstBreak = row.id;
      if (sha256(canonicalAudit(row)) !== row.entryHash && firstBreak === null) firstBreak = row.id;
      previous = row.entryHash;
      checked++;
    }
    return json(res, envelope({ checked, legacyRows: 0, intact: firstBreak === null, firstBreakId: firstBreak }).body);
  }

  if (path === "/api/v1/audit/retention/run" && method === "POST") {
    const policy = await readJson(req);
    const cutoff = Date.now() - 180 * 86400000;
    const purgeable = auditRows.filter(
      (r) => new Date(r.createdAt).getTime() < cutoff && r.legalHold !== 1,
    );
    if (policy.legalHold) {
      return json(res, envelope({ executed: false, reason: "legal hold", archivedRows: 0, deletedRows: 0, archives: [] }).body);
    }
    let deleted = 0;
    for (const row of purgeable) {
      const index = auditRows.findIndex((r) => r.id === row.id);
      if (index >= 0) {
        auditRows.splice(index, 1);
        deleted++;
      }
    }
    recordAudit("audit.retention.purge", `归档 ${deleted} 行、删除 ${deleted} 行`, "local");
    return json(res, envelope({
      executed: true,
      reason: "ok",
      batches: deleted > 0 ? 1 : 0,
      archivedRows: deleted,
      deletedRows: deleted,
      archives: deleted > 0 ? ["e2e-archive.jsonl"] : [],
    }).body);
  }

  return fail(res, 404, `未知端点 ${method} ${path}`);
}

before(async () => {
  server = createServer((req, res) => {
    handle(req, res).catch((error) => fail(res, 500, String(error?.message ?? error)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// ---------------------------------------------------------------------- test cases ----

test("PKCE S256 与授权 URL 构造符合 RFC 7636", async () => {
  const { verifier, challenge } = await generatePkcePair();
  assert.match(verifier, /^[A-Za-z0-9._~-]{43}$/);
  assert.equal(challenge, b64url(createHash("sha256").update(verifier).digest()));
  const url = new URL(buildAuthorizationUrl(`${baseUrl}/idp/authorize`, {
    clientId: "reqora-e2e",
    redirectUri: `${baseUrl}/sso/callback.html`,
    state: "state-1",
    nonce: "nonce-1",
    codeChallenge: challenge,
  }));
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.throws(
    () => parseAuthorizationCallback(`${baseUrl}/sso/callback.html?code=x&state=attacker`, "state-1"),
    /state 不匹配/,
  );
});

test("E2E: 能力发现 → OIDC 授权码+PKCE → 回调 → 本地 JWT", async () => {
  const capabilities = await fetchProviders(baseUrl);
  assert.equal(capabilities.enabled, true);
  assert.deepEqual(
    capabilities.methods.map((m) => m.type),
    ["local", "oidc", "saml", "ldap", "header", "pat"],
  );
  assert.equal(capabilities.scim, true);
  assert.equal(capabilities.pat, true);
  assert.equal(SUPPORTED_LOGIN_METHODS.length, 7);

  const start = await startOidcLogin(baseUrl, "okta", `${baseUrl}/sso/callback.html`);
  assert.match(start.state, /^[A-Za-z0-9_-]+$/);
  assert.match(start.authorizationUrl, /code_challenge_method=S256/);

  const authorization = await fetch(start.authorizationUrl, { redirect: "manual" });
  assert.equal(authorization.status, 302);
  const callbackUrl = authorization.headers.get("location");
  assert.ok(callbackUrl, "IdP 应返回重定向 Location");
  const parsed = parseAuthorizationCallback(callbackUrl, start.state);
  assert.equal(parsed.state, start.state);
  assert.ok(parsed.code);

  const tokens = await completeOidcLogin(baseUrl, {
    providerId: "okta",
    code: parsed.code,
    state: start.state,
    redirectUri: `${baseUrl}/sso/callback.html`,
  });
  assert.equal(tokens.tokenType, "Bearer");
  assert.ok(tokens.accessToken.startsWith("e2e-access-"));
  assert.equal(tokens.expiresIn, 900);

  // 用 discovery/JWKS 独立验签，并核对 iss/aud/exp/nonce（服务端职责的可复核镜像）。
  const discovery = await (await fetch(`${baseUrl}/idp/.well-known/openid-configuration`)).json();
  assert.equal(discovery.issuer, `${baseUrl}/idp`);
  assert.equal(discovery.id_token_signing_alg_values_supported[0], "RS256");
  const jwks = await (await fetch(discovery.jwks_uri)).json();
  const key = createPublicKey({ key: jwks.keys[0], format: "jwk" });
  const [header, payload, signature] = tokens.idToken.split(".");
  assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).alg, "RS256");
  assert.equal(
    verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, "base64url")),
    true,
  );
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(claims.iss, discovery.issuer);
  assert.equal(claims.aud, "reqora-e2e");
  assert.equal(claims.nonce, tokens.nonce);
  assert.equal(claims.sub, "e2e-subject-1");
  assert.ok(claims.exp > Math.floor(Date.now() / 1000));

  // 重放同一 state/code 必须失败（一次性会话）。
  const replay = await fetch(`${baseUrl}/api/v1/auth/sso/oidc/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: "okta", code: parsed.code, state: start.state }),
  });
  assert.equal(replay.status, 401);
  assert.ok(idpCalls >= 1);
});

test("E2E: SCIM 供给 → 软停用 → 审计哈希链与导出", async () => {
  const config = await (await fetch(`${baseUrl}/scim/v2/ServiceProviderConfig`, {
    headers: { Authorization: `Bearer ${SCIM_TOKEN}` },
  })).json();
  assert.equal(config.patch.supported, true);
  assert.equal(config.bulk.supported, false);
  assert.equal(config.etag.supported, false);

  const created = await fetch(`${baseUrl}/scim/v2/Users`, {
    method: "POST",
    headers: { "Content-Type": "application/scim+json", Authorization: `Bearer ${SCIM_TOKEN}` },
    body: JSON.stringify(scimUserPayload({
      userName: "alice", email: "alice@example.com", displayName: "Alice", externalId: "idp-alice",
    })),
  });
  assert.equal(created.status, 201);
  const user = await created.json();
  assert.equal(user.active, true);
  assert.equal(user.emails[0].value, "alice@example.com");

  const patched = await fetch(`${baseUrl}/scim/v2/Users/${user.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/scim+json", Authorization: `Bearer ${SCIM_TOKEN}` },
    body: JSON.stringify(scimDeactivatePayload()),
  });
  const disabled = await patched.json();
  assert.equal(disabled.active, false, "SCIM active=false 必须软停用而非删除账号");

  const stillThere = await (await fetch(`${baseUrl}/scim/v2/Users/${user.id}`, {
    headers: { Authorization: `Bearer ${SCIM_TOKEN}` },
  })).json();
  assert.equal(stillThere.id, user.id);

  // 无 token / 错 token 一律 401。
  assert.equal((await fetch(`${baseUrl}/scim/v2/ServiceProviderConfig`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/scim/v2/ServiceProviderConfig`, {
    headers: { Authorization: "Bearer wrong" },
  })).status, 401);

  const chain = await (await fetch(`${baseUrl}/api/v1/audit/chain/verify`)).json();
  assert.equal(chain.data.intact, true);
  assert.ok(chain.data.checked >= 3);

  const jsonl = await fetchAuditExport(baseUrl, "e2e-access", "jsonl");
  const rows = jsonl.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(rows.some((r) => r.action === "scim.user.create"));
  assert.ok(rows.some((r) => r.action === "scim.user.patch"));
  assert.ok(rows.every((r) => typeof r.entryHash === "string" && r.entryHash.length === 64));

  const csv = await fetchAuditExport(baseUrl, "e2e-access", "csv");
  assert.match(csv.split("\n")[0], /prevHash,entryHash,legalHold/);
});

test("E2E: 审计留存 = 先归档后清理 + 逐行 legal hold", async () => {
  const policy = await fetchAuditPolicy(baseUrl, "e2e-access");
  assert.equal(policy.retentionDays, 180);
  assert.equal(policy.archiveEnabled, true);
  assert.equal(policy.hashChain, true);

  const now = new Date("2026-11-14T00:00:00.000Z");
  const old = new Date(now.getTime() - 400 * 86400000).toISOString();
  const recent = new Date(now.getTime() - 3 * 86400000).toISOString();
  const rows = [
    { id: 1, createdAt: old, legalHold: 0, action: "auth.login" },
    { id: 2, createdAt: old, legalHold: 1, action: "auth.sso.oidc" },
    { id: 3, createdAt: recent, legalHold: 0, action: "scim.user.create" },
  ];
  const plan = planAuditRetention(rows, policy, now);
  assert.deepEqual(plan.purgeable.map((r) => r.id), [1]);
  assert.deepEqual(plan.retained.map((r) => r.id), [2, 3]);
  assert.deepEqual(plan.archived.map((r) => r.id), [1], "清理前必须归档");
  assert.equal(rows.length, 3, "计划函数不得修改输入");

  const held = planAuditRetention(rows, { ...policy, legalHold: true }, now);
  assert.equal(held.purgeable.length, 0);
  assert.match(held.reason, /legal hold/);
  const disabled = planAuditRetention(rows, { ...policy, retentionDays: 0 }, now);
  assert.equal(disabled.purgeable.length, 0);
  const noArchive = planAuditRetention(rows, { ...policy, archiveEnabled: false }, now);
  assert.equal(noArchive.archived.length, 0);
  assert.equal(noArchive.purgeable.length, 1);

  // 真实端点：塞入一条过期行与一条法务保全行，跑清理后核对结果。
  recordAudit("auth.login.old", "400 天前的登录", "local", old);
  const holdRow = recordAudit("auth.sso.old", "400 天前但需保全", "oidc", old);
  holdRow.legalHold = 1;
  const run = await (await fetch(`${baseUrl}/api/v1/audit/retention/run`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  })).json();
  assert.equal(run.data.executed, true);
  assert.equal(run.data.archivedRows >= 1, true);
  assert.equal(run.data.deletedRows, run.data.archivedRows, "归档数必须等于删除数");

  const exported = await fetchAuditExport(baseUrl, "e2e-access", "jsonl");
  const remaining = exported.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(!remaining.some((r) => r.action === "auth.login.old"), "过期行应被清理");
  assert.ok(remaining.some((r) => r.action === "auth.sso.old"), "legal hold 行必须保留");
});

test("E2E: PAT / LDAP / 可信头登录与失败路径", async () => {
  const pat = await (await fetch(`${baseUrl}/api/v1/auth/pat/exchange`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "rq_pat_e2e" }),
  })).json();
  assert.equal(pat.code, 0);
  assert.ok(pat.data.accessToken);

  const badPat = await fetch(`${baseUrl}/api/v1/auth/pat/exchange`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "wrong" }),
  });
  assert.equal(badPat.status, 401);

  const ldap = await (await fetch(`${baseUrl}/api/v1/auth/sso/ldap`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "e2euser", password: "e2e-password" }),
  })).json();
  assert.equal(ldap.code, 0);
  assert.ok(ldap.data.refreshToken);

  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHash("sha256")
    .update(HEADER_SECRET + "|" + timestamp + "|proxyuser").digest("hex");
  const headerSso = await (await fetch(`${baseUrl}/api/v1/auth/sso/header`, {
    headers: {
      "X-Forwarded-User": "proxyuser",
      "X-Forwarded-Timestamp": timestamp,
      "X-Forwarded-Signature": signature,
    },
  })).json();
  assert.equal(headerSso.code, 0);
  assert.equal(headerSso.data.user.username, "proxyuser");

  const forged = await fetch(`${baseUrl}/api/v1/auth/sso/header`, {
    headers: {
      "X-Forwarded-User": "proxyuser",
      "X-Forwarded-Timestamp": timestamp,
      "X-Forwarded-Signature": "deadbeef",
    },
  });
  assert.equal(forged.status, 401);
});
