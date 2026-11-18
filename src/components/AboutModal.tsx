import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowUpCircle,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
} from "lucide-react";
import changelogMarkdown from "../../CHANGELOG.md?raw";
import { api } from "../lib/api";
import { parseReleaseNotes, releaseSectionLabel } from "../lib/releaseNotes.ts";
import { runtimeStatusLabel } from "../lib/runtimeLabel.ts";
import { useT } from "../i18n";
import { useUpdateCheck, type UpdateCheckStatus } from "../store/updateCheck";
import { useWorkspace } from "../store/workspace";
import { MarkdownView } from "./MarkdownView";
import { Button, Modal } from "./ui";

const REPOSITORY_URL = "https://github.com/xbeeant/reqora";
const ISSUES_URL = `${REPOSITORY_URL}/issues`;

type Tab = "about" | "update" | "notes";

const TABS: { id: Tab; labelKey: string }[] = [
  { id: "about", labelKey: "tools.about.tabAbout" },
  { id: "update", labelKey: "tools.about.tabUpdate" },
  { id: "notes", labelKey: "tools.about.tabNotes" },
];

const UPDATE_LABELS: Record<UpdateCheckStatus, string> = {
  idle: "tools.about.statusIdle",
  checking: "tools.about.statusChecking",
  latest: "tools.about.statusLatest",
  available: "tools.about.statusAvailable",
  error: "tools.about.statusError",
};

const UPDATE_TONES: Record<UpdateCheckStatus, string> = {
  idle: "text-ink-faint",
  checking: "text-ink-faint",
  latest: "text-emerald-600",
  available: "text-brand-600",
  error: "text-red-600",
};

function StatusIcon({ status }: { status: UpdateCheckStatus }) {
  if (status === "checking") return <Loader2 className="h-4 w-4 animate-spin" />;
  if (status === "latest") return <CheckCircle2 className="h-4 w-4" />;
  if (status === "available") return <ArrowUpCircle className="h-4 w-4" />;
  if (status === "error") return <AlertCircle className="h-4 w-4" />;
  return <Info className="h-4 w-4" />;
}

const DT_CLASS = "text-ink-faint";
const DD_CLASS = "break-all font-mono text-ink-soft";

/**
 * Product-facing "About" dialog: brand/runtime info, live update status and
 * the CHANGELOG bundled at build time (`?raw`). The update manifest's `notes`
 * are shown separately from the in-app changelog because they describe a
 * release that may not be installed yet.
 */
