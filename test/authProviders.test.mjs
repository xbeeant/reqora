import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import {
  AUTH_SECRET_FIELDS,
  applyAuthHeaders,
  applyAuthQuery,
  authLabel,
  authSummary,
  buildAuthorizeUrl,
  canonicalRequest,
  defaultAuth,
  generatePkcePair,
  isSecretAuthField,
  mergeOAuth2Token,
  normalizeAuth,
  normalizeMtls,
  oauth2TokenRequest,
  parseTokenResponse,
  sha256Hex,
  signAwsSigV4,
  tokenNeedsRefresh,
  validateAuth,
} from "../src/lib/authProviders.ts";

/* 全部使用明显伪造、无害的测试值，避免看起来像真实凭证。 */
const CERT = "PEM BEGIN CERTIFICATE\nCERTBODY\nEND CERTIFICATE PEM";
const KEY = "PEM BEGIN PRIVATE KEY\nKEYBODY\nEND PRIVATE KEY PEM";
const CA = "PEM BEGIN CERTIFICATE\nCABODY\nEND CERTIFICATE PEM";
const NO_LEAK = "DO_NOT_LEAK_zzz";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/* AWS 文档「Example: GET Object」的规范请求（硬编码）。 */
const AWS_GET_OBJECT_CANONICAL = [
  "GET",
  "/test.txt",
  "",
  "host:examplebucket.s3.amazonaws.com",
  "range:bytes=0-9",
  `x-amz-content-sha256:${EMPTY_SHA256}`,
  "x-amz-date:20130524T000000Z",
  "",
  "host;range;x-amz-content-sha256;x-amz-date",
  EMPTY_SHA256,
].join("\n");

const SIGV4_BASE = {
  method: "GET",
  url: "https://examplebucket.s3.amazonaws.com/test.txt",
  headers: { Range: "bytes=0-9" },
  accessKeyId: "my-access-key-id",
  secretAccessKey: "my-secret-key",
  region: "us-east-1",
  service: "s3",
  timestamp: new Date("2013-05-24T00:00:00Z"),
};

function independentHmacChain(secret, shortDate, region, service, stringToSign) {
  const kDate = createHmac("sha256", "AWS4" + secret).update(shortDate).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update(service).digest();
  const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
  return createHmac("sha256", kSigning).update(stringToSign).digest("hex");
}

/* -------------------------------------------------------------------------- */

test("sha256Hex 与 node:crypto 一致（含空串与 Uint8Array）", async () => {
  assert.equal(await sha256Hex(""), EMPTY_SHA256);
  assert.equal(await sha256Hex("abc"), createHash("sha256").update("abc").digest("hex"));
  const bytes = new Uint8Array([1, 2, 3, 255, 0, 127]);
  assert.equal(await sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"));
  assert.equal(await sha256Hex("你好 SigV4"), createHash("sha256").update("你好 SigV4").digest("hex"));
});

test("generatePkcePair 的 verifier/challenge 满足 S256 与 base64url 规范", async () => {
  const { verifier, challenge, method } = await generatePkcePair();
  assert.equal(method, "S256");
  assert.ok(verifier.length >= 43 && verifier.length <= 128, `verifier 长度 ${verifier.length}`);
  assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);
  assert.equal(challenge.length, 43);
  assert.ok(!challenge.includes("="), "challenge 不应有 padding");
  assert.match(challenge, /^[A-Za-z0-9\-_]+$/);
  const expected = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(challenge, expected);
  const second = await generatePkcePair();
  assert.notEqual(second.verifier, verifier, "两次生成应不同");
});

test("buildAuthorizeUrl authorizationCode 带齐参数与 PKCE", () => {
  const auth = {
    type: "oauth2",
    grant: "authorizationCode",
    authUrl: "https://auth.example.com/authorize",
    clientId: "client-1",
    redirectUri: "https://app.example.com/cb",
    scope: "read write",
    audience: "api://default",
  };
  const u = new URL(buildAuthorizeUrl(auth, "state-xyz", "challenge-abc"));
  assert.equal(u.origin + u.pathname, "https://auth.example.com/authorize");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), "client-1");
  assert.equal(u.searchParams.get("redirect_uri"), "https://app.example.com/cb");
  assert.equal(u.searchParams.get("scope"), "read write");
  assert.equal(u.searchParams.get("state"), "state-xyz");
  assert.equal(u.searchParams.get("audience"), "api://default");
  assert.equal(u.searchParams.get("code_challenge"), "challenge-abc");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
});

