import { useEffect, useState } from "react";
import { AlertCircle, Check, Loader2, X } from "lucide-react";
import { ActivityRail, type SideView } from "./components/ActivityRail";
import { ModelsPanel } from "./components/ModelsPanel";
import { DocPagesModal } from "./components/DocPagesModal";
import { ConsolePanel } from "./components/ConsolePanel";
import { HistoryDetail } from "./components/HistoryDetail";
import { EnvironmentModal } from "./components/EnvironmentModal";
import { ErrorLogModal } from "./components/ErrorLogModal";
import { ImportExportModal } from "./components/ImportExportModal";
import { RequestDetail } from "./components/RequestDetail";
import { RequestTabs } from "./components/RequestTabs";
import { SearchModal } from "./components/SearchModal";
import { SettingsCenter } from "./components/SettingsCenter";
import { TrashModal } from "./components/TrashModal";
import { McpModal } from "./components/McpModal";
import { AiGeneratePanel } from "./components/AiGeneratePanel";
import { GrpcModal } from "./components/GrpcModal";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { UpdateChecker } from "./components/UpdateChecker";
import { AboutModal } from "./components/AboutModal";
import { Button } from "./components/ui";
import { useT } from "./i18n";
import { useWorkspace, startExternalChangeWatch, stopExternalChangeWatch, checkExternalChanges } from "./store/workspace";
import { runtimeLabel } from "./lib/runtimeLabel.ts";

const VIEW_KEY = "reqora.sideView";

/** Ordered phases of workspace initialization, mirrored by `markStage` in
 * src/store/workspace/slices/core.ts. Shown in the loading overlay so a hang
 * is attributable to a single step. */
const LOAD_STEPS = ["cloud", "read", "normalize", "ready"] as const;
type LoadStep = (typeof LOAD_STEPS)[number];

/** 视图标签复用 core 命名空间的 core.view.* key（TopBar 亦在用）。 */
const VIEW_LABELS: Record<SideView, string> = {
  apis: "core.view.apis",
  cases: "core.view.cases",
  scenarios: "core.view.scenarios",
  models: "core.view.models",
  docs: "core.view.docs",
  history: "core.view.history",
};

