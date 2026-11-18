// 云端 API 客户端（P3）：令牌持久化、401 刷新重试、5xx 重试、4xx 不重试与错误映射。
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  CloudError,
  clearCloudSession,
  cloudLogin,
  cloudSyncRows,
  configureCloud,
} from "../src/lib/cloud.ts";
import { readCloudConnection, resetCloudConnection } from "../src/lib/cloudConnection.ts";
import { registerDict, t } from "../src/i18n/index.ts";
import { zh as cloudZh } from "../src/i18n/ns/cloud.ts";

registerDict("zh", cloudZh);

const emptyRows = () => ({
  folders: [],
  requests: [],
  environments: [],
  cases: [],
  scenarios: [],
  suites: [],
  artifacts: [],
});

const ok = (data) =>
  new Response(JSON.stringify({ code: 0, message: "ok", data, requestId: "rid" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const failure = (status, code, message) =>
  new Response(JSON.stringify({ code, message, data: null, requestId: "rid" }), {
    status,
    headers: { "content-type": "application/json" },
  });

const tokens = (access = "a1", refresh = "r1") => ({
  accessToken: access,
  refreshToken: refresh,
  tokenType: "Bearer",
  expiresIn: 900,
  user: { id: 1, username: "alice", superAdmin: false },
});

let calls = [];
let handler = () => ok(null);

beforeEach(() => {
  calls = [];
  resetCloudConnection();
  clearCloudSession();
  configureCloud("http://127.0.0.1:18080");
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler();
  };
});

test("登录后请求自动附带 Bearer 令牌，令牌持久化且不出现在 URL 中", async () => {
  handler = () => ok(tokens());
  const result = await cloudLogin("alice", "secret");
  assert.equal(result.user.username, "alice");
  assert.equal(readCloudConnection().session.access, "a1");
  assert.equal(readCloudConnection().user.username, "alice");

  let seenAuth = "";
  handler = () => {
    seenAuth = calls.at(-1).init.headers.authorization ?? "";
    return ok({ projectId: 7, version: 1 });
  };
  await cloudSyncRows(7, emptyRows());
  assert.equal(seenAuth, "Bearer a1");
  assert.ok(!calls.some((call) => call.url.includes("secret")));
});

test("401 触发一次刷新并重试原始请求", async () => {
  handler = () => ok(tokens());
  await cloudLogin("alice", "secret");
  calls = [];

  let step = 0;
  const authHeaders = [];
  handler = () => {
    step += 1;
    authHeaders.push(calls.at(-1).init.headers.authorization ?? "");
    if (step === 1) return failure(401, 1008, "令牌无效或已过期");
    if (step === 2) return ok(tokens("a2", "r2"));
    return ok({ projectId: 7, version: 2 });
  };
  const result = await cloudSyncRows(7, emptyRows());
  assert.equal(result.version, 2);
  assert.equal(step, 3);
  assert.ok(calls[1].url.endsWith("/api/v1/auth/refresh"));
  assert.equal(authHeaders[2], "Bearer a2");
  assert.equal(calls.at(-1).url, calls[0].url);
});

test("5xx 最多重试 3 次后抛出可重试错误", async () => {
  handler = () => ok(tokens());
  await cloudLogin("alice", "secret");
  calls = [];
  handler = () => new Response("{}", { status: 503 });
  await assert.rejects(
    () => cloudSyncRows(7, emptyRows()),
    (error) => error instanceof CloudError && error.retryable,
  );
  assert.equal(calls.length, 4); // 首次 + 3 次重试
});

test("4xx 不重试，服务端中文文案直接透出", async () => {
  handler = () => ok(tokens());
  await cloudLogin("alice", "secret");
  calls = [];
  handler = () => failure(409, 1009, "云端已更新到 v3，请先拉取再上传");
  await assert.rejects(
    () => cloudSyncRows(7, emptyRows()),
    (error) => {
      assert.equal(error.code, 1009);
      assert.match(error.message, /请先拉取/);
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("网络异常给离线提示而非原始错误", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    () => cloudLogin("alice", "secret"),
    (error) => error instanceof CloudError && error.message === t("cloud.offline"),
  );
});

test("未配置服务器地址时快速失败", async () => {
  configureCloud("  ");
  await assert.rejects(
    () => cloudLogin("alice", "secret"),
    (error) => error instanceof CloudError && error.message === t("cloud.error.noBaseUrl"),
  );
});
