// Regression coverage for "MCP 写入用例后，点击接口看不到新数据".
// The decision is pure; the watcher wiring is checked through its wrappers.

import assert from "node:assert/strict";
import test from "node:test";

import {
  checkExternalChanges,
  decideExternalChange,
  registerExternalChangeApi,
  startExternalChangeWatch,
  stopExternalChangeWatch,
} from "../src/store/workspace/externalChanges.ts";

test("版本未前进 / 无基线时什么都不做", () => {
  assert.equal(decideExternalChange(null, 10, false), "none");
  assert.equal(decideExternalChange({ rev: 11, writer: "mcp" }, null, false), "none");
  assert.equal(decideExternalChange({ rev: 10, writer: "mcp" }, 10, false), "none");
  assert.equal(decideExternalChange({ rev: 9, writer: "mcp" }, 10, false), "none");
});

test("桌面端自己的写入只推进基线，不重载快照", () => {
  assert.equal(decideExternalChange({ rev: 11, writer: "desktop" }, 10, false), "advance-baseline");
  assert.equal(decideExternalChange({ rev: 11, writer: "desktop" }, 10, true), "advance-baseline");
});

test("MCP / CLI 写入：空闲时自动重载，有未保存编辑时交给用户裁决", () => {
  assert.equal(decideExternalChange({ rev: 11, writer: "mcp" }, 10, false), "reload");
  assert.equal(decideExternalChange({ rev: 11, writer: "cli" }, 10, false), "reload");
  assert.equal(decideExternalChange({ rev: 11, writer: "mcp" }, 10, true), "conflict");
});

test("监视器包装函数在未注册时安全，注册后正确转发", async () => {
  registerExternalChangeApi(null);
  await checkExternalChanges("test");
  startExternalChangeWatch();
  stopExternalChangeWatch();

  const seen = [];
  registerExternalChangeApi({
    check: async (reason) => seen.push(`check:${reason}`),
    start: () => seen.push("start"),
    stop: () => seen.push("stop"),
  });
  await checkExternalChanges("poll");
  startExternalChangeWatch();
  stopExternalChangeWatch();
  assert.deepEqual(seen, ["check:poll", "start", "stop"]);
  registerExternalChangeApi(null);
});
