import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Copy, FileCode2, Plus, RotateCcw, Trash2 } from "lucide-react";
import {
  buildCodeTemplateContext,
  CODE_TEMPLATE_TOKENS,
  renderCodeTemplate,
  type CodeTemplateTokenHint,
} from "../lib/codeTemplate";
import { resolveRequestAuth } from "../lib/auth.ts";
import { variablesFrom } from "../lib/template";
import { useT } from "../i18n";
import { useWorkspace } from "../store/workspace";
import { Button, EmptyState, IconButton, Modal, inputClass } from "./ui";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * 自定义「复制代码」模板管理：用项目自己的封装类替换内置生成器。
 * 模板随工作区持久化，可在「代码」Tab 里直接选用并复制渲染结果。
 */
export function CodeTemplateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const templates = useWorkspace((state) => state.snapshot.codeTemplates);
  const environments = useWorkspace((state) => state.snapshot.environments);
  const collections = useWorkspace((state) => state.snapshot.collections);
  const cases = useWorkspace((state) => state.snapshot.cases);
  const activeEnvironmentId = useWorkspace((state) => state.snapshot.activeEnvironmentId);
  const draft = useWorkspace((state) => state.draft);
  const addCodeTemplate = useWorkspace((state) => state.addCodeTemplate);
  const addBuiltinCodeTemplates = useWorkspace((state) => state.addBuiltinCodeTemplates);
  const updateCodeTemplate = useWorkspace((state) => state.updateCodeTemplate);
  const deleteCodeTemplate = useWorkspace((state) => state.deleteCodeTemplate);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLTextAreaElement>(null);
  // 预览可编辑：保存用户改过的副本；渲染结果变化时（换模板 / 改请求）重置。
  const [previewDraft, setPreviewDraft] = useState<string | null>(null);

  const list = templates ?? [];
  const selected = list.find((item) => item.id === selectedId) ?? list[0];

  useEffect(() => {
    if (!open) return;
    const current = templates ?? [];
    if (!selectedId || !current.some((item) => item.id === selectedId)) {
      setSelectedId(current[0]?.id ?? null);
    }
  }, [open, selectedId, templates]);

  const variables = useMemo(() => {
    const environment = environments.find((item) => item.id === activeEnvironmentId);
    return variablesFrom(environment?.variables ?? []);
  }, [environments, activeEnvironmentId]);

  const context = useMemo(() => {
    // A case tab holds a request copy with a fresh id; pass `cases` so the
    // preview resolves collection auth inheritance the same way sending does.
    const resolved = resolveRequestAuth(draft, collections, undefined, cases);
    return buildCodeTemplateContext(resolved, variables);
  }, [draft, collections, cases, variables]);
  const preview = useMemo(
    () => (selected ? renderCodeTemplate(selected.content, context) : null),
    [selected, context],
  );

  useEffect(() => {
    setPreviewDraft(null);
  }, [selected?.id, preview?.code]);

  const create = () => {
    addCodeTemplate();
    const next = useWorkspace.getState().snapshot.codeTemplates ?? [];
    setSelectedId(next[next.length - 1]?.id ?? null);
    setConfirmDelete(null);
  };

  const insertToken = (hint: CodeTemplateTokenHint) => {
    if (!selected) return;
    const el = contentRef.current;
    const text = hint.insert ?? hint.token;
    const start = el?.selectionStart ?? selected.content.length;
    const end = el?.selectionEnd ?? start;
    updateCodeTemplate(selected.id, {
      content: selected.content.slice(0, start) + text + selected.content.slice(end),
    });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const previewText = previewDraft ?? preview?.code ?? "";
  const previewDirty = previewDraft !== null && previewDraft !== preview?.code;

  // 高度自适应：先归零再取 scrollHeight，随内容增减，上限由 CSS 控制。
  useLayoutEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [previewText, open]);

  const copyPreview = async () => {
    if (!previewText) return;
    try {
      await navigator.clipboard.writeText(previewText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t("tools.tmpl.title")}
      description={t("tools.tmpl.desc")}
      onClose={onClose}
      width="max-w-5xl"
      footer={<Button variant="primary" onClick={onClose}>{t("tools.common.done")}</Button>}
    >
      <div className="flex min-h-[430px] gap-4">
        <aside className="flex w-52 shrink-0 flex-col rounded-md border border-surface-border bg-surface-muted">
          <div className="border-b border-surface-border px-3 py-2 text-2xs font-medium uppercase tracking-wide text-ink-faint">
            {t("tools.tmpl.count", { count: list.length })}
          </div>
          <div className="scrollbar-thin flex-1 space-y-0.5 overflow-y-auto p-1.5">
            {list.map((item) => (
              <div
                key={item.id}
                className={`group flex items-center gap-1 rounded px-2 py-1.5 text-xs ${
                  selected?.id === item.id
                    ? "bg-surface font-medium text-brand-600 shadow-sm"
                    : "text-ink-soft hover:bg-surface/60"
                }`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left"
                  onClick={() => {
                    setSelectedId(item.id);
                    setConfirmDelete(null);
                  }}
                  title={item.description || item.name}
                >
                  {item.name || t("tools.tmpl.untitled")}
                </button>
                {item.language && (
                  <span className="wb-mini-badge shrink-0">{item.language}</span>
                )}
                <IconButton
                  label={t("tools.tmpl.delete")}
                  className="hidden group-hover:inline-flex"
                  onClick={() => {
                    setSelectedId(item.id);
                    setConfirmDelete(item.id);
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </IconButton>
              </div>
            ))}
            {list.length === 0 && (
              <p className="px-2 py-3 text-2xs leading-relaxed text-ink-faint">
                {t("tools.tmpl.emptySidebar")}
              </p>
            )}
          </div>
          <div className="space-y-1.5 border-t border-surface-border p-2">
            <Button size="sm" className="w-full" onClick={create}>
              <Plus className="h-3.5 w-3.5" />
              {t("tools.tmpl.new")}
            </Button>
            <Button size="sm" className="w-full" onClick={addBuiltinCodeTemplates} title={t("tools.tmpl.loadExamplesTip")}>
              <RotateCcw className="h-3.5 w-3.5" />
              {t("tools.tmpl.loadExamples")}
            </Button>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          {!selected ? (
            <EmptyState
              icon={<FileCode2 className="h-7 w-7" />}
              title={t("tools.tmpl.emptyTitle")}
              description={t("tools.tmpl.emptyDesc")}
              action={<Button size="sm" onClick={create}><Plus className="h-3.5 w-3.5" />{t("tools.tmpl.new")}</Button>}
            />
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <label className="col-span-2 block">
                  <span className="mb-1 block text-2xs font-medium text-ink-soft">{t("tools.tmpl.name")}</span>
                  <input
                    className={inputClass}
                    value={selected.name}
                    onChange={(event) => updateCodeTemplate(selected.id, { name: event.target.value })}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-2xs font-medium text-ink-soft">{t("tools.tmpl.language")}</span>
                  <input
                    className={inputClass}
                    placeholder="TypeScript"
                    value={selected.language ?? ""}
                    onChange={(event) => updateCodeTemplate(selected.id, { language: event.target.value })}
                  />
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-2xs font-medium text-ink-soft">{t("tools.tmpl.descLabel")}</span>
                <input
                  className={inputClass}
                  placeholder={t("tools.tmpl.descPlaceholder")}
                  value={selected.description}
                  onChange={(event) => updateCodeTemplate(selected.id, { description: event.target.value })}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-2xs font-medium text-ink-soft">{t("tools.tmpl.content")}</span>
                <textarea
                  ref={contentRef}
                  className={`${inputClass} h-44 resize-y font-mono text-[11px] leading-relaxed`}
                  spellCheck={false}
                  value={selected.content}
                  onChange={(event) => updateCodeTemplate(selected.id, { content: event.target.value })}
                />
              </label>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-2xs font-medium text-ink-soft">{t("tools.tmpl.tokens")}</span>
                  <span className="text-2xs text-ink-faint">
                    {t("tools.tmpl.syntaxHint")}
                  </span>
                </div>
                <div className="scrollbar-thin flex max-h-24 flex-wrap gap-1 overflow-y-auto rounded-md border border-surface-border bg-surface-muted p-2">
                  {CODE_TEMPLATE_TOKENS.map((hint) => (
                    <button
                      key={hint.token}
                      type="button"
                      className="wb-chip !h-6 !px-1.5 !font-mono !text-[9.5px]"
                      title={hint.description}
                      onClick={() => insertToken(hint)}
                    >
                      {hint.token}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-2xs font-medium text-ink-soft">
                    {t("tools.tmpl.preview")}
                    {previewDirty && (
                      <span className="ml-1 text-amber-600">· {t("tools.tmpl.previewEdited")}</span>
                    )}
                  </span>
                  <div className="flex items-center gap-1">
                    {previewDirty && (
                      <button
                        type="button"
                        className="wb-chip !h-6 !px-2 !text-[10px]"
                        onClick={() => setPreviewDraft(null)}
                      >
                        <RotateCcw className="h-3 w-3" />
                        {t("tools.tmpl.resetPreview")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="wb-chip !h-6 !px-2 !text-[10px]"
                      onClick={() => void copyPreview()}
                      disabled={!previewText}
                    >
                      <Copy className="h-3 w-3" />
                      {copied ? t("tools.common.copied") : t("tools.tmpl.copyPreview")}
                    </button>
                  </div>
                </div>
                {preview && preview.unknownTokens.length > 0 && (
                  <p className="mb-1 text-2xs text-amber-600">
                    {t("tools.tmpl.unknownTokens", { tokens: preview.unknownTokens.join("、") })}
                  </p>
                )}
                <textarea
                  ref={previewRef}
                  className="wb-preview-editor scrollbar-thin w-full resize-none rounded-md border border-surface-border bg-surface-muted p-2 font-mono text-[10.5px] leading-relaxed text-ink outline-none focus:border-accent"
                  value={previewText}
                  placeholder={t("tools.tmpl.emptyPreview")}
                  spellCheck={false}
                  onChange={(event) => setPreviewDraft(event.target.value)}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={t("tools.tmpl.deleteTitle")}
        message={t("tools.tmpl.deleteMsg", {
          name: list.find((item) => item.id === confirmDelete)?.name || t("tools.tmpl.untitled"),
        })}
        confirmLabel={t("tools.tmpl.deleteConfirm")}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) deleteCodeTemplate(confirmDelete);
          setSelectedId(null);
          setConfirmDelete(null);
        }}
      />
    </Modal>
  );
}
