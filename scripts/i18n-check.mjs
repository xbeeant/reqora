#!/usr/bin/env node
/**
 * i18n coverage audit for the renderer source tree.
 *
 *   node scripts/i18n-check.mjs            # report
 *   node scripts/i18n-check.mjs --verbose  # report + every offending line
 *   node scripts/i18n-check.mjs --strict   # exit 1 on missing keys
 *
 * It verifies:
 *  - every `t("ns.key")` / key-valued UI literal exists in both zh and en;
 *  - zh and en dictionaries stay symmetric;
 *  - no hard-coded CJK UI strings remain outside the dictionaries.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");
const NS_DIR = path.join(SRC, "i18n", "ns");
const CJK = /[\u4e00-\u9fff]/;
const verbose = process.argv.includes("--verbose");
const strict = process.argv.includes("--strict");
// String literals that merely look like i18n keys (protocol event names, etc.).
const KEY_LITERAL_ALLOWLIST = new Set(["response.output_text.delta"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Read keys of `export const zh = {...}` / `export const en = {...}`. */
function dictKeys(source, lang) {
  const start = new RegExp(
    "export\\s+const\\s+" + lang + "\\s*(?::\\s*[^=]+?)?=\\s*\\{",
  ).exec(source);
  if (!start) return new Set();
  let depth = 0;
  let quote = null;
  let escaped = false;
  let body = "";
  for (let i = start.index + start[0].length - 1; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      body += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      body += ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
    body += ch;
  }
  const keys = new Set();
  for (const match of body.matchAll(/^\s*["']([^"']+)["']\s*:/gm)) keys.add(match[1]);
  return keys;
}

/** Strip line/block comments so doc comments do not count as UI text. */
function stripComments(source) {
  let out = "";
  let quote = null;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

const nsFiles = fs.readdirSync(NS_DIR).filter((f) => f.endsWith(".ts"));
// The registry uses static imports; a new ns file must be added there too.
const registrySource = fs.readFileSync(path.join(SRC, "i18n", "locales", "index.ts"), "utf8");
const registered = new Set(
  [...registrySource.matchAll(/from\s+["']\.\.\/ns\/([^"'/]+)\.ts["']/g)].map((m) => m[1]),
);
const unregistered = nsFiles
  .map((f) => f.replace(/\.ts$/, ""))
  .filter((name) => !registered.has(name));
const dict = { zh: new Set(), en: new Set() };
for (const file of nsFiles) {
  const source = fs.readFileSync(path.join(NS_DIR, file), "utf8");
  for (const key of dictKeys(source, "zh")) dict.zh.add(key);
  for (const key of dictKeys(source, "en")) dict.en.add(key);
}
const namespaces = new Set([...dict.zh, ...dict.en].map((k) => k.split(".")[0]));

const used = new Map();
function note(key, file) {
  if (!used.has(key)) used.set(key, new Set());
  used.get(key).add(path.relative(ROOT, file));
}
const cjkHits = [];
const sources = walk(SRC).filter((f) => !f.startsWith(path.join(SRC, "i18n") + path.sep));
for (const file of sources) {
  const raw = fs.readFileSync(file, "utf8");
  const clean = stripComments(raw);
  for (const match of clean.matchAll(/\bt\(\s*["']([^"']+)["']/g)) note(match[1], file);
  // label/hint/aria constants that hold a key instead of calling t() inline.
  for (const match of clean.matchAll(/["']([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)["']/g)) {
    if (KEY_LITERAL_ALLOWLIST.has(match[1])) continue;
    if (namespaces.has(match[1].split(".")[0])) note(match[1], file);
  }
  clean.split(/\r?\n/).forEach((line, index) => {
    // Search keywords and doc comments are data, not renderable UI text.
    if (/^\s*keywords\s*:/.test(line)) return;
    const literal = /(["'`])[^"'`]*[\u4e00-\u9fff][^"'`]*\1/.test(line);
    const jsxText = />\s*[^<{}]*[\u4e00-\u9fff][^<{}]*</.test(line);
    if (literal || jsxText) {
      cjkHits.push({ file: path.relative(ROOT, file), line: index + 1, text: line.trim().slice(0, 140) });
    }
  });
}

const missing = {
  zh: [...used.keys()].filter((k) => !dict.zh.has(k)),
  en: [...used.keys()].filter((k) => !dict.en.has(k)),
};
const asymmetric = {
  zhOnly: [...dict.zh].filter((k) => !dict.en.has(k)),
  enOnly: [...dict.en].filter((k) => !dict.zh.has(k)),
};
const unused = [...dict.zh].filter((k) => !used.has(k));

console.log(`dictionaries: ${nsFiles.length} namespaces, zh=${dict.zh.size} en=${dict.en.size}`);
console.log(`namespace registry: ${registered.size}/${nsFiles.length} wired`);
for (const name of unregistered) console.log(`  [unregistered] ns/${name}.ts`);
console.log(`referenced keys: ${used.size}   hard-coded CJK lines: ${cjkHits.length}`);
console.log(`missing zh: ${missing.zh.length}   missing en: ${missing.en.length}`);
for (const key of missing.zh) console.log(`  [zh] ${key}  <- ${[...used.get(key)].slice(0, 2).join(", ")}`);
for (const key of missing.en) console.log(`  [en] ${key}  <- ${[...used.get(key)].slice(0, 2).join(", ")}`);
console.log(`zh-only keys: ${asymmetric.zhOnly.length}   en-only keys: ${asymmetric.enOnly.length}`);
if (verbose) for (const key of [...asymmetric.zhOnly, ...asymmetric.enOnly]) console.log(`  [asym] ${key}`);
console.log(`unused keys: ${unused.length}`);
if (verbose) for (const key of unused) console.log(`  [unused] ${key}`);

const byFile = new Map();
for (const hit of cjkHits) {
  if (!byFile.has(hit.file)) byFile.set(hit.file, []);
  byFile.get(hit.file).push(hit);
}
console.log(`\nfiles with hard-coded CJK UI text: ${byFile.size}`);
for (const [file, hits] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(hits.length).padStart(3)}  ${file}`);
  if (verbose) for (const hit of hits) console.log(`        ${hit.line}: ${hit.text}`);
}

if (strict && (
  missing.zh.length || missing.en.length
  || asymmetric.zhOnly.length || asymmetric.enOnly.length
  || unregistered.length
)) {
  process.exitCode = 1;
}
