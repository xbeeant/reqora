/**
 * 设置中心「协作」页的同步通道面板：选择通道、配置 Git 目录、执行同步 /
 * 仓库操作、裁决冲突，以及在两条通道之间带数据转换。
 *
 * 所有状态都来自 workspace store，面板本身不持有同步数据；冲突裁决先暂存
 * 在 store 的 gitResolutions，点「应用裁决」才真正跑一轮同步写盘。
 */

import { useState } from "react";
import {
  ArrowLeftRight, Check, Cloud, FolderOpen, GitBranch, GitCommitHorizontal,
  GitPullRequest, HardDrive, RefreshCw, UploadCloud,
} from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { t, useT } from "../i18n";
import { api } from "../lib/api";
import { isCloudServerConfigured } from "../lib/cloudConnection";
import type { SyncMode } from "../lib/appConfig";
import { Badge } from "./ui";

const MODE_OPTIONS = [
  { value: "local", label: "sync.mode.local", desc: "sync.mode.local.desc", icon: HardDrive },
  { value: "server", label: "sync.mode.server", desc: "sync.mode.server.desc", icon: Cloud },
  { value: "git", label: "sync.mode.git", desc: "sync.mode.git.desc", icon: GitBranch },
] as const satisfies ReadonlyArray<{
  value: SyncMode;
  label: string;
  desc: string;
  icon: typeof Cloud;
}>;

const DOMAIN_LABELS: Record<string, string> = {
  folders: "sync.conflict.domain.folders",
  requests: "sync.conflict.domain.requests",
  environments: "sync.conflict.domain.environments",
  cases: "sync.conflict.domain.cases",
  scenarios: "sync.conflict.domain.scenarios",
  suites: "sync.conflict.domain.suites",
  artifacts: "sync.conflict.domain.artifacts",
};

const SECTION_CLS = "rounded-lg border border-surface-border bg-surface p-4";
const BTN_CLS = "wb-btn wb-btn-ghost";
const PRIMARY_CLS = "wb-btn wb-btn-primary";

