/**
 * 字段级冲突合并弹窗。
 *
 * 数据来自 SyncConflictRecord 的一条 entry（base / local / remote 三份完整行），
 * 合并逻辑全部在 lib/fieldMerge.ts 的纯函数里：弹窗只负责渲染选择点、维护
 * 选择状态、实时预览合成行，最后把「一条普通的行」交给 store 落地。
 */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  composeMergedRow,
  defaultSelections,
  planFieldMerge,
  uniformSelections,
  type FieldChoice,
  type FieldSelection,
  type FieldSelections,
} from "../lib/fieldMerge.ts";
import type { SyncConflictEntry } from "../lib/cloudSync.ts";
import type { ThreeWayConflict } from "../lib/workspaceRows.ts";
import { useT } from "../i18n";
import { Button, Modal } from "./ui";

/** 值为 i18n key。 */
const DOMAIN_KEYS: Record<string, string> = {
  folders: "modals.conflict.domain.folders",
  requests: "modals.conflict.domain.requests",
  environments: "modals.conflict.domain.environments",
  cases: "modals.conflict.domain.cases",
  scenarios: "modals.conflict.domain.scenarios",
  suites: "modals.conflict.domain.suites",
  artifacts: "modals.conflict.domain.artifacts",
};

/** 值为 i18n key。 */
const KIND_KEYS: Record<FieldChoice["kind"], string> = {
  scalar: "modals.conflict.kind.scalar",
  text: "modals.conflict.kind.text",
  blob: "modals.conflict.kind.blob",
  "delete-vs-edit": "modals.conflict.kind.deleteVsEdit",
  row: "modals.conflict.kind.row",
};

function blobHash(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const hash = (value as Record<string, unknown>).__blob;
  return typeof hash === "string" ? hash : null;
}

/** 展示值：大对象只显示引用，长文本截断，绝不把 MB 级内容铺进 DOM。 */
function displayValue(t: ReturnType<typeof useT>, value: unknown): string {
  if (value === undefined || value === null) return t("modals.conflict.valueNone");
  const hash = blobHash(value);
  if (hash) return t("modals.conflict.valueBlob", { hash: hash.slice(0, 16) });
  if (typeof value === "string") return value.length > 800 ? `${value.slice(0, 800)}…` : value;
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > 800 ? `${text.slice(0, 800)}…` : text;
  } catch {
    return String(value);
  }
}

function rawText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

function SourceButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2 py-0.5 text-2xs font-medium transition-colors ${
        active
          ? "border-brand-400 bg-brand-50 text-brand-700"
          : "border-surface-border bg-surface text-ink-faint hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function ChoiceCard({
  choice,
  selection,
  onChange,
}: {
  choice: FieldChoice;
  selection: FieldSelection | undefined;
  onChange: (next: FieldSelection) => void;
}) {
  const t = useT();
  const source = selection?.source ?? choice.defaultSource;
  const isText = choice.kind === "text";
  const isRow = choice.kind === "row";
  const editableValue = source === "remote" ? choice.remote : choice.local;
  const customText = selection?.custom ?? rawText(editableValue);

  return (
    <div className="rounded-md border border-surface-border bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink" title={choice.label}>
          {choice.label}
        </span>
        <span className="shrink-0 rounded bg-surface-sunken px-1.5 py-0.5 text-2xs text-ink-faint">
          {t(KIND_KEYS[choice.kind])}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <SourceButton active={source === "local"} onClick={() => onChange({ source: "local" })}>
            {isRow ? t("modals.conflict.keepLocal") : t("modals.conflict.local")}
          </SourceButton>
          <SourceButton active={source === "remote"} onClick={() => onChange({ source: "remote" })}>
            {isRow ? t("modals.conflict.followCloud") : t("modals.conflict.cloud")}
          </SourceButton>
        </div>
      </div>

      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
        <div
          className={`rounded border px-2 py-1.5 ${
            source === "local" ? "border-brand-200 bg-brand-50/60" : "border-surface-border"
          }`}
        >
          <p className="mb-0.5 text-2xs font-medium text-ink-faint">{t("modals.conflict.localVersion")}</p>
          <pre className="scrollbar-thin max-h-24 overflow-auto whitespace-pre-wrap break-all text-2xs text-ink">
            {displayValue(t, choice.local)}
          </pre>
        </div>
        <div
          className={`rounded border px-2 py-1.5 ${
            source === "remote" ? "border-brand-200 bg-brand-50/60" : "border-surface-border"
          }`}
        >
          <p className="mb-0.5 text-2xs font-medium text-ink-faint">{t("modals.conflict.cloudVersion")}</p>
          <pre className="scrollbar-thin max-h-24 overflow-auto whitespace-pre-wrap break-all text-2xs text-ink">
            {displayValue(t, choice.remote)}
          </pre>
        </div>
      </div>

      {isText && (
        <div className="mt-2">
          <label className="mb-1 flex items-center gap-2 text-2xs text-ink-faint">
            <span>{t("modals.conflict.editCustom")}</span>
            {source === "custom" && <span className="text-brand-600">{t("modals.conflict.usingCustom")}</span>}
          </label>
          <textarea
            className="scrollbar-thin h-24 w-full resize-y rounded border border-surface-border bg-surface px-2 py-1 font-mono text-2xs text-ink focus:border-brand-400 focus:outline-none"
            value={customText}
            spellCheck={false}
            onChange={(event) => onChange({ source: "custom", custom: event.target.value })}
            onFocus={() => {
              if (source !== "custom") onChange({ source: "custom", custom: customText });
            }}
          />
        </div>
      )}
      {choice.kind === "blob" && (
        <p className="mt-1.5 text-2xs text-ink-faint">
          {t("modals.conflict.blobNote")}
        </p>
      )}
    </div>
  );
}

