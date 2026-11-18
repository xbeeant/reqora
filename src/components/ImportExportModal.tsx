import { useMemo, useRef, useState } from "react";
import { AlertTriangle, BookOpen, CheckCircle2, ClipboardPaste, Download, FileCode2, FileJson, FileText, FolderOpen, FolderPlus, Globe, Lock, Upload } from "lucide-react";
import { api } from "../lib/api.ts";
import {
  KEEP_FOLDER,
  NEW_COLLECTION,
  NEW_FOLDER,
  ROOT_FOLDER,
  listFolderPaths,
  normalizeFolderPath,
  type ImportTarget,
} from "../lib/importTarget.ts";
import { previewImport, type ImportFormat, type ImportPreview } from "../lib/transfer.ts";
import {
  EXPORT_FORMAT_GROUPS,
  exportFormatSpec,
  formatsOfFamily,
  type ExportFamily,
  type ExportFormatId,
} from "../lib/exportFormats.ts";
import { useWorkspace } from "../store/workspace";
import { useT } from "../i18n";
import { Button, Modal, Select, inputClass } from "./ui";
import { DocShareModal } from "./DocShareModal";

type Mode = "import" | "export";

/** 已选择但尚未写入工作区的内容；只有点击「确认导入」才生效。 */
type PendingImport = {
  name: string;
  content: string;
  sourceLabel?: string;
  preview: ImportPreview;
};

/** 值为 i18n key。 */
const FORMAT_KEYS: Record<ImportFormat, string> = {
  postman: "modals.importExport.format.postman",
  "postman-env": "modals.importExport.format.postmanEnv",
  openapi: "modals.importExport.format.openapi",
  har: "modals.importExport.format.har",
  insomnia: "modals.importExport.format.insomnia",
  curl: "modals.importExport.format.curl",
  "test-assets": "modals.importExport.format.testAssets",
  unknown: "modals.importExport.format.unknown",
};

/** 左侧族导航用短名，完整名称显示在右侧面板标题；doc / test-assets 为 i18n key。 */
const FAMILY_SHORT_LABEL: Record<ExportFamily, string> = {
  postman: "Postman",
  openapi: "OpenAPI",
  swagger: "Swagger",
  insomnia: "Insomnia",
  har: "HAR",
  curl: "cURL",
  doc: "modals.importExport.family.doc",
  sdk: "SDK",
  "test-assets": "modals.importExport.family.testAssets",
  bruno: "Bruno",
  opencollection: "OpenCollection",
};

function ExportFormatIcon({ family, className }: { family: ExportFamily; className: string }) {
  const Icon = family === "doc"
    ? BookOpen
    : family === "sdk" || family === "curl"
      ? FileCode2
      : family === "har"
        ? FileText
        : FileJson;
  return <Icon className={className} />;
}

/**
 * Apifox-style data import/export dialog. Import accepts Postman v2.1
 * (collection + environment), Insomnia v4/v5 (JSON/YAML), OpenAPI 3.x
 * (JSON/YAML), HAR 1.2 and raw cURL commands; selecting a file only stages a
 * read-only preview — nothing is
 * written to the workspace until the user clicks "确认导入".
 * Export offers versioned collection formats (Postman v2.1/v2.0 + environment,
 * OpenAPI 3.0.3/3.1.0 JSON+YAML, Swagger 2.0, Insomnia v4/v5, HAR 1.2, cURL)
 * alongside docs/SDK; every renderer goes through exportFormats.ts which reuses
 * redact.ts's redaction egress.
 *
 * The export tab has exactly ONE selection path: a family rail for navigation
 * plus single-select format cards driven by EXPORT_FORMATS (clicking a card only
 * selects it). The single export action lives in the modal footer, so no format
 * can be triggered by a second, inconsistent entry point.
 */
