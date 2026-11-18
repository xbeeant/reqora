// Wire contract for the shared `toWireSpec()` (src/lib/wireSpec.ts).
//
// Both the desktop IPC and the Node CLI / MCP sidecar feed the exact same
// RequestSpec to reqora-core, so these assertions pin the projection rules
// that must not drift between shells. Tests are read-only: no production code
// is touched, and every credential below is an obvious fake placeholder.

import assert from "node:assert/strict";
import test from "node:test";

import { toWireSpec, wireVariables } from "../src/lib/wireSpec.ts";

const SOAP_NS_11 = "http://schemas.xmlsoap.org/soap/envelope/";
const SOAP_NS_12 = "http://www.w3.org/2003/05/soap-envelope";
const SOAP11_ENVELOPE = `<soap:Envelope xmlns:soap="${SOAP_NS_11}"><soap:Body><Ping xmlns="urn:demo"/></soap:Body></soap:Envelope>`;
const SOAP12_ENVELOPE = `<soap:Envelope xmlns:soap="${SOAP_NS_12}"><soap:Body><Ping xmlns="urn:demo"/></soap:Body></soap:Envelope>`;
const SOAP_ACTION = "urn: Ping";
// 明确的假值占位：WS-Security 的密码本就以 XML 文本出现在 body 中（脱敏在
// redact / vault，不在 wire 契约），测试常量之外不输出这些值。
const FAKE_USER = "FAKE_WSSE_USER";
const FAKE_PASSWORD = "FAKE_WSSE_PASSWORD";

function baseRequest(overrides = {}) {
  return {
    id: "req-1",
    name: "示例请求",
    method: "GET",
    url: "https://example.test/api",
    headers: [{ id: "h1", key: "Accept", value: "application/json", enabled: true }],
    query: [{ id: "q1", key: "page", value: "1", enabled: true }],
    body: { type: "none" },
    auth: { type: "none" },
    pathVariables: [],
    ...overrides,
  };
}

function soapRequest(overrides = {}, soapOverrides = {}) {
  return baseRequest({
    protocol: "soap",
    soap: { version: "1.1", soapAction: SOAP_ACTION, envelope: SOAP11_ENVELOPE, ...soapOverrides },
    ...overrides,
  });
}

function wire(request, settings = {}, variables = {}) {
  return toWireSpec(request, { variables, settings });
}

function headerRows(spec, key) {
  const lower = String(key).toLowerCase();
  return spec.headers.filter((row) => String(row.key).toLowerCase() === lower);
}

/* -------------------------------------------------------------------------- */
/* 1. httpVersion 透传与优先级                                                 */
/* -------------------------------------------------------------------------- */

test("httpVersion：request 级覆盖 settings 级", () => {
  const spec = wire(baseRequest({ httpVersion: "http2" }), { httpVersion: "http3" });
  assert.equal(spec.httpVersion, "http2");
});

test("httpVersion：只有 settings 级时采用 settings", () => {
  const spec = wire(baseRequest(), { httpVersion: "http3" });
  assert.equal(spec.httpVersion, "http3");
});

test("httpVersion：request 与 settings 都缺省时为 auto", () => {
  assert.equal(wire(baseRequest(), {}).httpVersion, "auto");
  assert.equal(wire(baseRequest({ httpVersion: undefined }), { httpVersion: undefined }).httpVersion, "auto");
});

test("httpVersion：auto/http1/http2/http3 四种值原样透传", () => {
  for (const version of ["auto", "http1", "http2", "http3"]) {
    assert.equal(wire(baseRequest({ httpVersion: version }), {}).httpVersion, version);
    assert.equal(wire(baseRequest(), { httpVersion: version }).httpVersion, version);
  }
});

/* -------------------------------------------------------------------------- */
/* 2. SOAP 1.1 投影                                                            */
/* -------------------------------------------------------------------------- */

test("SOAP 1.1：method 被强制为 POST（即使草稿是 GET）", () => {
  const spec = wire(soapRequest({ method: "GET" }));
  assert.equal(spec.method, "POST");
});

test("SOAP 1.1：body 投影为 raw + 原始 envelope + text/xml contentType", () => {
  const spec = wire(soapRequest());
  assert.deepEqual(spec.body, {
    type: "raw",
    content: SOAP11_ENVELOPE,
    contentType: "text/xml; charset=utf-8",
  });
});

test("SOAP 1.1：注入 SOAPAction 头且只出现一次", () => {
  const spec = wire(soapRequest());
  const rows = headerRows(spec, "SOAPAction");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, SOAP_ACTION);
  assert.equal(rows[0].enabled, true);
});

test("SOAP 1.1：用户已写同名 SOAPAction 头时不重复追加且保留其非空值", () => {
  const request = soapRequest({
    headers: [{ id: "h1", key: "SOAPAction", value: "urn: Custom", enabled: false }],
  });
  const spec = wire(request);
  const rows = headerRows(spec, "SOAPAction");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, "urn: Custom");
  assert.equal(rows[0].enabled, true);
  // 投影复制了 header 行，不修改原始草稿，也不追加快照之外的同名行。
  assert.equal(request.headers.length, 1);
  assert.equal(request.headers[0].value, "urn: Custom");
});

/* -------------------------------------------------------------------------- */
/* 3. SOAP 1.2 投影（soapActionHeader 把 action 拼进 Content-Type）           */
/* -------------------------------------------------------------------------- */

