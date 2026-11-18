import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, BookOpen, Plus, Trash2 } from "lucide-react";
import { useT } from "../i18n";
import { useWorkspace } from "../store/workspace";
import { DOC_PAGE_GROUPS, newErrorCodeRow, slugifyDocTitle } from "../lib/docPages.ts";
import type { DocPage, DocPageGroup, ErrorCodeRow } from "../types";
import { MarkdownView } from "./MarkdownView";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button, IconButton, Modal, inputClass } from "./ui";

type ErrorField = "code" | "httpStatus" | "message" | "description" | "solution";

const ERROR_FIELDS: { key: ErrorField; labelKey?: string; label: string; width: string }[] = [
  { key: "code", labelKey: "tools.pages.field.code", label: "错误码", width: "w-24" },
  { key: "httpStatus", labelKey: "tools.pages.field.http", label: "HTTP", width: "w-16" },
  { key: "message", labelKey: "tools.pages.field.message", label: "说明", width: "w-32" },
  { key: "description", labelKey: "tools.pages.field.description", label: "描述", width: "w-40" },
  { key: "solution", labelKey: "tools.pages.field.solution", label: "处理建议", width: "w-40" },
];

/**
 * 工作区级公共文档章节：鉴权逻辑、接入流程、错误码、更新日志。
 * 与单接口「文档」标签并列，随工作区持久化、参与云同步，并在
 * 静态 HTML 导出 / Markdown 导出 / 桌面端预览 / 网页版中共同呈现。
 */
