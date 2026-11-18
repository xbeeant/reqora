import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, PanelRightClose, Sparkles } from "lucide-react";
import { useT } from "../i18n";
import { useWorkspace } from "../store/workspace";
import { MethodBadge, Button, IconButton, Spinner, inputClass } from "./ui";

/**
 * AI 生成接口：右侧对话面板（非模态，不遮挡工作区）。
 * 自然语言描述 → LLM → 请求草稿 → 一键导入当前集合。
 * 由 TopBar 的「AI 生成」按钮切换显示/隐藏；隐藏只是收起，输入内容与草稿都会保留。
 * 模型服务在设置里配置（OpenAI 兼容 /chat/completions）。
 */
export function AiGeneratePanel() {
  const t = useT();
  const open = useWorkspace((state) => state.aiModalOpen);
  const setOpen = useWorkspace((state) => state.setAiModalOpen);
  const aiBusy = useWorkspace((state) => state.aiBusy);
  const aiError = useWorkspace((state) => state.aiError);
  const aiDraft = useWorkspace((state) => state.aiDraft);
  const aiGenerate = useWorkspace((state) => state.aiGenerate);
  const importAiDraft = useWorkspace((state) => state.importAiDraft);
  const discardAiDraft = useWorkspace((state) => state.discardAiDraft);
  const settings = useWorkspace((state) => state.snapshot.settings);

  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);

  const configured = Boolean(settings.aiBaseUrl && settings.aiModel);
  const canGenerate = !aiBusy && configured && Boolean(description.trim());

  // Keep the latest reply in view whenever the conversation grows.
  useEffect(() => {
    if (open && threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [open, prompt, aiBusy, aiError, aiDraft]);

  if (!open) return null;

  const submit = () => {
    if (!canGenerate) return;
    setPrompt(description.trim());
    void aiGenerate(description);
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <aside id="wb-ai-panel" className="wb-ai-panel" aria-label={t("tools.ai.title")}>
      <header className="wb-ai-head">
        <span className="wb-ai-avatar">
          <Sparkles className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xs font-semibold text-ink">{t("tools.ai.title")}</h2>
          <p className="truncate text-2xs text-ink-faint">{t("tools.ai.panelSubtitle")}</p>
        </div>
        <IconButton label={t("tools.ai.hide")} onClick={() => setOpen(false)}>
          <PanelRightClose className="h-4 w-4" />
        </IconButton>
      </header>

      <div ref={threadRef} className="wb-ai-thread scrollbar-thin">
        <div className="wb-ai-row">
          <div className="wb-ai-bubble wb-ai-bubble-assistant">
            <p className="text-xs leading-relaxed text-ink-soft">{t("tools.ai.desc")}</p>
          </div>
        </div>

        {!configured && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            {t("tools.ai.notConfigured")}
          </div>
        )}

        {prompt && (
          <div className="wb-ai-row wb-ai-row-user">
            <div className="wb-ai-bubble wb-ai-bubble-user whitespace-pre-wrap break-words text-xs leading-relaxed">
              {prompt}
            </div>
          </div>
        )}

        {aiBusy && (
          <div className="wb-ai-row">
            <div className="wb-ai-bubble wb-ai-bubble-assistant inline-flex items-center gap-2 text-xs text-ink-soft">
              <Spinner className="h-3.5 w-3.5" />
              {t("tools.ai.generating")}
            </div>
          </div>
        )}

        {aiError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {aiError}
          </div>
        )}

        {aiDraft && (
          <div className="wb-ai-row">
            <div className="wb-ai-bubble wb-ai-bubble-assistant w-full min-w-0 space-y-2">
              <p className="text-xs text-ink-soft">{t("tools.ai.draftReady")}</p>

              <div className="rounded-lg border border-surface-border bg-surface p-2.5">
                <div className="flex items-center gap-2">
                  <MethodBadge method={aiDraft.method} />
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
                    {aiDraft.name}
                  </span>
                </div>
                <div className="mt-1.5 truncate font-mono text-2xs text-ink-faint">
                  {aiDraft.url}
                </div>
                {aiDraft.headers.some((row) => row.key) && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {aiDraft.headers
                      .filter((row) => row.key)
                      .map((row) => (
                        <span
                          key={row.id}
                          className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-2xs text-ink-soft"
                        >
                          {row.key}: {row.value}
                        </span>
                      ))}
                  </div>
                )}
                {aiDraft.body.type !== "none" && (
                  <pre className="scrollbar-thin mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-sunken p-2 font-mono text-2xs text-ink">
                    {aiDraft.body.type === "formUrlEncoded"
                      ? aiDraft.body.items
                          .map((item) => `${item.key}=${item.value}`)
                          .join("&")
                      : aiDraft.body.type === "json" || aiDraft.body.type === "raw"
                        ? aiDraft.body.content
                        : ""}
                  </pre>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="primary" onClick={() => importAiDraft()}>
                  <Check className="h-3.5 w-3.5" />
                  {t("tools.ai.import")}
                </Button>
                <Button size="sm" onClick={discardAiDraft}>
                  {t("tools.ai.discard")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="wb-ai-composer">
        <label className="sr-only" htmlFor="wb-ai-description">
          {t("tools.ai.descLabel")}
        </label>
        <textarea
          id="wb-ai-description"
          className={`${inputClass} h-24 resize-none text-xs leading-relaxed`}
          placeholder={t("tools.ai.descPlaceholder")}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          onKeyDown={onComposerKeyDown}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="min-w-0 text-2xs text-ink-faint">{t("tools.ai.sendHint")}</span>
          <Button size="sm" variant="primary" disabled={!canGenerate} onClick={submit}>
            {aiBusy ? <Spinner className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
            {t("tools.ai.generate")}
          </Button>
        </div>
      </div>
    </aside>
  );
}
