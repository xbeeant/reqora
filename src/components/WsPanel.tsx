import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Cable, PlugZap, Trash2, XOctagon } from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { useT } from "../i18n";
import { ProtocolBar } from "./ProtocolBar";
import { Button } from "./ui";
import type { WsTimelineEntry } from "../types";

const STATUS_LABEL_KEY: Record<WsSessionStatus, string> = {
  connecting: "protocol.status.connecting",
  open: "protocol.status.open",
  closed: "protocol.status.closed",
  error: "protocol.status.error",
};
type WsSessionStatus = "connecting" | "open" | "closed" | "error";

const statusTone: Record<WsSessionStatus, string> = {
  connecting: "wb-tone wb-tone-warn",
  open: "wb-tone wb-tone-ok",
  closed: "wb-tone wb-tone-muted",
  error: "wb-tone wb-tone-danger",
};

function TimelineRow({ entry }: { entry: WsTimelineEntry }) {
  const t = useT();
  if (entry.direction === "sys") {
    return (
      <div className="wb-ws-sys">
        <span>{entry.label}</span>
        {entry.at ? <time>{new Date(entry.at).toLocaleTimeString("zh-CN")}</time> : null}
      </div>
    );
  }
  const out = entry.direction === "out";
  return (
    <div className={`wb-ws-row ${out ? "out" : "in"}`}>
      <div className="wb-ws-bubble">
        <div className="wb-ws-bubble-head">
          {out ? <ArrowUpFromLine className="h-3 w-3" /> : <ArrowDownToLine className="h-3 w-3" />}
          <span>{out ? t("protocol.ws.sent") : t("protocol.ws.recv")}</span>
          <span className="wb-ws-time">
            +{entry.atMs}ms{entry.binary ? t("protocol.ws.binary") : ""}
          </span>
        </div>
        <pre className="wb-ws-payload scrollbar-thin">
          {entry.data || t("protocol.common.empty")}
        </pre>
      </div>
    </div>
  );
}

/**
 * Apifox-style WebSocket debugging panel: live message timeline plus a
 * composer. Shown in place of the HTTP editor/response split whenever the
 * active interface is a WS request.
 */
export function WsPanel() {
  const t = useT();
  const draft = useWorkspace((state) => state.draft);
  const session = useWorkspace((state) => state.wsSessions[state.draft.id]);
  const connectWs = useWorkspace((state) => state.connectWs);
  const sendWsMessage = useWorkspace((state) => state.sendWsMessage);
  const closeWs = useWorkspace((state) => state.closeWs);
  const clearWsTimeline = useWorkspace((state) => state.clearWsTimeline);
  const isSending = useWorkspace((state) => state.isSending);

  const [message, setMessage] = useState('{\n  "hello": "ws"\n}');
  const timelineRef = useRef<HTMLDivElement>(null);

  const live = session && (session.status === "open" || session.status === "connecting");

  useEffect(() => {
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session?.messages.length]);

  const send = () => {
    const text = message.trim();
    if (!text || !live) return;
    void sendWsMessage(text);
  };

  return (
    <div className="wb-ws">
      <ProtocolBar />
      <div className="wb-ws-toolbar">
        <Cable className="h-4 w-4 text-brand-500" />
        <span className="text-xs font-semibold text-ink">WebSocket</span>
        <span className={statusTone[(session?.status ?? "closed") as WsSessionStatus]}>
          {t(STATUS_LABEL_KEY[(session?.status ?? "closed") as WsSessionStatus])}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-faint" title={draft.url}>
          {session?.url || draft.url || "—"}
        </span>
        {session && session.messages.length > 0 && (
          <Button size="sm" variant="ghost" onClick={clearWsTimeline} title={t("protocol.common.clearHistory")}>
            <Trash2 className="h-3.5 w-3.5" />
            {t("protocol.common.clear")}
          </Button>
        )}
        {live ? (
          <Button size="sm" variant="danger" onClick={() => void closeWs()}>
            <XOctagon className="h-3.5 w-3.5" />
            {t("protocol.common.disconnect")}
          </Button>
        ) : (
          <Button size="sm" variant="primary" disabled={isSending} onClick={() => void connectWs()}>
            <PlugZap className="h-3.5 w-3.5" />
            {t("protocol.common.connect")}
          </Button>
        )}
      </div>

      {session?.error && (
        <div className="wb-banner wb-banner-danger">
          <XOctagon className="h-3.5 w-3.5" />
          {session.error}
        </div>
      )}

      <div ref={timelineRef} className="wb-ws-timeline scrollbar-thin">
        {!session || session.messages.length === 0 ? (
          <div className="wb-empty">
            <Cable className="mb-1 h-7 w-7 opacity-60" />
            <p className="wb-empty-title">{t("protocol.common.noMessages")}</p>
            <p className="max-w-sm text-xs leading-relaxed text-ink-faint">
              {t("protocol.ws.emptyDesc")}
            </p>
          </div>
        ) : (
          session.messages.map((entry) => <TimelineRow key={entry.id} entry={entry} />)
        )}
      </div>

      <div className="wb-ws-composer">
        <textarea
          className="wb-code scrollbar-thin"
          value={message}
          spellCheck={false}
          rows={2}
          placeholder={t("protocol.ws.messagePlaceholder")}
          aria-label={t("protocol.ws.messageAria")}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        <Button variant="primary" disabled={!live} onClick={send}>
          <ArrowUpFromLine className="h-3.5 w-3.5" />
          {t("protocol.common.send")}
        </Button>
      </div>
    </div>
  );
}