export default function App() {
  const initialize = useWorkspace((state) => state.initialize);
  const reinitialize = useWorkspace((state) => state.reinitialize);
  const send = useWorkspace((state) => state.send);
  const saveRequest = useWorkspace((state) => state.saveRequest);
  const activeTab = useWorkspace((state) => state.activeTab);
  const draft = useWorkspace((state) => state.draft);
  const updateCase = useWorkspace((state) => state.updateCase);
  const isLoading = useWorkspace((state) => state.isLoading);
  const loadError = useWorkspace((state) => state.loadError);
  const loadStage = useWorkspace((state) => state.loadStage);
  const loadTrace = useWorkspace((state) => state.loadTrace);
  const dismissLoadError = useWorkspace((state) => state.dismissLoadError);
  const saveError = useWorkspace((state) => state.saveError);
  const workspaceConflict = useWorkspace((state) => state.workspaceConflict);
  const resolveWorkspaceConflict = useWorkspace(
    (state) => state.resolveWorkspaceConflict,
  );
  const dismissSaveError = useWorkspace((state) => state.dismissSaveError);
  const retrySave = useWorkspace((state) => state.retrySave);
  const resetWorkspace = useWorkspace((state) => state.resetWorkspace);
  const runtime = useWorkspace((state) => state.runtime);
  const isSending = useWorkspace((state) => state.isSending);
  const theme = useWorkspace((state) => state.snapshot.theme ?? "light");
  const activeProjectId = useWorkspace((state) => state.projectsState?.activeProjectId);
  const setSearchModalOpen = useWorkspace((state) => state.setSearchModalOpen);
  const setConsoleOpen = useWorkspace((state) => state.setConsoleOpen);
  const setAboutModalOpen = useWorkspace((state) => state.setAboutModalOpen);
  const autoSyncMinutes = useWorkspace(
    (state) => state.snapshot.settings.autoSyncMinutes ?? 5,
  );
  const cloudLoggedIn = useWorkspace((state) => state.cloudLoggedIn);
  const cloudProjectId = useWorkspace((state) => state.cloudProjectId);
  const cloudBusy = useWorkspace((state) => state.cloudBusy);
  const cloudLastImport = useWorkspace((state) => state.cloudLastImport);
  const syncMode = useWorkspace((state) => state.syncMode);
  const gitBusy = useWorkspace((state) => state.gitBusy);
  const gitLastSyncAt = useWorkspace((state) => state.gitLastSyncAt);
  const t = useT();

  const [errorLogOpen, setErrorLogOpen] = useState(false);

  const loadFailed = loadStage === "error";
  const lastStage = [...loadTrace].reverse().find((entry) => entry.stage !== "error")?.stage;
  const activeStep: LoadStep =
    loadStage === "error"
      ? LOAD_STEPS.includes(lastStage as LoadStep)
        ? (lastStage as LoadStep)
        : "cloud"
      : LOAD_STEPS.includes(loadStage as LoadStep)
        ? (loadStage as LoadStep)
        : "cloud";
  const activeStepIndex = LOAD_STEPS.indexOf(activeStep);

  const [view, setView] = useState<SideView>(() => {
    const stored = localStorage.getItem(VIEW_KEY);
    return stored === "cases" ||
      stored === "scenarios" ||
      stored === "models" ||
      stored === "docs" ||
      stored === "history"
      ? stored
      : "apis";
  });

  useEffect(() => {
    void initialize();
  }, [initialize]);

  // MCP / CLI 写的是同一个 workspace.db，但 WebView 只在启动时读一次快照。
  // 轮询共享版本号 + 窗口重新聚焦时补一次检查，让外部写入的用例能自动
  // 出现在接口用例面板里，而不是等到下一次编辑触发保存冲突才被看见。
  useEffect(() => {
    startExternalChangeWatch();
    const onFocus = () => void checkExternalChanges("window-focus");
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      stopExternalChangeWatch();
    };
  }, []);

  // 自动同步循环：启动 ~30s 后先跑一轮，之后按设置间隔（0 = 关闭）。
  useEffect(() => {
    if (autoSyncMinutes <= 0) return;
    let cancelled = false;
    const tick = () => {
      // 按用户在设置页选择的通道分派：服务端 / Git-native / 仅本机。
      if (!cancelled) void useWorkspace.getState().syncAutoTick();
    };
    const initial = setTimeout(tick, 30_000);
    const interval = setInterval(tick, autoSyncMinutes * 60_000);
    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [autoSyncMinutes]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  useEffect(() => {
    // The history database is read on demand: opening the view, or switching
    // the local project (rows are scoped by project id), decrypts the newest
    // runs. Nothing is loaded into the workspace snapshot.
    if (view === "history") void useWorkspace.getState().loadHistory();
  }, [view, activeProjectId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key === "Enter") {
        event.preventDefault();
        void send();
      } else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchModalOpen(true);
      } else if (event.key === "\`") {
        // Apifox-style: ⌘` toggles the bottom console.
        event.preventDefault();
        const current = useWorkspace.getState().consoleOpen;
        setConsoleOpen(!current);
      } else if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        // Frozen tabs (execution run / saved revision) are snapshots — never
        // write them back into a collection. Send / load test remain available.
        if (activeTab?.kind === "history" || activeTab?.kind === "revision") return;
        // ⌘S saves into whichever kind of tab is active: interface or case.
        if (activeTab?.kind === "case") {
          updateCase(activeTab.id, { request: { ...draft, updatedAt: 0 } });
        } else {
          saveRequest();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [send, saveRequest, activeTab, draft, updateCase, setSearchModalOpen, setConsoleOpen]);

  return (
    <div className="wb-app">
      <TopBar view={view} />

      <div className="wb-body">
        <ActivityRail view={view} onViewChange={setView} />
        <Sidebar view={view} />

        <main className="wb-main">
          {view === "models" ? (
            <ModelsPanel />
          ) : view === "history" ? (
            <HistoryDetail />
          ) : (
            <>
              <RequestTabs />

              {loadError && (
                <div className="wb-banner wb-banner-danger">
                  <AlertCircle className="h-3.5 w-3.5" />
                  <span className="flex-1">{t("shell.loadFailed", { error: loadError })}</span>
                  <Button size="sm" variant="danger" onClick={() => void resetWorkspace()}>
                    {t("shell.resetWorkspace")}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setErrorLogOpen(true)}>
                    {t("shell.errorLog.view")}
                  </Button>
                </div>
              )}

              <RequestDetail />
            </>
          )}
        </main>

        <AiGeneratePanel />
      </div>

      <ConsolePanel />

      <footer className="wb-statusbar">
        <div className="flex items-center gap-2">
          <span className={`wb-status-dot ${runtime ? "" : "offline"}`} />
          <button
            type="button"
            title={t("shell.aboutTitle")}
            className="text-[10px] text-ink-faint transition-colors hover:text-ink"
            onClick={() => setAboutModalOpen(true)}
          >
            {runtimeLabel(runtime)}
          </button>
          {isSending && <span className="text-[10px] text-brand-500">{t("shell.sending")}</span>}
          {syncMode === "git" && (
            <span title={gitLastSyncAt ? t("sync.status.lastAt", { time: new Date(gitLastSyncAt).toLocaleString() }) : t("sync.status.noDir")}>
              {gitBusy
                ? t("sync.status.syncing")
                : gitLastSyncAt
                  ? t("sync.status.lastAt", {
                      time: new Date(gitLastSyncAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      }),
                    })
                  : t("sync.status.never")}
            </span>
          )}
          {cloudLoggedIn && syncMode !== "git" && (
            <span
              title={
                cloudProjectId != null
                  ? cloudLastImport
                    ? t("shell.lastSyncAt", { time: new Date(cloudLastImport.at).toLocaleString() })
                    : t("shell.boundNotSynced")
                  : t("shell.loggedInNotBound")
              }
            >
              {cloudBusy
                ? t("shell.cloudSyncing")
                : cloudProjectId != null
                  ? cloudLastImport
                    ? t("shell.cloudSyncAt", {
                        time: new Date(cloudLastImport.at).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        }),
                      })
                    : t("shell.cloudSyncPending")
                  : t("shell.cloudUnbound")}
            </span>
          )}
        </div>
        <span className="text-[10px] text-ink-faint">
          {t(VIEW_LABELS[view])} ·{" "}
          {t("shell.viewSuffix", {
            kind: activeTab?.kind === "case" ? t("shell.kindCase") : t("shell.kindApi"),
          })}
        </span>
        <div className="ml-auto flex items-center gap-3 text-[10px] text-ink-faint">
          <span>{t("shell.shortcutSend")}</span>
          <span>{t("shell.shortcutSearch")}</span>
          <span>
            {t("shell.shortcutSave", {
              kind: activeTab?.kind === "case" ? t("shell.kindCase") : t("shell.kindApi"),
            })}
          </span>
        </div>
      </footer>

      {(isLoading || loadFailed) && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-surface/80 backdrop-blur-[1px]">
          <div className="w-[380px] rounded-xl border border-surface-border bg-surface p-5 text-xs text-ink-soft shadow-xl">
            <div className="flex items-center gap-2 text-sm font-medium text-ink">
              {loadFailed ? (
                <AlertCircle className="h-4 w-4 text-amber-500" />
              ) : (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {t(loadFailed ? "shell.loadStep.failed" : "shell.loadingWorkspace")}
            </div>
            <ol className="mt-4 space-y-2">
              {LOAD_STEPS.map((step, index) => {
                const entry = loadTrace.find((item) => item.stage === step);
                const next = entry
                  ? loadTrace.find((item) => item.at > entry.at)
                  : undefined;
                const elapsed = entry
                  ? ((next?.at ?? Date.now()) - entry.at).toString() + " ms"
                  : null;
                const state = loadFailed && index === activeStepIndex
                  ? "failed"
                  : index < activeStepIndex || (index === activeStepIndex && entry && !loadFailed)
                    ? "active"
                    : "pending";
                return (
                  <li key={step} className="flex items-center gap-2">
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                      {state === "failed" ? (
                        <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
                      ) : entry ? (
                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                      ) : (
                        <span className="h-1.5 w-1.5 rounded-full bg-ink-faint" />
                      )}
                    </span>
                    <span className={state === "pending" ? "text-ink-faint" : ""}>
                      {t(`shell.loadStep.${step}`)}
                    </span>
                    {elapsed && <span className="ml-auto tabular-nums text-ink-faint">{elapsed}</span>}
                  </li>
                );
              })}
            </ol>
            {loadError && (
              <p className="mt-3 break-words rounded-md bg-amber-500/10 p-2 text-amber-600">
                {t("shell.loadFailed", { error: loadError })}
              </p>
            )}
            <p className="mt-3 text-[10px] text-ink-faint">{t("shell.loadStep.hint")}</p>
            {loadFailed && (
              <div className="mt-3 flex justify-end gap-2">
                <Button size="sm" variant="secondary" onClick={() => void reinitialize()}>
                  {t("shell.loadStep.retry")}
                </Button>
                <Button size="sm" variant="secondary" onClick={dismissLoadError}>
                  {t("shell.dismissNotice")}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {workspaceConflict ? (
        <div className="wb-toast wb-toast-conflict">
          <AlertCircle className="h-4 w-4 text-amber-500" />
          <div className="flex flex-col gap-0.5">
            <span>{t("store.save.conflictTitle")}</span>
            <span className="text-xs opacity-75">{workspaceConflict}</span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void resolveWorkspaceConflict("reload")}
          >
            {t("store.save.conflictReload")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void resolveWorkspaceConflict("overwrite")}
          >
            {t("store.save.conflictOverwrite")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setErrorLogOpen(true)}>
            {t("shell.errorLog.view")}
          </Button>
        </div>
      ) : (
        saveError && (
          <div className="wb-toast wb-toast-detail">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <span className="min-w-0 flex-1 leading-relaxed">{saveError}</span>
            <Button size="sm" variant="secondary" onClick={() => void retrySave()}>
              {t("shell.retrySave")}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setErrorLogOpen(true)}>
              {t("shell.errorLog.view")}
            </Button>
            <button type="button" aria-label={t("shell.dismissNotice")} onClick={dismissSaveError}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      )}

      <EnvironmentModal />
      <SettingsCenter />
      <UpdateChecker />
      <AboutModal />
      <ImportExportModal />
      <DocPagesModal />
      <SearchModal />
      <TrashModal />
      <McpModal />
      <GrpcModal />
      <ErrorLogModal open={errorLogOpen} onClose={() => setErrorLogOpen(false)} />
    </div>
  );
}
