import test from "node:test";
import assert from "node:assert/strict";

import {
  RUNTIME_CONNECTING,
  runtimeLabel,
  runtimeStatusLabel,
} from "../src/lib/runtimeLabel.ts";

test("状态栏使用对外品牌 Reqora 与中文状态", () => {
  assert.equal(
    runtimeLabel({ version: "0.1.0", status: "ready" }),
    "Reqora 0.1.0 · 已就绪",
  );
  assert.ok(!runtimeLabel({ version: "0.1.0", status: "ready" }).includes("Rust"));
});

test("运行时未连通时显示连接中", () => {
  assert.equal(runtimeLabel(null), RUNTIME_CONNECTING);
  assert.equal(runtimeLabel(undefined), "运行时连接中…");
});

test("未知状态原样保留，不误报已就绪", () => {
  assert.equal(runtimeStatusLabel("degraded"), "degraded");
  assert.equal(
    runtimeLabel({ version: "0.2.0", status: "degraded" }),
    "Reqora 0.2.0 · degraded",
  );
});
