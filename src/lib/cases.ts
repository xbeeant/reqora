import type { ApiCase, CaseGroup, CaseRunResult, RequestDraft } from "../types";
import { CASE_GROUPS } from "../types.ts";
import { normalizeRequest } from "./defaults.ts";
import { uid } from "./id.ts";

/**
 * Cases are the Apifox-style "单接口用例": one interface, many named
 * scenarios. Each case keeps an editable snapshot of the interface request;
 * `syncedAt` vs `request.contentUpdatedAt` drives the "接口已变更" hint and the
 * explicit "从接口同步" action (Apifox's manual-sync model, made visible).
 * Renames / moves / doc edits only touch `updatedAt`, so they never mark a
 * case stale.
 */

export function newCaseFromRequest(request: RequestDraft, name = "新用例", group: CaseGroup = "正向"): ApiCase {
  const now = Date.now();
  return {
    id: uid(),
    requestId: request.id,
    name,
    group,
    description: "",
    enabled: true,
    request: normalizeRequest({
      ...request,
      id: uid(),
      // The case keeps scenario data, not the interface's documentation.
      doc: undefined,
      name: request.name,
      // Case staleness is judged against syncedAt; the copy has no timestamp of its own.
      updatedAt: 0,
    }),
    syncedAt: request.contentUpdatedAt ?? request.updatedAt ?? now,
    createdAt: now,
    updatedAt: now,
  };
}

/** Re-copy the request part from the interface, keeping case identity/metadata. */
export function syncCaseFromRequest(caseItem: ApiCase, request: RequestDraft): ApiCase {
  const now = Date.now();
  return {
    ...caseItem,
    request: normalizeRequest({
      ...request,
      id: caseItem.request.id,
      doc: undefined,
      updatedAt: 0,
    }),
    syncedAt: request.contentUpdatedAt ?? request.updatedAt ?? now,
    updatedAt: now,
  };
}

export function isCaseStale(caseItem: ApiCase, request: RequestDraft | undefined): boolean {
  if (!request) return false;
  const updatedAt = request.contentUpdatedAt ?? request.updatedAt ?? 0;
  return updatedAt > 0 && updatedAt > (caseItem.syncedAt || 0);
}

export function countByGroup(cases: ApiCase[]): Record<CaseGroup, number> {
  const counts = Object.fromEntries(CASE_GROUPS.map((group) => [group, 0])) as Record<CaseGroup, number>;
  for (const item of cases) counts[item.group] += 1;
  return counts;
}

export function sortCases(cases: ApiCase[]): ApiCase[] {
  const order = new Map(CASE_GROUPS.map((group, index) => [group, index]));
  return [...cases].sort(
    (left, right) =>
      (order.get(left.group) ?? 99) - (order.get(right.group) ?? 99) ||
      left.createdAt - right.createdAt,
  );
}

/** Result of one case run, derived from the shared response/outcome slots. */
export function summarizeRun(
  response: { status: number; timeMs: number; ok: boolean } | null,
  outcome: { tests: { ok: boolean }[]; error: string | null; preError: string | null } | null,
  expectedStatus: number | undefined,
  error?: string,
): CaseRunResult {
  const passed = outcome?.tests.filter((test) => test.ok).length ?? 0;
  const failed = (outcome?.tests.length ?? 0) - passed;
  const statusOk = response ? (expectedStatus === undefined ? response.ok : response.status === expectedStatus) : false;
  return {
    at: Date.now(),
    status: response?.status ?? null,
    ok: statusOk && failed === 0 && !outcome?.error && !outcome?.preError && !error,
    timeMs: response?.timeMs ?? 0,
    passed,
    failed,
    error: error ?? outcome?.error ?? outcome?.preError ?? undefined,
  };
}

/** 每个用例保留的执行历史上限（最新在前，封顶截断）。 */
const CASE_RUN_HISTORY_CAP = 50;

/** 追加一条执行记录到用例历史：最新在前，超过上限截断尾部。 */
export function pushCaseRun(
  history: CaseRunResult[] | undefined,
  summary: CaseRunResult,
): CaseRunResult[] {
  return [summary, ...(history ?? [])].slice(0, CASE_RUN_HISTORY_CAP);
}
