// T0.2 验收：redactFreeText 从「只认已知形态」改为 fail-closed 兜底。
//
// 所有凭据样例都在运行时拼接，避免在测试源码里留下完整的敏感字面串
// （与 test/authRedaction.test.mjs 相同的约定）。
import test from "node:test";
import assert from "node:assert/strict";

import { redactFreeText } from "../src/lib/redact.ts";

// --------------------------------------------------------------- 样例构造 ----

// ≥24 位、混合大小写 + 数字、无 base64 标点的高熵串（未知键兜底的主要目标）。
const MIXED = ["aB3d", "E5fG", "7hJ9", "kL2m", "N4pQ", "6rS8", "tU0v", "WxYz"].join("");
// 32 位纯 hex。
const HEX32 = ["9f8a", "7b6c", "5d4e", "3f2a", "1b0c", "9d8e", "7f6a", "5b4c"].join("");
// 短、毫无「密钥长相」的纯文本值 —— 用于验证「不论值长什么样都打码」。
const PLAIN = ["hun", "ter", "2"].join("");
// 运行时生成的 base64。
const B64 = Buffer.from(["user", "name", ":", "pass", "word", "-", "1234567890"].join("")).toString("base64");
const PEM = [
  "-----BEGIN ", "RSA ", "PRIVATE KEY-----", "\n",
  "MIIEow", "IBAAKCAQEA", "example", "\n",
  "-----END ", "RSA ", "PRIVATE KEY-----",
].join("");
const UUID = ["550e8400", "-", "e29b", "-", "41d4", "-", "a716", "-", "446655440000"].join("");
// 连接串与 userinfo 里的口令片段。
const DBPASS = ["S3", "cr", "3t"].join("");

// --------------------------------------------------------------- 用例表 ----

/**
 * 每项：形态名 / 原始文本 / 必须消失的凭据值 / 必须保留的非敏感上下文。
 * 覆盖 ≥10 类非标准凭据形态；`keep` 同时承担「脱敏后仍能保留非敏感上下文」
 * 的断言。
 */
const SHAPES = [
  {
    name: "自定义 header（键名不含敏感词，靠高熵兜底）",
    text: "X-Custom-Auth: " + MIXED,
    secrets: [MIXED],
    keep: ["X-Custom-Auth", ": "],
  },
  {
    name: "base64（api_key 赋值）",
    text: "api_key = " + B64,
    secrets: [B64],
    keep: ["api_key", "="],
  },
  {
    name: "DB 连接串（postgres://user:pass@host）",
    text: "connectionString: postgres://admin:" + DBPASS + "@db.internal:5432/app",
    secrets: [DBPASS, "admin:"],
    keep: ["connectionString"],
  },
  {
    name: "URL query 串里的 token",
    text: "GET /v1/orders?token=" + MIXED + "&page=2",
    secrets: [MIXED],
    keep: ["/v1/orders", "page=2"],
  },
  {
    name: "粘贴日志（多行、含方案词与时间戳）",
    text: [
      "[2026-11-14 03:00:00] INFO POST /v1/login",
      "X-Trace-Id: " + UUID,
      "Authorization: Bearer " + MIXED,
      "password = " + PLAIN,
    ].join("\n"),
    secrets: [MIXED, PLAIN],
    keep: ["[2026-11-14 03:00:00]", "POST /v1/login", "X-Trace-Id", UUID],
  },
  {
    name: "YAML key: value",
    text: "client_secret: " + HEX32,
    secrets: [HEX32],
    keep: ["client_secret"],
  },
  {
    name: "curl -H 自定义头",
    text: "curl -H 'X-Api-Key: " + MIXED + "' https://api.example.com/v1",
    secrets: [MIXED],
    keep: ["curl -H", "X-Api-Key", "https://api.example.com/v1"],
  },
  {
    name: "多行 PEM 私钥块",
    text: PEM,
    secrets: ["MIIEow", "BEGIN RSA PRIVATE KEY"],
    keep: [],
  },
  {
    name: "X-Api-Key 头（键名命中 api[_-]?key）",
    text: "X-Api-Key: " + PLAIN,
    secrets: [PLAIN],
    keep: ["X-Api-Key"],
  },
  {
    name: "未知键名的高熵串（blob = ...）",
    text: "blob = " + MIXED,
    secrets: [MIXED],
    keep: ["blob", "="],
  },
  {
    name: 'JSON `"key": "value"`',
    text: '{"access_token": "' + MIXED + '", "id": 42}',
    secrets: [MIXED],
    keep: ["access_token", '"id": 42'],
  },
  {
    name: "Header: value（Authorization）",
    text: "Authorization: " + MIXED,
    secrets: [MIXED],
    keep: ["Authorization"],
  },
  {
    name: "中文键名「密钥」",
    text: "密钥: " + MIXED,
    secrets: [MIXED],
    keep: ["密钥"],
  },
  {
    name: "://user:pass@host 连接串",
    text: "referer: https://admin:" + DBPASS + "@api.example.com/v1",
    secrets: [DBPASS],
    keep: ["api.example.com/v1"],
  },
  {
    name: '带引号赋值 `token="..."`',
    text: 'refresh_token="' + MIXED + '"',
    secrets: [MIXED],
    keep: ["refresh_token"],
  },
];

