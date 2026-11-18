import { useEffect, useMemo, useState } from "react";
import { Check, Copy, GitMerge, Globe2, Plus, Trash2 } from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { useT } from "../i18n";
import { diffKeyValueLists, type EnvDiffRow } from "../lib/environment";
import { KeyValueTable } from "./KeyValueTable";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  Modal,
  Select,
  inputClass,
} from "./ui";

/** 值为 i18n key。 */
const STATUS_KEYS: Record<EnvDiffRow["status"], string> = {
  "only-source": "modals.env.status.onlySource",
  "only-target": "modals.env.status.onlyTarget",
  different: "modals.env.status.different",
  same: "modals.env.status.same",
};

const STATUS_TONE: Record<EnvDiffRow["status"], "neutral" | "success" | "warning"> = {
  "only-source": "success",
  "only-target": "neutral",
  different: "warning",
  same: "neutral",
};

/** 变量 / 全局 Header 的差异表，勾选后才允许合并。 */
function DiffTable({
  title,
  rows,
  selectedKeys,
  onChange,
}: {
  title: string;
  rows: EnvDiffRow[];
  selectedKeys: string[];
  onChange: (keys: string[]) => void;
}) {
  const t = useT();
  const actionable = rows.filter(
    (row) => row.status !== "only-target" && row.status !== "same",
  );
  const toggle = (key: string) =>
    onChange(
      selectedKeys.includes(key)
        ? selectedKeys.filter((item) => item !== key)
        : [...selectedKeys, key],
    );

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-2xs font-medium text-ink-soft">
          {t("modals.env.mergeableCount", { title, count: actionable.length })}
        </span>
        <button
          type="button"
          className="wb-chip !h-6 !px-2 !text-[10px]"
          disabled={actionable.length === 0}
          onClick={() =>
            onChange(
              actionable.length > 0 && actionable.every((row) => selectedKeys.includes(row.key))
                ? []
                : actionable.map((row) => row.key),
            )
          }
        >
          {t("modals.env.selectAll")}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-surface-border px-3 py-4 text-center text-2xs text-ink-faint">
          {t("modals.env.diffEmpty")}
        </p>
      ) : (
        <div className="scrollbar-thin max-h-52 overflow-auto rounded-md border border-surface-border">
          <table className="wb-table">
            <thead>
              <tr>
                <th className="!w-8" />
                <th>Key</th>
                <th>{t("modals.env.sourceValue")}</th>
                <th>{t("modals.env.targetValue")}</th>
                <th className="!w-20">{t("modals.env.statusHeader")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const selectable = row.status !== "only-target" && row.status !== "same";
                return (
                  <tr key={row.key}>
                    <td>
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-brand-500"
                        disabled={!selectable}
                        checked={selectable && selectedKeys.includes(row.key)}
                        aria-label={t("modals.env.mergeRow", { label: row.label })}
                        onChange={() => toggle(row.key)}
                      />
                    </td>
                    <td className="font-mono text-ink">{row.label}</td>
                    <td className="break-all font-mono text-2xs">{row.sourceValue ?? "—"}</td>
                    <td className="break-all font-mono text-2xs">{row.targetValue ?? "—"}</td>
                    <td>
                      <Badge tone={STATUS_TONE[row.status]}>{t(STATUS_KEYS[row.status])}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function EnvironmentModal() {
  const t = useT();
  const open = useWorkspace((state) => state.environmentModalOpen);
  const setOpen = useWorkspace((state) => state.setEnvironmentModalOpen);
  // 只订阅环境域 + 生效环境 id，快照其他域变化不再触发本弹窗重渲染。
  const environments = useWorkspace((state) => state.snapshot.environments);
  const activeEnvironmentId = useWorkspace((state) => state.snapshot.activeEnvironmentId);
  const addEnvironment = useWorkspace((state) => state.addEnvironment);
  const renameEnvironment = useWorkspace((state) => state.renameEnvironment);
  const deleteEnvironment = useWorkspace((state) => state.deleteEnvironment);
  const duplicateEnvironment = useWorkspace((state) => state.duplicateEnvironment);
  const updateEnvironmentVariables = useWorkspace(
    (state) => state.updateEnvironmentVariables,
  );
  const updateEnvironmentHeaders = useWorkspace((state) => state.updateEnvironmentHeaders);
  const mergeEnvironments = useWorkspace((state) => state.mergeEnvironments);
  const setActiveEnvironment = useWorkspace(
    (state) => state.setActiveEnvironment,
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [mode, setMode] = useState<"edit" | "compare">("edit");
  const [compareSourceId, setCompareSourceId] = useState<string | null>(null);
  const [selectedVariables, setSelectedVariables] = useState<string[]>([]);
  const [selectedHeaders, setSelectedHeaders] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [mergedNote, setMergedNote] = useState("");

  const selected =
    environments.find((environment) => environment.id === selectedId) ??
    environments[0];
  const others = environments.filter((item) => item.id !== selected?.id);
  const source = others.find((item) => item.id === compareSourceId) ?? others[0];
  const pendingEnvironment =
    environments.find((item) => item.id === pendingDelete) ?? null;

  // 每次从外部入口打开都聚焦当前生效的环境（包括刚新建并激活的环境）；
  // 面板内部自行切换选择时不会被这个 effect 覆盖。
  useEffect(() => {
    if (!open) return;
    setSelectedId(
      activeEnvironmentId ?? environments[0]?.id ?? null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 换目标 / 换来源时清掉旧勾选，避免把上一个环境的 key 合并到错误目标。
  useEffect(() => {
    setSelectedVariables([]);
    setSelectedHeaders([]);
    setMergedNote("");
  }, [selected?.id, source?.id, mode]);

  const variableDiff = useMemo(
    () => diffKeyValueLists(source?.variables, selected?.variables),
    [source?.variables, selected?.variables],
  );
  const headerDiff = useMemo(
    () => diffKeyValueLists(source?.headers, selected?.headers, true),
    [source?.headers, selected?.headers],
  );

  const doMerge = () => {
    if (!source || !selected) return;
    const count = selectedVariables.length + selectedHeaders.length;
    mergeEnvironments(source.id, selected.id, {
      variableKeys: selectedVariables,
      headerKeys: selectedHeaders,
      overwrite,
    });
    setSelectedVariables([]);
    setSelectedHeaders([]);
    setMergedNote(t("modals.env.mergedNote", { count, source: source.name, target: selected.name }));
  };

  /** 新建环境后立刻选中它（addEnvironment 会同步把它设为当前环境）。 */
  const createEnvironment = () => {
    addEnvironment();
    setSelectedId(useWorkspace.getState().snapshot.activeEnvironmentId);
  };

  return (
    <Modal
      open={open}
      title={t("modals.env.title")}
      description={t("modals.env.description")}
      onClose={() => setOpen(false)}
      footer={
        <Button variant="primary" onClick={() => setOpen(false)}>
          {t("modals.env.done")}
        </Button>
      }
      width="max-w-4xl"
    >
      <div className="flex min-h-[320px] gap-4">
        <div className="flex w-48 shrink-0 flex-col rounded-md border border-surface-border bg-surface-muted">
          <div className="border-b border-surface-border px-3 py-2 text-2xs font-medium uppercase tracking-wide text-ink-faint">
            {t("modals.env.listHeader")}
          </div>
          <div className="scrollbar-thin flex-1 overflow-y-auto p-1.5">
            {environments.map((environment) => (
              <div
                key={environment.id}
                className={`group flex h-8 items-center gap-1 rounded px-2 text-xs transition-colors ${
                  selected?.id === environment.id
                    ? "bg-surface font-medium text-brand-600 shadow-sm"
                    : "text-ink-soft hover:bg-surface/60"
                }`}
              >
                <button
                  type="button"
                  className="flex-1 truncate text-left"
                  onClick={() => setSelectedId(environment.id)}
                >
                  {environment.name || t("modals.env.unnamed")}
                </button>
                {activeEnvironmentId === environment.id && (
                  <Check className="h-3 w-3 shrink-0 text-emerald-600" />
                )}
                {/* Buttons are always present so hover only changes the row
                    background — no display/padding change, no layout jump. */}
                <IconButton
                  label={t("modals.env.duplicateAria")}
                  className="!h-5 !w-5"
                  onClick={() => duplicateEnvironment(environment.id)}
                >
                  <Copy className="h-3 w-3" />
                </IconButton>
                <IconButton
                  label={t("modals.env.deleteAria")}
                  className="!h-5 !w-5"
                  onClick={() => setPendingDelete(environment.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </IconButton>
              </div>
            ))}
          </div>
          <div className="border-t border-surface-border p-2">
            <Button size="sm" className="w-full" onClick={createEnvironment}>
              <Plus className="h-3.5 w-3.5" />
              {t("modals.env.newEnv")}
            </Button>
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-3 flex items-center gap-2">
            <div className="wb-segment wb-segment-xs shrink-0" role="group" aria-label={t("modals.env.ariaView")}>
              <button
                type="button"
                className={mode === "edit" ? "active" : ""}
                onClick={() => setMode("edit")}
              >
                {t("modals.env.tabEdit")}
              </button>
              <button
                type="button"
                className={mode === "compare" ? "active" : ""}
                onClick={() => setMode("compare")}
              >
                {t("modals.env.tabCompare")}
              </button>
            </div>
            <span className="ml-auto truncate text-2xs text-ink-faint">
              {t("modals.env.target", { name: selected?.name || "—" })}
            </span>
          </div>

          <ConfirmDialog
            open={!!pendingDelete}
            title={t("modals.env.deleteTitle")}
            message={
              t("modals.env.deleteMessage", { name: pendingEnvironment?.name || t("modals.env.unnamed") }) +
              (pendingDelete && activeEnvironmentId === pendingDelete
                ? t("modals.env.deleteMessageActive")
                : "")
            }
            confirmLabel={t("modals.env.deleteTitle")}
            onCancel={() => setPendingDelete(null)}
            onConfirm={() => {
              if (pendingDelete) deleteEnvironment(pendingDelete);
              setPendingDelete(null);
            }}
          />

          {mergedNote && (
            <div className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-2xs text-emerald-700">
              {mergedNote}
            </div>
          )}

          {!selected ? (
            <EmptyState
              title={t("modals.env.emptyTitle")}
              description={t("modals.env.emptyDesc")}
              action={
                <Button size="sm" onClick={createEnvironment}>
                  <Plus className="h-3.5 w-3.5" />
                  {t("modals.env.newEnv")}
                </Button>
              }
            />
          ) : mode === "edit" ? (
            <div className="space-y-4">
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <label className="mb-1 block text-2xs font-medium text-ink-soft">
                    {t("modals.env.nameLabel")}
                  </label>
                  <input
                    className={inputClass}
                    value={selected.name}
                    onChange={(event) =>
                      renameEnvironment(selected.id, event.target.value)
                    }
                  />
                </div>
                <Button
                  size="sm"
                  title={t("modals.env.duplicateTitle")}
                  onClick={() => duplicateEnvironment(selected.id)}
                >
                  <Copy className="h-3.5 w-3.5" />
                  {t("modals.env.duplicate")}
                </Button>
                <Button
                  size="sm"
                  variant={
                    activeEnvironmentId === selected.id
                      ? "secondary"
                      : "primary"
                  }
                  disabled={activeEnvironmentId === selected.id}
                  onClick={() => setActiveEnvironment(selected.id)}
                >
                  {activeEnvironmentId === selected.id
                    ? t("modals.env.currentEnv")
                    : t("modals.env.setCurrent")}
                </Button>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-2xs font-medium text-ink-soft">
                    {t("modals.env.variablesLabel", { count: selected.variables.filter((item) => item.key.trim()).length })}
                  </label>
                  <span className="text-2xs text-ink-faint">
                    {t("modals.env.variablesHint")}
                  </span>
                </div>
                <KeyValueTable
                  items={selected.variables}
                  onChange={(variables) =>
                    updateEnvironmentVariables(selected.id, variables)
                  }
                  keyPlaceholder={t("modals.env.varKeyPlaceholder")}
                  valuePlaceholder={t("modals.env.varValuePlaceholder")}
                  showSecret
                />
                <p className="mt-1.5 text-2xs leading-relaxed text-ink-faint">
                  {t("modals.env.secretHint")}
                </p>
              </div>

              <div className="border-t border-surface-border pt-3">
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="flex items-center gap-1.5 text-2xs font-medium text-ink-soft">
                    <Globe2 className="h-3.5 w-3.5 text-brand-500" />
                    {t("modals.env.headersLabel", { count: (selected.headers ?? []).filter((item) => item.key.trim()).length })}
                  </label>
                  <span className="text-2xs text-ink-faint">
                    {t("modals.env.headersHint")}
                  </span>
                </div>
                <KeyValueTable
                  items={selected.headers ?? []}
                  onChange={(headers) => updateEnvironmentHeaders(selected.id, headers)}
                  keyPlaceholder={t("modals.env.headerKeyPlaceholder")}
                  valuePlaceholder={t("modals.env.headerValuePlaceholder")}
                  showSecret
                />
                <p className="mt-1.5 text-2xs leading-relaxed text-ink-faint">
                  {t("modals.env.headersDesc")}
                </p>
              </div>
            </div>
          ) : others.length === 0 || !source ? (
            <EmptyState
              title={t("modals.env.compareEmptyTitle")}
              description={t("modals.env.compareEmptyDesc")}
              action={<Button size="sm" onClick={createEnvironment}><Plus className="h-3.5 w-3.5" />{t("modals.env.newEnv")}</Button>}
            />
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-2xs font-medium text-ink-soft">{t("modals.env.sourceEnv")}</span>
                <Select
                  className="!h-7 !w-48 !py-0 !text-[11px]"
                  value={source.id}
                  aria-label={t("modals.env.ariaCompareSource")}
                  onChange={(event) => setCompareSourceId(event.target.value)}
                >
                  {others.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name || t("modals.env.unnamed")}
                    </option>
                  ))}
                </Select>
                <span className="text-2xs text-ink-faint">
                  {t("modals.env.mergeInto", { name: selected.name || t("modals.env.unnamed") })}
                </span>
              </div>

              <DiffTable
                title={t("modals.env.variablesDiff")}
                rows={variableDiff}
                selectedKeys={selectedVariables}
                onChange={setSelectedVariables}
              />
              <DiffTable
                title={t("modals.env.headersDiff")}
                rows={headerDiff}
                selectedKeys={selectedHeaders}
                onChange={setSelectedHeaders}
              />

              <div className="flex flex-wrap items-center gap-3 border-t border-surface-border pt-3">
                <label className="flex items-center gap-1.5 text-2xs text-ink-soft">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-brand-500"
                    checked={overwrite}
                    onChange={(event) => setOverwrite(event.target.checked)}
                  />
                  {t("modals.env.overwrite")}
                </label>
                <Button
                  size="sm"
                  variant="primary"
                  className="!ml-auto"
                  disabled={selectedVariables.length + selectedHeaders.length === 0}
                  onClick={doMerge}
                >
                  <GitMerge className="h-3.5 w-3.5" />
                  {t("modals.env.mergeSelected", { count: selectedVariables.length + selectedHeaders.length })}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
