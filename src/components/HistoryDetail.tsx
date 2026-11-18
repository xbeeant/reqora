/**
 * Detail pane for the unified execution history (rendered in the main area
 * when the "History" view is active).
 *
 * Everything shown here was decrypted in Rust from the local AES-256-GCM
 * history database. It is never added to the workspace snapshot, so it cannot
 * reach cloud sync, the git mirror or an export.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Copy,
  Database,
  FileText,
  ListChecks,
  Lock,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import { useT } from "../i18n";
import { useWorkspace } from "../store/workspace";
import type {
  BenchmarkHistorySnapshot,
  HistoryRunKind,
  HistoryRunRecord,
  RequestDraft,
  ResponseData,
  ScriptOutcome,
} from "../types";
import { Badge, Button, EmptyState, Spinner } from "./ui";

type DetailTab = "response" | "request" | "tests" | "steps" | "raw" | "benchmark";

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function kindLabel(kind: HistoryRunKind, t: (key: string) => string): string {
  if (kind === "api") return t("shell.history.kindApi");
  if (kind === "case") return t("shell.history.kindCase");
  if (kind === "benchmark") return t("shell.history.kindBenchmark");
  return t("shell.history.kindScenario");
}

function Verdict({ ok, t }: { ok: boolean; t: (key: string) => string }) {
  return (
    <Badge tone={ok ? "success" : "danger"}>
      {ok ? t("shell.history.okBadge") : t("shell.history.failBadge")}
    </Badge>
  );
}

function KeyRows({ rows }: { rows: Array<{ key: string; value: string }> }) {
  if (rows.length === 0) return <div className="text-[11px] text-ink-faint">—</div>;
  return (
    <div className="wb-history-grid">
      {rows.map((row, index) => (
        <div key={`${row.key}-${index}`} className="wb-history-kv">
          <span className="font-mono text-[11px] text-brand-600">{row.key}</span>
          <span className="break-all font-mono text-[11px] text-ink">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

function CopyButton({ value, t }: { value: string; t: (key: string, vars?: Record<string, string | number>) => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <Copy className="h-3 w-3" />
      {copied ? t("shell.history.copied") : t("shell.history.copy")}
    </Button>
  );
}

function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 mt-4 flex items-center gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{children}</h3>
      <div className="ml-auto">{action}</div>
    </div>
  );
}

function ResponseBlock({
  response,
  t,
  showRaw = false,
}: {
  response: ResponseData | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
  showRaw?: boolean;
}) {
  if (!response) {
    return <div className="text-[11px] text-ink-faint">{t("shell.history.noResponse")}</div>;
  }
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-soft">
        <span className="font-mono font-bold text-ink">{response.status} {response.statusText}</span>
        <span>{t("shell.history.time")} · {response.timeMs} ms</span>
        <span>{t("shell.history.size")} · {formatBytes(response.size)}</span>
        {response.contentEncoding && <span>{response.contentEncoding}</span>}
      </div>
      <SectionTitle>{t("shell.history.headers")}</SectionTitle>
      <KeyRows rows={response.headers.map((header) => ({ key: header.name, value: header.value }))} />
      <SectionTitle action={<CopyButton value={response.body} t={t} />}>{t("shell.history.body")}</SectionTitle>
      <pre className="wb-history-code">{response.body || "(empty)"}</pre>
      {(response.truncated || detailTruncated(response)) && (
        <div className="mt-1 text-[10px] text-amber-600">{t("shell.history.truncatedNote")}</div>
      )}
      {response.timings && (
        <>
          <SectionTitle>{t("shell.history.timings")}</SectionTitle>
          <div className="flex flex-wrap gap-3 text-[11px] text-ink-soft">
            <span>DNS {response.timings.dnsMs} ms</span>
            <span>TCP {response.timings.tcpMs} ms</span>
            <span>TLS {response.timings.tlsMs} ms</span>
            <span>Server {response.timings.serverMs} ms</span>
            <span>Transfer {response.timings.transferMs} ms</span>
            <span>{response.timings.protocol}</span>
          </div>
        </>
      )}
      {showRaw && (
        <>
          <SectionTitle>{t("shell.history.rawRequest")}</SectionTitle>
          <pre className="wb-history-code">{response.rawRequest ?? "—"}</pre>
          <SectionTitle>{t("shell.history.rawResponse")}</SectionTitle>
          <pre className="wb-history-code">{response.rawResponse ?? "—"}</pre>
        </>
      )}
    </div>
  );
}

function detailTruncated(response: ResponseData): boolean {
  // Spilled bodies only carry an inline preview; the full bytes lived in the
  // short-lived response-body spool, not in the history database.
  return Boolean(response.bodyRef && response.inlineBytes !== undefined && response.inlineBytes < response.size);
}

function RequestBlock({ request, t }: { request: RequestDraft | null; t: (key: string) => string }) {
  if (!request) return <div className="text-[11px] text-ink-faint">—</div>;
  return (
    <div>
      <div className="flex items-center gap-2 text-[11px]">
        <span className="rounded bg-brand-50 px-1.5 py-0.5 font-mono text-[10px] font-bold text-brand-600">{request.method}</span>
        <span className="break-all font-mono text-ink">{request.url}</span>
      </div>
      <SectionTitle>{t("shell.history.requestHeaders")}</SectionTitle>
      <KeyRows rows={request.headers.filter((row) => row.enabled).map((row) => ({ key: row.key, value: row.value }))} />
      <SectionTitle>{t("shell.history.query")}</SectionTitle>
      <KeyRows rows={request.query.filter((row) => row.enabled).map((row) => ({ key: row.key, value: row.value }))} />
      <SectionTitle>{t("shell.history.requestBody")}</SectionTitle>
      <pre className="wb-history-code">{JSON.stringify(request.body, null, 2) ?? "—"}</pre>
      <SectionTitle>{t("shell.history.auth")}</SectionTitle>
      <pre className="wb-history-code">{JSON.stringify(request.auth, null, 2) ?? "—"}</pre>
      {request.preScript && (
        <>
          <SectionTitle>Pre-script</SectionTitle>
          <pre className="wb-history-code">{request.preScript}</pre>
        </>
      )}
      {request.postScript && (
        <>
          <SectionTitle>Post-script</SectionTitle>
          <pre className="wb-history-code">{request.postScript}</pre>
        </>
      )}
    </div>
  );
}

function OutcomeBlock({ outcome, t }: { outcome: ScriptOutcome | null; t: (key: string) => string }) {
  if (!outcome) return <div className="text-[11px] text-ink-faint">{t("shell.history.noTests")}</div>;
  const tests = outcome.tests ?? [];
  const assertions = outcome.assertions ?? [];
  const logs = outcome.logs ?? [];
  return (
    <div>
      <SectionTitle>{t("shell.history.tests")}</SectionTitle>
      {tests.length === 0 ? (
        <div className="text-[11px] text-ink-faint">—</div>
      ) : (
        tests.map((item, index) => (
          <div key={index} className="flex items-start gap-2 py-1 text-[11px]">
            {item.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <XCircle className="h-3.5 w-3.5 text-red-500" />}
            <span className="text-ink">{item.name || item.message}</span>
            {item.message && item.name && <span className="text-ink-faint">{item.message}</span>}
          </div>
        ))
      )}
      <SectionTitle>{t("shell.history.assertions")}</SectionTitle>
      {assertions.length === 0 ? (
        <div className="text-[11px] text-ink-faint">—</div>
      ) : (
        assertions.map((item, index) => (
          <div key={index} className="flex items-start gap-2 py-1 text-[11px]">
            {item.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <XCircle className="h-3.5 w-3.5 text-red-500" />}
            <span className="text-ink">{item.name || item.path}</span>
            <span className="text-ink-faint">{item.message}</span>
          </div>
        ))
      )}
      <SectionTitle>{t("shell.history.logs")}</SectionTitle>
      {logs.length === 0 ? (
        <div className="text-[11px] text-ink-faint">—</div>
      ) : (
        <pre className="wb-history-code">{logs.join("\n")}</pre>
      )}
      {(outcome.error || outcome.preError) && (
        <div className="mt-3 rounded border border-red-300/60 p-2 text-[11px] text-red-600">
          {outcome.preError} {outcome.error}
        </div>
      )}
    </div>
  );
}

export function HistoryDetail() {
  const t = useT();
  const runs = useWorkspace((state) => state.historyRuns);
  const detail = useWorkspace((state) => state.historyDetail);
  const selectedId = useWorkspace((state) => state.historySelectedId);
  const loading = useWorkspace((state) => state.historyLoading);
  const error = useWorkspace((state) => state.historyError);
  const stats = useWorkspace((state) => state.historyStats);
  const selectHistoryRun = useWorkspace((state) => state.selectHistoryRun);
  const deleteHistoryRun = useWorkspace((state) => state.deleteHistoryRun);
  const refreshHistory = useWorkspace((state) => state.refreshHistory);
  const [tab, setTab] = useState<DetailTab>("response");

  // Opening the History view selects the newest run automatically.
  useEffect(() => {
    if (!selectedId && runs.length > 0) void selectHistoryRun(runs[0].id);
  }, [selectedId, runs, selectHistoryRun]);

  useEffect(() => {
    setTab(detail?.kind === "benchmark" ? "benchmark" : "response");
  }, [selectedId, detail?.kind]);

  // A load run has no single response to inspect: show aggregate metrics and
  // the request snapshot instead of five empty tabs.
  const isBenchmark = detail?.kind === "benchmark";
  const tabs: Array<{ id: DetailTab; label: string; icon: ReactNode }> = isBenchmark
    ? [
        { id: "benchmark", label: t("shell.history.kindBenchmark"), icon: <Clock className="h-3 w-3" /> },
        { id: "request", label: t("shell.history.tabRequest"), icon: <Database className="h-3 w-3" /> },
      ]
    : [
        { id: "response", label: t("shell.history.tabResponse"), icon: <FileText className="h-3 w-3" /> },
        { id: "request", label: t("shell.history.tabRequest"), icon: <Database className="h-3 w-3" /> },
        { id: "tests", label: t("shell.history.tabTests"), icon: <ListChecks className="h-3 w-3" /> },
        { id: "steps", label: t("shell.history.tabSteps"), icon: <Clock className="h-3 w-3" /> },
        { id: "raw", label: t("shell.history.tabRaw"), icon: <FileText className="h-3 w-3" /> },
      ];

  return (
    <div className="wb-history-detail">
      <div className="wb-history-head">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-ink">{t("shell.history.title")}</h2>
            <Badge tone="neutral"><Lock className="mr-1 inline h-3 w-3" />{t("shell.history.encrypted")}</Badge>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-ink-faint">{t("shell.history.subtitle")}</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => void refreshHistory()}>
          <RefreshCw className="h-3 w-3" /> {t("shell.history.refresh")}
        </Button>
        {selectedId && (
          <Button size="sm" variant="danger" onClick={() => void deleteHistoryRun(selectedId)}>
            <Trash2 className="h-3 w-3" /> {t("shell.history.delete")}
          </Button>
        )}
      </div>

      {error && (
        <div className="wb-banner wb-banner-danger">
          <AlertCircle className="h-3.5 w-3.5" />
          <span className="flex-1">{t("shell.history.error", { error })}</span>
        </div>
      )}

      {stats?.keyMismatch && (
        <div className="wb-banner border border-amber-300/70 text-amber-700">
          <AlertCircle className="h-3.5 w-3.5" />
          <span>{t("shell.history.keyMismatch")}</span>
        </div>
      )}

      {!detail ? (
        <div className="flex flex-1 items-center justify-center">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-ink-faint">
              <Spinner className="h-4 w-4" /> {t("shell.history.loading")}
            </div>
          ) : (
            <EmptyState
              icon={<Clock className="h-7 w-7" />}
              title={t("shell.history.emptyTitle")}
              description={runs.length > 0 ? t("shell.history.selectHint") : t("shell.history.emptyDesc")}
            />
          )}
        </div>
      ) : (
        <>
          <div className="wb-history-summary">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">{kindLabel(detail.kind, t)}</Badge>
              <Verdict ok={detail.ok} t={t} />
              <span className="truncate text-xs font-semibold text-ink">{detail.name || detail.subjectName}</span>
              <span className="text-[11px] text-ink-faint">{new Date(detail.at).toLocaleString("zh-CN")}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-ink-soft">
              <span>{t("shell.history.status")} · {detail.status ?? "ERR"}</span>
              <span>{t("shell.history.time")} · {detail.timeMs} ms</span>
              {!isBenchmark && <span>{t("shell.history.size")} · {formatBytes(detail.size)}</span>}
              <span>{t("shell.history.passed")} · {detail.passed}</span>
              <span>{t("shell.history.failed")} · {detail.failed}</span>
              {!isBenchmark && <span>{t("shell.history.skipped")} · {detail.skipped}</span>}
              {isBenchmark && detail.benchmark?.report && (
                <span>
                  {t("tools.bench.throughput")} · {detail.benchmark.report.rps.toFixed(1)} req/s · P95 {Math.round(detail.benchmark.report.latency.p95Ms)} ms
                </span>
              )}
              {detail.method && <span className="font-mono">{detail.method}</span>}
            </div>
            {detail.url && <div className="mt-1 truncate font-mono text-[11px] text-ink-faint">{detail.url}</div>}
            {detail.error && <div className="mt-1 text-[11px] text-red-600">{detail.error}</div>}
            {detail.projectName && (
              <div className="mt-1 text-[10px] text-ink-faint">
                {t("shell.history.projectTag", { name: detail.projectName })}
              </div>
            )}
            {(detail.truncated?.length ?? 0) > 0 && (
              <details className="mt-2 text-[10px] text-amber-600">
                <summary>{t("shell.history.truncated")}</summary>
                <ul className="ml-4 mt-1 list-disc">
                  {detail.truncated.map((line) => <li key={line}>{line}</li>)}
                </ul>
              </details>
            )}
          </div>

          <div className="wb-history-tabs">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`wb-history-tab ${tab === item.id ? "active" : ""}`}
                onClick={() => setTab(item.id)}
              >
                {item.icon}
                {item.label}
                {item.id === "steps" && (detail.steps?.length ?? 0) > 0 && ` (${detail.steps?.length ?? 0})`}
              </button>
            ))}
          </div>

          <div className="wb-history-body scrollbar-thin">
            {tab === "response" && <ResponseBlock response={detail.response} t={t} />}
            {tab === "request" && <RequestBlock request={detail.request} t={t} />}
            {tab === "tests" && <OutcomeBlock outcome={detail.outcome} t={t} />}
            {tab === "raw" && <ResponseBlock response={detail.response} t={t} showRaw />}
            {tab === "steps" && (
              <StepBlock record={detail} t={t} />
            )}
            {tab === "benchmark" && (
              <BenchmarkBlock snapshot={detail.benchmark} error={detail.error} t={t} />
            )}
          </div>
        </>
      )}

      <div className="wb-history-foot">
        <Lock className="h-3 w-3" />
        <span>{t("shell.history.localOnly")}</span>
        {stats && (
          <span className="ml-auto truncate font-mono" title={t("shell.history.dbPath", { path: stats.path })}>
            {t("shell.history.stats", {
              runs: stats.runs,
              steps: stats.steps,
              size: formatBytes(stats.bytes),
            })}
          </span>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="wb-history-metric">
      <div className="wb-history-metric-label">{label}</div>
      <div className="wb-history-metric-value">{value}</div>
    </div>
  );
}

/**
 * The load engine aggregates in Rust and drops every individual response, so
 * this pane renders the statistics it did keep rather than a fake response.
 */
