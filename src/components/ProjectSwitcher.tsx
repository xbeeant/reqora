import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, CloudDownload, Plus, Settings2 } from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { t, useT } from "../i18n";
import { CloudPullModal } from "./CloudPullModal";
import { inputClass } from "./ui";

const message = (error: unknown) =>
  error instanceof Error ? error.message : t("shell.operationFailed");

/** Apifox-style project selector in the top-left corner: the primary entry
 * point for creating and switching projects, with quick access to full data
 * directory management in Settings. */
export function ProjectSwitcher() {
  const projectsState = useWorkspace((state) => state.projectsState);
  const refreshProjects = useWorkspace((state) => state.refreshProjects);
  const switchProject = useWorkspace((state) => state.switchProject);
  const createProject = useWorkspace((state) => state.createProject);
  const setSettingsModalOpen = useWorkspace((state) => state.setSettingsModalOpen);
  const setCloudPullOpen = useWorkspace((state) => state.setCloudPullOpen);
  const cloudLoggedIn = useWorkspace((state) => state.cloudLoggedIn);
  const isLoading = useWorkspace((state) => state.isLoading);
  const t = useT();

  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutside);
    return () => document.removeEventListener("pointerdown", closeOnOutside);
  }, [open]);

  const active = projectsState?.projects.find((project) => project.active) ?? null;
  const label = active?.name ?? (isLoading ? t("shell.loading") : t("shell.defaultProject"));

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
      setOpen(false);
      setCreating(false);
      setName("");
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className="flex items-center gap-1 rounded-md px-1.5 py-1 font-medium text-ink-soft hover:bg-surface-muted"
        title={t("shell.switchProjectTitle")}
        aria-label={t("shell.switchProjectAria")}
        onClick={() => {
          setOpen((current) => !current);
          if (!open) void refreshProjects();
        }}
      >
        <span className="max-w-[150px] truncate">{label}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>

      {open && (
        <div className="absolute left-0 top-[calc(100%+6px)] z-50 w-80 rounded-lg border border-surface-border bg-surface p-2 shadow-xl">
          <div className="mb-1 flex items-center justify-between px-1.5 py-1">
            <span className="text-2xs font-semibold text-ink">{t("shell.projects")}</span>
            <span className="text-2xs text-ink-faint">
              {t("shell.projectCount", { count: projectsState?.projects.length ?? 0 })}
            </span>
          </div>

          <div className="max-h-56 space-y-0.5 overflow-y-auto">
            {projectsState?.projects.map((project) => (
              <button
                key={project.id}
                type="button"
                disabled={busy}
                onClick={() => void run(() => switchProject(project.id))}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left disabled:opacity-50 ${
                  project.active ? "bg-blue-50" : "hover:bg-surface-muted"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-ink">{project.name}</span>
                  <span className="block truncate font-mono text-2xs text-ink-faint">
                    {project.dataDirectory}
                  </span>
                </span>
                {project.active && <Check className="h-3.5 w-3.5 shrink-0 text-blue-600" />}
              </button>
            ))}
            {!projectsState && (
              <p className="px-2 py-1.5 text-2xs text-ink-faint">{t("shell.projectsLoading")}</p>
            )}
          </div>

          <div className="my-1 h-px bg-surface-border" />

          {creating ? (
            <div className="space-y-2 px-1 pb-1">
              <input
                className={`${inputClass} !h-8 !text-xs`}
                placeholder={t("shell.projectNamePlaceholder")}
                aria-label={t("shell.newProjectName")}
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy || !name.trim()}
                  className="flex h-8 flex-1 items-center justify-center rounded-md bg-brand-500 px-2 text-2xs font-medium text-white disabled:opacity-50"
                  onClick={() => void run(() => createProject(name.trim()))}
                >
                  {t("shell.createAndSwitch")}
                </button>
                <button
                  type="button"
                  className="flex h-8 items-center rounded-md border border-surface-border px-2 text-2xs text-ink-soft"
                  onClick={() => {
                    setCreating(false);
                    setError(null);
                  }}
                >
                  {t("shell.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={busy}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-ink-soft hover:bg-surface-muted"
              onClick={() => setCreating(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("shell.createProject")}
            </button>
          )}

          {cloudLoggedIn && (
            <button
              type="button"
              disabled={busy}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-ink-soft hover:bg-surface-muted"
              onClick={() => {
                setOpen(false);
                setCloudPullOpen(true);
              }}
            >
              <CloudDownload className="h-3.5 w-3.5" />
              {t("shell.pullFromSpace")}
            </button>
          )}

          <button
            type="button"
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-ink-soft hover:bg-surface-muted"
            onClick={() => {
              setOpen(false);
              setSettingsModalOpen(true);
            }}
          >
            <Settings2 className="h-3.5 w-3.5" />
            {t("shell.manageProjects")}
          </button>

          {error && <p className="px-1.5 pt-1 text-2xs text-red-600">{error}</p>}
        </div>
      )}

      <CloudPullModal />
    </div>
  );
}
