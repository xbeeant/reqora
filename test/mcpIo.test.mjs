import assert from "node:assert/strict";
import test from "node:test";

import { createMessageQueue } from "../bin/mcpIo.mjs";

function harness({ handle }) {
  const frames = [];
  const logs = [];
  const io = createMessageQueue({
    handle,
    write: (frame) => frames.push(frame),
    log: (text) => logs.push(text),
  });
  return { io, frames, logs };
}

test("handler 抛错时仍回 JSON-RPC 错误帧，队列不会卡死", async () => {
  let shouldFail = true;
  const { io, frames, logs } = harness({
    handle: async (message) => {
      if (shouldFail) throw new Error("boom");
      return { jsonrpc: "2.0", id: message.id, result: { ok: true } };
    },
  });

  await io.enqueue(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" }));
  assert.deepEqual(frames, [{ jsonrpc: "2.0", id: 7, error: { code: -32603, message: "boom" } }]);
  assert.match(logs[0], /boom/u);

  shouldFail = false;
  await io.enqueue(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "ping" }));
  assert.deepEqual(frames[1], { jsonrpc: "2.0", id: 8, result: { ok: true } });
});

test("JSON 解析失败回 -32700，通知抛错不产生响应帧", async () => {
  const { io, frames } = harness({ handle: async () => { throw new Error("unreachable"); } });

  await io.enqueue("{not json");
  assert.deepEqual(frames[0], {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "JSON 解析失败" },
  });

  await io.enqueue(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal(frames.length, 1, "通知不应收到响应帧");
});

test("消息按到达顺序串行处理", async () => {
  const order = [];
  const { io, frames } = harness({
    handle: async (message) => {
      order.push(`start-${message.id}`);
      await new Promise((resolve) => setTimeout(resolve, message.id === 1 ? 10 : 0));
      order.push(`end-${message.id}`);
      return { jsonrpc: "2.0", id: message.id, result: {} };
    },
  });
  const first = io.enqueue(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
  const second = io.enqueue(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }));
  await Promise.all([first, second]);
  assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2"]);
  assert.deepEqual(frames.map((frame) => frame.id), [1, 2]);
});
