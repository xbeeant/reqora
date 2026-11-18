/**
 * Integration wiring checks. These read sources as text — the desktop WebView
 * has no DOM test runner here, and the Rust build needs a real toolchain.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readWorkspaceSource } from "./helpers/workspaceSource.mjs";
import test from "node:test";

const source = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

test("response viewer wires timing, raw exchange and image preview tabs", () => {
  const viewer = source("../src/components/ResponseViewer.tsx");
  // 标签文案已接入 i18n（response.tab.*），这里校验接线而非具体语言。
  assert.match(viewer, /key: "timing", label: t\("response\.tab\.timing"\)/);
  assert.match(viewer, /key: "raw", label: t\("response\.tab\.raw"\)/);
  assert.match(viewer, /<TimingView response=\{response\} \/>/);
  assert.match(viewer, /<RawView/);
  assert.match(viewer, /<ImagePreviewPane/);
  assert.match(viewer, /queryJsonPath\(parsedBody, jsonPath\)/);
  assert.match(viewer, /detectImage\(response\)/);
  assert.match(viewer, /timingSegments\(timings\)/);
  assert.match(viewer, /wb-timing-jump/);
});

test("JSON tree receives filter paths, expand controls and path copying", () => {
  const tree = source("../src/components/JsonTree.tsx");
  assert.match(tree, /exactPaths\?\.has\(path\)/);
  assert.match(tree, /ancestorPaths\?\.has\(path\)/);
  assert.match(tree, /onlyMatches/);
  assert.match(tree, /expandAll/);
  assert.match(tree, /onCopyPath/);
  assert.match(tree, /childPath\(path, key\)/);
});

test("frontend response type carries the new optional fields", () => {
  const types = source("../src/types.ts");
  assert.match(types, /export interface ResponseTimings/);
  assert.match(types, /timings\?: ResponseTimings/);
  assert.match(types, /rawRequest\?: string/);
  assert.match(types, /rawResponse\?: string/);
  assert.match(types, /tlsMerged: boolean/);
});

test("script sandbox exposes timings and raw messages to post-scripts", () => {
  const scripts = source("../src/lib/scripts.ts");
  assert.match(scripts, /timings: raw\.timings/);
  assert.match(scripts, /rawRequest: raw\.rawRequest/);
});

test("Rust side instruments DNS, connect and wire messages", () => {
  const http = source("../src-tauri/crates/reqora-core/src/service/http.rs");
  assert.match(http, /dns_resolver\(/);
  assert.match(http, /connector_layer\(/);
  assert.match(http, /wire_request\(/);
  assert.match(http, /wire_response\(/);
  assert.match(http, /ttfb_ms = started\.elapsed\(\)/);
  assert.match(http, /timings\.finish\(/);

  const timing = source("../src-tauri/crates/reqora-core/src/service/timing.rs");
  assert.match(timing, /impl Resolve for TimedResolver/);
  assert.match(timing, /impl<S, Req, R, E, F> Service<Req> for TimedConnector<S>/);
  assert.match(timing, /tls_merged/);

  const models = source("../src-tauri/crates/reqora-core/src/models.rs");
  assert.match(models, /pub timings: ResponseTimings/);
  assert.match(models, /pub raw_request: String/);
  assert.match(models, /pub raw_response: String/);

  const cargo = source("../src-tauri/Cargo.toml");
  assert.match(cargo, /tower-layer = "0\.3"/);
  assert.match(cargo, /tower-service = "0\.3"/);
});

test("SSE streams carry timings and verbatim wire bytes too", () => {
  const envelope = source("../src-tauri/crates/reqora-core/src/service/sse.rs");
  assert.match(envelope, /pub timings: ResponseTimings/);
  assert.match(envelope, /pub raw_request: String/);
  assert.match(envelope, /raw_response: String/);

  // stream_request 在 controller 分组后迁到 commands/http.rs
  const commands = source("../src-tauri/src/commands/http.rs");
  assert.match(commands, /raw_chunks\.extend_from_slice/);
  assert.match(commands, /timings: meta\.timings\.finish\(/);

  const sseLib = source("../src/lib/sse.ts");
  assert.match(sseLib, /extra\.timings/);
  assert.match(sseLib, /extra\.rawResponse/);

  const store = readWorkspaceSource();
  assert.match(store, /rawResponse: received\.done\?\.rawResponse/);
  assert.match(store, /timings: received\.done\?\.timings/);

  const types = source("../src/types.ts");
  assert.match(types, /export interface SseDone \{[\s\S]*?timings\?: ResponseTimings/);
});

test("CSP allows data: image previews", () => {
  const config = source("../src-tauri/tauri.conf.json");
  assert.match(config, /img-src 'self' data:/);
});

test("styles cover every new surface", () => {
  const css = source("../src/index.css");
  for (const selector of [
    ".wb-jsonpath-bar",
    ".wb-jsonpath-results",
    ".wb-json-row-hit",
    ".wb-image-stage",
    ".wb-timeline",
    ".wb-timing-table",
    ".wb-raw",
  ]) {
    assert.ok(css.includes(selector), `missing ${selector}`);
  }
});