test("SOAP 1.2：body contentType 为 application/soap+xml 且 Content-Type 头带 action 参数", () => {
  const spec = wire(soapRequest({}, { version: "1.2", envelope: SOAP12_ENVELOPE }));
  assert.equal(spec.body.type, "raw");
  assert.equal(spec.body.contentType, "application/soap+xml; charset=utf-8");
  const rows = headerRows(spec, "Content-Type");
  assert.equal(rows.length, 1);
  assert.match(rows[0].value, /^application\/soap\+xml; charset=utf-8; action="urn: Ping"$/);
  assert.equal(headerRows(spec, "SOAPAction").length, 0);
});

test("SOAP 1.2：用户已写 Content-Type 时不重复追加且被覆盖为带 action 的值", () => {
  const spec = wire(soapRequest(
    { headers: [{ id: "h1", key: "Content-Type", value: "text/plain", enabled: true }] },
    { version: "1.2", envelope: SOAP12_ENVELOPE },
  ));
  const rows = headerRows(spec, "Content-Type");
  assert.equal(rows.length, 1);
  assert.match(rows[0].value, /^application\/soap\+xml; charset=utf-8; action="urn: Ping"$/);
});

/* -------------------------------------------------------------------------- */
/* 4. WS-Security                                                              */
/* -------------------------------------------------------------------------- */

test("WS-Security：注入 wsse:Security / UsernameToken，密码以 XML 文本出现（假值）", () => {
  const spec = wire(soapRequest({}, {
    wsSecurity: true,
    username: FAKE_USER,
    password: FAKE_PASSWORD,
  }));
  const content = String(spec.body.content);
  assert.match(content, /<wsse:Security/);
  assert.match(content, /<wsse:UsernameToken>/);
  assert.match(content, /#PasswordText/);
  assert.ok(content.includes(FAKE_USER), "应包含假用户名常量");
  assert.ok(content.includes(FAKE_PASSWORD), "WS-Security 密码应以 XML 文本出现");
  assert.equal(spec.body.type, "raw");
});

test("WS-Security：envelope 已含 <wsse:Security 时不重复注入", () => {
  const withWsse = `<soap:Envelope xmlns:soap="${SOAP_NS_11}" xmlns:wsse="urn:wsse"><soap:Header><wsse:Security><wsse:UsernameToken/></wsse:Security></soap:Header><soap:Body><Ping/></soap:Body></soap:Envelope>`;
  const spec = wire(soapRequest({}, {
    envelope: withWsse,
    wsSecurity: true,
    username: FAKE_USER,
    password: FAKE_PASSWORD,
  }));
  const content = String(spec.body.content);
  // 只统计开标签：不重复注入意味着恰好一个 <wsse:Security> 起始元素，
  // 且 envelope 原样保留（未被 soapProjection 重建）。
  assert.equal((content.match(/<wsse:Security/g) ?? []).length, 1);
  assert.equal(content, withWsse);
});

test("WS-Security：wsSecurity 为 false 时按普通 envelope 投影，不注入 wsse", () => {
  const spec = wire(soapRequest({}, { wsSecurity: false }));
  assert.equal(spec.body.content, SOAP11_ENVELOPE);
  assert.ok(!String(spec.body.content).includes("wsse:Security"));
});

/* -------------------------------------------------------------------------- */
/* 5. 非 SOAP 回归 + toWireAuth                                                */
/* -------------------------------------------------------------------------- */

test("非 SOAP：method / headers / query / body / auth / url 与旧行为一致", () => {
  const request = baseRequest({
    method: "POST",
    body: { type: "json", content: '{"a":1}' },
    auth: { type: "bearer", token: "T" },
  });
  const spec = wire(request, { timeoutSecs: 12 });
  assert.equal(spec.method, "POST");
  assert.deepEqual(spec.headers, request.headers);
  assert.deepEqual(spec.query, request.query);
  assert.deepEqual(spec.body, request.body);
  assert.deepEqual(spec.auth, { type: "bearer", token: "T" });
  assert.equal(spec.url, request.url);
  assert.equal(spec.timeoutSecs, 12);
  assert.equal(spec.useCookies, true);
});

test("toWireAuth：inherit 降级为 none，auth 缺省也是 none", () => {
  assert.deepEqual(wire(baseRequest({ auth: { type: "inherit" } })).auth, { type: "none" });
  assert.deepEqual(wire(baseRequest({ auth: undefined })).auth, { type: "none" });
});

test("settings：网络项透传，proxyUrl 去空白且空串归为 undefined", () => {
  const spec = wire(baseRequest(), {
    timeoutSecs: 9,
    followRedirects: false,
    verifyTls: false,
    manageCookies: false,
    proxyUrl: "  http://proxy.test:8080  ",
  });
  assert.equal(spec.timeoutSecs, 9);
  assert.equal(spec.followRedirects, false);
  assert.equal(spec.verifyTls, false);
  assert.equal(spec.useCookies, false);
  assert.equal(spec.proxyUrl, "http://proxy.test:8080");
  assert.equal(wire(baseRequest(), { proxyUrl: "   " }).proxyUrl, undefined);
});

/* -------------------------------------------------------------------------- */
/* 6. wireVariables 归一化                                                     */
/* -------------------------------------------------------------------------- */

test("wireVariables：undefined / 数字 / null / 布尔归一化为字符串", () => {
  assert.deepEqual(
    wireVariables({ a: undefined, b: 42, c: 0, d: null, e: false, f: "x" }),
    { a: "", b: "42", c: "0", d: "", e: "false", f: "x" },
  );
});

test("wireVariables：undefined/null 输入返回空对象，toWireSpec 使用归一化结果", () => {
  assert.deepEqual(wireVariables(undefined), {});
  assert.deepEqual(wireVariables(null), {});
  assert.deepEqual(wire(baseRequest(), {}, { A: 7, B: null }).variables, { A: "7", B: "" });
});
