/**
 * `reqora.run.v1` — portable, redacted-by-construction run evidence.
 *
 * Design contract (docs/RUN_EVIDENCE_SCHEMA.md):
 *   - local first: no account, no backend, no network needed to read a file
 *   - stable bytes: fixed field order, arrays sorted by id, volatile timing
 *     data lives outside the diff zone (diffableEvidence)
 *   - fail-closed: only an allow-list of structural fields is ever emitted.
 *     No response body, no cookie, no header value, no environment value.
 *     Free text (error / name / note / url) goes through the repo's redaction
 *    出口 plus an additional unknown-shape scrubber at this boundary.
 *   - single source of truth: evidence files on disk; `run_history` is a
 *     derived index, never a second copy of the results.
 *
 * This module is pure: no Node builtins, no fs, no clock. It is imported by
 * the desktop bundle, the CLI wrapper and the MCP server alike.
 */

import { redactFreeText } from "./redact.ts";
import {
  generateFromSchema,
  schemaFromExample,
  validateJsonSchema,
} from "./jsonschema.ts";
import type { JsonSchemaValue } from "./jsonschema.ts";
import type { ResponseTimings } from "../types.ts";

export const EVIDENCE_SCHEMA_ID = "reqora.run.v1";

export type FailureClass = "none" | "assertion" | "exception" | "network";
export type SubjectKind = "case" | "scenario" | "suite";

/** Four-segment timing. `unattributed_ms` absorbs the rest when the engine
 * only reports a total (Node fetch fallback). */
export interface EvidenceTimings {
  dns_ms: number;
  connect_ms: number;
  wait_ms: number;
  transfer_ms: number;
  total_ms: number;
  unattributed_ms: number;
}

export interface EvidenceAssertion {
  id: string;
  name: string;
  source: string;
  ok: boolean;
  message: string | null;
}

export interface EvidenceStep {
  /** Original execution order; kept because `steps` is sorted by id for diff. */
  sequence: number;
  id: string;
  name: string;
  ok: boolean;
  skipped: boolean;
  skip_reason: string | null;
  status: number | null;
  method: string | null;
  url: string | null;
  assertions: EvidenceAssertion[];
  extracted: string[];
  timings: EvidenceTimings;
  /** Structure of the JSON response (types only, never values). */
  response_schema: JsonSchemaValue | null;
  /** Deterministic digest of `response_schema`, not of the body. */
  response_shape_digest: string | null;
  failure_class: FailureClass;
  error: string | null;
}

export interface EvidenceSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  assertions_total: number;
  assertions_failed: number;
  failure_classes: { assertion: number; exception: number; network: number };
  ok: boolean;
}

export interface EvidenceDiffEntry {
  key: string;
  step_id: string;
  step_name: string;
  detail: string;
}

export type ContractDriftKind =
  | "field_removed"
  | "type_changed"
  | "required_added"
  | "field_added";

export interface ContractDriftItem {
  step_id: string;
  kind: ContractDriftKind;
  path: string;
  detail: string;
}

export interface BaselineDiff {
  added_failures: EvidenceDiffEntry[];
  fixed: EvidenceDiffEntry[];
  /** Informational: never adds a gate failure on its own. */
  flaky: string[];
  contract_drift: ContractDriftItem[];
}

export interface EvidenceEngine {
  transport: "sidecar" | "node-fetch" | "unknown";
  declared_by: "explicit" | "environment" | "unspecified";
  note: string;
}

export interface RunEvidence {
  schema: typeof EVIDENCE_SCHEMA_ID;
  run_id: string;
  started_at: string;
  engine: EvidenceEngine;
  subject: { kind: SubjectKind; id: string; name: string };
  env: { name: string; variables: string[] };
  steps: EvidenceStep[];
  summary: EvidenceSummary;
  baseline_diff: BaselineDiff | null;
  /** Volatile, outside the diff zone. */
  telemetry: { total_ms: number };
}

/** Loose structural input: works with ScenarioStepResult, CLI report rows and
 * bare fixtures. Nothing here is trusted to be a secret-free string. */
