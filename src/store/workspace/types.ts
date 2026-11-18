export type LoadStage = "cloud" | "read" | "normalize" | "ready" | "error";

export interface LoadTraceEntry {
  stage: LoadStage;
  at: number;
}

import { ApiClientError } from "../../lib/api.ts";
import type { SyncMode } from "../../lib/appConfig.ts";
import type { GitSyncConflict, GitSyncStatus } from "../../lib/gitNative.ts";
import type { CloudProject, CloudUser } from "../../lib/cloud.ts";
import type { CloudImportRecord } from "../../lib/cloudConnection.ts";
import type { SyncConflictRecord } from "../../lib/cloudSync.ts";
import type { DropTarget } from "../../lib/collectionTree.ts";
import type { RequestRef } from "../../lib/collectionTree.ts";
import type { ExportFormatId } from "../../lib/exportFormats.ts";
import type { ImportTarget } from "../../lib/importTarget.ts";
import type { ImportSummary } from "../../lib/importTarget.ts";
import type { GqlSchema } from "../../lib/graphql.ts";
import type { ApiCase } from "../../types.ts";
import type { AuthSpec } from "../../types.ts";
import type { BenchmarkReport } from "../../types.ts";
import type { CodeTemplate } from "../../types.ts";
import type { ConsoleEntry } from "../../types.ts";
import type { DataModel } from "../../types.ts";
import type { DetailTab } from "../../types.ts";
import type { DocPage } from "../../types.ts";
import type { DocPageGroup } from "../../types.ts";
import type { DownloadResult } from "../../types.ts";
import type { HistoryCursor } from "../../types.ts";
import type { HistoryEntry } from "../../types.ts";
import type { HistoryRunKind } from "../../types.ts";
import type { HistoryRunRecord } from "../../types.ts";
import type { HistoryRunSummary } from "../../types.ts";
import type { HistoryStats } from "../../types.ts";
import type { KeyValue } from "../../types.ts";
import type { MockRule } from "../../types.ts";
import type { MockStatus } from "../../types.ts";
import type { MqttSpec } from "../../types.ts";
import type { MqttSessionState } from "../../types.ts";
import type { GrpcStreamState } from "../../types.ts";
import type { OpenTab } from "../../types.ts";
import type { McpCallOutcome } from "../../types.ts";
import type { McpConnectResult } from "../../types.ts";
import type { McpServerConfig } from "../../types.ts";
import type { GrpcFileRef } from "../../types.ts";
import type { GrpcSchema } from "../../types.ts";
import type { GrpcInvokeResult } from "../../types.ts";
import type { ParamMeta } from "../../types.ts";
import type { RequestDoc } from "../../types.ts";
import type { RequestDraft } from "../../types.ts";
import type { RequestRevision } from "../../types.ts";
import type { ProjectsState } from "../../types.ts";
import type { ResponseData } from "../../types.ts";
import type { ResponseExample } from "../../types.ts";
import type { ResponseParam } from "../../types.ts";
import type { ResponseParamLocation } from "../../types.ts";
import type { SaveResponseExampleResult } from "../../types.ts";
import type { RuntimeInfo } from "../../types.ts";
import type { ScenarioStep } from "../../types.ts";
import type { ScriptOutcome } from "../../types.ts";
import type { ScriptSnippet } from "../../types.ts";
import type { NamedDbConnection } from "../../types.ts";
import type { SseMergeConfig } from "../../types.ts";
import type { SseState } from "../../types.ts";
import type { TestScenario } from "../../types.ts";
import type { TestSuite } from "../../types.ts";
import type { Theme } from "../../types.ts";
import type { WorkspaceSettings } from "../../types.ts";
import type { WorkspaceSnapshot } from "../../types.ts";
import type { WsSessionState } from "../../types.ts";
import type { TcpDebugResult } from "../../types.ts";

/** Options for a single send. Download runs keep their response out of history. */
export interface SendRunOptions {
  download?: boolean;
}

/** A frozen revision plus the request it belongs to, cached for read-only tabs. */
export interface RevisionTabRecord {
  requestId: string;
  revision: RequestRevision;
}

interface WorkspaceShape {
  snapshot: WorkspaceSnapshot;
  runtime: RuntimeInfo | null;
  /** Local projects: the active one decides where workspace data lives. */
  projectsState: ProjectsState | null;
  draft: RequestDraft;
  /** Centre tabs; a tab is either an interface (request) or a case. */
  tabs: OpenTab[];
  activeTab: OpenTab | null;
  /** Which sub-tab the interface detail shows (Apifox: 文档/编辑/调试/用例/Mock). */
  detailTab: DetailTab;
  /** Case ids with a run in flight (for the progress dots in the case list). */
  runningCaseIds: string[];
  /** Scenario id with a run in flight (scenarios run one at a time). */
  runningScenarioId: string | null;
  activeCollectionId: string | null;
  response: ResponseData | null;
  scriptOutcome: ScriptOutcome | null;
  sse: SseState;

