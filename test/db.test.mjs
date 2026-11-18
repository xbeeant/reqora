import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dbSpecFromConfig,
  evaluateDbStep,
  newDbStep,
} from "../src/lib/scenario.ts";

const DB_RESULT = {
  columns: ["id", "name", "deleted_at"],
  rows: [
    { id: 42, name: "amy", deleted_at: null },
    { id: 43, name: "bob", deleted_at: null },
  ],
  rowsAffected: 0,
  elapsedMs: 5,
  truncated: false,
};

test("newDbStep produces a disabled-empty db step", () => {
  const step = newDbStep();
  assert.equal(step.source.kind, "db");
  if (step.source.kind === "db") {
    assert.equal(step.source.db.mode, "query");
    assert.equal(step.source.db.url, "");
    assert.deepEqual(step.source.db.extracts, []);
    assert.deepEqual(step.source.db.asserts, []);
  }
});

test("dbSpecFromConfig substitutes variables into url and sql", () => {
  const spec = dbSpecFromConfig(
    {
      url: "mysql://root:pw@{{dbHost}}:3306/app",
      sql: "SELECT * FROM users WHERE id = {{userId}}",
      mode: "query",
      extracts: [],
      asserts: [],
    },
    { dbHost: "10.0.0.2", userId: "42" },
  );
  assert.equal(spec.url, "mysql://root:pw@10.0.0.2:3306/app");
  assert.equal(spec.sql, "SELECT * FROM users WHERE id = 42");
  assert.equal(spec.mode, "query");
});

test("dbSpecFromConfig keeps execute mode", () => {
  const spec = dbSpecFromConfig(
    {
      url: "postgres://u:p@h/db",
      sql: "DELETE FROM tokens WHERE expired = 1",
      mode: "execute",
      extracts: [],
      asserts: [],
    },
    {},
  );
  assert.equal(spec.mode, "execute");
});

test("evaluateDbStep extracts cells and passes assertions", () => {
  const outcome = evaluateDbStep(
    {
      url: "mysql://x",
      sql: "SELECT 1",
      mode: "query",
      extracts: [
        { id: "e1", varName: "userId", column: "id", row: 0 },
        { id: "e2", varName: "secondName", column: "name", row: 1 },
        { id: "e3", varName: "empty", column: "deleted_at", row: 0 },
      ],
      asserts: [
        { id: "a1", target: "rows", row: 0, column: "", op: "eq", value: "2" },
        { id: "a2", target: "cell", row: 0, column: "name", op: "eq", value: "amy" },
        { id: "a3", target: "cell", row: 1, column: "id", op: "gt", value: "42" },
        { id: "a4", target: "cell", row: 0, column: "deleted_at", op: "eq", value: "null" },
      ],
    },
    DB_RESULT,
  );
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.extracted, {
    userId: "42",
    secondName: "bob",
    empty: "null",
  });
  assert.equal(outcome.passed, 4);
  assert.equal(outcome.failed, 0);
});

test("evaluateDbStep reports failing assertion with actual value", () => {
  const outcome = evaluateDbStep(
    {
      url: "mysql://x",
      sql: "SELECT 1",
      mode: "query",
      extracts: [],
      asserts: [
        { id: "a1", target: "rows", row: 0, column: "", op: "eq", value: "99" },
      ],
    },
    DB_RESULT,
  );
  assert.equal(outcome.passed, 0);
  assert.equal(outcome.failed, 1);
  assert.ok(outcome.error.includes("行数"), outcome.error);
  assert.ok(outcome.error.includes("实际 2"), outcome.error);
});

test("evaluateDbStep fails on missing row or column", () => {
  const missingRow = evaluateDbStep(
    {
      url: "x",
      sql: "s",
      mode: "query",
      extracts: [{ id: "e1", varName: "v", column: "id", row: 9 }],
      asserts: [],
    },
    DB_RESULT,
  );
  assert.ok(missingRow.error.includes("第 9 行"), missingRow.error);

  const missingColumn = evaluateDbStep(
    {
      url: "x",
      sql: "s",
      mode: "query",
      extracts: [{ id: "e1", varName: "v", column: "nope", row: 0 }],
      asserts: [],
    },
    DB_RESULT,
  );
  assert.ok(missingColumn.error.includes("nope"), missingColumn.error);
});

test("evaluateDbStep propagates query failure and skips assertions", () => {
  const outcome = evaluateDbStep(
    {
      url: "x",
      sql: "s",
      mode: "query",
      extracts: [{ id: "e1", varName: "v", column: "id", row: 0 }],
      asserts: [{ id: "a1", target: "rows", row: 0, column: "", op: "eq", value: "1" }],
    },
    null,
    "数据库连接失败：refused",
  );
  assert.equal(outcome.failed, 1);
  assert.equal(outcome.passed, 0);
  assert.ok(outcome.error.includes("数据库连接失败"), outcome.error);
});

test("evaluateDbStep handles execute mode (rowsAffected only)", () => {
  const outcome = evaluateDbStep(
    {
      url: "x",
      sql: "DELETE ...",
      mode: "execute",
      extracts: [],
      asserts: [{ id: "a1", target: "rows", row: 0, column: "", op: "gte", value: "1" }],
    },
    { columns: [], rows: [], rowsAffected: 3, elapsedMs: 9, truncated: false },
  );
  // rows.length is 0 in execute mode — assertion on rows refers to returned rows.
  assert.equal(outcome.passed, 0);
  assert.equal(outcome.failed, 1);
});
