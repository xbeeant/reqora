import { useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Filter,
  Radio,
  Settings2,
  Sparkles,
} from "lucide-react";
import { DEFAULT_MERGE_CONFIG, FORMAT_LABELS } from "../lib/sse";
import { useT } from "../i18n";
import { useWorkspace } from "../store/workspace";
import type { SseMergeMode } from "../types";

type View = "merged" | "timeline" | "raw" | "settings";

const MODES: { value: SseMergeMode; label: string; hint: string }[] = [
  { value: "auto", label: "response.sse.mode.auto.label", hint: "response.sse.mode.auto.hint" },
  { value: "jsonPath", label: "response.sse.mode.jsonPath.label", hint: "response.sse.mode.jsonPath.hint" },
  { value: "rawText", label: "response.sse.mode.rawText.label", hint: "response.sse.mode.rawText.hint" },
  { value: "off", label: "response.sse.mode.off.label", hint: "response.sse.mode.off.hint" },
];

const QUICK_PATHS = [
  "$.choices[0].delta.content",
  "$.choices[0].message.content",
  "$.candidates[0].content.parts[0].text",
  "$.delta.text",
  "$.chunk.text",
  "$.content",
];

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  return `${(size / 1024).toFixed(1)} KB`;
}

/**
 * SSE view modelled on Apifox's "时间线" panel: real-time merged text, an
 * event timeline with per-event intervals, a raw event inspector and custom
 * JSONPath merge rules.
 */
