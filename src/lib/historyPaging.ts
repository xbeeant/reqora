/**
 * Pure helpers for the infinite-scrolling execution-history list.
 *
 * The Rust store owns the cursor and the encrypted data; this module only
 * decides what the WebView keeps in memory. Keeping it framework-free makes
 * the tricky parts (deduplication across pages, search matching for freshly
 * appended runs) directly unit-testable.
 */
import type {
  HistoryCursor,
  HistoryRunPage,
  HistoryRunSummary,
} from "../types.ts";

/** Matches the default page size in `src-tauri/src/service/history.rs`. */
export const HISTORY_PAGE_SIZE = 30;
/** Aligns with the Rust retention ceiling (MAX_RUNS). */
export const HISTORY_MAX_ROWS = 500;

/** List rows are ordered newest first; the cursor always moves to older rows. */
export function mergeHistoryPage(
  current: HistoryRunSummary[],
  page: HistoryRunPage,
): { items: HistoryRunSummary[]; cursor: HistoryCursor | null; hasMore: boolean } {
  const seen = new Set(current.map((run) => run.id));
  // Also dedupe within the incoming page: a retried request or an overlapping
  // cursor must never produce two React keys for the same run id.
  const added = page.items.filter((run) => {
    if (seen.has(run.id)) return false;
    seen.add(run.id);
    return true;
  });
  return {
    items: [...current, ...added].slice(0, HISTORY_MAX_ROWS),
    cursor: page.nextCursor ?? null,
    hasMore: page.nextCursor !== null,
  };
}

/**
 * A run that finishes while the history view is open is inserted locally
 * instead of reloading the whole list. It must respect the same search term
 * that was pushed down to Rust, otherwise it would appear as a false hit.
 */
export function matchesHistorySearch(
  run: HistoryRunSummary,
  needle: string,
): boolean {
  const query = needle.trim().toLowerCase();
  if (!query) return true;
  return [
    run.name,
    run.subjectName,
    run.projectName,
    run.method,
    run.url,
    run.error,
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}