export interface EvidenceSourceStep {
  stepId?: string;
  id?: string;
  name?: string;
  ok?: boolean;
  skipped?: boolean;
  skipReason?: string;
  note?: string;
  status?: number | null;
  method?: string;
  url?: string;
  timeMs?: number;
  failed?: number;
  error?: string | null;
  extracted?: Record<string, unknown>;
  body?: string;
  /** Pre-computed structure; when absent we derive one from `body`. */
  response_schema?: JsonSchemaValue | null;
  timings?: ResponseTimings | EvidenceTimings | null;
  assertions?: unknown[];
  tests?: unknown[];
}

export interface BuildEvidenceInput {
  runId: string;
  startedAt: string;
  engine: EvidenceEngine;
  subject: { kind: SubjectKind; id: string; name: string };
  envName: string;
  envVariableNames?: string[];
  steps: EvidenceSourceStep[];
  baseline?: RunEvidence | null;
  /** Prior runs for flaky attribution, oldest first. */
  history?: RunEvidence[];
  totalMs?: number;
}

// ------------------------------------------------------------- redaction ----

const LONG_TOKEN = /[A-Za-z0-9+/=_-]{28,}/g;
const ASSIGNMENT = /([\w.-]*(?:token|secret|password|passwd|credential|api[-_]?key|auth|cookie)[\w.-]*\s*[:=]\s*)(\S+)/gi;
const PLACEHOLDER = /\{\{[^}]{1,64}\}\}/g;

/**
 * Free-text fail-closed scrubber. `redactFreeText()` is the repo-wide出口
 * (known credential shapes); everything it does not recognise is still
 * reduced to a conservative form here, so a new credential shape can never
 * leak into an evidence file. `{{token}}`-style placeholders survive.
 */
