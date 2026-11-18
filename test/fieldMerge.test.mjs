// 结构化字段级三方合并（lib/fieldMerge.ts）：
// - 单方改动自动采用，只有「同一字段双方都改」才产生选择点；
// - data 内的键控数组（headers / query / variables …）按元素 id 做集合合并，
//   双方各自新增的条目都保留，同一条目内还能下钻到字段级自动合并；
// - 结构字段不开放选择、删除 vs 修改退化为整行、大对象按引用挑；
// - composeMergedRow 与 planFieldMerge 走同一棵合并树，预览 === 落库结果。
import test from "node:test";
import assert from "node:assert/strict";
import {
  ROW_CHOICE_PATH,
  composeMergedRow,
  defaultSelections,
  planFieldMerge,
  stampMergedRow,
  uniformSelections,
} from "../src/lib/fieldMerge.ts";

const clone = (value) => JSON.parse(JSON.stringify(value));

function baseRow() {
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
      headers: [
        { id: "h1", key: "Accept", value: "application/json", enabled: true },
      ],
      query: [],
      body: { kind: "raw", raw: "{}" },
      auth: { type: "none" },
    },
  };
}

const conflict = (base, local, remote, overrides = {}) => ({
  domain: "requests",
  id: "r1",
  name: "订单接口",
  base,
  local,
  remote,
  ...overrides,
});

test("disjoint top-level edits merge automatically with zero decisions", () => {
  const base = baseRow();
  const local = clone(base);
  local.name = "订单接口（本地）";
  local.updatedAt = 200;
  const remote = clone(base);
  remote.url = "/orders/v2";
  remote.updatedAt = 300;

  const plan = planFieldMerge(conflict(base, local, remote));
  assert.equal(plan.mode, "fields");
  assert.equal(plan.choices.length, 0);
  assert.ok(plan.autoFields > 0);

  const row = composeMergedRow(plan, {});
  assert.equal(row.name, "订单接口（本地）");
  assert.equal(row.url, "/orders/v2");
  assert.equal(row.updatedAt, 200, "updatedAt 是结构字段，自动采用本地");
});

test("both sides editing the same scalar creates exactly one decision", () => {
  const base = baseRow();
  const local = clone(base);
  local.method = "POST";
  const remote = clone(base);
  remote.method = "DELETE";

  const plan = planFieldMerge(conflict(base, local, remote));
  assert.equal(plan.choices.length, 1);
  assert.equal(plan.choices[0].path, "method");
  assert.equal(plan.choices[0].kind, "scalar");
  assert.equal(composeMergedRow(plan, defaultSelections(plan)).method, "POST");
  assert.equal(composeMergedRow(plan, uniformSelections(plan, "remote")).method, "DELETE");
});

test("keyed arrays keep additions from both sides without a decision", () => {
  const base = baseRow();
  const local = clone(base);
  local.data.headers.push({ id: "h2", key: "X-Trace", value: "local", enabled: true });
  const remote = clone(base);
  remote.data.headers.push({ id: "h3", key: "Accept-Language", value: "zh", enabled: true });

  const plan = planFieldMerge(conflict(base, local, remote));
  assert.equal(plan.choices.length, 0);
  const row = composeMergedRow(plan, {});
  assert.deepEqual(
    row.data.headers.map((item) => item.id),
    ["h1", "h2", "h3"],
    "本地顺序优先，云端新增追加",
  );
});

test("edits to different fields of the SAME array item auto-merge", () => {
  const base = baseRow();
  const local = clone(base);
  local.data.headers[0].key = "X-Accept";
  const remote = clone(base);
  remote.data.headers[0].value = "text/plain";

  const plan = planFieldMerge(conflict(base, local, remote));
  assert.equal(plan.choices.length, 0, "下钻到条目字段后两侧改动互不重叠");
  assert.deepEqual(composeMergedRow(plan, {}).data.headers[0], {
    id: "h1",
    key: "X-Accept",
    value: "text/plain",
    enabled: true,
  });
});

