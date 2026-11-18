// Node-side I/O for reqora.run.v1 evidence files.
//
// Deliberately separated from src/lib/runEvidence.ts (pure, bundled into the
// WebView) so no Node builtin leaks into the desktop bundle. Every write is
// atomic and throws on failure: T1.3 treats "证据写不出" as a hard gate failure,
// never as a warning.

import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { writeFileAtomic } from "./atomicWrite.mjs";
import { serializeEvidence, validateEvidence } from "../src/lib/runEvidence.ts";

export const DEFAULT_EVIDENCE_DIR = "artifacts";

export function evidenceDirectory(explicit) {
  const raw = explicit ?? process.env.REQORA_EVIDENCE_DIR ?? DEFAULT_EVIDENCE_DIR;
  return resolve(raw);
}

export function readEvidenceFile(file) {
  const target = resolve(file);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    throw new Error(`无法读取证据文件 ${target}：${error.message}`);
  }
  const check = validateEvidence(parsed);
  if (!check.ok) {
    throw new Error(`证据文件 ${target} 不符合 ${"reqora.run.v1"}：${check.errors.join("；")}`);
  }
  return parsed;
}

export function listEvidence(dir) {
  const target = evidenceDirectory(dir);
  let names;
  try {
    names = readdirSync(target);
  } catch (error) {
    // A missing / unreadable history directory must never block a new run:
    // the write boundary is the only thing allowed to fail the gate.
    if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES") return [];
    throw new Error(`无法读取证据目录 ${target}：${error.message}`);
  }
  const out = [];
  for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
    const path = join(target, name);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      const check = validateEvidence(parsed);
      if (check.ok) out.push({ evidence: parsed, path });
    } catch {
      // A partial / unrelated JSON file must not break the whole index.
    }
  }
  return out;
}

/** Atomic write, then verify the bytes are readable and parseable. */
export function writeEvidenceFile(file, evidence) {
  const target = resolve(file);
  const body = serializeEvidence(evidence);
  try {
    // mkdir is inside the try on purpose: an unwritable / blocked parent is a
    // gate failure too, and must surface as "证据写入失败".
    mkdirSync(dirname(target), { recursive: true });
    writeFileAtomic(target, body, { mode: 0o600 });
  } catch (error) {
    throw new Error(`证据写入失败 ${target}：${error.message}`);
  }
  // Post-write verification: a green gate must never rest on an unreadable file.
  const verify = readEvidenceFile(target);
  if (verify.run_id !== evidence.run_id) {
    throw new Error(`证据写入后校验失败 ${target}：run_id 不一致`);
  }
  return target;
}

export function loadBaseline(file) {
  if (!file) return null;
  return readEvidenceFile(file);
}