  // ---- 统一执行历史（独立本地加密 SQLite，绝不在工作区快照里） ----
  historyRuns: HistoryRunSummary[];
  historyDetail: HistoryRunRecord | null;
  historySelectedId: string | null;
  historyLoading: boolean;
  historyError: string | null;
  historyStats: HistoryStats | null;
  historyKind: HistoryRunKind | "all";
  historyLoaded: boolean;
  /** Search term pushed down to Rust; never filters only the loaded page. */
  historySearch: string;
  /** Keyset cursor for the next page; null means the list is exhausted. */
  historyCursor: HistoryCursor | null;
  historyHasMore: boolean;
  historyLoadingMore: boolean;
  /** Decrypted run records backing read-only `history` centre tabs. */
  historyTabRecords: Record<string, HistoryRunRecord>;
  /** Open (or focus) one run as a frozen, still-sendable interface tab. */
  openHistoryRunTab: (id: string) => Promise<void>;
  loadHistory: () => Promise<void>;
  loadMoreHistory: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  setHistorySearch: (needle: string) => void;
  selectHistoryRun: (id: string | null) => Promise<void>;
  appendHistory: (record: HistoryRunRecord) => void;
  deleteHistoryRun: (id: string) => Promise<void>;
  clearHistoryRuns: (scope: "project" | "all") => Promise<void>;
  setHistoryKind: (kind: HistoryRunKind | "all") => void;

  isSending: boolean;
  isLoading: boolean;
  loadError: string | null;
  /** Current stage of workspace initialization, surfaced in the loading
   * overlay so a hung step can be identified without a debugger. */
  loadStage: LoadStage;
  /** Timestamped stage transitions for the same diagnostic purpose. */
  loadTrace: LoadTraceEntry[];
  sendError: ApiClientError | null;
  /** Last "send and download" outcome; these runs are never written to history. */
  downloadResult: DownloadResult | null;
  downloadError: string | null;
  clearDownload: () => void;
  saveError: string | null;
  /** Optimistic-lock revision of workspace.db, captured when the project loads.
   * Every auto-save passes it as `expectedRev` so a stale in-memory snapshot
   * cannot silently overwrite an out-of-process MCP / CLI write. */
  workspaceRev: number | null;
  /** Error message while a save was rejected as stale. Auto-save is paused
   * until the user reloads (keep external changes) or backs up + overwrites. */
  workspaceConflict: string | null;
  resolveWorkspaceConflict: (mode: "reload" | "overwrite") => Promise<void>;
  abortController: AbortController | null;
  environmentModalOpen: boolean;
  settingsModalOpen: boolean;
  aboutModalOpen: boolean;
  importExportModalOpen: boolean;
  searchModalOpen: boolean;
  trashModalOpen: boolean;
  /** Bottom console panel visibility (Apifox 风格控制台）。 */
  consoleOpen: boolean;
  consoleLogs: ConsoleEntry[];
  /** Active WS sessions keyed by request id (one live session per interface). */
  wsSessions: Record<string, WsSessionState>;
  /** MQTT 3.1.1 / 5.0 sessions, keyed by request id. */
  mqttSessions: Record<string, MqttSessionState>;
  mqttPublish: { topic: string; payload: string; qos: 0 | 1 | 2; retain: boolean };
  mqttSubInput: string;
  mqttSubQos: 0 | 1 | 2;
  mqttBusy: boolean;
  /** Live gRPC client / bidi streaming session (one at a time). */
  grpcStream: GrpcStreamState | null;
  grpcStreamBusy: boolean;
  /** Local mock server status; polled while running. */
  mock: MockStatus;
  mockBusy: boolean;
  mockError: string | null;