function BenchmarkBlock({
  snapshot,
  error,
  t,
}: {
  snapshot?: BenchmarkHistorySnapshot | null;
  error: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const report = snapshot?.report ?? null;
  const successRate = report && report.total > 0
    ? `${((report.success / report.total) * 100).toFixed(1)}%`
    : "—";
  return (
    <div>
      <SectionTitle>{t("shell.history.benchParams")}</SectionTitle>
      <div className="wb-history-metrics">
        <Metric label={t("shell.history.benchRequests")} value={String(snapshot?.total ?? report?.total ?? 0)} />
        <Metric label={t("shell.history.benchConcurrency")} value={String(snapshot?.concurrency ?? 0)} />
        <Metric label={t("tools.bench.throughput")} value={report ? `${report.rps.toFixed(1)} req/s` : "—"} />
        <Metric label={t("shell.history.time")} value={report ? `${report.timeMs} ms` : "—"} />
        <Metric label={t("tools.bench.successStat")} value={String(report?.success ?? 0)} />
        <Metric label={t("tools.bench.failedStat")} value={String(report?.failed ?? 0)} />
        <Metric label={t("shell.history.benchSuccessRate")} value={successRate} />
      </div>

      {!report ? (
        <div className="mt-3 text-[11px] text-red-600">{error || t("shell.history.benchNoReport")}</div>
      ) : (
        <>
          <SectionTitle>{t("shell.history.benchLatency")}</SectionTitle>
          <div className="wb-history-metrics">
            <Metric label={t("tools.bench.min")} value={`${report.latency.minMs} ms`} />
            <Metric label={t("tools.bench.avg")} value={`${report.latency.avgMs} ms`} />
            <Metric label="P50" value={`${report.latency.p50Ms} ms`} />
            <Metric label="P90" value={`${report.latency.p90Ms} ms`} />
            <Metric label="P95" value={`${report.latency.p95Ms} ms`} />
            <Metric label="P99" value={`${report.latency.p99Ms} ms`} />
            <Metric label={t("tools.bench.max")} value={`${report.latency.maxMs} ms`} />
          </div>

          <SectionTitle>{t("tools.bench.statusDist")}</SectionTitle>
          <KeyRows
            rows={Object.entries(report.statuses).map(([code, count]) => ({
              key: code === "0" ? "ERR" : code,
              value: String(count),
            }))}
          />

          <SectionTitle>{t("tools.bench.errorSamples")}</SectionTitle>
          {report.errors.length === 0 ? (
            <div className="text-[11px] text-ink-faint">—</div>
          ) : (
            <pre className="wb-history-code">{report.errors.join("\n")}</pre>
          )}
          {report.errorCount > report.errors.length && (
            <div className="mt-1 text-[10px] text-ink-faint">
              {t("shell.history.benchMoreErrors", { count: report.errorCount - report.errors.length })}
            </div>
          )}
        </>
      )}
      <p className="mt-4 text-[10px] leading-4 text-ink-faint">{t("shell.history.benchNoDetail")}</p>
    </div>
  );
}

function StepBlock({
  record,
  t,
}: {
  record: HistoryRunRecord;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const steps = record.steps ?? [];
  if (steps.length === 0) {
    return <div className="text-[11px] text-ink-faint">{t("shell.history.noSteps")}</div>;
  }
  return (
    <div className="space-y-2">
      {steps.map((step) => (
        <details key={step.seq} className="wb-history-step" open={!step.ok || step.seq === 0}>
          <summary className="flex items-center gap-2 text-[11px]">
            {step.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <XCircle className="h-3.5 w-3.5 text-red-500" />}
            <span className="font-semibold text-ink">{t("shell.history.step", { index: step.seq + 1 })} · {step.name}</span>
            {step.skipped && <Badge tone="neutral">{t("shell.history.skippedBadge")}</Badge>}
            <span className="ml-auto font-mono text-ink-faint">
              {step.status ?? "ERR"} · {step.timeMs} ms · {step.passed}/{step.passed + step.failed}
            </span>
          </summary>
          <div className="mt-2 pl-4">
            {step.note && <div className="mb-1 text-[10px] text-ink-faint">{step.note}</div>}
            {step.error && <div className="mb-1 text-[11px] text-red-600">{step.error}</div>}
            {step.iterations && step.iterations.length > 1 && (
              <div className="mb-2 text-[10px] text-ink-faint">
                {t("shell.history.iterations", { count: step.iterations.length })}
              </div>
            )}
            <ResponseBlock response={step.response} t={t} />
            {step.iterations?.map((iteration, index) => (
              <details key={index} className="mt-2">
                <summary className="cursor-pointer text-[10px] text-ink-faint">
                  #{index + 1} {iteration.response ? `${iteration.response.status} · ${iteration.response.timeMs} ms` : "ERR"}
                </summary>
                <div className="mt-1"><ResponseBlock response={iteration.response} t={t} /></div>
              </details>
            ))}
            <SectionTitle>{t("shell.history.assertions")}</SectionTitle>
            <OutcomeBlock outcome={step.outcome} t={t} />
          </div>
        </details>
      ))}
    </div>
  );
}
