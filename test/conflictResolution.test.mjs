// 冲突裁决闭环：threeWayMerge → planFieldMerge → composeMergedRow →
// stampMergedRow → 服务端采纳 → 下一轮不再冲突。
//
// 关键不变量：合成行写回本地后必须「立即上传」。否则相对旧基线仍是
// 「本地改了 + 云端也改了」，下一轮会无限重复报冲突（本测试显式断言）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  composeMergedRow,
  defaultSelections,
  planFieldMerge,
  stampMergedRow,
} from "../src/lib/fieldMerge.ts";
import { threeWayMerge } from "../src/lib/workspaceRows.ts";

const clone = (value) => JSON.parse(JSON.stringify(value));

const emptyRows = () => ({
  folders: [],
  requests: [],
  environments: [],
  cases: [],
  scenarios: [],
  suites: [],
  artifacts: [],
});

function row(overrides = {}) {
  return {
    id: "r1",
    updatedAt: 100,
    folderId: "c1",
    folderPath: "",
    name: "订单接口",
    method: "GET",
    url: "/orders",
    protocol: "http",
    position: 0,
    data: {
      headers: [{ id: "h1", key: "Accept", value: "application/json", enabled: true }],
      query: [],
      body: { kind: "raw", raw: "{}" },
    },
    ...overrides,
  };
}

const rowsWith = (request) => ({ ...emptyRows(), requests: [request] });

test("a two-sided edit produces a conflict carrying the baseline row", () => {
  const base = row();
  const local = row({ name: "订单（本地改名）", updatedAt: 200, method: "POST" });
  const remote = row({ url: "/orders/v2", updatedAt: 300, method: "PATCH" });

  const outcome = threeWayMerge(rowsWith(local), rowsWith(remote), rowsWith(base));
  assert.equal(outcome.conflicts.length, 1);
  assert.equal(outcome.conflicts[0].domain, "requests");
  assert.deepEqual(outcome.conflicts[0].base, base);
  assert.equal(outcome.localChanges.requests.length, 0, "冲突行不自动上传");
});

test("without uploading, the resolution would loop forever (why we upload immediately)", () => {
  const base = row();
  const local = row({ name: "订单（本地改名）", updatedAt: 200 });
  const remote = row({ url: "/orders/v2", updatedAt: 300 });
  const conflict = threeWayMerge(rowsWith(local), rowsWith(remote), rowsWith(base)).conflicts[0];
  const plan = planFieldMerge(conflict);
  const merged = composeMergedRow(plan, defaultSelections(plan));
  const stamped = stampMergedRow(merged, remote.updatedAt, 1000);

  // 只写回本地、服务端仍是旧版本 → 再次冲突。
  const again = threeWayMerge(rowsWith(stamped), rowsWith(remote), rowsWith(base));
  assert.equal(again.conflicts.length, 1);
});

test("after the server accepts the merged row, the next sync converges", () => {
  const base = row();
  const local = row({ name: "订单（本地改名）", updatedAt: 200, method: "POST" });
  const remote = row({ url: "/orders/v2", updatedAt: 300, method: "PATCH" });
  const conflict = threeWayMerge(rowsWith(local), rowsWith(remote), rowsWith(base)).conflicts[0];

  const plan = planFieldMerge(conflict);
  assert.equal(plan.mode, "fields");
  assert.equal(plan.choices.length, 1, "只有 method 双方都改；name / url 自动合并");
  assert.equal(plan.choices[0].path, "method");

  const merged = composeMergedRow(plan, defaultSelections(plan));
  assert.equal(merged.name, "订单（本地改名）");
  assert.equal(merged.url, "/orders/v2");
  assert.equal(merged.method, "POST");
  assert.equal(merged.data.body.raw, "{}", "未冲突的深层字段原样保留");

  const stamped = stampMergedRow(merged, remote.updatedAt, 1000);
  assert.ok(stamped.updatedAt > remote.updatedAt, "服务端 LWW 才会采纳合成行");

  // 服务端采纳合成行后，本地与云端一致 → 收敛，基线得以推进。
  const settled = threeWayMerge(rowsWith(stamped), rowsWith(stamped), rowsWith(base));
  assert.equal(settled.conflicts.length, 0);
  assert.equal(settled.localChanges.requests.length, 0);
});

test("skipIds suspends a conflict without uploading or overwriting", () => {
  const base = row();
  const local = row({ name: "本地", updatedAt: 200 });
  const remote = row({ url: "/v2", updatedAt: 300 });
  const outcome = threeWayMerge(rowsWith(local), rowsWith(remote), rowsWith(base), {
    skipIds: new Set(["requests:r1"]),
  });
  assert.equal(outcome.conflicts.length, 0, "挂起中不重复报告");
  assert.equal(outcome.localChanges.requests.length, 0, "挂起中不上传");
  assert.equal(outcome.remote.requests[0].name, "本地", "挂起中保留本地版本");
});

test("whole-row deletion resolution converges once the local row is gone", () => {
  const base = row();
  const local = row({ name: "本地改名", updatedAt: 200 });
  const conflict = threeWayMerge(rowsWith(local), emptyRows(), rowsWith(base)).conflicts[0];
  const plan = planFieldMerge(conflict);
  assert.equal(plan.mode, "whole-row");
  assert.equal(composeMergedRow(plan, { __row__: { source: "remote" } }), null);

  // 跟随云端删除：本地行移除后三方合并不再产生活行。
  const after = threeWayMerge(emptyRows(), emptyRows(), rowsWith(base));
  assert.equal(after.conflicts.length, 0);
  assert.equal(after.remote.requests.length, 0);
});

test("merged row keeps its shape through the snapshot round-trip", () => {
  const base = row();
  const local = clone(row({ name: "本地", updatedAt: 200 }));
  local.data.headers.push({ id: "h2", key: "X-Trace", value: "1", enabled: true });
  const remote = clone(row({ url: "/v2", updatedAt: 300 }));
  remote.data.headers.push({ id: "h3", key: "Accept-Language", value: "zh", enabled: true });

  const conflict = threeWayMerge(rowsWith(local), rowsWith(remote), rowsWith(base)).conflicts[0];
  const plan = planFieldMerge(conflict);
  assert.equal(plan.choices.length, 0, "两处互不重叠的新增都自动保留");
  const merged = composeMergedRow(plan, {});
  assert.equal(merged.data.headers.length, 3);
  assert.equal(merged.name, "本地");
  assert.equal(merged.url, "/v2");
  assert.equal(merged.id, "r1");
  assert.equal(typeof merged.position, "number");
  assert.equal(typeof merged.method, "string");
});
