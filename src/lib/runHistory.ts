/**
 * T1.5 — `run_history` as a *derived index* over evidence files.
 *
 * The evidence JSON files are the only source of truth. This module turns a
 * list of parsed evidence documents into the index rows the desktop SQLite
 * table stores (same columns, see RUN_HISTORY_DDL in storage.rs): evidence
 * bodies are never copied into the database, so a workspace stays small and
 * can always be rebuilt by re-scanning the evidence directory.
 */
import { detectFlaky } from "./runEvidence.ts";
import type { RunEvidence } from "./runEvidence.ts";

export interface RunHistoryEntry {
  run_id: string;
  subject_kind: string;
  subject_id: string;
  subject_name: string;
  started_at: number;
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Relative or absolute path to the evidence JSON; never the body. */
  evidence_path: string;
}

export interface TrendPoint {
  run_id: string;
  started_at: number;
  pass_rate: number;
  total: number;
}

export interface FailureFrequency {
  step_id: string;
  count: number;
  runs: number;
}

export function historyEntryFromEvidence(evidence: RunEvidence, evidencePath: string): RunHistoryEntry {
  const parsed = Date.parse(evidence.started_at);
  return {
    run_id: evidence.run_id,
    subject_kind: evidence.subject.kind,
    subject_id: evidence.subject.id,
    subject_name: evidence.subject.name,
    started_at: Number.isFinite(parsed) ? parsed : 0,
    ok: evidence.summary.ok,
    total: evidence.summary.total,
    passed: evidence.summary.passed,
    failed: evidence.summary.failed,
    skipped: evidence.summary.skipped,
    evidence_path: evidencePath,
  };
}

export function buildHistory(evidences: { evidence: RunEvidence; path: string }[]): RunHistoryEntry[] {
  return evidences
    .map((item) => historyEntryFromEvidence(item.evidence, item.path))
    .sort((a, b) => a.started_at - b.started_at || a.run_id.localeCompare(b.run_id));
}

export function queryHistory(
  history: RunHistoryEntry[],
  filter: { subjectId?: string; subjectKind?: string; limit?: number } = {},
): RunHistoryEntry[] {
  const matched = history.filter((row) => {
    if (filter.subjectId && row.subject_id !== filter.subjectId) return false;
    if (filter.subjectKind && row.subject_kind !== filter.subjectKind) return false;
    return true;
  });
  const limit = filter.limit ?? 20;
  return matched.slice(-Math.max(1, limit)).reverse();
}

export function passRateTrend(history: RunHistoryEntry[]): TrendPoint[] {
  return history.map((row) => ({
    run_id: row.run_id,
    started_at: row.started_at,
    total: row.total,
    pass_rate: row.total === 0 ? 0 : Math.round((row.passed / row.total) * 1000) / 10,
  }));
}

export function failureFrequency(evidences: RunEvidence[]): FailureFrequency[] {
  const counts = new Map<string, number>();
  for (const evidence of evidences) {
    const seen = new Set<string>();
    for (const step of evidence.steps) {
      if (step.skipped || step.ok) continue;
      seen.add(step.id);
    }
    for (const id of seen) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([step_id, count]) => ({ step_id, count, runs: evidences.length }))
    .sort((a, b) => b.count - a.count || a.step_id.localeCompare(b.step_id));
}

/** Same window semantics as `baseline_diff.flaky`, exposed for the history UI. */
export function flakyKeys(evidences: RunEvidence[], window = 5): string[] {
  return detectFlaky(evidences, window);
}
