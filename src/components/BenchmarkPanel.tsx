import { useState } from "react";
import { AlertTriangle, Gauge, Zap } from "lucide-react";
import { useT } from "../i18n";
import { useWorkspace } from "../store/workspace";
import { Badge, Button, Spinner, inputClass } from "./ui";

const LATENCY_ROWS: { key: "minMs" | "avgMs" | "p50Ms" | "p90Ms" | "p95Ms" | "p99Ms" | "maxMs"; labelKey?: string; label?: string }[] = [
  { key: "minMs", labelKey: "tools.bench.min" },
  { key: "avgMs", labelKey: "tools.bench.avg" },
  { key: "p50Ms", label: "P50" },
  { key: "p90Ms", label: "P90" },
  { key: "p95Ms", label: "P95" },
  { key: "p99Ms", label: "P99" },
  { key: "maxMs", labelKey: "tools.bench.max" },
];

/**
 * Load-test configuration and aggregate report, embedded as a detail tab.
 * The target is always the active draft — which for a read-only history tab
 * is the frozen request snapshot, so snapshots stay sendable.
 */
export function BenchmarkPanel() {
  const t = useT();
  const running = useWorkspace((state) => state.benchmarkRunning);
  const report = useWorkspace((state) => state.benchmarkReport);
  const error = useWorkspace((state) => state.benchmarkError);
  const runBenchmark = useWorkspace((state) => state.runBenchmark);
  const draft = useWorkspace((state) => state.draft);

  const [total, setTotal] = useState("100");
  const [concurrency, setConcurrency] = useState("10");

  const totalNum = Math.min(Math.max(Number(total) || 0, 1), 1000);
  const concurrencyNum = Math.min(Math.max(Number(concurrency) || 0, 1), 64);

  const statusEntries = report ? Object.entries(report.statuses) : [];
  const maxStatusCount = Math.max(1, ...statusEntries.map(([, count]) => count));

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <Gauge className="h-4 w-4" />
          {t("tools.bench.title")}
        </h3>
        <p className="wb-hint !mt-0">{t("tools.bench.desc")}</p>
      </div>

      <div className="flex items-end gap-3">
        <label className="flex-1">
          <span className="wb-label">{t("tools.bench.total")}</span>
          <input
            type="number"
            min={1}
            max={1000}
            className={inputClass}
            value={total}
            disabled={running}
            onChange={(event) => setTotal(event.target.value)}
          />
        </label>
        <label className="flex-1">
          <span className="wb-label">{t("tools.bench.concurrency")}</span>
          <input
            type="number"
            min={1}
            max={64}
            className={inputClass}
            value={concurrency}
            disabled={running}
            onChange={(event) => setConcurrency(event.target.value)}
          />
        </label>
        <Button
          variant="primary"
          disabled={running}
          onClick={() => void runBenchmark(totalNum, concurrencyNum)}
        >
          {running ? <Spinner className="h-3.5 w-3.5" /> : <Zap className="h-3.5 w-3.5" />}
          {running ? t("tools.bench.running") : t("tools.bench.start")}
        </Button>
      </div>
      <p className="wb-hint !mt-0">
        {t("tools.bench.target")}<span className="font-mono">{draft.method}</span>{" "}
        <span className="font-mono">{draft.url || t("tools.bench.noUrl")}</span>
      </p>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}

      {report && (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-2">
            <StatCard label={t("tools.bench.totalStat")} value={String(report.total)} />
            <StatCard label={t("tools.bench.successStat")} value={String(report.success)} tone="ok" />
            <StatCard label={t("tools.bench.failedStat")} value={String(report.failed)} tone={report.failed > 0 ? "bad" : "ok"} />
            <StatCard label={t("tools.bench.throughput")} value={`${report.rps.toFixed(1)} req/s`} />
          </div>

          <div>
            <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-ink">
              <Gauge className="h-3.5 w-3.5" />
              {t("tools.bench.latency", { ms: report.timeMs })}
            </h4>
            <div className="grid grid-cols-7 gap-1.5">
              {LATENCY_ROWS.map((row) => (
                <div key={row.key} className="rounded-md border border-surface-border bg-surface px-1.5 py-1.5 text-center">
                  <div className="text-2xs text-ink-faint">{row.labelKey ? t(row.labelKey) : row.label}</div>
                  <div className="font-mono text-xs text-ink">{report.latency[row.key].toFixed(1)}</div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h4 className="mb-1.5 text-xs font-semibold text-ink">{t("tools.bench.statusDist")}</h4>
            <div className="space-y-1">
              {statusEntries.map(([status, count]) => (
                <div key={status} className="flex items-center gap-2">
                  <Badge tone={status === "0" ? "danger" : Number(status) < 400 ? "success" : "warning"}>
                    {status === "0" ? "ERR" : status}
                  </Badge>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-muted">
                    <div
                      className={`h-full rounded-full ${status === "0" ? "bg-red-500" : Number(status) < 400 ? "bg-emerald-500" : "bg-amber-500"}`}
                      style={{ width: `${(count / maxStatusCount) * 100}%` }}
                    />
                  </div>
                  <span className="w-10 text-right font-mono text-2xs text-ink-soft">{count}</span>
                </div>
              ))}
            </div>
          </div>

          {report.errors.length > 0 && (
            <div>
              <h4 className="mb-1.5 text-xs font-semibold text-ink">{t("tools.bench.errorSamples")}</h4>
              <ul className="space-y-1">
                {report.errors.map((message) => (
                  <li key={message} className="break-all rounded-md bg-surface-muted px-2 py-1 font-mono text-2xs text-ink-soft">
                    {message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "ok" | "bad" }) {
  const color = tone === "ok" ? "text-emerald-600" : tone === "bad" ? "text-red-600" : "text-ink";
  return (
    <div className="rounded-lg border border-surface-border bg-surface px-2 py-2 text-center">
      <div className="text-2xs text-ink-faint">{label}</div>
      <div className={`font-mono text-sm font-semibold ${color}`}>{value}</div>
    </div>
  );
}
