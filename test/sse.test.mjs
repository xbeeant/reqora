/**
 * Pure-logic tests for the SSE merge engine.
 *
 * Run with `bun run test`. Node 22 strips TypeScript types natively, so these
 * tests import the real production modules — no bundler, no extra deps, no
 * duplicated merge logic in the test file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MERGE_CONFIG,
  createSseMerger,
  detectSseFormat,
  isEventStreamResponse,
  isNdjsonResponse,
  parseNdjsonText,
  parseSseText,
  shouldUseStream,
  sseToResponseData,
} from "../src/lib/sse.ts";

let seq = 0;
function frame(data, extra = {}) {
  seq += 1;
  return {
    seq,
    atMs: seq * 10,
    event: "message",
    id: "",
    data,
    raw: `data: ${data}`,
    ...extra,
  };
}

function openai(delta) {
  return JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] });
}

function merge(frames, config = DEFAULT_MERGE_CONFIG) {
  const merger = createSseMerger(config);
  let snapshot = merger.snapshot();
  for (const item of frames) snapshot = merger.push(item);
  return snapshot;
}

test("detectSseFormat recognises the common streaming shapes", () => {
  assert.equal(detectSseFormat(openai({ content: "hi" })), "openai");
  assert.equal(
    detectSseFormat(JSON.stringify({ candidates: [{ content: { parts: [{ text: "x" }] } }] })),
    "gemini",
  );
  assert.equal(
    detectSseFormat(JSON.stringify({ type: "content_block_delta", delta: { text: "x" } })),
    "claude",
  );
  assert.equal(detectSseFormat(JSON.stringify({ answer: "x" })), "genericJson");
  assert.equal(detectSseFormat("plain fragment"), "plainText");
  assert.equal(detectSseFormat("[DONE]"), "unknown");
  assert.equal(detectSseFormat(""), "unknown");
});

test("auto merge builds readable text incrementally and separates reasoning", () => {
  const merger = createSseMerger(DEFAULT_MERGE_CONFIG);
  const inputs = [
    openai({ reasoning_content: "让我想想" }),
    openai({ content: "春风" }),
    openai({ content: "拂过" }),
    "[DONE]",
  ];

  const seen = [];
  for (const data of inputs) seen.push(merger.push(frame(data)).mergedText);

  assert.deepEqual(seen, ["", "春风", "春风拂过", "春风拂过"]);
  const snapshot = merger.snapshot();
  assert.equal(snapshot.format, "openai");
  assert.equal(snapshot.reasoningText, "让我想想");
  assert.equal(snapshot.frames.length, 4);
  assert.equal(snapshot.snippets.length, 4, "one snippet per frame, even for skipped frames");
  assert.deepEqual(snapshot.snippets, ["", "春风", "拂过", ""]);
});

test("Gemini, Claude and plain text fragments all merge", () => {
  const gemini = [
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "Gemini " }] } }] }),
    JSON.stringify({ candidates: [{ content: { parts: [{ text: "streams" }] } }] }),
  ].map((data) => frame(data));
  assert.equal(merge(gemini).mergedText, "Gemini streams");

  const claude = [
    JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Claude " } }),
    JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "text." } }),
  ].map((data) => frame(data));
  assert.equal(merge(claude).mergedText, "Claude text.");

  const plain = ["春", "天", "来", "了", "。"].map((data) => frame(data));
  const plainSnapshot = merge(plain);
  assert.equal(plainSnapshot.mergedText, "春天来了。");
  assert.equal(plainSnapshot.format, "plainText");
});

test("custom JSONPath and reasoning path extract non-standard shapes", () => {
  const frames = ["自定义", "字段"].map((piece) =>
    frame(
      JSON.stringify({
        chunk: { text: piece },
        thinking: `想法${piece}`,
      }),
    ),
  );
  const snapshot = merge(frames, {
    mode: "jsonPath",
    jsonPath: "$.chunk.text",
    reasoningPath: "$.thinking",
  });
  assert.equal(snapshot.format, "custom");
  assert.equal(snapshot.mergedText, "自定义字段");
  assert.equal(snapshot.reasoningText, "想法自定义想法字段");
});

test("rawText concatenates data verbatim and off produces no merged text", () => {
  const frames = [frame("a"), frame("b\nc")];
  const raw = merge(frames, { ...DEFAULT_MERGE_CONFIG, mode: "rawText" });
  assert.equal(raw.mergedText, "ab\nc");

  const off = merge(frames, { ...DEFAULT_MERGE_CONFIG, mode: "off" });
  assert.equal(off.mergedText, "");
  assert.equal(off.frames.length, 2, "timeline still keeps every event");
});

test("error events are never merged but stay on the timeline", () => {
  const snapshot = merge([
    frame("good"),
    frame('{"message":"boom"}', { event: "error" }),
  ]);
  assert.equal(snapshot.mergedText, "good");
  assert.equal(snapshot.frames.length, 2);
});

test("re-merging already received frames with a new rule needs no new request", () => {
  const frames = [frame(JSON.stringify({ chunk: { text: "甲" } })), frame(JSON.stringify({ chunk: { text: "乙" } }))];
  const before = merge(frames);
  assert.equal(before.mergedText, "", "generic paths cannot see nested chunk.text");

  const after = merge(frames, {
    mode: "jsonPath",
    jsonPath: "$.chunk.text",
    reasoningPath: "",
  });
  assert.equal(after.mergedText, "甲乙");
});

test("parseSseText handles the buffered SSE fallback", () => {
  const raw = [
    "\uFEFF: connected",
    "",
    "event: patch",
    "id: 7",
    "data: line one",
    "data: line two",
    "",
    ": heartbeat",
    "",
    "data: tail",
  ].join("\r\n");
  const frames = parseSseText(raw);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].event, "patch");
  assert.equal(frames[0].id, "7");
  assert.equal(frames[0].data, "line one\nline two");
  assert.equal(frames[1].data, "tail");
  assert.equal(
    merge(frames, { ...DEFAULT_MERGE_CONFIG, mode: "rawText" }).mergedText,
    "line one\nline twotail",
  );
});

test("shouldUseStream auto-detects the three common signals and honours overrides", () => {
  const base = {
    headers: [],
    body: { type: "none" },
    url: "http://127.0.0.1:8788/plain",
  };
  assert.equal(shouldUseStream(base), false);
  assert.equal(
    shouldUseStream({ ...base, headers: [{ enabled: true, key: "Accept", value: "text/event-stream" }] }),
    true,
  );
  assert.equal(
    shouldUseStream({ ...base, body: { type: "json", content: '{"stream": true}' } }),
    true,
  );
  assert.equal(shouldUseStream({ ...base, url: "http://x/v1/chat?stream=true" }), true);
  assert.equal(
    shouldUseStream({ ...base, stream: "off", body: { type: "json", content: '{"stream": true}' } }),
    false,
  );
  assert.equal(shouldUseStream({ ...base, stream: "on" }), true);
});

test("isEventStreamResponse checks the content-type header case-insensitively", () => {
  assert.equal(
    isEventStreamResponse({ headers: [{ name: "Content-Type", value: "text/event-stream; charset=utf-8" }] }),
    true,
  );
  assert.equal(isEventStreamResponse({ headers: [{ name: "content-type", value: "application/json" }] }), false);
});

test("sseToResponseData exposes the merged text as the response body", () => {
  const meta = {
    status: 200,
    statusText: "OK",
    ok: true,
    url: "http://127.0.0.1:8788/plain",
    resolvedUrl: "http://127.0.0.1:8788/plain",
    headers: [{ name: "content-type", value: "text/event-stream" }],
    missingVariables: [],
  };
  const frames = [frame("春"), frame("天")];
  const response = sseToResponseData(meta, frames, "春天", 123, "rid-sse", false);
  assert.equal(response.status, 200);
  assert.equal(response.body, "春天");
  assert.equal(response.bodyKind, "text");
  assert.equal(response.timeMs, 123);
  assert.equal(response.requestId, "rid-sse");
  assert.equal(response.truncated, false);

  const empty = sseToResponseData(meta, frames, "", 1, "rid-2", true);
  assert.match(empty.body, /data: 春/);
  assert.equal(empty.truncated, true);
});

test("sseToResponseData forwards stream timings and raw wire messages", () => {
  const meta = {
    status: 200,
    statusText: "OK",
    ok: true,
    url: "http://127.0.0.1:8788/stream",
    resolvedUrl: "http://127.0.0.1:8788/stream",
    headers: [{ name: "content-type", value: "text/event-stream" }],
    missingVariables: [],
  };
  const timings = {
    dnsMs: 1, tcpMs: 2, tlsMs: 0, tlsMerged: false,
    serverMs: 10, transferMs: 87, totalMs: 100, reused: false, protocol: "HTTP/1.1",
  };
  const response = sseToResponseData(meta, [], "hello", 100, "rid", false, {
    timings,
    rawRequest: "GET /stream HTTP/1.1\r\n\r\n",
    rawResponse: "HTTP/1.1 200 OK\r\n\r\ndata: hello",
  });
  assert.deepEqual(response.timings, timings);
  assert.equal(response.rawRequest, "GET /stream HTTP/1.1\r\n\r\n");
  assert.equal(response.rawResponse, "HTTP/1.1 200 OK\r\n\r\ndata: hello");

  // Older callers that omit the extra argument keep working.
  assert.equal(sseToResponseData(meta, [], "", 5, "rid", false).timings, undefined);
});

// ---- NDJSON 增量解析与合并（P2-11） ----

test("parseNdjsonText frames every non-empty line", () => {
  const raw = '{"a":1}\r\n{"a":2}\n\n  \n{"a":3}\n';
  const frames = parseNdjsonText(raw);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].data, '{"a":1}');
  assert.equal(frames[0].event, "ndjson");
  assert.equal(frames[0].seq, 1);
  assert.equal(frames[2].data, '{"a":3}');
  assert.equal(frames[2].seq, 3);
});

test("isNdjsonResponse detects ndjson/jsonl content types", () => {
  const response = (contentType) => ({
    headers: [{ name: "content-type", value: contentType }],
  });
  assert.equal(isNdjsonResponse(response("application/x-ndjson")), true);
  assert.equal(isNdjsonResponse(response("application/jsonl; charset=utf-8")), true);
  assert.equal(isNdjsonResponse(response("text/event-stream")), false);
  assert.equal(isNdjsonResponse(response("application/json")), false);
});

test("ndjson frames merge like SSE frames and keep raw lines as body", () => {
  const meta = {
    status: 200,
    statusText: "OK",
    ok: true,
    url: "http://127.0.0.1:8788/ndjson",
    resolvedUrl: "http://127.0.0.1:8788/ndjson",
    headers: [{ name: "content-type", value: "application/x-ndjson" }],
    missingVariables: [],
  };
  const frames = parseNdjsonText('{"content":"你"}\n{"content":"好"}\n');
  assert.equal(frames.length, 2);
  const merged = createSseMerger(DEFAULT_MERGE_CONFIG);
  let snapshot = merged.snapshot();
  for (const item of frames) snapshot = merged.push(item);
  assert.equal(snapshot.mergedText, "你好");
  // Raw body of an NDJSON stream is plain lines, not "data: " prefixed SSE.
  const response = sseToResponseData(meta, frames, "", 5, "rid-nd", false);
  assert.equal(response.body, '{"content":"你"}\n{"content":"好"}');
});
