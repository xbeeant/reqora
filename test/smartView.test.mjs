/** Pure helpers behind the smart response views. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  detectImage,
  formatDuration,
  hasRawExchange,
  timingRows,
  timingSegments,
} from "../src/lib/smartView.ts";

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]).toString("base64");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]).toString("base64");

const response = (overrides = {}) => ({
  requestId: "r1",
  status: 200,
  statusText: "OK",
  ok: true,
  timeMs: 120,
  size: 16,
  url: "https://example.com/image",
  resolvedUrl: "https://example.com/image",
  missingVariables: [],
  headers: [],
  body: png,
  bodyKind: "binary",
  truncated: false,
  ...overrides,
});

test("declared image content type produces a data URL", () => {
  const preview = detectImage(response({ headers: [{ name: "Content-Type", value: "image/png" }] }));
  assert.ok(preview);
  assert.equal(preview.mime, "image/png");
  assert.equal(preview.sniffed, false);
  assert.equal(preview.dataUrl, `data:image/png;base64,${png}`);
});

test("image signature is sniffed when Content-Type is missing or generic", () => {
  const preview = detectImage(
    response({ headers: [{ name: "Content-Type", value: "application/octet-stream" }], body: jpeg }),
  );
  assert.ok(preview);
  assert.equal(preview.mime, "image/jpeg");
  assert.equal(preview.sniffed, true);
  assert.ok(preview.dataUrl.startsWith("data:image/jpeg;base64,"));
});

test("SVG and non-images are never rendered as bitmaps", () => {
  assert.equal(
    detectImage(response({ headers: [{ name: "content-type", value: "image/svg+xml" }], bodyKind: "text" })),
    null,
  );
  assert.equal(
    detectImage(response({ headers: [{ name: "content-type", value: "application/octet-stream" }], body: Buffer.from("hello world").toString("base64") })),
    null,
  );
  assert.equal(detectImage(response({ bodyKind: "text" })), null);
  assert.equal(detectImage(response({ body: "not base64!!" })), null);
  assert.equal(detectImage(response({ body: "" })), null);
});

test("timings expose five rows with an honest TLS note on HTTPS", () => {
  const timings = {
    dnsMs: 4,
    tcpMs: 21,
    tlsMs: 0,
    tlsMerged: true,
    serverMs: 60,
    transferMs: 15,
    totalMs: 100,
    reused: false,
    protocol: "HTTP/2.0",
  };
  const rows = timingRows(timings);
  assert.deepEqual(rows.map((row) => row.key), ["dns", "tcp", "tls", "server", "transfer"]);
  assert.equal(rows[1].hint, "TCP 连接 + TLS 握手");
  assert.equal(rows[2].ms, 0, "never fabricate a TLS duration");
  assert.equal(rows[2].merged, true);
  assert.ok(rows[2].hint.includes("reqwest"));

  const segments = timingSegments(timings);
  assert.deepEqual(segments.map((s) => s.key), ["dns", "tcp", "server", "transfer"]);
  assert.ok(Math.abs(segments.reduce((sum, s) => sum + s.width, 0) - 100) < 0.001);
  assert.equal(segments[1].offset, 4);
});

test("reused connections are labelled in the timing breakdown", () => {
  const timings = {
    dnsMs: 0, tcpMs: 0, tlsMs: 0, tlsMerged: false,
    serverMs: 8, transferMs: 1, totalMs: 9, reused: true, protocol: "HTTP/1.1",
  };
  assert.ok(timingRows(timings)[0].hint.includes("未发生解析"));
  assert.equal(formatDuration(9), "9 ms");
  assert.equal(formatDuration(1500), "1.50 s");
});

test("raw exchange availability is explicit", () => {
  assert.equal(hasRawExchange(response()), false);
  assert.equal(
    hasRawExchange(response({ rawRequest: "GET / HTTP/1.1", rawResponse: "HTTP/1.1 200 OK" })),
    true,
  );
});
