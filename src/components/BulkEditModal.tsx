import { useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { Check, Copy, HelpCircle } from "lucide-react";
import {
  MAX_BULK_ROWS,
  applyCaseStyle,
  itemsToBulkText,
  parseBulkText,
  serializeBulkRows,
  type BulkFormat,
  type BulkMode,
  type BulkRow,
  type CaseStyle,
} from "../lib/bulkParams.ts";
import type { KeyValue } from "../types";
import { useT } from "../i18n";
import { Button, Modal, Select, TabButton } from "./ui";

const FORMATS: { value: BulkFormat; labelKey: string; inputKey: string; hintKey: string }[] = [
  {
    value: "kv",
    labelKey: "request.bulk.format.kv.label",
    inputKey: "request.bulk.format.kv.input",
    hintKey: "request.bulk.format.kv.hint",
  },
  {
    value: "json",
    labelKey: "request.bulk.format.json.label",
    inputKey: "request.bulk.format.json.input",
    hintKey: "request.bulk.format.json.hint",
  },
  {
    value: "desc",
    labelKey: "request.bulk.format.desc.label",
    inputKey: "request.bulk.format.desc.input",
    hintKey: "request.bulk.format.desc.hint",
  },
];

const CASE_STYLES: { value: CaseStyle; labelKey: string }[] = [
  { value: "as-is", labelKey: "request.bulk.case.asIs" },
  { value: "camel", labelKey: "request.bulk.case.camel" },
  { value: "pascal", labelKey: "request.bulk.case.pascal" },
  { value: "snake", labelKey: "request.bulk.case.snake" },
];

const MODES: { value: BulkMode; labelKey: string }[] = [
  { value: "replace", labelKey: "request.bulk.mode.replace" },
  { value: "append", labelKey: "request.bulk.mode.append" },
];

interface BulkEditResult {
  rows: BulkRow[];
  caseStyle: CaseStyle;
  mode: BulkMode;
}

interface Props {
  open: boolean;
  /** e.g. "批量编辑 Query 参数" */
  title: string;
  /** Current table rows; the editor opens pre-filled with them. */
  items: KeyValue[];
  onClose: () => void;
  onApply: (result: BulkEditResult) => void;
}

/** Paste many parameters at once instead of adding them row by row. */
export function BulkEditModal({ open, title, items, onClose, onApply }: Props) {
  const t = useT();
  const [text, setText] = useState("");
  const [format, setFormat] = useState<BulkFormat>("kv");
  const [caseStyle, setCaseStyle] = useState<CaseStyle>("as-is");
  const [mode, setMode] = useState<BulkMode>("replace");
  const [copied, setCopied] = useState(false);
  const gutterRef = useRef<HTMLDivElement>(null);
  const openedRef = useRef(false);

  // Seed once per opening; later changes to the table must not wipe the user's
  // in-progress text while the dialog stays open.
  useEffect(() => {
    if (open && !openedRef.current) {
      setText(itemsToBulkText(items));
      setFormat("kv");
      setCaseStyle("as-is");
      setMode("replace");
      setCopied(false);
    }
    openedRef.current = open;
  }, [open, items]);

  const parsed = useMemo(() => parseBulkText(text, format), [text, format]);
  const preview = useMemo(
    () =>
      parsed.rows.map((row) => ({
        ...row,
        key: applyCaseStyle(row.key, caseStyle),
      })),
    [parsed.rows, caseStyle],
  );
  const active = FORMATS.find((entry) => entry.value === format) ?? FORMATS[0];
  const lines = Math.max(1, text.split("\n").length);
  const canApply = !parsed.error && (preview.length > 0 || mode === "replace");

  const switchFormat = (next: BulkFormat) => {
    if (next === format) return;
    // Carry the parsed content over to the new syntax (descriptions are only
    // representable in the "desc" format).
    if (!parsed.error && parsed.rows.length > 0) {
      setText(serializeBulkRows(parsed.rows, next));
    }
    setFormat(next);
  };

  const onScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
  };

  const copy = async () => {
    const payload =
      parsed.error || parsed.rows.length === 0
        ? text
        : serializeBulkRows(parsed.rows, format);
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const apply = () => {
    if (!canApply) return;
    onApply({ rows: parsed.rows, caseStyle, mode });
    onClose();
  };

  return (
    <Modal
      open={open}
      title={t("request.bulk.title")}
      description={title}
      onClose={onClose}
      width="max-w-4xl"
      footer={
        <>
          <span className="mr-auto text-2xs text-ink-faint">
            {parsed.error
              ? t("request.bulk.footer.error")
              : parsed.truncated
                ? t("request.bulk.footer.countTruncated", { count: preview.length, max: MAX_BULK_ROWS })
                : t("request.bulk.footer.count", { count: preview.length })}
          </span>
          <Button size="sm" onClick={onClose}>
            {t("request.editor.cancel")}
          </Button>
          <Button size="sm" onClick={() => void copy()} disabled={!text.trim()}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? t("request.bulk.copied") : t("request.bulk.copy")}
          </Button>
          <Button size="sm" variant="primary" onClick={apply} disabled={!canApply}>
            {t("request.bulk.ok")}
          </Button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-1 border-b border-surface-border">
        {FORMATS.map((entry) => (
          <TabButton
            key={entry.value}
            active={format === entry.value}
            onClick={() => switchFormat(entry.value)}
          >
            {t(entry.labelKey)}
          </TabButton>
        ))}
      </div>

      <div className="wb-bulk-layout">
        <div className="flex min-w-0 flex-col">
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="wb-label !mb-0">{t(active.inputKey)}</span>
            <span title={t(active.hintKey)} className="inline-flex text-ink-faint">
              <HelpCircle className="h-3.5 w-3.5" />
            </span>
            <button
              type="button"
              className="ml-auto text-2xs text-ink-faint hover:text-brand-600"
              onClick={() => setText("")}
            >
              {t("request.bulk.clear")}
            </button>
          </div>
          <div className="wb-bulk-editor">
            <div ref={gutterRef} className="wb-gutter scrollbar-thin" aria-hidden>
              {Array.from({ length: lines }, (_, index) => (
                <div key={index}>{index + 1}</div>
              ))}
            </div>
            <textarea
              className="wb-code scrollbar-thin"
              value={text}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label={t(active.inputKey)}
              placeholder={
                format === "json"
                  ? '{\n  "page": 1,\n  "keyword": "abc"\n}'
                  : format === "desc"
                    ? t("request.bulk.placeholder.desc")
                    : "page: 1\nkeyword: abc"
              }
              onChange={(event) => setText(event.target.value)}
              onScroll={onScroll}
            />
          </div>
          <p className="wb-hint mt-2 !py-2 text-[10px]">{t(active.hintKey)}</p>
          {parsed.error && (
            <p className="mt-1 text-2xs text-red-600">{parsed.error}</p>
          )}
          {parsed.truncated && (
            <p className="mt-1 text-2xs text-amber-700">
              {t("request.bulk.truncated", { max: MAX_BULK_ROWS })}
            </p>
          )}
        </div>

        <div className="flex min-w-0 flex-col">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="wb-label !mb-0">{t("request.bulk.preview")}</span>
            <span className="text-2xs text-ink-faint">{t("request.bulk.preview.cased")}</span>
          </div>
          <div className="wb-bulk-preview scrollbar-thin">
            {preview.length === 0 ? (
              <p className="wb-empty text-2xs text-ink-faint">
                {parsed.error ? t("request.bulk.preview.unparsable") : t("request.bulk.preview.empty")}
              </p>
            ) : (
              <table className="wb-table">
                <thead>
                  <tr>
                    <th>{t("request.bulk.col.key")}</th>
                    <th>{t("request.bulk.col.value")}</th>
                    <th>{t("request.bulk.col.desc")}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.slice(0, 100).map((row, index) => (
                    <tr key={`${row.key}:${index}`}>
                      <td className="font-mono text-brand-600" title={row.key}>
                        <div className="max-w-[160px] truncate">{row.key}</div>
                      </td>
                      <td className="font-mono" title={row.value}>
                        <div className="max-w-[160px] truncate">
                          {row.value || <span className="text-ink-faint">{t("request.bulk.emptyValue")}</span>}
                        </div>
                      </td>
                      <td title={row.description}>
                        <div className="max-w-[160px] truncate">
                          {row.description || <span className="text-ink-faint">—</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {preview.length > 100 && (
              <p className="px-3 py-2 text-2xs text-ink-faint">
                {t("request.bulk.preview.truncated", { count: preview.length })}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-surface-border pt-3">
        <label className="flex items-center gap-2 text-2xs text-ink-soft">
          {t("request.bulk.caseStyle.label")}
          <Select
            className="!h-8 !w-40 !py-0 !text-[11px]"
            value={caseStyle}
            aria-label={t("request.bulk.caseStyle.label")}
            onChange={(event) => setCaseStyle(event.target.value as CaseStyle)}
          >
            {CASE_STYLES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {t(entry.labelKey)}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2 text-2xs text-ink-soft">
          {t("request.bulk.mode.label")}
          <Select
            className="!h-8 !w-40 !py-0 !text-[11px]"
            value={mode}
            aria-label={t("request.bulk.mode.label")}
            onChange={(event) => setMode(event.target.value as BulkMode)}
          >
            {MODES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {t(entry.labelKey)}
              </option>
            ))}
          </Select>
        </label>
        <span className="text-2xs text-ink-faint">
          {t("request.bulk.note")}
        </span>
      </div>
    </Modal>
  );
}