test("both sides editing one header value drills down to that leaf", () => {
  const base = baseRow();
  const local = clone(base);
  local.data.headers[0].value = "application/xml";
  const remote = clone(base);
  remote.data.headers[0].value = "text/plain";

  const plan = planFieldMerge(conflict(base, local, remote));
  assert.equal(plan.choices.length, 1);
  assert.equal(plan.choices[0].path, "data.headers[id:h1].value");
  assert.match(plan.choices[0].label, /Accept/);
  assert.equal(composeMergedRow(plan, uniformSelections(plan, "remote")).data.headers[0].value, "text/plain");
});

test("delete vs edit becomes a decision, defaulting to local (keep deletion)", () => {
  const base = baseRow();
  const local = clone(base);
  local.data.headers = [];
  const remote = clone(base);
  remote.data.headers[0].value = "text/plain";

  const plan = planFieldMerge(conflict(base, local, remote));
  assert.equal(plan.choices.length, 1);
  assert.equal(plan.choices[0].kind, "delete-vs-edit");
  assert.equal(composeMergedRow(plan, defaultSelections(plan)).data.headers.length, 0);
  assert.equal(composeMergedRow(plan, uniformSelections(plan, "remote")).data.headers.length, 1);
});

test("long text conflicts are editable with a custom value", () => {
  const base = baseRow();
  const local = clone(base);
  local.data.body.raw = "{\"local\":true}";
  const remote = clone(base);
  remote.data.body.raw = "{\"remote\":true}";

  const plan = planFieldMerge(conflict(base, local, remote));
  const textChoice = plan.choices.find((choice) => choice.kind === "text");
  assert.ok(textChoice, "body.raw 应标记为文本冲突");
  assert.equal(textChoice.path, "data.body.raw");

  const edited = composeMergedRow(plan, {
    ...defaultSelections(plan),
    [textChoice.path]: { source: "custom", custom: "{\"merged\":true}" },
  });
  assert.equal(edited.data.body.raw, "{\"merged\":true}");
  assert.equal(edited.data.body.kind, "raw", "同层未冲突字段不受影响");
});

test("structural fields are never offered as choices", () => {
  const base = baseRow();
  const local = clone(base);
  local.folderId = "c2";
  local.position = 5;
  local.updatedAt = 900;
  const remote = clone(base);
  remote.folderId = "c3";
  remote.position = 9;
  remote.updatedAt = 950;

  const plan = planFieldMerge(conflict(base, local, remote));
  assert.equal(plan.choices.length, 0);
  assert.ok(plan.structural.some((label) => label.includes("所属集合")));
  const row = composeMergedRow(plan, {});
  assert.equal(row.folderId, "c2");
  assert.equal(row.position, 5);
  assert.equal(row.id, "r1");
});

test("delete vs modify degrades to whole-row selection", () => {
  const base = baseRow();
  const local = clone(base);
  local.name = "本地改名";
  const plan = planFieldMerge(conflict(base, local, null));
  assert.equal(plan.mode, "whole-row");
  assert.match(plan.wholeRowReason, /删除/);
  assert.equal(plan.choices.length, 1);
  assert.equal(plan.choices[0].path, ROW_CHOICE_PATH);
  assert.equal(composeMergedRow(plan, defaultSelections(plan)).name, "本地改名");
  assert.equal(
    composeMergedRow(plan, { [ROW_CHOICE_PATH]: { source: "remote" } }),
    null,
    "跟随云端删除时合成结果为 null",
  );
});

test("tombstone on either side is also whole-row", () => {
  const base = baseRow();
  const local = { ...clone(base), deleted: true, updatedAt: 500 };
  const remote = { ...clone(base), name: "云端改名", updatedAt: 600 };
  const plan = planFieldMerge(conflict(base, local, remote));
  assert.equal(plan.mode, "whole-row");
});

