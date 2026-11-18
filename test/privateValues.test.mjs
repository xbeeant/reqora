import test from "node:test";
import assert from "node:assert/strict";

import { emptySnapshot, emptyRequest, normalizeRequest } from "../src/lib/defaults.ts";
import {
  PRIVATE_MASK,
  blankPrivateRows,
  enforcePrivate,
  isPrivateVariable,
  maskPrivateText,
  privateContext,
  shareableVariables,
} from "../src/lib/privateValues.ts";
import { stripForUpload } from "../src/lib/cloudSync.ts";
import {
  restoreRowsCredentials,
  rowsToSnapshot,
  snapshotToRows,
} from "../src/lib/workspaceRows.ts";
import { buildDocSitePayload } from "../src/lib/docSitePayload.ts";
import { exportOpenApi } from "../src/lib/transfer.ts";

const ACCOUNT = "alice@example.com";
const PASSWORD = "s3cr3t-pass";

const row = (id, key, value, extra = {}) => ({
  id,
  key,
  value,
  enabled: true,
  ...extra,
});

function makeSnapshot() {
  const snapshot = emptySnapshot();
  snapshot.activeEnvironmentId = "env-1";
  snapshot.environments = [
    {
      id: "env-1",
      name: "生产",
      updatedAt: 1,
      variables: [
        row("v1", "baseUrl", "https://api.example.com"),
        row("v2", "account", ACCOUNT, { secret: true }),
        row("v3", "password", PASSWORD, { secret: true }),
        row("v4", "publicToken", "public-value", { secret: false }),
        row("v5", "short", "ab", { secret: true }),
      ],
      headers: [],
    },
  ];
  return snapshot;
}

function withRequest(snapshot) {
  const request = normalizeRequest({
    ...emptyRequest(),
    id: "r1",
    name: "示例接口",
    method: "GET",
    url: "{{baseUrl}}/profile?pwd={{password}}",
    query: [row("q1", "pwd", PASSWORD, { secret: true })],
    headers: [],
  });
  snapshot.collections = [{ id: "c1", name: "集合", items: [request] }];
  return snapshot;
}

// ------------------------------------------------------------- policy ----

test("三态：只有 secret === true 是私密", () => {
  assert.equal(isPrivateVariable({ secret: true }), true);
  assert.equal(isPrivateVariable({ secret: false }), false);
  assert.equal(isPrivateVariable({}), false);
  assert.equal(isPrivateVariable(null), false);
});

test("shareableVariables 只剔除私密行，{{模板}} 因此保留变量名", () => {
  const variables = shareableVariables(makeSnapshot().environments[0].variables);
  assert.deepEqual(variables, {
    baseUrl: "https://api.example.com",
    publicToken: "public-value",
  });
  assert.equal(variables.password, undefined);
  assert.equal(variables.account, undefined);
});

test("blankPrivateRows 保留行结构与私密标记，只清空值", () => {
  const rows = blankPrivateRows(makeSnapshot().environments[0].variables);
  assert.equal(rows.length, 5);
  const password = rows.find((item) => item.key === "password");
  assert.equal(password.id, "v3");
  assert.equal(password.secret, true);
  assert.equal(password.enabled, true);
  assert.equal(password.value, "");
  assert.equal(rows.find((item) => item.key === "baseUrl").value, "https://api.example.com");
});

test("privateContext 收集所有私密项，忽略过短值与占位符", () => {
  const ctx = privateContext(makeSnapshot());
  assert.deepEqual([...ctx.keys].sort(), ["account", "password", "short"]);
  assert.ok(ctx.values.includes(PASSWORD));
  assert.ok(ctx.values.includes(ACCOUNT));
  assert.ok(!ctx.values.includes("ab"));
  // 长值优先替换，避免短值先命中把长值切碎。
  assert.ok(ctx.values.every((value, index) => index === 0 || ctx.values[index - 1].length >= value.length));
});

test("maskPrivateText 替换真实值且幂等", () => {
  const ctx = privateContext(makeSnapshot());
  const once = maskPrivateText(`GET /x?p=${PASSWORD}&u=${ACCOUNT}`, ctx);
  assert.ok(!once.includes(PASSWORD));
  assert.ok(!once.includes(ACCOUNT));
  assert.equal(maskPrivateText(once, ctx), once);
  assert.equal(maskPrivateText("普通文本", ctx), "普通文本");
});

