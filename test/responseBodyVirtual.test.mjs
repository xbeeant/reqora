/**
 * Virtual response body windowing. The pure helpers are imported directly
 * (zero runtime deps); the React / Tauri surfaces are checked as source text
 * because there is no DOM runner and no Rust toolchain in this suite.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BODY_WINDOW_LINES,
  BodyWindowCache,
  inlineLines,
  windowFor,
} from "../src/lib/bodyWindow.ts";

const source = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

test("BODY_WINDOW_LINES is a fixed fetch granularity", () => {
  assert.equal(BODY_WINDOW_LINES, 200);
});

test("windowFor clamps a negative scrollTop to the top", () => {
  const window = windowFor(-500, 200, 20, 5, 1000);
  assert.equal(window.startLine, 0);
  assert.ok(window.count > 0);
  assert.equal(window.offsetTop, 0);
});

test("windowFor handles zero and one-line bodies", () => {
  assert.equal(windowFor(0, 200, 20, 5, 0).count, 0);
  const one = windowFor(50, 200, 20, 5, 1);
  assert.equal(one.startLine, 0);
  assert.equal(one.count, 1);
  assert.equal(one.offsetTop, 0);
});

test("windowFor keeps the window inside the tail when scrolled past the end", () => {
  const total = 50;
  const window = windowFor(999999, 200, 20, 5, total);
  assert.ok(window.startLine >= 0 && window.startLine < total);
  assert.equal(window.startLine + window.count, total);
  assert.equal(window.offsetTop, window.startLine * 20);
});

test("windowFor offsetTop tracks startLine with overscan", () => {
  const window = windowFor(200, 200, 20, 3, 100);
  assert.equal(window.startLine, 7);
  assert.equal(window.offsetTop, window.startLine * 20);
});

test("inlineLines slices a window without newline characters", () => {
  assert.deepEqual(inlineLines("a\nb\nc\nd", 1, 2), ["b", "c"]);
  assert.deepEqual(inlineLines("a\nb\nc\nd", 10, 2), []);
  assert.deepEqual(inlineLines("a\nb", 0, 0), []);
  assert.deepEqual(inlineLines("single", 0, 5), ["single"]);
  for (const line of inlineLines("x\ny\nz", 0, 3)) assert.ok(!line.includes("\n"));
});

test("BodyWindowCache evicts the least recently used window", () => {
  const cache = new BodyWindowCache(3);
  cache.put("b", 0, 1, ["0"]);
  cache.put("b", 1, 1, ["1"]);
  cache.put("b", 2, 1, ["2"]);
  assert.ok(cache.has("b", 1, 1)); // touch 1, so 0 becomes the oldest
  cache.put("b", 3, 1, ["3"]); // evicts the 0 window
  assert.equal(cache.get("b", 0, 1), undefined);
  assert.ok(cache.has("b", 1, 1));
  assert.ok(cache.has("b", 3, 1));
});

test("BodyWindowCache stitches adjacent cached windows", () => {
  const cache = new BodyWindowCache();
  cache.put("b", 0, 2, ["a", "b"]);
  cache.put("b", 2, 2, ["c", "d"]);
  assert.deepEqual(cache.get("b", 0, 4), ["a", "b", "c", "d"]);
  assert.equal(cache.get("b", 0, 5), undefined);
});

test("BodyWindowCache.clear drops one body or all of them", () => {
  const cache = new BodyWindowCache();
  cache.put("a", 0, 1, ["a"]);
  cache.put("b", 0, 1, ["b"]);
  cache.clear("a");
  assert.equal(cache.has("a", 0, 1), false);
  assert.ok(cache.has("b", 0, 1));
  cache.clear();
  assert.equal(cache.has("b", 0, 1), false);
});

test("responseBody re-exports helpers and exposes both loaders", () => {
  const module = source("../src/lib/responseBody.ts");
  assert.match(module, /export \{[\s\S]*windowFor/);
  assert.match(module, /loadBodyLines/);
  assert.match(module, /materializeResponseBody/);
  assert.match(module, /api\.readResponseLines/);
  assert.match(module, /lines\.join\("\\n"\)/);
});

test("VirtualCodeView avoids innerHTML and positions rows with translateY", () => {
  const component = source("../src/components/VirtualCodeView.tsx");
  assert.ok(!component.includes("dangerouslySetInnerHTML"));
  assert.match(component, /translateY/);
  assert.match(component, /aria-label/);
  assert.match(component, /windowFor/);
});

test("Rust body pipeline streams, tees to BLOB chunks and decodes four codecs", () => {
  const pipeline = source("../src-tauri/crates/reqora-core/src/service/response_body.rs");
  assert.match(pipeline, /bytes_stream\(\)/);
  assert.match(pipeline, /into_async_read\(\)/);
  assert.match(pipeline, /append_chunk\(/);
  assert.match(pipeline, /append_line_offsets\(/);
  assert.match(pipeline, /inline_cap/);
  for (const decoder of [
    "GzipDecoder",
    "ZlibDecoder",
    "DeflateDecoder",
    "BrotliDecoder",
    "ZstdDecoder",
  ]) {
    assert.ok(pipeline.includes(decoder), `missing ${decoder}`);
  }

  const store = source("../src-tauri/crates/reqora-core/src/service/body_store.rs");
  assert.match(store, /response_chunk/);
  assert.match(store, /response_line/);
  assert.match(store, /read_range/);
  assert.match(store, /line_range/);

  const cargo = source("../src-tauri/Cargo.toml");
  assert.match(cargo, /async-compression/);
});

test("auto-decompression is disabled so the Content-Encoding chain survives", () => {
  const http = source("../src-tauri/crates/reqora-core/src/service/http.rs");
  for (const toggle of ["gzip", "brotli", "deflate", "zstd"]) {
    assert.match(http, new RegExp(`\\.${toggle}\\(false\\)`), `missing .${toggle}(false)`);
  }
  assert.match(http, /ACCEPT_ENCODING/);
  assert.match(http, /gzip, deflate, br, zstd/);
});

test("workspace saves diff staged rows instead of deleting every table", () => {
  const storage = source("../src-tauri/src/storage.rs");
  assert.match(storage, /create_stage_tables/);
  assert.match(storage, /apply_staged_changes/);
  assert.match(storage, /ON CONFLICT\(id\) DO UPDATE SET/);
  assert.match(storage, /save_with_write_count/);
  assert.ok(!storage.includes('"DELETE FROM entity"'));
  assert.ok(!storage.includes('"DELETE FROM history"'));
  assert.ok(!storage.includes('"DELETE FROM meta"'));
});

test("post-scripts materialise the full spooled body before running", () => {
  const pipeline = source("../src/store/workspace/pipeline.ts");
  assert.match(pipeline, /materializeResponseBody/);
  assert.match(pipeline, /scriptResponse/);
  assert.match(pipeline, /evaluateAssertions\(request\.assertions, scriptResponse\)/);
});
