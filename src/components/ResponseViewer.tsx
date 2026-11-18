import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Image as ImageIcon,
  Inbox,
  ListTree,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  XCircle,
} from "lucide-react";
import { api } from "../lib/api";
import { resolveRequestAuth } from "../lib/auth.ts";
import { CODE_LANGUAGES, generateCode, type CodeLanguage } from "../lib/codegen";
import { buildCodeTemplateContext, renderCodeTemplate } from "../lib/codeTemplate";
import { collectPaths, formatMatchValue, queryJsonPath } from "../lib/jsonpath.ts";
import {
  detectImage,
  formatDuration,
  timingRows,
  timingSegments,
  type ImagePreview,
} from "../lib/smartView.ts";
import { variablesFrom } from "../lib/template";
import { validateResponse } from "../lib/validate";
import { useT } from "../i18n";
import { useWorkspace } from "../store/workspace";
import type { ResponseData, ScriptTest, StoredCookie } from "../types";
import { CodeTemplateModal } from "./CodeTemplateModal";
import { JsonTree } from "./JsonTree";
import { SseViewer } from "./SseViewer";
import { Badge, Button, Select, Spinner } from "./ui";
import { VirtualCodeView } from "./VirtualCodeView";
import { BodyWindowCache, loadBodyLines } from "../lib/responseBody.ts";

type ResponseTab =
  | "body"
  | "sse"
  | "timing"
  | "raw"
  | "headers"
  | "cookies"
  | "tests"
  | "logs"
  | "assertions"
  | "validate"
  | "curl";

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** Token-based highlighting. Never uses innerHTML — response bodies are untrusted. */
function HighlightedCode({ text }: { text: string }) {
  const nodes = useMemo(() => {
    const parts: ReactNode[] = [];
    const pattern =
      /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
    let lastIndex = 0;
    let key = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
      if (match[1]) {
        parts.push(
          <span key={key++} className={match[2] ? "wb-json-key" : "wb-json-string"}>
            {match[1]}
          </span>,
        );
        if (match[2]) parts.push(<span key={key++}>{match[2]}</span>);
      } else if (match[3]) {
        parts.push(
          <span key={key++} className="wb-json-number">
            {match[3]}
          </span>,
        );
      } else if (match[4]) {
        parts.push(
          <span key={key++} className="wb-json-bool">
            {match[4]}
          </span>,
        );
      }
      lastIndex = pattern.lastIndex;
    }
    parts.push(text.slice(lastIndex));
    return parts;
  }, [text]);

  return <>{nodes}</>;
}