test("buildAuthorizeUrl implicit 用 response_type=token 且不带 PKCE", () => {
  const auth = {
    type: "oauth2",
    grant: "implicit",
    authUrl: "https://auth.example.com/authorize",
    clientId: "client-1",
    scope: "read",
  };
  const u = new URL(buildAuthorizeUrl(auth, "s1"));
  assert.equal(u.searchParams.get("response_type"), "token");
  assert.equal(u.searchParams.get("state"), "s1");
  assert.equal(u.searchParams.get("client_id"), "client-1");
  assert.equal(u.searchParams.get("code_challenge"), null);
  assert.equal(u.searchParams.get("code_challenge_method"), null);
});

test("parseTokenResponse 处理 expires_in 与默认 tokenType", () => {
  const r = parseTokenResponse({ access_token: "tok", expires_in: 3600 }, 1000);
  assert.equal(r.accessToken, "tok");
  assert.equal(r.tokenType, "Bearer");
  assert.equal(r.expiresAt, 1000 + 3600 * 1000);
  assert.equal(r.refreshToken, undefined);
});

test("parseTokenResponse 容忍 JSON 字符串与 expires_at", () => {
  const payload = JSON.stringify({
    access_token: "tok-a",
    token_type: "MAC",
    expires_at: 1700000000,
    refresh_token: "r-new",
    scope: "read write",
  });
  const r = parseTokenResponse(payload, 1000);
  assert.equal(r.accessToken, "tok-a");
  assert.equal(r.tokenType, "MAC");
  assert.equal(r.refreshToken, "r-new");
  assert.equal(r.scope, "read write");
  assert.equal(r.expiresAt, 1700000000 * 1000);
});

test("parseTokenResponse 缺失 refreshToken 时该字段不出现", () => {
  const r = parseTokenResponse({ access_token: "tok" });
  assert.equal(r.refreshToken, undefined);
  assert.ok(!("refreshToken" in r));
  const r2 = parseTokenResponse("not-json");
  assert.equal(r2.accessToken, "");
  assert.equal(r2.tokenType, "Bearer");
});

test("tokenNeedsRefresh 提前 60s 边界", () => {
  const now = 1_000_000;
  const base = { type: "oauth2", grant: "clientCredentials", accessToken: "tok", refreshToken: "r" };
  assert.equal(tokenNeedsRefresh({ ...base, expiresAt: now + 60000 }, now), true, "恰好 60s 应刷新");
  assert.equal(tokenNeedsRefresh({ ...base, expiresAt: now + 60001 }, now), false, "60s+1ms 不刷新");
  assert.equal(tokenNeedsRefresh({ ...base, expiresAt: now + 60000 }, now, 0), false, "skew=0 时不刷新");
  assert.equal(tokenNeedsRefresh({ ...base, refreshToken: undefined, expiresAt: now + 1 }, now), false, "无 refreshToken 不刷新");
  assert.equal(tokenNeedsRefresh({ ...base, accessToken: undefined }, now), true, "无 accessToken 但可刷新");
});

test("mergeOAuth2Token 合并并保留旧 refreshToken", () => {
  const auth = {
    type: "oauth2", grant: "authorizationCode",
    accessToken: "old", refreshToken: "refresh-old", tokenType: "Bearer", expiresAt: 100,
  };
  const merged = mergeOAuth2Token(auth, { accessToken: "new", tokenType: "MAC", expiresAt: 999 });
  assert.equal(merged.accessToken, "new");
  assert.equal(merged.tokenType, "MAC");
  assert.equal(merged.expiresAt, 999);
  assert.equal(merged.refreshToken, "refresh-old", "新值缺失时保留旧 refreshToken");
  assert.equal(merged.grant, "authorizationCode");
  const merged2 = mergeOAuth2Token(auth, { accessToken: "x", refreshToken: "refresh-new", tokenType: "Bearer" });
  assert.equal(merged2.refreshToken, "refresh-new", "新值存在时覆盖");
});

