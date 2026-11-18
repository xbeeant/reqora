import { Fragment, useMemo, useState } from "react";
import { Check, ChevronRight, Copy, Folder, Layers, Search } from "lucide-react";
import type {
  DocSiteChapter,
  DocSiteParamRow,
  DocSitePayload,
  DocSiteRequest,
} from "../lib/docSitePayload.ts";
import {
  folderGroups,
  folderHiddenByAncestor,
  folderOutline,
} from "../lib/docSitePayload.ts";
import { requestBodyFieldTreeRows, responseParamTreeRows, TREE_INDENT } from "../lib/responseParamTree.ts";
import { MarkdownView } from "./MarkdownView";
import { inputClass } from "./ui";
import { useT } from "../i18n";

/**
 * 响应字段表按对象层级展开：`data.orders[0].total` 不再平铺，
 * 而是 `data` → `orders` → `total` 逐级缩进，父级只读显示 object / array<object>。
 * 行结构直接复用 DocSiteParamRow（含 location），Header 行因此走平铺分支、
 * 不会被误当 body 字段树；父级判定 / 缩进 / 显示名统一取树行契约字段。
 */
function ResponseParamTable({ rows }: { rows: DocSiteParamRow[] }) {
  const t = useT();
  return (
    <table className="wb-doc-table wb-doc-tree-table">
      <thead>
        <tr>
          <th>{t("docs.col.param")}</th>
          <th>{t("docs.col.type")}</th>
          <th>{t("docs.col.required")}</th>
          <th>{t("docs.col.example")}</th>
          <th>{t("docs.col.description")}</th>
        </tr>
      </thead>
      <tbody>
        {responseParamTreeRows(rows).map((node) => {
          const item = node.item;
          return (
            <tr key={node.key} className={node.isGroup ? "wb-doc-tree-group" : ""}>
              <td className="wb-docsite-mono">
                <div className="wb-doc-tree-name" style={{ paddingLeft: `${node.indent}px` }}>
                  {!node.isGroup && node.indent > 0 ? (
                    <span className="wb-doc-tree-leaf" aria-hidden="true" />
                  ) : null}
                  <span className={node.isGroup ? "font-medium" : ""}>{node.leafName}</span>
                </div>
              </td>
              <td>{node.isGroup ? node.containerType : item?.type || "string"}</td>
              <td>{node.isGroup ? "—" : item?.required ? t("docs.yes") : t("docs.no")}</td>
              <td className="wb-docsite-mono">{node.isGroup ? "" : item?.example ?? ""}</td>
              <td>{node.isGroup ? "" : item?.description ?? ""}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * 请求参数表：Body 字段（如 specValueList[0].bid）按对象层级展开，
 * Query / Header 保持平铺。与响应字段表、桌面端文档标签共用树行契约。
 */
function RequestParamTable({ rows }: { rows: DocSiteParamRow[] }) {
  const t = useT();
  return (
    <table className="wb-doc-table wb-doc-tree-table">
      <thead>
        <tr>
          <th>{t("docs.col.param")}</th>
          <th>{t("docs.col.type")}</th>
          <th>{t("docs.col.required")}</th>
          <th>{t("docs.col.example")}</th>
          <th>{t("docs.col.description")}</th>
        </tr>
      </thead>
      <tbody>
        {requestBodyFieldTreeRows(rows).map((node) => {
          const item = node.item;
          return (
            <tr key={node.key} className={node.isGroup ? "wb-doc-tree-group" : ""}>
              <td className="wb-docsite-mono">
                <div className="wb-doc-tree-name" style={{ paddingLeft: `${node.indent}px` }}>
                  {!node.isGroup && node.indent > 0 ? (
                    <span className="wb-doc-tree-leaf" aria-hidden="true" />
                  ) : null}
                  <span className={node.isGroup ? "font-medium" : ""}>{node.leafName}</span>
                </div>
              </td>
              <td>{node.isGroup ? node.containerType : item?.type || "string"}</td>
              <td>{item?.required ? t("docs.yes") : t("docs.no")}</td>
              <td className="wb-docsite-mono">{item?.example ?? ""}</td>
              <td>{item?.description ?? ""}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * 纯 props 驱动的文档站视图 —— 不读 useWorkspace、不碰 Tauri。
 * 桌面端「文档站预览」与网页版 `?doc=<token>` 渲染的是同一个组件：
 * 前者传 buildDocSitePayload(snapshot)，后者传服务端返回的 JSON 经
 * normalizeDocSitePayload 归一化后的结果。
 *
 * Markdown、表格、代码片段、徽标样式全部复用桌面端既有模块/类名，
 * 因此网页版与客户端不会出现两套渲染逻辑漂移。
 */
export interface DocSiteViewerProps {
  payload: DocSitePayload;
  mode?: "preview" | "public";
  onClose?: () => void;
}

function methodClass(method: string): string {
  const key = method.toLowerCase();
  return ["get", "post", "put", "patch", "delete", "head", "options"].includes(key)
    ? `wb-method wb-method-${key}`
    : "wb-method";
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button
      type="button"
      className="wb-chip !h-7 shrink-0 !px-2.5 !text-[10px]"
      onClick={() => void copy()}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? t("docs.copiedShort") : label ?? t("docs.copy")}
    </button>
  );
}

function ChapterCard({ chapter }: { chapter: DocSiteChapter }) {
  const t = useT();
  const rows = chapter.errorCodes?.rows ?? [];
  const columns = chapter.errorCodes?.columns ?? [];
  return (
    <section className="wb-docsite-card" id={`page-${chapter.slug}`}>
      <div className="wb-docsite-card-head">
        <span className="wb-mini-badge">{chapter.groupLabel}</span>
        <h2>{chapter.title}</h2>
      </div>
      {chapter.body.trim() ? <MarkdownView text={chapter.body} /> : null}
      {rows.length > 0 ? (
        <>
          <h4 className="wb-docsite-subhead">{t("docs.errorCodes")}</h4>
          <table className="wb-doc-table">
            <thead>
              <tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className={cellIndex === 0 ? "wb-docsite-mono" : ""}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}

function RequestCard({ request }: { request: DocSiteRequest }) {
  const t = useT();
  const [snippetId, setSnippetId] = useState(request.snippets[0]?.id ?? "");
  const snippet = request.snippets.find((item) => item.id === snippetId) ?? request.snippets[0];

  return (
    <section className="wb-docsite-card" id={`api-${request.id}`}>
      <div className="wb-docsite-card-head">
        <span className={methodClass(request.method)}>{request.method}</span>
        <h2>{request.name}</h2>
      </div>
      {request.summary ? <p className="wb-docsite-summary">{request.summary}</p> : null}
      <div className="wb-docsite-url">
        <CopyButton text={request.url} label={t("docs.copyUrl")} />
        <code>{request.url || t("docs.noUrl")}</code>
      </div>
      {request.description ? <MarkdownView text={request.description} /> : null}

      {request.tables.map((table) => (
        <div key={table.label}>
          <h4 className="wb-docsite-subhead">{table.label}</h4>
          <RequestParamTable rows={table.rows} />
        </div>
      ))}

      {request.body ? (
        <>
          <h4 className="wb-docsite-subhead">{request.body.label}</h4>
          <pre className="wb-code-block">{request.body.text}</pre>
        </>
      ) : null}

      {request.responses.length > 0 ? (
        <>
          <h4 className="wb-docsite-subhead">{t("docs.responseExamples")}</h4>
          {request.responses.map((response) => (
            <div key={response.id} className="wb-docsite-response">
              <div className="wb-docsite-response-head">
                <span className="wb-mini-badge">{response.status || "—"}</span>
                <strong>{response.name}</strong>
                {response.description ? <span>{response.description}</span> : null}
              </div>
              {(response.tables ?? []).map((table) => (
                <div key={table.label} className="wb-docsite-response-params">
                  <div className="wb-docsite-response-params-label">
                    {table.label} · {table.rows.length}
                  </div>
                  <ResponseParamTable rows={table.rows} />
                </div>
              ))}
              {response.text ? <pre className="wb-code-block">{response.text}</pre> : null}
            </div>
          ))}
        </>
      ) : null}

      {request.snippets.length > 0 ? (
        <>
          <h4 className="wb-docsite-subhead">{t("docs.codeExamples")}</h4>
          <div className="wb-cfg-tabs wb-docsite-snippet-tabs">
            {request.snippets.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`wb-cfg-tab ${item.id === snippet?.id ? "active" : ""}`}
                onClick={() => setSnippetId(item.id)}
              >
                {item.label}
              </button>
            ))}
            {snippet ? <CopyButton text={snippet.code} /> : null}
          </div>
          {snippet ? <pre className="wb-code-block">{snippet.code}</pre> : null}
        </>
      ) : null}
    </section>
  );
}

export function DocSiteViewer({ payload, mode = "preview", onClose }: DocSiteViewerProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  // 目录里可折叠的文件夹（按完整路径，默认全部展开）。
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const toggleFolderCollapse = (path: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const chapters = useMemo(
    () =>
      needle
        ? payload.chapters.filter((chapter) =>
            `${chapter.title} ${chapter.body}`.toLowerCase().includes(needle),
          )
        : payload.chapters,
    [payload.chapters, needle],
  );

  const collections = useMemo(
    () =>
      needle
        ? payload.collections
            .map((collection) => ({
              ...collection,
              requests: collection.requests.filter((request) =>
                `${request.name} ${request.method} ${request.url} ${request.summary}`
                  .toLowerCase()
                  .includes(needle),
              ),
            }))
            .filter((collection) => collection.requests.length > 0)
        : payload.collections,
    [payload.collections, needle],
  );

  const chapterGroups = useMemo(() => {
    const grouped = new Map<string, DocSiteChapter[]>();
    for (const chapter of chapters) {
      const label = chapter.groupLabel || t("docs.guide");
      grouped.set(label, [...(grouped.get(label) ?? []), chapter]);
    }
    return [...grouped.entries()];
  }, [chapters]);

  const generated = useMemo(() => {
    if (!payload.generatedAt) return "";
    const date = new Date(payload.generatedAt);
    return Number.isNaN(date.getTime()) ? payload.generatedAt : date.toLocaleString();
  }, [payload.generatedAt]);

  const requests = collections.flatMap((collection) => collection.requests);
  const empty = chapterGroups.length === 0 && requests.length === 0;

  return (
    <div className="wb-docsite">
      <aside className="wb-docsite-nav">
        <div className="wb-docsite-brand">
          <strong>{payload.title}</strong>
          <small>{mode === "public" ? t("docs.onlineDoc") : t("docs.previewBadge")}</small>
        </div>
        <div className="wb-docsite-search">
          <Search className="h-3.5 w-3.5 shrink-0" />
          <input
            className={inputClass}
            placeholder={t("docs.search.placeholder")}
            aria-label={t("docs.search.aria")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <nav className="scrollbar-thin">
          {chapterGroups.map(([label, items]) => (
            <div className="wb-docsite-toc-group" key={label}>
              <div className="wb-docsite-toc-name">{label}</div>
              <ul>
                {items.map((chapter) => (
                  <li key={chapter.id}>
                    <a href={`#page-${chapter.slug}`}>{chapter.title}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {collections.map((collection) => (
            <div className="wb-docsite-toc-group" key={collection.id}>
              <div className="wb-docsite-toc-name">{collection.name}</div>
              {folderOutline(folderGroups(collection.requests)).map((node) => {
                // 纯文件夹标题节点：可点击折叠。
                if (node.path !== "" && node.requests.length === 0) {
                  if (folderHiddenByAncestor(node.path, collapsedFolders)) return null;
                  const collapsed = collapsedFolders.has(node.path);
                  return (
                    <li
                      key={`${collection.id}-folder-${node.path}`}
                      className="wb-docsite-toc-folder"
                      style={{ paddingLeft: `${(node.depth - 1) * TREE_INDENT}px` }}
                    >
                      <button
                        type="button"
                        className="flex w-full items-center gap-1 py-0.5 text-left"
                        title={collapsed ? t("docs.folder.expand", { path: node.path }) : t("docs.folder.collapse", { path: node.path })}
                        aria-expanded={!collapsed}
                        onClick={() => toggleFolderCollapse(node.path)}
                      >
                        <ChevronRight
                          className={`h-3 w-3 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
                        />
                        <Folder className="mr-1 inline h-3 w-3 align-[-1px]" />
                        <span className="truncate">{node.name}</span>
                      </button>
                    </li>
                  );
                }
                // 接口列表：自身或任一祖先被折叠时隐藏。
                if (
                  collapsedFolders.has(node.path) ||
                  folderHiddenByAncestor(node.path, collapsedFolders)
                ) {
                  return null;
                }
                return (
                  <ul key={`${collection.id}-reqs-${node.path || "root"}`}>
                    {node.requests.map((request) => (
                      <li key={request.id}>
                        <a href={`#api-${request.id}`}>
                          <span className={methodClass(request.method)}>{request.method}</span>
                          {request.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                );
              })}
            </div>
          ))}
          {needle && empty ? <p className="wb-hint !m-2">{t("docs.noMatch")}</p> : null}
        </nav>
        <div className="wb-docsite-foot">
          {t("docs.requestCount", { count: payload.totalRequests })}
          {generated ? ` · ${generated}` : ""}
        </div>
      </aside>

      <main className="wb-docsite-main scrollbar-thin">
        <header className="wb-docsite-header">
          <div>
            <h1>{payload.title}</h1>
            <p>
              {t("docs.stats", { collections: payload.collections.length, requests: payload.totalRequests })}
              {payload.chapters.length > 0 ? ` · ${t("docs.chaptersCount", { count: payload.chapters.length })}` : ""}
              {generated ? ` · ${t("docs.updatedAt", { time: generated })}` : ""}
            </p>
          </div>
          {onClose ? (
            <button type="button" className="wb-chip" onClick={onClose}>
              {t("docs.closePreview")}
            </button>
          ) : null}
        </header>

        {chapters.map((chapter) => <ChapterCard key={chapter.id} chapter={chapter} />)}
        {collections.map((collection) => (
          <Fragment key={collection.id}>
            {/* 正文按「集合 → 文件夹(可嵌套) → 接口」呈现：集合是文件夹与接口卡片的顶层分组。 */}
            {collection.requests.length > 0 && (
              <div className="wb-docsite-collection">
                <Layers className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{collection.name}</span>
                <span className="wb-docsite-collection-count">
                  {t("docs.requestCount", { count: collection.requests.length })}
                </span>
              </div>
            )}
            {folderOutline(folderGroups(collection.requests)).map((node) => {
              // 层级文件夹标题：多级路径逐级缩进展示（正文是线性文档，不折叠）。
              // 子树接口数由 folderOutline 下沉到 node.count，渲染层不再重算。
              if (node.path !== "" && node.requests.length === 0) {
                return (
                  <div
                    key={`${collection.id}-head-${node.path}`}
                    className="mb-1 mt-5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint"
                    style={{ marginLeft: `${(node.depth - 1) * TREE_INDENT}px` }}
                    title={node.path}
                  >
                    <Folder className="h-3.5 w-3.5" />
                    <span>{node.name}</span>
                    <span className="font-normal normal-case">· {t("docs.requestCount", { count: node.count })}</span>
                  </div>
                );
              }
              return (
                <Fragment key={`${collection.id}-body-${node.path || "root"}`}>
                  {node.requests.map((request) => (
                    <RequestCard key={request.id} request={request} />
                  ))}
                </Fragment>
              );
            })}
          </Fragment>
        ))}

        {empty && !needle ? (
          <div className="wb-empty">
            <div className="wb-empty-title">{t("docs.site.empty.title")}</div>
            <p>{t("docs.site.empty.desc")}</p>
          </div>
        ) : null}
      </main>
    </div>
  );
}