export function SseViewer() {
  const t = useT();
  const [view, setView] = useState<View>("merged");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [showReasoning, setShowReasoning] = useState(true);
  const [copied, setCopied] = useState(false);

  const sse = useWorkspace((state) => state.sse);
  const config =
    useWorkspace((state) => state.snapshot.settings.sseMerge) ?? DEFAULT_MERGE_CONFIG;
  const setMergeConfig = useWorkspace((state) => state.setSseMergeConfig);

  const frames = sse.frames;
  const activeMode = MODES.find((mode) => mode.value === config.mode);
  const needle = filter.trim().toLowerCase();
  const visible = useMemo(
    () =>
      needle
        ? frames.filter((frame) =>
            `${frame.seq} ${frame.event} ${frame.data}`.toLowerCase().includes(needle),
          )
        : frames,
    [frames, needle],
  );

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  if (!sse.active) {
    return (
      <div className="wb-empty">
        <Radio className="h-8 w-8 opacity-50" />
        <p className="wb-empty-title">{t("response.sse.empty.title")}</p>
        <p className="max-w-md text-xs leading-relaxed">
          {t("response.sse.empty.intro")} <code className="font-mono">text/event-stream</code>
          {t("response.sse.empty.mid")}<strong>{t("response.sse.empty.merge")}</strong>
          {t("response.sse.empty.outro")}
        </p>
        <p className="max-w-md font-mono text-[10px] text-ink-faint">
          {t("response.sse.empty.example")}
        </p>
      </div>
    );
  }

  const done = sse.done;
  const statusTone = sse.error
    ? "wb-tone-danger"
    : sse.streaming
      ? "wb-tone-info"
      : done?.cancelled
        ? "wb-tone-warn"
        : "wb-tone-ok";

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="wb-sse-status">
        <span className={`wb-tone ${statusTone}`}>
          {sse.streaming ? (
            <>
              <span className="wb-sse-pulse" /> {t("response.sse.streaming")}
            </>
          ) : sse.error ? (
            t("response.sse.error")
          ) : done?.cancelled ? (
            t("response.sse.stopped")
          ) : (
            t("response.sse.done")
          )}
        </span>
        <span className="wb-tone wb-tone-muted">{FORMAT_LABELS[sse.format]}</span>
        <span>{t("response.sse.events", { count: frames.length })}</span>
        {!!sse.mergedText && <span>{t("response.sse.chars", { count: sse.mergedText.length })}</span>}
        {!!done && (
          <>
            <span>{formatBytes(done.bytes)}</span>
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {done.elapsedMs} ms
            </span>
          </>
        )}
        {done?.truncated && <span className="wb-tone wb-tone-warn">{t("response.sse.truncated")}</span>}
        {sse.meta && (
          <span className="ml-auto font-mono text-[10px] text-ink-faint">
            {sse.meta.status} {sse.meta.statusText} · {sse.meta.contentType.split(";")[0]}
          </span>
        )}
      </div>

      {sse.error && <div className="wb-banner wb-banner-danger">{sse.error}</div>}

      <div className="wb-sse-tabs">
        {(
          [
            ["merged", t(MODES[0].label)],
            ["timeline", `${t("response.sse.tab.timeline")}${frames.length ? ` ${frames.length}` : ""}`],
            ["raw", t("response.sse.tab.raw")],
            ["settings", t("response.sse.tab.settings")],
          ] as [View, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`wb-cfg-tab ${view === key ? "active" : ""} !h-8`}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="wb-resp-body scrollbar-thin !flex !flex-col !bg-surface">
        {view === "merged" && (
          <div className="wb-sse-merged flex-1">
            {!!sse.reasoningText && (
              <div className="wb-sse-reasoning shrink-0">
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 text-left text-[11px] font-semibold"
                  onClick={() => setShowReasoning((current) => !current)}
                >
                  {showReasoning ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                  <Sparkles className="h-3.5 w-3.5" />
                  {t("response.sse.reasoning", { count: sse.reasoningText.length })}
                </button>
                {showReasoning && (
                  <pre className="wb-sse-reasoning-body">{sse.reasoningText}</pre>
                )}
              </div>
            )}

            <div className="flex shrink-0 items-center gap-2 border-b border-surface-border bg-surface-muted px-3 py-1.5">
              <span className="text-[10.5px] font-semibold text-ink-soft">{t("response.sse.mergedTitle")}</span>
              <span className="text-[10px] text-ink-faint">
                {config.mode === "auto" ? t("response.sse.autoHint") : activeMode ? t(activeMode.label) : ""}
              </span>
              <button
                type="button"
                className="wb-chip !ml-auto !h-6 !px-2 !text-[10px]"
                onClick={() => void copy(sse.mergedText)}
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? t("response.common.copied") : t("response.common.copy")}
              </button>
            </div>

            {config.mode === "off" ? (
              <div className="wb-hint m-3 text-center">
                {t("response.sse.offHint")}
              </div>
            ) : sse.mergedText ? (
              <pre className="wb-sse-text">
                {sse.mergedText}
                {sse.streaming && <span className="wb-sse-caret" />}
              </pre>
            ) : (
              <div className="wb-hint m-3 text-center">
                {sse.streaming
                  ? t("response.sse.waiting")
                  : t("response.sse.noText")}
              </div>
            )}
          </div>
        )}

        {view === "timeline" && (
          <div>
            <div className="wb-sse-filter">
              <Filter className="h-3.5 w-3.5 shrink-0" />
              <input
                value={filter}
                placeholder={t("response.sse.filterPlaceholder")}
                aria-label={t("response.sse.filterAria")}
                onChange={(event) => setFilter(event.target.value)}
              />
              <span className="ml-auto shrink-0 text-[10px] text-ink-faint">
                {visible.length} / {frames.length}
              </span>
            </div>
            {visible.length === 0 ? (
              <div className="wb-empty !min-h-[120px]">
                <p className="wb-empty-title">{sse.streaming ? t("response.sse.waitingEvents") : t("response.sse.noMatch")}</p>
              </div>
            ) : (
              visible.map((frame, index) => {
                const previous = index > 0 ? visible[index - 1] : null;
                const delta = previous ? frame.atMs - previous.atMs : frame.atMs;
                const snippet = sse.snippets[frame.seq - 1] ?? "";
                const open = selected === frame.seq;
                return (
                  <div key={frame.seq} className="wb-sse-event">
                    <button
                      type="button"
                      className="wb-sse-event-row"
                      onClick={() => setSelected(open ? null : frame.seq)}
                    >
                      <span className="wb-sse-arrow">↓</span>
                      <span className="wb-mini-badge shrink-0">#{frame.seq}</span>
                      {frame.event !== "message" && (
                        <span className="wb-tone wb-tone-info !font-mono">{frame.event}</span>
                      )}
                      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-soft">
                        {frame.data.replace(/\n/g, " ⏎ ") || t("response.sse.noData")}
                      </span>
                      {!!snippet && (
                        <span className="wb-sse-snippet" title={t("response.sse.snippetTitle")}>{snippet}</span>
                      )}
                      <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                        +{frame.atMs}ms
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                        Δ{delta}ms
                      </span>
                    </button>
                    {open && (
                      <div className="wb-sse-detail">
                        <div className="mb-1.5 flex items-center gap-2 text-[10px] text-ink-faint">
                          <span className="wb-tone wb-tone-muted">Raw</span>
                          {!!frame.id && <span>id: {frame.id}</span>}
                          <span>seq: {frame.seq}</span>
                          <button
                            type="button"
                            className="wb-chip !ml-auto !h-6 !px-2 !text-[10px]"
                            onClick={() => void copy(frame.raw)}
                          >
                            <Copy className="h-3 w-3" />{t("response.common.copy")}
                          </button>
                        </div>
                        <pre className="wb-code-block !p-2 !text-[10.5px]">{frame.raw}</pre>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {view === "raw" && (
          <div>
            <div className="flex items-center gap-2 border-b border-surface-border bg-surface-muted px-3 py-1.5">
              <span className="text-[10.5px] text-ink-faint">{t("response.sse.rawTitle")}</span>
              <button
                type="button"
                className="wb-chip !ml-auto !h-6 !px-2 !text-[10px]"
                onClick={() =>
                  void copy(frames.map((frame) => `${frame.raw}\n\n`).join(""))
                }
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {t("response.common.copy")}
              </button>
            </div>
            <pre className="wb-code-block">
              {frames.map((frame) => `${frame.raw}\n\n`).join("") || t("response.sse.waitingEvents")}
            </pre>
          </div>
        )}

        {view === "settings" && (
          <div className="space-y-4 p-3">
            <div>
              <label className="wb-label">{t("response.sse.mergeMode")}</label>
              <div className="wb-segment !flex-wrap">
                {MODES.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    className={config.mode === mode.value ? "active" : ""}
                    onClick={() => setMergeConfig({ mode: mode.value })}
                  >
                    {t(mode.label)}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[10.5px] text-ink-faint">
                {activeMode ? t(activeMode.hint) : ""}
              </p>
            </div>

            {config.mode === "jsonPath" && (
              <div className="space-y-3">
                <div>
                  <label className="wb-label">{t("response.sse.textPath")}</label>
                  <input
                    className="wb-url-input !font-mono !text-[11px]"
                    value={config.jsonPath}
                    placeholder="$.choices[0].delta.content"
                    aria-label={t("response.sse.textPathAria")}
                    onChange={(event) => setMergeConfig({ jsonPath: event.target.value })}
                  />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {QUICK_PATHS.map((path) => (
                    <button
                      key={path}
                      type="button"
                      className="wb-chip !h-6 !px-2 !font-mono !text-[10px]"
                      onClick={() => setMergeConfig({ jsonPath: path })}
                    >
                      {path}
                    </button>
                  ))}
                </div>
                <div>
                  <label className="wb-label">{t("response.sse.reasoningPath")}</label>
                  <input
                    className="wb-url-input !font-mono !text-[11px]"
                    value={config.reasoningPath}
                    placeholder="$.choices[0].delta.reasoning_content"
                    aria-label={t("response.sse.reasoningPathAria")}
                    onChange={(event) => setMergeConfig({ reasoningPath: event.target.value })}
                  />
                </div>
              </div>
            )}

            <div className="wb-hint">
              <Settings2 className="mr-1 inline h-3 w-3" />
              {t("response.sse.ruleHint.a")}<strong>{t("response.sse.ruleHint.b")}</strong>
              {t("response.sse.ruleHint.c")}<strong>{FORMAT_LABELS[sse.format]}</strong>
              {t("response.sse.ruleHint.d", { merged: sse.mergedText.length, reasoning: sse.reasoningText.length })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
