import type {
  ApiCase,
  RequestDraft,
  ResponseData,
  ScenarioStep,
  ScenarioStepResult,
  ScenarioRunSummary,
  TestScenario,
} from "../types.ts";
import {
  computeRepeatIterations,
  evaluateStepCondition,
  resolveStepOwnerRequestId,
  resolveStepRequest,
  runExtracts,
  summarizeScenario,
} from "./scenario.ts";
import type { RepeatIteration } from "./scenario.ts";

/**
 * Framework-free scenario orchestrator.
 *
 * The desktop app drives scenarios from the Zustand store (`runScenario`), which
 * is welded to UI state. Automation (CLI + MCP server) needs the exact same
 * orchestration rules without React, so this module owns them as a pure
 * function over an injected transport:
 *
 * - `enabled === false` → skipped
 * - `condition` gate → skipped (not a failure, chain continues)
 * - `source.kind === "wait"` → sleep only
 * - `repeat` (count / over) → N iterations, per-iteration variables
 * - extracts of step N are visible to step N+1
 * - `continueOnFailure === false` stops the remaining chain
 *
 * This is the single implementation: the desktop store (`runScenario`) injects
 * `executePipeline` + a database hook, the CLI / MCP server injects a fetch
 * transport. Do not re-implement the rules at a call site.
 */

/** What one step's transport returns; mirrors the app's response+outcome slots. */
export interface StepTransportResult {
  response: ResponseData | null;
  timeMs: number;
  error: string | null;
  preError?: string | null;
  /** `postScript` test() results. */
  tests?: { ok: boolean; name?: string; message?: string }[];
  /** Declarative assertion results (already evaluated). */
  assertions?: { ok: boolean }[];
  aborted?: boolean;
  /** Variable table after scripts / extracts ran (setVar support). */
  activeVariables?: Record<string, string>;
  /** Non-fatal notes (script errors, unsupported body types…). */
  note?: string[];
}

export type StepTransport = (
  request: RequestDraft,
  variables: Record<string, string>,
  ownerRequestId: string | undefined,
) => Promise<StepTransportResult>;

/** A database step outcome, already evaluated (rows compared to expectations). */
export interface DbStepTransportResult {
  status?: number | null;
  ok: boolean;
  timeMs: number;
  passed: number;
  failed: number;
  error?: string;
  extracted?: Record<string, string>;
}

/**
 * Database steps run through drivers that only exist in the desktop app (the
 * Rust bridge). Out-of-process callers simply omit this hook and the step fails
 * loudly instead of being silently skipped.
 */
export type DbStepTransport = (
  step: ScenarioStep,
  variables: Record<string, string>,
) => Promise<DbStepTransportResult>;

export interface RunOptions {
  /** Case table used to resolve `source.kind === "case"` steps. */
  cases: ApiCase[];
  transport: StepTransport;
  /** Desktop-only database executor; absent → db steps fail with a clear error. */
  dbTransport?: DbStepTransport;
  /** Environment variables (already resolved from the chosen environment). */
  baseVariables?: Record<string, string>;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Hard cap on executed steps (safety valve for AI-driven runs). */
  maxSteps?: number;
  /**
   * Where a multi-round dataset pass writes its "第 n/N 轮" label: the desktop
   * UI puts it in `note` (step names stay clean in the run list), reports put it
   * in `name` so each row is identifiable on its own.
   */
  roundLabelTarget?: "name" | "note";
  /**
   * Capture a bounded UTF-8 response body into each step result. Off by
   * default so the desktop run list and its persisted reports stay small;
   * automation callers (CLI / MCP) opt in so agents can read what came back.
   */
  captureBody?: boolean;
  onStep?: (result: ScenarioStepResult) => void;
}

export interface RunResult {
  steps: ScenarioStepResult[];
  /** Final scenario variable table (base + dataset row + extracts). */
  variables: Record<string, string>;
  summary: ScenarioRunSummary;
  /** True when every executed step passed and nothing failed. */
  ok: boolean;
}

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Same ceiling as the MCP `presentRun` report; never embed whole downloads. */
const STEP_BODY_LIMIT = 16_384;

/** Only text bodies are useful to an agent, and they must stay bounded. */
function captureStepBody(response: ResponseData | null): Pick<ScenarioStepResult, "body" | "bodyTruncated"> {
  const body = response?.body;
  if (typeof body !== "string") return {};
  return {
    body: body.slice(0, STEP_BODY_LIMIT),
    bodyTruncated: body.length > STEP_BODY_LIMIT,
  };
}

function emptyResult(step: ScenarioStep): ScenarioStepResult {
  return {
    stepId: step.id,
    name: step.name,
    status: null,
    ok: true,
    skipped: false,
    timeMs: 0,
    passed: 0,
    failed: 0,
    extracted: {},
  };
}

/**
 * Run one step once (no loop control). Returns a per-iteration result plus the
 * variables it extracted so the caller can fold them into the scenario table.
 */
interface IterationOutcome {
  result: ScenarioStepResult;
  /** Variables written by pre/post scripts during this iteration. */
  scriptVariables?: Record<string, string>;
}

