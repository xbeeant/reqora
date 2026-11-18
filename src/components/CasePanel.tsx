import { useMemo, useState } from "react";
import { Copy, Play, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { useT } from "../i18n";
import { countByGroup, isCaseStale, sortCases } from "../lib/cases.ts";
import { CASE_GROUPS } from "../types.ts";
import type { CaseGroup } from "../types";
import { Button, Select, InlineRenameInput, inputClass } from "./ui";

/**
 * Apifox-style single-interface test-case panel: group chips with counts,
 * a flat sortable list, per-case run/open/copy/delete and run-all.
 */
export function CasePanel() {
  const t = useT();
  // 只订阅 cases 域：快照其他域变化不再触发本面板重渲染。
  const allCases = useWorkspace((state) => state.snapshot.cases);
  const draft = useWorkspace((state) => state.draft);
  const activeTab = useWorkspace((state) => state.activeTab);
  const runningCaseIds = useWorkspace((state) => state.runningCaseIds);
  const addCase = useWorkspace((state) => state.addCase);
  const updateCase = useWorkspace((state) => state.updateCase);
  const deleteCase = useWorkspace((state) => state.deleteCase);
  const duplicateCase = useWorkspace((state) => state.duplicateCase);
  const syncCase = useWorkspace((state) => state.syncCase);
  const runCase = useWorkspace((state) => state.runCase);
  const runCases = useWorkspace((state) => state.runCases);
  const openTab = useWorkspace((state) => state.openTab);
  const saveDraftAsCase = useWorkspace((state) => state.saveDraftAsCase);

  const [groupFilter, setGroupFilter] = useState<"全部" | CaseGroup>("全部");
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const cases = useMemo(
    () => allCases.filter((item) => item.requestId === draft.id),
    [allCases, draft.id],
  );
  const counts = countByGroup(cases);
  const total = cases.length;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sortCases(cases).filter(
      (item) =>
        (groupFilter === "全部" || item.group === groupFilter) &&
        (!needle || `${item.name} ${item.description ?? ""}`.toLowerCase().includes(needle)),
    );
  }, [cases, groupFilter, query]);

  const stale = cases.some((item) => isCaseStale(item, draft));

  const addWith = (group: CaseGroup) => {
    const id = addCase(draft.id, `用例 ${total + 1} · ${group}`, group);
    if (id) {
      // Open the new case in an editor tab right away (Apifox behaviour).
      openTab({ kind: "case", id });
    }
  };

  const quickAdd = () => {
    // Save the live debug state (whatever is on screen right now) as a case.
    const id = saveDraftAsCase(`用例 ${total + 1}`);
    if (id) openTab({ kind: "case", id });
  };

  const runnableIds = cases.filter((item) => item.enabled).map((item) => item.id);

  return (
    <div className="wb-case scrollbar-thin">
      <div className="wb-case-toolbar">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className={`wb-chip !h-7 !px-2.5 ${groupFilter === "全部" ? "!bg-brand-50 !text-brand-600 dark:!bg-brand-500/15 dark:!text-brand-300" : ""}`}
            onClick={() => setGroupFilter("全部")}
          >
            {t("testing.filter.all")} <span className="ml-1 font-mono">{total}</span>
          </button>
          {CASE_GROUPS.map((group) => (
            <button
              key={group}
              type="button"
              className={`wb-chip !h-7 !px-2.5 ${groupFilter === group ? "!bg-brand-50 !text-brand-600 dark:!bg-brand-500/15 dark:!text-brand-300" : ""}`}
              onClick={() => setGroupFilter(group)}
            >
              {group} <span className="ml-1 font-mono">{counts[group]}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="wb-sidebar-search !h-7 !w-44">
            <Search className="h-3 w-3 shrink-0" />
            <input
              value={query}
              placeholder={t("testing.search.placeholder")}
              aria-label={t("testing.search.aria")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={runnableIds.length === 0}
            title={t("testing.runAll.title")}
            onClick={() => void runCases(runnableIds)}
          >
            <Play className="h-3.5 w-3.5" />
            {t("testing.runAll")}
          </Button>
          <Button size="sm" variant="primary" onClick={quickAdd}>
            <Plus className="h-3.5 w-3.5" />
            {t("testing.addCase")}
          </Button>
        </div>
      </div>

      {stale && (
        <div className="wb-banner wb-banner-warn mx-4 mt-3">
          <span className="flex-1">{t("testing.staleBanner")}</span>
        </div>
      )}

      {total === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="text-sm text-ink-soft">{t("testing.empty.title")}</p>
          <p className="max-w-[380px] text-xs text-ink-faint">
            {t("testing.empty.desc")}
          </p>
          <div className="flex gap-2">
            {CASE_GROUPS.map((group) => (
              <Button key={group} size="sm" variant="ghost" onClick={() => addWith(group)}>
                <Plus className="h-3.5 w-3.5" />
                {group}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <table className="wb-case-table">
          <thead>
            <tr>
              <th>{t("testing.col.name")}</th>
              <th className="!w-28">{t("testing.col.group")}</th>
              <th className="!w-24">{t("testing.col.expectedStatus")}</th>
              <th className="!w-40">{t("testing.col.lastRun")}</th>
              <th className="!w-32 text-right">{t("testing.col.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((caseItem) => {
              const staleCase = isCaseStale(caseItem, draft);
              const running = runningCaseIds.includes(caseItem.id);
              const run = caseItem.lastRun;
              return (
                <tr
                  key={caseItem.id}
                  className={activeTab?.kind === "case" && activeTab.id === caseItem.id ? "active" : ""}
                  onClick={() => openTab({ kind: "case", id: caseItem.id })}
                >
                  <td>
                    <div className="flex items-center gap-2">
                      {renamingId === caseItem.id ? (
                        <InlineRenameInput
                          value={caseItem.name}
                          onCommit={(next) => {
                            updateCase(caseItem.id, { name: next });
                            setRenamingId(null);
                          }}
                          onCancel={() => setRenamingId(null)}
                          className="!w-44"
                          ariaLabel={t("testing.renameCase.aria")}
                        />
                      ) : (
                        <span
                          className="min-w-0 max-w-[260px] cursor-text truncate text-[12px] font-medium text-ink"
                          title={t("testing.renameHint")}
                          onDoubleClick={(event) => {
                            event.stopPropagation();
                            setRenamingId(caseItem.id);
                          }}
                        >
                          {caseItem.name}
                        </span>
                      )}
                      {staleCase && (
                        <span className="wb-mini-badge !text-amber-600" title={t("testing.staleBadge.title")}>
                          {t("testing.staleBadge")}
                        </span>
                      )}
                      {run && (
                        <span className={`wb-case-pill ${run.ok ? "ok" : "fail"}`}>
                          {run.ok
                            ? t("testing.result.pass")
                            : run.failed > 0
                              ? t("testing.assertFailCount", { count: run.failed })
                              : run.status ?? "ERR"}
                        </span>
                      )}
                    </div>
                    {caseItem.description && (
                      <div className="mt-0.5 max-w-[300px] truncate text-2xs text-ink-faint">
                        {caseItem.description}
                      </div>
                    )}
                  </td>
                  <td onClick={(event) => event.stopPropagation()}>
                    <Select
                      className="!h-7 !py-0 !text-[11px]"
                      value={caseItem.group}
                      aria-label={t("testing.caseGroup.aria")}
                      onChange={(event) =>
                        updateCase(caseItem.id, { group: event.target.value as CaseGroup })
                      }
                    >
                      {CASE_GROUPS.map((group) => (
                        <option key={group} value={group}>{group}</option>
                      ))}
                    </Select>
                  </td>
                  <td onClick={(event) => event.stopPropagation()}>
                    <input
                      className={`${inputClass} !h-7 !w-16 !py-0 font-mono !text-[11px]`}
                      value={caseItem.expectedStatus ?? ""}
                      placeholder={t("testing.expectedStatus.auto")}
                      aria-label={t("testing.col.expectedStatus")}
                      onChange={(event) => {
                        const raw = event.target.value.trim();
                        const status = raw ? Number.parseInt(raw, 10) : undefined;
                        updateCase(caseItem.id, {
                          expectedStatus:
                            status !== undefined && Number.isFinite(status) ? status : undefined,
                        });
                      }}
                    />
                  </td>
                  <td>
                    {running ? (
                      <span className="text-2xs text-brand-500">{t("testing.running")}</span>
                    ) : run ? (
                      <span className="text-2xs text-ink-faint">
                        {new Date(run.at).toLocaleTimeString("zh-CN")} · {run.status ?? "ERR"} · {run.timeMs}ms
                      </span>
                    ) : (
                      <span className="text-2xs text-ink-faint">{t("testing.notRun")}</span>
                    )}
                  </td>
                  <td className="text-right" onClick={(event) => event.stopPropagation()}>
                    <div className="flex items-center justify-end gap-0.5">
                      {staleCase && (
                        <button
                          type="button"
                          className="wb-icon-btn !h-6 !w-6"
                          title={t("testing.sync.title")}
                          aria-label={t("testing.sync.title")}
                          onClick={() => syncCase(caseItem.id)}
                        >
                          <RefreshCw className="h-3.5 w-3.5 text-amber-500" />
                        </button>
                      )}
                      <button
                        type="button"
                        className="wb-icon-btn !h-6 !w-6"
                        title={t("testing.runCase.title")}
                        aria-label={t("testing.runCase.title")}
                        onClick={() => void runCase(caseItem.id)}
                      >
                        <Play className={`h-3.5 w-3.5 ${running ? "animate-pulse text-brand-500" : ""}`} />
                      </button>
                      <button
                        type="button"
                        className="wb-icon-btn !h-6 !w-6"
                        title={t("testing.openCase.title")}
                        aria-label={t("testing.openCase.title")}
                        onClick={() => openTab({ kind: "case", id: caseItem.id })}
                      >
                        <Search className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className="wb-icon-btn !h-6 !w-6"
                        title={t("testing.duplicateCase.title")}
                        aria-label={t("testing.duplicateCase.title")}
                        onClick={() => duplicateCase(caseItem.id)}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className="wb-icon-btn !h-6 !w-6"
                        title={t("testing.deleteCase.title")}
                        aria-label={t("testing.deleteCase.title")}
                        onClick={() => deleteCase(caseItem.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {visible.length === 0 && total > 0 && (
        <p className="p-6 text-center text-xs text-ink-faint">{t("testing.noMatch")}</p>
      )}

      <div className="wb-case-foot">
        <span className="text-2xs text-ink-faint">
          {t("testing.foot", { total })}
        </span>
      </div>
    </div>
  );
}