export function DocPagesModal() {
  const t = useT();
  const open = useWorkspace((state) => state.docPagesModalOpen);
  const focusId = useWorkspace((state) => state.docPagesFocusId);
  const closeDocPages = useWorkspace((state) => state.closeDocPages);
  // 保留模板里原有的 onClose 命名，避免把整份 JSX 改一遍。
  const onClose = closeDocPages;
  const rawPages = useWorkspace((state) => state.snapshot.docPages);
  const addDocPage = useWorkspace((state) => state.addDocPage);
  const addBuiltinDocPages = useWorkspace((state) => state.addBuiltinDocPages);
  const updateDocPage = useWorkspace((state) => state.updateDocPage);
  const deleteDocPage = useWorkspace((state) => state.deleteDocPage);
  const moveDocPage = useWorkspace((state) => state.moveDocPage);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // 侧栏点某个章节进来时聚焦它。closeDocPages 会把 focusId 清空，
  // 因此下次再点同一章节仍能重新触发（依赖数组不会卡住）。
  useEffect(() => {
    if (open && focusId) setSelectedId(focusId);
  }, [open, focusId]);

  const pages = useMemo(() => rawPages ?? [], [rawPages]);
  const selected = pages.find((page) => page.id === selectedId) ?? pages[0] ?? null;
  const rows = selected?.errorCodes ?? [];

  const patch = (changes: Partial<Omit<DocPage, "id">>) => {
    if (selected) updateDocPage(selected.id, changes);
  };

  const patchRow = (id: string, field: ErrorField, value: string) => {
    if (!selected) return;
    patch({
      errorCodes: rows.map((row) =>
        row.id === id ? ({ ...row, [field]: value } as ErrorCodeRow) : row,
      ),
    });
  };

  const create = (group: DocPageGroup) => {
    addDocPage(group);
    const next = useWorkspace.getState().snapshot.docPages ?? [];
    setSelectedId(next[next.length - 1]?.id ?? null);
    setTab("edit");
  };

  const remove = (id: string) => {
    const index = pages.findIndex((page) => page.id === id);
    deleteDocPage(id);
    const next = pages[index + 1] ?? pages[index - 1];
    setSelectedId(next?.id ?? null);
    setConfirmDelete(null);
  };

  return (
    <Modal
      open={open}
      title={t("tools.pages.title")}
      description={t("tools.pages.desc")}
      onClose={onClose}
      width="max-w-6xl"
      footer={<Button variant="primary" onClick={onClose}>{t("tools.common.done")}</Button>}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => create(selected?.group ?? "guide")}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t("tools.pages.newChapter")}
        </Button>
        <Button size="sm" variant="secondary" onClick={addBuiltinDocPages}>
          <BookOpen className="mr-1 h-3.5 w-3.5" />
          {t("tools.pages.loadBuiltin")}
        </Button>
        <span className="wb-hint !ml-auto">{t("tools.pages.builtinHint")}</span>
      </div>

      <div className="wb-docpages-layout">
        <aside className="wb-docpages-list scrollbar-thin">
          {pages.length === 0 ? (
            <p className="wb-hint !m-2">{t("tools.pages.empty")}</p>
          ) : (
            pages.map((page, index) => (
              <div
                key={page.id}
                className={`wb-docpages-item ${selected?.id === page.id ? "active" : ""}`}
              >
                <button type="button" className="wb-docpages-item-name" onClick={() => setSelectedId(page.id)}>
                  <span className="wb-mini-badge">
                    {DOC_PAGE_GROUPS.find((group) => group.id === page.group)?.label ?? t("tools.pages.groupGuide")}
                  </span>
                  <span className="truncate">{page.title || t("tools.pages.untitled")}</span>
                  <small>#{page.slug}</small>
                </button>
                <div className="wb-docpages-item-actions">
                  <IconButton
                    label={t("tools.pages.moveUp")}
                    disabled={index === 0}
                    onClick={() => moveDocPage(page.id, -1)}
                  >
                    <ArrowUp className="h-3 w-3" />
                  </IconButton>
                  <IconButton
                    label={t("tools.pages.moveDown")}
                    disabled={index === pages.length - 1}
                    onClick={() => moveDocPage(page.id, 1)}
                  >
                    <ArrowDown className="h-3 w-3" />
                  </IconButton>
                  <IconButton label={t("tools.pages.deleteChapter")} onClick={() => setConfirmDelete(page.id)}>
                    <Trash2 className="h-3 w-3" />
                  </IconButton>
                </div>
              </div>
            ))
          )}
        </aside>

        <section className="wb-docpages-editor scrollbar-thin">
          {!selected ? (
            <div className="wb-empty">
              <div className="wb-empty-title">{t("tools.pages.emptyTitle")}</div>
              <p>{t("tools.pages.emptyDesc")}</p>
            </div>
          ) : (
            <>
              <div className="wb-segment mb-3 !w-fit">
                <button type="button" className={tab === "edit" ? "active" : ""} onClick={() => setTab("edit")}>
                  {t("tools.common.edit")}
                </button>
                <button type="button" className={tab === "preview" ? "active" : ""} onClick={() => setTab("preview")}>
                  {t("tools.pages.preview")}
                </button>
              </div>

              {tab === "edit" ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="wb-label mb-1 block">{t("tools.pages.titleLabel")}</span>
                      <input
                        className={inputClass}
                        value={selected.title}
                        placeholder={t("tools.pages.titlePlaceholder")}
                        onChange={(event) => patch({ title: event.target.value })}
                      />
                    </label>
                    <label className="block">
                      <span className="wb-label mb-1 block">{t("tools.pages.slugLabel")}</span>
                      <input
                        className={inputClass}
                        value={selected.slug}
                        placeholder="auth"
                        onChange={(event) => patch({ slug: event.target.value })}
                        onBlur={(event) =>
                          patch({
                            slug: slugifyDocTitle(event.target.value, selected?.slug ?? "section"),
                          })
                        }
                      />
                    </label>
                  </div>

                  <div>
                    <span className="wb-label mb-1 block">{t("tools.pages.groupLabel")}</span>
                    <div className="wb-segment !w-fit">
                      {DOC_PAGE_GROUPS.map((group) => (
                        <button
                          key={group.id}
                          type="button"
                          className={selected.group === group.id ? "active" : ""}
                          onClick={() => patch({ group: group.id })}
                        >
                          {group.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <label className="block">
                    <span className="wb-label mb-1 block">{t("tools.pages.bodyLabel")}</span>
                    <textarea
                      className={`${inputClass} h-52 resize-y font-mono text-[11px] leading-relaxed`}
                      value={selected.body}
                      placeholder={t("tools.pages.bodyPlaceholder")}
                      onChange={(event) => patch({ body: event.target.value })}
                    />
                  </label>

                  <div>
                    <div className="mb-1 flex items-center gap-2">
                      <span className="wb-label">{t("tools.pages.errorCodes")}</span>
                      <Button size="sm" variant="ghost" onClick={() => patch({ errorCodes: [...rows, newErrorCodeRow()] })}>
                        <Plus className="mr-1 h-3 w-3" />
                        {t("tools.pages.addRow")}
                      </Button>
                    </div>
                    {rows.length > 0 ? (
                      <div className="wb-docpages-codes scrollbar-thin">
                        <div className="wb-docpages-code-row wb-docpages-code-head">
                          {ERROR_FIELDS.map((field) => (
                            <span key={field.key} className={field.width}>{field.labelKey ? t(field.labelKey) : field.label}</span>
                          ))}
                          <span />
                        </div>
                        {rows.map((row) => (
                          <div className="wb-docpages-code-row" key={row.id}>
                            {ERROR_FIELDS.map((field) => (
                              <input
                                key={field.key}
                                className={`${inputClass} ${field.width} !h-7 !px-1.5 !py-0 !text-[11px]`}
                                aria-label={field.labelKey ? t(field.labelKey) : field.label}
                                value={row[field.key]}
                                onChange={(event) => patchRow(row.id, field.key, event.target.value)}
                              />
                            ))}
                            <IconButton
                              label={t("tools.pages.deleteRow")}
                              onClick={() => patch({ errorCodes: rows.filter((item) => item.id !== row.id) })}
                            >
                              <Trash2 className="h-3 w-3" />
                            </IconButton>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="wb-docpages-preview">
                  <h2 className="wb-docpages-preview-title">{selected.title || t("tools.pages.untitled")}</h2>
                  <MarkdownView text={selected.body} emptyHint={t("tools.pages.emptyBody")} />
                  {rows.some((row) => row.code.trim() || row.message.trim()) ? (
                    <>
                      <h4 className="wb-docsite-subhead">{t("tools.pages.codeTable")}</h4>
                      <table className="wb-doc-table">
                        <thead>
                          <tr>{ERROR_FIELDS.map((field) => <th key={field.key}>{field.labelKey ? t(field.labelKey) : field.label}</th>)}</tr>
                        </thead>
                        <tbody>
                          {rows
                            .filter((row) => row.code.trim() || row.message.trim() || row.description.trim())
                            .map((row) => (
                              <tr key={row.id}>
                                {ERROR_FIELDS.map((field) => <td key={field.key}>{row[field.key]}</td>)}
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </>
                  ) : null}
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={t("tools.pages.deleteTitle")}
        message={t("tools.pages.deleteMsg", {
          title:
            pages.find((page) => page.id === confirmDelete)?.title || t("tools.pages.untitled"),
        })}
        confirmLabel={t("tools.pages.deleteConfirm")}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) remove(confirmDelete);
        }}
      />
    </Modal>
  );
}
