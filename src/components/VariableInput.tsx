import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  filterVariableSuggestions,
  VARIABLE_SOURCE_LABELS,
  type VariableSuggestion,
} from "../lib/variables.ts";
import { useT } from "../i18n";

interface Trigger {
  /** Index of the opening `{{`. */
  start: number;
  /** Caret position when the trigger was detected. */
  end: number;
  /** Text typed after `{{` so far. */
  query: string;
}

const TRIGGER_PATTERN = /\{\{([^{}]*)$/;

function detectTrigger(value: string, caret: number): Trigger | null {
  const before = value.slice(0, caret);
  const match = TRIGGER_PATTERN.exec(before);
  if (!match) return null;
  return { start: caret - match[0].length, end: caret, query: match[1] };
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Candidates offered when the user types `{{`. */
  suggestions: readonly VariableSuggestion[];
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  spellCheck?: boolean;
  disabled?: boolean;
  /** Render a <textarea> (request bodies, GraphQL, scripts). */
  multiline?: boolean;
  type?: "text" | "password";
}

interface PanelRect {
  left: number;
  top: number;
  width: number;
}

interface EditorEvent {
  currentTarget: HTMLInputElement | HTMLTextAreaElement;
}

interface KeyEventLike {
  key: string;
  preventDefault: () => void;
  stopPropagation: () => void;
}

/**
 * Drop-in replacement for <input> / <textarea> that offers `{{` autocomplete.
 * The menu is portalled to document.body with fixed coordinates so it is never
 * clipped by the `overflow: hidden` tables and panes it lives inside. The
 * component itself renders no wrapper element, so it drops into existing
 * flex/grid cells without changing layout.
 */
export function VariableInput({
  value,
  onChange,
  suggestions,
  className = "",
  placeholder,
  ariaLabel,
  spellCheck = false,
  disabled = false,
  multiline = false,
  type = "text",
}: Props) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [rect, setRect] = useState<PanelRect | null>(null);

  const element = () => (multiline ? textareaRef.current : inputRef.current);

  const matches = useMemo(
    () => (trigger ? filterVariableSuggestions(suggestions, trigger.query) : []),
    [suggestions, trigger],
  );
  const open = trigger !== null && matches.length > 0 && !disabled;
  const activeIndex = Math.min(highlight, Math.max(0, matches.length - 1));

  const close = () => {
    setTrigger(null);
    setRect(null);
  };

  const refresh = (nextValue: string, caret: number) => {
    setTrigger(detectTrigger(nextValue, caret));
    setHighlight(0);
  };

  // Fixed coordinates + scroll/resize listeners, mirroring the custom Select.
  useLayoutEffect(() => {
    if (!open) {
      setRect(null);
      return;
    }
    const update = () => {
      const el = element();
      if (!el) return;
      const bounds = el.getBoundingClientRect();
      const estimated = Math.min(matches.length * 40 + 34, 300);
      const openUp =
        bounds.bottom + estimated > window.innerHeight && bounds.top - estimated > 0;
      const width = Math.min(360, Math.max(260, bounds.width));
      setRect({
        left: Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8)),
        top: openUp ? bounds.top - estimated - 4 : bounds.bottom + 4,
        width,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, matches.length, multiline]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (element()?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const commit = (item: VariableSuggestion) => {
    const el = element();
    if (!trigger || !el) return;
    const end = el.selectionStart ?? trigger.end;
    const before = value.slice(0, trigger.start);
    const after = value.slice(end);
    const next = before + item.insert + after;
    const caret = before.length + item.insert.length;
    onChange(next);
    close();
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const handleChange = (event: EditorEvent) => {
    const next = event.currentTarget.value;
    onChange(next);
    refresh(next, event.currentTarget.selectionStart ?? next.length);
  };

  const handleClick = (event: EditorEvent) => {
    refresh(event.currentTarget.value, event.currentTarget.selectionStart ?? 0);
  };

  const handleKeyDown = (event: KeyEventLike) => {
    if (!open) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setHighlight((current) => (current + 1) % matches.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setHighlight((current) => (current - 1 + matches.length) % matches.length);
        break;
      case "Enter":
      case "Tab": {
        const item = matches[activeIndex];
        if (item) {
          event.preventDefault();
          commit(item);
        }
        break;
      }
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close();
        break;
      default:
        break;
    }
  };

  const shared = {
    className,
    value,
    placeholder,
    disabled,
    spellCheck,
    "aria-label": ariaLabel,
    onChange: handleChange,
    onClick: handleClick,
    onKeyDown: handleKeyDown,
    onBlur: close,
  };

  const panel =
    open && rect
      ? createPortal(
          <div
            ref={panelRef}
            className="wb-var-panel scrollbar-thin"
            style={{ position: "fixed", left: rect.left, top: rect.top, width: rect.width }}
            role="listbox"
            aria-label={t("request.var.panel.aria")}
            onMouseDown={(event) => event.preventDefault()}
          >
            <div className="wb-var-head">
              <code>{`{{${trigger.query}`}</code>
              <span>{t("request.var.panel.hint")}</span>
            </div>
            {matches.map((item, index) => (
              <div
                key={`${item.source}:${item.key}`}
                role="option"
                aria-selected={index === activeIndex}
                data-index={index}
                className={`wb-var-option ${index === activeIndex ? "highlighted" : ""}`}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  commit(item);
                }}
              >
                <div className="wb-var-row">
                  <code className="wb-var-key">{item.insert}</code>
                  <span className="wb-var-source">{VARIABLE_SOURCE_LABELS[item.source]}</span>
                  {item.value !== undefined && type !== "password" && (
                    <span className="wb-var-value" title={item.value}>
                      {item.value}
                    </span>
                  )}
                </div>
                {item.detail && <div className="wb-var-detail">{item.detail}</div>}
              </div>
            ))}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      {multiline ? (
        <textarea ref={textareaRef} {...shared} />
      ) : (
        <input ref={inputRef} type={type} {...shared} />
      )}
      {panel}
    </>
  );
}
