/**
 * Builders for the unified execution-history record (interface / case /
 * scenario / load test). Framework-free by design: the desktop store, the CLI
 * and unit tests all import the same functions.
 *
 * The record leaves this module as **plaintext** and is encrypted as one whole
 * document by Rust before it touches `~/.reqora/history.db`. That is why it is
 * safe to include full response bodies, headers, auth values and script logs
 * here — nothing is uploaded, synced or written into the workspace snapshot.
 *
 * Bodies are bounded so a single run cannot balloon the local database. Every
 * truncation is reported in `record.truncated` and shown in the detail panel.
 */
import type {
  BenchmarkReport,
  CaseRunResult,
  HistoryRunKind,
  HistoryRunRecord,
  HistoryRunStep,
  RequestDraft,
  ResponseData,
  ScenarioRunSummary,
  ScenarioStepResult,
  ScriptOutcome,
} from "../types.ts";

/** Max characters kept in any single string field (e.g. a response body). */
export const HISTORY_BODY_LIMIT = 256 * 1024;
/** Raw wire dumps are noisier than a body; keep a smaller window. */
export const HISTORY_RAW_LIMIT = 64 * 1024;
/** Soft ceiling for one JSON record; above it we re-run with tighter limits. */
export const HISTORY_SOFT_LIMIT = 1_800_000;
/** Cap on any array (script logs, assertions, step lists…). */
export const HISTORY_MAX_ARRAY = 500;
const COMPACT_LIMIT = 32 * 1024;

export interface HistoryContext {
  projectId: string;
  projectName: string;
  /** Injectable for deterministic tests. */
  id?: string;
  at?: number;
}

export interface SingleRunInput {
  context: HistoryContext;
  kind: Extract<HistoryRunKind, "api" | "case">;
  subjectId: string;
  subjectName: string;
  name: string;
  /** Resolved request snapshot shown in history (no `{{...}}` left). */
  request: RequestDraft;
  /** Original template kept for re-sending from a frozen tab. */
  requestTemplate?: RequestDraft | null;
  response: ResponseData | null;
  outcome: ScriptOutcome | null;
  error: string | null;
  startedAt: number;
  /** Case: assertion verdict. Interface: HTTP-level success. */
  ok: boolean;
  summary?: CaseRunResult | null;
}

export interface BenchmarkRunInput {
  context: HistoryContext;
  subjectId: string;
  subjectName: string;
  /** Snapshot of the request that was repeated by the load engine. */
  request: RequestDraft;
  /** Original template kept for re-running from a frozen tab. */
  requestTemplate?: RequestDraft | null;
  /** Planned request count and concurrency, exactly as sent to Rust. */
  total: number;
  concurrency: number;
  /** Aggregate report; null when the IPC call itself failed. */
  report: BenchmarkReport | null;
  error: string | null;
  startedAt: number;
}

export interface ScenarioRunInput {
  context: HistoryContext;
  scenarioId: string;
  scenarioName: string;
  summary: ScenarioRunSummary;
  steps: HistoryRunStep[];
  startedAt: number;
  error?: string | null;
}

/** One HTTP exchange captured inside a scenario step. */
export interface HistoryResponseCapture {
  request: RequestDraft;
  requestTemplate?: RequestDraft | null;
  response: ResponseData | null;
  outcome: ScriptOutcome | null;
  error?: string | null;
  timeMs: number;
}

interface Bounded {
  value: unknown;
  truncated: string[];
}

function limitFor(path: string, aggressive: boolean): number {
  if (aggressive) return COMPACT_LIMIT;
  if (/(^|\.)raw(Request|Response)$/.test(path)) return HISTORY_RAW_LIMIT;
  return HISTORY_BODY_LIMIT;
}

