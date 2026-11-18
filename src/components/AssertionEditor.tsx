import { CheckCircle2, Plus, Trash2, XCircle } from "lucide-react";
import { useT } from "../i18n";
import { uid } from "../lib/id";
import type { AssertionResult, AssertionSpec } from "../types";

interface Props {
  items: AssertionSpec[];
  onChange: (items: AssertionSpec[]) => void;
  results?: AssertionResult[];
}

const SOURCES: { value: AssertionSpec["source"]; label: string; pathLabel: string }[] = [
  { value: "status", label: "Status", pathLabel: "—" },
  { value: "json", label: "JSON Body", pathLabel: "$.data.items[0].id" },
  { value: "header", label: "Header", pathLabel: "content-type" },
  { value: "text", label: "Raw Text", pathLabel: "—" },
  { value: "latency", label: "Latency (ms)", pathLabel: "—" },
];

const OPS: { value: AssertionSpec["op"]; labelKey: string; needsValue: boolean }[] = [
  { value: "eq", labelKey: "testing.op.eq", needsValue: true },
  { value: "ne", labelKey: "testing.op.ne", needsValue: true },
  { value: "gt", labelKey: "testing.op.gt", needsValue: true },
  { value: "gte", labelKey: "testing.op.gte", needsValue: true },
  { value: "lt", labelKey: "testing.op.lt", needsValue: true },
  { value: "lte", labelKey: "testing.op.lte", needsValue: true },
  { value: "contains", labelKey: "testing.op.contains", needsValue: true },
  { value: "matches", labelKey: "testing.op.matches", needsValue: true },
  { value: "exists", labelKey: "testing.op.exists", needsValue: false },
];

const QUICK_RULES: { labelKey: string; rule: Omit<AssertionSpec, "id"> }[] = [
  {
    labelKey: "testing.assert.quick.status200",
    rule: { enabled: true, name: "状态码 200", source: "status", path: "$", op: "eq", value: "200" },
  },
  {
    labelKey: "testing.assert.quick.status2xx",
    rule: { enabled: true, name: "响应是 2xx", source: "status", path: "$", op: "lt", value: "400" },
  },
  {
    labelKey: "testing.assert.quick.latency",
    rule: { enabled: true, name: "延迟低于 1000ms", source: "latency", path: "$", op: "lt", value: "1000" },
  },
  {
    labelKey: "testing.assert.quick.json",
    rule: {
      enabled: true,
      name: "Content-Type 是 JSON",
      source: "header",
      path: "content-type",
      op: "contains",
      value: "json",
    },
  },
];

const FIELD =
  "h-8 w-full rounded-md border border-surface-border bg-surface px-2 text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-brand-400 disabled:opacity-40";

