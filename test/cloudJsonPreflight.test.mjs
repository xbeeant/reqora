// 云端请求的客户端可观测性（回归修正）：
// - JSON.stringify 会把嵌套 NaN/Infinity 转成 null，不会产生非法 JSON，
//   因此 HttpMessageNotReadableException 的原因在服务端，不能靠客户端清洗解释。
// - 非对象请求体在发出前被拦下并给出诊断。
// - 400 被拒时留下请求指纹；响应头 X-Reqora-Error-Detail 可区分新旧后端。
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CloudError, cloudSyncRows, configureCloud } from "../src/lib/cloud.ts";
import { resetCloudConnection } from "../src/lib/cloudConnection.ts";
import { registerDict, t } from "../src/i18n/index.ts";
import { zh as cloudZh } from "../src/i18n/ns/cloud.ts";

registerDict("zh", cloudZh);

const ok = (data) =>
  new Response(JSON.stringify({ code: 0, message: "ok", data, requestId: "rid" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const rowsWith = (data) => ({
  folders: [],
  requests: [{ id: "r1", updatedAt: 1, folderId: "f", folderPath: "", name: "x", method: "GET", url: "/", protocol: "http", position: 0, data }],
  environments: [],
  cases: [],
  scenarios: [],
  suites: [],
  artifacts: [],
});

const badRequest = (version) =>
  new Response(
    JSON.stringify({
      code: 1001,
      message: "请求格式不合法：HttpMessageNotReadableException",
      data: null,
      requestId: "rid-400",
    }),
    {
      status: 400,
      headers: {
        "content-type": "application/json",
        ...(version ? { "X-Reqora-Error-Detail": version } : {}),
      },
    },
  );

let calls = [];
let handler = () => ok(null);
let logs = [];
let warnings = [];
const originalError = console.error;
const originalWarn = console.warn;

beforeEach(() => {
  calls = [];
  logs = [];
  warnings = [];
  resetCloudConnection();
  configureCloud("http://127.0.0.1:18080");
  console.error = (...args) => logs.push(args);
  console.warn = (...args) => warnings.push(args);
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler();
  };
});

afterEach(() => {
  console.error = originalError;
  console.warn = originalWarn;
});

test("嵌套 NaN 被 JSON.stringify 转成 null，请求照常发出（不是非法 JSON）", async () => {
  await cloudSyncRows(1, rowsWith({ score: NaN }));
  assert.equal(calls.length, 1);
  assert.match(calls[0].init.body, /"score":null/);
  assert.doesNotThrow(() => JSON.parse(calls[0].init.body));
  assert.equal(logs.length, 0);
});

test("非对象请求体在发出前被拦下并写入调试台", async () => {
  await assert.rejects(
    () => cloudSyncRows(1, null),
    (error) => {
      assert.ok(error instanceof CloudError);
      assert.equal(
        error.message,
        t("cloud.error.bodyNotJsonObject", { body: "null" }),
      );
      return true;
    },
  );
  assert.equal(calls.length, 0);
  assert.equal(logs.length, 1);
  assert.match(String(logs[0][0]), /@RequestBody 无法反序列化/);
});

test("旧版后端 400：记录请求指纹并明确指出后端未部署新版处理器", async () => {
  handler = () => badRequest(null);
  await assert.rejects(
    () => cloudSyncRows(1, rowsWith({ ok: 1 })),
    (error) => {
      assert.equal(
        error.message,
        t("cloud.error.http400DetailLegacy", {
          message: "请求格式不合法：HttpMessageNotReadableException",
        }),
      );
      return true;
    },
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][1].requestId, "rid-400");
  assert.equal(warnings[0][1].status, 400);
  assert.ok(warnings[0][1].bodyBytes > 0);
  assert.match(warnings[0][1].bodyPreview, /"requests"/);
  assert.match(warnings[0][1].errorDetailVersion, /旧版/);
});

test("新版后端 400：提示去服务端日志看 Jackson 具体原因", async () => {
  handler = () => badRequest("v2");
  await assert.rejects(
    () => cloudSyncRows(1, rowsWith({ ok: 1 })),
    (error) => {
      assert.equal(
        error.message,
        t("cloud.error.http400DetailV2", {
          message: "请求格式不合法：HttpMessageNotReadableException",
        }),
      );
      return true;
    },
  );
  assert.equal(warnings[0][1].errorDetailVersion, "v2");
});
