import { api } from "../../../lib/api.ts";
import { initializeCloudConnection } from "../../../lib/cloudConnection.ts";
import { emptyRequest } from "../../../lib/defaults.ts";
import { emptySnapshot } from "../../../lib/defaults.ts";
import { normalizeSnapshot } from "../../../lib/defaults.ts";
import { seedSnapshot } from "../../../lib/defaults.ts";
import { uid } from "../../../lib/id.ts";
import type { ConsoleEntry } from "../../../types.ts";
import { messageOf } from "../helpers.ts";
import { clone } from "../helpers.ts";
import { emptySseState } from "../helpers.ts";
import { t } from "../../../i18n/index.ts";
import type { StoreContext } from "../context.ts";
import type { CoreSlice, LoadStage } from "../types.ts";

export const createCoreSlice = (ctx: StoreContext): CoreSlice => {
  const { set, get, runtime, hydrateCloud, flushBeforeSwitch, clearPending } = ctx;
  const markStage = (stage: LoadStage) => {
    set((state) => ({
      loadStage: stage,
      loadTrace: [...state.loadTrace, { stage, at: Date.now() }].slice(-24),
    }));
  };
  return {
    snapshot: emptySnapshot(),
    runtime: null,
    draft: emptyRequest(),
    tabs: [],
    activeTab: null,
    detailTab: "debug",
    runningCaseIds: [],
    runningScenarioId: null,
    activeCollectionId: null,
    response: null,
    scriptOutcome: null,
    sse: emptySseState(),
    projectsState: null,
    isSending: false,
    isLoading: true,
    loadError: null,
    loadStage: "cloud",
    loadTrace: [],
    sendError: null,
    saveError: null,
    workspaceRev: null,
    workspaceConflict: null,
    abortController: null,
    environmentModalOpen: false,
    settingsModalOpen: false,
    aboutModalOpen: false,
    importExportModalOpen: false,
    searchModalOpen: false,
    trashModalOpen: false,
    docPagesModalOpen: false,
    docPagesFocusId: null,
    benchmarkModalOpen: false,
    benchmarkRunning: false,
    benchmarkReport: null,
    benchmarkError: null,
    introspecting: false,
    introspectionError: null,
    introspectionSchema: null,
    mcpModalOpen: false,
    mcpConnections: {},
    mcpBusy: null,
    mcpError: null,
    mcpCallResult: null,
    aiModalOpen: false,
    aiBusy: false,
    aiError: null,
    aiDraft: null,
    grpcModalOpen: false,
    grpcSchema: null,
    grpcFiles: [],
    grpcMethodPath: "",
    grpcAddress: "",
    grpcMessage: "{}",
    grpcVerifyTls: true,
    grpcCaPem: "",
    grpcResult: null,
    grpcBusy: null,
    grpcError: null,
    selectedModelId: null,
    runningSuiteId: null,
    consoleOpen: false,
    consoleLogs: [],
    wsSessions: {},
    mqttSessions: {},
    mqttPublish: { topic: "", payload: "", qos: 0, retain: false },
    mqttSubInput: "",
    mqttSubQos: 0,
    mqttBusy: false,
    grpcStream: null,
    grpcStreamBusy: false,
    mock: { running: false, port: null, startedAt: null, requestsServed: 0, log: [] },
    mockBusy: false,
    mockError: null,
    cloudBusy: false,
    cloudUser: null,
    cloudLoggedIn: false,
    cloudError: null,
    cloudNotice: null,
    cloudBaseUrl: "",
    cloudProjectId: null,
    cloudProjectName: null,
    cloudLastImport: null,
    cloudLastImportError: null,
    cloudPickerOpen: false,
    cloudPickerProject: null,
    cloudSpaces: null,
    cloudSpacesBusy: false,
    cloudSpacesError: null,
    cloudJustBound: null,
    cloudPullOpen: false,
    cloudConflicts: [],
    cloudConflictRecord: null,
    tcpRunning: false,
    tcpResult: null,
    tcpError: null,
    tcpEncoding: "text",
    tcpNewline: "lf",
    tcpPayload: "",
    tcpReadTimeoutMs: 2000,
    schedule: null,

    // ---- console helpers (defined before initialize so it can log) ----
    pushConsole: (entry) => {
      const item: ConsoleEntry = { ...entry, id: uid(), at: Date.now() };
      const logs = [...get().consoleLogs, item].slice(-500);
      set({ consoleLogs: logs });
    },
    clearConsole: () => set({ consoleLogs: [] }),

    initialize: async () => {
      if (runtime.initializationStarted) return;
      runtime.initializationStarted = true;
      // 重载 / 项目切换会替换整份内存快照，旧的 delta 队列必须作废，
      // 否则陈旧行会写进新项目（flushBeforeSwitch 也依赖这里兜底）。
      clearPending();
      set({ isLoading: true, loadError: null, loadStage: "cloud", loadTrace: [] });
      try {
      // Restore a persisted login before anything reads the connection state.
      // The token pair is encrypted at rest, so this decryption must complete
      // first; no network request is made, an offline backend cannot block it.
      await initializeCloudConnection();
      hydrateCloud();
      markStage("read");
      const [snapshotResult, runtimeResult, projectsResult, revResult] = await Promise.allSettled([
        api.loadWorkspace(),
        api.runtimeInfo(),
        api.listProjects(),
        api.loadWorkspaceRev(),
      ]);
      const projectsState =
        projectsResult.status === "fulfilled" ? projectsResult.value : null;
      // Make the active local project id available to hydrateCloud() before it
      // resolves the matching collaboration space. Capture the on-disk
      // revision as the optimistic-lock baseline for every later auto-save.
      set({
        projectsState,
        workspaceRev: revResult.status === "fulfilled" ? (revResult.value?.rev ?? null) : null,
        workspaceConflict: null,
      });
      // 同步通道是「本机配置 × 本地项目」，项目切换后重新投影，纯本地读取。
      void get().refreshSyncMode();

      if (snapshotResult.status === "rejected") {
        set({
          isLoading: false,
          loadError: messageOf(snapshotResult.reason),
          snapshot: emptySnapshot(),
          draft: emptyRequest(),
          projectsState,
        });
        return;
      }

      markStage("normalize");
      let snapshot = normalizeSnapshot(snapshotResult.value);
      // Migrate legacy cloud settings out of the snapshot into the connection
      // layer, then refresh the UI projection (now that projectsState is set).
      hydrateCloud(snapshot);
      const untouched =
        !snapshot.seeded &&
        snapshot.collections.length === 0 &&
        snapshot.environments.length === 0 &&
        snapshot.history.length === 0 &&
        snapshot.cases.length === 0;
      if (untouched) {
        // 必须再过一遍 normalizeSnapshot：seedSnapshot 只包含首批字段，
        // 直接入 store 会让 scriptLibrary / dbConnections / suites 等字段
        // 变成 undefined，SettingsModal 等组件的 `?? []` 选择器每次渲染都
        // 返回新数组，触发 useSyncExternalStore 无限重渲染（React #185），
        // 表现为数据目录为空时启动白屏。
        snapshot = normalizeSnapshot(seedSnapshot());
        try {
          await api.saveWorkspace(snapshot);
        } catch {
          // First-run seeding is best effort; the user can still work in memory.
        }
      }

      // 历史默认上限只有 5 MiB，而真实项目（用例 + 历史）轻松超过 25 MiB；
      // 加上 set_workspace_limit 之前根本没注册，设置页调高也不生效，自动保存
      // 一直报「无权限」。启动时把陈旧的 5 MiB 抬到至少 64 MiB / 当前快照的
      // 1.5 倍，并同步给 Rust 存储层。只改内存中的 settings，不触发 persist，
      // 避免启动时额外写一次全量快照；下次正常编辑会随快照落盘。
      const MIB = 1024 * 1024;
      const LEGACY_CAP = 5 * MIB;
      const MIN_CAP = 64 * MIB;
      const configured = snapshot.settings?.maxWorkspaceBytes;
      if (typeof configured === "number" && configured <= LEGACY_CAP) {
        const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
        const raised = Math.max(MIN_CAP, Math.ceil((bytes * 1.5) / MIB) * MIB);
        snapshot = {
          ...snapshot,
          settings: { ...(snapshot.settings ?? {}), maxWorkspaceBytes: raised },
        };
      }
      // 设置页配置的快照存储上限同步到本地 SQLite 存储层（best-effort：
      // 浏览器 / 测试环境没有 Tauri invoke，失败静默）。
      void api
        .setWorkspaceLimit(snapshot.settings?.maxWorkspaceBytes ?? MIN_CAP)
        .catch(() => {});

      const firstCollection = snapshot.collections[0];
      const firstRequest = firstCollection?.items[0];
      markStage("ready");
      set({
        snapshot,
        projectsState,
        runtime:
          runtimeResult.status === "fulfilled" ? runtimeResult.value : null,
        draft: firstRequest ? clone(firstRequest) : emptyRequest(),
        activeTab: firstRequest ? { kind: "request", id: firstRequest.id } : null,
        activeCollectionId: firstCollection?.id ?? null,
        tabs: firstRequest ? [{ kind: "request", id: firstRequest.id }] : [],
        isLoading: false,
      });
      } catch (error) {
        // A malformed row or a failed migration must never leave the WebView
        // behind an eternal "loading workspace" overlay. Surface the reason
        // and keep the app usable so the user can fix/delete the bad data.
        console.error("workspace.initialize failed", error);
        markStage("error");
        set({
          isLoading: false,
          loadError: messageOf(error),
          snapshot: emptySnapshot(),
          draft: emptyRequest(),
          projectsState: null,
        });
      }
    },

    /** Re-load the active project in place — never reload the WebView, which
     * goes blank in Tauri dev until the window is reopened. */
    reinitialize: async (options) => {
      if (runtime.persistTimer) {
        clearTimeout(runtime.persistTimer);
        runtime.persistTimer = undefined;
      }
      runtime.initializationStarted = false;
      set({
        isLoading: true,
        loadError: null,
        loadStage: "cloud",
        loadTrace: [],
        // 切换数据目录（keepModals）时保留设置弹窗：目录变更只是同一项目的
        // 存储位置变化，关闭弹窗会打断正在进行的协作空间绑定等流程。
        ...(options?.keepModals
          ? {}
          : { settingsModalOpen: false, aboutModalOpen: false }),
        response: null,
        scriptOutcome: null,
        sse: emptySseState(),
        sendError: null,
        consoleLogs: [],
        activeTab: null,
        tabs: [],
        activeCollectionId: null,
        // Cloud connection state is app-global (localStorage), not tied to a
        // project snapshot; initialize() re-reads it and resolves the space
        // that belongs to the newly selected local project.
        cloudError: null,
        cloudNotice: null,
        workspaceRev: null,
        workspaceConflict: null,
        saveError: null,
      });
      await get().initialize();
    },

    /** Resolve a stale-snapshot conflict. "reload" discards unsaved local
     * edits and re-reads the project (keeping the MCP / CLI write);
     * "overwrite" first takes the existing on-disk backup, then forces the
     * local snapshot through, so the previous state stays recoverable. */
    resolveWorkspaceConflict: async (mode) => {
      if (runtime.persistTimer) {
        clearTimeout(runtime.persistTimer);
        runtime.persistTimer = undefined;
      }
      if (mode === "reload") {
        await get().reinitialize();
        return;
      }
      try {
        await api.backupWorkspace("before-force-overwrite");
        const rev = await api.saveWorkspace(get().snapshot, { force: true });
        // 整份强写覆盖磁盘全部行，pending 队列一并作废（失败则保留待重试）。
        clearPending();
        set({
          workspaceRev: rev?.rev ?? null,
          workspaceConflict: null,
          saveError: null,
        });
      } catch (error) {
        set({
          saveError: t("store.save.conflictOverwriteFailed", { message: messageOf(error) }),
        });
      }
    },

    refreshProjects: async () => {
      try {
        set({ projectsState: await api.listProjects() });
      } catch {
        // Browser-only dev or transient failure: keep the previous state.
      }
    },

    switchProject: async (id) => {
      if (id === get().projectsState?.activeProjectId) return;
      await flushBeforeSwitch();
      set({ projectsState: await api.switchProject(id) });
      await get().reinitialize();
    },

    createProject: async (name) => {
      await flushBeforeSwitch();
      set({ projectsState: await api.createProject(name) });
      await get().reinitialize();
    },

    renameProject: async (id, name) => {
      set({ projectsState: await api.renameProject(id, name) });
    },

    setDataRoot: async (root) => {
      await flushBeforeSwitch();
      set({ projectsState: await api.setDataRoot(root) });
      // 切换的是全局数据根目录：只换存储位置，保留弹窗上下文。
      await get().reinitialize({ keepModals: true });
    },

    setDraft: (patch) => {
      // Frozen centre tabs (an execution run or a saved revision) show a
      // snapshot. No editor control may write back into them, even if a
      // disabled control somehow fires; sending / load-testing still read
      // the draft as usual.
      const kind = get().activeTab?.kind;
      if (kind === "history" || kind === "revision") return;
      set({ draft: { ...get().draft, ...patch } });
    },

    setDetailTab: (tab) => set({ detailTab: tab }),

  };
};
