import { useState } from "react";
import { RotateCcw, Trash2, X } from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { useT } from "../i18n";
import type { TrashEntry } from "../types";
import { ConfirmDialog } from "./ConfirmDialog";
import { Badge, Button, Modal } from "./ui";

function entryTitle(t: ReturnType<typeof useT>, entry: TrashEntry): { label: string; type: string; detail: string } {
  const payload = entry.payload;
  if (payload.kind === "request") {
    return {
      label: payload.request.name,
      type: t("modals.trash.type.request"),
      detail: payload.collectionName ? t("modals.trash.fromCollection", { name: payload.collectionName }) : "",
    };
  }
  if (payload.kind === "case") {
    return { label: payload.caseItem.name, type: t("modals.trash.type.case"), detail: "" };
  }
  return { label: payload.scenario.name, type: t("modals.trash.type.scenario"), detail: "" };
}

function formatWhen(t: ReturnType<typeof useT>, ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return t("modals.trash.justNow");
  if (diff < 3_600_000) return t("modals.trash.minutesAgo", { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("modals.trash.hoursAgo", { count: Math.floor(diff / 3_600_000) });
  return new Date(ms).toLocaleString();
}

/** Recycle bin: recently deleted requests / cases / scenarios, restorable. */
export function TrashModal() {
  const t = useT();
  const open = useWorkspace((state) => state.trashModalOpen);
  const setOpen = useWorkspace((state) => state.setTrashModalOpen);
  const entries = useWorkspace((state) => state.snapshot.trash ?? []);
  const restoreFromTrash = useWorkspace((state) => state.restoreFromTrash);
  const deleteTrashEntry = useWorkspace((state) => state.deleteTrashEntry);
  const emptyTrash = useWorkspace((state) => state.emptyTrash);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  const close = () => {
    setConfirmEmpty(false);
    setOpen(false);
  };

  // Newest first for display.
  const ordered = [...entries].reverse();

  return (
    <Modal
      open={open}
      title={t("modals.trash.title")}
      description={t("modals.trash.description")}
      onClose={close}
      width="max-w-xl"
      footer={
        entries.length > 0 ? (
          <div className="flex items-center gap-2">
            <Button onClick={() => setConfirmEmpty(true)}>{t("modals.trash.emptyAll")}</Button>
            <Button variant="primary" onClick={close}>
              {t("modals.trash.done")}
            </Button>
          </div>
        ) : (
          <Button variant="primary" onClick={close}>
            {t("modals.trash.done")}
          </Button>
        )
      }
    >
      {ordered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-ink-faint">
          <Trash2 className="h-8 w-8 opacity-40" />
          <p className="text-xs">{t("modals.trash.empty")}</p>
        </div>
      ) : (
        <ul className="divide-y divide-surface-border">
          {ordered.map((entry) => {
            const info = entryTitle(t, entry);
            return (
              <li key={entry.id} className="flex items-center gap-2.5 py-2">
                <Badge>{info.type}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-ink">{info.label}</div>
                  <div className="text-2xs text-ink-faint">
                    {formatWhen(t, entry.deletedAt)}
                    {info.detail && ` · ${info.detail}`}
                  </div>
                </div>
                <button
                  type="button"
                  className="wb-icon-btn !h-6 !w-6"
                  title={t("modals.trash.restoreTitle")}
                  aria-label={t("modals.trash.restoreAria", { name: info.label })}
                  onClick={() => restoreFromTrash(entry.id)}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="wb-icon-btn !h-6 !w-6 hover:!text-red-500"
                  title={t("modals.trash.deleteTitle")}
                  aria-label={t("modals.trash.deleteAria", { name: info.label })}
                  onClick={() => deleteTrashEntry(entry.id)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={confirmEmpty}
        title={t("modals.trash.emptyAll")}
        message={t("modals.trash.emptyMessage", { count: entries.length })}
        confirmLabel={t("modals.trash.emptyConfirm")}
        onCancel={() => setConfirmEmpty(false)}
        onConfirm={() => {
          emptyTrash();
          setConfirmEmpty(false);
        }}
      />
    </Modal>
  );
}