  initialize: () => Promise<void>;
  /** Re-load the active project's snapshot without reloading the WebView. */
  reinitialize: (options?: { keepModals?: boolean }) => Promise<void>;
  refreshProjects: () => Promise<void>;
  switchProject: (id: string) => Promise<void>;
  createProject: (name: string) => Promise<void>;
  /** 重命名本地项目（拉取协作空间时让本地项目带上空间名）。 */
  renameProject: (id: string, name: string) => Promise<void>;
  setDataRoot: (root: string | null) => Promise<void>;
  setDraft: (patch: Partial<RequestDraft>) => void;
  setDetailTab: (tab: DetailTab) => void;
  selectRequest: (collectionId: string, request: RequestDraft) => void;
  loadFromHistory: (entry: HistoryEntry) => void;
  newRequest: (collectionId?: string) => void;
  saveRequest: () => void;
  deleteRequest: (collectionId: string, requestId: string) => void;
  addCollection: () => void;
  renameCollection: (id: string, name: string) => void;
  /** 集合级鉴权：请求把 auth 设为 inherit 时生效。 */
  setCollectionAuth: (id: string, auth: AuthSpec) => void;
  deleteCollection: (id: string) => void;
  addEnvironment: () => void;
  renameEnvironment: (id: string, name: string) => void;
  deleteEnvironment: (id: string) => void;
  duplicateEnvironment: (id: string) => void;
  updateEnvironmentVariables: (id: string, variables: KeyValue[]) => void;
  updateEnvironmentHeaders: (id: string, headers: KeyValue[]) => void;
  mergeEnvironments: (
    sourceId: string,
    targetId: string,
    selection: { variableKeys: string[]; headerKeys: string[]; overwrite: boolean },
  ) => void;
  setActiveEnvironment: (id: string | null) => void;
  addCodeTemplate: () => void;
  addBuiltinCodeTemplates: () => void;
  updateCodeTemplate: (id: string, patch: Partial<Omit<CodeTemplate, "id">>) => void;
  deleteCodeTemplate: (id: string) => void;
  /** 公共文档章节：鉴权 / 流程 / 错误码 / 更新日志，随工作区持久化并参与云同步。 */
  addDocPage: (group?: DocPageGroup) => void;
  addBuiltinDocPages: () => void;
  updateDocPage: (id: string, patch: Partial<Omit<DocPage, "id">>) => void;
  deleteDocPage: (id: string) => void;
  moveDocPage: (id: string, delta: -1 | 1) => void;
  setDocPages: (pages: DocPage[]) => void;
  /** 全局公共文档编辑器：openDocPages(id) 可在打开时聚焦指定章节。 */
  docPagesModalOpen: boolean;
  docPagesFocusId: string | null;
  openDocPages: (id?: string | null) => void;
  closeDocPages: () => void;
  clearHistory: () => void;
  updateSettings: (patch: Partial<WorkspaceSettings>) => void;
  setEnvironmentModalOpen: (open: boolean) => void;
  setSettingsModalOpen: (open: boolean) => void;
  setAboutModalOpen: (open: boolean) => void;
  setImportExportModalOpen: (open: boolean) => void;
  setSearchModalOpen: (open: boolean) => void;
  setTrashModalOpen: (open: boolean) => void;
  setConsoleOpen: (open: boolean) => void;
  pushConsole: (entry: Omit<ConsoleEntry, "id" | "at">) => void;
  clearConsole: () => void;
  openTab: (tab: OpenTab) => void;
  closeTab: (tab: OpenTab) => void;
  /** 关闭除给定标签页以外的全部标签页。 */
  closeOtherTabs: (tab: OpenTab) => void;
  /** 关闭给定标签页左侧的全部标签页。 */
  closeTabsToLeft: (tab: OpenTab) => void;
  /** 关闭给定标签页右侧的全部标签页。 */
  closeTabsToRight: (tab: OpenTab) => void;
  /** 关闭全部标签页。 */
  closeAllTabs: () => void;
  setTheme: (theme: Theme) => void;
  setSseMergeConfig: (patch: Partial<SseMergeConfig>) => void;
  remergeSse: () => void;
  /** `download: true` saves the full response to a file and skips history. */
  send: (options?: SendRunOptions) => Promise<void>;
  cancelSend: () => void;
  resetWorkspace: () => Promise<void>;
  dismissLoadError: () => void;
  dismissSaveError: () => void;
  /** Retry a failed workspace save immediately, without waiting for an edit. */
  retrySave: () => Promise<void>;

  // ---- cases (Apifox 单接口用例) ----
  addCase: (requestId: string, name?: string, group?: ApiCase["group"]) => string | null;
  updateCase: (id: string, patch: Partial<ApiCase>) => void;
  deleteCase: (id: string) => void;
  duplicateCase: (id: string) => void;
  syncCase: (id: string) => void;
  runCase: (id: string) => Promise<void>;
  runCases: (ids: string[]) => Promise<void>;
  saveDraftAsCase: (name?: string) => string | null;

  // ---- documentation (projection of the interface definition) ----
  updateDoc: (patch: Partial<RequestDoc>) => void;
  updateParamMeta: (key: string, patch: Partial<ParamMeta>) => void;
  /**
   * 把最近一次响应保存为返回示例：每次点击都会新增一条，字段说明沿用已有示例；
   * 数据（状态码 + key/value）与已有示例完全一致时不重复入档。
   */
  saveResponseExample: (name?: string) => SaveResponseExampleResult;
  /** 把当前响应（通常是用例运行结果）保存为其所属接口的返回示例。 */
  saveCaseResponseExample: (caseId: string) => SaveResponseExampleResult;
  updateResponseExample: (id: string, patch: Partial<ResponseExample>) => void;
  deleteResponseExample: (id: string) => void;
  /** Response field docs are per-example (different statuses have different shapes). */
  addResponseParam: (exampleId: string, location?: ResponseParamLocation) => void;
  updateResponseParam: (exampleId: string, paramId: string, patch: Partial<ResponseParam>) => void;
  deleteResponseParam: (exampleId: string, paramId: string) => void;
  /** Seed/refresh the field table from the example body; keeps user annotations. Returns new rows. */
  generateResponseParams: (exampleId: string) => number;
  /** Bind a data model to a request without requiring it to be the open tab. */
  bindDataModel: (
    requestId: string,
    target: "request" | "response",
    modelId: string | null,
  ) => void;

