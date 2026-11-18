/**
 * soap.ts 测试：WSDL 1.1 解析（document/rpc/soap12/前缀/单引号/缺 binding/DTD）、
 * Content-Type / SOAPAction、Envelope 构建、WS-Security（同步 SHA-256）、
 * Fault 解析、prettifyXml、转义、WSDL → HTTP 请求草稿。
 *
 * Node 22 原生剥离 TS 类型，测试直接 import 生产模块，零编译、零依赖。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  parseWsdl,
  soapContentType,
  soapActionHeader,
  buildWsseHeader,
  buildSoapEnvelope,
  parseSoapFault,
  prettifyXml,
  escapeXml,
  wsdlOperationsToRequests,
  sha256Hex,
} from "../src/lib/soap.ts";

/* -------------------------------------------------------------------------- */
/* WSDL 样例                                                                   */
/* -------------------------------------------------------------------------- */

const WSDL_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
             xmlns:tns="urn:calc" xmlns:xsd="http://www.w3.org/2001/XMLSchema"
             targetNamespace="urn:calc">
  <types><xsd:schema targetNamespace="urn:calc">
    <xsd:element name="Add"><xsd:complexType><xsd:sequence>
      <xsd:element name="a" type="xsd:int"/><xsd:element name="b" type="xsd:int"/>
    </xsd:sequence></xsd:complexType></xsd:element>
  </xsd:schema></types>
  <message name="AddRequest"><part name="parameters" element="tns:Add"/></message>
  <message name="AddResponse"><part name="parameters" element="tns:AddResponse"/></message>
  <portType name="CalcPortType">
    <operation name="Add"><input message="tns:AddRequest"/><output message="tns:AddResponse"/></operation>
  </portType>
  <binding name="CalcBinding" type="tns:CalcPortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="Add">
      <soap:operation soapAction="urn:calc#Add" style="document"/>
      <input><soap:body use="literal"/></input>
      <output><soap:body use="literal"/></output>
    </operation>
  </binding>
  <service name="CalcService">
    <port name="CalcPort" binding="tns:CalcBinding"><soap:address location="http://localhost:8080/soap/calc"/></port>
  </service>
</definitions>`;

const WSDL_RPC = `<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
             xmlns:tns="urn:calc" targetNamespace="urn:calc">
  <message name="AddRequest"><part name="a" type="xsd:int"/><part name="b" type="xsd:int"/></message>
  <message name="AddResponse"><part name="result" type="xsd:int"/></message>
  <portType name="CalcPortType">
    <operation name="Add"><input message="tns:AddRequest"/><output message="tns:AddResponse"/></operation>
  </portType>
  <binding name="CalcRpcBinding" type="tns:CalcPortType">
    <soap:binding style="rpc" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="Add">
      <soap:operation soapAction=""/>
      <input><soap:body use="encoded" namespace="urn:calc:rpc"/></input>
      <output><soap:body use="encoded" namespace="urn:calc:rpc"/></output>
    </operation>
  </binding>
  <service name="S"><port name="P" binding="tns:CalcRpcBinding"><soap:address location="http://localhost:8080/rpc"/></port></service>
</definitions>`;

const WSDL_SOAP12 = `<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/"
             xmlns:tns="urn:c12" targetNamespace="urn:c12">
  <message name="R"><part name="v" type="xsd:string"/></message>
  <portType name="P"><operation name="Ping"><input message="tns:R"/></operation></portType>
  <binding name="B" type="tns:P">
    <soap12:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="Ping">
      <soap12:operation soapAction="urn:ping"/>
      <input><soap12:body use="literal"/></input>
    </operation>
  </binding>
  <service name="S"><port name="P1" binding="tns:B"><soap12:address location="http://x/12"/></port></service>