export function safeFreeText(input: unknown, limit = 512): string | null {
  if (input === null || input === undefined) return null;
  let text = String(input);
  // Keep template placeholders intact before any masking.
  const placeholders: string[] = [];
  text = text.replace(PLACEHOLDER, (match) => {
    placeholders.push(match);
    return `\u0000P${placeholders.length - 1}\u0000`;
  });
  text = redactFreeText(text);
  text = text.replace(ASSIGNMENT, (_all, prefix: string) => `${prefix}[REDACTED]`);
  // Unknown shapes are masked too: fail-closed, not "only known patterns".
  text = text.replace(LONG_TOKEN, "[REDACTED]");
  // Drop query strings: tokens in URLs are the most common accidental leak.
  text = text.replace(/\bhttps?:\/\/[^\s"']+/gi, (url) => safeUrl(url) ?? "[REDACTED]");
  text = text.replace(/\u0000P(\d+)\u0000/g, (_all, index: string) => placeholders[Number(index)] ?? "{{var}}");
  text = text.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  if (text.length > limit) text = `${text.slice(0, limit)}…[truncated]`;
  return text || null;
}

/** Origin + pathname only; userinfo, query and hash never enter evidence. */
export function safeUrl(input: unknown): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return "[invalid-url]";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "[non-http-url]";
  const segments = parsed.pathname
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) =>
      part.length <= 64 && /^[A-Za-z0-9._~%$&()+,;=:@-]+$/.test(part) ? part : "[REDACTED]",
    );
  return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}/${segments.join("/")}`;
}

/** Only identifier-shaped names are kept; values are never accepted. */
function safeNames(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const names = values
    .filter((item): item is string => typeof item === "string")
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(name))
    .map((name) => name);
  return [...new Set(names)].sort();
}

const NETWORK_ERROR = /(econn|enotfound|eai_again|etimedout|timeout|socket|network|fetch failed|dns|tls|certificate|connection refused|aborted)/i;

// --------------------------------------------------------- step mapping ----

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sourceAssertions(row: EvidenceSourceStep, stepId: string, skipped: boolean): EvidenceAssertion[] {
  const raw = [...(row.assertions ?? []), ...(row.tests ?? [])];
  const mapped = raw.map((item, index): EvidenceAssertion => {
    const record = asRecord(item);
    const ok = record.ok === true;
    const name = safeFreeText(record.name ?? record.title ?? `断言 ${index + 1}`, 160) ?? `断言 ${index + 1}`;
    return {
      id: typeof record.id === "string" && record.id ? record.id : `${stepId}:assertion-${index + 1}`,
      name,
      source: typeof record.source === "string" ? record.source : "unknown",
      ok,
      message: ok ? null : safeFreeText(record.message ?? record.error ?? null, 256),
    };
  });
  // When the caller only reports aggregate pass/fail counts, synthesise one
  // assertion so every step still has a per-assertion result (字段完整率 100%).
  if (mapped.length === 0 && !skipped && (row.ok === false || (row.failed ?? 0) > 0)) {
    mapped.push({
      id: `${stepId}:aggregate`,
      name: "步骤结果",
      source: "aggregate",
      ok: false,
      message: safeFreeText(row.error ?? "步骤未通过", 256),
    });
  }
  return mapped.sort((a, b) => a.id.localeCompare(b.id));
}

function sourceTimings(row: EvidenceSourceStep, totalMs: number): EvidenceTimings {
  const raw = row.timings;
  if (raw && typeof raw === "object") {
    // Both ResponseTimings (Rust) and EvidenceTimings (already normalised).
    const record = raw as unknown as Record<string, number>;
    const num = (key: string): number =>
      typeof record[key] === "number" && Number.isFinite(record[key]) ? Math.round(record[key] * 1000) / 1000 : 0;
    if ("dnsMs" in record || "tcpMs" in record || "serverMs" in record) {
      const dns = num("dnsMs");
      const connect = num("tcpMs") + num("tlsMs");
      const wait = num("serverMs");
      const transfer = num("transferMs");
      const total = num("totalMs") || totalMs;
      return {
        dns_ms: dns,
        connect_ms: connect,
        wait_ms: wait,
        transfer_ms: transfer,
        total_ms: total,
        unattributed_ms: Math.max(0, total - dns - connect - wait - transfer),
      };
    }
  }
  return {
    dns_ms: 0,
    connect_ms: 0,
    wait_ms: 0,
    transfer_ms: 0,
    total_ms: totalMs,
    unattributed_ms: totalMs,
  };
}

/** Structure only: types and field names, never response values. */
function sourceResponseSchema(row: EvidenceSourceStep): JsonSchemaValue | null {
  if (row.response_schema && typeof row.response_schema === "object") {
    return row.response_schema;
  }
  if (typeof row.body !== "string" || !row.body.trim()) return null;
  try {
    return schemaFromExample(JSON.parse(row.body));
  } catch {
    return null;
  }
}

/** FNV-1a over the canonical shape JSON: stable, non-cryptographic, no deps. */
export function shapeDigest(schema: JsonSchemaValue): string {
  const text = JSON.stringify(canonicalJson(schema));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}

function failureClassOf(row: EvidenceSourceStep, status: number | null): FailureClass {
  if (row.ok !== false) return "none";
  const error = typeof row.error === "string" ? row.error : "";
  if (NETWORK_ERROR.test(error) || status === null) return NETWORK_ERROR.test(error) ? "network" : "exception";
  return "assertion";
}

export function toEvidenceStep(row: EvidenceSourceStep, sequence: number): EvidenceStep {
  const id = row.stepId ?? row.id ?? `step-${String(sequence).padStart(3, "0")}`;
  const status = typeof row.status === "number" ? row.status : null;
  const totalMs = typeof row.timeMs === "number" && Number.isFinite(row.timeMs) ? row.timeMs : 0;
  const skipped = row.skipped === true;
  const schema = sourceResponseSchema(row);
  return {
    sequence,
    id,
    name: safeFreeText(row.name ?? id, 200) ?? id,
    ok: row.ok !== false,
    skipped,
    skip_reason: skipped ? safeFreeText(row.skipReason ?? row.note ?? "未记录跳过原因", 256) : null,
    status,
    method: typeof row.method === "string" ? row.method.slice(0, 16).toUpperCase() : null,
    url: safeUrl(row.url),
    assertions: sourceAssertions(row, id, skipped),
    extracted: safeNames(Object.keys(row.extracted ?? {})),
    timings: sourceTimings(row, totalMs),
    response_schema: schema,
    response_shape_digest: schema ? shapeDigest(schema) : null,
    failure_class: skipped ? "none" : failureClassOf(row, status),
    error: safeFreeText(row.error ?? null, 512),
  };
}

// ------------------------------------------------------------ stable JSON ----

/** Recursively rebuild objects with sorted keys; arrays keep their order
 * (callers sort by id before calling). */
export function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) result[key] = canonicalJson(child);
    }
    return result;
  }
  return value;
}

/** Explicit field order — never rely on the caller's insertion order. */
function canonicalEvidence(evidence: RunEvidence): Record<string, unknown> {
  const steps = evidence.steps
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((step) => ({
      sequence: step.sequence,
      id: step.id,
      name: step.name,
      ok: step.ok,
      skipped: step.skipped,
      skip_reason: step.skip_reason,
      status: step.status,
      method: step.method,
      url: step.url,
      assertions: step.assertions
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id)),
      extracted: step.extracted.slice().sort(),
      timings: step.timings,
      response_schema: step.response_schema ? canonicalJson(step.response_schema) : null,
      response_shape_digest: step.response_shape_digest,
      failure_class: step.failure_class,
      error: step.error,
    }));
  return {
    schema: evidence.schema,
    run_id: evidence.run_id,
    started_at: evidence.started_at,
    engine: {
      transport: evidence.engine.transport,
      declared_by: evidence.engine.declared_by,
      note: evidence.engine.note,
    },
    subject: {
      kind: evidence.subject.kind,
      id: evidence.subject.id,
      name: evidence.subject.name,
    },
    env: { name: evidence.env.name, variables: evidence.env.variables.slice().sort() },
    steps,
    summary: evidence.summary,
    baseline_diff: evidence.baseline_diff ? canonicalJson(evidence.baseline_diff) : null,
    telemetry: { total_ms: evidence.telemetry.total_ms },
  };
}

export function serializeEvidence(evidence: RunEvidence, pretty = true): string {
  return `${JSON.stringify(canonicalEvidence(evidence), null, pretty ? 2 : 0)}\n`;
}

/**
 * The diff zone: run identity and every volatile timing are removed, so two
 * runs of the same input produce byte-identical output even when the network
 * took a different amount of time.
 */
export function diffableEvidence(evidence: RunEvidence): Record<string, unknown> {
  const canonical = canonicalEvidence(evidence) as Record<string, unknown>;
  delete canonical.run_id;
  delete canonical.started_at;
  delete canonical.telemetry;
  delete canonical.baseline_diff;
  const steps = canonical.steps as Record<string, unknown>[];
  canonical.steps = steps.map((step) => {
    const copy = { ...step };
    delete copy.timings;
    return copy;
  });
  return canonicalJson(canonical) as Record<string, unknown>;
}

export function diffableBytes(evidence: RunEvidence): string {
  return `${JSON.stringify(diffableEvidence(evidence))}\n`;
}

// ------------------------------------------------------------------ diff ----

function failureKeys(evidence: RunEvidence): Map<string, { step_id: string; step_name: string; detail: string }> {
  const map = new Map<string, { step_id: string; step_name: string; detail: string }>();
  for (const step of evidence.steps) {
    if (step.skipped) continue;
    const failedAssertions = step.assertions.filter((item) => !item.ok);
    for (const assertion of failedAssertions) {
      map.set(`${step.id}:${assertion.id}`, {
        step_id: step.id,
        step_name: step.name,
        detail: `断言「${assertion.name}」失败${assertion.message ? `：${assertion.message}` : ""}`,
      });
    }
    if (!step.ok) {
      // Always keep a step-level key: assertion ids may change between runs,
      // but flaky attribution must still see the step flip pass/fail.
      map.set(step.id, {
        step_id: step.id,
        step_name: step.name,
        detail: `步骤失败（${step.failure_class}）${step.error ? `：${step.error}` : ""}`,
      });
    }
  }
  return map;
}

/**
 * Contract drift reuses the workspace JSON Schema subset engine: a value is
 * regenerated from the current shape and validated against the baseline
 * shape, then new-required fields are found by direct schema comparison.
 */
export function detectContractDrift(
  currentSchema: JsonSchemaValue | null,
  baselineSchema: JsonSchemaValue | null,
): Omit<ContractDriftItem, "step_id">[] {
  if (!currentSchema || !baselineSchema) return [];
  const items: Omit<ContractDriftItem, "step_id">[] = [];
  const sample = generateFromSchema(currentSchema);
  const findings = validateJsonSchema(sample, baselineSchema);
  for (const finding of findings) {
    if (finding.level !== "error") continue;
    const kind: ContractDriftKind = /缺少必填字段/.test(finding.message)
      ? "field_removed"
      : /期望类型/.test(finding.message)
        ? "type_changed"
        : "type_changed";
    items.push({
      kind,
      path: finding.path || "(root)",
      detail: finding.message,
    });
  }
  const requiredOf = (schema: JsonSchemaValue): string[] =>
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [];
  const baseRequired = new Set(requiredOf(baselineSchema));
  for (const name of requiredOf(currentSchema)) {
    if (!baseRequired.has(name)) {
      items.push({
        kind: "required_added",
        path: name,
        detail: `响应新增必填字段 ${name}`,
      });
    }
  }
  const baseProps = asRecord(baselineSchema.properties);
  for (const name of Object.keys(asRecord(currentSchema.properties))) {
    if (!(name in baseProps)) {
      items.push({ kind: "field_added", path: name, detail: `响应新增字段 ${name}` });
    }
  }
  const seen = new Set<string>();
  return items
    .filter((item) => {
      const key = `${item.kind}:${item.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => `${a.kind}:${a.path}`.localeCompare(`${b.kind}:${b.path}`));
}