test("oauth2TokenRequest clientAuth=body 把凭证放进 body", () => {
  const auth = {
    type: "oauth2", grant: "clientCredentials",
    tokenUrl: "https://auth.example.com/token",
    clientId: "client-1", clientSecret: "cs-1", scope: "read", clientAuth: "body",
  };
  const r = oauth2TokenRequest(auth, "clientCredentials");
  assert.equal(r.url, "https://auth.example.com/token");
  assert.equal(r.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(r.headers.Authorization, undefined);
  assert.match(r.body, /grant_type=client_credentials/);
  assert.match(r.body, /client_id=client-1/);
  assert.match(r.body, /client_secret=cs-1/);
  assert.match(r.body, /scope=read/);
});

test("oauth2TokenRequest clientAuth=basic 加 Authorization 且 body 无凭证", () => {
  const auth = {
    type: "oauth2", grant: "clientCredentials",
    tokenUrl: "https://auth.example.com/token",
    clientId: "client-1", clientSecret: "cs-1", clientAuth: "basic",
  };
  const r = oauth2TokenRequest(auth, "clientCredentials");
  assert.ok(r.headers.Authorization.startsWith("Basic "));
  assert.equal(Buffer.from(r.headers.Authorization.slice(6), "base64").toString("utf8"), "client-1:cs-1");
  assert.ok(!r.body.includes("client_secret"));
  assert.ok(!r.body.includes("client_id"));
  assert.match(r.body, /grant_type=client_credentials/);
});

test("canonicalRequest 生成硬编码 AWS 规范 canonical 字符串", () => {
  const c = canonicalRequest(SIGV4_BASE);
  assert.equal(c.canonical, AWS_GET_OBJECT_CANONICAL);
  assert.equal(c.signedHeaders, "host;range;x-amz-content-sha256;x-amz-date");
  assert.equal(c.payloadHash, EMPTY_SHA256);
  assert.equal(c.amzDate, "20130524T000000Z");
  assert.equal(c.shortDate, "20130524");
  assert.equal(c.scope, "20130524/us-east-1/s3/aws4_request");
});

test("SigV4 payloadHash（非空 body）与 node:crypto 一致", () => {
  const body = "Hello, SigV4!";
  const c = canonicalRequest({
    method: "POST", url: "https://api.example.com/a%20b/path",
    body,
    accessKeyId: "k", secretAccessKey: "s", region: "us-east-1", service: "execute-api",
    timestamp: new Date("2020-01-01T00:00:00Z"),
  });
  assert.equal(c.payloadHash, createHash("sha256").update(body).digest("hex"));
  assert.ok(c.canonical.startsWith("POST\n/a%20b/path\n"));
  assert.equal(c.shortDate, "20200101");
});

test("signAwsSigV4 header 签名 Authorization 格式", async () => {
  const signed = await signAwsSigV4(SIGV4_BASE);
  assert.match(
    signed.authorization,
    /^AWS4-HMAC-SHA256 Credential=my-access-key-id\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
  );
  assert.equal(signed.headers.Authorization, signed.authorization);
  assert.equal(signed.amzDate, "20130524T000000Z");
  assert.equal(signed.headers["x-amz-date"], "20130524T000000Z");
  assert.equal(signed.headers["x-amz-content-sha256"], EMPTY_SHA256);
  assert.equal(signed.headers["host"], "examplebucket.s3.amazonaws.com");
  assert.equal(signed.query["X-Amz-Signature"], undefined);
});

test("signAwsSigV4 签名 HMAC 链用 node:crypto.createHmac 交叉验证", async () => {
  const signed = await signAwsSigV4(SIGV4_BASE);
  const c = canonicalRequest(SIGV4_BASE);
  const canonicalHash = createHash("sha256").update(c.canonical).digest("hex");
  const stringToSign = `AWS4-HMAC-SHA256\n${c.amzDate}\n${c.scope}\n${canonicalHash}`;
  const expected = independentHmacChain(
    SIGV4_BASE.secretAccessKey, c.shortDate, SIGV4_BASE.region, SIGV4_BASE.service, stringToSign,
  );
  const actual = signed.authorization.match(/Signature=([0-9a-f]+)/)[1];
  assert.equal(actual, expected);
});

test("signAwsSigV4 预签名 URL query 参数齐全", async () => {
  const signed = await signAwsSigV4({
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/test.txt?prefix=a",
    accessKeyId: "my-access-key-id",
    secretAccessKey: "my-secret-key",
    sessionToken: "sess-tok",
    region: "us-east-1",
    service: "s3",
    signQuery: true,
    expiresIn: 900,
    timestamp: new Date("2013-05-24T00:00:00Z"),
  });
  assert.equal(signed.authorization, "");
  assert.equal(signed.query["X-Amz-Algorithm"], "AWS4-HMAC-SHA256");
  assert.equal(signed.query["X-Amz-Credential"], "my-access-key-id/20130524/us-east-1/s3/aws4_request");
  assert.equal(signed.query["X-Amz-Date"], "20130524T000000Z");
  assert.equal(signed.query["X-Amz-Expires"], "900");
  assert.equal(signed.query["X-Amz-SignedHeaders"], "host");
  assert.equal(signed.query["X-Amz-Security-Token"], "sess-tok");
  assert.equal(signed.query["prefix"], "a", "保留原始 query 参数");
  assert.match(signed.query["X-Amz-Signature"], /^[0-9a-f]{64}$/);
});

test("normalizeMtls PEM 拼接 / PKCS#12 / 校验 / none", () => {
  const r = normalizeMtls({ type: "mtls", certPem: CERT, keyPem: KEY, caPem: CA, passphrase: "pp" });
  assert.equal(r.kind, "pem");
  assert.ok(r.identityPem.startsWith(KEY), "key 应拼在 cert 之前");
  assert.ok(r.identityPem.includes("BEGIN CERTIFICATE"));
  assert.ok(r.identityPem.includes("PRIVATE KEY"));
  assert.equal(r.caPem, CA);
  assert.equal(r.passphrase, "pp");
  assert.equal(normalizeMtls({ type: "mtls", certPem: "bad", keyPem: "bad" }).kind, "none", "无效 PEM 降级 none");
  const p12 = normalizeMtls({ type: "mtls", p12Base64: "QUJD", passphrase: "pp" });
  assert.equal(p12.kind, "pkcs12");
  assert.equal(p12.identityPem, undefined);
  assert.equal(normalizeMtls({ type: "mtls" }).kind, "none");
});

test("validateAuth 各分支返回中文错误", () => {
  assert.deepEqual(validateAuth({ type: "none" }), []);
  assert.deepEqual(validateAuth({ type: "inherit" }), []);
  assert.ok(validateAuth({ type: "bearer" }).some((e) => e.includes("令牌")));
  assert.deepEqual(validateAuth({ type: "bearer", token: "tok" }), []);
  assert.ok(validateAuth({ type: "basic", username: "u" }).some((e) => e.includes("密码")));
  assert.deepEqual(validateAuth({ type: "apiKey", key: "X-Key", value: "v", location: "query" }), []);
  assert.ok(validateAuth({ type: "apiKey", key: "X-Key", value: "v", location: "cookie" }).length > 0);
  assert.deepEqual(validateAuth({ type: "apiKey", key: "X-Key", value: "v", in: "query" }), [], "旧 in 兼容");
  assert.deepEqual(
    validateAuth({ type: "oauth2", grant: "clientCredentials", tokenUrl: "https://a/token", clientId: "c" }),
    [],
  );
  assert.ok(validateAuth({ type: "oauth2", grant: "clientCredentials" }).some((e) => e.includes("tokenUrl")));
  assert.ok(
    validateAuth({ type: "oauth2", grant: "authorizationCode", tokenUrl: "https://a/token", authUrl: "bad", clientId: "c" })
      .some((e) => e.includes("authUrl")),
  );
  assert.ok(validateAuth({ type: "oauth2", grant: "password", tokenUrl: "https://a/token" }).length > 0);
  assert.ok(
    validateAuth({ type: "oauth2", grant: "clientCredentials", tokenUrl: "https://a/token", clientId: "c", pkce: true, codeVerifier: "short" })
      .some((e) => e.includes("codeVerifier")),
  );
  assert.equal(validateAuth({ type: "awsSigV4", accessKeyId: "a", secretAccessKey: "b", region: "r", service: "s" }).length, 0);
  assert.ok(validateAuth({ type: "awsSigV4" }).length >= 4);
  assert.equal(validateAuth({ type: "mtls", certPem: CERT, keyPem: KEY }).length, 0);
  assert.ok(validateAuth({ type: "mtls", certPem: "bad", keyPem: "bad" }).length >= 2);
  assert.ok(validateAuth({ type: "weird" }).length > 0);
});

test("AUTH_SECRET_FIELDS 覆盖与 isSecretAuthField", () => {
  const required = [
    "token", "password", "clientSecret", "secretAccessKey", "sessionToken",
    "accessToken", "refreshToken", "code", "codeVerifier", "keyPem", "certPem",
    "caPem", "p12Base64", "passphrase", "value", "state",
  ];
  for (const k of required) {
    assert.ok(AUTH_SECRET_FIELDS.includes(k), `AUTH_SECRET_FIELDS 缺少 ${k}`);
    assert.equal(isSecretAuthField(k), true, `isSecretAuthField(${k}) 应为 true`);
  }
  assert.equal(isSecretAuthField("clientSecret"), true);
  assert.equal(isSecretAuthField("CLIENT_SECRET"), true, "大小写/下划线不敏感");
  assert.equal(isSecretAuthField("client_secret"), true);
  assert.equal(isSecretAuthField("clientId"), false);
  assert.equal(isSecretAuthField("region"), false);
  assert.equal(isSecretAuthField("grant"), false);
  assert.equal(isSecretAuthField("key"), false, "apiKey 的请求头名不是密钥");
  assert.equal(isSecretAuthField("username"), false);
});

test("authSummary 不泄漏任何密钥", () => {
  const auths = [
    { type: "bearer", token: NO_LEAK },
    { type: "basic", username: "u", password: NO_LEAK },
    { type: "apiKey", key: "X-Key", value: NO_LEAK, location: "header" },
    {
      type: "oauth2", grant: "authorizationCode",
      clientId: "c", clientSecret: NO_LEAK, accessToken: NO_LEAK, refreshToken: NO_LEAK,
      code: NO_LEAK, codeVerifier: NO_LEAK, state: NO_LEAK,
      authUrl: "https://a/auth", tokenUrl: "https://a/token",
    },
    {
      type: "awsSigV4", accessKeyId: "a", secretAccessKey: NO_LEAK,
      sessionToken: NO_LEAK, region: "r", service: "s",
    },
    {
      type: "mtls", certPem: CERT, keyPem: KEY, caPem: CA,
      p12Base64: NO_LEAK, passphrase: NO_LEAK,
    },
  ];
  for (const a of auths) {
    const s = authSummary(a);
    assert.equal(typeof s, "string");
    assert.ok(s.length > 0);
    assert.ok(!s.includes(NO_LEAK), `authSummary 泄漏于 ${a.type}: ${s}`);
  }
});

test("applyAuthHeaders 四种旧类型", async () => {
  assert.deepEqual(await applyAuthHeaders({ type: "none" }, { A: "1" }), { A: "1" });
  assert.deepEqual(await applyAuthHeaders({ type: "inherit" }, { A: "1" }), { A: "1" });
  assert.equal((await applyAuthHeaders({ type: "bearer", token: "tok-abc" }, {})).Authorization, "Bearer tok-abc");
  assert.equal(
    (await applyAuthHeaders({ type: "basic", username: "u", password: "p" }, {})).Authorization,
    "Basic " + Buffer.from("u:p").toString("base64"),
  );
  const ak = await applyAuthHeaders({ type: "apiKey", key: "X-Key", value: "v1", location: "header" }, {});
  assert.equal(ak["X-Key"], "v1");
});

test("applyAuthHeaders 新类型（oauth2 / awsSigV4 / mtls）与过期抛错", async () => {
  const oa = await applyAuthHeaders(
    { type: "oauth2", grant: "authorizationCode", accessToken: "tok-oa", tokenType: "Bearer" },
    {},
  );
  assert.equal(oa.Authorization, "Bearer tok-oa");

  await assert.rejects(
    () => applyAuthHeaders(
      { type: "oauth2", grant: "authorizationCode", accessToken: "tok", refreshToken: "r", expiresAt: 1000 },
      {}, { now: 2000 },
    ),
    /刷新令牌/,
  );

  const sv = await applyAuthHeaders(
    { type: "awsSigV4", accessKeyId: "my-access-key-id", secretAccessKey: "my-secret-key", region: "us-east-1", service: "s3" },
    {},
    { url: "https://examplebucket.s3.amazonaws.com/test.txt", method: "GET" },
  );
  assert.ok(sv.Authorization.startsWith("AWS4-HMAC-SHA256"));
  assert.ok(sv["x-amz-date"]);
  assert.ok(sv["x-amz-content-sha256"]);
  assert.ok(sv["host"]);

  assert.deepEqual(await applyAuthHeaders({ type: "mtls", certPem: CERT, keyPem: KEY }, { A: "1" }), { A: "1" });
});

test("applyAuthQuery 注入 apiKey(query)", () => {
  assert.equal(
    applyAuthQuery({ type: "apiKey", key: "X-Key", value: "v1", in: "query" }, "https://a/path"),
    "https://a/path?X-Key=v1",
  );
  assert.equal(
    applyAuthQuery({ type: "apiKey", key: "sig", value: "a b", in: "query" }, "https://a/p?x=1"),
    "https://a/p?x=1&sig=a%20b",
  );
  assert.equal(
    applyAuthQuery({ type: "apiKey", key: "X-Key", value: "v1", in: "header" }, "https://a/p"),
    "https://a/p",
  );
  assert.equal(applyAuthQuery({ type: "bearer", token: "t" }, "https://a/p"), "https://a/p");
});

test("defaultAuth / normalizeAuth / authLabel", () => {
  assert.deepEqual(defaultAuth("none"), { type: "none" });
  assert.equal(defaultAuth("oauth2").grant, "authorizationCode");
  assert.equal(defaultAuth("oauth2").clientAuth, "body");
  assert.equal(defaultAuth("oauth2").tokenType, "Bearer");
  assert.equal(defaultAuth("awsSigV4").region, "us-east-1");
  assert.equal(defaultAuth("awsSigV4").service, "execute-api");
  const apiDefault = defaultAuth("apiKey");
  assert.equal(apiDefault.location, "header", "defaultAuth 必须输出 location");
  assert.ok(!("in" in apiDefault), "defaultAuth 不应输出 in");
  assert.equal(defaultAuth("mtls").minTlsVersion, "1.2");

  const n = normalizeAuth({ type: "bearer" });
  assert.equal(n.type, "bearer");
  assert.equal(n.token, "");
  assert.equal(n.tokenPrefix, "Bearer");
  assert.equal(normalizeAuth({ type: "bogus" }).type, "none", "未知 type 降级 none");
  assert.equal(normalizeAuth(null).type, "none");
  assert.equal(normalizeAuth("not json").type, "none");
  assert.equal(normalizeAuth(JSON.stringify({ type: "basic", username: "u" })).username, "u");
  assert.equal(normalizeAuth({ type: "oauth2", grant: "weird" }).grant, "authorizationCode");
  const nq = normalizeAuth({ type: "apiKey", in: "QUERY" });
  assert.equal(nq.location, "query", "旧数据 in 归一化到 location");
  assert.ok(!("in" in nq), "normalizeAuth 不应输出 in");
  assert.equal(normalizeAuth({ type: "apiKey", location: "query" }).location, "query");
  assert.equal(normalizeAuth({ type: "apiKey", location: "header" }).location, "header");
  assert.equal(normalizeAuth({ type: "apiKey" }).location, "header");

  assert.equal(authLabel({ type: "oauth2" }), "OAuth 2.0");
  assert.equal(authLabel({ type: "awsSigV4" }), "AWS SigV4");
  assert.equal(authLabel({ type: "mtls" }), "mTLS 双向证书");
  assert.equal(authLabel({ type: "none" }), "无认证");
  assert.equal(authLabel({ type: "inherit" }), "继承上级");
});

test("apiKey 以 location 为准（in 仅作旧数据兼容读取）", async () => {
  // location: query -> 不注入 header，走 query
  const hq = await applyAuthHeaders({ type: "apiKey", key: "X-Key", value: "v1", location: "query" }, {});
  assert.equal(hq["X-Key"], undefined);
  assert.equal(
    applyAuthQuery({ type: "apiKey", key: "X-Key", value: "v1", location: "query" }, "https://a/p"),
    "https://a/p?X-Key=v1",
  );
  // location: header -> 注入 header，不走 query
  const hh = await applyAuthHeaders({ type: "apiKey", key: "X-Key", value: "v1", location: "header" }, {});
  assert.equal(hh["X-Key"], "v1");
  assert.equal(
    applyAuthQuery({ type: "apiKey", key: "X-Key", value: "v1", location: "header" }, "https://a/p"),
    "https://a/p",
  );
  // location 优先于 in
  const hp = await applyAuthHeaders(
    { type: "apiKey", key: "X-Key", value: "v1", location: "query", in: "header" }, {},
  );
  assert.equal(hp["X-Key"], undefined, "location 应优先于 in");
  // 旧数据仅 in 仍兼容
  const legacy = await applyAuthHeaders({ type: "apiKey", key: "X-Key", value: "v1", in: "header" }, {});
  assert.equal(legacy["X-Key"], "v1");
  assert.equal(
    applyAuthQuery({ type: "apiKey", key: "sig", value: "v", in: "query" }, "https://a/p"),
    "https://a/p?sig=v",
  );
});
