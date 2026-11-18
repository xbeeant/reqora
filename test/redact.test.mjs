// 上传快照的深度脱敏纯函数：结构化字段、自由文本模式、原值不被修改。
import test from "node:test";
import assert from "node:assert/strict";
import {
  SENSITIVE_NAME,
  redactAuth,
  redactFreeText,
  redactSnapshot,
  restoreRedacted,
} from "../src/lib/redact.ts";
import { emptySnapshot, normalizeSnapshot } from "../src/lib/defaults.ts";
import { applyEnvMerge } from "../src/lib/environment.ts";

const row = (key, value, extra = {}) => ({
  id: `row-${key}`,
  key,
  value,
  enabled: true,
  ...extra,
});

test("自由文本中的常见凭据形态会被替换", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  assert.match(redactFreeText(`token: ${jwt}`), /<redacted-jwt>/);
  assert.match(redactFreeText("key = sk-abcdefghijklmnopqrstuvwxyz123456"), /<redacted-key>/);
  assert.match(redactFreeText("Authorization: Bearer abcdefghijklmnop1234"), /Bearer <redacted>/);
  assert.match(redactFreeText("AKIAIOSFODNN7EXAMPLE"), /<redacted-key>/);
  assert.match(
    redactFreeText("mysql://root:pass@127.0.0.1:3306/app"),
    /<redacted-connection>/,
  );
  assert.match(redactFreeText("https://api.x.dev/v1?token=abcdef123456&page=2"), /\?token=<redacted>/);
  assert.match(redactFreeText("https://user:pass@api.x.dev"), /<redacted>@/);
});

test("模板变量与普通英文不会被误伤", () => {
  assert.equal(redactFreeText("Bearer {{token}}"), "Bearer {{token}}");
  assert.equal(redactFreeText("https://api.example.com/v1/users"), "https://api.example.com/v1/users");
  assert.equal(redactFreeText("{{apiKey}}"), "{{apiKey}}");
  assert.equal(redactFreeText("单击「Token」按钮刷新"), "单击「Token」按钮刷新");
  assert.equal(SENSITIVE_NAME.test("baseUrl"), false);
  assert.equal(SENSITIVE_NAME.test("token"), true);
});

test("redactAuth 保留结构、清空凭据，且覆盖未来的鉴权变体", () => {
  assert.deepEqual(redactAuth({ type: "bearer", token: "secret" }), {
    type: "bearer",
    token: "",
  });
  assert.deepEqual(redactAuth({ type: "basic", username: "alice", password: "p" }), {
    type: "basic",
    username: "alice",
    password: "",
  });
  assert.deepEqual(
    redactAuth({ type: "apiKey", key: "X-Api-Key", value: "v", location: "header" }),
    { type: "apiKey", key: "X-Api-Key", value: "", location: "header" },
  );
  // OAuth2 / SigV4 之后新增变体时，未知的字符串字段一律清空。
  assert.deepEqual(
    redactAuth({
      type: "oauth2",
      clientId: "public-id",
      clientSecret: "shh",
      tokenUrl: "https://sso.example.com/token",
      accessToken: "abc",
    }),
    {
      type: "oauth2",
      clientId: "",
      clientSecret: "",
      tokenUrl: "https://sso.example.com/token",
      accessToken: "",
    },
  );
});

