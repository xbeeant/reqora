import type {
  ButtonHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from "react";
import { Children, isValidElement, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import { useT } from "../i18n";
import type { HttpMethod } from "../types";

export const inputClass =
  "w-full rounded-md border border-surface-border bg-surface px-2.5 py-1.5 text-sm text-ink outline-none transition placeholder:text-ink-faint focus:border-brand-400 focus:ring-2 focus:ring-brand-100 disabled:bg-surface-sunken";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-brand-600 text-white shadow-sm hover:bg-brand-700",
  secondary: "border border-surface-border bg-surface text-ink hover:bg-surface-muted",
  ghost: "text-ink-soft hover:bg-surface-sunken hover:text-ink",
  danger: "border border-red-200 bg-surface text-red-600 hover:bg-red-50",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-xs",
  md: "h-9 px-3.5 text-sm",
};

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-200 disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`}
      {...rest}
    />
  );
}

export function IconButton({
  label,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-surface-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-200 disabled:opacity-40 ${className}`}
      {...rest}
    />
  );
}

interface OptionItem {
  value: string;
  label: ReactNode;
  disabled: boolean;
}

/** Extract {value,label,disabled} from declarative <option> children. */
function parseOptions(children: ReactNode): OptionItem[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const props = child.props as { value?: unknown; children?: ReactNode; disabled?: boolean };
    const value =
      props.value === undefined || props.value === null ? "" : String(props.value);
    return [{ value, label: props.children ?? value, disabled: props.disabled === true }];
  });
}

export interface SelectChangeEvent {
  target: { value: string };
}

export interface SelectProps {
  className?: string;
  value: string;
  onChange: (event: SelectChangeEvent) => void;
  children: ReactNode;
  disabled?: boolean;
  id?: string;
  title?: string;
  "aria-label"?: string;
}

/**
 * Custom dropdown styled to match the workbench (same tokens, radii, focus
 * ring and dark theme as inputs) — native <select> popup menus cannot be
 * styled. Keeps the native select contract: `onChange` receives
 * `{ target: { value } }` and options stay declarative `<option>` elements,
 * so call sites need no changes.
 */
