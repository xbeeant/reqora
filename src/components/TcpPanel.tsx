import { ArrowRightLeft, Cable, Hexagon, Trash2, XOctagon } from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { useT } from "../i18n";
import { ProtocolBar } from "./ProtocolBar";
import { Badge, Button, Select, Spinner, inputClass } from "./ui";

/** 把 hex 字符串格式化成 16 字节一行的 hex dump。 */
function hexDump(hex: string): string {
  const rows: string[] = [];
  for (let i = 0; i < hex.length; i += 32) {
    const bytes = hex.slice(i, i + 32).match(/.{2}/g) ?? [];
    rows.push(bytes.join(" "));
  }
  return rows.join("\n");
}

function formatBytes(count: number): string {
  if (count < 1024) return `${count} B`;
  return `${(count / 1024).toFixed(1)} KB`;
}

/**
 * TCP 裸 socket 调试面板：连接 → 发送（文本/hex）→ 收到静默或 EOF 为止 →
 * 展示 hex 与文本两种渲染。一次性调试模型（无会话状态）。
 */
export function TcpPanel() {
  const t = useT();
  const draft = useWorkspace((state) => state.draft);
  const running = useWorkspace((state) => state.tcpRunning);
  const result = useWorkspace((state) => state.tcpResult);
  const error = useWorkspace((state) => state.tcpError);
  const encoding = useWorkspace((state) => state.tcpEncoding);
  const newline = useWorkspace((state) => state.tcpNewline);
  const payload = useWorkspace((state) => state.tcpPayload);
  const readTimeoutMs = useWorkspace((state) => state.tcpReadTimeoutMs);
  const runTcpDebug = useWorkspace((state) => state.runTcpDebug);
  const setTcpPayload = useWorkspace((state) => state.setTcpPayload);
  const setTcpEncoding = useWorkspace((state) => state.setTcpEncoding);
  const setTcpNewline = useWorkspace((state) => state.setTcpNewline);
  const setTcpReadTimeoutMs = useWorkspace((state) => state.setTcpReadTimeoutMs);
  const clearTcpResult = useWorkspace((state) => state.clearTcpResult);

  const run = () => {
    if (!draft.url.trim() || running) return;
    void runTcpDebug();
  };

  return (
    <div className="wb-ws">
      <ProtocolBar />
      <div className="wb-ws-toolbar">
        <Cable className="h-4 w-4 text-brand-500" />
        <span className="text-xs font-semibold text-ink">TCP</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-faint" title={draft.url}>
          {draft.url || "—"}
        </span>
        {result && (
          <Button size="sm" variant="ghost" onClick={clearTcpResult} title={t("protocol.common.clearResult")}>
            <Trash2 className="h-3.5 w-3.5" />
            {t("protocol.common.clear")}
          </Button>
        )}
        <Button size="sm" variant="primary" disabled={running || !draft.url.trim()} onClick={run}>
          {running ? <Spinner className="h-3.5 w-3.5" /> : <ArrowRightLeft className="h-3.5 w-3.5" />}
          {t("protocol.common.send")}
        </Button>
      </div>

      {error && (
        <div className="wb-banner wb-banner-danger">
          <XOctagon className="h-3.5 w-3.5" />
          {error}
        </div>
      )}

      <div className="space-y-3 p-3">
        <div className="grid grid-cols-3 gap-2">
          <label className="block">
            <span className="mb-1 block text-xs text-ink-soft">{t("protocol.tcp.encoding")}</span>
            <Select
              className={inputClass}
              value={encoding}
              aria-label={t("protocol.tcp.encodingAria")}
              onChange={(event) => setTcpEncoding(event.target.value as "text" | "hex")}
            >
              <option value="text">{t("protocol.tcp.encodingText")}</option>
              <option value="hex">{t("protocol.tcp.encodingHex")}</option>
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-ink-soft">{t("protocol.tcp.newline")}</span>
            <Select
              className={inputClass}
              value={newline}
              aria-label={t("protocol.tcp.newlineAria")}
              onChange={(event) => setTcpNewline(event.target.value as "none" | "lf" | "crlf")}
            >
              <option value="lf">{t("protocol.tcp.newlineLf")}</option>
              <option value="crlf">{t("protocol.tcp.newlineCrLf")}</option>
              <option value="none">{t("protocol.tcp.newlineNone")}</option>
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-ink-soft">{t("protocol.tcp.readTimeout")}</span>
            <input
              type="number"
              min={100}
              max={120000}
              step={100}
              className={`${inputClass} font-mono text-xs`}
              value={readTimeoutMs}
              aria-label={t("protocol.tcp.readTimeoutAria")}
              onChange={(event) =>
                setTcpReadTimeoutMs(Math.max(100, Number(event.target.value) || 2000))
              }
            />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs text-ink-soft">
            {t(encoding === "hex" ? "protocol.tcp.payloadHex" : "protocol.tcp.payloadText")}
          </span>
          <textarea
            className={`${inputClass} h-24 font-mono text-xs`}
            aria-label={t("protocol.tcp.payloadAria")}
            value={payload}
            spellCheck={false}
            placeholder={
              encoding === "hex"
                ? t("protocol.tcp.payloadPlaceholderHex")
                : t("protocol.tcp.payloadPlaceholderText")
            }
            onChange={(event) => setTcpPayload(event.target.value)}
          />
        </label>

        {result && (
          <div className="rounded-lg border border-surface-border bg-surface-sunken p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              <Badge tone={result.receivedBytes > 0 ? "success" : "neutral"}>
                {result.receivedBytes > 0
                  ? t("protocol.tcp.received")
                  : t("protocol.tcp.noResponse")}
              </Badge>
              <span className="text-ink-faint">
                {t("protocol.tcp.stats", {
                  sent: formatBytes(result.sentBytes),
                  received: formatBytes(result.receivedBytes),
                  elapsed: result.elapsedMs,
                })}
              </span>
              {result.closedByServer && (
                <Badge tone="neutral">{t("protocol.tcp.closedByServer")}</Badge>
              )}
              {result.truncated && <Badge tone="warning">{t("protocol.tcp.truncated")}</Badge>}
            </div>
            {result.warnings.length > 0 && (
              <ul className="mb-2 space-y-0.5 text-2xs text-amber-600">
                {result.warnings.map((warning, index) => (
                  <li key={index}>⚠ {warning}</li>
                ))}
              </ul>
            )}
            <div className="mb-1.5 flex items-center gap-1 text-2xs text-ink-faint">
              <Hexagon className="h-3 w-3" />
              Hex
            </div>
            <pre className="scrollbar-thin mb-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-surface p-2 font-mono text-2xs text-ink">
              {result.dataHex ? hexDump(result.dataHex) : t("protocol.common.none")}
            </pre>
            <div className="mb-1.5 flex items-center gap-1 text-2xs text-ink-faint">
              <Cable className="h-3 w-3" />
              {t("protocol.tcp.textRender")}
            </div>
            <pre className="scrollbar-thin max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-surface p-2 font-mono text-2xs text-ink">
              {result.dataText || t("protocol.common.none")}
            </pre>
          </div>
        )}

        {!result && !error && (
          <div className="rounded-lg border border-dashed border-surface-border px-4 py-6 text-center">
            <Cable className="mx-auto mb-2 h-6 w-6 text-ink-faint" />
            <p className="text-xs leading-relaxed text-ink-soft">
              {t("protocol.tcp.emptyDesc")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
