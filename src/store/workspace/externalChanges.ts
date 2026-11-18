/**
 * Bridge between the WebView store and the rest of the app.
 *
 * The implementation needs the store's `set` / `get` and its private persist
 * timer, so it lives inside `createContext()` and registers itself here. UI
 * modules import the three thin wrappers instead of the store, which keeps
 * `slices/*` free of a circular import back into `store/workspace.ts`.
 */
/**
 * Pure decision for one revision check — kept separate so the concurrency
 * rules can be regression-tested without a Tauri/WebView runtime.
 *
 * `writer === "desktop"` means one of our own untracked saves (first-run
 * seeding, project switch, run history): just move the baseline forward.
 * Any other writer is an MCP / CLI write that must reach the UI, unless a
 * local edit is still pending — in that case the user decides.
 */
export type ExternalChangeDecision =
  | "none"
  | "advance-baseline"
  | "reload"
  | "conflict";

export function decideExternalChange(
  disk: { rev: number; writer: string } | null,
  baseline: number | null,
  hasPendingEdits: boolean,
): ExternalChangeDecision {
  if (!disk || baseline === null || disk.rev <= baseline) return "none";
  if (disk.writer === "desktop") return "advance-baseline";
  return hasPendingEdits ? "conflict" : "reload";
}

export interface ExternalChangeApi {
  /** Compare the on-disk workspace_rev with the WebView baseline. */
  check: (reason?: string) => Promise<void>;
  /** Start the background poll (idempotent). */
  start: () => void;
  /** Stop the background poll (idempotent). */
  stop: () => void;
}

let registered: ExternalChangeApi | null = null;

export function registerExternalChangeApi(next: ExternalChangeApi | null): void {
  registered = next;
}

export function checkExternalChanges(reason?: string): Promise<void> {
  return registered?.check(reason) ?? Promise.resolve();
}

export function startExternalChangeWatch(): void {
  registered?.start();
}

export function stopExternalChangeWatch(): void {
  registered?.stop();
}
