import { Layers, Play, Plus, Trash2 } from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { useT } from "../i18n";
import { suiteItemName } from "../lib/suite.ts";
import type { SuiteItem, SuiteItemResult } from "../types";
import { Button, EmptyState, Select, inputClass } from "./ui";

const KIND_LABEL: Record<SuiteItem["kind"], string> = {
  case: "testing.kind.case",
  scenario: "testing.kind.scenario",
};

/**
 * 测试套件编辑器（P0-4）：组合用例 / 场景为一次批量回归，逐项顺序执行，
 * 汇总通过 / 失败并写入套件的最近运行报告。
 */
export function SuitePanel({ suiteId }: { suiteId: string }) {
  const t = useT();
  const suite = useWorkspace((state) =>
    (state.snapshot.suites ?? []).find((item) => item.id === suiteId),
  );
  const cases = useWorkspace((state) => state.snapshot.cases);
  const scenarios = useWorkspace((state) => state.snapshot.scenarios);
  const updateSuite = useWorkspace((state) => state.updateSuite);
  const deleteSuite = useWorkspace((state) => state.deleteSuite);
  const addSuiteItem = useWorkspace((state) => state.addSuiteItem);
  const removeSuiteItem = useWorkspace((state) => state.removeSuiteItem);
  const runSuite = useWorkspace((state) => state.runSuite);
  const running = useWorkspace((state) => state.runningSuiteId === suiteId);
  const openTab = useWorkspace((state) => state.openTab);

  if (!suite) return null;
  const run = suite.lastRun;

  return (
    <div className="wb-scenario scrollbar-thin">
      <div className="wb-scenario-toolbar">
        <Layers className="h-4 w-4 shrink-0 text-brand-500" />
        <input
          className={`${inputClass} !h-8 !w-64 !py-0 !text-[13px] font-medium`}
          value={suite.name}
          aria-label={t("testing.suite.name.aria")}
          onChange={(event) => updateSuite(suiteId, { name: event.target.value })}
        />
        <input
          className={`${inputClass} !h-8 !min-w-0 flex-1 !py-0 !text-[11px]`}
          value={suite.description ?? ""}
          placeholder={t("testing.suite.desc.placeholder")}
          aria-label={t("testing.suite.desc.aria")}
          onChange={(event) => updateSuite(suiteId, { description: event.target.value })}
        />
        <Button
          size="sm"
          variant="primary"
          disabled={running || suite.items.length === 0}
          onClick={() => void runSuite(suiteId)}
        >
          <Play className={`h-3.5 w-3.5 ${running ? "animate-pulse" : ""}`} />
          {running ? t("testing.running") : t("testing.suite.run")}
        </Button>
        <Button
          size="sm"
          variant="danger"
          onClick={() => {
            deleteSuite(suiteId);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("testing.suite.delete")}
        </Button>
      </div>

      <div className="flex flex-col gap-1.5 p-4">
        {suite.items.length === 0 ? (
          <EmptyState
            icon={<Layers className="h-7 w-7" />}
            title={t("testing.suite.empty.title")}
            description={t("testing.suite.empty.desc")}
          />
        ) : (
          suite.items.map((item, index) => {
            const name = suiteItemName(item, cases, scenarios);
            const dangling = name === null;
            return (
              <div
                key={item.id}
                className="wb-scenario-step flex items-center gap-2"
                style={{ padding: "6px 10px" }}
              >
                <span className="wb-scenario-index">{index + 1}</span>
                <span className="wb-mini-badge">{t(KIND_LABEL[item.kind])}</span>
                {dangling ? (
                  <span className="min-w-0 flex-1 text-2xs text-red-500">
                    {t("testing.suite.dangling", { kind: t(KIND_LABEL[item.kind]) })}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-[12px] text-ink hover:text-brand-600"
                    onClick={() => openTab({ kind: item.kind === "case" ? "case" : "scenario", id: item.refId })}
                  >
                    {name}
                  </button>
                )}
                {!dangling && run && (
                  <SuiteItemBadge
                    result={run.items.find((candidate) => candidate.itemId === item.id)}
                  />
                )}
                <button
                  type="button"
                  className="wb-icon-btn !h-6 !w-6"
                  title={t("testing.suite.remove")}
                  aria-label={t("testing.suite.remove")}
                  onClick={() => removeSuiteItem(suiteId, item.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="wb-scenario-add">
        <span className="text-2xs text-ink-faint">{t("testing.suite.addMember")}</span>
        <Select
          className="!h-7 !w-56 !py-0 !text-[11px]"
          value=""
          aria-label={t("testing.suite.addCase.aria")}
          onChange={(event) => {
            if (event.target.value) addSuiteItem(suiteId, "case", event.target.value);
          }}
        >
          <option value="">{t("testing.selectCase")}</option>
          {cases.map((caseItem) => (
            <option key={caseItem.id} value={caseItem.id}>
              {t("testing.caseOption", { name: caseItem.name, group: caseItem.group })}
            </option>
          ))}
        </Select>
        <Select
          className="!h-7 !w-56 !py-0 !text-[11px]"
          value=""
          aria-label={t("testing.suite.addScenario.aria")}
          onChange={(event) => {
            if (event.target.value) addSuiteItem(suiteId, "scenario", event.target.value);
          }}
        >
          <option value="">{t("testing.selectScenario")}</option>
          {scenarios.map((scenario) => (
            <option key={scenario.id} value={scenario.id}>
              {t("testing.scenarioOption", { name: scenario.name, count: scenario.steps.length })}
            </option>
          ))}
        </Select>
        <span className="ml-auto text-2xs text-ink-faint">
          {t("testing.suite.memberCount", { count: suite.items.length })}
        </span>
      </div>

      {run && (
        <div className="wb-scenario-report">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-ink">{t("testing.col.lastRun")}</span>
            <span className="text-2xs text-ink-faint">
              {t("testing.viewRun.meta", {
                at: new Date(run.at).toLocaleString("zh-CN"),
                ms: run.timeMs,
              })}
            </span>
            <span className={`wb-case-pill ${run.failed > 0 ? "fail" : "ok"}`}>
              {run.failed > 0
                ? t("testing.runStat.fail", { count: run.failed })
                : t("testing.runStat.pass", { passed: run.passed, total: run.total })}
              {run.skipped > 0 ? ` · ${t("testing.runStat.skipped", { count: run.skipped })}` : ""}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => updateSuite(suiteId, { lastRun: undefined })}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("testing.clearReport")}
            </Button>
          </div>
          <table className="wb-case-table mt-2">
            <thead>
              <tr>
                <th>#</th>
                <th>{t("testing.col.member")}</th>
                <th className="!w-16">{t("testing.col.type")}</th>
                <th className="!w-24">{t("testing.col.result")}</th>
                <th className="!w-20">{t("testing.col.duration")}</th>
                <th>{t("testing.col.error")}</th>
              </tr>
            </thead>
            <tbody>
              {run.items.map((item, index) => (
                <tr key={item.itemId} className={item.ok || item.skipped ? "" : "wb-step-fail"}>
                  <td className="font-mono text-ink-faint">{index + 1}</td>
                  <td className="text-[12px] font-medium text-ink">{item.name}</td>
                  <td className="text-2xs text-ink-soft">{t(KIND_LABEL[item.kind])}</td>
                  <td className="font-mono">
                    {item.skipped
                      ? t("testing.skipped")
                      : item.ok
                        ? t("testing.result.pass")
                        : t("testing.result.failed")}
                  </td>
                  <td className="font-mono">{item.timeMs}ms</td>
                  <td className="min-w-0 text-2xs text-red-500">{item.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="wb-case-foot">
        <Plus className="h-3.5 w-3.5 text-ink-faint" />
        <span className="text-2xs text-ink-faint">
          {t("testing.suite.foot")}
        </span>
      </div>
    </div>
  );
}

/** 套件成员最近一次在套件运行中的结果徽标。 */
function SuiteItemBadge({ result }: { result: SuiteItemResult | undefined }) {
  const t = useT();
  if (!result) return null;
  return (
    <span
      className={`wb-case-pill ${result.skipped ? "" : result.ok ? "ok" : "fail"} !text-[10px]`}
    >
      {result.skipped
        ? t("testing.skipped")
        : result.ok
          ? t("testing.result.pass")
          : t("testing.result.failed")}
    </span>
  );
}
