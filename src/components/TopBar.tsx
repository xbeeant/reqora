import {
  Download, Languages, Monitor, Moon, Network, Plug, Search,
  Settings2, Sparkles, Sun, Trash2, Upload,
} from "lucide-react";
import { useWorkspace } from "../store/workspace";
import type { SideView } from "./ActivityRail";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { EnvironmentPicker } from "./EnvironmentPicker";
import { BrandMark } from "./BrandMark";
import { setLang, useLang, useT } from "../i18n";

/** Crumb labels are i18n keys, resolved at render time so they follow the UI language. */
const VIEW_LABELS: Record<SideView, string> = {
  apis: "core.view.apis",
  cases: "core.view.cases",
  scenarios: "core.view.scenarios",
  models: "core.view.models",
  docs: "core.view.docs",
  history: "core.view.history",
};

/**
 * Apifox-style top toolbar: brand block, project context, environment
 * selector and the global entry points (search / import / export / console /
 * settings / theme / language).
 */
export function TopBar({ view }: { view: SideView }) {
  const t = useT();
  const lang = useLang();
  // 只订阅顶栏需要的域（trash / collections / theme），快照其他域变化不再
  // 触发顶栏重渲染。
  const trash = useWorkspace((state) => state.snapshot.trash);
  const collections = useWorkspace((state) => state.snapshot.collections);
  const setImportExportModalOpen = useWorkspace((state) => state.setImportExportModalOpen);
  const setSearchModalOpen = useWorkspace((state) => state.setSearchModalOpen);
  const setConsoleOpen = useWorkspace((state) => state.setConsoleOpen);
  const consoleOpen = useWorkspace((state) => state.consoleOpen);
  const mockRunning = useWorkspace((state) => state.mock.running);
  const mockPort = useWorkspace((state) => state.mock.port);
  const theme = useWorkspace((state) => state.snapshot.theme ?? "light");
  const setTheme = useWorkspace((state) => state.setTheme);
  const setSettingsModalOpen = useWorkspace((state) => state.setSettingsModalOpen);
  const setTrashModalOpen = useWorkspace((state) => state.setTrashModalOpen);
  const setMcpModalOpen = useWorkspace((state) => state.setMcpModalOpen);
  const setGrpcModalOpen = useWorkspace((state) => state.setGrpcModalOpen);
  const setAiModalOpen = useWorkspace((state) => state.setAiModalOpen);
  const aiPanelOpen = useWorkspace((state) => state.aiModalOpen);
  const trashCount = (trash ?? []).length;

  const requestCount = collections.reduce((sum, c) => sum + c.items.length, 0);

  return (
    <header className="wb-topbar">
      <div className="flex items-center gap-2.5">
        <BrandMark />
        <div>
          <div className="wb-brand-name">Reqora</div>
          <div className="wb-brand-sub">{t("core.brand.tagline")}</div>
        </div>
      </div>

      <div className="wb-crumb">
        <ProjectSwitcher />
        <span>/</span>
        <span>{t(VIEW_LABELS[view])}</span>
        <span className="wb-mini-badge">{t("core.requestCount", { count: requestCount })}</span>
      </div>

      <button
        type="button"
        className="wb-chip ml-2 !h-7"
        title={t("core.search.title")}
        onClick={() => setSearchModalOpen(true)}
      >
        <Search className="h-3.5 w-3.5" />
        {t("core.search")}
        <kbd className="wb-kbd">⌘K</kbd>
      </button>

      <div className="ml-auto flex items-center gap-2">
        {mockRunning && (
          <span className="wb-chip !h-7 !cursor-default !border-emerald-200 !text-emerald-700" title={t("core.mockRunning")}>
            <span className="wb-status-dot !h-1.5 !w-1.5" />
            Mock :{mockPort}
          </span>
        )}

        <EnvironmentPicker placement="topbar" />

        <span className="mx-1 h-4 w-px bg-surface-border" />

        <button
          type="button"
          className="wb-chip !h-7"
          title={t("core.import.title")}
          onClick={() => setImportExportModalOpen(true)}
        >
          <Upload className="h-3.5 w-3.5" />
          {t("core.import")}
        </button>
        <button
          type="button"
          className="wb-chip !h-7"
          title={t("core.export.title")}
          onClick={() => setImportExportModalOpen(true)}
        >
          <Download className="h-3.5 w-3.5" />
          {t("core.export")}
        </button>
        <button
          type="button"
          className={`wb-icon-btn !h-7 !w-7 ${consoleOpen ? "active" : ""}`}
          title={t(consoleOpen ? "core.console.close" : "core.console.open")}
          aria-label={t("core.console.aria")}
          onClick={() => setConsoleOpen(!consoleOpen)}
        >
          <Monitor className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="wb-icon-btn !h-7 !w-7"
          title={t(theme === "dark" ? "core.theme.toLight" : "core.theme.toDark")}
          aria-label={t("core.theme.aria")}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          className="wb-chip !h-7"
          title={t("core.lang.title")}
          aria-label={t("core.lang.aria")}
          onClick={() => setLang(lang === "zh" ? "en" : "zh")}
        >
          <Languages className="h-3.5 w-3.5" />
          {lang === "zh" ? "ZH" : "EN"}
        </button>
        <button
          type="button"
          className={`wb-chip !h-7 ${aiPanelOpen ? "active" : ""}`}
          title={t(aiPanelOpen ? "core.aiGenerate.hide" : "core.aiGenerate.title")}
          aria-expanded={aiPanelOpen}
          aria-controls={aiPanelOpen ? "wb-ai-panel" : undefined}
          onClick={() => setAiModalOpen(!aiPanelOpen)}
        >
          <Sparkles className="h-3.5 w-3.5" />
          {t("core.aiGenerate")}
        </button>
        <button
          type="button"
          className="wb-icon-btn !h-7 !w-7"
          title={t("core.grpc.title")}
          aria-label={t("core.grpc.aria")}
          onClick={() => setGrpcModalOpen(true)}
        >
          <Network className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="wb-icon-btn !h-7 !w-7"
          title={t("core.mcp.title")}
          aria-label="MCP"
          onClick={() => setMcpModalOpen(true)}
        >
          <Plug className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="wb-icon-btn !h-7 !w-7 relative"
          title={t("core.trash.title")}
          aria-label={t("core.trash.aria")}
          onClick={() => setTrashModalOpen(true)}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {trashCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-0.5 text-[9px] font-semibold leading-none text-white">
              {trashCount > 99 ? "99+" : trashCount}
            </span>
          )}
        </button>
        <button
          type="button"
          className="wb-icon-btn !h-7 !w-7"
          title={t("core.settings")}
          aria-label={t("core.settings")}
          onClick={() => setSettingsModalOpen(true)}
        >
          <Settings2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
}
