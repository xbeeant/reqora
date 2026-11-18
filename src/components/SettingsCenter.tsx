import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Activity, Check, ChevronRight, Cloud, CloudUpload, Code, Database, ExternalLink,
  Folder, FolderOpen, Gauge, Info, Link, LogIn, LogOut, Plus, RefreshCw, RotateCcw, Save,
  Search, Send, Settings, Shield, Sparkles, Trash, Unlink, Users, X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { t, useLang, useT } from "../i18n";
import type { HttpVersion, NamedDbConnection, WorkspaceSettings } from "../types";
import {
  cloudProjectFor, isCloudServerConfigured, normalizeCloudBaseUrl,
} from "../lib/cloudConnection";
import { api } from "../lib/api";
import { runtimeStatusLabel } from "../lib/runtimeLabel.ts";
import type { SyncConflictEntry } from "../lib/cloudSync.ts";
import { OrgPanel } from "./OrgPanel";
import { CloudProjectPicker } from "./CloudProjectPicker";
import { ConflictMergeModal } from "./ConflictMergeModal";
import { SyncModePanel } from "./SyncModePanel";
import { ConfirmDialog } from "./ConfirmDialog";
import pkg from "../../package.json";

/* Navigation — grouped by function, collaboration first and default. */
type TabId =
  | "collab" | "org" | "admin" | "request" | "limits" | "ai" | "scripts"
  | "database" | "projects" | "runtime" | "danger";

interface TabDef {
  id: TabId;
  label: string;
  hint: string;
  icon: LucideIcon;
  keywords: string;
}
interface TabGroup { title: string; tabs: TabDef[] }

/* label / hint 存 i18n key，渲染时用 t() 解析；keywords 保留原文供搜索匹配。 */
const GROUPS: TabGroup[] = [
  { title: "shell.group.collab", tabs: [
    { id: "collab", label: "shell.tab.collab", hint: "shell.tabHint.collab", icon: Cloud,
      keywords: "collab cloud sync space conflict login 协作 同步 空间 冲突 后端服务 登录" },
    { id: "org", label: "shell.tab.org", hint: "shell.tabHint.org", icon: Users,
      keywords: "org organization invite member team 组织 邀请 成员 团队" },
    { id: "admin", label: "shell.tab.admin", hint: "shell.tabHint.admin", icon: Shield,
      keywords: "admin console role audit 管理端 角色 授权 审计" },
  ]},
  { title: "shell.group.request", tabs: [
    { id: "request", label: "shell.tab.request", hint: "shell.tabHint.request", icon: Send,
      keywords: "request timeout redirect tls cookie proxy http version 请求 超时 代理 证书 版本" },
    { id: "limits", label: "shell.tab.limits", hint: "shell.tabHint.limits", icon: Gauge,
      keywords: "limit size response body spool storage mib bytes 上限 大小 存储 截断" },
    { id: "ai", label: "shell.tab.ai", hint: "shell.tabHint.ai", icon: Sparkles,
      keywords: "ai openai deepseek ollama model 模型 助手 密钥" },
    { id: "scripts", label: "shell.tab.scripts", hint: "shell.tabHint.scripts", icon: Code,
      keywords: "script hook pre post snippet library 脚本 钩子 脚本库" },
    { id: "database", label: "shell.tab.database", hint: "shell.tabHint.database", icon: Database,
      keywords: "database mysql postgres connection dsn 数据库 连接串" },
  ]},
  { title: "shell.group.system", tabs: [
    { id: "projects", label: "shell.tab.projects", hint: "shell.tabHint.projects", icon: Folder,
      keywords: "project data directory workspace 项目 数据目录 切换" },
    { id: "runtime", label: "shell.tab.runtime", hint: "shell.tabHint.runtime", icon: Activity,
      keywords: "runtime version log limit 运行时 版本 日志 上限" },
    { id: "danger", label: "shell.tab.danger", hint: "shell.tabHint.danger", icon: RotateCcw,
      keywords: "danger reset workspace 危险 重置 工作区" },
  ]},
];

/** Opening Settings always lands on collaboration. */
const DEFAULT_TAB: TabId = "collab";

const SYNC_MINUTES = [
  { value: "0", label: "shell.syncOff" },
  { value: "1", label: "shell.sync1" },
  { value: "5", label: "shell.sync5" },
  { value: "15", label: "shell.sync15" },
  { value: "30", label: "shell.sync30" },
];

const HTTP_VERSIONS: { value: HttpVersion; label: string }[] = [
  { value: "auto", label: "shell.httpAuto" },
  { value: "http1", label: "shell.http1" },
  { value: "http2", label: "shell.http2" },
  { value: "http3", label: "shell.http3" },
];

const CONFLICT_DOMAIN_LABELS: Record<string, string> = {
  folders: "shell.domain.folders",
  requests: "shell.domain.requests",
  environments: "shell.domain.environments",
  cases: "shell.domain.cases",
  scenarios: "shell.domain.scenarios",
  suites: "shell.domain.suites",
  artifacts: "shell.domain.artifacts",
};

const ERROR_TEXT = (error: unknown): string =>
  error instanceof Error ? error.message : t("shell.operationFailed");

/* Draft state — only the settings saved together with the footer button.
 * Actions that read live configuration flush the draft first, so an edited
 * backend URL never silently applies to an old address. */
interface Draft {
  timeoutSecs: number;
  scriptTimeoutMs: number;
  httpVersion: HttpVersion;
  followRedirects: boolean;
  verifyTls: boolean;
  manageCookies: boolean;
  proxyUrl: string;
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
  globalPreScript: string;
  globalPostScript: string;
  autoSyncMinutes: number;
  cloudBaseUrl: string;
  /** 引擎与存储上限，UI 以 MiB 编辑，保存时换回字节。 */
  maxResponseMib: number;
  maxRequestMib: number;
  inlineMib: number;
  spoolMib: number;
  workspaceMib: number;
}

const MIB = 1024 * 1024;

