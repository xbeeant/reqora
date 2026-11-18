import { useEffect, useRef, useState } from "react";
import { ChevronDown, Trash2, X } from "lucide-react";
import { useT } from "../i18n";
import { useWorkspace } from "../store/workspace";
import type { ConsoleEntry } from "../types";

const SOURCE_LABEL: Record<ConsoleEntry["source"], string> = {
  http: "response.console.source.http",
  ws: "response.console.source.ws",
  mqtt: "response.console.source.mqtt",
  soap: "response.console.source.soap",
  grpc: "response.console.source.grpc",
  mock: "response.console.source.mock",
  script: "response.console.source.script",
  scenario: "response.console.source.scenario",
  import: "response.console.source.import",
};

const LEVEL_CLASS: Record<ConsoleEntry["level"], string> = {
  info: "wb-console-info",
  warn: "wb-console-warn",
  error: "wb-console-error",
};

/**
 * Apifox-style bottom console: a live, filterable feed of network, WebSocket,
 * Mock, script and import events. Toggle from the top bar.
 */
export function ConsolePanel() {
  const t = useT();
  const open = useWorkspace((state) => state.consoleOpen);
  const setOpen = useWorkspace((state) => state.setConsoleOpen);
  const logs = useWorkspace((state) => state.consoleLogs);
  const clearConsole = useWorkspace((state) => state.clearConsole);
  const [source, setSource] = useState<"all" | ConsoleEntry["source"]>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  const filtered = source === "all" ? logs : logs.filter((entry) => entry.source === source);

  useEffect(() => {
    if (autoScroll && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [filtered.length, autoScroll]);

  if (!open) return null;

  return (
    <section className="wb-console" aria-label={t("response.console.aria")}>
      <div className="wb-console-head">
        <span className="text-2xs font-bold uppercase tracking-wider text-ink-soft">{t("response.console.title")}</span>
        <span className="wb-mini-badge">{filtered.length}</span>
        <div className="ml-2 flex items-center gap-1">
          {(["all", "http", "ws", "mock", "import", "mqtt", "soap", "grpc"] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={`wb-console-filter ${source === item ? "active" : ""}`}
              onClick={() => setSource(item)}
            >
              {item === "all" ? t("response.console.all") : t(SOURCE_LABEL[item])}
            </button>
          ))}
        </div>
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-2xs text-ink-faint">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(event) => setAutoScroll(event.target.checked)}
            className="accent-brand-500"
          />
          {t("response.console.autoScroll")}
        </label>
        <button type="button" className="wb-icon-btn !h-6 !w-6" title={t("response.console.clear")} onClick={clearConsole}>
          <Trash2 className="h-3 w-3" />
        </button>
        <button
          type="button"
          className="wb-icon-btn !h-6 !w-6"
          title={t("response.console.collapse")}
          aria-label={t("response.console.collapse")}
          onClick={() => setOpen(false)}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        <button type="button" className="wb-icon-btn !h-6 !w-6" title={t("response.console.close")} onClick={() => setOpen(false)}>
          <X className="h-3 w-3" />
        </button>
      </div>
      <div ref={bodyRef} className="wb-console-body scrollbar-thin">
        {filtered.length === 0 ? (
          <p className="px-3 py-3 text-2xs text-ink-faint">
            {t("response.console.empty")}
          </p>
        ) : (
          filtered.map((entry) => (
            <div key={entry.id} className={`wb-console-row ${LEVEL_CLASS[entry.level]}`}>
              <time>{new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false })}</time>
              <span className="wb-console-src">{t(SOURCE_LABEL[entry.source])}</span>
              <span className="wb-console-text">{entry.text}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
