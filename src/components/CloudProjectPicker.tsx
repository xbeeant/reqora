import { useEffect, useMemo, useState } from "react";
import { Check, Cloud, HardDrive, Plus, RefreshCw, TriangleAlert } from "lucide-react";
import { cloudProjectSlugFor } from "../lib/cloud";
import { isShareableRowsEmpty } from "../lib/cloudSync";
import { cloudProjectFor } from "../lib/cloudConnection";
import { snapshotToRows } from "../lib/workspaceRows";
import { useWorkspace } from "../store/workspace";
import { useT } from "../i18n";
import { Button, Modal, inputClass } from "./ui";

/** 值为 i18n key。 */
const ROLE_KEYS: Record<string, string> = {
  OWNER: "modals.cloud.role.owner",
  ADMIN: "modals.cloud.role.admin",
  EDITOR: "modals.cloud.role.editor",
  VIEWER: "modals.cloud.role.viewer",
};

/**
 * 首次同步（或解绑后再同步）时选择协作空间的弹窗：
 * 绑定到一个已有协作空间，或新建一个并绑定。绑定关系按本地项目
 * 记忆在本机（localStorage），之后同步不再询问。
 */
export function CloudProjectPicker() {
  const t = useT();
  const open = useWorkspace((state) => state.cloudPickerOpen);
  const project = useWorkspace((state) => state.cloudPickerProject);
  const spaces = useWorkspace((state) => state.cloudSpaces);
  const spacesBusy = useWorkspace((state) => state.cloudSpacesBusy);
  const spacesError = useWorkspace((state) => state.cloudSpacesError);
  const setCloudPickerOpen = useWorkspace((state) => state.setCloudPickerOpen);
  const cloudLoadSpaces = useWorkspace((state) => state.cloudLoadSpaces);
  const cloudBindSpace = useWorkspace((state) => state.cloudBindSpace);
  const cloudCreateAndBindSpace = useWorkspace((state) => state.cloudCreateAndBindSpace);
  const projectsState = useWorkspace((state) => state.projectsState);
  const snapshot = useWorkspace((state) => state.snapshot);

  const [mode, setMode] = useState<"existing" | "create">("existing");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const defaultSlug = project ? cloudProjectSlugFor(project.id) : "";
  const active = projectsState?.projects.find((item) => item.active) ?? null;

  // 本地是否没有可共享实体（决定绑定后的同步方向提示）。
  const localEmpty = useMemo(
    () => isShareableRowsEmpty(snapshotToRows(snapshot)),
    [snapshot],
  );
  const currentBoundId = cloudProjectFor(project?.id ?? "default")?.id ?? null;
  const selectedSpace =
    mode === "existing"
      ? (spaces ?? []).find((item) => item.id === selectedId) ?? null
      : null;
  const rebinding = selectedSpace != null && selectedSpace.id !== currentBoundId;

  // 每次打开都回到初始态：默认绑定已有空间，预填建议名称与 slug。
  useEffect(() => {
    if (!open) return;
    setMode("existing");
    setSelectedId(null);
    setNotice(null);
    setNewName(project?.name ?? "");
    setNewSlug(project ? cloudProjectSlugFor(project.id) : "");
  }, [open, project?.id, project?.name]);

  // 列表加载后，把与本地项目建议 slug 相同的空间预选中。
  useEffect(() => {
    if (!open || !spaces) return;
    setSelectedId((current) => {
      if (current != null) return current;
      const match = spaces.find((item) => item.slug === defaultSlug);
      return match?.id ?? null;
    });
  }, [open, spaces, defaultSlug]);

  const canConfirm =
    mode === "existing" ? selectedId != null : Boolean(newName.trim()) && Boolean(newSlug.trim());

  const confirm = () => {
    if (mode === "existing" && selectedId != null) void cloudBindSpace(selectedId);
    else if (mode === "create") void cloudCreateAndBindSpace(newName, newSlug);
  };

  return (
    <Modal
      open={open}
      title={t("modals.cloudPicker.title")}
      description={t("modals.cloudPicker.description")}
      onClose={() => setCloudPickerOpen(false)}
      width="max-w-lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => setCloudPickerOpen(false)}>
            {t("modals.importExport.cancel")}
          </Button>
          <Button variant="primary" disabled={!canConfirm || spacesBusy} onClick={confirm}>
            <Cloud className="h-3.5 w-3.5" />
            {t("modals.cloudPicker.bindAndSync")}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="rounded-md border border-surface-border bg-surface-muted px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink">
              {t("modals.cloudPicker.currentProject", { name: project?.name ?? t("modals.cloudPicker.defaultProject") })}
            </span>
            {active && <span className="text-2xs text-ink-faint">{t("modals.cloudPicker.dataDirNote")}</span>}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={mode === "existing" ? "primary" : "ghost"}
            onClick={() => setMode("existing")}
          >
            <HardDrive className="h-3.5 w-3.5" />
            {t("modals.cloudPicker.bindExisting")}
          </Button>
          <Button
            size="sm"
            variant={mode === "create" ? "primary" : "ghost"}
            onClick={() => setMode("create")}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("modals.cloudPicker.createNew")}
          </Button>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            disabled={spacesBusy}
            onClick={() => void cloudLoadSpaces()}
            aria-label={t("modals.cloud.refreshAria")}
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>

        {mode === "existing" ? (
          <div className="max-h-56 space-y-1.5 overflow-y-auto">
            {spacesBusy && !spaces && <p className="text-2xs text-ink-faint">{t("modals.cloud.loading")}</p>}
            {spacesError && (
              <p className="rounded-md bg-red-50 px-2 py-1.5 text-2xs text-red-600">{spacesError}</p>
            )}
            {spaces && spaces.length === 0 && !spacesError && (
              <p className="text-2xs text-ink-faint">
                {t("modals.cloudPicker.noSpaces")}
              </p>
            )}
            {(spaces ?? []).map((space) => (
              <button
                type="button"
                key={space.id}
                disabled={spacesBusy}
                onClick={() => setSelectedId(space.id)}
                className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left ${
                  selectedId === space.id
                    ? "border-blue-300 bg-blue-50"
                    : "border-surface-border bg-surface-muted"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-xs text-ink">{space.name}</span>
                    <span className="shrink-0 rounded bg-surface-border px-1 text-2xs text-ink-soft">
                      {ROLE_KEYS[space.memberRole] ? t(ROLE_KEYS[space.memberRole]) : space.memberRole}
                    </span>
                  </span>
                  <span className="block truncate font-mono text-2xs text-ink-faint">
                    {space.slug} · #{space.id}
                  </span>
                </span>
                {selectedId === space.id && <Check className="h-3.5 w-3.5 shrink-0 text-blue-600" />}
              </button>
            ))}
            {defaultSlug && (
              <p className="pt-1 text-2xs text-ink-faint">
                {t("modals.cloudPicker.suggestedSlug", { slug: defaultSlug })}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2 rounded-md border border-surface-border px-2.5 py-2">
            <label className="block">
              <span className="mb-1 block text-2xs text-ink-soft">{t("modals.cloudPicker.nameLabel")}</span>
              <input
                className={`${inputClass} !h-8 !text-xs`}
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                aria-label={t("modals.cloudPicker.nameAria")}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-2xs text-ink-soft">{t("modals.cloudPicker.slugLabel")}</span>
              <input
                className={`${inputClass} !h-8 font-mono !text-xs`}
                value={newSlug}
                spellCheck={false}
                onChange={(event) => setNewSlug(event.target.value)}
                aria-label={t("modals.cloudPicker.slugAria")}
              />
            </label>
          </div>
        )}

        {rebinding && selectedSpace && (
          <p
            className={`flex items-start gap-1.5 rounded-md px-2 py-1.5 text-2xs leading-relaxed ${
              localEmpty ? "bg-blue-50 text-blue-700" : "bg-amber-50 text-amber-700"
            }`}
          >
            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
            {localEmpty
              ? t("modals.cloudPicker.rebindEmpty", {
                  space: selectedSpace.name,
                  rename: project?.name === "默认项目"
                    ? t("modals.cloudPicker.rebindEmptyRename", { name: selectedSpace.name })
                    : "",
                })
              : t("modals.cloudPicker.rebindData", { space: selectedSpace.name })}
          </p>
        )}

        <p className="text-2xs leading-relaxed text-ink-faint">
          {t("modals.cloudPicker.syncNote")}
        </p>

        {notice && <p className="text-2xs text-emerald-600">{notice}</p>}
      </div>
    </Modal>
  );
}