  // ---- test scenarios (cross-interface chains with a shared variable table) ----
  addScenario: (name?: string) => string;
  updateScenario: (id: string, patch: Partial<TestScenario>) => void;
  deleteScenario: (id: string) => void;
  duplicateScenario: (id: string) => void;
  addScenarioStepFromCase: (scenarioId: string, caseId: string) => void;
  addScenarioStepFromDraft: (scenarioId: string) => void;
  addScenarioDbStep: (scenarioId: string) => void;
  addScenarioWaitStep: (scenarioId: string) => void;
  updateScenarioStep: (scenarioId: string, stepId: string, patch: Partial<ScenarioStep>) => void;
  deleteScenarioStep: (scenarioId: string, stepId: string) => void;
  moveScenarioStep: (scenarioId: string, stepId: string, direction: -1 | 1) => void;
  runScenario: (id: string) => Promise<void>;

  // ---- 数据模型（JSON Schema 复用层） ----
  /** 当前在「数据模型」视图打开的模型 id。 */
  selectedModelId: string | null;
  selectModel: (id: string | null) => void;
  upsertDataModel: (model: DataModel) => void;
  deleteDataModel: (id: string) => void;

  // ---- 测试套件（P0-4） ----
  runningSuiteId: string | null;
  addSuite: (name?: string) => string;
  updateSuite: (id: string, patch: Partial<TestSuite>) => void;
  deleteSuite: (id: string) => void;
  addSuiteItem: (suiteId: string, kind: "case" | "scenario", refId: string) => void;
  removeSuiteItem: (suiteId: string, itemId: string) => void;
  runSuite: (id: string) => Promise<void>;

  // ---- 接口变更历史（P1-7） ----
  /** Frozen revision snapshots backing read-only `revision` centre tabs. */
  revisionTabRecords: Record<string, RevisionTabRecord>;
  /** Open (or focus) one saved revision as a frozen, still-sendable interface tab. */
  openRevisionTab: (revisionId: string) => void;
  revertRequestToRevision: (requestId: string, revisionId: string) => void;
  clearRequestRevisions: (requestId: string) => void;

  // ---- 脚本库（P1-8） ----
  addScriptSnippet: (snippet: { name: string; description: string; code: string }) => void;
  updateScriptSnippet: (id: string, patch: Partial<ScriptSnippet>) => void;
  deleteScriptSnippet: (id: string) => void;

  // ---- 全局命名数据库连接（P2-13）----
  saveDbConnections: (connections: NamedDbConnection[]) => void;

  // ---- 场景定时运行（P2-14）----
  /** null = 未启用；非空 = 每 intervalSecs 自动跑一次该场景（会话内有效）。 */
  schedule: { scenarioId: string; intervalSecs: number; timer: number } | null;
  startScenarioSchedule: (scenarioId: string, intervalSecs: number) => void;
  stopScenarioSchedule: () => void;

  // ---- WebSocket debugging ----
  connectWs: () => Promise<void>;
  sendWsMessage: (text: string) => Promise<void>;
  closeWs: () => Promise<void>;
  clearWsTimeline: () => void;

  // ---- MQTT 3.1.1 / 5.0 ----
  setMqttDraft: (patch: Partial<MqttSpec>) => void;
  setMqttPublish: (
    patch: Partial<{ topic: string; payload: string; qos: 0 | 1 | 2; retain: boolean }>,
  ) => void;
  setMqttSubInput: (value: string) => void;
  setMqttSubQos: (qos: 0 | 1 | 2) => void;
  connectMqtt: () => Promise<void>;
  disconnectMqtt: () => Promise<void>;
  publishMqtt: () => Promise<void>;
  subscribeMqtt: () => Promise<void>;
  unsubscribeMqtt: (topic: string) => Promise<void>;
  clearMqttTimeline: () => void;

  // ---- TCP raw socket debugging ----
  tcpRunning: boolean;
  tcpResult: TcpDebugResult | null;
  tcpError: string | null;
  tcpEncoding: "text" | "hex";
  tcpNewline: "none" | "lf" | "crlf";
  tcpPayload: string;
  tcpReadTimeoutMs: number;
  runTcpDebug: () => Promise<void>;
  setTcpPayload: (payload: string) => void;
  setTcpEncoding: (encoding: "text" | "hex") => void;
  setTcpNewline: (newline: "none" | "lf" | "crlf") => void;
  setTcpReadTimeoutMs: (ms: number) => void;
  clearTcpResult: () => void;

