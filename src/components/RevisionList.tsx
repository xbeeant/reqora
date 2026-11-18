/**
 * Revision history for the interface currently occupying the centre area.
 * Rows open as frozen interface tabs instead of replacing the editor's draft,
 * so an unsaved request is never lost while browsing old versions. Reverting
 * and clearing stay on the editable interface tab; a frozen tab only inspects.
 */
import { History, RotateCcw, Trash2 } from "lucide-react";
import { useT } from "../i18n";
import { useWorkspace } from "../store/workspace";
import { revisionDiff } from "../lib/revisions.ts";
import { EMPTY_REVISIONS } from "../lib/defaults.ts";
import type { RequestRevision } from "../types";
import { Button, EmptyState } from "./ui";

export function RevisionList({
  subjectId,
  readOnly = false,
}: {
  subjectId: string | null;
  readOnly?: boolean;
}) {
  const t = useT();
  const collections = useWorkspace((state) => state.snapshot.collections);
  const revisions = useWorkspace((state) => state.snapshot.revisions ?? EMPTY_REVISIONS);
  const draft = useWorkspace((state) => state.draft);
  const tabs = useWorkspace((state) => state.tabs);
  const openRevisionTab = useWorkspace((state) => state.openRevisionTab);
  const revert = useWorkspace((state) => state.revertRequestToRevision);
  const clearRevisions = useWorkspace((state) => state.clearRequestRevisions);

  const raw = subjectId ? revisions[subjectId] : [];
  const list: RequestRevision[] = Array.isArray(raw) ? raw : [];
  // Compare against the saved request, not the shared draft: on a frozen tab
  // the draft is the snapshot itself and would make every diff meaningless.
  const current = subjectId
    ? collections.flatMap((item) => item.items).find((item) => item.id === subjectId) ?? draft
    : draft;
  const opened = new Set(
    tabs.filter((tab) => tab.kind === "revision").map((tab) => tab.id),
  );

  return (
    <div className="wb-run-history">
      <div className="wb-run-history-head">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-ink">
            {t("modals.revisions.title", { name: current.name || draft.name })}
          </h3>
          <p className="wb-hint !mt-0">
            {readOnly
              ? t("request.revisions.readonlyHint")
              : t("modals.revisions.description")}
          </p>
        </div>
        <span className="wb-mini-badge">
          {t("request.revisions.count", { count: list.length })}
        </span>
        {!readOnly && subjectId && list.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => clearRevisions(subjectId)}>
            <Trash2 className="h-3 w-3" />
            {t("modals.revisions.clear")}
          </Button>
        )}
      </div>

      <div className="wb-run-history-body scrollbar-thin">
        {list.length === 0 ? (
          <EmptyState
            icon={<History className="h-7 w-7" />}
            title={t("modals.revisions.emptyTitle")}
            description={t("modals.revisions.emptyDesc")}
          />
        ) : (
          list.map((revision) => {
            const changes = revisionDiff(current, revision.snapshot);
            return (
              <div
                key={revision.id}
                className={`wb-revision-row ${opened.has(revision.id) ? "selected" : ""}`}
              >
                <button
                  type="button"
                  className="wb-revision-open"
                  title={t("request.revisions.openRow")}
                  onClick={() => openRevisionTab(revision.id)}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold text-ink">
                      {new Date(revision.at).toLocaleString("zh-CN")}
                    </span>
                    <span className="wb-mini-badge">
                      {revision.snapshot.method} {revision.snapshot.url || t("modals.revisions.noUrl")}
                    </span>
                    {opened.has(revision.id) && (
                      <span className="wb-mini-badge">{t("request.history.opened")}</span>
                    )}
                  </div>
                  {changes.length > 0 ? (
                    <ul className="mt-1 list-disc pl-5 text-2xs text-ink-soft">
                      {changes.map((change) => (
                        <li key={change}>{t("modals.revisions.change", { change })}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-2xs text-ink-faint">{t("modals.revisions.same")}</p>
                  )}
                </button>
                {!readOnly && subjectId && (
                  <div className="wb-revision-actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => revert(subjectId, revision.id)}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      {t("modals.revisions.revert")}
                    </Button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