test("enforcePrivate：行标记 / 变量名索引 / 自由文本三层都不放行", () => {
  const ctx = privateContext(makeSnapshot());
  const payload = {
    variables: { password: PASSWORD, baseUrl: "https://api.example.com" },
    rows: [{ key: "account", value: ACCOUNT, private: true }],
    log: `Authorization: ${PASSWORD}`,
    nested: { items: [{ key: "x", value: PASSWORD, secret: true }] },
  };
  const out = enforcePrivate(payload, ctx);
  assert.match(out.variables.password, /\*\*\*/u);
  assert.equal(out.variables.baseUrl, "https://api.example.com");
  assert.match(out.rows[0].value, /\*\*\*/u);
  assert.ok(!out.log.includes(PASSWORD));
  assert.match(out.nested.items[0].value, /\*\*\*/u);
  assert.ok(!JSON.stringify(out).includes(PASSWORD));
  // 原对象不被修改（出口兜底必须作用于副本）。
  assert.equal(payload.variables.password, PASSWORD);
});

// ------------------------------------------------------- cloud sync ----

test("云同步：变量名上传、值置空；下载后本机真实值仍在", () => {
  const snapshot = makeSnapshot();
  const stripped = stripForUpload(snapshot);
  const uploaded = stripped.environments[0].variables;
  const password = uploaded.find((item) => item.key === "password");
  assert.ok(password, "变量名仍同步，协作者知道要填什么");
  assert.equal(password.value, "", "私密值不上传");
  assert.equal(password.secret, true, "私密标记随定义同步");
  assert.equal(
    uploaded.find((item) => item.key === "baseUrl").value,
    "https://api.example.com",
    "非私密值正常共享",
  );

  const localRows = snapshotToRows(snapshot);
  const serverRows = snapshotToRows(stripped);
  const restored = restoreRowsCredentials(serverRows, localRows);
  const rebuilt = rowsToSnapshot(restored, snapshot);
  const local = rebuilt.environments[0].variables;
  assert.equal(local.find((item) => item.key === "password").value, PASSWORD);
  assert.equal(local.find((item) => item.key === "account").value, ACCOUNT);
});

// ------------------------------------------------------ export paths ----

test("文档站 payload 与显式传入的 variables 都不带私密值", () => {
  const snapshot = withRequest(makeSnapshot());
  const plain = JSON.stringify(buildDocSitePayload(snapshot));
  assert.ok(!plain.includes(PASSWORD), "默认路径泄露私密值");
  assert.ok(!plain.includes(ACCOUNT));
  assert.ok(plain.includes("https://api.example.com"), "公共变量照常替换");

  const forced = JSON.stringify(
    buildDocSitePayload(snapshot, {
      variables: { password: PASSWORD, account: ACCOUNT, baseUrl: "https://api.example.com" },
    }),
  );
  assert.ok(!forced.includes(PASSWORD), "显式 variables 也不能绕过私密收口");
  assert.ok(!forced.includes(ACCOUNT));
});

test("本地调试 HTML 导出用的变量表已剔除私密项", () => {
  // exportFormats.ts 的文档站渲染器使用 shareableVariables 构造这份表。
  const variables = shareableVariables(makeSnapshot().environments[0].variables);
  const resolved = JSON.stringify(variables);
  assert.ok(!resolved.includes(PASSWORD));
  assert.ok(!resolved.includes(ACCOUNT));
});

test("OpenAPI 导出：私密 query 行不留 example，正文里的硬编码值也遮蔽", () => {
  const snapshot = withRequest(makeSnapshot());
  const text = exportOpenApi(snapshot);
  assert.ok(!text.includes(PASSWORD));
  assert.ok(!text.includes(ACCOUNT));
  assert.ok(text.includes("pwd"), "参数名保留");
  const parsed = JSON.parse(text);
  const parameters = parsed.paths["/profile?pwd={{password}}"]?.get?.parameters
    ?? Object.values(parsed.paths)[0]?.get?.parameters
    ?? [];
  const secretParam = parameters.find((item) => item.name === "pwd");
  assert.ok(secretParam, "私密参数仍出现在文档里");
  assert.equal(secretParam.example, undefined, "但不带真实值");
});

test("PRIVATE_MASK 与脱敏链路使用同一个占位符", () => {
  assert.equal(PRIVATE_MASK, "***");
  assert.match(enforcePrivate({ private: true, value: PASSWORD }, privateContext(makeSnapshot())).value, /\*\*\*/u);
});