  // ---- 云端协作：只配置地址 + 一次性登录 + 按行双向同步 ----
  // 连接配置（地址 / token / 协作空间 / 同步记录）存在 WebView localStorage，
  // 不进入 snapshot，因此不会随本地工作区保存，也不会被同步上传。
  cloudBusy: boolean;
  cloudUser: CloudUser | null;
  /** 是否持有持久化的 token（重启后仍为 true，无需再次登录）。 */
  cloudLoggedIn: boolean;
  cloudError: string | null;
  cloudNotice: string | null;
  cloudBaseUrl: string;
  /** 当前本地项目对应的协作空间，自动解析，无需用户手填项目 ID。 */
  cloudProjectId: number | null;
  cloudProjectName: string | null;
  /** 首次同步（未绑定协作空间）时弹出选择框。 */
  cloudPickerOpen: boolean;
  /** 触发选择框的本地项目（id + 名称），供弹窗展示与预填。 */
  cloudPickerProject: { id: string; name: string } | null;
  /** 云端可选协作空间列表（登录用户可见的）。 */
  cloudSpaces: CloudProject[] | null;
  cloudSpacesBusy: boolean;
  cloudSpacesError: string | null;
  /** 本次同步刚完成的绑定方式，用于通知文案，用完即清。 */
  cloudJustBound: "created" | "bound" | null;
  /** 「从协作空间拉取项目」弹窗（新建本地项目 + 下载云端数据）。 */
  cloudPullOpen: boolean;
  /** 当前本地项目待裁决的同步冲突（双方都修改过的行，精简展示字段）。 */
  cloudConflicts: Array<{ domain: string; id: string; name: string }>;
  /** 完整冲突明细（含 base / local / remote 三份行），供字段级合并弹窗使用。 */
  cloudConflictRecord: SyncConflictRecord | null;

  // ---- 同步通道：本地 / 服务端协作 / Git-native（按本地项目选择） ----
  syncMode: SyncMode;
  gitSyncDir: string;
  gitAutoPull: boolean;
  gitBusy: boolean;
  gitError: string | null;
  gitNotice: string | null;
  gitLastSyncAt: number | null;
  gitConflicts: GitSyncConflict[];
  /** 用户对冲突行的裁决暂存：key = `${domain}:${id}`。 */
  gitResolutions: Record<string, "local" | "git">;
  gitStatus: GitSyncStatus | null;
  syncConverting: boolean;
  refreshSyncMode: () => Promise<void>;
  setSyncMode: (mode: SyncMode) => Promise<void>;
  setGitSyncDir: (dir: string) => Promise<void>;
  pickGitSyncDir: () => Promise<void>;
  setGitAutoPull: (value: boolean) => Promise<void>;
  refreshGitStatus: () => Promise<void>;
  gitSyncNow: (options?: {
    pull?: boolean;
    commit?: boolean;
    push?: boolean;
    message?: string;
  }) => Promise<void>;
  gitResolveConflict: (domain: string, id: string, choice: "local" | "git") => void;
  gitApplyResolutions: () => Promise<void>;
  convertSyncChannel: (target: "git" | "server") => Promise<void>;
  syncAutoTick: () => Promise<void>;

  setCloudPickerOpen: (open: boolean) => void;
  setCloudPullOpen: (open: boolean) => void;
  cloudLoadSpaces: () => Promise<void>;
  /** 把当前本地项目绑定到一个已有协作空间，然后立即执行一次同步。 */
  cloudBindSpace: (spaceId: number) => Promise<void>;
  /** 选一个云端空间 → 新建同名本地项目 → 绑定 → 仅下载全量数据。 */
  cloudPullProject: (spaceId: number, localName: string) => Promise<void>;
  /** 新建协作空间并绑定到当前本地项目，然后立即执行一次同步。 */
  cloudCreateAndBindSpace: (name: string, slug: string) => Promise<void>;
  /** 解除当前本地项目与协作空间的绑定（下次同步会重新弹选择框）。 */
  cloudUnbindProject: () => void;
  /** 裁决一条同步冲突：useLocal=以上传本地版本为准；useCloud=以云端版本写回本地。 */
  cloudResolveConflict: (domain: string, id: string, useLocal: boolean) => Promise<void>;
  /**
   * 字段级合并裁决：`mergedRow` 是弹窗按用户选择合成的完整行；null 表示
   * 跟随云端删除。合成行会打新时间戳、回填本地凭据，作为普通本地变更上传。
   */
  cloudResolveConflictWithMerge: (
    domain: string,
    id: string,
    mergedRow: Record<string, unknown> | null,
  ) => Promise<void>;
  /** 自动同步心跳：条件不满足时静默跳过（未登录 / 未绑定 / 弹窗打开 / 忙碌）。 */
  cloudAutoSyncTick: () => Promise<void>;
  cloudLastImport: CloudImportRecord | null;
  cloudLastImportError: string | null;
  setCloudBaseUrl: (url: string) => void;
  cloudLogin: (username: string, password: string) => Promise<void>;
  cloudLogout: () => void;
    /**
     * 与协作空间按行双向同步：本地行 vs 云端行逐条按 updatedAt 胜出，
     * 本地获胜的行脱敏后上传，云端获胜的行合并回本地共享域。
     * 本机域（历史 / 回收站 / dbConnections / mcpServers / theme / 本机凭据）
     * 永不参与同步。
     */
    cloudImport: (options?: { downloadOnly?: boolean }) => Promise<void>;

