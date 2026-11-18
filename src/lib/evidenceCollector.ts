/**
 * T1.2 — subscriber for `ScenarioRunner`'s existing `onStep` hook.
 *
 * No orchestration semantics are changed: the desktop store, CLI and MCP
 * server keep passing their own `onStep`, and can chain this collector after
 * it. The collector only accumulates results and, at `finish()`, hands them
 * to the one `buildEvidence()` implementation so all three surfaces emit the
 * identical `reqora.run.v1` document.
 */
import { buildEvidence } from "./runEvidence.ts";
import type {
  EvidenceEngine,
  EvidenceSourceStep,
  RunEvidence,
  SubjectKind,
} from "./runEvidence.ts";
import type { ScenarioStepResult } from "../types.ts";

export interface CollectorOptions {
  runId: string;
  startedAt: string;
  engine: EvidenceEngine;
  subject: { kind: SubjectKind; id: string; name: string };
  envName: string;
  envVariableNames?: string[];
  baseline?: RunEvidence | null;
  history?: RunEvidence[];
  /** Injectable for deterministic tests. */
  now?: () => number;
}

export interface EvidenceCollector {
  onStep: (result: ScenarioStepResult | EvidenceSourceStep) => void;
  /** Optional: attach timing metadata that never appears in a step result. */
  note: (patch: { method?: string; url?: string; responseSchema?: object | null }) => void;
  finish: () => RunEvidence;
  readonly size: number;
}

export function createEvidenceCollector(options: CollectorOptions): EvidenceCollector {
  const rows: EvidenceSourceStep[] = [];
  const started = options.now?.() ?? Date.now();
  let pending: { method?: string; url?: string; responseSchema?: object | null } = {};

  return {
    onStep(result) {
      const row: EvidenceSourceStep = { ...(result as EvidenceSourceStep) };
      if (pending.method && !row.method) row.method = pending.method;
      if (pending.url && !row.url) row.url = pending.url;
      if (pending.responseSchema && !row.response_schema) {
        row.response_schema = pending.responseSchema as EvidenceSourceStep["response_schema"];
      }
      rows.push(row);
      pending = {};
    },
    note(patch) {
      pending = { ...pending, ...patch };
    },
    finish() {
      return buildEvidence({
        runId: options.runId,
        startedAt: options.startedAt,
        engine: options.engine,
        subject: options.subject,
        envName: options.envName,
        envVariableNames: options.envVariableNames ?? [],
        steps: rows,
        baseline: options.baseline ?? null,
        history: options.history ?? [],
        totalMs: (options.now?.() ?? Date.now()) - started,
      });
    },
    get size() {
      return rows.length;
    },
  };
}

/**
 * Compose with an existing UI callback without changing runner semantics:
 * `onStep: chainOnStep(uiCallback, collector)`.
 */
export function chainOnStep(
  existing: ((result: ScenarioStepResult) => void) | undefined,
  collector: EvidenceCollector,
): (result: ScenarioStepResult) => void {
  return (result) => {
    existing?.(result);
    collector.onStep(result);
  };
}
