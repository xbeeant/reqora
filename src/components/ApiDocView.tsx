import { useMemo, useState } from "react";
import { BookMarked, Braces, ChevronDown, ChevronRight, Copy, Database, Pencil, Play, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { deriveParamSections } from "../lib/docs.ts";
import type { ParamRow } from "../lib/docs.ts";
import { emptyDoc,
  EMPTY_DATA_MODELS,
} from "../lib/defaults.ts";
import { parseSchemaText, schemaFieldRows } from "../lib/jsonschema.ts";
import { normalizeResponseParams } from "../lib/responseParams.ts";
import { formatResponseExampleBody, responseExampleHint } from "../lib/responseExamples.ts";
import { requestBodyFieldTreeRows, responseParamTreeRows } from "../lib/responseParamTree.ts";
import type { ResponseParamTreeRow } from "../lib/responseParamTree.ts";
import type { DocStatus, ParamMeta, ResponseExample, ResponseParam, ResponseParamLocation } from "../types";
import { Button, EmptyState, Select, inputClass } from "./ui";
import { MarkdownView } from "./MarkdownView";
import { useT } from "../i18n";

const DOC_STATUSES: DocStatus[] = ["开发中", "联调中", "已完成", "已废弃"];

const statusClass = (status: DocStatus) =>
  status === "已完成"
    ? "wb-doc-status ok"
    : status === "已废弃"
      ? "wb-doc-status dead"
      : "wb-doc-status";

/** 与 responseParamTree 契约一致的每层缩进像素（TREE_INDENT）。 */
const TREE_INDENT = 14;

/** 字段树行的渲染视图，供文档表格直接消费。 */
interface DocTreeRow {
  key: string;
  depth: number;
  indentPx: number;
  isGroup: boolean;
  containerType: string;
  label: string;
  item: ResponseParam | null;
  /** 与 splitPath 同源的末级字段名，替代自行 lastIndexOf(".") 拆 path。 */
  leafName: string;
  /** 重命名时拼接用的前缀（原 name 去掉末段后的部分，含末尾的点）。 */
  prefix: string;
}

/**
 * 把 responseParamTreeRows 的行投影成表格视图。直接消费新契约的 isGroup /
 * indent（= depth * TREE_INDENT）/ leafName；对尚未携带这些字段的旧行形状
 * （旧快照 / 并行改造的过渡期）按等价规则回退，保证两种形状下渲染一致，
 * 也不把本文件与 responseParamTree 的具体导出做编译期绑定。
 */
function toDocTreeRows(rows: readonly unknown[]): DocTreeRow[] {
  return rows.map((raw, index) => {
    const node = raw as {
      key?: string;
      path?: string;
      label?: string;
      depth?: number;
      children?: number;
      containerType?: string;
      item?: ResponseParam | null;
      isGroup?: boolean;
      indent?: number;
      leafName?: string;
    };
    const item = node.item ?? null;
    const rawName = item?.name ?? "";
    const depth = node.depth ?? 0;
    const leafName = node.leafName ?? rawName.slice(rawName.lastIndexOf(".") + 1);
    const cut = rawName.lastIndexOf(".");
    // leafName 是原 name 的末段时，前缀就是去掉它的剩余部分（含末尾的点）；
    // 否则回退到按最后一个点切分，保持旧行为。
    const prefix =
      leafName !== "" && rawName.endsWith(leafName)
        ? rawName.slice(0, rawName.length - leafName.length)
        : cut === -1
          ? ""
          : rawName.slice(0, cut + 1);
    return {
      key: node.key ?? node.path ?? `row-${index}`,
      depth,
      indentPx: node.indent ?? depth * TREE_INDENT,
      isGroup: node.isGroup ?? (node.children ?? 0) > 0,
      containerType: node.containerType ?? "",
      label: node.label ?? node.leafName ?? node.path ?? "",
      item,
      leafName,
      prefix,
    };
  });
}

/**
 * Apifox-style interface documentation view. The parameter tables are derived
 * live from the request definition; only per-param metadata (type / required /
 * description / example) is stored as a doc increment — the request itself is
 * the single source of truth.
 */
export function ApiDocView() {
  const t = useT();
  const draft = useWorkspace((state) => state.draft);
  const activeTab = useWorkspace((state) => state.activeTab);
  const response = useWorkspace((state) => state.response);
  const models = useWorkspace((state) => state.snapshot.dataModels ?? EMPTY_DATA_MODELS);
  const updateDoc = useWorkspace((state) => state.updateDoc);
  const updateParamMeta = useWorkspace((state) => state.updateParamMeta);
  const saveResponseExample = useWorkspace((state) => state.saveResponseExample);
  const updateResponseExample = useWorkspace((state) => state.updateResponseExample);
  const deleteResponseExample = useWorkspace((state) => state.deleteResponseExample);
  const addResponseParam = useWorkspace((state) => state.addResponseParam);
  const updateResponseParam = useWorkspace((state) => state.updateResponseParam);
  const deleteResponseParam = useWorkspace((state) => state.deleteResponseParam);
  const generateResponseParams = useWorkspace((state) => state.generateResponseParams);
  const saveDraftAsCase = useWorkspace((state) => state.saveDraftAsCase);
  const setDetailTab = useWorkspace((state) => state.setDetailTab);

  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({ query: true, header: true, body: true });
  const [openExample, setOpenExample] = useState<string | null>(null);
  const [savedHint, setSavedHint] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState<string | null>(null);
  const [bodyDraft, setBodyDraft] = useState("");

  // `doc` is optional on imported/restored snapshots. Never hide the whole
  // documentation view (including the binding controls) because it is missing.
  const doc = draft.doc ?? emptyDoc();
  const boundModel = models.find((model) => model.id === doc.requestModelId) ?? null;
  const boundRows = useMemo(() => {
    if (!boundModel) return [];
    const parsed = parseSchemaText(boundModel.schemaText);
    return parsed.schema ? schemaFieldRows(parsed.schema) : [];
  }, [boundModel]);
  const modelBadge = (id: string | undefined) => {
    if (!id) return null;
    const model = models.find((item) => item.id === id);
    return model ? (
      <span className="wb-mini-badge text-emerald-600">{t("docs.model.bound", { name: model.name })}</span>
    ) : (
      <span className="wb-mini-badge text-red-500">{t("docs.model.deleted")}</span>
    );
  };

  // Without an open request tab the draft is a scratch request: editing its
  // doc would look successful but never be persisted. Show guidance instead.
  if (activeTab?.kind !== "request") {
    return (
      <div className="wb-doc scrollbar-thin">
        <EmptyState
          title={t("docs.empty.title")}
          description={t("docs.empty.desc")}
        />
      </div>
    );
  }
  const sections = deriveParamSections(draft, doc);

  // 文档页标识请求体类型：form-data / json 等一目了然（无请求体时不显示）。
  const bodyTypeBadge = (() => {
    const body = draft.body;
    switch (body.type) {
      case "none":
        return null;
      case "json":
        return "application/json";
      case "raw":
        return body.contentType?.trim() || "Raw";
      case "formUrlEncoded":
        return "application/x-www-form-urlencoded";
      case "formData":
        return "multipart/form-data";
      case "binary":
        return body.contentType?.trim() || "binary";
      case "graphql":
        return "GraphQL";
    }
  })();

  const toggleSection = (key: string) =>
    setOpenSections((current) => ({ ...current, [key]: !current[key] }));

  const startEditDesc = () => {
    setDescDraft(doc.description);
    setEditingDesc(true);
  };

  const commitDesc = () => {
    updateDoc({ description: descDraft });
    setEditingDesc(false);
  };

  const showHint = (message: string) => {
    setSavedHint(message);
    setTimeout(() => setSavedHint(null), 2500);
  };

  /**
   * 请求体字段按对象层级展示：JSON Body 派生出的 `specValueList[0].bid`
   * 会被 requestBodyFieldTreeRows 折叠成 `specValueList` (array) → `bid` 的
   * 树形行。带 meta 的容器（array / object）与普通叶子一样可编辑示例值 /
   * 类型 / 必填 / 说明；旧快照里没有合成 meta 的容器退回只读结构行。
   * Query / Header 是平铺键值，不走这层投影。
   */
  const renderBodyParams = (rows: ParamRow[]) => (
    <table className="wb-doc-table wb-doc-tree-table">
      <thead>
        <tr>
          <th>{t("docs.col.paramName")}</th>
          <th>{t("docs.col.example")}</th>
          <th className="!w-24">{t("docs.col.type")}</th>
          <th className="!w-14">{t("docs.col.required")}</th>
          <th>{t("docs.col.description")}</th>
        </tr>
      </thead>
      <tbody>
        {requestBodyFieldTreeRows(rows).map((node: ResponseParamTreeRow<ParamRow>) => {
          const indent = { paddingLeft: `${node.indent}px` };
          const row = node.item;
          // 容器行没有合成 meta（旧快照）时退回只读结构行，不提供编辑框。
          if (node.isGroup && !row) {
            return (
              <tr key={node.key} className="wb-doc-tree-group">
                <td>
                  <div className="wb-doc-tree-name" style={indent}>
                    <span className="truncate font-mono text-[11px] font-medium text-ink">
                      {node.leafName}
                    </span>
                  </div>
                </td>
                <td />
                <td>
                  <span className="font-mono text-[11px] text-ink-soft">{node.containerType}</span>
                </td>
                <td className="text-center text-2xs text-ink-faint">—</td>
                <td />
              </tr>
            );
          }
          if (!row) return null;
          const meta: ParamMeta = row.meta;
          return (
            <tr key={row.key} className={node.isGroup ? "wb-doc-tree-group" : undefined}>
              <td>
                <div className="wb-doc-tree-name" style={indent}>
                  {node.depth > 0 && !node.isGroup ? (
                    <span className="wb-doc-tree-leaf" aria-hidden="true" />
                  ) : null}
                  <code
                    className={`font-mono text-[11.5px] ${node.isGroup ? "font-medium text-ink" : "text-ink"}`}
                  >
                    {node.leafName}
                  </code>
                </div>
                {!meta.example && row.value && (
                  <span className="ml-2 text-2xs text-ink-faint">{t("docs.currentValue", { value: row.value })}</span>
                )}
              </td>
              <td>
                <input
                  className={`${inputClass} !h-6 !py-0 !text-[11px]`}
                  value={meta.example}
                  placeholder={t("docs.col.example")}
                  aria-label={t("docs.aria.example", { name: node.leafName })}
                  onChange={(event) =>
                    updateParamMeta(row.key, { example: event.target.value })
                  }
                />
              </td>
              <td>
                <input
                  className={`${inputClass} !h-6 !py-0 !text-[11px]`}
                  value={meta.type}
                  placeholder={node.containerType || "string"}
                  aria-label={t("docs.aria.type", { name: node.leafName })}
                  onChange={(event) => updateParamMeta(row.key, { type: event.target.value })}
                />
              </td>
              <td className="text-center">
                <input
                  type="checkbox"
                  checked={meta.required}
                  aria-label={t("docs.aria.required", { name: node.leafName })}
                  onChange={(event) => updateParamMeta(row.key, { required: event.target.checked })}
                />
              </td>
              <td>
                <input
                  className={`${inputClass} !h-6 !py-0 !text-[11px]`}
                  value={meta.description}
                  placeholder={t("docs.placeholder.paramDesc")}
                  aria-label={t("docs.aria.description", { name: node.leafName })}
                  onChange={(event) => updateParamMeta(row.key, { description: event.target.value })}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  /**
   * 响应参数定义：每个响应示例一份独立字段表。字段名是响应体 JSON 路径或响应头名，
   * 类型 / 必填 / 示例值 / 说明都是文档增量，随工作区持久化并进入所有导出链路。
   */
  const renderResponseParams = (example: ResponseExample) => {
    const params = normalizeResponseParams(example.params);
    return (
      <div className="wb-doc-response-params">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="flex-1 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
            {t("docs.respParams.count", { count: params.length })}
          </h4>
          <Button
            size="sm"
            variant="ghost"
            title={t("docs.respParams.regenerate.title")}
            onClick={() => {
              const added = generateResponseParams(example.id);
              showHint(
                added > 0
                  ? t("docs.respParams.generated", { count: added })
                  : t("docs.respParams.noNew"),
              );
            }}
          >
            <RefreshCw className="h-3 w-3" />
            {t("docs.respParams.generate")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => addResponseParam(example.id)}>
            <Plus className="h-3 w-3" />
            {t("docs.respParams.add")}
          </Button>
        </div>
        {params.length === 0 ? (
          <p className="px-1 py-2 text-2xs leading-relaxed text-ink-faint">
            {t("docs.respParams.empty")}
          </p>
        ) : (
          <table className="wb-doc-table wb-doc-tree-table">
            <thead>
              <tr>
                <th className="!w-20">{t("docs.col.location")}</th>
                <th>{t("docs.col.paramName")}</th>
                <th className="!w-24">{t("docs.col.type")}</th>
                <th className="!w-14">{t("docs.col.required")}</th>
                <th className="!w-32">{t("docs.col.example")}</th>
                <th>{t("docs.col.description")}</th>
                <th className="!w-10" />
              </tr>
            </thead>
            <tbody>
              {toDocTreeRows(responseParamTreeRows(params)).map((node) => {
                const indent = { paddingLeft: `${node.indentPx}px` };
                const row = node.item;
                // 对象 / 数组父级：字段表里通常没有独立一行，这里按只读层级行展示。
                if (!row) {
                  return (
                    <tr key={node.key} className="wb-doc-tree-group">
                      <td className="text-2xs text-ink-faint">Body</td>
                      <td>
                        <div className="wb-doc-tree-name" style={indent}>
                          <span className="truncate font-mono text-[11px] font-medium text-ink">
                            {node.label}
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className="font-mono text-[11px] text-ink-soft">
                          {node.containerType}
                        </span>
                      </td>
                      <td className="text-center text-2xs text-ink-faint">—</td>
                      <td />
                      <td />
                      <td />
                    </tr>
                  );
                }
                // 叶子只编辑最后一层字段名（leafName，与 splitPath 同源），
                // 前面的层级路径由 node.prefix 保留（含 [0] 下标）。
                return (
                  <tr key={node.key}>
                    <td>
                      <Select
                        className="!h-6 !w-full !py-0 !text-[11px]"
                        value={row.location}
                        aria-label={t("docs.aria.location", { name: row.name || t("docs.defaultField") })}
                        onChange={(event) =>
                          updateResponseParam(example.id, row.id, {
                            location: event.target.value as ResponseParamLocation,
                          })
                        }
                      >
                        <option value="body">Body</option>
                        <option value="header">Header</option>
                      </Select>
                    </td>
                    <td>
                      <div className="wb-doc-tree-name" style={indent}>
                        {node.depth > 0 && !node.isGroup ? (
                          <span className="wb-doc-tree-leaf" aria-hidden="true" />
                        ) : null}
                        <input
                          className={`${inputClass} !h-6 !py-0 !font-mono !text-[11px]`}
                          value={node.leafName}
                          placeholder={node.depth > 0 ? t("docs.placeholder.fieldName") : "data.list[0].id"}
                          title={t("docs.aria.fullPath", { name: row.name || t("docs.unnamed") })}
                          aria-label={t("docs.aria.paramName")}
                          onChange={(event) => {
                            const next = event.target.value;
                            updateResponseParam(example.id, row.id, {
                              // 清空等于重新命名整条字段，保留前缀会留下 `data.` 这种残尾。
                              name: next.trim() === "" ? "" : `${node.prefix}${next}`,
                            });
                          }}
                        />
                      </div>
                    </td>
                    <td>
                      <input
                        className={`${inputClass} !h-6 !py-0 !text-[11px]`}
                        value={row.type}
                        placeholder="string"
                        aria-label={t("docs.aria.type", { name: row.name || t("docs.defaultField") })}
                        onChange={(event) =>
                          updateResponseParam(example.id, row.id, { type: event.target.value })
                        }
                      />
                    </td>
                    <td className="text-center">
                      <input
                        type="checkbox"
                        checked={row.required}
                        aria-label={t("docs.aria.required", { name: row.name || t("docs.defaultField") })}
                        onChange={(event) =>
                          updateResponseParam(example.id, row.id, { required: event.target.checked })
                        }
                      />
                    </td>
                    <td>
                      <input
                        className={`${inputClass} !h-6 !py-0 !text-[11px]`}
                        value={row.example}
                        placeholder={t("docs.col.example")}
                        aria-label={t("docs.aria.example", { name: row.name || t("docs.defaultField") })}
                        onChange={(event) =>
                          updateResponseParam(example.id, row.id, { example: event.target.value })
                        }
                      />
                    </td>
                    <td>
                      <input
                        className={`${inputClass} !h-6 !py-0 !text-[11px]`}
                        value={row.description}
                        placeholder={t("docs.placeholder.desc")}
                        aria-label={t("docs.aria.description", { name: row.name || t("docs.defaultField") })}
                        onChange={(event) =>
                          updateResponseParam(example.id, row.id, { description: event.target.value })
                        }
                      />
                    </td>
                    <td className="text-center">
                      <button
                        type="button"
                        className="wb-icon-btn !h-5 !w-5"
                        title={t("docs.btnDeleteField")}
                        aria-label={t("docs.btnDeleteField")}
                        onClick={() => deleteResponseParam(example.id, row.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="text-2xs leading-relaxed text-ink-faint">
          {t("docs.respParams.note")}
        </p>
      </div>
    );
  };

  return (
    <div className="wb-doc scrollbar-thin">
      <div className="wb-doc-head">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold text-ink">{draft.name}</h2>
            <span className={`wb-method !w-auto !text-[10px] wb-method-${draft.method.toLowerCase()}`}>
              {draft.method}
            </span>
            <code className="truncate rounded bg-surface-muted px-2 py-0.5 font-mono text-[11px] text-ink-soft">
              {draft.url || t("docs.noUrl")}
            </code>
          </div>
          {doc.summary && <p className="text-xs text-ink-soft">{doc.summary}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span className={statusClass(doc.status)}>{doc.status}</span>
          <Select
            className="!h-7 !w-[104px] !py-0 !text-[11px]"
            value={doc.status}
            aria-label={t("docs.aria.docStatus")}
            onChange={(event) => updateDoc({ status: event.target.value as DocStatus })}
          >
            {DOC_STATUSES.map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </Select>
          <input
            className={`${inputClass} !h-7 !w-24 !py-0 !text-[11px]`}
            value={doc.owner}
            placeholder={t("docs.owner")}
            aria-label={t("docs.owner")}
            onChange={(event) => updateDoc({ owner: event.target.value })}
          />
          <Button size="sm" variant="primary" onClick={() => saveDraftAsCase()}>
            <Save className="h-3.5 w-3.5" />
            {t("docs.saveAsCase")}
          </Button>
        </div>
      </div>

      {savedHint && <div className="wb-banner wb-banner-ok mb-3">{savedHint}</div>}

      <section className="wb-doc-section">
        <div className="flex items-center gap-2">
          <BookMarked className="h-3.5 w-3.5 text-brand-500" />
          <h3 className="flex-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("docs.section.desc")}</h3>
          {editingDesc ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setEditingDesc(false)}>{t("docs.cancel")}</Button>
              <Button size="sm" onClick={commitDesc}>{t("docs.saveDesc")}</Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={startEditDesc}>{t("docs.editDesc")}</Button>
          )}
        </div>
        {editingDesc ? (
          <textarea
            className={`${inputClass} mt-2 min-h-[160px] font-mono text-[12px] leading-relaxed`}
            value={descDraft}
            aria-label={t("docs.aria.descEditor")}
            placeholder={t("docs.placeholder.markdown")}
            onChange={(event) => setDescDraft(event.target.value)}
          />
        ) : (
          <MarkdownView
            text={doc.description}
            emptyHint={t("docs.emptyDesc")}
          />
        )}
      </section>

      {sections.map((section) => (
        <section key={section.location} className="wb-doc-section">
          <button
            type="button"
            className="flex w-full items-center gap-2 text-left"
            onClick={() => toggleSection(section.location)}
            aria-expanded={openSections[section.location]}
          >
            {openSections[section.location] ? (
              <ChevronDown className="h-3.5 w-3.5 text-ink-faint" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-ink-faint" />
            )}
            <h3 className="flex-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
              {section.label} · {section.rows.length}
            </h3>
            {section.location === "body" && bodyTypeBadge && (
              <span
                className="wb-mini-badge font-mono"
                title={t("docs.bodyType.title")}
              >
                {bodyTypeBadge}
              </span>
            )}
          </button>
          {openSections[section.location] && (
            section.rows.length === 0 ? (
              <p className="px-1 py-2 text-2xs text-ink-faint">{t("docs.noParams", { label: section.label })}</p>
            ) : section.location === "body" ? (
              renderBodyParams(section.rows)
            ) : (
              <table className="wb-doc-table">
                <thead>
                  <tr>
                    <th>{t("docs.col.paramName")}</th>
                    <th>{t("docs.col.example")}</th>
                    <th className="!w-24">{t("docs.col.type")}</th>
                    <th className="!w-14">{t("docs.col.required")}</th>
                    <th>{t("docs.col.description")}</th>
                  </tr>
                </thead>
                <tbody>
                  {section.rows.map((row) => {
                    const meta: ParamMeta = row.meta;
                    return (
                      <tr key={row.key}>
                        <td>
                          <code className="font-mono text-[11.5px] text-ink">{row.name}</code>
                          {!meta.example && row.value && (
                            <span className="ml-2 text-2xs text-ink-faint">{t("docs.currentValue", { value: row.value })}</span>
                          )}
                        </td>
                        <td>
                          <input
                            className={`${inputClass} !h-6 !py-0 !text-[11px]`}
                            value={meta.example}
                            placeholder={t("docs.col.example")}
                            aria-label={t("docs.aria.example", { name: row.name })}
                            onChange={(event) =>
                              updateParamMeta(row.key, { example: event.target.value })
                            }
                          />
                        </td>
                        <td>
                          <input
                            className={`${inputClass} !h-6 !py-0 !text-[11px]`}
                            value={meta.type}
                            placeholder="string"
                            aria-label={t("docs.aria.type", { name: row.name })}
                            onChange={(event) => updateParamMeta(row.key, { type: event.target.value })}
                          />
                        </td>
                        <td className="text-center">
                          <input
                            type="checkbox"
                            checked={meta.required}
                            aria-label={t("docs.aria.required", { name: row.name })}
                            onChange={(event) => updateParamMeta(row.key, { required: event.target.checked })}
                          />
                        </td>
                        <td>
                          <input
                            className={`${inputClass} !h-6 !py-0 !text-[11px]`}
                            value={meta.description}
                            placeholder={t("docs.placeholder.paramDesc")}
                            aria-label={t("docs.aria.description", { name: row.name })}
                            onChange={(event) => updateParamMeta(row.key, { description: event.target.value })}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          )}
        </section>
      ))}

      <section className="wb-doc-section">
        <div className="flex items-center gap-2">
          <Database className="h-3.5 w-3.5 text-brand-500" />
          <h3 className="flex-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("docs.section.modelBinding")}</h3>
        </div>
        {models.length === 0 ? (
          <p className="px-1 py-2 text-2xs leading-relaxed text-ink-faint">
            {t("docs.models.empty")}
          </p>
        ) : (
          <div className="space-y-2 px-1 py-1">
            <div className="flex flex-wrap items-center gap-2 text-2xs text-ink-soft">
              <label className="flex items-center gap-1.5">
                {t("docs.requestModel")}
                <Select
                  className="!h-6 !w-40 !py-0 !text-[11px]"
                  value={doc.requestModelId ?? ""}
                  aria-label={t("docs.aria.requestModel")}
                  onChange={(event) => updateDoc({ requestModelId: event.target.value || undefined })}
                >
                  <option value="">{t("docs.noBinding")}</option>
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>{model.name}</option>
                  ))}
                </Select>
              </label>
              {modelBadge(doc.requestModelId) ?? (
                <span className="text-ink-faint">{t("docs.unbound")}</span>
              )}
            </div>

            {boundModel && boundRows.length > 0 && (
              <div className="overflow-hidden rounded-md border border-surface-border">
                <div className="border-b border-surface-border bg-surface-muted px-2 py-1 text-2xs font-medium text-ink-soft">
                  {t("docs.modelFields", { name: boundModel.name, count: boundRows.length })}
                </div>
                <table className="wb-doc-table">
                  <thead>
                    <tr>
                      <th>{t("docs.col.field")}</th>
                      <th className="!w-24">{t("docs.col.type")}</th>
                      <th className="!w-14">{t("docs.col.required")}</th>
                      <th>{t("docs.col.description")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {boundRows.map((row) => (
                      <tr key={row.name}>
                        <td><code className="font-mono text-[11.5px] text-ink">{row.name}</code></td>
                        <td className="text-ink-soft">{row.type}</td>
                        <td className="text-ink-soft">{row.required ? t("docs.yes") : t("docs.no")}</td>
                        <td className="text-ink-soft">{row.description || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="text-2xs leading-relaxed text-ink-faint">
              {t("docs.models.note")}
            </p>
          </div>
        )}
      </section>

      <section className="wb-doc-section">
        <div className="flex items-center gap-2">
          <Braces className="h-3.5 w-3.5 text-brand-500" />
          <h3 className="flex-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            {t("docs.section.responses", { count: doc.responses.length })}
          </h3>
          <Button
            size="sm"
            variant="ghost"
            disabled={!response}
            title={response ? t("docs.saveResponse.title") : t("docs.saveResponse.titleDisabled")}
            onClick={() => {
              const result = saveResponseExample();
              showHint(responseExampleHint(result, "doc"));
            }}
          >
            <Save className="h-3.5 w-3.5" />
            {t("docs.saveResponse")}
          </Button>
        </div>
        {doc.responses.length === 0 ? (
          <p className="px-1 py-2 text-2xs text-ink-faint">
            {t("docs.responses.empty")}
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {doc.responses.map((example) => (
              <div key={example.id} className="wb-doc-example">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => setOpenExample(openExample === example.id ? null : example.id)}
                >
                  {openExample === example.id ? (
                    <ChevronDown className="h-3.5 w-3.5 text-ink-faint" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-ink-faint" />
                  )}
                  <span className={`font-mono text-[11px] font-bold ${example.status < 400 ? "text-emerald-600" : "text-red-500"}`}>
                    {example.status}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink">{example.name}</span>
                  <span className="text-2xs text-ink-faint">{example.contentType}</span>
                </button>
                <button
                  type="button"
                  className="wb-icon-btn !h-5 !w-5"
                  title={t("docs.copyExample")}
                  aria-label={t("docs.copyExample")}
                  onClick={async () => {
                    try {
                      if (!navigator.clipboard) throw new Error("clipboard unavailable");
                      await navigator.clipboard.writeText(formatResponseExampleBody(example.body));
                      showHint(t("docs.copied"));
                    } catch {
                      showHint(t("docs.copyFailed"));
                    }
                  }}
                >
                  <Copy className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  className="wb-icon-btn !h-5 !w-5"
                  title={t("docs.deleteExample")}
                  aria-label={t("docs.deleteExample")}
                  onClick={() => deleteResponseExample(example.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
                {openExample === example.id && (
                  <div className="w-full space-y-2">
                    <div className="flex flex-wrap items-center gap-2 text-2xs text-ink-soft">
                      <label className="flex items-center gap-1.5">
                        {t("docs.name")}
                        <input
                          className={`${inputClass} !h-6 !w-40 !py-0 !text-[11px]`}
                          value={example.name}
                          aria-label={t("docs.aria.exampleName")}
                          onChange={(event) =>
                            updateResponseExample(example.id, { name: event.target.value })
                          }
                        />
                      </label>
                      <label className="flex min-w-[180px] flex-1 items-center gap-1.5">
                        {t("docs.col.description")}
                        <input
                          className={`${inputClass} !h-6 !min-w-0 !flex-1 !py-0 !text-[11px]`}
                          value={example.description}
                          placeholder={t("docs.placeholder.exampleDesc")}
                          aria-label={t("docs.aria.exampleDesc")}
                          onChange={(event) =>
                            updateResponseExample(example.id, { description: event.target.value })
                          }
                        />
                      </label>
                    </div>

                    {models.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 text-2xs text-ink-soft">
                      <label className="flex items-center gap-1.5">
                        {t("docs.bindModel")}
                        <Select
                          className="!h-6 !w-36 !py-0 !text-[11px]"
                          value={example.modelId ?? ""}
                          aria-label={t("docs.aria.bindModel", { name: example.name })}
                          onChange={(event) =>
                            updateResponseExample(example.id, { modelId: event.target.value || undefined })
                          }
                        >
                          <option value="">{t("docs.noBinding")}</option>
                          {models.map((model) => (
                            <option key={model.id} value={model.id}>{model.name}</option>
                          ))}
                        </Select>
                      </label>
                      {modelBadge(example.modelId)}
                      <span className="text-ink-faint">
                        {t("docs.bindModel.note")}
                      </span>
                      </div>
                    )}

                    {renderResponseParams(example)}

                    <div className="flex items-center gap-2">
                      <h4 className="flex-1 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
                        {t("docs.responseBody")}
                      </h4>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (editingBody === example.id) {
                            updateResponseExample(example.id, { body: bodyDraft });
                            setEditingBody(null);
                          } else {
                            setBodyDraft(formatResponseExampleBody(example.body));
                            setEditingBody(example.id);
                          }
                        }}
                      >
                        <Pencil className="h-3 w-3" />
                        {editingBody === example.id ? t("docs.doneEdit") : t("docs.editBody")}
                      </Button>
                    </div>
                    {editingBody === example.id ? (
                      <textarea
                        className={`${inputClass} min-h-[120px] font-mono text-[11.5px] leading-relaxed`}
                        value={bodyDraft}
                        aria-label={t("docs.aria.exampleBody")}
                        placeholder={t("docs.placeholder.exampleBody")}
                        onChange={(event) => setBodyDraft(event.target.value)}
                      />
                    ) : (
                      <pre className="wb-doc-example-body scrollbar-thin">{formatResponseExampleBody(example.body)}</pre>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="wb-doc-foot">
        <Button size="sm" variant="ghost" onClick={() => setDetailTab("debug")}>
          <Play className="h-3.5 w-3.5" />
          {t("docs.goDebug")}
        </Button>
        <span className="text-2xs text-ink-faint">
          {t("docs.foot.note")}
        </span>
      </div>
    </div>
  );
}