test("递归脱敏覆盖所有嵌套位置，且不修改原对象", () => {
  const input = {
    collections: [
      {
        id: "c1",
        name: "示例",
        auth: { type: "bearer", token: "col-secret" },
        items: [
          {
            id: "r1",
            auth: { type: "basic", username: "u", password: "req-secret" },
            headers: [row("Authorization", "Bearer abc")],
            url: "https://api.x.dev/v1?token=abcdef123456",
            body: { type: "json", content: '{"jwt":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"}' },
          },
        ],
      },
    ],
    cases: [{ id: "k1", request: { auth: { type: "bearer", token: "case-secret" } } }],
    scenarios: [
      {
        id: "s1",
        steps: [
          {
            id: "st1",
            source: {
              kind: "inline",
              request: { auth: { type: "bearer", token: "inline-secret" } },
            },
          },
          { id: "st2", source: { kind: "db", db: { url: "mysql://u:p@h/db", sql: "select 1" } } },
        ],
        dataSet: { columns: ["token", "userId"], rows: [{ token: "ds-secret", userId: "42" }] },
      },
    ],
    revisions: {
      r1: [{ id: "rev1", at: 1, snapshot: { auth: { type: "bearer", token: "rev-secret" } } }],
    },
    environments: [
      {
        id: "e1",
        variables: [
          row("token", "env-secret"),
          row("token", "shared-on-purpose", { secret: false }),
          row("apiKeyName", "forced", { secret: true }),
          row("baseUrl", "https://api.example.com"),
        ],
      },
    ],
    docPages: [{ id: "d1", body: "把 sk-abcdefghijklmnopqrstuvwxyz123456 填进去" }],
  };
  const before = JSON.stringify(input);
  const output = redactSnapshot(input);

  assert.equal(JSON.stringify(input), before, "原始快照不得被修改");
  assert.equal(output.collections[0].items[0].auth.password, "");
  assert.equal(output.collections[0].auth.token, "");
  assert.equal(output.collections[0].items[0].headers[0].value, "");
  assert.equal(output.cases[0].request.auth.token, "");
  assert.equal(output.scenarios[0].steps[0].source.request.auth.token, "");
  assert.equal(output.scenarios[0].steps[1].source.db.url, "");
  assert.equal(output.scenarios[0].steps[1].source.db.sql, "select 1", "SQL 保留");
  assert.equal(output.scenarios[0].dataSet.rows[0].token, "");
  assert.equal(output.scenarios[0].dataSet.rows[0].userId, "42", "普通数据行保留");
  assert.equal(output.revisions.r1[0].snapshot.auth.token, "");
  assert.equal(output.environments[0].variables[0].value, "");
  assert.equal(
    output.environments[0].variables[1].value,
    "shared-on-purpose",
    "secret:false 是显式共享",
  );
  assert.equal(output.environments[0].variables[2].value, "", "secret:true 强制脱敏");
  assert.equal(output.environments[0].variables[3].value, "https://api.example.com");
  assert.match(output.collections[0].items[0].url, /token=<redacted>/);
  assert.match(output.collections[0].items[0].body.content, /<redacted-jwt>/);
  assert.match(output.docPages[0].body, /<redacted-key>/);

  const serialised = JSON.stringify(output);
  for (const secret of [
    "col-secret",
    "req-secret",
    "case-secret",
    "inline-secret",
    "rev-secret",
    "env-secret",
    "ds-secret",
    "Bearer abc",
  ]) {
    assert.ok(!serialised.includes(secret), `脱敏结果不得包含 ${secret}`);
  }
});

test("redactSnapshot 容忍 null / 原始值 / 数组", () => {
  assert.equal(redactSnapshot(null), null);
  assert.equal(redactSnapshot(42), 42);
  assert.deepEqual(redactSnapshot(["a", 1, null]), ["a", 1, null]);
  assert.deepEqual(redactSnapshot({}), {});
});