async function runIteration(
  step: ScenarioStep,
  iterVars: Record<string, string>,
  options: RunOptions,
): Promise<IterationOutcome> {
  const base = emptyResult(step);

  if (step.source.kind === "wait") {
    const ms = Math.min(Math.max(Math.floor(step.source.ms), 0), 60_000);
    const sleep = options.sleep ?? DEFAULT_SLEEP;
    if (ms > 0) await sleep(ms);
    return { result: { ...base, timeMs: ms, note: `等待 ${ms}ms` } };
  }

  if (step.source.kind === "db") {
    // Database steps need a driver; the desktop app injects one through
    // `dbTransport`. Out of process we have no driver, so fail loudly instead
    // of silently passing.
    if (!options.dbTransport) {
      return {
        result: {
          ...base,
          ok: false,
          failed: 1,
          error: "数据库步骤需要在桌面端执行（MCP / CLI 不支持直连数据库）",
        },
      };
    }
    const db = await options.dbTransport(step, { ...(options.baseVariables ?? {}), ...iterVars });
    return {
      result: {
        ...base,
        status: db.status ?? null,
        ok: db.ok,
        timeMs: db.timeMs,
        passed: db.passed,
        failed: db.failed,
        error: db.error,
        extracted: db.extracted ?? {},
      },
    };
  }

  const request = resolveStepRequest(step, options.cases);
  if (!request) {
    return {
      result: { ...base, ok: false, failed: 1, error: "找不到步骤引用的用例（可能已被删除）" },
    };
  }

  const ownerRequestId = resolveStepOwnerRequestId(step, options.cases);
  const variables = { ...(options.baseVariables ?? {}), ...iterVars };
  const result = await options.transport(request, variables, ownerRequestId);

  const scriptFailed = (result.tests ?? []).filter((item) => !item.ok).length;
  const assertionFailed = (result.assertions ?? []).filter((item) => !item.ok).length;
  const { extracted, error: extractError } = runExtracts(step.extracts ?? [], result.response);

  const error = result.error ?? result.preError ?? extractError ?? undefined;
  const capturedBody = options.captureBody ? captureStepBody(result.response) : {};
  // Evidence chain (reqora.run.v1): keep every assertion result, the four-segment
  // timing and a redactable request shape instead of only passed/failed counts.
  // Purely additive — orchestration semantics are unchanged.
  const assertionRows = [
    ...(result.tests ?? []).map((item, index) => ({
      id: `test-${index + 1}`,
      name: item.name ?? `test ${index + 1}`,
      ok: item.ok,
      source: "script",
      message: item.message,
    })),
    ...(result.assertions ?? []).map((item, index) => ({
      id: `assertion-${index + 1}`,
      ok: item.ok,
      source: "declarative",
    })),
  ];

  return {
    result: {
      ...base,
      status: result.response?.status ?? null,
      ok: !result.aborted && !error && scriptFailed === 0 && assertionFailed === 0,
      timeMs: result.response?.timeMs ?? result.timeMs ?? 0,
      passed:
        (result.tests ?? []).length -
        scriptFailed +
        (result.assertions ?? []).length -
        assertionFailed,
      failed: scriptFailed + assertionFailed + (error ? 1 : 0),
      error,
      extracted,
      ...capturedBody,
      timings: result.response?.timings,
      assertions: assertionRows,
      method: request.method,
      url: request.url,
    },
    scriptVariables: result.activeVariables,
  };
}

/** Fold a transport result into the variable table (scripts may setVar). */
function mergeScriptVariables(
  scenarioVars: Record<string, string>,
  baseVariables: Record<string, string>,
  active: Record<string, string> | undefined,
) {
  if (!active) return;
  for (const [key, value] of Object.entries(active)) {
    if (baseVariables[key] !== value) scenarioVars[key] = value;
  }
}

/**
 * Run a list of steps once. `datasetRow` variables are visible to every step
 * (the app runs one such pass per CSV row).
 */
