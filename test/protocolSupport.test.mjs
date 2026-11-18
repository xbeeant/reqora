// 7 项能力的跨模块冒烟：只验证「模块已接通、契约形状正确」，不重复各模块
// 自己的深度单测（authProviders/soap/mqtt 各有专门测试文件）。
//
// 所有凭据都是明显的假值占位；断言失败信息只给中文说明，不回显任何值。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUTH_SECRET_FIELDS,
  applyAuthHeaders,
  applyAuthQuery,
  defaultAuth,
  isSecretAuthField,
  tokenNeedsRefresh,
  validateAuth,
} from "../src/lib/authProviders.ts";
import {
  buildSoapEnvelope,
  escapeXml,
  parseSoapFault,
  parseWsdl,
  soapActionHeader,
  soapContentType,
} from "../src/lib/soap.ts";
import {
  decodeConnack,
  encodeConnect,
  encodePublish,
  encodeSubscribe,
  parseMqttUrl,
  topicMatches,
} from "../src/lib/mqtt.ts";
import { redactAuth, redactFreeText, redactSnapshot, restoreRedacted } from "../src/lib/redact.ts";
import { api, sendRequest, streamRequest } from "../src/lib/api.ts";
import { emptyRequest, normalizeRequest } from "../src/lib/defaults.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative) => readFileSync(join(root, relative), "utf8");

const NEW_AUTH_TYPES = ["oauth2", "awsSigV4", "mtls"];
// 任务要求登记的新认证密钥字段（MCP 展示 / 导出脱敏都依赖这份清单）。
const REQUIRED_SECRET_FIELDS = [
  "clientSecret", "secretAccessKey", "sessionToken", "accessToken",
  "refreshToken", "code", "codeVerifier", "keyPem", "certPem",
  "caPem", "p12Base64", "passphrase",
];

/* 1. authProviders：三种新认证的默认草稿 */
test("冒烟 1/7：authProviders 三种新认证 defaultAuth 形状正确", () => {
  const required = {
    oauth2: ["accessToken", "refreshToken", "clientSecret", "codeVerifier"],
    awsSigV4: ["accessKeyId", "secretAccessKey", "sessionToken", "region", "service"],
    mtls: ["certPem", "keyPem", "caPem", "p12Base64", "passphrase"],
  };
  for (const type of NEW_AUTH_TYPES) {
    const draft = defaultAuth(type);
    assert.equal(typeof draft, "object", `${type} 默认草稿应为对象`);
    assert.equal(draft.type, type, `${type} 默认草稿的 type 必须正确`);
    assert.ok(Object.keys(draft).length > 5, `${type} 默认草稿字段过少`);
    for (const key of required[type]) {
      assert.ok(Object.hasOwn(draft, key), `${type} 默认草稿缺少 ${key}`);
    }
  }
});

/* 2. authProviders：校验器与 wire 注入入口 */
test("冒烟 2/7：validateAuth 与 auth wire 注入入口可用", () => {
  for (const type of NEW_AUTH_TYPES) {
    const issues = validateAuth(defaultAuth(type));
    assert.ok(Array.isArray(issues), `${type} 校验结果应为错误列表`);
    assert.ok(issues.length > 0, "空白默认草稿应报出缺失字段");
    assert.ok(issues.every((item) => typeof item === "string"), "校验错误应为可读字符串");
  }
  assert.equal(typeof applyAuthHeaders, "function");
  assert.equal(typeof applyAuthQuery, "function");
  assert.equal(typeof tokenNeedsRefresh, "function");
  assert.equal(tokenNeedsRefresh({ type: "none" }), false);
});

/* 3. authProviders：新认证密钥字段登记 */
test("冒烟 3/7：AUTH_SECRET_FIELDS 覆盖全部新变体密钥", () => {
  assert.ok(Array.isArray(AUTH_SECRET_FIELDS));
  assert.ok(AUTH_SECRET_FIELDS.length >= REQUIRED_SECRET_FIELDS.length);
  for (const field of REQUIRED_SECRET_FIELDS) {
    assert.ok(AUTH_SECRET_FIELDS.includes(field), `AUTH_SECRET_FIELDS 缺少 ${field}`);
    assert.equal(isSecretAuthField(field), true, `${field} 应被识别为密钥字段`);
  }
});

