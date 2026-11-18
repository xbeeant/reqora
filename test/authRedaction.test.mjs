import test from "node:test";
import assert from "node:assert/strict";
import {
  redactSnapshot,
  restoreRedacted,
  redactFreeText,
  redactAuth,
} from "../src/lib/redact.ts";
import { isSecretAuthField } from "../src/lib/authProviders.ts";
import { normalizeRequest } from "../src/lib/defaults.ts";
import { generateCode } from "../src/lib/codegen.ts";

// 凭据样例在运行时拼接，避免在测试源码里留下完整的敏感字面串。
const sampleKey = (prefix) => prefix + "0".repeat(16);
const samplePem = [
  "-----BEGIN ",
  "RSA ",
  "PRIVATE KEY-----",
  "\nMIIEowIBAAKCAQEAexample",
  "\n",
  "-----END ",
  "RSA ",
  "PRIVATE KEY-----",
].join("");

test("OAuth2 变体：密钥类字段置空，方案字段保留", () => {
  const r = redactSnapshot({
    auth: {
      type: "oauth2",
      grant: "authorizationCode",
      tokenUrl: "https://issuer.example/token",
      scope: "read write",
      clientSecret: "cs",
      accessToken: "at",
      refreshToken: "rt",
      code: "auth-code",
      codeVerifier: "cv",
      state: "state-xyz",
      username: "user",
      password: "pw",
    },
  }).auth;
  assert.equal(r.type, "oauth2");
  assert.equal(r.grant, "authorizationCode");
  assert.equal(r.tokenUrl, "https://issuer.example/token");
  assert.equal(r.scope, "read write");
  for (const k of [
    "clientSecret", "accessToken", "refreshToken", "code",
    "codeVerifier", "state", "username", "password",
  ]) {
    assert.equal(r[k], "", `${k} 应被置空`);
  }
});

test("OAuth2 state：与 isSecretAuthField 口径一致，fail-closed 置空", () => {
  assert.equal(isSecretAuthField("state"), true);
  const r = redactAuth({ type: "oauth2", state: "state-xyz", scope: "read" });
  assert.equal(r.state, "", "state 不能因历史白名单而放行");
  assert.equal(r.scope, "read", "非密钥方案字段仍保留");
});

test("AWS SigV4 变体：密钥置空，region/service/数值布尔字段保留", () => {
  const r = redactSnapshot({
    auth: {
      type: "awsSigV4",
      accessKeyId: "AK",
      secretAccessKey: "sec",
      sessionToken: "sess",
      region: "us-east-1",
      service: "s3",
      signQuery: true,
      expiresIn: 60,
    },
  }).auth;
  assert.equal(r.type, "awsSigV4");
  assert.equal(r.region, "us-east-1");
  assert.equal(r.service, "s3");
  assert.equal(r.signQuery, true);
  assert.equal(r.expiresIn, 60);
  assert.equal(r.secretAccessKey, "");
  assert.equal(r.sessionToken, "");
  assert.equal(r.accessKeyId, "", "accessKeyId 同样按 fail-closed 置空");
});

test("mTLS 变体：证书/私钥/口令置空，serverName/minTlsVersion 保留", () => {
  const r = redactSnapshot({
    auth: {
      type: "mtls",
      certPem: "CERT",
      keyPem: "KEY",
      caPem: "CA",
      p12Base64: "P12",
      passphrase: "pp",
      serverName: "api.example.com",
      minTlsVersion: "1.3",
    },
  }).auth;
  assert.equal(r.type, "mtls");
  assert.equal(r.serverName, "api.example.com");
  assert.equal(r.minTlsVersion, "1.3");
  for (const k of ["certPem", "keyPem", "caPem", "p12Base64", "passphrase"]) {
    assert.equal(r[k], "", `${k} 应被置空`);
  }
});

test("soap / mqtt 子树只脱敏 username/password，其余字段保留", () => {
  const r = redactSnapshot({
    request: {
      soap: { version: "1.1", operation: "Ping", soapAction: "act", username: "su", password: "sp" },
      mqtt: { url: "mqtt://broker.example", topic: "t/1", qos: 1, username: "mu", password: "mp" },
    },
  });
  assert.equal(r.request.soap.username, "");
  assert.equal(r.request.soap.password, "");
  assert.equal(r.request.soap.operation, "Ping");
  assert.equal(r.request.soap.soapAction, "act");
  assert.equal(r.request.mqtt.username, "");
  assert.equal(r.request.mqtt.password, "");
  assert.equal(r.request.mqtt.topic, "t/1");
  assert.equal(r.request.mqtt.qos, 1);
});

