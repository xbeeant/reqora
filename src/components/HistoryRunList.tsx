/**
 * Execution history for the interface currently occupying the centre area.
 * Rows open as frozen interface tabs instead of replacing the editor's draft,
 * so an unsaved request is never lost while browsing old runs.
 */
import { useEffect } from "react";
import { Clock, RefreshCw } from "lucide-react";
import { useT } from "../i18n";
import { useWorkspace } from "../store/workspace";
import type { HistoryRunKind } from "../types";
import { Button, EmptyState, Spinner } from "./ui";

function kindLabel(kind: HistoryRunKind, t: (key: string) => string): string {
  if (kind === "case") return t("shell.history.kindCase");
  if (kind === "scenario") return t("shell.history.kindScenario");
  if (kind === "benchmark") return t("shell.history.kindBenchmark");
  return t("shell.history.kindApi");
}

export function HistoryRunList({ subjectId }: { subjectId: string | null }) {
  const t = useT();
  const runs = useWorkspace((state) => state.historyRuns);
  const tabs = useWorkspace((state) => state.tabs);
  const loaded = useWorkspace((state) => state.historyLoaded);
  const loading = useWorkspace((state) => state.historyLoading);
  const error = useWorkspace((state) => state.historyError);
  const loadHistory = useWorkspace((state) => state.loadHistory);
  const refreshHistory = useWorkspace((state) => state.refreshHistory);
  const openHistoryRunTab = useWorkspace((state) => state.openHistoryRunTab);

  // The history database is decrypted on demand; opening this tab is one of
  // those moments, alongside the sidebar History view.
  useEffect(() => {
    if (!loaded) void loadHistory();
  }, [loaded, loadHistory]);

  const visible = subjectId
    ? runs.filter((entry) => entry.subjectId === subjectId)
    : runs;
  const opened = new Set(
    tabs.filter((tab) => tab.kind === "history").map((tab) => tab.id),
  );

  return (
    <div className="wb-run-history">
      <div className="wb-run-history-head">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-ink">{t("request.history.title")}</h3>
          <p className="wb-hint !mt-0">{t("request.history.subtitle")}</p>
        </div>
        <span className="wb-mini-badge">
          {t("request.history.count", { count: visible.length })}
        </span>
        <Button size="sm" variant="secondary" onClick={() => void refreshHistory()}>
          <RefreshCw className="h-3 w-3" />
          {t("shell.history.refresh")}
        </Button>
      </div>

      {error && (
        <div className="wb-banner wb-banner-danger">
          <span className="flex-1">{t("shell.history.error", { error })}</span>
        </div>
      )}

      <div className="wb-run-history-body scrollbar-thin">
        {loading && !loaded ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-ink-faint">
            <Spinner className="h-4 w-4" />
            {t("shell.history.loading")}
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<Clock className="h-7 w-7" />}
            title={t("request.history.empty")}
            description={t("request.history.emptyHint")}
          />
        ) : (
          visible.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`wb-history-row group ${opened.has(entry.id) ? "selected" : ""}`}
              title={t("request.history.openRow")}
              onClick={() => void openHistoryRunTab(entry.id)}
            >
              <div className="flex items-center gap-2">
                <span className={`wb-history-kind kind-${entry.kind}`}>
                  {kindLabel(entry.kind, t)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-ink">
                  {entry.name || entry.subjectName}
                </span>
                {opened.has(entry.id) && (
                  <span className="wb-mini-badge">{t("request.history.opened")}</span>
                )}
                <span
                  className={`font-mono text-[10px] font-bold ${
                    entry.ok && (entry.status === null || entry.status < 400)
                      ? "text-emerald-600"
                      : "text-red-500"
                  }`}
                >
                  {entry.status ?? "ERR"}
                </span>
              </div>
              <div className="mt-1 truncate pl-[50px] font-mono text-[10px] text-ink-faint">
                {entry.method ? `${entry.method} ` : ""}{entry.url || entry.error || "—"}
              </div>
              <div className="mt-0.5 pl-[50px] text-[10px] text-ink-faint">
                {new Date(entry.at).toLocaleString("zh-CN")} · {entry.timeMs} ms
                {entry.kind === "benchmark" &&
                  ` · ${(entry.rps ?? 0).toFixed(1)} req/s · P95 ${Math.round(entry.p95Ms ?? 0)} ms`}
                {entry.failed > 0 && ` · ${entry.failed} ${t("shell.history.failed")}`}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