/** 引擎与存储上限的默认值 / 区间（与 Rust 侧 Config 边界一致，单位 MiB）。label / hint 为 i18n key。 */
const LIMIT_FIELDS = [
  { key: "maxResponseMib" as const, label: "shell.limit.response.label", bytes: "maxResponseBytes" as const,
    def: 10, min: 0.001, max: 100,
    hint: "shell.limit.response.hint" },
  { key: "maxRequestMib" as const, label: "shell.limit.request.label", bytes: "maxRequestBodyBytes" as const,
    def: 5, min: 0.001, max: 50,
    hint: "shell.limit.request.hint" },
  { key: "inlineMib" as const, label: "shell.limit.inline.label", bytes: "inlineBodyBytes" as const,
    def: 0.25, min: 0.001, max: 8,
    hint: "shell.limit.inline.hint" },
  { key: "spoolMib" as const, label: "shell.limit.spool.label", bytes: "maxBodySpoolBytes" as const,
    def: 256, min: 1, max: 1024,
    hint: "shell.limit.spool.hint" },
  { key: "workspaceMib" as const, label: "shell.limit.workspace.label", bytes: "maxWorkspaceBytes" as const,
    def: 64, min: 1, max: 256,
    hint: "shell.limit.workspace.hint" },
];

function readDraft(): Draft {
  const state = useWorkspace.getState();
  const w = (state.snapshot?.settings ?? {}) as Partial<WorkspaceSettings>;
  return {
    timeoutSecs: w.timeoutSecs ?? 30,
    scriptTimeoutMs: w.scriptTimeoutMs ?? 2000,
    httpVersion: w.httpVersion ?? "auto",
    followRedirects: w.followRedirects ?? true,
    verifyTls: w.verifyTls ?? true,
    manageCookies: w.manageCookies ?? true,
    proxyUrl: w.proxyUrl ?? "",
    aiBaseUrl: w.aiBaseUrl ?? "",
    aiApiKey: w.aiApiKey ?? "",
    aiModel: w.aiModel ?? "",
    globalPreScript: w.globalPreScript ?? "",
    globalPostScript: w.globalPostScript ?? "",
    autoSyncMinutes: w.autoSyncMinutes ?? 5,
    // P0: never pre-fill the historical example.com placeholder. An empty
    // field keeps the collaboration entry point disabled until a real URL is
    // configured (build-time REQORA_COLLAB_SERVER_URL or typed here).
    cloudBaseUrl: state.cloudBaseUrl || "",
    maxResponseMib: (w.maxResponseBytes ?? 10 * MIB) / MIB,
    maxRequestMib: (w.maxRequestBodyBytes ?? 5 * MIB) / MIB,
    inlineMib: (w.inlineBodyBytes ?? 256 * 1024) / MIB,
    spoolMib: (w.maxBodySpoolBytes ?? 256 * MIB) / MIB,
    workspaceMib: (w.maxWorkspaceBytes ?? 64 * MIB) / MIB,
  };
}

function commit(d: Draft): void {
  const store = useWorkspace.getState();
  store.updateSettings({
    timeoutSecs: d.timeoutSecs,
    scriptTimeoutMs: d.scriptTimeoutMs,
    httpVersion: d.httpVersion,
    followRedirects: d.followRedirects,
    verifyTls: d.verifyTls,
    manageCookies: d.manageCookies,
    proxyUrl: d.proxyUrl,
    aiBaseUrl: d.aiBaseUrl,
    aiApiKey: d.aiApiKey,
    aiModel: d.aiModel,
    globalPreScript: d.globalPreScript,
    globalPostScript: d.globalPostScript,
    autoSyncMinutes: d.autoSyncMinutes,
    // 引擎与存储上限：以字节入库存；快照存储上限由 updateSettings
    // 同步到本地 SQLite 存储层，其余随请求 spec.limits 下发。
    maxResponseBytes: Math.round(d.maxResponseMib * MIB),
    maxRequestBodyBytes: Math.round(d.maxRequestMib * MIB),
    inlineBodyBytes: Math.round(d.inlineMib * MIB),
    maxBodySpoolBytes: Math.round(d.spoolMib * MIB),
    maxWorkspaceBytes: Math.round(d.workspaceMib * MIB),
  });
  // The store version also invalidates stale tokens / bindings / baselines when
  // the server changes; writing straight to localStorage would skip all of it.
  store.setCloudBaseUrl(normalizeCloudBaseUrl(d.cloudBaseUrl));
}

/* Reusable controls */
const CONTROL_CLS =
  "w-full rounded-md border border-surface-border bg-surface-muted text-[12px] text-ink outline-none transition placeholder:text-ink-faint focus:border-brand-400 focus:bg-surface focus:ring-2 focus:ring-brand-500/10";
const INPUT_CLS = `${CONTROL_CLS} h-8 px-2.5`;

function Field({ label, hint, htmlFor, children }: {
  label: string; hint?: string; htmlFor?: string; children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[142px_minmax(0,1fr)] items-start gap-4 py-2.5 max-[620px]:grid-cols-1 max-[620px]:gap-1.5">
      <div className="pt-1.5">
        <label htmlFor={htmlFor} className="block text-[12px] font-medium text-ink">{label}</label>
        {hint ? <p className="mt-0.5 text-[10.5px] leading-4 text-ink-faint">{hint}</p> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-surface-border bg-surface p-4">
      <h3 className="text-[12px] font-semibold text-ink">{title}</h3>
      {desc ? <p className="mt-1 text-[11px] leading-5 text-ink-faint">{desc}</p> : null}
      <div className="mt-2 divide-y divide-surface-border/60">{children}</div>
    </section>
  );
}

function Toggle({ checked, onChange, label }: {
  checked: boolean; onChange: (value: boolean) => void; label: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors ${
        checked ? "bg-brand-600" : "border border-surface-border bg-surface-sunken"}`}>
      <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-all ${
        checked ? "left-[16px]" : "left-[2px]"}`} />
    </button>
  );
}