  // ---- Mock server ----
  startMock: (port: number) => Promise<void>;
  stopMock: () => Promise<void>;
  refreshMockStatus: () => Promise<void>;
  getMockRules: () => MockRule[];

  // ---- Import / export ----
  /** Optional target keeps the two-argument call (scripted / legacy) working. */
  /** Returns null when parsing failed; otherwise a merge summary for the dialog. */
  importContent: (content: string, sourceLabel?: string, target?: ImportTarget) => ImportSummary | null;
  /** 格式与版本由 exportFormats.ts 的注册表统一定义；渲染统一走 redact.ts 脱敏出口。 */
  exportAs: (format: ExportFormatId, password?: string) => Promise<void>;

  // ---- Collection tree (nested folders + reorder) ----
  moveRequest: (collectionId: string, requestId: string, folder: string) => void;
  /** Drag & drop: change folder, collection AND array order in one atomic write. */
  moveRequestTo: (source: RequestRef, target: DropTarget) => void;
  /** Drag a whole folder (with all descendants) into another folder / collection. */
  moveFolderTo: (
    source: { collectionId: string; path: string },
    target: { collectionId: string; folder: string },
  ) => void;
  /**
   * Rename a request: bumps row-level `updatedAt` (so the rename syncs) but
   * not `contentUpdatedAt`, so cases are not marked stale.
   */
  renameRequest: (requestId: string, name: string) => void;
  duplicateRequest: (collectionId: string, requestId: string) => void;
  renameFolder: (collectionId: string, from: string, to: string) => void;
  /**
   * 显式新建（可能为空的）文件夹；多层级路径（"a/b/c"）连同祖先一起登记。
   * 含接口的文件夹由请求的 folder 路径派生，无需先建。
   */
  createFolder: (collectionId: string, path: string) => void;
  /**
   * 删除文件夹：显式登记项与子孙路径一并移除，其中的接口上移到父文件夹
   * （根文件夹的接口回到集合根目录），不进回收站、不删接口。
   */
  deleteFolder: (collectionId: string, path: string) => void;

  // ---- Recycle bin ----
  restoreFromTrash: (entryId: string) => void;
  deleteTrashEntry: (entryId: string) => void;
  emptyTrash: () => void;

  // ---- Benchmark ----
  benchmarkModalOpen: boolean;
  benchmarkRunning: boolean;
  benchmarkReport: BenchmarkReport | null;
  benchmarkError: string | null;
  setBenchmarkModalOpen: (open: boolean) => void;
  runBenchmark: (total: number, concurrency: number) => Promise<void>;

  // ---- GraphQL introspection ----
  introspecting: boolean;
  introspectionError: string | null;
  introspectionSchema: GqlSchema | null;
  introspect: () => Promise<void>;
  clearIntrospection: () => void;

  // ---- MCP 服务器 ----
  mcpModalOpen: boolean;
  /** Live connections: server name -> tools discovered at connect time. */
  mcpConnections: Record<string, McpConnectResult>;
  /** Server name with a connect/call in flight (drives busy states). */
  mcpBusy: string | null;
  mcpError: string | null;
  mcpCallResult: { server: string; tool: string; outcome: McpCallOutcome } | null;
  setMcpModalOpen: (open: boolean) => void;
  saveMcpServers: (servers: McpServerConfig[]) => void;
  mcpConnect: (config: McpServerConfig) => Promise<boolean>;
  mcpDisconnect: (name: string) => Promise<void>;
  mcpCallTool: (server: string, tool: string, args: Record<string, unknown>) => Promise<void>;
  clearMcpCallResult: () => void;

  // ---- AI 生成接口 ----
  aiModalOpen: boolean;
  aiBusy: boolean;
  aiError: string | null;
  aiDraft: RequestDraft | null;
  setAiModalOpen: (open: boolean) => void;
  aiGenerate: (description: string) => Promise<boolean>;
  importAiDraft: (collectionId?: string | null) => void;
  discardAiDraft: () => void;

  // ---- gRPC 调试 ----
  grpcModalOpen: boolean;
  grpcSchema: GrpcSchema | null;
  /** 已选取的 proto 文件（本次会话）。 */
  grpcFiles: GrpcFileRef[];
  /** 选中的 method 全路径：/pkg.Service/Method。 */
  grpcMethodPath: string;
  grpcAddress: string;
  grpcMessage: string;
  /** TLS 证书校验开关（默认开；关掉后自签名证书也能连）。 */
  grpcVerifyTls: boolean;
  /** 追加到根证书库的自定义 CA（PEM）。 */
  grpcCaPem: string;
  grpcResult: GrpcInvokeResult | null;
  grpcBusy: "compile" | "invoke" | "reflect" | null;
  grpcError: string | null;
  setGrpcModalOpen: (open: boolean) => void;
  pickProto: () => Promise<void>;
  grpcReflect: () => Promise<void>;
  selectGrpcMethod: (path: string) => void;
  setGrpcAddress: (address: string) => void;
  setGrpcMessage: (message: string) => void;
  setGrpcVerifyTls: (verifyTls: boolean) => void;
  setGrpcCaPem: (caPem: string) => void;
  grpcInvoke: () => Promise<void>;

