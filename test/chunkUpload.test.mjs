// 分块上传（chunkRowsForUpload / findOversizedRows）：服务端对单次 sync 的
// 全部行 data 求和做 5 MiB 上限检查（1010 / 413），客户端按更小的字节预算把
// 变更行切块逐次上传。分块必须：行不跨块、域与行顺序稳定、重复调用幂等、
// 单行超预算的行独立成块且被 findOversizedRows 报告。
import test from "node:test";
import assert from "node:assert/strict";
import {
  SYNC_CHUNK_BYTES,
  chunkRowsForUpload,
  findOversizedRows,
} from "../src/lib/cloudSync.ts";

const emptyRows = () => ({
  folders: [],
  requests: [],
  environments: [],
  cases: [],
  scenarios: [],
  suites: [],
  artifacts: [],
});

const requestRow = (id, fillerKiB = 1) => ({
  id,
  updatedAt: 1731300000000,
  folderId: "f1",
  folderPath: "",
  name: `行 ${id}`,
  method: "POST",
  url: "/x",
  protocol: "http",
  position: 0,
  data: { blob: "x".repeat(fillerKiB * 1024) },
});

const bytesOf = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

const chunkRowTotal = (chunk) =>
  ["folders", "requests", "environments", "cases", "scenarios", "suites", "artifacts"].reduce(
    (total, domain) => total + (chunk[domain] ?? []).reduce((sum, row) => sum + bytesOf(row), 0),
    0,
  );

test("empty payload produces no chunks", () => {
  assert.deepEqual(chunkRowsForUpload(emptyRows()), []);
});

test("payload under budget stays a single chunk with original order", () => {
  const payload = emptyRows();
  payload.folders.push({ id: "f1", updatedAt: 1, name: "集合", position: 0 });
  payload.requests.push(requestRow("r1"), requestRow("r2"));
  const chunks = chunkRowsForUpload(payload, SYNC_CHUNK_BYTES);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].folders.map((row) => row.id), ["f1"]);
  assert.deepEqual(chunks[0].requests.map((row) => row.id), ["r1", "r2"]);
});

test("payload over budget splits by bytes without splitting a row", () => {
  const payload = emptyRows();
  // 12 行 × 400 KiB ≈ 4.7 MiB，预算 1 MiB 时必须切成多块，且没有任何一行被拆开。
  for (let index = 1; index <= 12; index += 1) payload.requests.push(requestRow(`r${index}`, 400));
  const budget = 1024 * 1024;
  const chunks = chunkRowsForUpload(payload, budget);
  assert.ok(chunks.length > 1, `期望多块，实际 ${chunks.length}`);
  const ids = chunks.flatMap((chunk) => chunk.requests.map((row) => row.id));
  assert.deepEqual(ids, ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11", "r12"]);
  for (const chunk of chunks) {
    assert.ok(chunkRowTotal(chunk) <= budget, "每块行数据字节合计不得超过预算");
    assert.ok(chunk.requests.length >= 1, "每块至少有一行（行不跨块）");
  }
});

test("domain order is stable across chunk boundaries", () => {
  const payload = emptyRows();
  payload.folders.push({ id: "f1", updatedAt: 1, name: "集合", position: 0 });
  payload.environments.push({ id: "e1", updatedAt: 2, name: "环境", position: 0 });
  payload.requests.push(requestRow("r1", 700));
  payload.suites.push({ id: "s1", updatedAt: 3, name: "套件", position: 0 });
  const budget = 512 * 1024;
  const chunks = chunkRowsForUpload(payload, budget);
  // 域迭代顺序 folders→requests→environments→suites，行不跨块、不被重排：
  // f1 → 块 0；r1（超预算）独占块 1；e1、s1 顺延到块 2。
  assert.deepEqual(chunks[0].folders.map((row) => row.id), ["f1"]);
  assert.deepEqual(chunks[1].requests.map((row) => row.id), ["r1"]);
  assert.deepEqual(chunks[2].environments.map((row) => row.id), ["e1"]);
  assert.deepEqual(chunks[2].suites.map((row) => row.id), ["s1"]);
  // 跨块的扁平顺序与上传域顺序一致（确定性）。
  const flatIds = chunks.flatMap((chunk) =>
    ["folders", "requests", "environments", "cases", "scenarios", "suites", "artifacts"].flatMap(
      (domain) => chunk[domain].map((row) => row.id),
    ),
  );
  assert.deepEqual(flatIds, ["f1", "r1", "e1", "s1"]);
});

test("oversized row is isolated into its own chunk and reported", () => {
  const payload = emptyRows();
  payload.requests.push(requestRow("normal"));
  payload.requests.push(requestRow("huge", 2 * 1024)); // 约 2 MiB，预算 1 MiB
  payload.requests.push(requestRow("after"));
  const budget = 1024 * 1024;
  const oversized = findOversizedRows(payload, budget);
  assert.equal(oversized.length, 1);
  assert.equal(oversized[0].id, "huge");
  assert.equal(oversized[0].domain, "requests");
  assert.equal(oversized[0].name, "行 huge");
  const chunks = chunkRowsForUpload(payload, budget);
  const hugeChunk = chunks.find((chunk) => chunk.requests.some((row) => row.id === "huge"));
  assert.equal(hugeChunk.requests.length, 1, "超限行必须独占一块");
});

test("default budget is below the server's 5 MiB batch cap", () => {
  assert.equal(SYNC_CHUNK_BYTES, 4 * 1024 * 1024);
  assert.ok(SYNC_CHUNK_BYTES < 5 * 1024 * 1024);
});

test("chunking is deterministic for identical input", () => {
  const payload = emptyRows();
  for (let index = 1; index <= 6; index += 1) payload.requests.push(requestRow(`r${index}`, 300));
  const first = chunkRowsForUpload(payload, 1024 * 1024);
  const second = chunkRowsForUpload(payload, 1024 * 1024);
  assert.deepEqual(
    first.map((chunk) => chunk.requests.map((row) => row.id)),
    second.map((chunk) => chunk.requests.map((row) => row.id)),
  );
});
