import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Check, ChevronDown, Globe2, Plus, Settings2 } from "lucide-react";
import { useT } from "../i18n";
import { useWorkspace } from "../store/workspace";

/**
 * 环境相关操作的唯一入口（放在顶栏）：
 * 一个下拉里完成「切换 / 无环境 / 新建 / 打开维护面板」。
 * placement 只影响外壳排版（侧栏版带内边距、顶栏版紧凑），交互与菜单完全一致。
 */
type PickerItem =
  | { kind: "env"; id: string | null; name: string; count: number }
  | { kind: "new" }
  | { kind: "manage" };

const MENU_MIN_WIDTH = 248;

export function EnvironmentPicker({
  placement = "sidebar",
}: {
  placement?: "sidebar" | "topbar";
}) {
  const t = useT();
  // 只订阅环境域 + 生效环境 id。
  const environments = useWorkspace((state) => state.snapshot.environments);
  const activeEnvironmentId = useWorkspace((state) => state.snapshot.activeEnvironmentId);
  const setActiveEnvironment = useWorkspace((state) => state.setActiveEnvironment);
  const addEnvironment = useWorkspace((state) => state.addEnvironment);
  const setEnvironmentModalOpen = useWorkspace((state) => state.setEnvironmentModalOpen);

  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const activeId = activeEnvironmentId ?? null;
  const active =
    environments.find((environment) => environment.id === activeId) ?? null;

  const items = useMemo<PickerItem[]>(
    () => [
      { kind: "env", id: null, name: t("shell.noEnv"), count: 0 },
      ...environments.map((environment) => ({
        kind: "env" as const,
        id: environment.id,
        name: environment.name,
        count: (environment.variables ?? []).filter((row) => Boolean(row.key?.trim())).length,
      })),
      { kind: "new" },
      { kind: "manage" },
    ],
    [environments, t],
  );

  // The menu is fixed-positioned so it is not clipped by the sidebar, and
  // stays pinned to the trigger while the tree scrolls or the window resizes.
  useEffect(() => {
    if (!open) {
      setRect(null);
      return;
    }
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const bounds = el.getBoundingClientRect();
      const width = Math.max(bounds.width, MENU_MIN_WIDTH);
      const estimated = Math.min(items.length * 32 + 56, 320);
      const openUp =
        bounds.bottom + estimated > window.innerHeight && bounds.top - estimated > 0;
      setRect({
        left: Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)),
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
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Opening highlights the currently active environment.
  useEffect(() => {
    if (!open) return;
    const index = items.findIndex(
      (item) => item.kind === "env" && item.id === activeId,
    );
    setHighlight(index >= 0 ? index : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, highlight]);

  const commit = (item: PickerItem) => {
    setOpen(false);
    if (item.kind === "env") {
      setActiveEnvironment(item.id);
      triggerRef.current?.focus();
    } else if (item.kind === "new") {
      // addEnvironment creates the environment and activates it; the modal
      // then opens on it so the name and variables can be filled in at once.
      addEnvironment();
      setEnvironmentModalOpen(true);
    } else {
      setEnvironmentModalOpen(true);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
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
        setHighlight((current) => Math.min(current + 1, items.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setHighlight((current) => Math.max(current - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        setHighlight(0);
        break;
      case "End":
        event.preventDefault();
        setHighlight(items.length - 1);
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        const item = items[highlight];
        if (item) commit(item);
        break;
      }
    }
  };

  const currentLabel = `${t("shell.currentEnv")}: ${active?.name ?? t("shell.noEnv")}`;

  return (
    <div ref={wrapRef} className={`wb-env-picker ${placement === "topbar" ? "in-topbar" : ""}`}>
      <span className="wb-env-label">{t("core.environment")}</span>
      <button
        ref={triggerRef}
        type="button"
        className={`wb-env-trigger ${active ? "" : "none"}`}
        title={currentLabel}
        aria-label={currentLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onKeyDown}
      >
        <Globe2 className="h-3.5 w-3.5 shrink-0" />
        <span className="wb-env-name">{active?.name ?? t("shell.noEnv")}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && rect && (
        <div
          ref={menuRef}
          role="listbox"
          aria-label={t("shell.envPicker.switch")}
          className="wb-env-menu scrollbar-thin"
          style={{ position: "fixed", left: rect.left, top: rect.top, width: rect.width }}
        >
          <p className="wb-env-menu-label">{t("shell.envPicker.switch")}</p>
          {items.map((item, index) => (
            <Fragment key={index}>
              {item.kind === "new" && <div className="wb-env-menu-sep" />}
              <div
                role="option"
                aria-selected={item.kind === "env" && item.id === activeId}
                data-index={index}
                className={`wb-env-menu-item ${index === highlight ? "highlighted" : ""} ${
                  item.kind === "env" && item.id === activeId ? "selected" : ""
                } ${item.kind !== "env" ? "action" : ""}`}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => commit(item)}
              >
                {item.kind === "env" ? (
                  <>
                    <Globe2 className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                    <span className="wb-env-name">{item.name}</span>
                    {item.id !== null && (
                      <span className="wb-env-count">
                        {t("shell.envPicker.variableCount", { count: item.count })}
                      </span>
                    )}
                    {item.id === activeId && <Check className="h-3.5 w-3.5 shrink-0" />}
                  </>
                ) : item.kind === "new" ? (
                  <>
                    <Plus className="h-3.5 w-3.5 shrink-0" />
                    <span className="wb-env-name">{t("modals.env.newEnv")}</span>
                  </>
                ) : (
                  <>
                    <Settings2 className="h-3.5 w-3.5 shrink-0" />
                    <span className="wb-env-name">{t("shell.envPicker.manage")}</span>
                  </>
                )}
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