/** A key is flaky when it both passed and failed inside the recent window. */
export function detectFlaky(history: RunEvidence[], window = 5): string[] {
  const recent = history.slice(-Math.max(2, window));
  if (recent.length < 2) return [];
  const states = new Map<string, Set<string>>();
  for (const run of recent) {
    const failing = new Set(failureKeys(run).keys());
    const keys = new Set<string>();
    for (const step of run.steps) {
      if (step.skipped) continue;
      keys.add(step.id);
      for (const assertion of step.assertions) keys.add(`${step.id}:${assertion.id}`);
    }
    for (const key of keys) {
      const set = states.get(key) ?? new Set<string>();
      set.add(failing.has(key) ? "fail" : "pass");
      states.set(key, set);
    }
  }
  return [...states.entries()]
    .filter(([, set]) => set.has("pass") && set.has("fail"))
    .map(([key]) => key)
    .sort();
}

export function diffEvidence(
  current: RunEvidence,
  baseline: RunEvidence | null,
  history: RunEvidence[] = [],
): BaselineDiff {
  const currentFailures = failureKeys(current);
  const baselineFailures = baseline ? failureKeys(baseline) : new Map<string, { step_id: string; step_name: string; detail: string }>();
  const toEntry = (key: string, meta: { step_id: string; step_name: string; detail: string }): EvidenceDiffEntry => ({
    key,
    step_id: meta.step_id,
    step_name: meta.step_name,
    detail: meta.detail,
  });
  const added_failures = [...currentFailures.entries()]
    .filter(([key]) => !baselineFailures.has(key))
    .map(([key, meta]) => toEntry(key, meta))
    .sort((a, b) => a.key.localeCompare(b.key));
  const fixed = [...baselineFailures.entries()]
    .filter(([key]) => !currentFailures.has(key))
    .map(([key, meta]) => toEntry(key, meta))
    .sort((a, b) => a.key.localeCompare(b.key));

  const drift: ContractDriftItem[] = [];
  if (baseline) {
    const baselineById = new Map(baseline.steps.map((step) => [step.id, step]));
    for (const step of current.steps) {
      const previous = baselineById.get(step.id);
      if (!previous) continue;
      for (const item of detectContractDrift(step.response_schema, previous.response_schema)) {
        drift.push({ step_id: step.id, ...item });
      }
    }
  }
  return {
    added_failures,
    fixed,
    flaky: detectFlaky([...history, current]),
    contract_drift: drift.sort((a, b) =>
      `${a.step_id}:${a.kind}:${a.path}`.localeCompare(`${b.step_id}:${b.kind}:${b.path}`),
    ),
  };
}