</definitions>`;

/** 带 wsdl: 前缀 + 单引号属性 + 无引号属性值。 */
const WSDL_PREFIX_QUOTES = `<wsdl:definitions xmlns:wsdl='http://schemas.xmlsoap.org/wsdl/'
             xmlns:soap='http://schemas.xmlsoap.org/wsdl/soap/'
             xmlns:tns='urn:q' targetNamespace='urn:q'>
  <wsdl:message name='Q'><wsdl:part name='v' type='xsd:string'/></wsdl:message>
  <wsdl:portType name='P'><wsdl:operation name='Go'><wsdl:input message='tns:Q'/></wsdl:operation></wsdl:portType>
  <wsdl:binding name='B' type='tns:P'>
    <soap:binding style=document transport='http://schemas.xmlsoap.org/soap/http'/>
    <wsdl:operation name='Go'><soap:operation soapAction='urn:go'/><wsdl:input><soap:body use='literal'/></wsdl:input></wsdl:operation>
  </wsdl:binding>
  <wsdl:service name='S'><wsdl:port name='P1' binding='tns:B'><soap:address location='http://x/q'/></wsdl:port></wsdl:service>
</wsdl:definitions>`;

const WSDL_NO_BINDING = `<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
             xmlns:tns="urn:nb" targetNamespace="urn:nb">
  <message name="M"><part name="v" type="xsd:string"/></message>
  <portType name="P"><operation name="Op"><input message="tns:M"/></operation></portType>
  <service name="S"><port name="P1" binding="tns:Missing"><soap:address location="http://x/nb"/></port></service>
