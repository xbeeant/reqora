#!/usr/bin/env node
/**
 * Stage the "ships inside the installer" assets into `src-tauri/bundle-assets/`.
 * Tauri's `bundle.resources` then copies this whole folder into every desktop
 * installer, and the Rust installer (src/bundled_assets.rs) writes it to
 * ~/.reqora on first launch / version change.
 *
 * Staged layout:
 *   bundle-assets/manifest.json           version + { target, sha256 } list
 *   bundle-assets/mcp/mcp.mjs             single-file MCP server
 *   bundle-assets/skills/<name>/SKILL.md   AI skills
 *   bundle-assets/bin/reqora-send[.exe]    optional Rust engine sidecar
 *
 * NOTE: the ready-to-paste MCP config (~/.reqora/mcp/CONFIG.md) is generated at
 * *install time* by bundled_assets.rs, because its paths must point at the real
 * user's home — not the build machine's.
 *
 *   node scripts/stage-bundle-assets.mjs           # stage into src-tauri/bundle-assets
 *   node scripts/stage-bundle-assets.mjs --strict  # fail if mcp.mjs / skills missing
 *
 * The sidecar is optional: without it the installed MCP falls back to Node fetch
 * (explicit diagnostic mode). mcp.mjs and skills are required — a bundle with
 * no MCP server defeats the whole point, so --strict makes CI catch that.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.platform === "win32" ? "reqora-send.exe" : "reqora-send";

/** Candidate locations for the already-built engine sidecar, most specific first. */
function engineCandidates(root) {
  const triple = `${process.platform}-${process.arch}`;
  return [
    // macOS CI builds a universal sidecar so the DMG works on both arches.
    path.join(root, "dist-engine", "darwin-universal", exe),
    path.join(root, "dist-engine", triple, exe),
    path.join(root, "dist-engine", exe),
    path.join(root, "src-tauri", "target", "release", exe),
  ].filter(existsSync);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Pure-ish staging entry point. `root` and `outDir` are parameters so tests can
 * stage a throwaway fixture instead of touching the real repo.
 * Returns { manifest, outDir }.
 */
export function stage({ strict = false, root = defaultRoot, outDir = path.join(root, "src-tauri", "bundle-assets"), quiet = false } = {}) {
  const log = quiet ? () => {} : (...args) => console.log(...args);
  const warn = quiet ? () => {} : (...args) => console.warn(...args);
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

  const mcpSource = path.join(root, "dist-mcp", "mcp.mjs");
  const skillsSource = path.join(root, "skills");
  if (!existsSync(mcpSource)) {
    const message = `[stage] ✗ 缺少 ${mcpSource}，请先运行 bun run mcp:build`;
    if (strict) throw new Error(message);
    warn(message + "（跳过 MCP 入口）");
  }
  if (!existsSync(skillsSource)) {
    const message = `[stage] ✗ 缺少 ${skillsSource}`;
    if (strict) throw new Error(message);
    warn(message + "（跳过 skills）");
  }

  // Remove only generated content, keep the committed README.md so the
  // bundle.resources directory still exists before a fresh stage.
  for (const child of ["mcp", "skills", "bin"]) {
    rmSync(path.join(outDir, child), { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
  rmSync(path.join(outDir, "manifest.json"), { force: true });
  mkdirSync(outDir, { recursive: true });

  /** Copy one file into outDir and return its manifest entry. */
  const stageFile = (source, relTarget) => {
    const target = path.join(outDir, relTarget);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
    const rel = relTarget.replaceAll("\\", "/");
    return { target: rel, sha256: sha256(target) };
  };

  const files = [];
  if (existsSync(mcpSource)) files.push(stageFile(mcpSource, "mcp/mcp.mjs"));

  if (existsSync(skillsSource)) {
    for (const name of readdirSync(skillsSource, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const skill = path.join(skillsSource, name.name, "SKILL.md");
      if (existsSync(skill)) files.push(stageFile(skill, `skills/${name.name}/SKILL.md`));
    }
  }

  const engine = engineCandidates(root)[0];
  if (engine) {
    files.push(stageFile(engine, `bin/${exe}`));
    log(`[stage] 引擎 sidecar：${engine}`);
  } else if (!quiet) {
    warn(`[stage] ⚠ 未找到 ${exe}：安装包内的 MCP 会走 Node fetch 诊断模式。先运行 bun run engine:build 再 stage 即可随包分发。`);
  }

  const manifest = { version: pkg.version, files };
  writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const size = (rel) => `${(statSync(path.join(outDir, rel)).size / 1024).toFixed(1)} KiB`;
  log(`[stage] v${pkg.version} → ${outDir}`);
  for (const file of files) log(`  - ${file.target} (${size(file.target)})`);
  return { manifest, outDir };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.join(defaultRoot, "scripts", "stage-bundle-assets.mjs");
if (invokedDirectly) {
  try {
    stage({ strict: process.argv.includes("--strict") });
  } catch (error) {
    console.error(`[stage] 失败：${error?.stack ?? error}`);
    process.exit(1);
  }
}