function CookiesTable({
  response,
  jar,
  onRefreshJar,
  onClearJar,
}: {
  response: ResponseData;
  jar: StoredCookie[] | null;
  onRefreshJar: () => void;
  onClearJar: () => void;
}) {
  const t = useT();
  const cookies = response.headers
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .flatMap((header) => header.value.split(/,(?=\s*[^;,=]+\s*=)/))
    .map((raw) => {
      const [pair, ...attributes] = raw.trim().split(";");
      const index = pair.indexOf("=");
      return {
        name: index > 0 ? pair.slice(0, index).trim() : pair.trim(),
        value: index > 0 ? pair.slice(index + 1).trim() : "",
        attributes: attributes.map((item) => item.trim()).filter(Boolean).join(" · "),
      };
    });

  return (
    <div>
      <div className="border-b border-surface-border bg-surface-muted px-3 py-2 text-[10.5px] text-ink-faint">
        {t("response.cookies.setCookieTitle")}
      </div>
      {cookies.length === 0 ? (
        <div className="wb-empty !py-4"><p className="text-xs">{t("response.cookies.none")}</p></div>
      ) : (
        <table className="wb-table">
          <thead>
            <tr>
              <th className="!w-1/4">Name</th>
              <th className="!w-1/3">Value</th>
              <th>Attributes</th>
            </tr>
          </thead>
          <tbody>
            {cookies.map((cookie, index) => (
              <tr key={`${cookie.name}-${index}`}>
                <td className="font-mono text-ink">{cookie.name}</td>
                <td className="break-all font-mono">{cookie.value}</td>
                <td className="font-mono text-2xs">{cookie.attributes || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="flex items-center gap-2 border-y border-surface-border bg-surface-muted px-3 py-2 text-[10.5px] text-ink-faint">
        <span>{t("response.cookies.jarTitle")}</span>
        <span className="!ml-auto flex items-center gap-1">
          <button
            type="button"
            className="wb-chip !h-6 !px-2 !text-[10px]"
            onClick={onRefreshJar}
            title={t("response.common.refresh")}
          >
            <RefreshCw className="h-3 w-3" />
          </button>
          {jar && jar.length > 0 && (
            <button
              type="button"
              className="wb-chip !h-6 !px-2 !text-[10px] hover:!text-red-600"
              onClick={onClearJar}
            >
              <Trash2 className="h-3 w-3" /> {t("response.common.clear")}
            </button>
          )}
        </span>
      </div>
      {jar === null ? (
        <div className="wb-empty !py-4"><p className="text-xs">{t("response.common.loading")}</p></div>
      ) : jar.length === 0 ? (
        <div className="wb-empty !py-4">
          <p className="text-xs">{t("response.cookies.jarEmpty")}</p>
          <p className="mt-1 text-2xs text-ink-faint">
            {t("response.cookies.jarHint")}
          </p>
        </div>
      ) : (
        <table className="wb-table">
          <thead>
            <tr>
              <th className="!w-1/4">Domain</th>
              <th className="!w-1/5">Name</th>
              <th className="!w-1/3">Value</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {jar.map((cookie, index) => (
              <tr key={`${cookie.domain}-${cookie.name}-${index}`}>
                <td className="font-mono text-ink">{cookie.domain}</td>
                <td className="break-all font-mono">{cookie.name}</td>
                <td className="break-all font-mono">{cookie.value}</td>
                <td className="text-2xs text-ink-faint">
                  {[
                    cookie.hostOnly ? "hostOnly" : `.${cookie.domain}`,
                    cookie.secure ? "Secure" : null,
                    cookie.expiresAtMs
                      ? new Date(cookie.expiresAtMs).toLocaleString()
                      : t("response.cookies.session"),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Binary image bodies render directly from the base64 payload. */
function ImagePreviewPane({
  response,
  preview,
  onCopy,
}: {
  response: ResponseData;
  preview: ImagePreview;
  onCopy: (text: string) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [copied, setCopied] = useState(false);
  const t = useT();
  const copyBase64 = async () => {
    onCopy(response.body);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="wb-image-pane">
      <div className="wb-image-bar">
        <ImageIcon className="h-3.5 w-3.5" />
        <span className="wb-tone wb-tone-info">{preview.mime}</span>
        {preview.sniffed && (
          <span className="text-[10px] text-ink-faint">{t("response.image.sniffed")}</span>
        )}
        <span className="text-[10px] text-ink-faint">{formatBytes(response.size)}</span>
        {response.truncated && (
          <span className="wb-tone wb-tone-warn">{t("response.image.truncated")}</span>
        )}
        <div className="wb-segment wb-segment-xs !ml-auto">
          <button type="button" onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))}>−</button>
          <button type="button" onClick={() => setZoom(1)} title={t("response.image.resetZoom")}>{Math.round(zoom * 100)}%</button>
          <button type="button" onClick={() => setZoom((value) => Math.min(4, value + 0.25))}>+</button>
        </div>
        <button type="button" className="wb-chip !h-7 !px-2.5 !text-[10px]" onClick={() => void copyBase64()}>
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? t("response.common.copied") : t("response.image.copyBase64")}
        </button>
      </div>
      <div className="wb-image-stage">
        <img
          src={preview.dataUrl}
          alt={t("response.image.alt")}
          style={{ transform: `scale(${zoom})` }}
        />
      </div>
    </div>
  );
}

/** Five-phase timing breakdown. Every value is a real Rust-side checkpoint. */
function TimingView({ response }: { response: ResponseData }) {
  const t = useT();
  const timings = response.timings;
  if (!timings) {
    return (
      <div className="wb-empty">
        <Clock className="h-8 w-8 opacity-50" />
        <p className="wb-empty-title">{t("response.timing.none.title")}</p>
        <p className="max-w-sm text-xs leading-relaxed">
          {t("response.timing.none.desc", { total: formatDuration(response.timeMs) })}
        </p>
      </div>
    );
  }
  const rows = timingRows(timings);
  const segments = timingSegments(timings);
  const denominator = Math.max(timings.totalMs, 1);
  return (
    <div className="wb-timing">
      <div className="wb-timing-summary">
        <div><span>{t("response.timing.total")}</span><strong>{formatDuration(timings.totalMs)}</strong></div>
        <div><span>{t("response.timing.ttfb")}</span><strong>{formatDuration(timings.totalMs - timings.transferMs)}</strong></div>
        <div><span>{t("response.timing.protocol")}</span><strong>{timings.protocol}</strong></div>
        <div><span>{t("response.timing.connection")}</span><strong>{timings.reused ? t("response.timing.reused") : t("response.timing.new")}</strong></div>
      </div>
      <div className="wb-timeline" role="img" aria-label={t("response.timing.chartAria")}>
        {segments.map((segment) => (
          <div
            key={segment.key}
            className={`wb-timeline-seg phase-${segment.key}`}
            style={{ width: `${segment.width}%` }}
            title={`${segment.label} · ${formatDuration(segment.ms)}`}
          />
        ))}
      </div>
      <table className="wb-table wb-timing-table">
        <thead>
          <tr><th className="!w-28">{t("response.timing.col.phase")}</th><th className="!w-24">{t("response.timing.col.duration")}</th><th className="!w-1/4">{t("response.timing.col.percent")}</th><th>{t("response.timing.col.note")}</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className={row.merged ? "wb-timing-merged" : ""}>
              <td className="font-medium text-ink">{row.label}</td>
              <td className="font-mono">{row.merged ? "—" : formatDuration(row.ms)}</td>
              <td>
                <div className="wb-timing-track">
                  {!row.merged && (
                    <span
                      className={`wb-timing-bar phase-${row.key}`}
                      style={{ width: `${Math.min((row.ms / denominator) * 100, 100)}%` }}
                    />
                  )}
                </div>
              </td>
              <td className="!text-[10.5px]">{row.hint}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="wb-timing-legend">
        {segments.map((segment) => (
          <span key={segment.key}>
            <i className={`phase-${segment.key}`} />{segment.label}
          </span>
        ))}
      </div>
      <p className="wb-timing-note">
        {t("response.timing.note")}
        {timings.reused ? " " + t("response.timing.reuseNote") : ""}
      </p>
    </div>
  );
}

/** Request / response in wire form, verbatim headers and body. */
function RawView({
  response,
  side,
  onSide,
  onCopy,
}: {
  response: ResponseData;
  side: "request" | "response";
  onSide: (side: "request" | "response") => void;
  onCopy: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const t = useT();
  const text = side === "request" ? response.rawRequest : response.rawResponse;
  const copyText = () => {
    onCopy(text ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="wb-raw">
      <div className="wb-raw-bar">
        <div className="wb-segment wb-segment-xs">
          <button type="button" className={side === "request" ? "active" : ""} onClick={() => onSide("request")}>{t("response.raw.request")}</button>
          <button type="button" className={side === "response" ? "active" : ""} onClick={() => onSide("response")}>{t("response.raw.response")}</button>
        </div>
        <span className="text-[10px] text-ink-faint">
          {t("response.raw.note")}
        </span>
        <button
          type="button"
          className="wb-chip !ml-auto !h-7 !px-2.5 !text-[10px]"
          disabled={!text}
          onClick={copyText}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? t("response.common.copied") : t("response.raw.copy")}
        </button>
      </div>
      {text === undefined ? (
        <div className="wb-empty">
          <Inbox className="h-8 w-8 opacity-50" />
          <p className="wb-empty-title">{t("response.raw.none.title")}</p>
          <p className="max-w-sm text-xs leading-relaxed">
            {t("response.raw.none.desc")}
          </p>
        </div>
      ) : (
        <pre className="wb-code-block !min-h-full">{text}</pre>
      )}
    </div>
  );
}

export function ResponseViewer() {
  const t = useT();
  const [tab, setTab] = useState<ResponseTab>("body");
  const [view, setView] = useState<"pretty" | "raw" | "tree">("pretty");
  const [copied, setCopied] = useState(false);
  const [jar, setJar] = useState<StoredCookie[] | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  // Tab 数量多到需要横向滚动时，让当前激活项始终留在可视区。
  useEffect(() => {
    const container = tabsRef.current;
    const active = container?.querySelector<HTMLElement>('[data-tab][aria-selected="true"]');
    if (!container || !active) return;
    const box = container.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    if (item.left < box.left) container.scrollLeft -= box.left - item.left + 8;
    else if (item.right > box.right) container.scrollLeft += item.right - box.right + 8;
  }, [tab]);

  const response = useWorkspace((state) => state.response);
  const draft = useWorkspace((state) => state.draft);
  // 只订阅本视图需要的域：响应查看期间其他快照域变化不再触发重渲染。
  const environments = useWorkspace((state) => state.snapshot.environments);
  const activeEnvironmentId = useWorkspace((state) => state.snapshot.activeEnvironmentId);
  const collections = useWorkspace((state) => state.snapshot.collections);
  const allCases = useWorkspace((state) => state.snapshot.cases);
  const dataModels = useWorkspace((state) => state.snapshot.dataModels);
  const outcome = useWorkspace((state) => state.scriptOutcome);
  const sse = useWorkspace((state) => state.sse);
  const sendError = useWorkspace((state) => state.sendError);
  const isSending = useWorkspace((state) => state.isSending);
  const send = useWorkspace((state) => state.send);
  const cancelSend = useWorkspace((state) => state.cancelSend);
  const downloadResult = useWorkspace((state) => state.downloadResult);
  const downloadError = useWorkspace((state) => state.downloadError);
  const clearDownload = useWorkspace((state) => state.clearDownload);
  const [codeLang, setCodeLang] = useState<CodeLanguage>("curl");
  const [codeTarget, setCodeTarget] = useState("builtin:curl");
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [jsonPath, setJsonPath] = useState("");
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
  const [rawSide, setRawSide] = useState<"request" | "response">("request");
  const codeTemplates = useWorkspace((state) => state.snapshot.codeTemplates);
  // 代码预览可编辑：手动改动存副本，生成结果变化时重置，复制用副本。
  const [codeEditDraft, setCodeEditDraft] = useState<string | null>(null);

  const loadJar = useCallback(async () => {
    try {
      setJar(await api.cookieList());
    } catch {
      setJar(null);
    }
  }, []);

  // The jar changes with every request — refresh whenever the Cookies tab
  // becomes active or a new response lands.
  useEffect(() => {
    if (tab === "cookies") void loadJar();
  }, [tab, response, loadJar]);

  const clearJar = useCallback(async () => {
    try {
      await api.cookieClear();
    } finally {
      void loadJar();
    }
  }, [loadJar]);

  // A stream starts producing readable text before the final response exists,
  // so bring the timeline forward as soon as the first event arrives. A normal
  // response switches back automatically if the tab was left on SSE.
  useEffect(() => {
    if (sse.active) {
      setTab("sse");
    } else if (response) {
      setTab((current) => (current === "sse" ? "body" : current));
    }
  }, [sse.active, response]);

  const variables = useMemo(() => {
    const environment = environments.find(
      (item) => item.id === activeEnvironmentId,
    );
    return variablesFrom(environment?.variables ?? []);
  }, [environments, activeEnvironmentId]);

  const activeCodeTemplate = codeTarget.startsWith("tpl:")
    ? codeTemplates?.find((item) => item.id === codeTarget.slice(4))
    : undefined;

  useEffect(() => {
    // 选中模板被删除时回到内置 cURL，避免下拉显示 cURL 却仍用旧语言生成。
    if (codeTarget.startsWith("tpl:") && !activeCodeTemplate) {
      setCodeTarget("builtin:curl");
      setCodeLang("curl");
    }
  }, [codeTarget, activeCodeTemplate]);

  // Copy-code / custom templates must show the effective auth, not the
  // frontend-only `inherit` marker. In a case tab `draft` is a copy with a
  // fresh id, so `cases` is needed to find the original interface's collection.
  const codeDraft = useMemo(
    () => resolveRequestAuth(draft, collections, undefined, allCases),
    [draft, collections, allCases],
  );

  const generatedCode = useMemo(() => {
    if (activeCodeTemplate) {
      return renderCodeTemplate(
        activeCodeTemplate.content,
        buildCodeTemplateContext(codeDraft, variables, response?.resolvedUrl),
      );
    }
    return {
      code: generateCode(codeDraft, codeLang, variables, response?.resolvedUrl),
      unknownTokens: [] as string[],
    };
  }, [activeCodeTemplate, codeDraft, variables, codeLang, response?.resolvedUrl]);

  // 生成结果变化时（请求改动 / 换语言 / 换模板）丢弃手动编辑的副本。
  useEffect(() => {
    setCodeEditDraft(null);
  }, [generatedCode.code]);

  const codeEditDirty = codeEditDraft !== null && codeEditDraft !== generatedCode.code;
  const codePreviewText = codeEditDraft ?? generatedCode.code;

  const bodyText =
    response && response.bodyKind === "json" && view === "pretty"
      ? prettyJson(response.body)
      : (response?.body ?? "");

  const parsedBody = useMemo(() => {
    // A truncated body is only a preview — never pretend the fragment parses.
    if (!response || response.bodyKind !== "json" || response.truncated) return null;
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      return null;
    }
  }, [response]);

  const [bodyCache] = useState(() => new BodyWindowCache());

  // Release a spilled body only when a *new* response replaces it. Releasing
  // on unmount would break switching tabs/requests and back: the store still
  // points at that bodyRef, but the on-disk rows would already be gone.
  // Otherwise BodyStore prunes to the most recent 12 bodies, so disk stays
  // bounded without an explicit release.
  const previousBodyId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const next = response?.bodyRef;
    const previous = previousBodyId.current;
    if (previous && previous !== next) {
      void api.releaseResponseBody(previous).catch(() => {});
      bodyCache.clear(previous);
    }
    previousBodyId.current = next;
  }, [response?.bodyRef, bodyCache]);

  const loadWindow = useCallback(
    (startLine: number, count: number) =>
      response?.bodyRef
        ? loadBodyLines(response, startLine, count, bodyCache)
        : Promise.resolve([]),
    [response, bodyCache],
  );

  const virtualTotalLines = response
    ? (response.totalLines ?? Math.max(1, (response.body ?? "").split("\n").length))
    : 1;

  const pathQuery = useMemo(
    () => (jsonPath.trim() && parsedBody !== null ? queryJsonPath(parsedBody, jsonPath) : null),
    [parsedBody, jsonPath],
  );
  const pathSets = useMemo(
    () => (pathQuery?.ok ? collectPaths(pathQuery.matches) : null),
    [pathQuery],
  );
  const imagePreview = useMemo(
    () => (response ? detectImage(response) : null),
    [response],
  );

  const tests: (ScriptTest & { source?: string })[] = [
    ...(outcome?.tests ?? []),
    ...(outcome?.assertions ?? []),
  ];
  const passed = tests.filter((test) => test.ok).length;
  const failed = tests.length - passed;

  // Auto-validation against the documented response examples. Skipped while a
  // stream is in progress (the final response does not exist yet).
  const validation = useMemo(() => {
    if (!response || sse.active) return [];
    return validateResponse(draft, response, dataModels ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, response, sse.active, dataModels]);
  const hasDocResponses = (draft.doc?.responses?.length ?? 0) > 0;
  const validationErrors = validation.filter((item) => item.level === "error").length;
  const validationWarnings = validation.filter((item) => item.level === "warning").length;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const tabs: { key: ResponseTab; label: string; badge?: number }[] = [
    { key: "body", label: "Body" },
    {
      key: "sse",
      label: t("response.tab.sse"),
      badge: sse.active ? sse.frames.length : undefined,
    },
    { key: "timing", label: t("response.tab.timing") },
    { key: "raw", label: t("response.tab.raw") },
    { key: "headers", label: "Headers", badge: response?.headers.length },
    {
      key: "cookies",
      label: "Cookies",
      badge: response?.headers.filter((header) => header.name.toLowerCase() === "set-cookie").length,
    },
    { key: "tests", label: "Tests", badge: tests.length || undefined },
    { key: "logs", label: "Script Logs", badge: outcome?.logs.length },
    { key: "assertions", label: "Assertions", badge: outcome?.assertions.length },
    {
      key: "validate",
      label: t("response.tab.validate"),
      badge: validation.length || undefined,
    },
    { key: "curl", label: t("response.tab.code") },
  ];

  return (
    <section className="wb-pane h-full">
      <div className="wb-resp-head">
        <div
          ref={tabsRef}
          className="wb-cfg-tabs wb-resp-tabs !flex-1 !border-0 !p-0"
          role="tablist"
          aria-label={t("response.tabsAria")}
          onWheel={(event) => {
            const el = event.currentTarget;
            // 鼠标滚轮默认只滚垂直方向；溢出时把 deltaY 映射成横向滚动。
            if (el.scrollWidth > el.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
              el.scrollLeft += event.deltaY;
            }
          }}
        >
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              data-tab={item.key}
              className={`wb-cfg-tab ${tab === item.key ? "active" : ""}`}
              onClick={() => setTab(item.key)}
            >
              {item.key === "sse" && sse.streaming && <span className="wb-sse-pulse" />}
              {item.label}
              {!!item.badge && <span className="wb-mini-badge">{item.badge}</span>}
            </button>
          ))}
        </div>
        {!response && sse.active && (
          <div className="flex shrink-0 items-center gap-2 text-[10.5px] text-ink-soft">
            <span className="wb-tone wb-tone-info">
              {sse.streaming ? t("response.sse.streaming") : t("response.sse.ended")}
            </span>
            {sse.meta && <span>{sse.meta.status} {sse.meta.statusText}</span>}
            <span>{t("response.sse.summary", { events: sse.frames.length, chars: sse.mergedText.length })}</span>
          </div>
        )}
        {response && (
          <div className="flex shrink-0 items-center gap-2.5 text-[10.5px] text-ink-soft">
            {tests.length > 0 && (
              <span className={`wb-tone ${failed > 0 ? "wb-tone-danger" : "wb-tone-ok"}`}>
                {failed > 0 ? `FAIL ${failed}` : `PASS ${passed}`}
              </span>
            )}
            <span className={`wb-tone ${response.ok ? "wb-tone-ok" : "wb-tone-danger"}`}>
              {response.status} {response.statusText}
            </span>
            <button
              type="button"
              className="wb-timing-jump"
              title={t("response.timing.jump")}
              onClick={() => setTab("timing")}
            >
              <Clock className="h-3 w-3" />
              {response.timeMs} ms
            </button>
            <span className="hidden xl:inline">{formatBytes(response.size)}</span>
          </div>
        )}
      </div>

      {response && response.missingVariables.length > 0 && (
        <div className="wb-banner wb-banner-warn">
          <AlertTriangle className="h-3.5 w-3.5" />
          {t("response.missingVars")}
          <span className="font-mono font-medium">
            {response.missingVariables.map((name) => `{{${name}}}`).join(" ")}
          </span>
        </div>
      )}

      {response?.truncated && (
        <div className="wb-banner wb-banner-warn">
          <AlertTriangle className="h-3.5 w-3.5" />
          {t("response.truncatedBanner", {
            size: formatBytes(response.size),
            decoded: response.contentEncoding
              ? t("response.truncatedDecoded", { encoding: response.contentEncoding })
              : "",
            inline: formatBytes(response.inlineBytes ?? response.body.length),
          })}
        </div>
      )}

      {downloadResult && (
        <div className="wb-banner wb-banner-success !py-2" title={downloadResult.path}>
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">
              {t("response.download.saved", {
                name: downloadResult.fileName,
                size: formatBytes(downloadResult.size),
              })}
            </p>
            <p className="truncate font-mono text-[10px] opacity-75">{downloadResult.path}</p>
          </div>
          <button
            type="button"
            className="wb-icon-btn !h-6 !w-6"
            aria-label={t("response.download.dismiss")}
            title={t("response.download.dismiss")}
            onClick={clearDownload}
          >
            <XCircle className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {downloadError && (
        <div className="wb-banner wb-banner-danger !py-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{t("response.download.failed")}</p>
            <p className="truncate font-mono text-[10px] opacity-75">{downloadError}</p>
          </div>
          <button
            type="button"
            className="wb-icon-btn !h-6 !w-6"
            aria-label={t("response.download.dismiss")}
            title={t("response.download.dismiss")}
            onClick={clearDownload}
          >
            <XCircle className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {sendError && (
        <div className="wb-banner wb-banner-danger !py-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{sendError.message}</p>
            <p className="font-mono text-[10px] opacity-75">
              {sendError.code} · requestId: {sendError.requestId}
            </p>
          </div>
          <Button size="sm" variant="danger" onClick={() => void send()}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t("response.common.retry")}
          </Button>
        </div>
      )}

      <div
        className={`wb-resp-body scrollbar-thin ${
          tab === "sse" || tab === "curl" ? "!flex !flex-col !overflow-hidden" : ""
        }`}
      >
        {tab === "sse" ? (
          <SseViewer />
        ) : isSending ? (
          <div className="wb-empty">
            <Spinner className="h-6 w-6 text-brand-500" />
            <p>{t("response.sending")}</p>
            <Button size="sm" variant="ghost" onClick={cancelSend}>{t("response.common.cancel")}</Button>
          </div>
        ) : tab === "curl" ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-surface-border bg-surface-muted px-3 py-2 shrink-0">
              <Badge>{t("response.code.badge")}</Badge>
              <Select
                className="!h-7 !py-0 !text-[11px]"
                value={codeTarget}
                aria-label={t("response.code.selectAria")}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value.startsWith("builtin:")) setCodeLang(value.slice(8) as CodeLanguage);
                  setCodeTarget(value);
                }}
              >
                {CODE_LANGUAGES.map((item) => (
                  <option key={item.id} value={`builtin:${item.id}`}>
                    {t("response.code.builtin", { label: item.label })}
                  </option>
                ))}
                {(codeTemplates ?? []).length > 0 && (
                  <option disabled value="__divider__">{t("response.code.divider")}</option>
                )}
                {(codeTemplates ?? []).map((item) => (
                  <option key={item.id} value={`tpl:${item.id}`}>
                    {item.name}
                  </option>
                ))}
              </Select>
              <button
                type="button"
                className="wb-chip !h-7 !px-2.5 !text-[10px]"
                title={t("response.code.manageTitle")}
                onClick={() => setTemplateModalOpen(true)}
              >
                <Settings2 className="h-3 w-3" />
                {t("response.code.manage")}
              </button>
              <span className="hidden text-[10px] text-ink-faint xl:inline">
                {t("response.code.warn")}
              </span>
              {codeEditDirty && (
                <button
                  type="button"
                  className="wb-chip !h-7 !px-2.5 !text-[10px]"
                  title={t("response.code.reset")}
                  onClick={() => setCodeEditDraft(null)}
                >
                  <RefreshCw className="h-3 w-3" />
                  {t("response.code.reset")}
                </button>
              )}
              <button
                type="button"
                className="wb-chip !ml-auto !h-7 !px-2.5 !text-[10px]"
                onClick={() => void copy(codePreviewText)}
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? t("response.common.copied") : t("response.common.copy")}
              </button>
            </div>
            {generatedCode.unknownTokens.length > 0 && (
              <div className="wb-banner wb-banner-warn !py-1.5 shrink-0">
                <AlertTriangle className="h-3.5 w-3.5" />
                {t("response.code.unknownVars")}
                <span className="font-mono">{generatedCode.unknownTokens.join("、")}</span>
              </div>
            )}
            {activeCodeTemplate && (
              <div className="border-b border-surface-border bg-surface-muted px-3 py-1.5 text-[10px] text-ink-faint shrink-0">
                {activeCodeTemplate.name}
                {activeCodeTemplate.description ? ` · ${activeCodeTemplate.description}` : ""}
              </div>
            )}
            <textarea
              className="wb-code-block wb-code-preview-fill w-full resize-none font-mono outline-none focus:border-accent"
              value={codePreviewText}
              placeholder={t("response.code.empty")}
              spellCheck={false}
              onChange={(event) => setCodeEditDraft(event.target.value)}
            />
          </div>
        ) : !response ? (
          <div className="wb-empty">
            <Inbox className="h-8 w-8 opacity-50" />
            <p className="wb-empty-title">{sendError ? t("response.empty.error.title") : t("response.empty.title")}</p>
            <p className="max-w-sm text-xs leading-relaxed">
              {sendError
                ? t("response.empty.error.desc")
                : t("response.empty.desc")}
            </p>
          </div>
        ) : tab === "timing" ? (
          <TimingView response={response} />
        ) : tab === "raw" ? (
          <RawView
            response={response}
            side={rawSide}
            onSide={setRawSide}
            onCopy={(text) => void copy(text)}
          />
        ) : tab === "headers" ? (
          <table className="wb-table">
            <thead>
              <tr><th className="!w-1/3">Header</th><th>Value</th></tr>
            </thead>
            <tbody>
              {response.headers.map((header, index) => (
                <tr key={`${header.name}-${index}`}>
                  <td className="font-mono text-ink">{header.name}</td>
                  <td className="break-all font-mono">{header.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : tab === "cookies" ? (
          <CookiesTable response={response} jar={jar} onRefreshJar={() => void loadJar()} onClearJar={() => void clearJar()} />
        ) : tab === "tests" ? (
          tests.length === 0 ? (
            <div className="wb-empty">
              <CheckCircle2 className="h-8 w-8 opacity-50" />
              <p className="wb-empty-title">{t("response.tests.empty.title")}</p>
              <p className="max-w-sm text-xs leading-relaxed">
                {t("response.tests.empty.desc")}
              </p>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-3 border-b border-surface-border bg-surface-muted px-3 py-2 text-[11px]">
                <span className={`wb-tone ${failed > 0 ? "wb-tone-danger" : "wb-tone-ok"}`}>
                  {failed > 0 ? "FAIL" : "PASS"}
                </span>
                <span className="text-ink-soft">
                  {passed} passed · {failed} failed · {tests.length} total
                </span>
              </div>
              {tests.map((test, index) => (
                <div key={index} className="wb-log-line !font-sans">
                  <span className="!w-5">
                    {test.ok ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 text-red-500" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-ink">{test.name}</span>
                      <span className="wb-tone wb-tone-muted">{test.origin === "script" ? t("response.tests.script") : t("response.tests.assertion")}</span>
                    </div>
                    {!test.ok && test.message && (
                      <div className="mt-0.5 text-[10.5px] text-red-600">{test.message}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : tab === "logs" ? (
          <div>
            <div className="flex flex-wrap items-center gap-2 border-b border-surface-border bg-surface-muted px-3 py-2 text-[10.5px] text-ink-faint">
              <span>{t("response.logs.count", { count: outcome?.logs.length ?? 0 })}</span>
              <span>·</span>
              <span>{t("response.logs.duration", { ms: outcome?.durationMs ?? 0 })}</span>
              {!!outcome?.mutations.length && (
                <>
                  <span>·</span>
                  <span className="font-mono">{t("response.logs.mutations", { list: outcome.mutations.join(", ") })}</span>
                </>
              )}
            </div>
            {outcome?.preError && (
              <div className="wb-banner wb-banner-danger">{t("response.logs.preError", { message: outcome.preError })}</div>
            )}
            {outcome?.error && (
              <div className="wb-banner wb-banner-danger">{t("response.logs.postError", { message: outcome.error })}</div>
            )}
            {!outcome?.logs.length && !outcome?.preError && !outcome?.error ? (
              <div className="wb-empty">
                <p className="wb-empty-title">{t("response.logs.empty.title")}</p>
                <p className="text-xs">{t("response.logs.empty.desc")}</p>
              </div>
            ) : (
              outcome?.logs.map((line, index) => (
                <div key={index} className="wb-log-line">
                  <span>{index + 1}</span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ink">{line}</span>
                </div>
              ))
            )}
          </div>
        ) : tab === "assertions" ? (
          !outcome?.assertions.length ? (
            <div className="wb-empty">
              <p className="wb-empty-title">{t("response.assertions.empty.title")}</p>
              <p className="text-xs">{t("response.assertions.empty.desc")}</p>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 border-b border-surface-border bg-surface-muted px-3 py-2 text-[10.5px] text-ink-faint">
                <span className={`wb-tone ${failed > 0 ? "wb-tone-danger" : "wb-tone-ok"}`}>
                  {failed > 0 ? "FAIL" : "PASS"}
                </span>
                <span>{t("response.assertions.passed", { passed: outcome.assertions.filter((item) => item.ok).length, total: outcome.assertions.length })}</span>
              </div>
              {outcome.assertions.map((assertion, index) => (
                <div key={index} className="wb-log-line !font-sans">
                  <span className="!w-5">
                    {assertion.ok ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 text-red-500" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium text-ink">{assertion.name}</span>
                      <span className="wb-tone wb-tone-muted !font-mono">{assertion.source} · {assertion.path}</span>
                      <span className="font-mono text-[10px] text-ink-faint">
                        {assertion.op} {assertion.expected || "—"}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[10.5px] text-ink-faint">
                      {t("response.assertions.actual")}<span className="font-mono text-ink-soft">{assertion.actual}</span>
                      {!assertion.ok && assertion.message ? ` · ${assertion.message}` : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : tab === "validate" ? (
          !hasDocResponses ? (
            <div className="wb-empty">
              <p className="wb-empty-title">{t("response.validate.noDocs.title")}</p>
              <p className="text-xs">
                {t("response.validate.noDocs.desc")}
              </p>
            </div>
          ) : validation.length === 0 ? (
            <div>
              <div className="flex items-center gap-2 border-b border-surface-border bg-surface-muted px-3 py-2 text-[10.5px] text-ink-faint">
                <span className="wb-tone wb-tone-ok">PASS</span>
                <span>{t("response.validate.pass.title")}</span>
              </div>
              <div className="wb-log-line !font-sans">
                <span className="!w-5"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /></span>
                <span className="min-w-0 flex-1 text-[10.5px] text-ink-soft">
                  {t("response.validate.pass.desc", { status: response?.status })}
                </span>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 border-b border-surface-border bg-surface-muted px-3 py-2 text-[10.5px] text-ink-faint">
                <span className={`wb-tone ${validationErrors > 0 ? "wb-tone-danger" : "wb-tone-warn"}`}>
                  {validationErrors > 0 ? "FAIL" : "WARN"}
                </span>
                <span>
                  {t("response.validate.summary", { total: validation.length, errors: validationErrors, warnings: validationWarnings })}
                </span>
                <span className="!ml-auto text-[10px]">{t("response.validate.note")}</span>
              </div>
              {validation.map((finding, index) => (
                <div key={index} className="wb-log-line !font-sans">
                  <span className="!w-5">
                    {finding.level === "error" ? (
                      <XCircle className="h-3.5 w-3.5 text-red-500" />
                    ) : finding.level === "warning" ? (
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                    ) : (
                      <AlertCircle className="h-3.5 w-3.5 text-sky-500" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{finding.check}</span>
                      <span className={`wb-tone !font-mono ${finding.level === "error" ? "wb-tone-danger" : finding.level === "warning" ? "wb-tone-warn" : "wb-tone-muted"}`}>
                        {finding.level}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[10.5px] text-ink-faint">{finding.message}</div>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : imagePreview ? (
          <ImagePreviewPane
            response={response}
            preview={imagePreview}
            onCopy={(text) => void copy(text)}
          />
        ) : response.bodyKind === "empty" ? (
          <div className="wb-empty">
            <p className="wb-empty-title">{t("response.body.empty.title")}</p>
            <p className="text-xs">{t("response.body.empty.desc", { status: response.status })}</p>
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-surface-border bg-surface-muted px-3 py-1.5">
              {response.bodyKind === "json" && (
                <div className="wb-segment !py-0.5">
                  {(["pretty", "raw", "tree"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={view === option ? "active" : ""}
                      onClick={() => setView(option)}
                    >
                      {option === "pretty" ? "Pretty" : option === "raw" ? "Raw" : (
                        <span className="inline-flex items-center gap-1"><ListTree className="h-3 w-3" />Tree</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              <span className="wb-tone wb-tone-muted">{response.bodyKind}</span>
              <span className="text-[10px] text-ink-faint">{formatBytes(response.size)}</span>
              <button
                type="button"
                className="wb-chip !ml-auto !h-7 !px-2.5 !text-[10px]"
                onClick={() => void copy(bodyText)}
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? t("response.common.copied") : t("response.common.copy")}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
              {response.truncated && response.bodyKind === "json" && view !== "raw" ? (
                <div className="wb-vcode-notice">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    {t("response.body.truncatedNotice")}
                    <button
                      type="button"
                      className="wb-chip !mt-2 !h-7 !px-2.5 !text-[10px]"
                      onClick={() => setView("raw")}
                    >
                      {t("response.body.viewFullText")}
                    </button>
                  </div>
                </div>
              ) : view === "tree" && response.bodyKind === "json" && parsedBody !== null ? (
                <div className="wb-jsonpath-wrap">
                  <div className="wb-jsonpath-bar">
                    <Search className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                    <input
                      className="wb-jsonpath-input"
                      value={jsonPath}
                      onChange={(event) => setJsonPath(event.target.value)}
                      placeholder={t("response.jsonpath.placeholder")}
                      spellCheck={false}
                      aria-label={t("response.jsonpath.aria")}
                    />
                    {jsonPath && (
                      <button type="button" className="wb-jsonpath-clear" title={t("response.jsonpath.clear")} onClick={() => setJsonPath("")}>×</button>
                    )}
                    <span className={`wb-jsonpath-status ${pathQuery && !pathQuery.ok ? "error" : ""}`}>
                      {!pathQuery
                        ? t("response.jsonpath.browse")
                        : !pathQuery.ok
                          ? pathQuery.error
                          : t("response.jsonpath.matches", { count: pathQuery.matches.length, plus: pathQuery.truncated ? "+" : "" })}
                    </span>
                    <button
                      type="button"
                      className={`wb-chip !h-6 !px-2 !text-[10px] ${onlyMatches ? "active" : ""}`}
                      onClick={() => setOnlyMatches((value) => !value)}
                    >
                      {t("response.jsonpath.onlyMatches")}
                    </button>
                    <button
                      type="button"
                      className="wb-chip !h-6 !px-2 !text-[10px]"
                      onClick={() => setExpandAll((value) => !value)}
                    >
                      {expandAll ? t("response.jsonpath.collapse") : t("response.jsonpath.expandAll")}
                    </button>
                  </div>
                  {pathQuery?.ok && pathQuery.matches.length > 0 && (
                    <div className="wb-jsonpath-results">
                      {pathQuery.matches.slice(0, 50).map((match) => (
                        <button
                          key={match.path}
                          type="button"
                          className="wb-jsonpath-result"
                          title={t("response.jsonpath.copyTitle")}
                          onClick={() => void copy(match.path)}
                        >
                          <span className="wb-jsonpath-result-path">{match.path}</span>
                          <span className="wb-jsonpath-result-value">{formatMatchValue(match.value)}</span>
                        </button>
                      ))}
                      {pathQuery.matches.length > 50 && (
                        <div className="wb-jsonpath-more">
                          {t("response.jsonpath.more", { total: pathQuery.matches.length, plus: pathQuery.truncated ? "+" : "" })}
                        </div>
                      )}
                    </div>
                  )}
                  <JsonTree
                    data={parsedBody}
                    filtering={!!pathQuery?.ok}
                    exactPaths={pathSets?.exact}
                    ancestorPaths={pathSets?.ancestors}
                    onlyMatches={onlyMatches}
                    expandAll={expandAll}
                    onCopyPath={(path) => void copy(path)}
                  />
                </div>
              ) : response.bodyRef ? (
                <VirtualCodeView
                  totalLines={virtualTotalLines}
                  rowHeight={20}
                  highlight={response.bodyKind === "json" && view === "pretty"}
                  bodyId={response.bodyRef}
                  onLoadWindow={loadWindow}
                />
              ) : (
                <pre className="wb-code-block !min-h-full">
                  {response.bodyKind === "json" && view === "pretty" ? (
                    <HighlightedCode text={bodyText} />
                  ) : (
                    bodyText
                  )}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>
      <CodeTemplateModal open={templateModalOpen} onClose={() => setTemplateModalOpen(false)} />
    </section>
  );
}
