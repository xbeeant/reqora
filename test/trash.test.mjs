import assert from "node:assert/strict";
import { test } from "node:test";
import { emptySnapshot, normalizeSnapshot } from "../src/lib/defaults.ts";

/** Minimal valid request shape used inside trash payloads. */
function request(id, name) {
  return {
    id,
    name,
    method: "GET",
    url: "https://api.example.com/users",
    headers: [],
    query: [],
    body: { type: "none" },
    auth: { type: "none" },
    doc: {
      summary: "",
      description: "",
      owner: "",
      status: "联调中",
      tags: [],
      paramMeta: {},
      updatedAt: 0,
      responses: [],
    },
  };
}

test("normalizeSnapshot tolerates snapshots without trash (old v1 data)", () => {
  const raw = emptySnapshot();
  delete raw.trash;
  const snapshot = normalizeSnapshot(raw);
  assert.deepEqual(snapshot.trash, []);
});

test("normalizeSnapshot keeps trash entries and defaults a bad deletedAt", () => {
  const entry = {
    id: "t1",
    deletedAt: "not-a-number",
    payload: {
      kind: "request",
      request: request("r1", "被删接口"),
      collectionId: "c1",
      collectionName: "示例集合",
    },
  };
  const raw = emptySnapshot();
  raw.trash = [entry];
  const snapshot = normalizeSnapshot(raw);
  assert.equal(snapshot.trash.length, 1);
  assert.equal(snapshot.trash[0].id, "t1");
  assert.equal(snapshot.trash[0].deletedAt, 0);
  assert.equal(snapshot.trash[0].payload.kind, "request");
  assert.equal(snapshot.trash[0].payload.request.name, "被删接口");
});

test("normalizeSnapshot round-trips case and scenario trash payloads", () => {
  const raw = emptySnapshot();
  raw.trash = [
    {
      id: "t2",
      deletedAt: 1700000000000,
      payload: {
        kind: "case",
        caseItem: {
          id: "case1",
          name: "被删用例",
          requestId: "r1",
          group: "正向",
          request: request("r1", "宿主接口"),
          createdAt: 0,
          updatedAt: 0,
          lastRun: undefined,
        },
      },
    },
    {
      id: "t3",
      deletedAt: 1700000001000,
      payload: {
        kind: "scenario",
        scenario: {
          id: "s1",
          name: "被删场景",
          steps: [],
          createdAt: 0,
          updatedAt: 0,
        },
      },
    },
  ];
  const snapshot = normalizeSnapshot(raw);
  assert.equal(snapshot.trash.length, 2);
  assert.equal(snapshot.trash[0].payload.caseItem.name, "被删用例");
  assert.equal(snapshot.trash[1].payload.scenario.name, "被删场景");
});