// ---------------------------------------------------------------- builder ----

export function buildEvidence(input: BuildEvidenceInput): RunEvidence {
  const steps = input.steps.map((row, index) => toEvidenceStep(row, index + 1));
  const failed = steps.filter((step) => !step.skipped && !step.ok);
  const skipped = steps.filter((step) => step.skipped);
  const assertions = steps.flatMap((step) => step.assertions);
  const failure_classes = { assertion: 0, exception: 0, network: 0 };
  for (const step of failed) {
    if (step.failure_class === "network") failure_classes.network += 1;
    else if (step.failure_class === "exception") failure_classes.exception += 1;
    else failure_classes.assertion += 1;
  }
  const totalMs =
    typeof input.totalMs === "number" && Number.isFinite(input.totalMs)
      ? input.totalMs
      : steps.reduce((sum, step) => sum + step.timings.total_ms, 0);

  const evidence: RunEvidence = {
    schema: EVIDENCE_SCHEMA_ID,
    run_id: input.runId,
    started_at: input.startedAt,
    engine: input.engine,
    subject: input.subject,
    env: { name: input.envName, variables: safeNames(input.envVariableNames ?? []) },
    steps: steps.sort((a, b) => a.id.localeCompare(b.id)),
    summary: {
      total: steps.length,
      passed: steps.length - failed.length - skipped.length,
      failed: failed.length,
      skipped: skipped.length,
      assertions_total: assertions.length,
      assertions_failed: assertions.filter((item) => !item.ok).length,
      failure_classes,
      ok: failed.length === 0,
    },
    baseline_diff: null,
    telemetry: { total_ms: totalMs },
  };
  evidence.baseline_diff = diffEvidence(evidence, input.baseline ?? null, input.history ?? []);
  return evidence;
}

