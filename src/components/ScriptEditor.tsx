import { useRef, useState, type KeyboardEvent, type UIEvent } from "react";
import { EMPTY_SCRIPT_LIBRARY } from "../lib/defaults.ts";
import { BookMarked, BookOpen, Code2, Plus, RotateCcw } from "lucide-react";
import { SCRIPT_HELPERS } from "../lib/scripts";
import { useT } from "../i18n";
import { useWorkspace } from "../store/workspace";

interface Props {
  phase: "pre" | "post";
  value: string;
  onChange: (value: string) => void;
}

const SAMPLES: Record<Props["phase"], string> = {
  pre: `// 前置脚本：在请求交给 Rust 发出之前执行
setHeader("X-Trace-Id", uuid());
setVar("sentAt", String(now()));
log("prepared at " + getVar("sentAt"));`,
  post: `// 后置脚本：请求完成后执行，可读 response
log("status = " + response.status);

test("状态码 2xx", function () {
  assert(response.ok, "服务器返回 " + response.status);
});

test("返回体含 data 字段", function () {
  assert(json("$.json.hello") !== undefined, "缺少 data");
});`,
};

const PLACEHOLDER_KEYS: Record<Props["phase"], string> = {
  pre: "testing.script.placeholder.pre",
  post: "testing.script.placeholder.post",
};

/**
 * A real editor surface for pre/post scripts: line numbers, tab indentation,
 * a searchable helper reference and one-click insertion at the caret.
 * The script itself is executed in a Blob Worker by lib/scripts.ts.
 */
export function ScriptEditor({ phase, value, onChange }: Props) {
  const t = useT();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const [helperFilter, setHelperFilter] = useState("");
  const [showHelpers, setShowHelpers] = useState(true);
  const scriptLibrary = useWorkspace((state) => state.snapshot.scriptLibrary ?? EMPTY_SCRIPT_LIBRARY);
  const addScriptSnippet = useWorkspace((state) => state.addScriptSnippet);

  const lines = Math.max(1, value.split("\n").length);
  const filtered = SCRIPT_HELPERS.filter((helper) =>
    `${helper.signature} ${helper.description}`
      .toLowerCase()
      .includes(helperFilter.trim().toLowerCase()),
  );

  const insert = (text: string) => {
    const area = textareaRef.current;
    if (!area) {
      onChange(value + text);
      return;
    }
    const start = area.selectionStart ?? value.length;
    const end = area.selectionEnd ?? value.length;
    const next = value.slice(0, start) + text + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      area.focus();
      const caret = start + text.length;
      area.setSelectionRange(caret, caret);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    insert("  ");
  };

  const onScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    if (gutterRef.current) {
      gutterRef.current.scrollTop = event.currentTarget.scrollTop;
    }
  };

  return (
    <div className="wb-script-layout">
      <div className="wb-script-main">
        <div className="wb-script-bar">
          <Code2 className="h-3.5 w-3.5 shrink-0" />
          <span className="shrink-0 whitespace-nowrap font-mono">
            {phase === "pre" ? "pre-request.js" : "tests.js"}
          </span>
          <span className="wb-mini-badge shrink-0">{t("testing.script.lines", { count: lines })}</span>
          <span
            className="ml-auto hidden truncate text-ink-faint 2xl:inline"
            title={t("testing.script.sandbox.title")}
          >
            {t("testing.script.sandbox")}
          </span>
          {value.trim() ? (
            <button
              type="button"
              className="wb-icon-btn !h-6 !w-6"
              title={t("testing.script.clear")}
              aria-label={t("testing.script.clear")}
              onClick={() => onChange("")}
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          ) : (
            <button
              type="button"
              className="wb-chip !h-6 !px-2 !text-[10px]"
              onClick={() => insert(SAMPLES[phase])}
            >
              <Plus className="h-3 w-3" />
              {t("testing.script.insertSample")}
            </button>
          )}
          {scriptLibrary.length > 0 && (
            <select
              className="!h-6 max-w-36 rounded border border-surface-border bg-transparent !px-1 font-sans !text-[10px] text-ink-soft"
              value=""
              aria-label={t("testing.script.library.aria")}
              title={t("testing.script.library.title")}
              onChange={(event) => {
                const snippet = scriptLibrary.find((item) => item.id === event.target.value);
                if (snippet) insert(`\n${snippet.code}\n`);
              }}
            >
              <option value="">{t("testing.script.library")}</option>
              {scriptLibrary.map((snippet) => (
                <option key={snippet.id} value={snippet.id}>
                  {snippet.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="wb-icon-btn !h-6 !w-6"
            title={t("testing.script.save.title")}
            aria-label={t("testing.script.save.aria")}
            disabled={!value.trim()}
            onClick={() => {
              const name = window.prompt(
                t("testing.script.prompt.title"),
                t(phase === "pre" ? "testing.script.snippet.pre" : "testing.script.snippet.post"),
              );
              if (name && name.trim()) addScriptSnippet({ name, description: "", code: value });
            }}
          >
            <BookMarked className="h-3 w-3" />
          </button>
        </div>

        <div className="wb-script-edit">
          <div ref={gutterRef} className="wb-gutter scrollbar-thin" aria-hidden>
            {Array.from({ length: lines }, (_, index) => (
              <div key={index}>{index + 1}</div>
            ))}
          </div>
          <textarea
            ref={textareaRef}
            className="wb-code scrollbar-thin"
            value={value}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={phase === "pre" ? t("testing.script.aria.pre") : t("testing.script.aria.post")}
            placeholder={t(PLACEHOLDER_KEYS[phase])}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
            onScroll={onScroll}
          />
        </div>
      </div>

      {showHelpers ? (
        <div className="wb-script-side">
          <div className="wb-script-side-head flex items-center gap-1.5">
            <BookOpen className="h-3.5 w-3.5" />
            {t("testing.script.helpers")}
            <button
              type="button"
              className="wb-icon-btn !ml-auto !h-5 !w-5"
              title={t("testing.script.helpers.collapse")}
              aria-label={t("testing.script.helpers.collapse.aria")}
              onClick={() => setShowHelpers(false)}
            >
              ×
            </button>
          </div>
          <div className="border-b border-surface-border p-2">
            <input
              className="wb-url-input !h-7 !w-full !px-2 !font-sans !text-[11px]"
              value={helperFilter}
              placeholder={t("testing.script.search.placeholder")}
              aria-label={t("testing.script.search.aria")}
              onChange={(event) => setHelperFilter(event.target.value)}
            />
          </div>
          <div className="wb-helper-list scrollbar-thin">
            {filtered.map((helper) => (
              <button
                key={helper.signature}
                type="button"
                className="wb-helper"
                title={t("testing.script.insertHelper.title", { signature: helper.signature })}
                onClick={() => insert(helper.signature)}
              >
                <code>{helper.signature}</code>
                <span>{helper.description}</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="px-2 py-3 text-2xs text-ink-faint">{t("testing.script.noMatch")}</p>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="wb-chip !h-7 self-start !px-2 !text-[10px]"
          onClick={() => setShowHelpers(true)}
        >
          <BookOpen className="h-3 w-3" />
          Helper
        </button>
      )}
    </div>
  );
}
