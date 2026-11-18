// Staging contract test: the JS stage script and the Rust installer must agree
// on the manifest shape ({ version, files: [{ target, sha256 }] }) and the target
// layout (mcp/, skills/<name>/, bin/). A drift here would silently install
// nothing on first launch, so we lock it down on the JS side too.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { stage } from "../scripts/stage-bundle-assets.mjs";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "reqora-stage-"));
  const outDir = path.join(root, "src-tauri", "bundle-assets");
  mkdirSync(path.join(root, "dist-mcp"), { recursive: true });
  mkdirSync(path.join(root, "skills", "reqora-mcp"), { recursive: true });
  mkdirSync(path.join(root, "skills", "reqora-standards"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(path.join(root, "dist-mcp", "mcp.mjs"), "// bundle\n");
  writeFileSync(path.join(root, "skills", "reqora-mcp", "SKILL.md"), "# mcp skill\n");
  writeFileSync(path.join(root, "skills", "reqora-standards", "SKILL.md"), "# standards\n");
  return { root, outDir };
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("stage produces manifest matching the Rust installer contract", () => {
  const { root, outDir } = fixture();
  try {
    const { manifest } = stage({ root, outDir, quiet: true });
    assert.equal(manifest.version, "1.2.3");
    const targets = manifest.files.map((f) => f.target).sort();
    assert.deepEqual(targets, [
      "mcp/mcp.mjs",
      "skills/reqora-mcp/SKILL.md",
      "skills/reqora-standards/SKILL.md",
    ]);
    // Every sha256 must match the staged bytes, or the installer rejects it.
    for (const file of manifest.files) {
      assert.equal(file.sha256, sha(readFileSync(path.join(outDir, file.target))));
      assert.doesNotMatch(file.target, /\\|^\//); // Rust safe_target() rejects these
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stage includes the engine sidecar when a build artifact exists", () => {
  const { root, outDir } = fixture();
  try {
    const exe = process.platform === "win32" ? "reqora-send.exe" : "reqora-send";
    const triple = `${process.platform}-${process.arch}`;
    mkdirSync(path.join(root, "dist-engine", triple), { recursive: true });
    writeFileSync(path.join(root, "dist-engine", triple, exe), "binary-stub");
    const { manifest } = stage({ root, outDir, quiet: true });
    assert.ok(manifest.files.some((f) => f.target === `bin/${exe}`));
    assert.equal(readFileSync(path.join(outDir, "bin", exe), "utf8"), "binary-stub");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stage --strict fails when mcp.mjs is missing", () => {
  const { root, outDir } = fixture();
  try {
    rmSync(path.join(root, "dist-mcp", "mcp.mjs"));
    assert.throws(() => stage({ root, outDir, strict: true, quiet: true }), /mcp\.mjs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stage is idempotent (repeat runs do not accumulate manifest entries)", () => {
  const { root, outDir } = fixture();
  try {
    const first = stage({ root, outDir, quiet: true });
    const second = stage({ root, outDir, quiet: true });
    assert.deepEqual(second.manifest, first.manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