/** Declarative checks are plain data; evaluation happens in lib/scripts.ts. */
export function AssertionEditor({ items, onChange, results = [] }: Props) {
  const t = useT();
  const update = (id: string, patch: Partial<AssertionSpec>) =>
    onChange(items.map((item) => (item.id === id ? { ...item, ...patch } : item)));

  const add = (rule?: Omit<AssertionSpec, "id">) =>
    onChange([
      ...items,
      rule
        ? { ...rule, id: uid() }
        : {
            id: uid(),
            enabled: true,
            name: "",
            source: "status",
            path: "$",
            op: "eq",
            value: "200",
          },
    ]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="wb-btn wb-btn-ghost !h-8 !px-3 !text-[11px]" onClick={() => add()}>
          <Plus className="h-3.5 w-3.5" />
          {t("testing.assert.add")}
        </button>
        <span className="text-2xs text-ink-faint">{t("testing.assert.quickAdd")}</span>
        {QUICK_RULES.map((quick) => (
          <button
            key={quick.labelKey}
            type="button"
            className="wb-chip !h-7 !px-2.5 !text-[10px]"
            onClick={() => add(quick.rule)}
          >
            {t(quick.labelKey)}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="wb-hint text-center">
          {t("testing.assert.empty.pre")}
          <strong> Assertions </strong>
          {t("testing.assert.empty.mid")}
          <strong> Tests </strong>
          {t("testing.assert.empty.post")}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item, index) => {
            const source = SOURCES.find((entry) => entry.value === item.source);
            const needsValue = OPS.find((entry) => entry.value === item.op)?.needsValue ?? true;
            const noPath = item.source === "status" || item.source === "latency" || item.source === "text";
            const result = results[index];
            return (
              <div
                key={item.id}
                className={`wb-rule-card ${item.enabled ? "" : "disabled"}`}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 shrink-0 accent-brand-500"
                    checked={item.enabled}
                    aria-label={t("testing.assert.enabled.aria")}
                    onChange={(event) => update(item.id, { enabled: event.target.checked })}
                  />
                  <span className="wb-mini-badge shrink-0">#{index + 1}</span>
                  <input
                    className="min-w-0 flex-1 border-0 bg-transparent px-1 py-1 text-[11.5px] font-medium text-ink outline-none placeholder:text-ink-faint"
                    value={item.name}
                    placeholder={t("testing.assert.name.placeholder")}
                    aria-label={t("testing.assert.name.aria")}
                    onChange={(event) => update(item.id, { name: event.target.value })}
                  />
                  {!item.enabled ? (
                    <span className="wb-tone wb-tone-muted">{t("testing.skipped")}</span>
                  ) : result ? (
                    result.ok ? (
                      <span className="wb-tone wb-tone-ok">
                        <CheckCircle2 className="h-3 w-3" />PASS
                      </span>
                    ) : (
                      <span className="wb-tone wb-tone-danger" title={result.message}>
                        <XCircle className="h-3 w-3" />FAIL
                      </span>
                    )
                  ) : (
                    <span className="text-2xs text-ink-faint">{t("testing.notRun")}</span>
                  )}
                  <button
                    type="button"
                    className="wb-icon-btn !h-6 !w-6"
                    title={t("testing.db.assert.delete")}
                    aria-label={t("testing.db.assert.delete")}
                    onClick={() => onChange(items.filter((entry) => entry.id !== item.id))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="wb-rule-grid">
                  <label>
                    <span className="wb-label">{t("testing.label.source")}</span>
                    <select
                      className={FIELD}
                      value={item.source}
                      aria-label={t("testing.assert.source.aria")}
                      onChange={(event) =>
                        update(item.id, { source: event.target.value as AssertionSpec["source"] })
                      }
                    >
                      {SOURCES.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="wb-label">{t("testing.label.path")}</span>
                    <input
                      className={`${FIELD} font-mono`}
                      value={item.path}
                      disabled={noPath}
                      placeholder={source?.pathLabel ?? t("testing.label.path")}
                      aria-label={t("testing.assert.path.aria")}
                      onChange={(event) => update(item.id, { path: event.target.value })}
                    />
                  </label>
                  <label>
                    <span className="wb-label">{t("testing.label.op")}</span>
                    <select
                      className={FIELD}
                      value={item.op}
                      aria-label={t("testing.assert.op.aria")}
                      onChange={(event) =>
                        update(item.id, { op: event.target.value as AssertionSpec["op"] })
                      }
                    >
                      {OPS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {t(option.labelKey)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="wb-label">{t("testing.label.value")}</span>
                    <input
                      className={`${FIELD} font-mono`}
                      value={item.value}
                      disabled={!needsValue}
                      placeholder={needsValue ? t("testing.assert.value.placeholder") : t("testing.assert.value.none")}
                      aria-label={t("testing.label.value")}
                      onChange={(event) => update(item.id, { value: event.target.value })}
                    />
                  </label>
                </div>

                {result && !result.ok && (
                  <p className="mt-2 text-[10.5px] text-red-600">
                    {t("testing.assert.actual", { value: result.actual })}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="wb-hint">
        {t("testing.assert.hint.pre")}
        <code className="font-mono">$.a.b[0].c</code>
        {t("testing.assert.hint.mid")}
        <strong>FAIL</strong>
        {t("testing.assert.hint.post")}
      </p>
    </div>
  );
}
