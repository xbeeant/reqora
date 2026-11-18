// Regression tests for the "send and download" send mode:
//   1. a normal send still writes both history stores
//   2. a download send skips them entirely and copies the spooled body to a file
//   3. a failed download send is also kept out of history
//
// The slice is driven through a fake in-memory context and a fake Tauri
// `invoke`, so no WebView, Rust command or real network is involved.
import assert from "node:assert/strict";
import test, { after } from "node:test";

const commands = [];
const originalWindow = globalThis.window;
let failSend = false;
globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args) => {
      commands.push({ cmd, args });
      if (cmd === "send_request") {
        if (failSend) throw new Error("network down");
        return makeResponse();
      }
      if (cmd === "save_response_body") return { path: "C:/tmp/report.pdf", size: 4 };
      throw new Error(`unexpected command: ${cmd}`);
    },
  },
};
after(() => {
  globalThis.window = originalWindow;
});

const { createRequestRunSlice } = await import("../src/store/workspace/slices/requestRun.ts");
const { emptyRequest, emptySnapshot } = await import("../src/lib/defaults.ts");

function makeResponse() {
  return {
    requestId: "r1",
    status: 200,
    statusText: "OK",
    ok: true,
    timeMs: 12,
    size: 4,
    url: "https://api.example.test/files/report.pdf",
    resolvedUrl: "https://api.example.test/files/report.pdf",
    missingVariables: [],
    headers: [
      { name: "content-type", value: "application/pdf" },
      { name: "content-disposition", value: 'attachment; filename="report.pdf"' },
    ],
    body: "%PDF",
    bodyKind: "binary",
    truncated: true,
    bodyRef: "body-1",
    inlineBytes: 4,
    totalLines: 1,
  };
}

function makeHarness({ failSend: shouldFail = false } = {}) {
  failSend = shouldFail;
  const calls = { history: 0, append: 0, console: [] };
  let state;
  const ctx = {
    set: (patch) => {
      state = { ...state, ...patch };
    },
    get: () => state,
    runtime: {},
    recordHistory: () => {
      calls.history += 1;
    },
  };
  const slice = createRequestRunSlice(ctx);
  state = {
    ...slice,
    snapshot: emptySnapshot(),
    draft: {
      ...emptyRequest(),
      id: "req-1",
      name: "下载报表",
      method: "POST",
      url: "https://api.example.test/files/report.pdf",
    },
    activeTab: { kind: "request", id: "req-1" },
    detailTab: "debug",
    isSending: false,
    pushConsole: (entry) => calls.console.push(entry),
    appendHistory: () => {
      calls.append += 1;
    },
  };
  return { calls, send: slice.send, state: () => state };
}

const mentionsNoHistory = (entry) =>
  entry.source === "http" && (/历史/.test(entry.text) || /history/i.test(entry.text));

test("normal send records both request history and execution history", async () => {
  commands.length = 0;
  const harness = makeHarness();
  await harness.send();
  assert.equal(harness.calls.history, 1);
  assert.equal(harness.calls.append, 1);
  assert.equal(commands.filter((item) => item.cmd === "save_response_body").length, 0);
});

test("send and download skips history and saves the full spooled body", async () => {
  commands.length = 0;
  const harness = makeHarness();
  await harness.send({ download: true });
  assert.equal(harness.calls.history, 0);
  assert.equal(harness.calls.append, 0);
  const saved = commands.find((item) => item.cmd === "save_response_body");
  assert.ok(saved, "save_response_body must be invoked");
  assert.equal(saved.args.bodyId, "body-1");
  assert.equal(saved.args.fileName, "report.pdf");
  assert.deepEqual(harness.state().downloadResult, {
    fileName: "report.pdf",
    path: "C:/tmp/report.pdf",
    size: 4,
  });
  assert.ok(harness.calls.console.some(mentionsNoHistory));
});

test("a failed download send is still kept out of history", async () => {
  const harness = makeHarness({ failSend: true });
  await harness.send({ download: true });
  assert.equal(harness.calls.history, 0);
  assert.equal(harness.calls.append, 0);
  assert.ok(harness.calls.console.some(mentionsNoHistory));
});