export function ConflictMergeModal({
  entry,
  busy,
  onClose,
  onApply,
}: {
  entry: SyncConflictEntry | null;
  busy: boolean;
  onClose: () => void;
  onApply: (row: Record<string, unknown> | null) => void;
}) {
  const t = useT();
  const plan = useMemo(() => {
    if (!entry) return null;
    return planFieldMerge({
      domain: entry.domain as ThreeWayConflict["domain"],
      id: entry.id,
      name: entry.name,
      base: entry.base,
      local: entry.local,
      remote: entry.remote,
    });
  }, [entry]);

  // 父组件按冲突条目给弹窗加 key：切换条目时整个组件重新挂载，选择状态
  // 天然隔离；同一条目在编辑期间被 store 刷新也不会清空用户已做的选择。
  const [selections, setSelections] = useState<FieldSelections>(() =>
    plan ? defaultSelections(plan) : {},
  );

  const preview = useMemo(
    () => (plan ? composeMergedRow(plan, selections) : null),
    [plan, selections],
  );
  const previewText = useMemo(() => {
    if (!plan) return "";
    if (!preview) return t("modals.conflict.rowDeleted");
    try {
      return JSON.stringify(preview, null, 2);
    } catch {
      return String(preview);
    }
  }, [plan, preview, t]);

  const setChoice = (path: string, next: FieldSelection) =>
    setSelections((current) => ({ ...current, [path]: next }));

  const decisionCount = plan?.choices.length ?? 0;
  const customCount = Object.values(selections).filter((item) => item.source === "custom").length;

  return (
    <Modal
      open={Boolean(entry && plan)}
      title={t("modals.conflict.title", {
        domain: entry && DOMAIN_KEYS[entry.domain] ? t(DOMAIN_KEYS[entry.domain]) : entry?.domain ?? "",
        name: entry?.name ?? "",
      })}
      description={
        plan?.mode === "whole-row"
          ? plan.wholeRowReason ?? undefined
          : t("modals.conflict.descAuto", { auto: plan?.autoFields ?? 0, count: decisionCount })
      }
      width="max-w-4xl"
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-2xs text-ink-faint">
            {plan?.mode === "fields" && customCount > 0 ? t("modals.conflict.footerCustom", { count: customCount }) : ""}
            {t("modals.conflict.footerNote")}
          </span>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
            {t("modals.importExport.cancel")}
          </Button>
          <Button size="sm" variant="primary" disabled={busy || !plan} onClick={() => onApply(preview)}>
            {busy ? t("modals.conflict.applying") : t("modals.conflict.apply")}
          </Button>
        </>
      }
    >
      {plan && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-surface-border bg-surface-muted px-3 py-2">
            <span className="text-2xs text-ink-faint">{t("modals.conflict.batchSelect")}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelections(uniformSelections(plan, "local"))}
            >
              {t("modals.conflict.allLocal")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelections(uniformSelections(plan, "remote"))}
            >
              {t("modals.conflict.allCloud")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelections(defaultSelections(plan))}>
              {t("modals.conflict.reset")}
            </Button>
            {plan.structural.length > 0 && (
              <span className="ml-auto text-2xs text-ink-faint" title={plan.structural.join("、")}>
                {t("modals.conflict.structural", { count: plan.structural.length })}
              </span>
            )}
          </div>

          {decisionCount === 0 ? (
            <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              {t("modals.conflict.noConflicts")}
            </p>
          ) : (
            <div className="space-y-2">
              {plan.choices.map((choice) => (
                <ChoiceCard
                  key={choice.path}
                  choice={choice}
                  selection={selections[choice.path]}
                  onChange={(next) => setChoice(choice.path, next)}
                />
              ))}
            </div>
          )}

          <details className="rounded-md border border-surface-border bg-surface-muted">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink">
              {t("modals.conflict.previewSummary")}
            </summary>
            <pre className="scrollbar-thin max-h-64 overflow-auto border-t border-surface-border px-3 py-2 font-mono text-2xs text-ink">
              {previewText}
            </pre>
          </details>
        </div>
      )}
    </Modal>
  );
}