  // ---- gRPC client / bidirectional streaming ----
  grpcStreamStart: () => Promise<void>;
  grpcStreamSend: (message?: string) => Promise<void>;
  grpcStreamClose: () => Promise<void>;
  grpcStreamCancel: () => Promise<void>;
}
export type CoreSlice = Pick<WorkspaceShape, "snapshot" | "runtime" | "draft" | "tabs" | "activeTab" | "detailTab" | "runningCaseIds" | "runningScenarioId" | "activeCollectionId" | "response" | "scriptOutcome" | "sse" | "projectsState" | "isSending" | "isLoading" | "loadError" | "loadStage" | "loadTrace" | "sendError" | "saveError" | "abortController" | "environmentModalOpen" | "settingsModalOpen" | "aboutModalOpen" | "importExportModalOpen" | "searchModalOpen" | "trashModalOpen" | "docPagesModalOpen" | "docPagesFocusId" | "benchmarkModalOpen" | "benchmarkRunning" | "benchmarkReport" | "benchmarkError" | "introspecting" | "introspectionError" | "introspectionSchema" | "mcpModalOpen" | "mcpConnections" | "mcpBusy" | "mcpError" | "mcpCallResult" | "aiModalOpen" | "aiBusy" | "aiError" | "aiDraft" | "grpcModalOpen" | "grpcSchema" | "grpcFiles" | "grpcMethodPath" | "grpcAddress" | "grpcMessage" | "grpcVerifyTls" | "grpcCaPem" | "grpcResult" | "grpcBusy" | "grpcError" | "selectedModelId" | "runningSuiteId" | "consoleOpen" | "consoleLogs" | "wsSessions" | "mock" | "mockBusy" | "mockError" | "cloudBusy" | "cloudUser" | "cloudLoggedIn" | "cloudError" | "cloudNotice" | "cloudBaseUrl" | "cloudProjectId" | "cloudProjectName" | "cloudLastImport" | "cloudLastImportError" | "cloudPickerOpen" | "cloudPickerProject" | "cloudSpaces" | "cloudSpacesBusy" | "cloudSpacesError" | "cloudJustBound" | "cloudPullOpen" | "cloudConflicts" | "cloudConflictRecord" | "tcpRunning" | "tcpResult" | "tcpError" | "tcpEncoding" | "tcpNewline" | "tcpPayload" | "tcpReadTimeoutMs" | "schedule" | "pushConsole" | "clearConsole" | "initialize" | "reinitialize" | "refreshProjects" | "switchProject" | "createProject" | "renameProject" | "setDataRoot" | "setDraft" | "setDetailTab" | "mqttSessions" | "mqttPublish" | "mqttSubInput" | "mqttSubQos" | "mqttBusy" | "grpcStream" | "grpcStreamBusy" | "workspaceRev" | "workspaceConflict" | "resolveWorkspaceConflict">;
export type CollectionsSlice = Pick<WorkspaceShape, "selectRequest" | "loadFromHistory" | "newRequest" | "saveRequest" | "deleteRequest" | "addCollection" | "createFolder" | "deleteFolder" | "renameCollection" | "setCollectionAuth" | "deleteCollection">;
export type EnvironmentsSlice = Pick<WorkspaceShape, "addEnvironment" | "renameEnvironment" | "deleteEnvironment" | "updateEnvironmentVariables" | "setActiveEnvironment" | "duplicateEnvironment" | "updateEnvironmentHeaders" | "mergeEnvironments" | "addCodeTemplate" | "addBuiltinCodeTemplates" | "updateCodeTemplate" | "deleteCodeTemplate" | "addDocPage" | "addBuiltinDocPages" | "updateDocPage" | "deleteDocPage" | "moveDocPage" | "setDocPages" | "clearHistory" | "updateSettings">;
export type DraftUiSlice = Pick<WorkspaceShape, "setEnvironmentModalOpen" | "setSettingsModalOpen" | "setAboutModalOpen" | "setTrashModalOpen" | "setBenchmarkModalOpen" | "setImportExportModalOpen" | "setSearchModalOpen" | "setConsoleOpen" | "openDocPages" | "closeDocPages" | "openTab" | "closeTab" | "closeOtherTabs" | "closeTabsToLeft" | "closeTabsToRight" | "closeAllTabs" | "setTheme" | "setSseMergeConfig" | "remergeSse">;
export type RequestRunSlice = Pick<WorkspaceShape, "send" | "cancelSend" | "resetWorkspace" | "dismissLoadError" | "dismissSaveError" | "retrySave" | "downloadResult" | "downloadError" | "clearDownload">;
export type CasesSlice = Pick<WorkspaceShape, "addCase" | "updateCase" | "deleteCase" | "duplicateCase" | "syncCase" | "runCase" | "runCases" | "saveDraftAsCase" | "updateDoc" | "updateParamMeta" | "saveResponseExample" | "saveCaseResponseExample" | "updateResponseExample" | "deleteResponseExample" | "addResponseParam" | "updateResponseParam" | "deleteResponseParam" | "generateResponseParams">;
export type ScenariosSlice = Pick<WorkspaceShape, "addScenario" | "updateScenario" | "deleteScenario" | "selectModel" | "upsertDataModel" | "deleteDataModel" | "bindDataModel">;
export type SuitesSlice = Pick<WorkspaceShape, "addSuite" | "updateSuite" | "deleteSuite" | "addSuiteItem" | "removeSuiteItem" | "runSuite">;
export type MiscSlice = Pick<WorkspaceShape, "revisionTabRecords" | "openRevisionTab" | "revertRequestToRevision" | "clearRequestRevisions" | "addScriptSnippet" | "updateScriptSnippet" | "deleteScriptSnippet" | "saveDbConnections" | "startScenarioSchedule" | "stopScenarioSchedule" | "restoreFromTrash" | "deleteTrashEntry" | "emptyTrash" | "runBenchmark">;
export type ProtocolsSlice = Pick<WorkspaceShape, "introspect" | "clearIntrospection" | "duplicateScenario" | "addScenarioStepFromCase" | "addScenarioDbStep" | "addScenarioWaitStep" | "addScenarioStepFromDraft" | "updateScenarioStep" | "deleteScenarioStep" | "moveScenarioStep" | "runScenario" | "connectWs" | "sendWsMessage" | "closeWs" | "clearWsTimeline" | "runTcpDebug" | "setTcpPayload" | "setTcpEncoding" | "setTcpNewline" | "setTcpReadTimeoutMs" | "clearTcpResult" | "setMqttDraft" | "setMqttPublish" | "setMqttSubInput" | "setMqttSubQos" | "connectMqtt" | "disconnectMqtt" | "publishMqtt" | "subscribeMqtt" | "unsubscribeMqtt" | "clearMqttTimeline">;
export type CloudSlice = Pick<WorkspaceShape, "setCloudBaseUrl" | "cloudLogin" | "cloudLogout" | "cloudImport" | "setCloudPickerOpen" | "setCloudPullOpen" | "cloudLoadSpaces" | "cloudBindSpace" | "cloudPullProject" | "cloudCreateAndBindSpace" | "cloudUnbindProject" | "cloudResolveConflict" | "cloudResolveConflictWithMerge" | "cloudAutoSyncTick" | "startMock" | "stopMock" | "refreshMockStatus" | "getMockRules">;
export type ImportExportSlice = Pick<WorkspaceShape, "importContent" | "exportAs" | "moveRequest" | "renameRequest" | "moveRequestTo" | "moveFolderTo" | "duplicateRequest" | "renameFolder">;
export type IntegrationsSlice = Pick<WorkspaceShape, "setMcpModalOpen" | "saveMcpServers" | "mcpConnect" | "mcpDisconnect" | "mcpCallTool" | "clearMcpCallResult" | "setAiModalOpen" | "aiGenerate" | "importAiDraft" | "discardAiDraft" | "setGrpcModalOpen" | "pickProto" | "grpcReflect" | "selectGrpcMethod" | "setGrpcAddress" | "setGrpcMessage" | "setGrpcVerifyTls" | "setGrpcCaPem" | "grpcInvoke" | "grpcStreamStart" | "grpcStreamSend" | "grpcStreamClose" | "grpcStreamCancel">;