test("快照归一化保留 KeyValue.secret 三态（含 pathVariables）", () => {
  const raw = {
    ...emptySnapshot(),
    collections: [
      {
        id: "c1",
        name: "C",
        items: [
          {
            id: "r1",
            name: "接口",
            method: "GET",
            url: "{{baseUrl}}/u/:id",
            headers: [row("Authorization", "Bearer live", { secret: false })],
            query: [row("page", "1", { secret: true })],
            pathVariables: [row("token", "path-live", { secret: false }), row("id", "7")],
            body: { type: "none" },
            auth: { type: "none" },
          },
        ],
      },
    ],
  };
  const normalized = normalizeSnapshot(raw);
  const request = normalized.collections[0].items[0];
  assert.equal(request.pathVariables[0].secret, false, "pathVariables 归一化不得丢标记");
  assert.equal(request.pathVariables[1].secret, undefined, "未设置时不要凭空加 key");
  assert.equal(request.headers[0].secret, false);
  assert.equal(request.query[0].secret, true);

  const redacted = redactSnapshot(normalized);
  const out = redacted.collections[0].items[0];
  assert.equal(out.pathVariables[0].value, "path-live", "secret:false 显式共享");
  assert.equal(out.pathVariables[1].value, "7");
  assert.equal(out.headers[0].value, "Bearer live", "secret:false 覆盖敏感名");
  assert.equal(out.query[0].value, "", "secret:true 强制脱敏");
});

test("环境对比合并保留来源行的 secret 三态", () => {
  const target = [
    row("baseUrl", "https://a"),
    row("token", "target-secret", { secret: false }),
  ];
  const source = [
    row("token", "source-secret", { secret: true }),
    row("apiKey", "source-key", { secret: false }),
  ];
  const merged = applyEnvMerge(target, source, ["token", "apiKey"], true);
  assert.equal(
    merged.find((item) => item.key === "token").secret,
    true,
    "覆盖值时来源的脱敏标记必须随值迁移",
  );
  const added = merged.find((item) => item.key === "apiKey");
  assert.equal(added.secret, false, "新增行继承来源标记");
  assert.equal(added.value, "source-key");
  assert.equal(merged.find((item) => item.key === "baseUrl").secret, undefined);
});

test("restoreRedacted 是脱敏的逆操作：结构化凭据与自由文本都能回填", () => {
  const local = {
    folder: {
      id: "c1",
      name: "用户服务",
      auth: { type: "basic", username: "alice", password: "p@ss" },
    },
    request: {
      id: "r1",
      name: "登录",
      auth: { type: "bearer", token: "real-token" },
      headers: [row("Authorization", "Bearer abcdefghijklmnop1234")],
      variables: [row("baseUrl", "https://api.example.com")],
      doc: "连接串 mysql://root:pass@127.0.0.1:3306/app",
      note: "Authorization: Bearer abcdefghijklmnop1234",
      // 敏感命名的标量字段直接清空。
      clientSecret: "shh",
    },
    environment: {
      id: "e1",
      variables: [row("API_KEY", "env-secret"), row("baseUrl", "https://t")],
    },
    db: { url: "mysql://root:pass@127.0.0.1/app", sql: "select 1" },
  };

  const redacted = redactSnapshot(local);
  assert.equal(redacted.request.auth.token, "");
  assert.equal(redacted.request.clientSecret, "");
  assert.equal(redacted.request.headers[0].value, "", "敏感 KeyValue 直接清空");
  assert.match(redacted.request.doc, /<redacted-connection>/);
  assert.match(redacted.request.note, /Bearer <redacted>/);
  assert.equal(redacted.environment.variables[0].value, "");

  assert.deepEqual(restoreRedacted(redacted, local), local, "空位全部按本地回填");
});

test("restoreRedacted 不会覆盖远端协作者的编辑", () => {
  const local = {
    request: {
      id: "r1",
      name: "登录",
      auth: { type: "bearer", token: "local-token" },
      headers: [row("Authorization", "Bearer abcdefghijklmnop1234")],
    },
  };
  const redacted = redactSnapshot(local);
  const remote = {
    ...redacted,
    request: {
      ...redacted.request,
      name: "远端改名",
      url: "https://remote.example.com/login",
      // 远端把 token 明确改成了一个新值：它不是脱敏空位，必须保留。
      auth: { type: "bearer", token: "remote-token" },
    },
  };
  const restored = restoreRedacted(remote, local);
  assert.equal(restored.request.name, "远端改名");
  assert.equal(restored.request.url, "https://remote.example.com/login");
  assert.equal(restored.request.auth.token, "remote-token");
});