test("restoreRedacted 回填扩展变体的凭据字段", () => {
  const local = {
    auth: {
      type: "oauth2",
      grant: "password",
      tokenUrl: "https://issuer.example/token",
      clientSecret: "real-secret",
      accessToken: "real-at",
      username: "alice",
    },
  };
  const remote = redactSnapshot(local);
  assert.equal(remote.auth.clientSecret, "");
  assert.equal(remote.auth.username, "");
  const restored = restoreRedacted(remote, local);
  assert.equal(restored.auth.clientSecret, "real-secret");
  assert.equal(restored.auth.accessToken, "real-at");
  assert.equal(restored.auth.username, "alice");
  assert.equal(restored.auth.tokenUrl, "https://issuer.example/token");
});

test("restoreRedacted 回填 soap / mqtt 的 username/password", () => {
  const local = { soap: { username: "su", password: "sp", operation: "Ping" } };
  const remote = redactSnapshot(local);
  assert.equal(remote.soap.username, "");
  const restored = restoreRedacted(remote, local);
  assert.equal(restored.soap.username, "su");
  assert.equal(restored.soap.password, "sp");
  assert.equal(restored.soap.operation, "Ping");
});

test("redactAuth 对扩展变体 fail-closed，且不改变经典 basic 行为", () => {
  const mtls = redactAuth({ type: "mtls", keyPem: "KEY", serverName: "s", minTlsVersion: "1.3" });
  assert.equal(mtls.keyPem, "");
  assert.equal(mtls.serverName, "s");
  assert.equal(mtls.minTlsVersion, "1.3");
  const basic = redactAuth({ type: "basic", username: "u", password: "p" });
  assert.equal(basic.username, "u", "历史白名单行为保持不变");
  assert.equal(basic.password, "");
});

test("redactFreeText 覆盖 AKIA/ASIA、PEM 私钥、x-amz-security-token、refresh_token", () => {
  assert.match(redactFreeText(`id=${sampleKey("AKIA")}`), /<redacted-key>/);
  assert.match(redactFreeText(`id=${sampleKey("ASIA")}`), /<redacted-key>/);
  assert.match(redactFreeText(samplePem), /<redacted-private-key>/);
  assert.match(redactFreeText("x-amz-security-token: FwoGZXIvYXdzEBYaD"), /<redacted>/);
  assert.match(redactFreeText("refresh_token=abc123secret"), /refresh_token=<redacted>/);
});

test("normalizeRequest 放行 mqtt/soap 协议并透传新字段", () => {
  const r = normalizeRequest({
    protocol: "mqtt",
    httpVersion: "http3",
    mqtt: {
      url: "mqtt://broker.example", topic: "t", qos: 1, retain: false,
      version: "5", keepAliveSecs: 30, cleanSession: true,
    },
    soap: { version: "1.2", operation: "Ping" },
    method: "GET",
    url: "",
  });
  assert.equal(r.protocol, "mqtt");
  assert.equal(r.httpVersion, "http3");
  assert.equal(r.mqtt.topic, "t");
  assert.equal(r.soap.version, "1.2");
  assert.equal(normalizeRequest({ protocol: "soap" }).protocol, "soap");
});

test("generateCode 不写入扩展变体密钥，只输出占位注释", () => {
  const base = { method: "GET", url: "https://api.example.com" };
  const oauth = generateCode(
    normalizeRequest({
      ...base,
      auth: { type: "oauth2", grant: "clientCredentials", tokenUrl: "https://t", clientSecret: "TOPSECRET", accessToken: "ATSECRET" },
    }),
    "curl",
  );
  assert.ok(!oauth.includes("TOPSECRET"));
  assert.ok(!oauth.includes("ATSECRET"));
  assert.match(oauth, /OAuth 2\.0/);
  assert.match(oauth, /\$\{REQORA_TOKEN\}/);

  const sigv4 = generateCode(
    normalizeRequest({
      ...base,
      auth: { type: "awsSigV4", accessKeyId: "AK", secretAccessKey: "SIGV4SECRET", region: "us-east-1", service: "s3" },
    }),
    "curl",
  );
  assert.ok(!sigv4.includes("SIGV4SECRET"));
  assert.match(sigv4, /aws-sigv4/);

  const mtls = generateCode(
    normalizeRequest({ ...base, auth: { type: "mtls", keyPem: "MILSKEYSECRET", certPem: "CERTSECRET" } }),
    "curl",
  );
  assert.ok(!mtls.includes("MILSKEYSECRET"));
  assert.ok(!mtls.includes("CERTSECRET"));
  assert.match(mtls, /--cert <client\.pem>/);
});