export type HistorySlice = Pick<WorkspaceShape, "historyRuns" | "historyDetail" | "historySelectedId" | "historyLoading" | "historyError" | "historyStats" | "historyKind" | "historyLoaded" | "historySearch" | "historyCursor" | "historyHasMore" | "historyLoadingMore" | "historyTabRecords" | "openHistoryRunTab" | "loadHistory" | "loadMoreHistory" | "refreshHistory" | "selectHistoryRun" | "appendHistory" | "deleteHistoryRun" | "clearHistoryRuns" | "setHistoryKind" | "setHistorySearch">;

export type SyncModeSlice = Pick<WorkspaceShape, "syncMode" | "gitSyncDir" | "gitAutoPull" | "gitBusy" | "gitError" | "gitNotice" | "gitLastSyncAt" | "gitConflicts" | "gitResolutions" | "gitStatus" | "syncConverting" | "refreshSyncMode" | "setSyncMode" | "setGitSyncDir" | "pickGitSyncDir" | "setGitAutoPull" | "refreshGitStatus" | "gitSyncNow" | "gitResolveConflict" | "gitApplyResolutions" | "convertSyncChannel" | "syncAutoTick">;

export type WorkspaceState = CoreSlice & CollectionsSlice & EnvironmentsSlice & DraftUiSlice & RequestRunSlice & CasesSlice & ScenariosSlice & SuitesSlice & MiscSlice & ProtocolsSlice & CloudSlice & ImportExportSlice & IntegrationsSlice & HistorySlice & SyncModeSlice;
