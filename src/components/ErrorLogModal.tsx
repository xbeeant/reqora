import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Copy, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import { useT } from "../i18n";
import { Button, Modal } from "./ui";

interface LogLine {
  at?: number;
  source?: string;
  command?: string;
  code?: string;
  requestId?: string;
  message?: string;
  raw?: string;
}

/** Non-JSON lines (hand-edited / older builds) are shown verbatim. */
function parseLine(raw: string): LogLine | string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as LogLine;
    }
  } catch {
    // fall through
  }
  return raw;
}

/**
 * The installed app has no visible stdout. This dialog makes the on-disk error
 * log discoverable: where it lives, what the last failures were, and a path
 * that can be copied into a bug report.
 */
export function ErrorLogModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [path, setPath] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.readErrorLog(100);
      setPath(result.path ?? "");
      setLines(result.lines ?? []);
    } catch (cause) {
      setError(String((cause as Error)?.message ?? cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const copyPath = async () => {
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t("shell.errorLog.title")}
      description={t("shell.errorLog.description")}
      onClose={onClose}
      width="max-w-3xl"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={() => void load()} disabled={busy}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t("shell.errorLog.refresh")}
          </Button>
          <Button size="sm" onClick={onClose}>{t("shell.close")}</Button>
        </>
      }
    >
      <div className="mb-3 rounded-lg border border-surface-border bg-surface-sunken/60 px-3 py-2">
        <div className="text-[11px] font-medium text-ink-faint">{t("shell.errorLog.path")}</div>
        <div className="mt-1 flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all font-mono text-xs text-ink">{path || "—"}</code>
          <Button size="sm" variant="secondary" onClick={() => void copyPath()} disabled={!path}>
            <Copy className="h-3.5 w-3.5" />
            {copied ? t("shell.errorLog.copied") : t("shell.errorLog.copy")}
          </Button>
        </div>
        <div className="mt-2 text-[11px] text-ink-faint">{t("shell.errorLog.hint")}</div>
      </div>

      {error && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {t("shell.errorLog.loadFailed", { message: error })}
        </div>
      )}

      {lines.length === 0 ? (
        <div className="py-10 text-center text-xs text-ink-faint">{t("shell.errorLog.empty")}</div>
      ) : (
        <div className="space-y-1.5">
          {[...lines].reverse().map((raw, index) => {
            const parsed = parseLine(raw);
            const structured = typeof parsed !== "string";
            const item: LogLine = structured ? (parsed as LogLine) : {};
            const when = typeof item.at === "number"
              ? new Date(item.at).toLocaleString()
              : "";
            return (
              <div
                key={`${index}-${raw.slice(0, 24)}`}
                className="rounded-lg border border-surface-border px-3 py-2 text-xs"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-faint">
                  {when && <span className="font-mono">{when}</span>}
                  {item.source && <span className="rounded bg-surface-sunken px-1.5 py-0.5">{item.source}</span>}
                  {item.command && <span className="font-mono">{item.command}</span>}
                  {item.code && <span className="font-mono text-amber-600">{item.code}</span>}
                  {item.requestId && item.requestId !== "-" && (
                    <span className="font-mono">#{item.requestId}</span>
                  )}
                </div>
                <div className="mt-1 whitespace-pre-wrap break-words text-ink">
                  {structured ? (item.message ?? raw) : raw}
                </div>
                {structured && item.raw && item.raw !== item.message && (
                  <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-ink-faint">
                    {t("shell.errorLog.raw")} {item.raw}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
