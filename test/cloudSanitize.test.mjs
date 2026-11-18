// 上传前清洗（sanitizeRowsForUpload）：NaN / Infinity 会让 JSON.stringify
// 输出裸 token，服务端 Jackson 直接抛 HttpMessageNotReadableException（用户
// 看到「请求格式不合法」）。清洗必须就地生效、报出受影响行，且干净数据零扰动。
import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeRowsForUpload } from "../src/lib/cloudSync.ts";
import { stableStringify } from "../src/lib/cloudSync.ts";

const basePayload = () => ({
  folders: [],
  requests: [],
  environments: [],
  cases: [],
  scenarios: [],
  suites: [],
  artifacts: [],
});

test("clean payload is untouched and reports nothing", () => {
  const payload = basePayload();
  payload.requests.push({
    id: "r1",
    updatedAt: 1731300000000,
    folderId: "f1",
    folderPath: "",
    name: "登录",
    method: "POST",
    url: "/login",
    protocol: "http",
    position: 0,
    data: { headers: [{ key: "a", value: "1" }], body: { type: "json", content: "{\"x\":1}" } },
  });
  const before = stableStringify(payload);
  const { payload: out, fixed } = sanitizeRowsForUpload(payload);
  assert.equal(fixed.length, 0);
  assert.equal(stableStringify(out), before);
});

test("NaN / Infinity in row data are replaced with null and reported", () => {
  const payload = basePayload();
  payload.requests.push({
    id: "r-bad",
    updatedAt: 1731300000001,
    folderId: "f1",
    folderPath: "",
    name: "脚本污染",
    method: "POST",
    url: "/x",
    protocol: "http",
    position: 0,
    data: {
      doc: { responses: [{ ms: NaN }] },
      nested: { deep: [1, Infinity, "ok"] },
    },
  });
  const { payload: out, fixed } = sanitizeRowsForUpload(payload);
  assert.equal(fixed.length, 2);
  assert.ok(fixed[0].includes("doc.responses[0].ms"), fixed.join("、"));
  assert.ok(fixed[1].includes("nested.deep[1]"), fixed.join("、"));
  // 清洗后的对象结构必须保留（不能整个子节点被抹成 null）。
  const data = out.requests[0].data;
  assert.equal(data.doc.responses[0].ms, null);
  assert.deepEqual(data.nested.deep, [1, null, "ok"]);
  // 清洗后的 payload 必须是合法 JSON（这是本次修复的核心断言）。
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(out)));
});

test("NaN in folder auth and environment values are cleaned", () => {
  const payload = basePayload();
  payload.folders.push({
    id: "f-bad",
    updatedAt: 1731300000002,
    name: "集合",
    auth: { type: "bearer", token: NaN },
    position: 0,
  });
  payload.environments.push({
    id: "e-bad",
    updatedAt: 1731300000003,
    name: "环境",
    position: 0,
    data: { values: [{ key: "port", value: Infinity }] },
  });
  const { payload: out, fixed } = sanitizeRowsForUpload(payload);
  assert.equal(fixed.length, 2);
  assert.ok(fixed[0].includes("folders#f-bad auth.token"), fixed.join("、"));
  assert.ok(fixed[1].includes("environments#e-bad data.values[0].value"), fixed.join("、"));
  // 对象结构保留，只有脏叶子被置 null。
  assert.deepEqual(out.folders[0].auth, { type: "bearer", token: null });
  assert.deepEqual(out.environments[0].data.values[0], { key: "port", value: null });
});

test("non-integer updatedAt / position are floored to non-negative integers", () => {
  const payload = basePayload();
  payload.scenarios.push({
    id: "s-bad",
    updatedAt: 1731300000000.75,
    name: "场景",
    position: -0.5,
    data: {},
  });
  const { payload: out, fixed } = sanitizeRowsForUpload(payload);
  assert.equal(fixed.length, 2);
  assert.equal(out.scenarios[0].updatedAt, 1731300000000);
  assert.equal(out.scenarios[0].position, 0);
});

test("meta.settings is cleaned too", () => {
  const payload = basePayload();
  payload.meta = { seeded: true, activeEnvironmentId: null, settings: { timeoutSecs: NaN } };
  const { payload: out, fixed } = sanitizeRowsForUpload(payload);
  assert.deepEqual(fixed, ["meta.settings.timeoutSecs"]);
  assert.equal(out.meta.settings.timeoutSecs, null);
});
