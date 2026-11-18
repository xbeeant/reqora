import { useRef, useState } from "react";
import { ListPlus, Paperclip, Trash2, Upload } from "lucide-react";
import { applyRowEdit, newPlaceholderId } from "../lib/placeholderRow.ts";
import { formatBytes, readFileAsBase64 } from "../lib/file";
import { useT } from "../i18n";
import type { FormPart } from "../types";
import type { VariableSuggestion } from "../lib/variables.ts";
import { IconButton } from "./ui";
import { VariableInput } from "./VariableInput";

const CELL_CLASS =
  "h-9 w-full border-0 bg-transparent px-2 font-mono text-xs text-ink outline-none placeholder:text-ink-faint focus:bg-brand-50/40";

interface Props {
  items: FormPart[];
  onChange: (items: FormPart[]) => void;
  disabled?: boolean;
  /** When provided, text field values offer `{{` variable autocomplete. */
  suggestions?: readonly VariableSuggestion[];
  /** When provided, render a "批量编辑" toolbar above the table header. */
  onBulkEdit?: () => void;
}

/** The trailing add-row is local state; see placeholderRow.ts for why its id matters. */
const makePart = (id: string): FormPart => ({
  id,
  key: "",
  value: "",
  enabled: true,
  file: false,
  fileName: "",
  contentType: "",
});

/** Multipart form-data editor: each row is either a text field or a file part. */
export function FormDataEditor({
  items,
  onChange,
  disabled = false,
  suggestions = [],
  onBulkEdit,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const t = useT();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [placeholderId, setPlaceholderId] = useState(() =>
    newPlaceholderId(items.map((item) => item.id)),
  );

  const rows: FormPart[] = [...items, makePart(placeholderId)];

  const update = (id: string, patch: Partial<FormPart>) => {
    if (disabled) return;
    const next = applyRowEdit({ items, placeholderId }, id, patch, makePart);
    onChange(next.items);
    setPlaceholderId(next.placeholderId);
  };

  const remove = (id: string) => onChange(items.filter((item) => item.id !== id));

  const pickFile = async (file: File | undefined, id: string) => {
    if (!file) return;
    const data = await readFileAsBase64(file);
    update(id, {
      value: data,
      fileName: file.name,
      contentType: file.type || "application/octet-stream",
      file: true,
    });
    setPendingId(null);
  };

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-md border border-surface-border bg-surface">
        {onBulkEdit && (
          <div className="flex items-center justify-end gap-2 border-b border-surface-border bg-surface-muted px-2 py-1">
            <span className="text-2xs text-ink-faint">
              {t("request.kv.count", { count: items.filter((item) => item.key.trim()).length })}
            </span>
            <button
              type="button"
              className="wb-chip !h-6 !px-2 !text-[10px]"
              title={t("request.form.bulk.title")}
              onClick={onBulkEdit}
            >
              <ListPlus className="h-3 w-3" />
              {t("request.kv.bulk")}
            </button>
          </div>
        )}
        <div className="grid grid-cols-[34px_1fr_72px_1fr_34px] border-b border-surface-border bg-surface-muted text-2xs font-medium text-ink-faint">
          <span className="py-1.5 text-center">{t("request.kv.col.enabled")}</span>
          <span className="border-l border-surface-border py-1.5 pl-2">Key</span>
          <span className="border-l border-surface-border py-1.5 pl-2">{t("request.form.col.type")}</span>
          <span className="border-l border-surface-border py-1.5 pl-2">{t("request.form.col.value")}</span>
          <span />
        </div>

        {rows.map((row) => {
          const isPlaceholder = row.id === placeholderId;
          const isFile = row.file === true;
          return (
            <div
              key={row.id}
              className="grid grid-cols-[34px_1fr_72px_1fr_34px] items-center border-b border-surface-border/70 last:border-b-0"
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
              <input
                className={`${CELL_CLASS} border-l border-surface-border/70`}
                value={row.key}
                disabled={disabled}
                placeholder={t("request.editor.body.form.keyPlaceholder")}
                onChange={(event) => update(row.id, { key: event.target.value })}
              />
              <div className="border-l border-surface-border/70 px-1">
                <select
                  className={`${CELL_CLASS} !px-1`}
                  value={isFile ? "file" : "text"}
                  disabled={disabled}
                  aria-label={t("request.form.type.aria")}
                  onChange={(event) =>
                    update(
                      row.id,
                      event.target.value === "file"
                        ? { file: true, value: "", fileName: "", contentType: "" }
                        : { file: false, value: "", fileName: "", contentType: "" },
                    )
                  }
                >
                  <option value="text">{t("request.form.type.text")}</option>
                  <option value="file">{t("request.form.type.file")}</option>
                </select>
              </div>
              <div className="flex items-center gap-1 border-l border-surface-border/70 px-2">
                {isFile ? (
                  row.fileName ? (
                    <span className="flex min-w-0 flex-1 items-center gap-1 text-2xs text-ink-soft">
                      <Paperclip className="h-3 w-3 shrink-0" />
                      <span className="truncate" title={row.fileName}>
                        {row.fileName}
                      </span>
                      {row.value && (
                        <span className="shrink-0 text-ink-faint">
                          {formatBytes((row.value.length * 3) / 4)}
                        </span>
                      )}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="wb-chip !h-7 !text-[10px]"
                      disabled={disabled}
                      onClick={() => {
                        setPendingId(row.id);
                        fileInputRef.current?.click();
                      }}
                    >
                      <Upload className="h-3 w-3" />
                      {t("request.form.pickFile")}
                    </button>
                  )
                ) : (
                  <VariableInput
                    className={CELL_CLASS}
                    value={row.value}
                    disabled={disabled}
                    suggestions={suggestions}
                    placeholder={t("request.editor.body.form.valuePlaceholder")}
                    ariaLabel={t("request.form.value.aria")}
                    onChange={(value) => update(row.id, { value })}
                  />
                )}
              </div>
              <div className="flex justify-center">
                {isFile && row.fileName && (
                  <button
                    type="button"
                    className="text-2xs text-ink-faint hover:text-brand-600"
                    disabled={disabled}
                    onClick={() =>
                      update(row.id, {
                        file: false,
                        value: "",
                        fileName: "",
                        contentType: "",
                      })
                    }
                  >
                    {t("request.form.remove")}
                  </button>
                )}
                {!isPlaceholder && !isFile && (
                  <IconButton label={t("request.kv.delete")} disabled={disabled} onClick={() => remove(row.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                )}
                {!isPlaceholder && isFile && !row.fileName && (
                  <IconButton label={t("request.kv.delete")} disabled={disabled} onClick={() => remove(row.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          void pickFile(file, pendingId ?? placeholderId);
          event.target.value = "";
        }}
      />

      <p className="wb-hint">
        {t("request.form.hint.1")}{" "}
        <code className="font-mono">{"{{VAR}}"}</code>
        {t("request.form.hint.2")}{" "}
        <code className="font-mono">multipart/form-data</code>
        {t("request.form.hint.3")}
      </p>
    </div>
  );
}