export function Select({
  className = "",
  value,
  onChange,
  children,
  disabled = false,
  id,
  title,
  "aria-label": ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);

  const options = useMemo(() => parseOptions(children), [children]);
  const selected = options.find((option) => option.value === value);

  // Position the panel with the button in fixed coordinates so it survives
  // overflow-clipped containers (trees, tables), and keep it pinned to the
  // button while the page scrolls.
  useEffect(() => {
    if (!open) {
      setRect(null);
      return;
    }
    const update = () => {
      const el = buttonRef.current;
      if (!el) return;
      const bounds = el.getBoundingClientRect();
      const estimated = Math.min(options.length * 30 + 8, 240);
      const openUp = bounds.bottom + estimated > window.innerHeight && bounds.top - estimated > 0;
      setRect({
        left: Math.max(8, Math.min(bounds.left, window.innerWidth - Math.max(bounds.width, 120) - 8)),
        top: openUp ? bounds.top - estimated - 4 : bounds.bottom + 4,
        width: bounds.width,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, options.length]);

  // Click outside closes.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Opening moves the highlight to the selected option.
  useEffect(() => {
    if (!open) return;
    const index = options.findIndex((option) => option.value === value);
    setHighlight(index >= 0 ? index : 0);
    // Re-run only on open; `value`/`options` changes mid-open are rare and
    // resetting then would fight the pointer hover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keyboard navigation keeps the highlighted option visible.
  useEffect(() => {
    if (!open || highlight < 0) return;
    const panel = panelRef.current;
    const item = panel?.querySelector<HTMLElement>(`[data-index="${highlight}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const commit = (option: OptionItem) => {
    if (option.disabled) return;
    onChange({ target: { value: option.value } });
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        setOpen(false);
        break;
      case "ArrowDown":
        event.preventDefault();
        setHighlight((current) => Math.min((current < 0 ? -1 : current) + 1, options.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setHighlight((current) => Math.max((current < 0 ? options.length : current) - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        setHighlight(0);
        break;
      case "End":
        event.preventDefault();
        setHighlight(options.length - 1);
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        const option = options[highlight] ?? selected;
        if (option) commit(option);
        break;
      }
    }
  };

  return (
    <span ref={wrapRef} className="wb-select-wrap">
      <button
        ref={buttonRef}
        id={id}
        type="button"
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        className={`wb-select-trigger ${inputClass} flex items-center justify-between gap-1.5 text-left ${className}`}
        onClick={() => {
          if (!disabled) setOpen((current) => !current);
        }}
        onKeyDown={onKeyDown}
      >
        <span className="min-w-0 flex-1 truncate">{selected ? selected.label : value}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && rect && (
        <span
          ref={panelRef}
          role="listbox"
          aria-label={ariaLabel}
          className="wb-select-panel scrollbar-thin"
          style={{
            position: "fixed",
            left: rect.left,
            top: rect.top,
            width: Math.max(rect.width, 120),
          }}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isHighlighted = index === highlight;
            return (
              <span
                key={`${option.value}:${index}`}
                role="option"
                aria-selected={isSelected}
                data-index={index}
                className={`wb-select-option ${isSelected ? "selected" : ""} ${
                  isHighlighted ? "highlighted" : ""
                } ${option.disabled ? "disabled" : ""}`}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => commit(option)}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {isSelected && <Check className="h-3.5 w-3.5 shrink-0" />}
              </span>
            );
          })}
        </span>
      )}
    </span>
  );
}

const METHOD_TONES: Record<HttpMethod, string> = {
  GET: "wb-method-get",
  POST: "wb-method-post",
  PUT: "wb-method-put",
  PATCH: "wb-method-patch",
  DELETE: "wb-method-delete",
  HEAD: "wb-method-head",
  OPTIONS: "wb-method-options",
};

export function MethodBadge({
  method,
  className = "",
}: {
  method: HttpMethod;
  className?: string;
}) {
  return (
    <span
      className={`wb-method inline-flex w-[62px] shrink-0 justify-center rounded bg-surface-sunken px-1.5 py-0.5 text-2xs font-bold tracking-wide ${METHOD_TONES[method]} ${className}`}
    >
      {method}
    </span>
  );
}

export function TabButton({
  active,
  badge,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active: boolean;
  badge?: number;
}) {
  return (
    <button
      type="button"
      className={`relative flex h-9 items-center gap-1.5 border-b-2 px-3 text-xs font-medium transition-colors ${
        active
          ? "border-brand-500 text-brand-600"
          : "border-transparent text-ink-soft hover:text-ink"
      } ${className}`}
      {...rest}
    >
      {children}
      {badge !== undefined && badge > 0 && (
        <span className="rounded-full bg-surface-sunken px-1.5 py-0.5 text-2xs text-ink-soft">
          {badge}
        </span>
      )}
    </button>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  const tones = {
    neutral: "wb-tone-muted",
    success: "wb-tone-ok",
    warning: "wb-tone-warn",
    danger: "wb-tone-danger",
  };
  return <span className={`wb-tone ${tones[tone]}`}>{children}</span>;
}

export function Spinner({ className = "" }: { className?: string }) {
  return <Loader2 className={`h-4 w-4 animate-spin ${className}`} />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="wb-empty">
      {icon && <div className="mb-1 opacity-60">{icon}</div>}
      <p className="wb-empty-title">{title}</p>
      {description && (
        <p className="max-w-sm text-xs leading-relaxed text-ink-faint">
          {description}
        </p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/**
 * Double-click → inline rename. Enter commits, Escape cancels, blur commits;
 * the `finished` ref prevents the blur that follows Enter/Escape (or unmount)
 * from committing twice — an easy bug when the input is removed on commit.
 */
export function InlineRenameInput({
  value,
  onCommit,
  onCancel,
  className = "",
  ariaLabel,
}: {
  value: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  className?: string;
  ariaLabel?: string;
}) {
  const t = useT();
  const [text, setText] = useState(value);
  const finished = useRef(false);
  const finish = (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (commit && text.trim()) onCommit(text.trim());
    else onCancel();
  };
  return (
    <input
      autoFocus
      className={`h-6 min-w-0 rounded border border-brand-400 bg-surface px-1.5 text-[11px] text-ink outline-none ${className}`}
      value={text}
      aria-label={ariaLabel ?? t("shell.name")}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => finish(true)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
    />
  );
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  width = "max-w-2xl",
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const t = useT();
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-6 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex max-h-[82vh] w-full ${width} flex-col overflow-hidden rounded-xl border border-surface-border bg-surface shadow-panel`}
      >
        <div className="flex items-start justify-between border-b border-surface-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            {description && (
              <p className="mt-1 text-xs text-ink-faint">{description}</p>
            )}
          </div>
          <IconButton label={t("shell.close")} onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="scrollbar-thin flex-1 overflow-y-auto px-5 py-4">
          {children}
        </div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-surface-border bg-surface-muted px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