// --------------------------------------------------------------- T0.2 -----

test("T0.2 覆盖 ≥10 类非标准凭据形态：未知键 / 未知形态默认打码", () => {
  assert.ok(SHAPES.length >= 10, "用例表必须覆盖至少 10 类形态");
  for (const shape of SHAPES) {
    const out = redactFreeText(shape.text);
    assert.notEqual(out, shape.text, `${shape.name}：应当发生脱敏`);
    for (const secret of shape.secrets) {
      assert.ok(!out.includes(secret), `${shape.name}：凭据值 ${JSON.stringify(secret)} 必须被打码`);
    }
    for (const context of shape.keep) {
      assert.ok(out.includes(context), `${shape.name}：非敏感上下文 ${JSON.stringify(context)} 必须保留`);
    }
  }
});

test("T0.2 敏感键名驱动的值级打码：不论值长什么样都替换", () => {
  // 纯文本短值、纯 hex、base64 三种截然不同的形态，命中敏感键后一律打码。
  const cases = [
    ["Cookie: " + PLAIN, "Cookie"],
    ["passwd=" + HEX32, "passwd"],
    ["client_secret = " + B64, "client_secret"],
    ["set-cookie: " + PLAIN, "set-cookie"],
    ["口令：" + PLAIN, "口令"],
  ];
  for (const [text, key] of cases) {
    const out = redactFreeText(text);
    assert.ok(!out.includes(PLAIN) && !out.includes(HEX32) && !out.includes(B64),
      `${key}：值必须被替换`);
    assert.ok(out.includes(key), `${key}：键名属于结构，必须保留`);
    assert.match(out, /\{\{[^}]+\}\}|<redacted[^>]*>/, `${key}：必须留下语义占位符`);
  }
});

test("T0.2 {{token}} 等模板占位符不被误伤", () => {
  const samples = [
    "Bearer {{token}}",
    "{{apiKey}}",
    "{{token}} {{password}} {{baseUrl}}",
    "const key = '{{token}}';",
    '{"username":"demo","password":"{{password}}"}',
    "https://{{baseUrl}}/v1/{{entity}}?page=2",
    "单击「Token」按钮刷新 {{token}}",
    "x-amz-security-token: {{token}}",
  ];
  for (const text of samples) {
    assert.equal(redactFreeText(text), text, `占位符必须原样保留：${text}`);
  }
});

test("T0.2 幂等：对已脱敏文本再跑一次结果不变", () => {
  for (const shape of SHAPES) {
    const once = redactFreeText(shape.text);
    const twice = redactFreeText(once);
    assert.equal(twice, once, `${shape.name}：二次脱敏不得改变结果`);
  }
  // 已知形态正则产物 + fail-closed 产物混在同一段文本里也保持幂等。
  const mixedText = [
    "Bearer " + MIXED,
    "token=" + MIXED + "&page=2",
    "X-Api-Key: " + PLAIN,
    "Authorization: Bearer {{token}}",
  ].join("\n");
  const once = redactFreeText(mixedText);
  assert.equal(redactFreeText(once), once);
});

test("T0.2 脱敏后仍能保留非敏感上下文", () => {
  const log = [
    "2026-11-14 03:00:00 INFO POST /v1/orders status=200",
    "X-Request-Id: " + UUID,
    "Authorization: " + MIXED,
    "note: 这是一段普通说明文字，不含任何凭据。",
  ].join("\n");
  const out = redactFreeText(log);
  assert.ok(!out.includes(MIXED));
  for (const context of [
    "2026-11-14 03:00:00",
    "INFO POST /v1/orders",
    "status=200",
    "X-Request-Id",
    UUID,
    "这是一段普通说明文字",
  ]) {
    assert.ok(out.includes(context), `非敏感上下文 ${JSON.stringify(context)} 必须保留`);
  }
});

test("T0.2 不误伤：正常 URL 路径 / JSON 键名 / UUID 项目 id / 普通标识符", () => {
  const samples = [
    "https://api.example.com/v1/users",
    "https://api.example.com/v1/orders/" + UUID,
    '{"accessToken": "", "contentType": "application/json"}',
    "const getUserInfoByAccessTokenAndScope = 1;",
    "some_long_snake_case_identifier_for_readability = 2;",
    "authorizationCodeGrantFlow", // 普通含敏感词的标识符本身不被替换
    "下单 {{token}} 按钮刷新",
  ];
  for (const text of samples) {
    assert.equal(redactFreeText(text), text, `不得误伤：${text}`);
  }
});

test("T0.2 已知形态的既有输出保持不变（回归保护）", () => {
  // 这些断言与 test/redact.test.mjs / test/authRedaction.test.mjs 的口径一致：
  // fail-closed 层不能把 `<redacted...>` 系列标记改写成别的形态。
  assert.match(redactFreeText("https://api.x.dev/v1?token=" + MIXED + "&page=2"), /\?token=<redacted>/);
  assert.match(redactFreeText("refresh_token=" + PLAIN), /refresh_token=<redacted>/);
  assert.match(redactFreeText("x-amz-security-token: " + B64), /<redacted>/);
  assert.match(redactFreeText(PEM), /<redacted-private-key>/);
  assert.match(redactFreeText("id=" + "AKIA" + "0".repeat(16)), /<redacted-key>/);
});