function TextInput({ id, value, onChange, placeholder, type = "text", mono = false }: {
  id?: string; value: string; onChange: (value: string) => void; placeholder?: string;
  type?: "text" | "password" | "url"; mono?: boolean;
}) {
  return (
    <input id={id} type={type} value={value} placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className={`${INPUT_CLS} ${mono ? "font-mono text-[11.5px]" : ""}`} />
  );
}

function NumberInput({ id, value, onChange, min = 0, max = 3600, suffix }: {
  id?: string; value: number; onChange: (value: number) => void;
  min?: number; max?: number; suffix?: string;
}) {
  return (
    <div className="relative">
      <input id={id} type="number" value={value} min={min} max={max}
        onChange={(event) => {
          const next = Number(event.target.value);
          onChange(Number.isFinite(next) ? Math.min(max, Math.max(min, next)) : min);
        }}
        className={`${INPUT_CLS} pr-12`} />
      {suffix ? (
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10.5px] text-ink-faint">
          {suffix}
        </span>
      ) : null}
    </div>
  );
}

function SelectInput<T extends string>({ id, value, onChange, options }: {
  id?: string; value: T; onChange: (value: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <select id={id} value={value} onChange={(event) => onChange(event.target.value as T)}
      className={`${INPUT_CLS} appearance-none pr-7`}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

function SegmentInput<T extends string>({ value, onChange, options }: {
  value: T; onChange: (value: T) => void; options: { value: T; label: string }[];
}) {
  return (
    <div className="wb-segment !flex-wrap">
      {options.map((option) => (
        <button key={option.value} type="button"
          className={value === option.value ? "active" : ""}
          onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

function TextArea({ id, value, onChange, placeholder }: {
  id?: string; value: string; onChange: (value: string) => void; placeholder?: string;
}) {
  return (
    <textarea id={id} rows={5} value={value} placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className={`${CONTROL_CLS} resize-y px-2.5 py-2 font-mono text-[11.5px] leading-5`} />
  );
}

function InfoRow({ icon: Icon, title, children }: {
  icon: LucideIcon; title: string; children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5 py-2">
      <Icon size={14} className="mt-0.5 shrink-0 text-brand-600" />
      <div className="min-w-0">
        <div className="text-[11.5px] font-medium text-ink">{title}</div>
        <div className="mt-0.5 break-words text-[10.5px] leading-4 text-ink-faint">{children}</div>
      </div>
    </div>
  );
}

function Badge({ tone, children }: { tone: "ok" | "muted" | "warn" | "info"; children: ReactNode }) {
  return <span className={`wb-tone wb-tone-${tone}`}>{children}</span>;
}

function ListRow({ title, subtitle, right }: {
  title: string; subtitle?: string; right?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="min-w-0">
        <div className="truncate text-[11.5px] font-medium text-ink">{title}</div>
        {subtitle ? <div className="mt-0.5 truncate font-mono text-[10px] text-ink-faint">{subtitle}</div> : null}
      </div>
      {right ? <div className="flex shrink-0 items-center gap-1.5">{right}</div> : null}
    </div>
  );
}

function MiniButton({ children, onClick, tone = "ghost", icon: Icon, disabled = false }: {
  children: ReactNode; onClick: () => void;
  tone?: "ghost" | "primary" | "danger"; icon?: LucideIcon; disabled?: boolean;
}) {
  const cls = tone === "primary" ? "wb-btn wb-btn-primary"
    : tone === "danger" ? "wb-btn wb-btn-danger" : "wb-btn wb-btn-ghost";
  return (
    <button type="button" className={cls} onClick={onClick} disabled={disabled}>
      {Icon ? <Icon size={13} /> : null}{children}
    </button>
  );
}

/* Settings dialog — the single settings surface, grouped into tabs. */
export function SettingsCenter() {
  const open = useWorkspace((state) => state.settingsModalOpen);
  const setOpen = useWorkspace((state) => state.setSettingsModalOpen);
  // Subscribe to every value the panels render. Reading a one-off getState()
  // snapshot leaves the UI stale after login / logout / project / list edits.
  const scriptLibrary = useWorkspace((state) => state.snapshot.scriptLibrary);
  const dbConnections = useWorkspace((state) => state.snapshot.dbConnections);
  const projectsState = useWorkspace((state) => state.projectsState);
  const runtime = useWorkspace((state) => state.runtime);
  const cloudLoggedIn = useWorkspace((state) => state.cloudLoggedIn);
  const cloudUser = useWorkspace((state) => state.cloudUser);
  const cloudBusy = useWorkspace((state) => state.cloudBusy);
  const cloudError = useWorkspace((state) => state.cloudError);
  const cloudNotice = useWorkspace((state) => state.cloudNotice);
  const cloudLastImport = useWorkspace((state) => state.cloudLastImport);
  const cloudLastImportError = useWorkspace((state) => state.cloudLastImportError);
  const cloudProjectId = useWorkspace((state) => state.cloudProjectId);
  const cloudConflictRecord = useWorkspace((state) => state.cloudConflictRecord);

  const [draft, setDraft] = useState<Draft>(readDraft);
  const [baseline, setBaseline] = useState<Draft>(readDraft);
  const [active, setActive] = useState<TabId>(DEFAULT_TAB);
  const [query, setQuery] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [mergeKey, setMergeKey] = useState<string | null>(null);
  const [snippetName, setSnippetName] = useState("");
  const [snippetCode, setSnippetCode] = useState("");
  const [dbName, setDbName] = useState("");
  const [dbUrl, setDbUrl] = useState("");
  const [newProject, setNewProject] = useState("");
  const [loginName, setLoginName] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [rootBusy, setRootBusy] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [rootNotice, setRootNotice] = useState<string | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);
  const t = useT();
  // visibleGroups 的 useMemo 内含译文，语言切换时需重算。
  const lang = useLang();

  useEffect(() => {
    if (!open) return;
    const next = readDraft();
    setDraft(next);
    setBaseline(next);
    setActive(DEFAULT_TAB);
    setQuery("");
    setConfirmReset(false);
    setMergeKey(null);
    setLoginName("");
    setLoginPassword("");
    setRootError(null);
    setRootNotice(null);
    setAdminError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Nested dialogs are portalled to body; close the topmost one first.
      if (mergeKey) { setMergeKey(null); return; }
      if (confirmReset) { setConfirmReset(false); return; }
      const store = useWorkspace.getState();
      if (store.cloudPickerOpen) { store.setCloudPickerOpen(false); return; }
      setMergeKey(null);
      setConfirmReset(false);
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, mergeKey, confirmReset, setOpen]);

  useEffect(() => {
    if (open && active === "projects") void useWorkspace.getState().refreshProjects();
  }, [open, active]);

  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GROUPS;
    return GROUPS.map((group) => ({
      ...group,
      tabs: group.tabs.filter((tab) =>
        `${t(tab.label)} ${t(tab.hint)} ${tab.keywords} ${t(group.title)}`.toLowerCase().includes(q)),
    })).filter((group) => group.tabs.length > 0);
  }, [query, lang]);

  const activeMeta = useMemo(() => {
    for (const group of GROUPS) {
      const tab = group.tabs.find((item) => item.id === active);
      if (tab) return { ...tab, group: group.title };
    }
    return { ...GROUPS[0].tabs[0], group: GROUPS[0].title };
  }, [active]);

  function patch<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);

  /** Never leave a nested picker open after the settings dialog closes:
   * cloudAutoSyncTick stays blocked while cloudPickerOpen is true. */
  function close(): void {
    const store = useWorkspace.getState();
    if (store.cloudPickerOpen) store.setCloudPickerOpen(false);
    setMergeKey(null);
    setConfirmReset(false);
    setOpen(false);
  }

  function flushDraft(): void {
    if (!dirty) return;
    commit(draft);
    setBaseline(draft);
  }

  function handleSave(): void {
    if (dirty) {
      commit(draft);
      setBaseline(draft);
    }
    close();
  }

  function addSnippet(): void {
    if (!snippetName.trim() || !snippetCode.trim()) return;
    useWorkspace.getState().addScriptSnippet({
      name: snippetName.trim(), description: "", code: snippetCode,
    });
    setSnippetName("");
    setSnippetCode("");
  }

  function addDbConnection(): void {
    if (!dbName.trim() || !dbUrl.trim()) return;
    const store = useWorkspace.getState();
    const list = store.snapshot.dbConnections ?? [];
    const next: NamedDbConnection = {
      id: `db-${Date.now().toString(36)}`,
      name: dbName.trim(), url: dbUrl.trim(), description: "",
    };
    store.saveDbConnections([...list, next]);
    setDbName("");
    setDbUrl("");
  }

  async function runRootAction(task: () => Promise<void>, success: string): Promise<void> {
    setRootBusy(true);
    setRootError(null);
    setRootNotice(null);
    try {
      await task();
      setRootNotice(success);
    } catch (caught) {
      setRootError(ERROR_TEXT(caught));
    } finally {
      setRootBusy(false);
    }
  }

  async function changeDataRoot(): Promise<void> {
    try {
      const picked = await api.pickDirectory();
      if (!picked) return;
      await runRootAction(
        () => useWorkspace.getState().setDataRoot(picked),
        t("shell.dataRootChanged", { path: picked }),
      );
    } catch (caught) {
      setRootError(ERROR_TEXT(caught));
    }
  }

  const server = normalizeCloudBaseUrl(draft.cloudBaseUrl);
  const serverConfigured = isCloudServerConfigured(server);
  const adminUrl = serverConfigured ? `${server}/admin/index.html` : "";
  const mergeEntry: SyncConflictEntry | null = mergeKey
    ? (cloudConflictRecord?.entries.find(
        (entry) => `${entry.domain}:${entry.id}` === mergeKey,
      ) ?? null)
    : null;

  function openAdmin(): void {
    if (!serverConfigured) return;
    flushDraft();
    setAdminError(null);
    void api.openUrl(adminUrl).catch((caught) => setAdminError(ERROR_TEXT(caught)));
  }

  function renderPanel(): ReactNode {
    const pid = projectsState?.activeProjectId ?? "default";
    const bound = cloudProjectFor(pid);
    const scripts = scriptLibrary ?? [];
    const connections = dbConnections ?? [];
    const projects = projectsState?.projects ?? [];
    const conflicts = cloudConflictRecord?.entries ?? [];

    switch (active) {
      case "collab":
        return (
          <>
            <SyncModePanel />
            <div className="mt-3 flex items-center gap-3 rounded-lg border border-brand-200 bg-brand-50/70 p-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white">
                <Cloud size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] font-semibold text-ink">{t("shell.collabTitle")}</span>
                  <Badge tone={cloudLoggedIn ? "ok" : "muted"}>{cloudLoggedIn ? t("shell.connected") : t("shell.notLoggedIn")}</Badge>
                </div>
                <p className="mt-1 truncate text-[11px] text-ink-soft">
                  {cloudLoggedIn
                    ? `${cloudUser?.displayName || cloudUser?.username || t("shell.signedIn")}${cloudUser?.superAdmin ? ` · ${t("shell.superAdmin")}` : ""}${bound ? ` · ${t("shell.spaceBound", { name: bound.name })}` : ` · ${t("shell.spaceNotBound")}`}`
                    : t("shell.collabLoggedOutDesc")}
                </p>
                <p className="mt-0.5 truncate font-mono text-[10px] text-ink-faint">
                  {serverConfigured ? server : t("shell.collabNotConfiguredShort")}
                </p>
              </div>
            </div>

            <Section title={t("shell.section.backend")}
              desc={t("shell.section.backendDesc")}>
              {!serverConfigured ? (
                <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11px] leading-5 text-amber-800">
                  {t("shell.collabNotConfigured")}
                </p>
              ) : null}
              <Field label={t("shell.field.serverUrl")} hint={t("shell.field.serverUrlHint")} htmlFor="collab-url">
                <TextInput id="collab-url" value={draft.cloudBaseUrl}
                  onChange={(value) => patch("cloudBaseUrl", value)}
                  placeholder="https://your-server.example.com/reqora" mono />
              </Field>
              <Field label={t("shell.field.autoSync")} hint={t("shell.field.autoSyncHint")} htmlFor="auto-sync">
                <SelectInput id="auto-sync" value={String(draft.autoSyncMinutes)}
                  onChange={(value) => patch("autoSyncMinutes", Number(value))}
                  options={SYNC_MINUTES.map((option) => ({ value: option.value, label: t(option.label) }))} />
              </Field>
              {!cloudLoggedIn ? (
                <div className="space-y-2 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-[120px] flex-1">
                      <TextInput value={loginName} onChange={setLoginName} placeholder={t("shell.username")} />
                    </div>
                    <div className="min-w-[160px] flex-[1.5]">
                      <TextInput type="password" value={loginPassword} onChange={setLoginPassword}
                        placeholder={t("shell.password")} />
                    </div>
                    <MiniButton tone="primary" icon={LogIn}
                      disabled={cloudBusy || !serverConfigured || !loginName.trim() || !loginPassword}
                      onClick={() => {
                        flushDraft();
                        void useWorkspace.getState().cloudLogin(loginName.trim(), loginPassword);
                      }}>{t("shell.login")}</MiniButton>
                  </div>
                  <p className="text-[10.5px] leading-4 text-ink-faint">
                    {t("shell.loginHint")}
                  </p>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2 py-2.5">
                  <MiniButton tone="primary" icon={CloudUpload} disabled={cloudBusy} onClick={() => {
                    flushDraft();
                    void useWorkspace.getState().cloudImport();
                  }}>{t("shell.syncData")}</MiniButton>
                  <MiniButton icon={Cloud} disabled={cloudBusy} onClick={() => {
                    flushDraft();
                    useWorkspace.getState().setCloudPickerOpen(true);
                  }}>{t("shell.pickSpace")}</MiniButton>
                  <MiniButton icon={Unlink} disabled={!cloudProjectId} onClick={() => {
                    useWorkspace.getState().cloudUnbindProject();
                  }}>{t("shell.unbindSpace")}</MiniButton>
                  <MiniButton icon={LogOut} onClick={() => useWorkspace.getState().cloudLogout()}>{t("shell.logout")}</MiniButton>
                </div>
              )}
              {cloudError ? (
                <p className="my-2 rounded-md bg-red-50 px-2.5 py-1.5 text-[11px] text-red-600">{cloudError}</p>
              ) : null}
              {cloudNotice ? (
                <p className="my-2 rounded-md bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-700">{cloudNotice}</p>
              ) : null}
              {cloudLastImportError && !cloudError ? (
                <p className="my-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700">
                  {t("shell.lastSyncFailed", { error: cloudLastImportError })}
                </p>
              ) : null}
            </Section>

            <Section title={t("shell.section.syncStatus")} desc={t("shell.section.syncStatusDesc")}>
              <InfoRow icon={Activity} title={t("shell.lastSync")}>
                {cloudLastImport
                  ? t("shell.syncRecord", {
                      project: cloudLastImport.projectName || `#${cloudLastImport.projectId}`,
                      version: cloudLastImport.version,
                      time: new Date(cloudLastImport.at).toLocaleString(),
                    })
                  : t("shell.noSyncRecord")}
              </InfoRow>
              <InfoRow icon={Link} title={t("shell.currentSpace")}>
                {bound ? t("shell.spaceDetail", { name: bound.name, id: bound.id, slug: bound.slug }) : t("shell.spaceNotBound")}
              </InfoRow>
              {conflicts.length > 0 ? (
                <div className="rounded-md border border-brand-200 bg-brand-50/60 p-3">
                  <div className="text-[11px] font-semibold text-brand-700">
                    {t("shell.conflictCount", { count: conflicts.length })}
                  </div>
                  <div className="mt-2 divide-y divide-brand-200/60">
                    {conflicts.map((entry) => (
                      <div key={`${entry.domain}:${entry.id}`}
                        className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                        <div className="min-w-0">
                          <div className="truncate text-[11px] font-medium text-ink">{entry.name || entry.id}</div>
                          <div className="text-[10px] text-ink-faint">
                            {t(CONFLICT_DOMAIN_LABELS[entry.domain] ?? entry.domain)}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <MiniButton disabled={cloudBusy}
                            onClick={() => setMergeKey(`${entry.domain}:${entry.id}`)}>{t("shell.mergeFields")}</MiniButton>
                          <MiniButton disabled={cloudBusy} onClick={() => {
                            void useWorkspace.getState()
                              .cloudResolveConflict(entry.domain, entry.id, true);
                          }}>{t("shell.useLocal")}</MiniButton>
                          <MiniButton disabled={cloudBusy} onClick={() => {
                            void useWorkspace.getState()
                              .cloudResolveConflict(entry.domain, entry.id, false);
                          }}>{t("shell.useCloud")}</MiniButton>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <InfoRow icon={Check} title={t("shell.rowConflicts")}>{t("shell.noConflicts")}</InfoRow>
              )}
            </Section>
          </>
        );

      case "org":
        return <OrgPanel />;

      case "admin":
        return (
          <Section title={t("shell.section.admin")}
            desc={t("shell.section.adminDesc")}>
            <Field label={t("shell.field.consoleUrl")} hint={t("shell.field.consoleUrlHint")}>
              <div className="flex items-center gap-2">
                <input readOnly value={adminUrl} aria-label={t("shell.adminUrlAria")} spellCheck={false}
                  onFocus={(event) => event.currentTarget.select()}
                  className={`${INPUT_CLS} min-w-0 flex-1 font-mono text-[11px]`} />
                <MiniButton icon={ExternalLink} tone="primary" onClick={openAdmin}>{t("shell.openAdmin")}</MiniButton>
              </div>
            </Field>
            {adminError ? (
              <p className="my-2 rounded-md bg-red-50 px-2.5 py-1.5 text-[11px] text-red-600">
                {t("shell.browserError", { error: adminError })}
              </p>
            ) : null}
            <InfoRow icon={Shield} title={t("shell.loginRequirement")}>
              {t("shell.loginRequirementDesc")}
            </InfoRow>
          </Section>
        );

      case "request":
        return (
          <Section title={t("shell.tab.request")} desc={t("shell.section.requestDesc")}>
            <Field label={t("shell.field.timeout")} hint={t("shell.field.timeoutHint")} htmlFor="timeout">
              <NumberInput id="timeout" value={draft.timeoutSecs}
                onChange={(value) => patch("timeoutSecs", value)} min={1} max={300} suffix={t("shell.unitSec")} />
            </Field>
            <Field label={t("shell.field.scriptTimeout")} hint={t("shell.field.scriptTimeoutHint")} htmlFor="script-timeout">
              <NumberInput id="script-timeout" value={draft.scriptTimeoutMs}
                onChange={(value) => patch("scriptTimeoutMs", value)} min={200} max={10000} suffix={t("shell.unitMs")} />
            </Field>
            <Field label={t("shell.field.httpVersion")} hint={t("shell.field.httpVersionHint")}>
              <SegmentInput value={draft.httpVersion}
                onChange={(value) => patch("httpVersion", value)}
                options={HTTP_VERSIONS.map((option) => ({ value: option.value, label: t(option.label) }))} />
            </Field>
            <Field label={t("shell.field.followRedirects")} hint={t("shell.field.followRedirectsHint")}>
              <div className="flex h-8 items-center">
                <Toggle checked={draft.followRedirects} onChange={(value) => patch("followRedirects", value)}
                  label={t("shell.field.followRedirects")} />
              </div>
            </Field>
            <Field label={t("shell.field.verifyTls")} hint={t("shell.field.verifyTlsHint")}>
              <div className="flex h-8 items-center">
                <Toggle checked={draft.verifyTls} onChange={(value) => patch("verifyTls", value)}
                  label={t("shell.field.verifyTls")} />
              </div>
            </Field>
            <Field label={t("shell.field.manageCookies")} hint={t("shell.field.manageCookiesHint")}>
              <div className="flex h-8 items-center">
                <Toggle checked={draft.manageCookies} onChange={(value) => patch("manageCookies", value)}
                  label={t("shell.field.manageCookies")} />
              </div>
            </Field>
            <Field label={t("shell.field.proxy")} hint={t("shell.field.proxyHint")} htmlFor="proxy">
              <TextInput id="proxy" value={draft.proxyUrl} onChange={(value) => patch("proxyUrl", value)}
                placeholder={t("shell.proxyPlaceholder")} mono />
            </Field>
          </Section>
        );

      case "limits":
        return (
          <Section
            title={t("shell.tab.limits")}
            desc={t("shell.section.limitsDesc")}
          >
            {LIMIT_FIELDS.map((item) => (
              <Field key={item.key} label={t(item.label)} hint={t(item.hint)} htmlFor={`limit-${item.key}`}>
                <NumberInput
                  id={`limit-${item.key}`}
                  value={draft[item.key]}
                  onChange={(value) => patch(item.key, value)}
                  min={item.min}
                  max={item.max}
                  suffix="MiB"
                />
              </Field>
            ))}
            <InfoRow icon={Info} title={t("shell.restoreDefaults")}>
              {t("shell.restoreDefaultsDesc")}
            </InfoRow>
          </Section>
        );

      case "ai":
        return (
          <Section title={t("shell.tab.ai")}
            desc={t("shell.section.aiDesc")}>
            <Field label="Base URL" hint={t("shell.field.aiBaseUrlHint")} htmlFor="ai-url">
              <TextInput id="ai-url" value={draft.aiBaseUrl} onChange={(value) => patch("aiBaseUrl", value)}
                placeholder="https://api.deepseek.com/v1" mono />
            </Field>
            <Field label="API Key" hint={t("shell.field.aiKeyHint")} htmlFor="ai-key">
              <TextInput id="ai-key" type="password" value={draft.aiApiKey}
                onChange={(value) => patch("aiApiKey", value)} placeholder={t("shell.aiKeyPlaceholder")} />
            </Field>
            <Field label={t("shell.field.aiModel")} htmlFor="ai-model">
              <TextInput id="ai-model" value={draft.aiModel} onChange={(value) => patch("aiModel", value)}
                placeholder="deepseek-chat" mono />
            </Field>
          </Section>
        );

      case "scripts":
        return (
          <>
            <Section title={t("shell.section.hooks")}
              desc={t("shell.section.hooksDesc")}>
              <Field label={t("shell.field.preScript")} hint="global pre" htmlFor="pre-script">
                <TextArea id="pre-script" value={draft.globalPreScript}
                  onChange={(value) => patch("globalPreScript", value)}
                  placeholder={t("shell.preScriptPlaceholder")} />
              </Field>
              <Field label={t("shell.field.postScript")} hint="global post" htmlFor="post-script">
                <TextArea id="post-script" value={draft.globalPostScript}
                  onChange={(value) => patch("globalPostScript", value)}
                  placeholder={t("shell.postScriptPlaceholder")} />
              </Field>
            </Section>
            <Section title={t("shell.section.library", { count: scripts.length })}
              desc={t("shell.section.libraryDesc")}>
              {scripts.length === 0 ? (
                <InfoRow icon={Info} title={t("shell.noSnippets")}>{t("shell.noSnippetsDesc")}</InfoRow>
              ) : scripts.map((item) => (
                <ListRow key={item.id} title={item.name}
                  subtitle={item.description || item.code.slice(0, 60)}
                  right={<MiniButton icon={Trash} tone="danger"
                    onClick={() => useWorkspace.getState().deleteScriptSnippet(item.id)}>{t("shell.delete")}</MiniButton>} />
              ))}
              <div className="flex flex-wrap items-end gap-2 py-2.5">
                <div className="min-w-[140px] flex-1">
                  <TextInput value={snippetName} onChange={setSnippetName} placeholder={t("shell.snippetNamePlaceholder")} />
                </div>
                <div className="min-w-[220px] flex-[2]">
                  <TextInput value={snippetCode} onChange={setSnippetCode}
                    placeholder={t("shell.snippetCodePlaceholder")} mono />
                </div>
                <MiniButton icon={Plus} tone="primary" onClick={addSnippet}
                  disabled={!snippetName.trim() || !snippetCode.trim()}>{t("shell.add")}</MiniButton>
              </div>
            </Section>
          </>
        );

      case "database":
        return (
          <Section title={t("shell.tab.database")}
            desc={t("shell.section.dbDesc")}>
            {connections.length === 0 ? (
              <InfoRow icon={Info} title={t("shell.noDbConnections")}>{t("shell.noDbDesc")}</InfoRow>
            ) : connections.map((conn) => (
              <ListRow key={conn.id} title={conn.name} subtitle={conn.url}
                right={<MiniButton icon={Trash} tone="danger" onClick={() => {
                  const store = useWorkspace.getState();
                  store.saveDbConnections((store.snapshot.dbConnections ?? [])
                    .filter((item) => item.id !== conn.id));
                }}>{t("shell.delete")}</MiniButton>} />
            ))}
            <div className="flex flex-wrap items-end gap-2 py-2.5">
              <div className="min-w-[140px] flex-1">
                <TextInput value={dbName} onChange={setDbName} placeholder={t("shell.dbNamePlaceholder")} />
              </div>
              <div className="min-w-[220px] flex-[2]">
                <TextInput value={dbUrl} onChange={setDbUrl}
                  placeholder="mysql://user:pass@127.0.0.1:3306/db" mono />
              </div>
              <MiniButton icon={Plus} tone="primary" onClick={addDbConnection}
                disabled={!dbName.trim() || !dbUrl.trim()}>{t("shell.add")}</MiniButton>
            </div>
          </Section>
        );

      case "projects":
        return (
          <>
            <Section title={t("shell.section.dataRoot")}
              desc={t("shell.section.dataRootDesc")}>
              <InfoRow icon={Folder} title={t("shell.currentProject")}>
                {projects.find((item) => item.active)?.name ?? t("shell.loading")}
              </InfoRow>
              <InfoRow icon={FolderOpen} title={t("shell.dataRootLabel")}>
                <span className="break-all font-mono">{projectsState?.dataRoot || t("shell.loadingFull")}</span>
              </InfoRow>
              <div className="flex flex-wrap items-center gap-2 py-2.5">
                <MiniButton icon={FolderOpen} disabled={rootBusy}
                  onClick={() => void changeDataRoot()}>{t("shell.changeDataRoot")}</MiniButton>
                <MiniButton icon={RotateCcw} disabled={rootBusy} onClick={() => {
                  void runRootAction(
                    () => useWorkspace.getState().setDataRoot(null),
                    t("shell.dataRootRestored"),
                  );
                }}>{t("shell.restoreDataRoot")}</MiniButton>
              </div>
              {rootNotice ? (
                <p className="my-2 rounded-md bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-700">{rootNotice}</p>
              ) : null}
              {rootError ? (
                <p className="my-2 rounded-md bg-red-50 px-2.5 py-1.5 text-[11px] text-red-600">{rootError}</p>
              ) : null}
            </Section>
            <Section title={t("shell.section.projectList", { count: projects.length })}
              desc={t("shell.section.projectListDesc")}>
              {projects.length === 0 ? (
                <InfoRow icon={Info} title={t("shell.projectListTitle")}>{t("shell.projectsNotLoaded")}</InfoRow>
              ) : projects.map((project) => (
                <ListRow key={project.id} title={project.name}
                  subtitle={project.dataDirectory || project.id}
                  right={project.active ? <Badge tone="info">{t("shell.current")}</Badge>
                    : <MiniButton onClick={() => void useWorkspace.getState().switchProject(project.id)}>{t("shell.switch")}</MiniButton>} />
              ))}
              <div className="flex flex-wrap items-end gap-2 py-2.5">
                <div className="min-w-[200px] flex-1">
                  <TextInput value={newProject} onChange={setNewProject} placeholder={t("shell.newProjectName")} />
                </div>
                <MiniButton icon={Plus} tone="primary" disabled={!newProject.trim()} onClick={() => {
                  if (!newProject.trim()) return;
                  void useWorkspace.getState().createProject(newProject.trim());
                  setNewProject("");
                }}>{t("shell.create")}</MiniButton>
                <MiniButton icon={RefreshCw}
                  onClick={() => void useWorkspace.getState().refreshProjects()}>{t("shell.refresh")}</MiniButton>
              </div>
            </Section>
          </>
        );

      case "runtime":
        return (
          <Section title={t("shell.tab.runtime")}
            desc={t("shell.section.runtimeDesc")}>
            <InfoRow icon={Activity} title={t("shell.statusVersion")}>
              {runtime ? `${runtimeStatusLabel(runtime.status)} · ${runtime.version}` : t("shell.runtimeConnecting", { version: pkg.version })}
            </InfoRow>
            <InfoRow icon={Info} title={t("shell.logLevel")}>{runtime?.logLevel ?? "—"}</InfoRow>
            <InfoRow icon={Info} title={t("shell.limit.response.label")}>
              {runtime ? `${(runtime.maxResponseBytes / 1024 / 1024).toFixed(1)} MB` : "—"}
            </InfoRow>
            <InfoRow icon={Folder} title={t("shell.workspaceDir")}>
              <span className="break-all font-mono">{runtime?.workspacePath ?? "—"}</span>
            </InfoRow>
          </Section>
        );

      case "danger":
        return (
          <Section title={t("shell.tab.danger")} desc={t("shell.section.dangerDesc")}>
            <div className="flex flex-wrap items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="text-[11.5px] font-medium text-ink">{t("shell.resetWorkspace")}</div>
                <div className="mt-0.5 text-[10.5px] leading-4 text-ink-faint">
                  {t("shell.resetDesc")}
                </div>
              </div>
              <MiniButton icon={RotateCcw} tone="danger" onClick={() => setConfirmReset(true)}>
                {t("shell.resetWorkspace")}
              </MiniButton>
            </div>
          </Section>
        );

      default:
        return null;
    }
  }

  if (!open) return null;

  const ActiveIcon = activeMeta.icon;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
        onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
        <div role="dialog" aria-modal="true" aria-label={t("shell.settings")}
          className="flex h-[min(680px,90vh)] w-[min(940px,94vw)] flex-col overflow-hidden rounded-xl border border-surface-border bg-surface shadow-panel">
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-surface-border px-5">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-white">
                <Settings size={15} />
              </div>
              <div>
                <div className="text-[13px] font-semibold leading-4 text-ink">{t("shell.settingsTitle")}</div>
                <div className="text-[10px] leading-4 text-ink-faint">{t("shell.settingsSubtitle")}</div>
              </div>
            </div>
            <button type="button" aria-label={t("shell.closeSettings")} className="wb-icon-btn" onClick={close}>
              <X size={16} />
            </button>
          </div>

          <div className="flex min-h-0 flex-1">
            <nav className="flex w-[218px] shrink-0 flex-col border-r border-surface-border bg-surface-muted" aria-label={t("shell.settingsCategories")}>
              <div className="px-3 pt-3">
                <div className="flex h-8 items-center gap-2 rounded-md border border-surface-border bg-surface px-2.5 focus-within:border-brand-400">
                  <Search size={13} className="shrink-0 text-ink-faint" />
                  <input value={query} onChange={(event) => setQuery(event.target.value)}
                    placeholder={t("shell.searchSettings")} aria-label={t("shell.searchSettings")}
                    className="w-full border-0 bg-transparent text-[11.5px] text-ink outline-none placeholder:text-ink-faint" />
                  {query ? (
                    <button type="button" aria-label={t("shell.clearSearch")} className="text-ink-faint hover:text-ink"
                      onClick={() => setQuery("")}><X size={12} /></button>
                  ) : null}
                </div>
              </div>
              <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3" role="tablist" aria-orientation="vertical">
                {visibleGroups.length === 0 ? (
                  <p className="px-2 pt-6 text-center text-[11px] text-ink-faint">{t("shell.noSettingsMatch")}</p>
                ) : null}
                {visibleGroups.map((group) => (
                  <div key={group.title}>
                    <div className="px-2 pb-1 pt-4 text-2xs font-bold uppercase tracking-wider text-ink-faint">
                      {t(group.title)}
                    </div>
                    {group.tabs.map((tab) => {
                      const Icon = tab.icon;
                      const isActive = tab.id === active;
                      return (
                        <button key={tab.id} type="button" role="tab" aria-selected={isActive}
                          onClick={() => setActive(tab.id)}
                          className={`relative flex w-full items-center gap-2 rounded-md py-[7px] pl-2.5 pr-2 text-left text-[12px] transition-colors ${
                            isActive ? "bg-brand-50 font-semibold text-brand-700"
                              : "text-ink-soft hover:bg-surface-sunken hover:text-ink"}`}>
                          {isActive ? (
                            <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-brand-500" />
                          ) : null}
                          <Icon size={14} className={isActive ? "text-brand-600" : "text-ink-faint"} />
                          <span className="truncate">{t(tab.label)}</span>
                          {tab.id === DEFAULT_TAB ? (
                            <span className="ml-auto rounded bg-brand-100 px-1.5 py-0.5 text-[9px] font-bold text-brand-700">
                              {t("shell.defaultBadge")}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </nav>

            <div className="flex min-w-0 flex-1 flex-col">
              <div className="shrink-0 border-b border-surface-border px-6 py-4">
                <div className="flex items-center gap-1.5 text-[10.5px] text-ink-faint">
                  <span>{t(activeMeta.group)}</span>
                  <ChevronRight size={11} />
                  <span className="text-ink-soft">{t(activeMeta.label)}</span>
                </div>
                <h2 className="mt-1.5 flex items-center gap-2 text-[15px] font-semibold text-ink">
                  <ActiveIcon size={16} className="text-brand-600" />
                  {t(activeMeta.label)}
                </h2>
                <p className="mt-1 text-[11px] text-ink-faint">{t(activeMeta.hint)}</p>
              </div>
              <div className="scrollbar-thin min-h-0 flex-1 space-y-3.5 overflow-y-auto px-6 py-5">
                {renderPanel()}
              </div>
              <div className="flex h-14 shrink-0 items-center justify-between border-t border-surface-border px-5">
                <div className={`flex items-center gap-1.5 text-[11px] ${dirty ? "text-brand-600" : "text-ink-faint"}`}>
                  {dirty ? <span className="h-1.5 w-1.5 rounded-full bg-brand-500" /> : <Check size={12} />}
                  {dirty ? t("shell.unsavedChanges") : t("shell.allSaved")}
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" className="wb-btn wb-btn-ghost" onClick={close}>{t("shell.cancel")}</button>
                  <button type="button" className="wb-btn wb-btn-primary" onClick={handleSave}>
                    <Save size={13} />{t("shell.done")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Nested dialogs are portalled to body: the settings dialog uses
       * overflow-hidden + backdrop-blur, which would clip / contain a plain
       * fixed-position child. */}
      {createPortal(<CloudProjectPicker />, document.body)}
      {createPortal(
        <ConflictMergeModal
          key={mergeKey ?? "none"}
          entry={mergeEntry}
          busy={cloudBusy}
          onClose={() => setMergeKey(null)}
          onApply={(row) => {
            if (!mergeEntry) return;
            setMergeKey(null);
            void useWorkspace.getState()
              .cloudResolveConflictWithMerge(mergeEntry.domain, mergeEntry.id, row);
          }}
        />,
        document.body,
      )}
      <ConfirmDialog
        open={confirmReset}
        title={t("shell.resetWorkspace")}
        message={t("shell.resetConfirmMsg")}
        confirmLabel={t("shell.confirmReset")}
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false);
          void useWorkspace.getState().resetWorkspace().then(() => close());
        }}
      />
    </>
  );
}

export default SettingsCenter;
