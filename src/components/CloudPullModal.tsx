import { useEffect, useState } from "react";
import { Check, Cloud, Download, RefreshCw } from "lucide-react";
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
 * 「从协作空间拉取项目」弹窗：本地还没有这个项目、但服务器上已有。
 * 选一个云端空间 → 输入本地项目名 → 新建本地项目 → 仅下载该空间全部数据。
 */
export function CloudPullModal() {
  const t = useT();
  const open = useWorkspace((state) => state.cloudPullOpen);
  const spaces = useWorkspace((state) => state.cloudSpaces);
  const spacesBusy = useWorkspace((state) => state.cloudSpacesBusy);
  const spacesError = useWorkspace((state) => state.cloudSpacesError);
  const setCloudPullOpen = useWorkspace((state) => state.setCloudPullOpen);
  const cloudLoadSpaces = useWorkspace((state) => state.cloudLoadSpaces);
  const cloudPullProject = useWorkspace((state) => state.cloudPullProject);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [name, setName] = useState("");
  /** 用户手动编辑过名称后不再自动覆盖；否则始终跟随服务端空间名。 */
  const [nameDirty, setNameDirty] = useState(false);

  const selectedSpace = (spaces ?? []).find((item) => item.id === selectedId) ?? null;

  // 每次打开都回到初始态。
  useEffect(() => {
    if (!open) return;
    setSelectedId(null);
    setName("");
    setNameDirty(false);
  }, [open]);

  // 列表加载完成后预选第一个空间。
  useEffect(() => {
    if (!open || !spaces) return;
    setSelectedId((current) => {
      if (current != null) return current;
      return spaces[0]?.id ?? null;
    });
  }, [open, spaces]);

  // 名称始终以云端项目名称为准：切换选中空间时同步服务端名称，
  // 只有用户手动改过（nameDirty）才保留输入值。
  useEffect(() => {
    if (!open || nameDirty) return;
    setName(selectedSpace?.name ?? "");
  }, [open, nameDirty, selectedSpace?.name]);

  const canConfirm = selectedSpace != null && Boolean(name.trim());

  return (
    <Modal
      open={open}
      title={t("modals.cloudPull.title")}
      description={t("modals.cloudPull.description")}
      onClose={() => setCloudPullOpen(false)}
      width="max-w-lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => setCloudPullOpen(false)}>
            {t("modals.importExport.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!canConfirm || spacesBusy}
            onClick={() => selectedSpace && void cloudPullProject(selectedSpace.id, name)}
          >
            <Download className="h-3.5 w-3.5" />
            {t("modals.cloudPull.createAndPull")}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center justify-end">
          <Button
            size="sm"
            variant="ghost"
            disabled={spacesBusy}
            onClick={() => void cloudLoadSpaces()}
            aria-label={t("modals.cloud.refreshAria")}
          >
            <RefreshCw className="h-3 w-3" />
            {t("modals.cloud.refresh")}
          </Button>
        </div>

        <div className="max-h-56 space-y-1.5 overflow-y-auto">
          {spacesBusy && !spaces && (
            <p className="text-2xs text-ink-faint">{t("modals.cloud.loading")}</p>
          )}
          {spacesError && (
            <p className="rounded-md bg-red-50 px-2 py-1.5 text-2xs text-red-600">{spacesError}</p>
          )}
          {spaces && spaces.length === 0 && !spacesError && (
            <p className="text-2xs text-ink-faint">{t("modals.cloudPull.noSpaces")}</p>
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
        </div>

        <label className="block">
          <span className="mb-1 block text-2xs text-ink-soft">{t("modals.cloudPull.nameLabel")}</span>
          <input
            className={`${inputClass} !h-8 !text-xs`}
            placeholder={selectedSpace?.name || t("modals.cloudPull.namePlaceholder")}
            aria-label={t("modals.cloudPull.nameLabel")}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameDirty(true);
            }}
          />
        </label>

        {selectedSpace && (
          <p className="flex items-start gap-1.5 rounded-md bg-blue-50 px-2 py-1.5 text-2xs leading-relaxed text-blue-700">
            <Cloud className="mt-0.5 h-3 w-3 shrink-0" />
            {t("modals.cloudPull.confirmNote", {
              name: name.trim() || selectedSpace.name,
              space: selectedSpace.name,
            })}
          </p>
        )}
      </div>
    </Modal>
  );
}
