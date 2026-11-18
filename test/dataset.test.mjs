import test from "node:test";
import assert from "node:assert/strict";
import { datasetToCsv, parseCsvDataset } from "../src/lib/scenario.ts";
import { normalizeScenario } from "../src/lib/defaults.ts";

test("parseCsvDataset：基本表头 + 数据行", () => {
  const parsed = parseCsvDataset("userId,name\n101,Alice\n102,Bob");
  assert.deepEqual(parsed.columns, ["userId", "name"]);
  assert.deepEqual(parsed.rows, [
    { userId: "101", name: "Alice" },
    { userId: "102", name: "Bob" },
  ]);
  assert.equal(parsed.error, undefined);
});

test("parseCsvDataset：CRLF 与空行跳过、列数不足补空串", () => {
  const parsed = parseCsvDataset("a,b\r\n1,x\r\n\r\n2\r\n");
  assert.deepEqual(parsed.rows, [
    { a: "1", b: "x" },
    { a: "2", b: "" },
  ]);
});

test("parseCsvDataset：双引号转义（引号内逗号与重复引号）", () => {
  const parsed = parseCsvDataset('name,note\n"Alice, Jr","她说""你好"""');
  assert.deepEqual(parsed.rows, [{ name: "Alice, Jr", note: '她说"你好"' }]);
});

test("parseCsvDataset：只有表头 / 空表头列名报错", () => {
  assert.match(parseCsvDataset("a,b\n").error ?? "", /至少需要表头/);
  assert.match(parseCsvDataset("a,\n1,2\n").error ?? "", /空列名/);
});

test("parseCsvDataset：超过 200 行截断并提示", () => {
  const lines = ["a"];
  for (let index = 0; index < 205; index += 1) lines.push(String(index));
  const parsed = parseCsvDataset(lines.join("\n"));
  assert.equal(parsed.rows.length, 200);
  assert.match(parsed.error ?? "", /超过上限/);
});

test("datasetToCsv：与 parseCsvDataset 往返一致（含转义）", () => {
  const original = {
    columns: ["name", "note"],
    rows: [{ name: "Alice, Jr", note: '含"引号"' }],
  };
  const csv = datasetToCsv(original);
  const parsed = parseCsvDataset(csv);
  assert.deepEqual(parsed.rows, original.rows);
  assert.deepEqual(parsed.columns, original.columns);
});

test("normalizeScenario：dataSet 归一（丢弃无效行/空列）", () => {
  const scenario = normalizeScenario({
    id: "s1",
    name: "数据驱动",
    steps: [],
    dataSet: {
      columns: ["a", "", 42, "b"],
      rows: [{ a: "1", b: "2" }, null, [1, 2]],
    },
    createdAt: 0,
    updatedAt: 0,
  });
  assert.deepEqual(scenario.dataSet.columns, ["a", "b"]);
  assert.deepEqual(scenario.dataSet.rows, [{ a: "1", b: "2" }]);

  const noData = normalizeScenario({
    id: "s2",
    name: "无数据",
    steps: [],
    createdAt: 0,
    updatedAt: 0,
  });
  assert.equal(noData.dataSet, undefined);
});
