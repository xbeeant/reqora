/**
 * User-facing runtime badge for the window status bar and the sidebar footer.
 *
 * This is a product surface, so it shows the public brand (Reqora) rather than
 * an implementation detail. The Rust side keeps its machine-readable `status`
 * on the IPC boundary; only the display label is translated here. Internal
 * identifiers (package names, bundle id, REQORA_* env vars, localStorage
 * keys) deliberately stay `reqora`.
 */

interface RuntimeBadge {
  version: string;
  status: string;
}

const STATUS_LABELS: Record<string, string> = {
  ready: "已就绪",
};

export const RUNTIME_CONNECTING = "运行时连接中…";

/** Unknown statuses pass through verbatim — never claim "已就绪" blindly. */
export function runtimeStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/** Single source of truth for the two status-bar copies. */
export function runtimeLabel(runtime: RuntimeBadge | null | undefined): string {
  if (!runtime) return RUNTIME_CONNECTING;
  return `Reqora ${runtime.version} · ${runtimeStatusLabel(runtime.status)}`;
}