/** Deep-clone a JSON-like value while bounding every string and array. */
function bounded(value: unknown, path: string, aggressive: boolean, depth = 0): Bounded {
  if (depth > 30) return { value: null, truncated: [`${path} (嵌套过深)`] };
  if (typeof value === "string") {
    const limit = limitFor(path, aggressive);
    if (value.length > limit) {
      return { value: value.slice(0, limit), truncated: [`${path} · 截断至 ${limit} 字符`] };
    }
    return { value, truncated: [] };
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, HISTORY_MAX_ARRAY);
    const truncated = value.length > HISTORY_MAX_ARRAY
      ? [`${path} · 仅保留前 ${HISTORY_MAX_ARRAY} 项`]
      : [];
    const out: unknown[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const child = bounded(items[index], `${path}[${index}]`, aggressive, depth + 1);
      out.push(child.value);
      truncated.push(...child.truncated);
    }
    return { value: out, truncated };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const truncated: string[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child === undefined || typeof child === "function") continue;
      const next = bounded(child, path ? `${path}.${key}` : key, aggressive, depth + 1);
      out[key] = next.value;
      truncated.push(...next.truncated);
    }
    return { value: out, truncated };
  }
  return { value: value ?? null, truncated: [] };
}

function seal(record: HistoryRunRecord): HistoryRunRecord {
  let pass = bounded(record, "", false);
  let truncated = pass.truncated;
  if (JSON.stringify(pass.value).length > HISTORY_SOFT_LIMIT) {
    pass = bounded(record, "", true);
    truncated = [...pass.truncated, "记录整体过大，已启用紧凑截断"];
  }
  const out = pass.value as HistoryRunRecord;
  // Rust rejects anything above 2 MiB. If compact truncation is still not
  // enough (a scenario with hundreds of chatty steps), shed whole steps
  // rather than losing the entire run.
  const originalSteps = out.steps.length;
  while (JSON.stringify(out).length > HISTORY_SOFT_LIMIT && out.steps.length > 0) {
    out.steps = out.steps.slice(0, Math.floor(out.steps.length / 2));
  }
  if (out.steps.length < originalSteps) {
    truncated.push(`步骤明细过大，仅保留前 ${out.steps.length} 步`);
  }
  return { ...out, truncated: [...new Set(truncated)] };
}

function runId(context: HistoryContext, at: number): string {
  if (context.id) return context.id;
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `history-${at}-${Math.random().toString(36).slice(2, 12)}`;
}

function outcomeCounts(outcome: ScriptOutcome | null): { passed: number; failed: number } {
  const tests = outcome?.tests ?? [];
  const assertions = outcome?.assertions ?? [];
  const all = [...tests, ...assertions];
  return {
    passed: all.filter((item) => item.ok).length,
    failed: all.filter((item) => !item.ok).length,
  };
}

function base(
  context: HistoryContext,
  kind: HistoryRunKind,
  at: number,
): Pick<
  HistoryRunRecord,
  "id" | "kind" | "at" | "projectId" | "projectName" | "truncated" | "steps"
> {
  return {
    id: runId(context, at),
    kind,
    at,
    projectId: context.projectId || "default",
    projectName: context.projectName || "默认项目",
    truncated: [],
    steps: [],
  };
}

/** Interface direct-send or single-case run: one request, one full response. */
export function buildSingleRunRecord(input: SingleRunInput): HistoryRunRecord {
  const at = input.context.at ?? Date.now();
  const counts = outcomeCounts(input.outcome);
  const summary = input.summary ?? null;
  const response = input.response;
  const record: HistoryRunRecord = {
    ...base(input.context, input.kind, at),
    subjectId: input.subjectId,
    subjectName: input.subjectName,
    name: input.name,
    method: input.request.method,
    url: input.request.url,
    ok: input.ok,
    status: response?.status ?? null,
    timeMs: response?.timeMs ?? Math.max(0, Date.now() - input.startedAt),
    size: response?.size ?? 0,
    total: input.kind === "case" && summary
      ? summary.passed + summary.failed
      : counts.passed + counts.failed,
    passed: input.kind === "case" && summary ? summary.passed : counts.passed,
    failed: input.kind === "case" && summary ? summary.failed : counts.failed,
    skipped: 0,
    error: input.error ?? response?.statusText ?? "",
    request: input.request,
    requestTemplate: input.requestTemplate ?? null,
    response,
    outcome: input.outcome,
    summary,
    steps: [],
    truncated: [],
  };
  return seal(record);
}

