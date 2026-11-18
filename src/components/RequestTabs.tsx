import { useEffect, useState } from "react";
import { EMPTY_SUITES } from "../lib/defaults.ts";
import { ChevronLeft, ChevronRight, ListChecks, Lock, Plus, X, XCircle, XSquare } from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { useT } from "../i18n";
import type { OpenTab, RequestDraft } from "../types";
import { InlineRenameInput } from "./ui";

const methodClass = (method: string) => `wb-method-${method.toLowerCase()}`;

interface TabMenu {
  tab: OpenTab;
  index: number;
  x: number;
  y: number;
}

export function RequestTabs() {
  const t = useT();
  const tabs = useWorkspace((state) => state.tabs);
  const activeTab = useWorkspace((state) => state.activeTab);
  const draft = useWorkspace((state) => state.draft);
  const collections = useWorkspace((state) => state.snapshot.collections);
  const cases = useWorkspace((state) => state.snapshot.cases);
  const scenarios = useWorkspace((state) => state.snapshot.scenarios);
  const suites = useWorkspace((state) => state.snapshot.suites ?? EMPTY_SUITES);
  const historyTabRecords = useWorkspace((state) => state.historyTabRecords);
  const revisionTabRecords = useWorkspace((state) => state.revisionTabRecords);
  const openTab = useWorkspace((state) => state.openTab);
  const closeTab = useWorkspace((state) => state.closeTab);
  const closeOtherTabs = useWorkspace((state) => state.closeOtherTabs);
  const closeTabsToLeft = useWorkspace((state) => state.closeTabsToLeft);
  const closeTabsToRight = useWorkspace((state) => state.closeTabsToRight);
  const closeAllTabs = useWorkspace((state) => state.closeAllTabs);
  const newRequest = useWorkspace((state) => state.newRequest);
  const renameRequest = useWorkspace((state) => state.renameRequest);
  const updateCase = useWorkspace((state) => state.updateCase);
  const updateScenario = useWorkspace((state) => state.updateScenario);
  const updateSuite = useWorkspace((state) => state.updateSuite);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<TabMenu | null>(null);

  // Esc closes the context menu; the overlay below handles click-away.
  useEffect(() => {
    if (!menu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menu]);

  const byId = new Map<string, RequestDraft>();
  for (const collection of collections) {
    for (const request of collection.items) byId.set(request.id, request);
  }
  const caseById = new Map(cases.map((item) => [item.id, item]));

  // A brand-new empty workspace has no saved request yet; still show its draft
  // as one tab so the tab bar never looks broken.
  const items: OpenTab[] =
    tabs.length > 0 ? tabs : [{ kind: "request", id: draft.id }];

  const sameTab = (left: OpenTab, right: OpenTab) =>
    left.kind === right.kind && left.id === right.id;

  const commitRename = (tab: OpenTab, name: string) => {
    switch (tab.kind) {
      case "request":
        renameRequest(tab.id, name);
        break;
      case "case":
        updateCase(tab.id, { name });
        break;
      case "scenario":
        updateScenario(tab.id, { name });
        break;
      case "suite":
        updateSuite(tab.id, { name });
        break;
      case "history":
      case "revision":
        // Frozen snapshots are never renamed in place.
        break;
    }
    setEditingKey(null);
  };

  const openTabMenu = (event: React.MouseEvent, tab: OpenTab, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({
      tab,
      index,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 210)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 190)),
    });
  };

  const menuItem = (
    label: string,
    icon: React.ReactNode,
    enabled: boolean,
    action: () => void,
  ) => (
    <button
      type="button"
      role="menuitem"
      disabled={!enabled}
      className={`flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs ${
        enabled ? "text-ink hover:bg-brand-50/70" : "cursor-not-allowed text-ink-faint/60"
      }`}
      onClick={() => {
        setMenu(null);
        if (enabled) action();
      }}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );

  return (
    <div className="wb-tabs scrollbar-thin">
      {items.map((tab, index) => {
        const caseItem = tab.kind === "case" ? caseById.get(tab.id) : undefined;
        const scenarioItem =
          tab.kind === "scenario"
            ? scenarios.find((item) => item.id === tab.id)
            : undefined;
        const suiteItem =
          tab.kind === "suite" ? suites.find((item) => item.id === tab.id) : undefined;
        const historyRecord =
          tab.kind === "history" ? historyTabRecords[tab.id] : undefined;
        const revisionRecord =
          tab.kind === "revision" ? revisionTabRecords[tab.id] : undefined;
        const frozen = Boolean(historyRecord || revisionRecord);
        const request =
          tab.kind === "request"
            ? byId.get(tab.id)
            : tab.kind === "revision"
              ? revisionRecord?.revision.snapshot
              : caseById.get(tab.id)?.request;
        const isDraft = tab.kind === "request" && tab.id === draft.id;
        const isActive = activeTab ? sameTab(activeTab, tab) : isDraft;
        const name = historyRecord
          ? historyRecord.name || historyRecord.subjectName
          : revisionRecord
            ? revisionRecord.revision.snapshot.name || t("request.tabs.deleted")
            : suiteItem
              ? suiteItem.name
              : scenarioItem
                ? scenarioItem.name
                : caseItem
                  ? caseItem.name
                  : (request?.name ?? (isDraft ? draft.name : t("request.tabs.deleted")));
        const method =
          historyRecord?.request?.method ??
          historyRecord?.method ??
          request?.method ??
          (isDraft ? draft.method : "GET");
        const key = `${tab.kind}:${tab.id}`;
        return (
          <div
            key={key}
            className={`wb-tab ${isActive ? "active" : ""}`}
            role="tab"
            aria-selected={isActive}
            title={
              revisionRecord
                ? t("request.tabs.title.revision", { name })
                : historyRecord
                  ? t("request.tabs.title.history", { name })
                  : suiteItem
                    ? t("request.tabs.title.suite", { name })
                    : scenarioItem
                      ? t("request.tabs.title.scenario", { name })
                      : caseItem
                        ? t("request.tabs.title.case", { name })
                        : t("request.tabs.title.request", { name })
            }
            // Re-opening the already active tab would overwrite `draft` with a
            // fresh copy from the collection and drop unsaved edits. Double
            // clicking to rename must never do that.
            onClick={() => { if (!isActive) openTab(tab); }}
            onDoubleClick={() => { if (!frozen) setEditingKey(key); }}
            onContextMenu={(event) => openTabMenu(event, tab, index)}
          >
            {frozen ? (
              <Lock className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
            ) : scenarioItem ? (
              <ListChecks className="h-3.5 w-3.5 shrink-0 text-brand-500" />
            ) : (
              <span className={`wb-method !w-auto !text-[9px] ${methodClass(method)}`}>
                {method}
              </span>
            )}
            {editingKey === key ? (
              <InlineRenameInput
                value={name}
                onCommit={(next) => commitRename(tab, next)}
                onCancel={() => setEditingKey(null)}
                className="!w-32"
                ariaLabel={t("request.tabs.rename.aria")}
              />
            ) : (
              <span className="min-w-0 max-w-[140px] truncate">{name}</span>
            )}
            {caseItem && (
              <span className="wb-mini-badge" title={t("request.tabs.badge.case.title")}>
                {t("request.tabs.badge.case")}
              </span>
            )}
            {frozen && (
              <span className="wb-mini-badge" title={t("request.tabs.badge.readonly.title")}>
                {t("request.tabs.badge.readonly")}
              </span>
            )}
            {scenarioItem && (
              <span className="wb-mini-badge" title={t("request.tabs.badge.scenario.title")}>
                {t("request.tabs.badge.scenario", { count: scenarioItem.steps.length })}
              </span>
            )}
            <button
              type="button"
              className="wb-tab-close"
              title={t("request.tabs.close.title")}
              aria-label={t("request.tabs.close.aria")}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab);
              }}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="wb-icon-btn !h-[38px] !w-9 !rounded-none"
        title={t("request.tabs.new.title")}
        aria-label={t("request.tabs.new.aria")}
        onClick={() => newRequest()}
      >
        <Plus className="h-4 w-4" />
      </button>
      <div className="ml-auto hidden shrink-0 items-center gap-2 px-3 text-[10px] text-ink-faint lg:flex">
        <span>{t("request.tabs.shortcut.send")}</span>
        <span>·</span>
        <span>{t("request.tabs.shortcut.save")}</span>
      </div>

      {menu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onMouseDown={() => setMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu(null);
            }}
          />
          <div
            role="menu"
            className="fixed z-50 min-w-[190px] overflow-hidden rounded-md border border-surface-border bg-surface py-1 shadow-xl"
            style={{ left: menu.x, top: menu.y }}
          >
            {menuItem(t("request.tabs.menu.close"), <X className="h-3 w-3 shrink-0 text-ink-faint" />, true, () =>
              closeTab(menu.tab),
            )}
            {menuItem(
              t("request.tabs.menu.closeOthers"),
              <XSquare className="h-3 w-3 shrink-0 text-ink-faint" />,
              items.length > 1,
              () => closeOtherTabs(menu.tab),
            )}
            {menuItem(
              t("request.tabs.menu.closeLeft"),
              <ChevronLeft className="h-3 w-3 shrink-0 text-ink-faint" />,
              menu.index > 0,
              () => closeTabsToLeft(menu.tab),
            )}
            {menuItem(
              t("request.tabs.menu.closeRight"),
              <ChevronRight className="h-3 w-3 shrink-0 text-ink-faint" />,
              menu.index < items.length - 1,
              () => closeTabsToRight(menu.tab),
            )}
            <div className="my-1 border-t border-surface-border" />
            {menuItem(t("request.tabs.menu.closeAll"), <XCircle className="h-3 w-3 shrink-0 text-ink-faint" />, true, () =>
              closeAllTabs(),
            )}
          </div>
        </>
      )}
    </div>
  );
}