test("missing baseline falls back to whole-row instead of guessing", () => {
  const base = baseRow();
  const local = clone(base);
  local.name = "本地";
  const remote = clone(base);
  remote.name = "云端";
  const plan = planFieldMerge(conflict(null, local, remote));
  assert.equal(plan.mode, "whole-row");
  assert.match(plan.wholeRowReason, /基线/);
});

test("blob references are chosen as references, never expanded", () => {
  const base = baseRow();
  const local = clone(base);
  local.data.body = { __blob: "aaaa", size: 10, encoding: "json" };
  const remote = clone(base);
  remote.data.body = { __blob: "bbbb", size: 20, encoding: "json" };

  const plan = planFieldMerge(conflict(base, local, remote));
  const blobChoice = plan.choices.find((choice) => choice.kind === "blob");
  assert.ok(blobChoice);
  const row = composeMergedRow(plan, uniformSelections(plan, "remote"));
  assert.equal(row.data.body.__blob, "bbbb");
});

test("arrays without stable element ids are an opaque single choice", () => {
  const base = baseRow();
  base.data.tags = [{ a: 1 }];
  const local = clone(base);
  local.data.tags = [{ a: 2 }];
  const remote = clone(base);
  remote.data.tags = [{ a: 3 }];

  const plan = planFieldMerge(conflict(base, local, remote));
  const choice = plan.choices.find((item) => item.path === "data.tags");
  assert.ok(choice, "没有 id 的对象数组不能拆成集合，只能整体二选一");
  assert.deepEqual(composeMergedRow(plan, defaultSelections(plan)).data.tags, [{ a: 2 }]);
});

test("both sides adding the SAME id with different content conflicts at the leaf", () => {
  const base = baseRow();
  const local = clone(base);
  local.data.headers.push({ id: "h9", key: "X-Flag", value: "1", enabled: true });
  const remote = clone(base);
  remote.data.headers.push({ id: "h9", key: "X-Flag", value: "2", enabled: true });

  const plan = planFieldMerge(conflict(base, local, remote));
  assert.equal(plan.choices.length, 1);
  assert.equal(plan.choices[0].path, "data.headers[id:h9].value");
  assert.equal(composeMergedRow(plan, uniformSelections(plan, "remote")).data.headers.length, 2);
});

test("plan and compose are deterministic", () => {
  const base = baseRow();
  const local = clone(base);
  local.method = "POST";
  local.data.body.raw = "{\"a\":1}";
  const remote = clone(base);
  remote.method = "PATCH";
  remote.data.body.raw = "{\"b\":2}";
  const input = conflict(base, local, remote);

  const first = planFieldMerge(input);
  const second = planFieldMerge(input);
  assert.deepEqual(first.choices, second.choices);
  const selections = defaultSelections(first);
  assert.deepEqual(
    composeMergedRow(first, selections),
    composeMergedRow(second, selections),
  );
});

test("stampMergedRow is strictly newer than the remote version", () => {
  const row = { id: "r1", updatedAt: 100, name: "x" };
  assert.equal(stampMergedRow(row, 500, 1000).updatedAt, 1000);
  assert.equal(stampMergedRow(row, 5000, 1000).updatedAt, 5001);
  assert.equal(row.updatedAt, 100, "不得原地修改输入");
  assert.equal(stampMergedRow({ ...row, deleted: true }, 1, 1000).deleted, true);
});

test("every row domain produces a usable plan", () => {
  const domains = [
    "folders",
    "requests",
    "environments",
    "cases",
    "scenarios",
    "suites",
    "artifacts",
  ];
  for (const domain of domains) {
    const base = { id: "x1", updatedAt: 1, name: "原始", data: { variables: [] } };
    const local = { ...clone(base), name: "本地" };
    const remote = { ...clone(base), name: "云端" };
    const plan = planFieldMerge(conflict(base, local, remote, { domain }));
    assert.equal(plan.domain, domain);
    assert.equal(plan.choices.length, 1);
    assert.equal(composeMergedRow(plan, defaultSelections(plan)).name, "本地");
  }
});