/** Scenario run: aggregate counts plus one row per step, each with its own response. */
export function buildScenarioRunRecord(input: ScenarioRunInput): HistoryRunRecord {
  const at = input.context.at ?? Date.now();
  const summary = input.summary;
  // A looped step carries its iterations separately; `step.response` is the
  // first of them, so counting both would double the reported byte size.
  const responses = input.steps.flatMap((step) =>
    step.iterations?.length
      ? step.iterations.map((item) => item.response)
      : [step.response],
  );
  const size = responses.reduce((sum, response) => sum + (response?.size ?? 0), 0);
  const withStatus = [...responses].reverse().find((response) => response?.status != null);
  const record: HistoryRunRecord = {
    ...base(input.context, "scenario", at),
    subjectId: input.scenarioId,
    subjectName: input.scenarioName,
    name: input.scenarioName,
    method: "",
    url: "",
    ok: summary.failed === 0 && !input.error,
    status: withStatus?.status ?? null,
    timeMs: summary.timeMs || Math.max(0, Date.now() - input.startedAt),
    size,
    total: summary.total ?? input.steps.length,
    passed: summary.passed ?? 0,
    failed: summary.failed ?? 0,
    skipped: summary.skipped ?? 0,
    error: input.error ?? "",
    request: null,
    // Scenario runs keep their snapshots on the steps; surface the first
    // template so a frozen scenario tab can still be re-sent safely.
    requestTemplate: input.steps.find((step) => step.requestTemplate)?.requestTemplate ?? null,
    response: null,
    outcome: null,
    summary,
    steps: input.steps,
    truncated: [],
  };
  return seal(record);
}

/**
 * Most frequent non-zero status in a load-test report. A transport failure is
 * counted as status 0, which is deliberately not shown as the run's status.
 */
function dominantStatus(report: BenchmarkReport | null): number | null {
  if (!report) return null;
  const winner = Object.entries(report.statuses ?? {})
    .map(([status, count]) => ({ status: Number(status), count: Number(count) || 0 }))
    .filter((item) => item.status > 0 && item.count > 0)
    .sort((left, right) => right.count - left.count)[0];
  return winner ? winner.status : null;
}

/**
 * Load-test run. The Rust engine deliberately keeps only aggregate statistics
 * (status distribution, latency percentiles, error samples), so there is no
 * single response body to capture. We store the request snapshot, the load
 * parameters and the whole aggregate report instead — all sealed as usual.
 */
export function buildBenchmarkRunRecord(input: BenchmarkRunInput): HistoryRunRecord {
  const at = input.context.at ?? Date.now();
  const report = input.report;
  const label = input.request.name?.trim() || `${input.request.method} ${input.request.url}`;
  const record: HistoryRunRecord = {
    ...base(input.context, "benchmark", at),
    subjectId: input.subjectId,
    subjectName: input.subjectName,
    name: `${label} · ${input.total}×${input.concurrency}`,
    method: input.request.method,
    url: input.request.url,
    ok: Boolean(report && report.total > 0 && report.failed === 0),
    status: dominantStatus(report),
    timeMs: report?.timeMs ?? Math.max(0, Date.now() - input.startedAt),
    // No per-response bytes survive aggregation; do not invent a size.
    size: 0,
    total: report?.total ?? input.total,
    passed: report?.success ?? 0,
    failed: report?.failed ?? (input.error ? input.total : 0),
    skipped: 0,
    error: input.error ?? "",
    request: input.request,
    requestTemplate: input.requestTemplate ?? null,
    response: null,
    outcome: null,
    summary: null,
    benchmark: { total: input.total, concurrency: input.concurrency, report },
    steps: [],
    truncated: [],
  };
  return seal(record);
}

/** Normalise one scenario step (and its captured responses) for storage. */
export function buildHistoryStep(input: {
  seq: number;
  result: ScenarioStepResult;
  captures: HistoryResponseCapture[];
}): HistoryRunStep {
  const { result, captures } = input;
  const first = captures[0] ?? null;
  const iterations = captures.length > 1
    ? captures.map((capture) => ({
        request: capture.request,
        response: capture.response,
        outcome: capture.outcome,
        error: capture.error ?? undefined,
      }))
    : undefined;
  return {
    seq: input.seq,
    name: result.name,
    ok: result.ok,
    skipped: result.skipped,
    status: result.status ?? first?.response?.status ?? null,
    timeMs: result.timeMs,
    passed: result.passed,
    failed: result.failed,
    error: result.error ?? first?.error ?? undefined,
    note: result.note,
    stepResult: result,
    request: first?.request ?? null,
    requestTemplate: first?.requestTemplate ?? null,
    response: first?.response ?? null,
    outcome: first?.outcome ?? null,
    iterations,
  };
}