export async function runSteps(
  steps: ScenarioStep[],
  options: RunOptions,
  datasetRow: Record<string, string> = {},
): Promise<RunResult> {
  const baseVariables = { ...(options.baseVariables ?? {}), ...datasetRow };
  const scenarioVars: Record<string, string> = { ...datasetRow };
  const results: ScenarioStepResult[] = [];
  const startedAt = Date.now();
  let stopChain = false;
  const maxSteps = options.maxSteps ?? Number.POSITIVE_INFINITY;

  for (const step of steps) {
    if (results.length >= maxSteps) {
      results.push({
        ...emptyResult(step),
        ok: false,
        skipped: true,
        skipReason: `已达单次执行上限 ${maxSteps} 步，未执行`,
        note: `已达单次执行上限 ${maxSteps} 步，未执行`,
      });
      // Skipped steps must reach the evidence collector too: a chain with a
      // disabled / gated step otherwise produces an incomplete evidence file.
      options.onStep?.(results[results.length - 1]);
      continue;
    }
    if (!step.enabled) {
      results.push({
        ...emptyResult(step),
        ok: false,
        skipped: true,
        skipReason: "步骤已停用",
        note: "步骤已停用",
      });
      options.onStep?.(results[results.length - 1]);
      continue;
    }
    if (stopChain) break;

    if (step.condition) {
      const check = evaluateStepCondition(step.condition, { ...baseVariables, ...scenarioVars });
      if (!check.met) {
        const conditionNote = `条件未满足：{{${step.condition.varName}}} ${step.condition.op} ${step.condition.value}（实际 ${check.actual ?? "未定义"}），已跳过`;
        results.push({
          ...emptyResult(step),
          skipped: true,
          skipReason: conditionNote,
          note: conditionNote,
        });
        options.onStep?.(results[results.length - 1]);
        continue;
      }
    }

    if (step.source.kind === "wait") {
      const { result } = await runIteration(step, scenarioVars, options);
      results.push(result);
      options.onStep?.(result);
      continue;
    }

    let iterations: RepeatIteration[];
    try {
      iterations = computeRepeatIterations(step.repeat, { ...baseVariables, ...scenarioVars });
    } catch (repeatError) {
      results.push({
        ...emptyResult(step),
        ok: false,
        failed: 1,
        error: (repeatError as Error).message,
      });
      if (!step.continueOnFailure) stopChain = true;
      continue;
    }

    const looping =
      iterations.length > 1 || Boolean(step.repeat && (step.repeat.over || (step.repeat.count ?? 1) > 1));
    const aggregated: ScenarioStepResult = {
      ...emptyResult(step),
      note: looping ? `循环执行 ${iterations.length} 次` : undefined,
      assertions: [],
    };

    for (const iteration of iterations) {
      const outcome = await runIteration(
        step,
        { ...scenarioVars, ...iteration.bindings },
        options,
      );
      const result = outcome.result;
      mergeScriptVariables(scenarioVars, baseVariables, outcome.scriptVariables);
      Object.assign(scenarioVars, result.extracted);
      Object.assign(aggregated.extracted, result.extracted);
      // Fold per-iteration evidence detail into the aggregated row; ids carry
      // the iteration label so repeated steps stay individually attributable.
      if (result.assertions?.length) {
        aggregated.assertions = [
          ...(aggregated.assertions ?? []),
          ...result.assertions.map((item, index) => ({
            ...item,
            id: `${iteration.label ?? `iter-${index}`}:${item.id ?? index}`,
          })),
        ];
      }
      if (result.timings) aggregated.timings = result.timings;
      if (result.method) aggregated.method = result.method;
      if (result.url) aggregated.url = result.url;
      aggregated.timeMs += result.timeMs;
      aggregated.passed += result.passed;
      aggregated.failed += result.failed;
      if (result.status !== null) aggregated.status = result.status;
      // Repeat/loop iterations are folded into one row: keep the last response.
      if (result.body !== undefined) {
        aggregated.body = result.body;
        if (result.bodyTruncated !== undefined) aggregated.bodyTruncated = result.bodyTruncated;
      }
      if (result.error && !aggregated.error) {
        aggregated.error = iteration.label ? `[${iteration.label}] ${result.error}` : result.error;
      }
      if (!result.ok) {
        aggregated.ok = false;
        if (!step.continueOnFailure) {
          stopChain = true;
          break;
        }
      }
    }

    results.push(aggregated);
    options.onStep?.(aggregated);
  }

  const summary = summarizeScenario(results, steps.length, Date.now() - startedAt);
  return {
    steps: results,
    variables: scenarioVars,
    summary,
    ok: summary.failed === 0,
  };
}

/** Run a whole scenario, honouring its CSV dataset (one pass per row). */
export async function runScenario(
  scenario: TestScenario,
  options: RunOptions & { dataRows?: Record<string, string>[] },
): Promise<RunResult & { rounds: RunResult[] }> {
  const rounds = options.dataRows?.length
    ? options.dataRows
    : scenario.dataSet?.rows?.length
      ? scenario.dataSet.rows
      : [{}];

  const startedAt = Date.now();
  const allSteps: ScenarioStepResult[] = [];
  const allVariables: Record<string, string> = { ...(options.baseVariables ?? {}) };
  const roundResults: RunResult[] = [];

  for (const [index, row] of rounds.entries()) {
    const label = rounds.length > 1 ? `第 ${index + 1}/${rounds.length} 轮` : "";
    const round = await runSteps(scenario.steps, options, row);
    roundResults.push(round);
    Object.assign(allVariables, round.variables);
    const toNote = (options.roundLabelTarget ?? "name") === "note";
    for (const step of round.steps) {
      if (!label) {
        allSteps.push(step);
      } else if (toNote) {
        allSteps.push({ ...step, note: step.note ? `${label} · ${step.note}` : label });
      } else {
        allSteps.push({ ...step, name: `${label} · ${step.name}` });
      }
    }
  }

  const summary = summarizeScenario(
    allSteps,
    scenario.steps.length * rounds.length,
    Date.now() - startedAt,
  );
  return { steps: allSteps, variables: allVariables, summary, ok: summary.failed === 0, rounds: roundResults };
}