</definitions>`;

/* -------------------------------------------------------------------------- */
/* parseWsdl                                                                   */
/* -------------------------------------------------------------------------- */

test("parseWsdl：document/literal 完整样例串联 operation→binding→portType→message/part", () => {
  const info = parseWsdl(WSDL_DOC);
  assert.equal(info.targetNamespace, "urn:calc");
  assert.equal(info.version, "1.1");
  assert.equal(info.endpoint, "http://localhost:8080/soap/calc");
  assert.deepEqual(info.warnings, []);
  assert.equal(info.operations.length, 1);
  const op = info.operations[0];
  assert.equal(op.name, "Add");
  assert.equal(op.soapAction, "urn:calc#Add");
  assert.equal(op.namespace, "urn:calc");
  assert.equal(op.style, "document");
  assert.equal(op.version, "1.1");
  assert.equal(op.endpoint, "http://localhost:8080/soap/calc");
  assert.equal(op.inputElement, "tns:Add");
  assert.equal(op.inputParts.length, 1);
  assert.equal(op.inputParts[0].name, "parameters");
  assert.equal(op.inputParts[0].element, "tns:Add");
});

test("parseWsdl：rpc 风格 + soapAction 为空回退 namespace+operation + soap:body@namespace 覆盖", () => {
  const info = parseWsdl(WSDL_RPC);
  assert.equal(info.version, "1.1");
  assert.deepEqual(info.warnings, []);
  const op = info.operations[0];
  assert.equal(op.style, "rpc");
  assert.equal(op.namespace, "urn:calc:rpc");
  assert.equal(op.soapAction, "urn:calc:rpc/Add", "空 soapAction 应回退为 命名空间/操作名");
  assert.equal(op.inputParts.length, 2);
  assert.deepEqual(op.inputParts, [
    { name: "a", type: "xsd:int" },
    { name: "b", type: "xsd:int" },
  ]);
  assert.equal(op.inputElement, undefined);
  assert.equal(op.endpoint, "http://localhost:8080/rpc");
});

test("parseWsdl：soap12 命名空间识别为 SOAP 1.2", () => {
  const info = parseWsdl(WSDL_SOAP12);
  assert.equal(info.version, "1.2");
  assert.equal(info.targetNamespace, "urn:c12");
  assert.deepEqual(info.warnings, []);
  const op = info.operations[0];
  assert.equal(op.name, "Ping");
  assert.equal(op.version, "1.2");
  assert.equal(op.soapAction, "urn:ping");
  assert.equal(op.endpoint, "http://x/12");
});

test("parseWsdl：命名空间前缀 + 单引号/双引号/无引号属性 + 自闭合标签", () => {
  const info = parseWsdl(WSDL_PREFIX_QUOTES);
  assert.equal(info.targetNamespace, "urn:q");
  assert.equal(info.version, "1.1");
  assert.deepEqual(info.warnings, []);
  assert.equal(info.operations.length, 1);
  assert.equal(info.operations[0].name, "Go");
  assert.equal(info.operations[0].soapAction, "urn:go");
  assert.equal(info.operations[0].endpoint, "http://x/q");
});

test("parseWsdl：缺 binding 时给出 warnings 而不是抛错", () => {
  const info = parseWsdl(WSDL_NO_BINDING);
  assert.equal(info.operations.length, 0);
  assert.ok(info.warnings.length > 0, "应至少有一条 warning");
  assert.ok(info.warnings.some((w) => /binding/i.test(w)), "warning 应提示缺少 binding");
});

test("parseWsdl：DOCTYPE 直接抛中文错误（XXE 防护）", () => {
  const xml = `<?xml version="1.0"?>\n<!DOCTYPE definitions [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>\n` + WSDL_DOC;
  assert.throws(() => parseWsdl(xml), (err) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /XXE|DOCTYPE|ENTITY|拒绝/);
    return true;
  });
});

test("parseWsdl：<!ENTITY> 直接抛中文错误", () => {
  const xml = `<!ENTITY x "boom">\n` + WSDL_DOC;
  assert.throws(() => parseWsdl(xml), /XXE|ENTITY|拒绝/);
});

/* -------------------------------------------------------------------------- */
/* Content-Type / SOAPAction                                                   */
/* -------------------------------------------------------------------------- */

test("soapContentType：1.1 与 1.2", () => {
  assert.equal(soapContentType("1.1"), "text/xml; charset=utf-8");
  assert.equal(soapContentType("1.2"), "application/soap+xml; charset=utf-8");
});

test("soapActionHeader：1.1 → SOAPAction；1.2 → Content-Type 带 action 参数", () => {
  assert.deepEqual(soapActionHeader({ soapAction: "urn:Add", version: "1.1" }), {
    key: "SOAPAction", value: "urn:Add",
  });
  assert.deepEqual(soapActionHeader({ soapAction: "urn:Add", version: "1.2" }), {
    key: "Content-Type",
    value: 'application/soap+xml; charset=utf-8; action="urn:Add"',
  });
});

/* -------------------------------------------------------------------------- */
/* buildSoapEnvelope                                                           */
/* -------------------------------------------------------------------------- */

test("buildSoapEnvelope：SOAP 1.1 命名空间与结构", () => {
  const env = buildSoapEnvelope({ version: "1.1", operation: "Add", namespace: "urn:calc", parameters: { a: 1, b: 2 } });
  assert.match(env, /<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(env, /xmlns:soap="http:\/\/schemas\.xmlsoap\.org\/soap\/envelope\/"/);
  assert.match(env, /<soap:Envelope/);
  assert.match(env, /<soap:Body>/);
  assert.match(env, /<Add xmlns="urn:calc">/);
  assert.match(env, /<a>1<\/a>/);
  assert.match(env, /<b>2<\/b>/);
  assert.match(env, /<\/soap:Envelope>$/);
});

test("buildSoapEnvelope：SOAP 1.2 命名空间", () => {
  const env = buildSoapEnvelope({ version: "1.2", operation: "Ping" });
  assert.match(env, /xmlns:soap="http:\/\/www\.w3\.org\/2003\/05\/soap-envelope"/);
  assert.match(env, /<soap:Body>/);
  assert.match(env, /<Ping\/>/);
});

test("buildSoapEnvelope：参数转义 + 嵌套对象/数组 + @ 属性", () => {
  const env = buildSoapEnvelope({
    version: "1.1", operation: "Echo", namespace: "urn:t",
    parameters: {
      q: 'a & b <c> "d" \'e\'',
      nested: { x: 1, items: [2, 3] },
      "@id": 7,
    },
  });
  assert.match(env, /a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;/);
  assert.match(env, /<Echo xmlns="urn:t" id="7">/);
  assert.match(env, /<nested>/);
  assert.match(env, /<x>1<\/x>/);
  assert.equal((env.match(/<items>/g) || []).length, 2, "数组应生成两个重复元素");
  assert.match(env, /<items>2<\/items>/);
  assert.match(env, /<items>3<\/items>/);
});

test("buildSoapEnvelope：bodyXml 优先于 operation/parameters", () => {
  const env = buildSoapEnvelope({
    version: "1.1", bodyXml: "<custom>raw &amp; text</custom>",
    operation: "Add", parameters: { a: 1 },
  });
  assert.match(env, /<custom>raw &amp; text<\/custom>/);
  assert.ok(!env.includes("<Add"), "不应再生成方法包装元素");
  assert.ok(!env.includes("<a>1</a>"), "不应再生成 parameters");
});

test("buildSoapEnvelope：headerXml 与 WSSE 一起插入 Header", () => {
  const env = buildSoapEnvelope({
    version: "1.1", wsSecurity: true, username: "alice", password: "s3cr&t",
    headerXml: "<trace id=\"t1\"/>", bodyXml: "<ping/>",
  });
  assert.match(env, /<soap:Header>/);
  assert.match(env, /<wsse:Security/);
  assert.match(env, /<wsse:Username>alice<\/wsse:Username>/);
  assert.match(env, /s3cr&amp;t/);
  assert.match(env, /<trace id="t1"\/>/);
  assert.match(env, /<soap:Body>/);
  assert.match(env, /<ping\/>/);
});

/* -------------------------------------------------------------------------- */
/* WS-Security / SHA-256                                                       */
/* -------------------------------------------------------------------------- */

test("buildWsseHeader：PasswordText + 用户名/密码转义", () => {
  const h = buildWsseHeader("alice", "s3cr&t", { passwordType: "PasswordText" });
  assert.match(h, /^<wsse:Security /);
  assert.match(h, /<wsse:UsernameToken>/);
  assert.match(h, /<wsse:Username>alice<\/wsse:Username>/);
  assert.match(h, /#PasswordText"/);
  assert.match(h, />s3cr&amp;t<\/wsse:Password>/);
  assert.ok(!h.includes("wsse:Nonce"), "PasswordText 不应生成 Nonce");
});

test("buildWsseHeader：PasswordDigest = Base64(SHA256(nonce+created+password)) 已知摘要", () => {
  // nonce="a" + created="b" + password="c" => SHA-256("abc")
  const h = buildWsseHeader("bob", "c", { passwordType: "PasswordDigest", nonce: "a", created: "b" });
  const expected = createHash("sha256").update("abc").digest("base64");
  assert.equal(expected, "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
  assert.match(h, /#PasswordDigest"/);
  assert.ok(h.includes(`>${expected}</wsse:Password>`), "摘要应与 node:crypto 一致");
  assert.match(h, /<wsse:Nonce>a<\/wsse:Nonce>/);
  assert.match(h, /<wsu:Created>b<\/wsu:Created>/);
  assert.ok(typeof h === "string" && h.length > 0);
});

test("sha256Hex：已知向量（abc / 空串 / hello world / 中文，并与 node:crypto 对照）", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  for (const s of ["hello world", "中文", "A".repeat(1000)]) {
    assert.equal(sha256Hex(s), createHash("sha256").update(s).digest("hex"), `向量不一致: ${s.slice(0, 10)}`);
  }
});

/* -------------------------------------------------------------------------- */
/* parseSoapFault                                                              */
/* -------------------------------------------------------------------------- */

test("parseSoapFault：SOAP 1.1（faultcode / faultstring / detail）", () => {
  const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault>
    <faultcode>soap:Client</faultcode>
    <faultstring>Invalid &amp; bad request</faultstring>
    <detail><err code="42">oops</err></detail>
  </soap:Fault></soap:Body></soap:Envelope>`;
  const f = parseSoapFault(xml);
  assert.ok(f);
  assert.equal(f.code, "soap:Client");
  assert.equal(f.message, "Invalid & bad request");
  assert.match(f.detail || "", /<err code="42">oops<\/err>/);
});