export function AboutModal() {
  const t = useT();
  const open = useWorkspace((state) => state.aboutModalOpen);
  const setOpen = useWorkspace((state) => state.setAboutModalOpen);
  const runtime = useWorkspace((state) => state.runtime);
  const status = useUpdateCheck((state) => state.status);
  const result = useUpdateCheck((state) => state.result);
  const error = useUpdateCheck((state) => state.error);
  const check = useUpdateCheck((state) => state.check);
  // This dialog renders the update status itself. Checks started here use
  // manual=false so the standalone UpdateChecker does not also pop a
  // duplicate "已是最新 / 失败" toast in the bottom-right corner.

  const [tab, setTab] = useState<Tab>("about");
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);
  const release = useMemo(() => parseReleaseNotes(changelogMarkdown), []);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const version = runtime?.version ?? result?.currentVersion ?? "—";
  const workspacePath = runtime?.workspacePath ?? "";
  const downloadUrl = result?.downloadUrl ?? "";
  const notes = result?.notes ?? "";
  const pubDate = result?.pubDate ? result.pubDate.replace(/T.*$/, "") : "—";

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => {
        setCopied(null);
        copyTimer.current = null;
      }, 1600);
    } catch {
      // Clipboard can be unavailable in a WebView; the value stays visible.
      setCopied(null);
    }
  };

  const externalLink = (url: string, label: string) => (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-brand-600 hover:underline"
      onClick={() => void api.openUrl(url)}
    >
      {label}
      <ExternalLink className="h-3 w-3" />
    </button>
  );

  return (
    <Modal
      open={open}
      title={t("tools.about.title")}
      description={t("tools.about.desc")}
      onClose={() => setOpen(false)}
      width="max-w-3xl"
      footer={
        <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
          {t("tools.about.close")}
        </Button>
      }
    >
      <div className="wb-segment mb-4">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? "active" : ""}
            onClick={() => setTab(item.id)}
          >
            {t(item.labelKey)}
          </button>
        ))}
      </div>

      {tab === "about" && (
        <div className="space-y-5">
          <div className="rounded-lg border border-surface-border bg-surface-muted px-4 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                <Info className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="text-base font-semibold text-ink">
                  Reqora <span className="text-xs font-normal text-ink-faint">{t("tools.about.brandSuffix")}</span>
                </div>
                <div className="text-xs text-ink-soft">{t("tools.about.tagline")}</div>
              </div>
              <span className="ml-auto shrink-0 rounded-md border border-surface-border bg-surface px-2 py-1 font-mono text-xs text-ink-soft">
                v{version}
              </span>
            </div>
            <p className="mt-3 text-2xs leading-relaxed text-ink-faint">
              {t("tools.about.privacy")}
            </p>
          </div>

          <dl className="grid grid-cols-[132px_1fr] gap-y-2.5 text-xs">
            <dt className={DT_CLASS}>{t("tools.about.version")}</dt>
            <dd className={DD_CLASS}>v{version}</dd>
            <dt className={DT_CLASS}>{t("tools.about.runtimeStatus")}</dt>
            <dd className={DD_CLASS}>
              {runtime ? runtimeStatusLabel(runtime.status) : t("tools.about.runtimeConnecting")}
            </dd>
            <dt className={DT_CLASS}>{t("tools.about.logLevel")}</dt>
            <dd className={DD_CLASS}>{runtime?.logLevel ?? "—"}</dd>
            <dt className={DT_CLASS}>{t("tools.about.maxResponse")}</dt>
            <dd className={DD_CLASS}>
              {runtime ? `${(runtime.maxResponseBytes / 1024 / 1024).toFixed(1)} MB` : "—"}
            </dd>
            <dt className={DT_CLASS}>{t("tools.about.dataDir")}</dt>
            <dd className={DD_CLASS}>
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1">{workspacePath || "—"}</span>
                {workspacePath && (
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1 text-ink-faint hover:text-ink"
                    title={t("tools.about.copyDir")}
                    aria-label={t("tools.about.copyDir")}
                    onClick={() => void copy(workspacePath, "dir")}
                  >
                    <Copy className="h-3 w-3" />
                    {copied === "dir" && <span>{t("tools.common.copied")}</span>}
                  </button>
                )}
              </div>
            </dd>
            <dt className={DT_CLASS}>{t("tools.about.license")}</dt>
            <dd className={DD_CLASS}>MIT</dd>
            <dt className={DT_CLASS}>{t("tools.about.copyright")}</dt>
            <dd className={DD_CLASS}>Copyright 2026 xbeeant</dd>
            <dt className={DT_CLASS}>{t("tools.about.repository")}</dt>
            <dd className={DD_CLASS}>{externalLink(REPOSITORY_URL, REPOSITORY_URL)}</dd>
            <dt className={DT_CLASS}>{t("tools.about.issues")}</dt>
            <dd className={DD_CLASS}>{externalLink(ISSUES_URL, ISSUES_URL)}</dd>
          </dl>
        </div>
      )}

      {tab === "update" && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-lg border border-surface-border bg-surface-muted px-4 py-3">
            <span className={UPDATE_TONES[status]}>
              <StatusIcon status={status} />
            </span>
            <div className="min-w-0 flex-1">
              <div className={`text-xs font-medium ${UPDATE_TONES[status]}`}>
                {t(UPDATE_LABELS[status])}
              </div>
              <div className="mt-0.5 text-2xs leading-relaxed text-ink-faint">
                {status === "error"
                  ? (error ?? t("tools.common.unknownError"))
                  : t("tools.about.autoCheckHint")}
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              className="shrink-0"
              disabled={status === "checking"}
              onClick={() => void check(false)}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${status === "checking" ? "animate-spin" : ""}`} />
              {t("tools.about.checkUpdate")}
            </Button>
          </div>

          <dl className="grid grid-cols-[132px_1fr] gap-y-2.5 text-xs">
            <dt className={DT_CLASS}>{t("tools.about.currentVersion")}</dt>
            <dd className={DD_CLASS}>v{version}</dd>
            <dt className={DT_CLASS}>{t("tools.about.latestVersion")}</dt>
            <dd className={DD_CLASS}>{result ? `v${result.latestVersion}` : "—"}</dd>
            <dt className={DT_CLASS}>{t("tools.about.releaseDate")}</dt>
            <dd className={DD_CLASS}>{pubDate}</dd>
            <dt className={DT_CLASS}>{t("tools.about.signature")}</dt>
            <dd className={DD_CLASS}>
              {result
                ? result.signatureVerified
                  ? t("tools.about.sigVerified")
                  : t("tools.about.sigUnset")
                : "—"}
            </dd>
            <dt className={DT_CLASS}>{t("tools.about.downloadUrl")}</dt>
            <dd className={DD_CLASS}>{downloadUrl || "—"}</dd>
          </dl>

          {downloadUrl && (
            <Button size="sm" variant="primary" onClick={() => void api.openUrl(downloadUrl)}>
              <Download className="h-3.5 w-3.5" />
              {t("tools.about.download")}
            </Button>
          )}

          <div className="rounded-lg border border-surface-border px-4 py-3">
            <div className="mb-2 text-xs font-medium text-ink">{t("tools.about.releaseNotes")}</div>
            {notes ? (
              <MarkdownView text={notes} />
            ) : (
              <p className="wb-hint">
                {t("tools.about.noNotes")}
              </p>
            )}
          </div>
        </div>
      )}

      {tab === "notes" && (
        <div className="space-y-4">
          {release.intro && (
            <div className="rounded-lg border border-surface-border bg-surface-muted px-4 py-3">
              <MarkdownView text={release.intro} />
            </div>
          )}
          {release.sections.length === 0 ? (
            <p className="wb-hint">{t("tools.about.noChangelog")}</p>
          ) : (
            release.sections.map((section, index) => (
              <details
                key={section.version}
                open={index === 0}
                className="rounded-lg border border-surface-border px-4 py-3"
              >
                <summary className="cursor-pointer text-xs font-medium text-ink-soft">
                  {releaseSectionLabel(section.version)}
                  <span className="ml-2 text-2xs font-normal text-ink-faint">
                    {t("tools.about.bundled")}
                  </span>
                </summary>
                <div className="mt-3">
                  <MarkdownView text={section.body} emptyHint={t("tools.about.emptySection")} />
                </div>
              </details>
            ))
          )}
        </div>
      )}
    </Modal>
  );
}
