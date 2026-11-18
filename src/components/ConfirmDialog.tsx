import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";
import { useT } from "../i18n";
import { Button } from "./ui";

/**
 * Lightweight confirmation dialog. Rendered into document.body with a higher
 * z-index than the shared `Modal` (z-50), so it can be used from inside another
 * modal without being clipped by overflow rules or competing on DOM order.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onCancel]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-6 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm rounded-xl border border-surface-border bg-surface p-5 shadow-panel"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600">
            <AlertTriangle className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-soft">{message}</p>
          </div>
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            {cancelLabel ?? t("shell.cancel")}
          </Button>
          <Button type="button" size="sm" variant="danger" onClick={onConfirm}>
            {confirmLabel ?? t("shell.delete")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