test("parseSoapFault：SOAP 1.2（Code/Value + Reason/Text + Detail）", () => {
  const xml = `<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body><env:Fault>
    <env:Code><env:Value>env:Sender</env:Value></env:Code>
    <env:Reason><env:Text xml:lang="en">Bad &amp; wrong</env:Text></env:Reason>
    <env:Detail><m:info xmlns:m="urn:m">detail &lt;x&gt;</m:info></env:Detail>
  </env:Fault></env:Body></env:Envelope>`;
  const f = parseSoapFault(xml);
  assert.ok(f);
  assert.equal(f.code, "env:Sender");
  assert.equal(f.message, "Bad & wrong");
  assert.match(f.detail || "", /<m:info xmlns:m="urn:m">/);
});

test("parseSoapFault：非 Fault 返回 null", () => {
  const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><AddResponse><result>3</result></AddResponse></soap:Body></soap:Envelope>`;
  assert.equal(parseSoapFault(xml), null);
});

/* -------------------------------------------------------------------------- */
/* wsdlOperationsToRequests                                                    */
/* -------------------------------------------------------------------------- */

test("wsdlOperationsToRequests：生成可直接发送的 HTTP 请求草稿", () => {
  const info = parseWsdl(WSDL_DOC);
  const reqs = wsdlOperationsToRequests(info);
  assert.equal(reqs.length, 1);
  const r = reqs[0];
  assert.equal(r.name, "Add");
  assert.equal(r.url, "http://localhost:8080/soap/calc");
  assert.equal(r.method, "POST");
  assert.equal(r.headers["Content-Type"], "text/xml; charset=utf-8");
  assert.equal(r.headers["SOAPAction"], "urn:calc#Add");
  assert.match(r.body, /<Add xmlns="urn:calc"\/>/);
  assert.strictEqual(r.soap, info.operations[0]);

  const reqs12 = wsdlOperationsToRequests(parseWsdl(WSDL_SOAP12));
  assert.equal(reqs12.length, 1);
  assert.equal(reqs12[0].method, "POST");
  assert.match(reqs12[0].headers["Content-Type"], /action="urn:ping"/);
  assert.equal(reqs12[0].headers["SOAPAction"], undefined);
  assert.match(reqs12[0].body, /2003\/05\/soap-envelope/);
});

/* -------------------------------------------------------------------------- */
/* prettifyXml / escapeXml                                                     */
/* -------------------------------------------------------------------------- */

test("prettifyXml：缩进格式化且不破坏文本内容（实体、混合内容、CDATA、注释）", () => {
  const out = prettifyXml(`<root><a x="1"><b>t &amp; x</b></a><c/></root>`);
  assert.match(out, /<root>\n {2}<a x="1">/);
  assert.match(out, /<b>t &amp; x<\/b>/, "文本实体原样保留");
  assert.match(out, /<c\/>/, "自闭合标签保留");

  // 混合内容必须原样内联，不能往文本里注入换行/缩进
  const mixed = prettifyXml(`<p>Hello <b>world</b> !</p>`);
  assert.equal(mixed, `<p>Hello <b>world</b> !</p>`);

  const cdata = prettifyXml(`<r><![CDATA[a < b & c]]><!-- hi --><x/></r>`);
  assert.match(cdata, /<!\[CDATA\[a < b & c\]\]>/);
  assert.match(cdata, /<!-- hi -->/);
  assert.match(cdata, /<x\/>/);
});

test("escapeXml：五字符转义且不重复转义", () => {
  assert.equal(escapeXml(`&<>"'`), "&amp;&lt;&gt;&quot;&apos;");
  assert.equal(escapeXml("a & b"), "a &amp; b");
  assert.equal(escapeXml("&amp;"), "&amp;amp;");
  assert.equal(escapeXml(123), "123");
});
