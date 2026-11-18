// P0: a Node fetch fallback is NOT feature-equivalent to the Rust engine.
// Every degraded run must report the machine-readable capability gap instead
// of silently claiming "same execution chain as the desktop".
import test from "node:test";
import assert from "node:assert/strict";
import {
  NODE_FALLBACK_DIFFERENCES,
  nodeFallbackDiagnostics,
  pushNodeFallbackDiagnostics,
  createRequester,
} from "../bin/requester.mjs";

const REQUIRED = [
  "proxy", "tls", "cookies", "mtls", "sigv4", "bodyTypes", "dbSteps", "wire",
];

test("能力差异清单覆盖 P0 要求的全部维度", () => {
  const capabilities = NODE_FALLBACK_DIFFERENCES.map((item) => item.capability);
  for (const name of REQUIRED) {
    assert.ok(capabilities.includes(name), `缺少能力差异项 ${name}`);
  }
  for (const item of NODE_FALLBACK_DIFFERENCES) {
    assert.ok(item.desktop && item.nodeFetch, `${item.capability} 必须同时说明两端行为`);
  }
});

test("诊断结果结构化，transport 如实标为 node-fetch", () => {
  const diagnostic = nodeFallbackDiagnostics();
  assert.equal(diagnostic.mode, "diagnostic");
  assert.equal(diagnostic.transport, "node-fetch");
  assert.equal(diagnostic.engine, "none");
  assert.match(diagnostic.summary, /不能假装|如实/);
  assert.equal(diagnostic.differences.length, NODE_FALLBACK_DIFFERENCES.length);
  // Returned arrays/objects must be copies, not the frozen shared constants.
  assert.notStrictEqual(diagnostic.differences, NODE_FALLBACK_DIFFERENCES);
});

test("note 中的能力差异清单只追加一次", () => {
  const note = ["已有一条提示"];
  pushNodeFallbackDiagnostics(note);
  pushNodeFallbackDiagnostics(note);
  assert.equal(note.length, 2);
  assert.match(note[1], /显式诊断模式/);
  for (const name of REQUIRED) assert.match(note[1], new RegExp(`\\[${name}\\]`));
  assert.equal(pushNodeFallbackDiagnostics(null), null);
});

test("engine=null 的降级运行结果 note 带显式诊断清单", async () => {
  const snapshot = {
    collections: [],
    cases: [],
    scenarios: [],
    environments: [],
    settings: { timeoutSecs: 1, followRedirects: true },
  };
  const requester = createRequester(snapshot, { engine: null });
  const request = {
    id: "diag-1",
    name: "diagnostic",
    method: "GET",
    // Port 1 is reserved/unreachable: the request fails before any real
    // network IO, but the fallback path still returns a note array.
    url: "http://127.0.0.1:1/__diagnostic__",
    headers: [],
    query: [],
    pathVariables: [],
    body: { type: "none" },
    auth: { type: "none" },
    assertions: [],
    preScript: "",
    postScript: "",
  };
  const result = await requester.send(request, {});
  assert.ok(Array.isArray(result.note), "降级运行必须返回 note 数组");
  assert.ok(
    result.note.some((line) => String(line).includes("显式诊断模式")),
    "降级运行必须进入显式诊断模式",
  );
  assert.ok(
    result.note.some((line) => String(line).includes("[proxy]")),
    "诊断清单必须逐项列出能力差异",
  );
});
