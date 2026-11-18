import {
  Boxes,
  Clock,
  Component,
  FileText,
  Info,
  ListChecks,
  Moon,
  Settings2,
  Sun,
  TestTube2,
} from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { useT } from "../i18n";

export type SideView = "apis" | "cases" | "scenarios" | "models" | "docs" | "history";

/** 标签复用 core 命名空间的 core.view.* key（TopBar 亦在用）。 */
const VIEWS: { id: SideView; icon: typeof Boxes; label: string }[] = [
  { id: "apis", icon: Boxes, label: "core.view.apis" },
  { id: "cases", icon: TestTube2, label: "core.view.cases" },
  { id: "scenarios", icon: ListChecks, label: "core.view.scenarios" },
  { id: "models", icon: Component, label: "core.view.models" },
  { id: "docs", icon: FileText, label: "core.view.docs" },
  { id: "history", icon: Clock, label: "core.view.history" },
];

/**
 * Apifox-style narrow icon rail on the far left: view switcher on top,
 * theme / settings at the bottom.
 */
export function ActivityRail({
  view,
  onViewChange,
}: {
  view: SideView;
  onViewChange: (view: SideView) => void;
}) {
  const theme = useWorkspace((state) => state.snapshot.theme ?? "light");
  const setTheme = useWorkspace((state) => state.setTheme);
  const setSettingsModalOpen = useWorkspace((state) => state.setSettingsModalOpen);
  const setAboutModalOpen = useWorkspace((state) => state.setAboutModalOpen);
  const t = useT();

  return (
    <nav className="wb-rail" aria-label={t("shell.viewSwitcher")}>
      <div className="wb-rail-group">
        {VIEWS.map((item) => {
          const Icon = item.icon;
          const active = view === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={`wb-rail-btn ${active ? "active" : ""}`}
              title={t(item.label)}
              aria-label={t(item.label)}
              aria-pressed={active}
              onClick={() => onViewChange(item.id)}
            >
              <Icon className="h-[17px] w-[17px]" />
            </button>
          );
        })}
      </div>
      <div className="wb-rail-group wb-rail-foot">
        <button
          type="button"
          className="wb-rail-btn"
          title={theme === "dark" ? t("shell.toLightTheme") : t("shell.toDarkTheme")}
          aria-label={t("shell.toggleTheme")}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? <Sun className="h-[17px] w-[17px]" /> : <Moon className="h-[17px] w-[17px]" />}
        </button>
        <button
          type="button"
          className="wb-rail-btn"
          title={t("shell.aboutHint")}
          aria-label={t("shell.about")}
          onClick={() => setAboutModalOpen(true)}
        >
          <Info className="h-[17px] w-[17px]" />
        </button>
        <button
          type="button"
          className="wb-rail-btn"
          title={t("shell.settings")}
          aria-label={t("shell.settings")}
          onClick={() => setSettingsModalOpen(true)}
        >
          <Settings2 className="h-[17px] w-[17px]" />
        </button>
      </div>
    </nav>
  );
}