/* 4. soap.ts：Content-Type / SOAPAction / Envelope / XML 转义 */
test("冒烟 4/7：soap.ts 的 1.1/1.2 投影与 XML 能力", () => {
  assert.equal(soapContentType("1.1"), "text/xml; charset=utf-8");
  assert.equal(soapContentType("1.2"), "application/soap+xml; charset=utf-8");
  assert.deepEqual(
    soapActionHeader({ soapAction: "urn: Ping", version: "1.1" }),
    { key: "SOAPAction", value: "urn: Ping" },
  );
  const action12 = soapActionHeader({ soapAction: "urn: Ping", version: "1.2" });
  assert.equal(action12.key, "Content-Type");
  assert.match(action12.value, /^application\/soap\+xml; charset=utf-8; action="urn: Ping"$/);
  const envelope = buildSoapEnvelope({ version: "1.1", operation: "Ping" });
  assert.match(envelope, /<soap:Envelope/);
  assert.match(envelope, /<soap:Body>/);
  assert.match(envelope, /<Ping/);
  assert.equal(escapeXml("a&b<c>"), "a&amp;b&lt;c&gt;");
  assert.equal(parseSoapFault(envelope), null);
  assert.equal(typeof parseWsdl, "function");
});

/* 5. mqtt.ts：URL 解析 / 主题匹配 / 报文编解码入口 */
test("冒烟 5/7：mqtt.ts 的 URL、主题与报文能力", () => {
  assert.deepEqual(parseMqttUrl("mqtt://localhost:1883/a/b"), {
    host: "localhost", port: 1883, useTls: false, transport: "tcp", path: "/a/b",
  });
  assert.equal(topicMatches("a/#", "a/b"), true);
  assert.equal(topicMatches("a/+", "a/b"), true);
  assert.equal(topicMatches("a/#", "b/c"), false);
  for (const fn of [encodeConnect, encodePublish, encodeSubscribe, decodeConnack]) {
    assert.equal(typeof fn, "function", "MQTT 报文编解码入口缺失");
  }
});

/* 6. redact.ts：对三种新认证的密钥脱敏 */
test("冒烟 6/7：redactAuth 对新增认证密钥打码", () => {
  const samples = {
    oauth2: {
      type: "oauth2", accessToken: "V00000001", refreshToken: "V00000002",
      clientSecret: "V00000003", codeVerifier: "V00000004", code: "V00000005",
      password: "V00000006",
    },
    awsSigV4: {
      type: "awsSigV4", accessKeyId: "V00000000",
      secretAccessKey: "V00000001", sessionToken: "V00000002",
    },
    mtls: {
      type: "mtls", certPem: "V00000001", keyPem: "V00000002",
      caPem: "V00000003", p12Base64: "V00000004", passphrase: "V00000005",
    },
  };
  for (const [type, auth] of Object.entries(samples)) {
    const redacted = redactAuth(auth);
    assert.equal(typeof redacted, "object", `${type} 脱敏结果应为对象`);
    assert.notEqual(redacted, auth, `${type} 脱敏应返回新对象`);
    for (const key of Object.keys(auth)) {
      if (key === "type" || key === "accessKeyId") continue;
      assert.notEqual(redacted[key], auth[key], `${type}.${key} 必须被打码`);
    }
  }
  assert.equal(typeof redactSnapshot, "function");
  assert.equal(typeof redactFreeText, "function");
  assert.equal(typeof restoreRedacted, "function");
});

/* 7. api.ts + defaults.ts：IPC wrapper 与新协议放行 */
test("冒烟 7/7：api.ts IPC wrapper 与 defaults.ts 对 mqtt/soap 放行", () => {
  assert.equal(typeof sendRequest, "function", "sendRequest IPC wrapper 缺失");
  assert.equal(typeof streamRequest, "function", "streamRequest IPC wrapper 缺失");
  assert.ok(Object.keys(api).length >= 50, "api 客户端方法数量异常");
  for (const name of [
    "mqttConnect", "mqttDisconnect", "mqttPublish", "mqttSubscribe",
    "mqttUnsubscribe", "wsConnect", "grpcInvoke", "benchmarkRun",
  ]) {
    assert.equal(typeof api[name], "function", `api.${name} 缺失`);
  }
  // 桌面端与 CLI/MCP 共用同一份 wire contract。
  assert.match(source("src/lib/api.ts"), /toWireSpec\(/);

  for (const protocol of ["soap", "mqtt"]) {
    const draft = normalizeRequest({ ...emptyRequest(), protocol });
    assert.equal(draft.protocol, protocol, `defaults 应放行 ${protocol} 协议`);
  }
  assert.equal(typeof emptyRequest().method, "string");
});
