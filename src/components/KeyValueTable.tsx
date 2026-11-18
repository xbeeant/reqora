import { useState } from "react";
import { ListPlus, LockKeyhole, Trash2 } from "lucide-react";
import { isPrivateVariable } from "../lib/privateValues.ts";
import { applyRowEdit, newPlaceholderId } from "../lib/placeholderRow.ts";
import { useT } from "../i18n";
import type { KeyValue } from "../types";
import type { VariableSuggestion } from "../lib/variables.ts";
import { IconButton } from "./ui";
import { VariableInput } from "./VariableInput";

const CELL_CLASS =
  "h-9 w-full border-0 bg-transparent px-2 font-mono text-xs text-ink outline-none placeholder:text-ink-faint focus:bg-brand-50/40";

/** The trailing add-row is local state; see placeholderRow.ts for why its id matters. */
const makeRow = (id: string): KeyValue => ({ id, key: "", value: "", enabled: true });

interface Props {
  items: KeyValue[];
  onChange: (items: KeyValue[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  disabled?: boolean;
  /** When provided, both cells offer `{{` variable autocomplete. */
  suggestions?: readonly VariableSuggestion[];
  /**
   * Show the「私密」control. Only enable for tables whose values can leave
   * this machine (environment variables, global headers, request headers /
   * query rows). See SECURITY.md → "上传脱敏的范围与边界".
   */
  showSecret?: boolean;
  /** When provided, render a "批量编辑" toolbar above the table header. */
  onBulkEdit?: () => void;
}

/** Always keeps one empty "add" row; changes are owned by the parent store. */
export function KeyValueTable({
  items,
  onChange,
  keyPlaceholder = "request.kv.keyPlaceholder.default",
  valuePlaceholder = "request.kv.valuePlaceholder.default",
  disabled = false,
  suggestions = [],
  showSecret = false,
  onBulkEdit,
}: Props) {
  const t = useT();
  const [placeholderId, setPlaceholderId] = useState(() =>
    newPlaceholderId(items.map((item) => item.id)),
  );
  const rows: KeyValue[] = [...items, makeRow(placeholderId)];
  const gridClass = showSecret
    ? "grid-cols-[34px_1fr_1fr_92px_34px]"
    : "grid-cols-[34px_1fr_1fr_34px]";

  const update = (id: string, patch: Partial<KeyValue>) => {
    if (disabled) return;
    const next = applyRowEdit({ items, placeholderId }, id, patch, makeRow);
    onChange(next.items);
    setPlaceholderId(next.placeholderId);
  };

  const remove = (id: string) => {
    onChange(items.filter((item) => item.id !== id));
  };

  // Delete the key entirely when returning to "auto": an explicit
  // `secret: undefined` would change stableStringify and create a fake cloud diff.
  // `secret === true` is the「私密」mark: value stays on this machine, the name
  // still syncs so teammates know what to fill in. See lib/privateValues.ts.
  const setSecret = (id: string, next: boolean | undefined) => {
    if (disabled) return;
    onChange(
      items.map((item) => {
        if (item.id !== id) return item;
        const row = { ...item };
        if (next === undefined) delete row.secret;
        else row.secret = next;
        return row;
      }),
    );
  };

  return (
    <div className="overflow-hidden rounded-md border border-surface-border bg-surface">
      {onBulkEdit && (
        <div className="flex items-center justify-end gap-2 border-b border-surface-border bg-surface-muted px-2 py-1">
          <span className="text-2xs text-ink-faint">
            {t("request.kv.count", { count: items.filter((item) => item.key.trim()).length })}
          </span>
          <button
            type="button"
            className="wb-chip !h-6 !px-2 !text-[10px]"
            title={t("request.kv.bulk.title")}
            onClick={onBulkEdit}
          >
            <ListPlus className="h-3 w-3" />
            {t("request.kv.bulk")}
          </button>
        </div>
      )}
      <div className={`grid ${gridClass} border-b border-surface-border bg-surface-muted text-2xs font-medium text-ink-faint`}>
        <span className="py-1.5 text-center">{t("request.kv.col.enabled")}</span>
        <span className="border-l border-surface-border py-1.5 pl-2">Key</span>
        <span className="border-l border-surface-border py-1.5 pl-2">Value</span>
        {showSecret && (
          <span
            className="flex items-center justify-center gap-1 border-l border-surface-border py-1.5"
            title={t("request.kv.secret.title")}
          >
            <LockKeyhole className="h-3 w-3" />
            {t("request.kv.col.secret")}
          </span>
        )}
        <span />
      </div>

      {rows.map((row) => (
        <div
          key={row.id}
          className={`grid ${gridClass} items-center border-b border-surface-border/70 last:border-b-0`}
        >
          <div className="flex justify-center">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-brand-500"
              checked={row.enabled}
              disabled={disabled}
              aria-label={t("request.kv.col.enabled.aria")}
              onChange={(event) => update(row.id, { enabled: event.target.checked })}
            />
          </div>
          <VariableInput
            className={`${CELL_CLASS} border-l border-surface-border/70`}
            value={row.key}
            onChange={(key) => update(row.id, { key })}
            suggestions={suggestions}
            placeholder={t(keyPlaceholder)}
            ariaLabel={t("request.kv.key.aria")}
            disabled={disabled}
          />
          <VariableInput
            className={`${CELL_CLASS} border-l border-surface-border/70`}
            value={row.value}
            onChange={(value) => update(row.id, { value })}
            suggestions={suggestions}
            placeholder={t(valuePlaceholder)}
            ariaLabel={t("request.kv.value.aria")}
            disabled={disabled}
          />
          {showSecret &&
            (row.id === placeholderId ? (
              <span className="border-l border-surface-border/70" />
            ) : (
              <div
                className={`flex h-9 items-center justify-center gap-1 border-l border-surface-border/70 ${
                  isPrivateVariable(row) ? "bg-amber-50/70" : ""
                }`}
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-brand-500"
                  checked={isPrivateVariable(row)}
                  disabled={disabled}
                  aria-label={t("request.kv.secret.aria", {
                    name: row.key || t("request.kv.secret.unnamed"),
                  })}
                  title={t("request.kv.secret.checked.title")}
                  onChange={(event) =>
                    setSecret(row.id, event.target.checked ? true : undefined)
                  }
                />
                {isPrivateVariable(row) ? (
                  <span className="text-2xs font-medium text-amber-600">{t("request.kv.localOnly")}</span>
                ) : (
                  <button
                    type="button"
                    disabled={disabled}
                    className={`text-2xs transition-colors hover:underline disabled:opacity-50 ${
                      row.secret === false
                        ? "font-medium text-emerald-600"
                        : "text-ink-faint"
                    }`}
                    title={
                      row.secret === false
                        ? t("request.kv.share.title")
                        : t("request.kv.auto.title")
                    }
                    aria-label={t("request.kv.policy.aria", {
                      policy: row.secret === false ? t("request.kv.policy.shared") : t("request.kv.policy.auto"),
                    })}
                    onClick={() =>
                      setSecret(row.id, row.secret === false ? undefined : false)
                    }
                  >
                    {row.secret === false ? t("request.kv.policy.shared") : t("request.kv.policy.auto")}
                  </button>
                )}
              </div>
            ))}
          <div className="flex justify-center">
            {row.id !== placeholderId && (
              <IconButton
                label={t("request.kv.delete")}
                disabled={disabled}
                onClick={() => remove(row.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
