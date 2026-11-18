import test from "node:test";
import assert from "node:assert/strict";
import {
  decryptDocSitePayload,
  encryptDocSitePayload,
  exportDocSiteHtml,
  exportEncryptedDocSiteHtml,
} from "../src/lib/docsite.ts";
import { seedSnapshot } from "../src/lib/defaults.ts";

test("exportDocSiteHtml：debug 选项注入调试按钮与脚本，URL 按环境变量替换", () => {
  const snapshot = seedSnapshot();
  const plain = exportDocSiteHtml(snapshot, "测试文档");
  assert.ok(!plain.includes("debug-btn"));

  const debug = exportDocSiteHtml(snapshot, "测试文档", {
    debug: true,
    variables: { baseUrl: "https://httpbin.org" },
  });
  assert.ok(debug.includes('class="debug-btn"'));
  assert.ok(debug.includes("https://httpbin.org/get"));
  assert.ok(!debug.includes("{{baseUrl}}/get"));
  assert.ok(debug.includes("CORS"));
  // data-url 属性经 HTML 转义（GET 示例带 query，故含 ?page=1）
  assert.ok(debug.includes('data-url="https://httpbin.org/get?page=1"'));
});

test("exportDocSiteHtml：JSON 请求体也做变量替换（data-body）", () => {
  const snapshot = seedSnapshot();
  // 找 POST JSON 示例，其 body 无变量；给 GET 加个带变量的验证——直接构造
  const withVar = {
    ...seedSnapshot(),
    collections: [
      {
        id: "c1",
        name: "调试",
        items: [
          {
            ...seedSnapshot().collections[0].items[0],
            method: "POST",
            url: "{{apiHost}}/v1/echo",
            body: {
              type: "json",
              content: '{"token":"{{token}}"}',
            },
          },
        ],
      },
    ],
  };
  const html = exportDocSiteHtml(withVar, "调试", {
    debug: true,
    variables: { apiHost: "https://api.example.com", token: "secret-123" },
  });
  assert.ok(html.includes("https://api.example.com/v1/echo"));
  assert.ok(html.includes("secret-123"));
  assert.ok(!html.includes("{{token}}"));
});

test("encryptDocSitePayload / decryptDocSitePayload：往返一致，错密码抛错", async () => {
  const secret = "Reqora 文档内容 · secret-中文";
  const payload = await encryptDocSitePayload(secret, "p@ss word");
  assert.equal(typeof payload, "string");
  assert.ok(!payload.includes("secret"));
  const decrypted = await decryptDocSitePayload(payload, "p@ss word");
  assert.equal(decrypted, secret);
  await assert.rejects(
    () => decryptDocSitePayload(payload, "wrong"),
    (error) => error instanceof Error || typeof error === "string",
  );
});

test("exportEncryptedDocSiteHtml：整份文档不可见、内嵌解密器", async () => {
  const snapshot = seedSnapshot();
  const html = await exportEncryptedDocSiteHtml(snapshot, "pass-123", "机密文档");
  assert.ok(html.includes("解锁文档"));
  assert.ok(html.includes("AES-GCM"));
  // 明文内容不出现
  assert.ok(!html.includes("POST JSON 示例"));
  assert.ok(!html.includes("<section"));
  // payload 提取后可解密回原文档
  const match = /<script id="payload" type="text\/plain">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match);
  const decrypted = await decryptDocSitePayload(match[1].trim(), "pass-123");
  assert.ok(decrypted.includes("POST JSON 示例"));
  assert.ok(decrypted.includes("debug-btn"));

  await assert.rejects(() => exportEncryptedDocSiteHtml(snapshot, "  "), /密码不能为空/);
});