export function SyncModePanel() {
  // 订阅语言变化，让面板在切换中英文时重新渲染（文案统一走 t()）。
  useT();
  const syncMode = useWorkspace((state) => state.syncMode);
  const cloudBaseUrl = useWorkspace((state) => state.cloudBaseUrl);
  // P0: no example.com fallback. The server channel and server-bound
  // conversions stay disabled until a real backend URL is configured.
  const serverConfigured = isCloudServerConfigured(cloudBaseUrl);
  const gitSyncDir = useWorkspace((state) => state.gitSyncDir);
  const gitAutoPull = useWorkspace((state) => state.gitAutoPull);
  const gitBusy = useWorkspace((state) => state.gitBusy);
  const gitError = useWorkspace((state) => state.gitError);
  const gitNotice = useWorkspace((state) => state.gitNotice);
  const gitLastSyncAt = useWorkspace((state) => state.gitLastSyncAt);
  const gitConflicts = useWorkspace((state) => state.gitConflicts);
  const gitResolutions = useWorkspace((state) => state.gitResolutions);
  const gitStatus = useWorkspace((state) => state.gitStatus);
  const syncConverting = useWorkspace((state) => state.syncConverting);
  const cloudLoggedIn = useWorkspace((state) => state.cloudLoggedIn);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const busy = gitBusy || syncConverting || actionBusy !== null;

  async function gitAction(action: "init" | "push", key: string): Promise<void> {
    if (!gitSyncDir || busy) return;
    setActionBusy(key);
    setActionError(null);
    try {
      const result = await api.gitSyncRun(gitSyncDir, action);
      if (!result.ok) {
        setActionError(t("sync.error.gitFailed", {
          action,
          message: (result.stderr || result.stdout || `exit ${result.code}`).trim(),
        }));
      }
      await useWorkspace.getState().refreshGitStatus();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("sync.error.gitFailed", { action, message: "" }));
    } finally {
      setActionBusy(null);
    }
  }

  const statusText = (): string => {
    if (!gitSyncDir) return t("sync.status.noDir");
    if (!gitStatus) return gitSyncDir;
    if (!gitStatus.available) return t("sync.status.noGit");
    if (!gitStatus.repo) return t("sync.status.notRepo");
    return gitStatus.dirty
      ? `${t("sync.status.repo", { branch: gitStatus.branch })} · ${t("sync.status.dirty", { count: gitStatus.changedFiles.length })}`
      : `${t("sync.status.repo", { branch: gitStatus.branch })} · ${t("sync.status.clean")}`;
  };

  return (
    <div className="space-y-3">
      <section className={SECTION_CLS}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[12px] font-semibold text-ink">{t("sync.section.mode")}</h3>
          <Badge tone={syncMode === "git" ? "success" : syncMode === "local" ? "neutral" : "warning"}>
            {t(`sync.mode.${syncMode}`)}
          </Badge>
        </div>
        <p className="mt-1 text-[11px] leading-5 text-ink-faint">{t("sync.section.modeDesc")}</p>
        {!serverConfigured ? (
          <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[10.5px] leading-4 text-amber-800">
            {t("shell.collabNotConfigured")}
          </p>
        ) : null}
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          {MODE_OPTIONS.map((option) => {
            const Icon = option.icon;
            const active = syncMode === option.value;
            return (
              <button key={option.value} type="button"
                disabled={busy || (option.value === "server" && !serverConfigured)}
                title={option.value === "server" && !serverConfigured ? t("shell.collabNotConfiguredShort") : undefined}
                onClick={() => void useWorkspace.getState().setSyncMode(option.value)}
                className={`flex h-full flex-col items-start gap-1 rounded-lg border p-3 text-left transition ${
                  active
                    ? "border-brand-400 bg-brand-50/70"
                    : "border-surface-border bg-surface-muted/40 hover:border-brand-200"}`}>
                <span className="flex w-full items-center gap-1.5 text-[11.5px] font-semibold text-ink">
                  <Icon size={14} className="text-brand-600" />
                  {t(option.label)}
                  {active ? <Check size={13} className="ml-auto text-brand-600" /> : null}
                </span>
                <span className="text-[10.5px] leading-4 text-ink-faint">{t(option.desc)}</span>
              </button>
            );
          })}
        </div>
      </section>

      {syncMode === "git" ? (
        <section className={SECTION_CLS}>
          <h3 className="text-[12px] font-semibold text-ink">{t("sync.section.git")}</h3>
          <p className="mt-1 text-[11px] leading-5 text-ink-faint">{t("sync.section.gitDesc")}</p>
          <div className="mt-3 grid grid-cols-[142px_minmax(0,1fr)] items-start gap-4 py-2 max-[620px]:grid-cols-1">
            <div className="pt-1.5">
              <div className="text-[12px] font-medium text-ink">{t("sync.field.dir")}</div>
              <p className="mt-0.5 text-[10.5px] leading-4 text-ink-faint">{t("sync.field.dirHint")}</p>
            </div>
            <div className="min-w-0 space-y-2">
              <div className="flex items-center gap-2">
                <input readOnly value={gitSyncDir}
                  placeholder={t("sync.field.choosePlaceholder")}
                  className="h-8 min-w-0 flex-1 rounded-md border border-surface-border bg-surface-muted px-2.5 font-mono text-[11px] text-ink outline-none" />
                <button type="button" className={BTN_CLS} disabled={busy}
                  onClick={() => void useWorkspace.getState().pickGitSyncDir()}>
                  <FolderOpen size={13} />{t("sync.action.chooseDir")}
                </button>
              </div>
              <label className="flex items-center gap-2 text-[11px] text-ink-soft">
                <input type="checkbox" checked={gitAutoPull}
                  onChange={(event) => void useWorkspace.getState().setGitAutoPull(event.target.checked)} />
                {t("sync.field.autoPull")}
                <span className="text-[10px] text-ink-faint">{t("sync.field.autoPullHint")}</span>
              </label>
              <div className="flex flex-wrap gap-2 pt-1">
                <button type="button" className={PRIMARY_CLS} disabled={busy || !gitSyncDir}
                  onClick={() => void useWorkspace.getState().gitSyncNow()}>
                  <RefreshCw size={13} />{t("sync.action.sync")}
                </button>
                <button type="button" className={BTN_CLS} disabled={busy || !gitSyncDir}
                  onClick={() => void useWorkspace.getState().gitSyncNow({ pull: true })}>
                  <GitPullRequest size={13} />{t("sync.action.pull")}
                </button>
                <button type="button" className={BTN_CLS} disabled={busy || !gitSyncDir}
                  onClick={() => void useWorkspace.getState().gitSyncNow({ pull: false, commit: true })}>
                  <GitCommitHorizontal size={13} />{t("sync.action.commit")}
                </button>
                <button type="button" className={BTN_CLS} disabled={busy || !gitSyncDir}
                  onClick={() => void gitAction("push", "push")}>
                  <UploadCloud size={13} />{t("sync.action.push")}
                </button>
                <button type="button" className={BTN_CLS} disabled={busy || !gitSyncDir}
                  onClick={() => void gitAction("init", "init")}>
                  <GitBranch size={13} />{t("sync.action.init")}
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <section className={SECTION_CLS}>
        <h3 className="text-[12px] font-semibold text-ink">{t("sync.section.transfer")}</h3>
        <p className="mt-1 text-[11px] leading-5 text-ink-faint">{t("sync.section.transferDesc")}</p>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          <div className="rounded-md border border-surface-border p-3">
            <p className="text-[10.5px] leading-4 text-ink-faint">{t("sync.convert.toGitHint")}</p>
            <button type="button" className={`${BTN_CLS} mt-2`} disabled={busy || !gitSyncDir}
              onClick={() => void useWorkspace.getState().convertSyncChannel("git")}>
              <ArrowLeftRight size={13} />
              {syncConverting ? t("sync.action.converting") : t("sync.action.convertToGit")}
            </button>
          </div>
          <div className="rounded-md border border-surface-border p-3">
            <p className="text-[10.5px] leading-4 text-ink-faint">{t("sync.convert.toServerHint")}</p>
            <button type="button" className={`${BTN_CLS} mt-2`}
              disabled={busy || !cloudLoggedIn || !serverConfigured}
              onClick={() => void useWorkspace.getState().convertSyncChannel("server")}>
              <ArrowLeftRight size={13} />
              {syncConverting ? t("sync.action.converting") : t("sync.action.convertToServer")}
            </button>
          </div>
        </div>
      </section>

      {syncMode === "git" ? (
        <section className={SECTION_CLS}>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[12px] font-semibold text-ink">{t("sync.section.status")}</h3>
            <button type="button" className={BTN_CLS} disabled={!gitSyncDir}
              onClick={() => void useWorkspace.getState().refreshGitStatus()}>
              <RefreshCw size={13} />
            </button>
          </div>
          <p className="mt-1 text-[11px] leading-5 text-ink-faint">{t("sync.section.statusDesc")}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-soft">
            <GitBranch size={13} className="text-brand-600" />
            <span className="font-mono text-[10.5px]">{statusText()}</span>
            <span className="text-ink-faint">
              {gitLastSyncAt
                ? t("sync.status.lastAt", { time: new Date(gitLastSyncAt).toLocaleString() })
                : t("sync.status.never")}
            </span>
          </div>
          {gitNotice ? (
            <p className="mt-2 rounded-md bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-700">{gitNotice}</p>
          ) : null}
          {gitError ? (
            <p className="mt-2 rounded-md bg-red-50 px-2.5 py-1.5 text-[11px] text-red-600">{gitError}</p>
          ) : null}
          {actionError ? (
            <p className="mt-2 rounded-md bg-red-50 px-2.5 py-1.5 text-[11px] text-red-600">{actionError}</p>
          ) : null}

          <div className="mt-3 border-t border-surface-border/60 pt-2">
            <div className="text-[11px] font-semibold text-ink">
              {gitConflicts.length > 0
                ? t("sync.conflict.count", { count: gitConflicts.length })
                : t("sync.conflict.noConflicts")}
            </div>
            {gitConflicts.length > 0 ? (
              <>
                <p className="mt-1 text-[10.5px] leading-4 text-ink-faint">{t("sync.conflict.hint")}</p>
                <div className="mt-2 divide-y divide-surface-border/60">
                  {gitConflicts.map((entry) => {
                    const key = `${entry.domain}:${entry.id}`;
                    const choice = gitResolutions[key];
                    return (
                      <div key={key} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <div className="min-w-0">
                          <div className="truncate text-[11px] font-medium text-ink">{entry.name || entry.id}</div>
                          <div className="text-[10px] text-ink-faint">
                            {t(DOMAIN_LABELS[entry.domain] ?? "sync.conflict.domain.requests")}
                          </div>
                        </div>
                        <div className="flex gap-1.5">
                          <button type="button"
                            className={choice === "local" ? PRIMARY_CLS : BTN_CLS}
                            onClick={() => useWorkspace.getState().gitResolveConflict(entry.domain, entry.id, "local")}>
                            {t("sync.conflict.useLocal")}
                          </button>
                          <button type="button"
                            className={choice === "git" ? PRIMARY_CLS : BTN_CLS}
                            onClick={() => useWorkspace.getState().gitResolveConflict(entry.domain, entry.id, "git")}>
                            {t("sync.conflict.useGit")}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <button type="button" className={`${PRIMARY_CLS} mt-2`}
                  disabled={busy || Object.keys(gitResolutions).length === 0}
                  onClick={() => void useWorkspace.getState().gitApplyResolutions()}>
                  {t("sync.action.applyResolutions")}
                </button>
              </>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