export function ImportExportModal() {
  const t = useT();
  const open = useWorkspace((state) => state.importExportModalOpen);
  const setOpen = useWorkspace((state) => state.setImportExportModalOpen);
  const importContent = useWorkspace((state) => state.importContent);
  const exportAs = useWorkspace((state) => state.exportAs);
  const openDocPages = useWorkspace((state) => state.openDocPages);

  const [mode, setMode] = useState<Mode>("import");
  const [pasted, setPasted] = useState("");
  const [exportPassword, setExportPassword] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [docShareOpen, setDocShareOpen] = useState(false);
  // 导出只有一套状态：族用于导航，exportFormat 是唯一被导出的格式。
  const [exportFamily, setExportFamily] = useState<ExportFamily>("postman");
  const [exportFormat, setExportFormat] = useState<ExportFormatId>("postman-v21");
  const fileRef = useRef<HTMLInputElement>(null);

  const collections = useWorkspace((state) => state.snapshot.collections);
  const activeCollectionId = useWorkspace((state) => state.activeCollectionId);

  // null = follow the active collection. Once the user picks a target explicitly
  // it sticks for the rest of the session (handy when pasting several cURLs).
  const [targetCollection, setTargetCollection] = useState<string | null>(null);
  const [folderChoice, setFolderChoice] = useState<string>(KEEP_FOLDER);
  const [newFolder, setNewFolder] = useState("");
  const [newCollectionName, setNewCollectionName] = useState("");
  const [preserveSourceFolders, setPreserveSourceFolders] = useState(true);

  const effectiveCollection = targetCollection ?? (
    activeCollectionId && collections.some((item) => item.id === activeCollectionId)
      ? activeCollectionId
      : collections[0]?.id ?? NEW_COLLECTION
  );
  const isNewCollection = effectiveCollection === NEW_COLLECTION;
  const folderPaths = useMemo(
    () => (isNewCollection ? [] : listFolderPaths(collections, effectiveCollection)),
    [collections, effectiveCollection, isNewCollection],
  );
  const folderMode: "keep" | "root" | "prefix" =
    folderChoice === KEEP_FOLDER ? "keep" : folderChoice === ROOT_FOLDER ? "root" : "prefix";
  const folderValue = folderChoice === NEW_FOLDER ? normalizeFolderPath(newFolder) : folderChoice;
  const folderMissing = folderChoice === NEW_FOLDER && !folderValue;
  const target: ImportTarget = {
    collectionId: isNewCollection ? null : effectiveCollection,
    newCollectionName: isNewCollection ? newCollectionName.trim() || undefined : undefined,
    folderMode,
    folder: folderMode === "prefix" ? folderValue : undefined,
    preserveSourceFolders,
  };
  const collectionLabel = isNewCollection
    ? t("modals.importExport.labelNewCollection", { name: newCollectionName.trim() || t("modals.importExport.autoName") })
    : t("modals.importExport.labelCollection", { name: collections.find((item) => item.id === effectiveCollection)?.name ?? "—" });
  const folderLabel = folderMode === "keep"
    ? t("modals.importExport.folder.keep")
    : folderMode === "root"
      ? t("modals.importExport.folder.root")
      : preserveSourceFolders
        ? t("modals.importExport.folder.prefix", { folder: folderValue || t("modals.importExport.folder.root") })
        : t("modals.importExport.folder.prefixFlat", { folder: folderValue || t("modals.importExport.folder.root") });

  // 全部格式（含加密文档站与 SDK）都从注册表读取，族切换时同步把选中项落到该族第一项。
  const familyFormats = useMemo(() => formatsOfFamily(exportFamily), [exportFamily]);
  const exportSpec = familyFormats.find((spec) => spec.id === exportFormat)
    ?? exportFormatSpec("postman-v21");
  const needsPassword = exportSpec?.encrypted === true;
  const canExport = !busy && (!needsPassword || exportPassword.trim() !== "");
  const activeGroup = EXPORT_FORMAT_GROUPS.find((group) => group.family === exportFamily);

  const chooseFamily = (family: ExportFamily) => {
    setExportFamily(family);
    const first = formatsOfFamily(family)[0];
    if (first) setExportFormat(first.id);
  };

  const close = () => {
    setOpen(false);
    setMessage(null);
    setPasted("");
    setPending(null);
  };

  /** 选择文件只做只读解析与暂存，不调用 importContent。 */
  const stageFile = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const picked = await api.pickAndReadText();
      setPending({
        name: picked.name,
        content: picked.content,
        sourceLabel: picked.name,
        preview: previewImport(picked.content),
      });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      if (!raw.includes("取消")) setMessage({ ok: false, text: raw });
    } finally {
      setBusy(false);
    }
  };

  /** 粘贴内容同样先进入待确认预览，保持与文件导入一致。 */
  const stagePasted = (asCurl: boolean) => {
    const content = pasted.trim();
    if (!content) return;
    setMessage(null);
    setPending({
      name: asCurl ? t("modals.importExport.pastedCurlName") : t("modals.importExport.pastedDocName"),
      content,
      sourceLabel: asCurl ? "curl" : undefined,
      preview: previewImport(content),
    });
  };

  const confirmImport = () => {
    if (!pending || pending.preview.error || folderMissing) return;
    const summary = importContent(pending.content, pending.sourceLabel, target);
    if (!summary) {
      setMessage({ ok: false, text: t("modals.importExport.importFailed") });
      return;
    }
    const destination = pending.preview.format === "postman-env"
      ? t("modals.importExport.envDestination")
      : `${collectionLabel} / ${folderLabel}`;
    const counts = pending.preview.format === "postman-env"
      ? t("modals.importExport.envCounts", { added: summary.addedEnvironments, merged: summary.mergedEnvironments })
      : t("modals.importExport.requestCounts", { added: summary.addedRequests, overwritten: summary.overwrittenRequests });
    const warningText = summary.warnings.length > 0
      ? t("modals.importExport.warningSuffix", { count: summary.warnings.length })
      : "";
    setMessage({
      ok: true,
      text: t("modals.importExport.importedMessage", { name: pending.name, destination, counts, warnings: warningText }),
    });
    setPending(null);
    setPasted("");
  };

  /** 唯一的导出口：格式只取自选择器的当前选中项。 */
  const doExport = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await exportAs(exportSpec.id, exportPassword || undefined);
      setMessage({ ok: true, text: t("modals.importExport.exportDone", { fileName: exportSpec.fileName }) });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open={open}
        title={t("modals.importExport.title")}
        description={t("modals.importExport.description")}
        onClose={close}
        width="max-w-2xl"
        footer={mode === "export" ? (
          <div className="flex w-full flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold text-ink">
                {t("modals.importExport.selected", { label: exportSpec.label, variant: exportSpec.variant })}
              </div>
              <div className="truncate text-2xs text-ink-faint">
                {t("modals.importExport.saveAs", { fileName: exportSpec.fileName, version: exportSpec.version })}
              </div>
            </div>
            {needsPassword && (
              <input
                type="password"
                className="wb-input !h-8 !w-48"
                placeholder={t("modals.importExport.passwordPlaceholder")}
                aria-label={t("modals.importExport.passwordAria")}
                value={exportPassword}
                onChange={(event) => setExportPassword(event.target.value)}
              />
            )}
            <Button variant="primary" disabled={!canExport} onClick={() => void doExport()}>
              <Download className="h-3.5 w-3.5" />
              {t("modals.importExport.export")}
            </Button>
          </div>
        ) : undefined}
      >
      <div className="wb-segment mb-4 !w-fit">
        <button type="button" className={mode === "import" ? "active" : ""} onClick={() => setMode("import")}>
          <Upload className="mr-1 inline h-3 w-3" />
          {t("modals.importExport.tabImport")}
        </button>
        <button type="button" className={mode === "export" ? "active" : ""} onClick={() => setMode("export")}>
          <Download className="mr-1 inline h-3 w-3" />
          {t("modals.importExport.tabExport")}
        </button>
      </div>

      {mode === "import" ? (
        <div className="space-y-4">
          <div className="grid grid-cols-5 gap-3">
            <div className="wb-import-card">
              <FileJson className="h-5 w-5 text-brand-500" />
              <div className="text-xs font-semibold text-ink">Postman</div>
              <div className="text-2xs text-ink-faint">{t("modals.importExport.card.postmanDesc")}</div>
            </div>
            <div className="wb-import-card">
              <FileJson className="h-5 w-5 text-brand-500" />
              <div className="text-xs font-semibold text-ink">{t("modals.importExport.format.openapi")}</div>
              <div className="text-2xs text-ink-faint">{t("modals.importExport.card.openapiDesc")}</div>
            </div>
            <div className="wb-import-card">
              <FileJson className="h-5 w-5 text-brand-500" />
              <div className="text-xs font-semibold text-ink">Insomnia</div>
              <div className="text-2xs text-ink-faint">{t("modals.importExport.card.insomniaDesc")}</div>
            </div>
            <div className="wb-import-card">
              <FileJson className="h-5 w-5 text-brand-500" />
              <div className="text-xs font-semibold text-ink">HAR</div>
              <div className="text-2xs text-ink-faint">{t("modals.importExport.card.harDesc")}</div>
            </div>
            <div className="wb-import-card">
              <ClipboardPaste className="h-5 w-5 text-brand-500" />
              <div className="text-xs font-semibold text-ink">cURL</div>
              <div className="text-2xs text-ink-faint">{t("modals.importExport.card.curlDesc")}</div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="primary" disabled={busy} onClick={() => void stageFile()}>
              <Upload className="h-3.5 w-3.5" />
              {t("modals.importExport.chooseFile")}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,.yaml,.yml,.txt,.har,application/json"
              className="hidden"
              aria-hidden="true"
              tabIndex={-1}
            />
            <span className="text-2xs text-ink-faint">{t("modals.importExport.previewHint")}</span>
          </div>

          <div className="wb-import-target">
            <div className="mb-2.5 flex flex-wrap items-center gap-1.5 text-xs font-semibold text-ink">
              <FolderPlus className="h-3.5 w-3.5 text-brand-500" />
              {t("modals.importExport.importTo")}
              <span className="ml-auto text-2xs font-normal text-ink-faint">
                {collectionLabel} / {folderLabel}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="wb-label" htmlFor="import-collection">{t("modals.importExport.targetCollection")}</label>
                <Select
                  id="import-collection"
                  value={effectiveCollection}
                  aria-label={t("modals.importExport.ariaTargetCollection")}
                  onChange={(event) => {
                    setTargetCollection(event.target.value);
                    // Folder paths only exist inside one collection.
                    setFolderChoice(KEEP_FOLDER);
                    setNewFolder("");
                  }}
                >
                  {collections.map((collection) => (
                    <option key={collection.id} value={collection.id}>{collection.name}</option>
                  ))}
                  <option value={NEW_COLLECTION}>{t("modals.importExport.newCollectionOption")}</option>
                </Select>
                {isNewCollection && (
                  <input
                    className={`${inputClass} mt-2 !h-8 !text-xs`}
                    value={newCollectionName}
                    placeholder={t("modals.importExport.newCollectionNamePlaceholder")}
                    aria-label={t("modals.importExport.newCollectionNameAria")}
                    onChange={(event) => setNewCollectionName(event.target.value)}
                  />
                )}
              </div>
              <div>
                <label className="wb-label" htmlFor="import-folder">{t("modals.importExport.targetFolder")}</label>
                <Select
                  id="import-folder"
                  value={folderChoice}
                  aria-label={t("modals.importExport.ariaTargetFolder")}
                  onChange={(event) => setFolderChoice(event.target.value)}
                >
                  <option value={KEEP_FOLDER}>{t("modals.importExport.folder.keepOption")}</option>
                  <option value={ROOT_FOLDER}>{t("modals.importExport.folder.rootOption")}</option>
                  {folderPaths.map((path) => (
                    <option key={path} value={path}>{path}</option>
                  ))}
                  <option value={NEW_FOLDER}>{t("modals.importExport.folder.newOption")}</option>
                </Select>
                {folderChoice === NEW_FOLDER && (
                  <input
                    className={`${inputClass} mt-2 !h-8 !text-xs`}
                    value={newFolder}
                    placeholder={t("modals.importExport.newFolderPlaceholder")}
                    aria-label={t("modals.importExport.newFolderAria")}
                    onChange={(event) => setNewFolder(event.target.value)}
                  />
                )}
              </div>
            </div>
            {folderMode === "prefix" && (
              <label className="mt-2.5 flex cursor-pointer items-center gap-1.5 text-2xs text-ink-soft">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-brand-600"
                  checked={preserveSourceFolders}
                  onChange={(event) => setPreserveSourceFolders(event.target.checked)}
                />
                {t("modals.importExport.preserveSource")}
              </label>
            )}
            {folderMissing && (
              <p className="mt-2 text-2xs text-red-600">{t("modals.importExport.folderMissing")}</p>
            )}
            <p className="wb-hint mt-2.5">
              {t("modals.importExport.hint1")}
            </p>
            <p className="wb-hint mt-1.5">
              {t("modals.importExport.hint2")}
            </p>
          </div>

          {pending && (
            <div className="rounded-md border border-blue-200 bg-blue-50/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-ink">{t("modals.importExport.pendingTitle", { name: pending.name })}</div>
                  <div className="text-2xs text-ink-faint">{t("modals.importExport.pendingHint")}</div>
                </div>
                <button
                  type="button"
                  className="shrink-0 text-2xs text-ink-faint hover:text-ink"
                  onClick={() => setPending(null)}
                >
                  {t("modals.importExport.cancel")}
                </button>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-2xs text-ink-soft sm:grid-cols-4">
                <span>
                  {t("modals.importExport.formatPrefix")}<span className="font-medium text-ink">{t(FORMAT_KEYS[pending.preview.format])}</span>
                </span>
                <span>{t("modals.importExport.countCollections", { count: pending.preview.collectionNames.length })}</span>
                <span>{t("modals.importExport.countRequests", { count: pending.preview.requestCount })}</span>
                <span>{t("modals.importExport.countEnvironments", { count: pending.preview.environmentNames.length })}</span>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded border border-surface-border bg-surface px-2 py-1.5 text-2xs text-ink-soft">
                <FolderOpen className="h-3 w-3 shrink-0 text-brand-500" />
                {pending.preview.format === "postman-env"
                  ? t("modals.importExport.envOnlyHint")
                  : t("modals.importExport.importDestination", { target: `${collectionLabel} / ${folderLabel}` })}
              </div>

              {!isNewCollection && pending.preview.format !== "postman-env" && (
                <p className="mt-1.5 text-2xs text-ink-faint">
                  {t("modals.importExport.overwriteHint")}
                </p>
              )}
              {pending.preview.collectionNames.length > 0 && (
                <p className="mt-1.5 truncate text-2xs text-ink-faint">
                  {t("modals.importExport.collectionsList", { names: pending.preview.collectionNames.join("、") })}
                </p>
              )}
              {pending.preview.variableNames.length > 0 && (
                <p className="mt-1 break-all text-2xs text-ink-faint">
                  {t("modals.importExport.variablesList", { names: pending.preview.variableNames.map((name) => `{{${name}}}`).join("、") })}
                </p>
              )}
              {pending.preview.warnings.length > 0 && (
                <ul className="mt-1.5 space-y-0.5 text-2xs text-amber-700">
                  {pending.preview.warnings.slice(0, 4).map((warning, index) => (
                    <li key={index}>• {warning}</li>
                  ))}
                  {pending.preview.warnings.length > 4 && (
                    <li>{t("modals.importExport.moreWarnings", { count: pending.preview.warnings.length - 4 })}</li>
                  )}
                </ul>
              )}
              {pending.preview.error && (
                <p className="mt-1.5 text-2xs text-red-600">{t("modals.importExport.parseError", { error: pending.preview.error })}</p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button variant="primary" disabled={!!pending.preview.error || folderMissing} onClick={confirmImport}>
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {t("modals.importExport.confirmImport")}
                </Button>
                <Button size="sm" onClick={() => setPending(null)}>
                  {t("modals.importExport.cancel")}
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void stageFile()}>
                  {t("modals.importExport.rechooseFile")}
                </Button>
              </div>
            </div>
          )}

          <div>
            <label className="wb-label">{t("modals.importExport.pasteLabel")}</label>
            <textarea
              className="wb-code scrollbar-thin !h-32 w-full rounded-md border border-surface-border bg-surface p-2 text-xs"
              value={pasted}
              spellCheck={false}
              placeholder={"curl -X POST https://api.example.com/login -H 'Content-Type: application/json' -d '{\"user\":\"a\"}'"}
              aria-label={t("modals.importExport.pasteAria")}
              onChange={(event) => setPasted(event.target.value)}
            />
            <div className="mt-2 flex gap-2">
              <Button size="sm" disabled={!pasted.trim()} onClick={() => stagePasted(true)}>
                {t("modals.importExport.previewCurl")}
              </Button>
              <Button size="sm" disabled={!pasted.trim()} onClick={() => stagePasted(false)}>
                {t("modals.importExport.previewCollection")}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs font-semibold text-ink">
            <FileJson className="h-3.5 w-3.5 text-brand-500" />
            {t("modals.importExport.exportFormats")}
            <span className="ml-auto text-2xs font-normal text-ink-faint">
              {t("modals.importExport.exportHint")}
            </span>
          </div>

          <div className="wb-export-picker">
            <div className="wb-export-families" role="group" aria-label={t("modals.importExport.ariaFamilies")}>
              {EXPORT_FORMAT_GROUPS.map((group) => {
                const active = group.family === exportFamily;
                return (
                  <button
                    key={group.family}
                    type="button"
                    className={`wb-export-family${active ? " active" : ""}`}
                    aria-pressed={active}
                    title={group.label}
                    onClick={() => chooseFamily(group.family)}
                  >
                    <ExportFormatIcon family={group.family} className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{t(FAMILY_SHORT_LABEL[group.family])}</span>
                    <span className="wb-export-family-count">
                      {formatsOfFamily(group.family).length}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-1.5 text-2xs text-ink-faint">
                <ExportFormatIcon family={exportFamily} className="h-3.5 w-3.5 shrink-0 text-brand-500" />
                <span className="font-semibold text-ink-soft">{activeGroup?.label}</span>
                <span>{t("modals.importExport.familyVersions", { count: familyFormats.length })}</span>
              </div>
              <div className="wb-export-choices" role="group" aria-label={t("modals.importExport.ariaVersions")}>
                {familyFormats.map((spec) => {
                  const selected = spec.id === exportSpec.id;
                  return (
                    <button
                      key={spec.id}
                      type="button"
                      className={`wb-export-card wb-export-choice${selected ? " selected" : ""}`}
                      aria-pressed={selected}
                      onClick={() => setExportFormat(spec.id)}
                    >
                      <div className="wb-export-choice-head">
                        <span className={`wb-export-radio${selected ? " on" : ""}`} aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
                          {spec.label}
                        </span>
                        {spec.encrypted && <Lock className="h-3.5 w-3.5 shrink-0 text-brand-500" />}
                      </div>
                      <div className="text-2xs font-medium text-brand-600">{spec.variant}</div>
                      <div className="text-2xs leading-relaxed text-ink-faint">{spec.description}</div>
                      <div className="truncate text-2xs text-ink-faint" title={spec.fileName}>
                        {spec.fileName}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="wb-docshare-entry">
            <div>
              <div className="text-xs font-semibold text-ink">{t("modals.importExport.docEntry.title")}</div>
              <div className="text-2xs text-ink-faint">
                {t("modals.importExport.docEntry.desc")}
              </div>
            </div>
            <Button size="sm" variant="secondary" onClick={() => openDocPages()}>
              <BookOpen className="mr-1 h-3.5 w-3.5" />
              {t("modals.importExport.docEntry.editSections")}
            </Button>
            <Button size="sm" onClick={() => setDocShareOpen(true)}>
              <Globe className="mr-1 h-3.5 w-3.5" />
              {t("modals.importExport.docEntry.previewPublish")}
            </Button>
          </div>
          <p className="wb-hint">
            {t("modals.importExport.exportScopeHint")}
          </p>
        </div>
      )}

      {message && (
        <div className={`mt-4 flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
          message.ok
            ? "border-emerald-200 bg-emerald-50 text-emerald-800"
            : "border-red-200 bg-red-50 text-red-700"
        }`}>
          {message.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
          {message.text}
        </div>
      )}
      </Modal>
      <DocShareModal open={docShareOpen} onClose={() => setDocShareOpen(false)} />
    </>
  );
}