// --------------------------------------------------------------- reading ----

export interface EvidenceValidation {
  ok: boolean;
  errors: string[];
}

/** Structural validation for files produced outside this process. */
export function validateEvidence(value: unknown): EvidenceValidation {
  const errors: string[] = [];
  const record = asRecord(value);
  if (record.schema !== EVIDENCE_SCHEMA_ID) errors.push(`schema 不是 ${EVIDENCE_SCHEMA_ID}`);
  for (const key of ["run_id", "started_at", "engine", "subject", "env", "steps", "summary"]) {
    if (!(key in record)) errors.push(`缺少字段 ${key}`);
  }
  if (!Array.isArray(record.steps)) errors.push("steps 必须是数组");
  if (errors.length === 0) {
    const steps = record.steps as unknown[];
    for (const [index, step] of steps.entries()) {
      const row = asRecord(step);
      for (const key of ["id", "ok", "skipped", "assertions", "extracted", "timings", "failure_class"]) {
        if (!(key in row)) errors.push(`steps[${index}] 缺少字段 ${key}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Agent-facing failure attribution for the `explain_failure` MCP tool. */
export function explainFailure(evidence: RunEvidence): {
  ok: boolean;
  message: string;
  failing_steps: Record<string, unknown>[];
  skipped_steps: string[];
  added_failures: EvidenceDiffEntry[];
  contract_drift: ContractDriftItem[];
} {
  const failing = evidence.steps
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .filter((step) => !step.skipped && !step.ok);
  const rows = failing.map((step) => ({
    sequence: step.sequence,
    step_id: step.id,
    name: step.name,
    failure_class: step.failure_class,
    status: step.status,
    url: step.url,
    failed_assertions: step.assertions.filter((item) => !item.ok).map((item) => item.name),
    error: step.error,
  }));
  const lines = rows.map((row) => {
    const assertions = (row.failed_assertions as string[]).join("、") || "无逐条断言";
    return `第 ${row.sequence} 步「${row.name}」失败（${row.failure_class}）：${assertions}${row.error ? `；${row.error}` : ""}`;
  });
  const drift = evidence.baseline_diff?.contract_drift ?? [];
  for (const item of drift) {
    lines.push(`契约漂移 ${item.kind} @ ${item.step_id}.${item.path}：${item.detail}`);
  }
  return {
    ok: failing.length === 0,
    message:
      failing.length === 0
        ? `本次运行通过：${evidence.summary.passed} 步通过、${evidence.summary.skipped} 步跳过（跳过不计入通过）。`
        : lines.join("\n"),
    failing_steps: rows,
    skipped_steps: evidence.steps.filter((step) => step.skipped).map((step) => `${step.sequence}:${step.id}`),
    added_failures: evidence.baseline_diff?.added_failures ?? [],
    contract_drift: drift,
  };
}
