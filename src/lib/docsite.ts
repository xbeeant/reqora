import type { WorkspaceSnapshot } from "../types";
import { requestBodyFieldTreeRows, responseParamTreeRows, TREE_INDENT } from "./responseParamTree.ts";
import { substitute } from "./template.ts";
import {
  buildDocSitePayload,
  folderGroups,
  folderOutline,
  type DocSiteBody,
  type DocSiteChapter,
  type DocSitePayload,
  type DocSiteRequest,
  type DocSiteResponse,
  type DocSiteTable,
  type FolderOutlineNode,
} from "./docSitePayload.ts";
import { DOC_SITE_ERROR_CODE_COLUMNS, docPageGroupLabel } from "./docPages.ts";

/**
 * 文档站导出：把整个工作区渲染成**单文件**静态 HTML（零依赖、无外部资源，
 * 浏览器直接打开即可阅读）。左侧目录 + 右侧内容，参数表 / 请求体 / URL /
 * 响应示例都取自 buildDocSitePayload(snapshot) 这一份投影（与桌面端预览、
 * Markdown 导出、网页版共用），这里只负责 HTML 格式化；描述走内置的迷你
 * Markdown 渲染器（全部先转义再渲染，杜绝注入）。
 *
 * P1-6 增强：
 * - 页内在线调试：导出时可选开启，每个接口带「调试」按钮（浏览器 fetch，
 *   受 CORS 限制，页面有明确提示）；URL / 请求体按活动环境做 {{变量}} 替换。
 * - 加密分享：exportEncryptedDocSiteHtml 用 AES-GCM（PBKDF2-SHA256 派生密钥）
 *   加密整份文档，单文件 HTML 内嵌解密器，凭密码查看。
 */

/** 文档站导出选项。 */
export interface DocSiteOptions {
  /** 页内在线调试（浏览器 fetch，CORS 需目标服务允许）。 */
  debug?: boolean;
  /** 导出前对 URL / 请求体做 {{变量}} 替换（通常传活动环境变量）。 */
  variables?: Record<string, string>;
}

const METHOD_COLORS: Record<string, string> = {
  GET: "#2ea44f",
  POST: "#c76e12",
  PUT: "#0969da",
  DELETE: "#cf222e",
  PATCH: "#8250df",
  HEAD: "#57606a",
  OPTIONS: "#57606a",
};

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 行内 Markdown：先转义，再处理 `code` 与 **bold**。 */
function mdInline(text: string): string {
  let out = esc(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return out;
}

/** 块级 Markdown 子集：标题 / 列表 / 代码块 / 段落。 */
function mdBlocks(markdown: string): string {
  if (markdown.trim() === "") return "";
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inCode = false;
  let code: string[] = [];
  let list: string[] | null = null;

  const flushList = () => {
    if (list && list.length > 0) {
      out.push(`<ul>${list.map((item) => `<li>${mdInline(item)}</li>`).join("")}</ul>`);
    }
    list = null;
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      const level = heading[1].length + 1;
      out.push(`<h${level}>${mdInline(heading[2])}</h${level}>`);
      continue;
    }
    const listItem = /^\s*[-*]\s+(.*)$/.exec(line);
    if (listItem) {
      list = list ?? [];
      list.push(listItem[1]);
      continue;
    }
    flushList();
    if (line.trim() === "") continue;
    out.push(`<p>${mdInline(line)}</p>`);
  }
  flushList();
  if (inCode && code.length > 0) out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
  return out.join("\n");
}

function methodBadge(method: string): string {
  const color = METHOD_COLORS[method.toUpperCase()] ?? "#57606a";
  return `<span class="method" style="background:${color}">${esc(method.toUpperCase())}</span>`;
}

const FOLDER_ICON_SVG =
  '<svg class="folder-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';

const COLLECTION_ICON_SVG =
  '<svg class="collection-ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 12.5-9.17 4.16a2 2 0 0 1-1.66 0L2 12.5"/><path d="m22 17.5-9.17 4.16a2 2 0 0 1-1.66 0L2 17.5"/></svg>';

interface FolderTreeNode {
  name: string;
  children: Map<string, FolderTreeNode>;
  requests: DocSiteRequest[];
}

/** 把 folderOutline 的平铺层级大纲收拢成一棵文件夹树（根节点挂集合根级接口）。 */
function buildFolderTree(outline: FolderOutlineNode<DocSiteRequest>[]): FolderTreeNode {
  const root: FolderTreeNode = { name: "", children: new Map(), requests: [] };
  for (const node of outline) {
    if (node.path === "") {
      root.requests.push(...node.requests);
      continue;
    }
    let cursor = root;
    for (const segment of node.path.split("/")) {
      let child = cursor.children.get(segment);
      if (!child) {
        child = { name: segment, children: new Map(), requests: [] };
        cursor.children.set(segment, child);
      }
      cursor = child;
    }
    cursor.requests.push(...node.requests);
  }
  return root;
}

/** 递归渲染目录树：文件夹用 <details open> 原生折叠，depth 0（根）不加外壳。 */
function renderTocTree(
  node: FolderTreeNode,
  depth: number,
  requestIndex: Map<DocSiteRequest, number>,
): string {
  const links = node.requests
    .map(
      (item) =>
        `<li><a href="#api-${requestIndex.get(item)}">${methodBadge(item.method)} ${esc(item.name)}</a></li>`,
    )
    .join("");
  const children = [...node.children.values()]
    .map((child) => renderTocTree(child, depth + 1, requestIndex))
    .join("");
  const inner = `<ul>${links}</ul>${children}`;
  if (depth === 0) return inner;
  return `<details open class="toc-folder"><summary class="toc-folder-name">${FOLDER_ICON_SVG}${esc(node.name)}</summary>${inner}</details>`;
}

/** 参数表格式化器：直接消费 DocSitePayload 投影好的 request.tables。 */
function paramTable(request: DocSiteRequest): string {
  const parts: string[] = [];
  for (const table of request.tables) {
    if (table.rows.length === 0) continue;
    parts.push(`<h4>${esc(table.label)}</h4>`);
    parts.push(
      '<table><thead><tr><th>参数</th><th>类型</th><th>必填</th><th>示例值</th><th>说明</th></tr></thead><tbody>',
    );
    // 请求参数表：Body 字段按对象层级展开（productBidList → array），
    // Query / Header 仍逐行平铺；与桌面端文档标签、响应字段表同一套树行契约。
    for (const node of requestBodyFieldTreeRows(table.rows)) {
      const indent = node.indent > 0 ? ` style="padding-left:${node.indent}px"` : "";
      if (node.isGroup) {
        const item = node.item;
        parts.push(
          "<tr class=\"tree-group\">",
          `<td class="mono"><span class="tree-name"${indent}>${esc(node.leafName)}</span></td>`,
          `<td>${esc(node.containerType)}</td>`,
          `<td>${item && item.required ? "是" : "否"}</td>`,
          `<td class="mono">${esc(item ? item.example : "")}</td>`,
          `<td>${mdInline(item ? item.description : "")}</td>`,
          "</tr>",
        );
        continue;
      }
      const item = node.item;
      parts.push(
        "<tr>",
        `<td class="mono"><span class="tree-name"${indent}>${esc(node.leafName)}</span></td>`,
        `<td>${esc(item ? item.type || "string" : "string")}</td>`,
        `<td>${item && item.required ? "是" : "否"}</td>`,
        `<td class="mono">${esc(item ? item.example : "")}</td>`,
        `<td>${mdInline(item ? item.description : "")}</td>`,
        "</tr>",
      );
    }
    parts.push("</tbody></table>");
  }
  return parts.join("\n");
}

/** 请求体格式化器：直接消费 DocSitePayload 投影好的 request.body。 */
function bodySection(body: DocSiteBody | null): string {
  if (!body || body.text.trim() === "") return "";
  return `<h4>${esc(body.label)}</h4><pre><code class="${esc(body.lang)}">${esc(body.text)}</code></pre>`;
}

/** 每个响应示例自己的 Body / Header 字段表。全部先转义，描述走内联 Markdown。 */
function responseParamHtml(tables: DocSiteTable[]): string[] {
  const parts: string[] = [];
  for (const table of tables) {
    parts.push(`<h4>${esc(table.label)}</h4>`);
    parts.push(
      '<table><thead><tr><th>参数</th><th>类型</th><th>必填</th><th>示例值</th><th>说明</th></tr></thead><tbody>',
    );
    // 响应字段按对象层级缩进展示（data → orders → total），与桌面端文档标签一致。
    // 父级判定 / 缩进 / 显示名统一取 ResponseParamTreeRow 契约字段。
    for (const node of responseParamTreeRows(table.rows)) {
      const indent = node.indent > 0 ? ` style="padding-left:${node.indent}px"` : "";
      if (node.isGroup) {
        parts.push(
          "<tr class=\"tree-group\">",
          `<td class="mono"><span class="tree-name"${indent}>${esc(node.leafName)}</span></td>`,
          `<td>${esc(node.containerType)}</td>`,
          "<td>—</td>",
          "<td></td>",
          "<td></td>",
          "</tr>",
        );
        continue;
      }
      const item = node.item;
      parts.push(
        "<tr>",
        `<td class="mono"><span class="tree-name"${indent}>${esc(node.leafName)}</span></td>`,
        `<td>${esc(item ? item.type || "string" : "string")}</td>`,
        `<td>${item && item.required ? "是" : "否"}</td>`,
        `<td class="mono">${esc(item ? item.example : "")}</td>`,
        `<td>${mdInline(item ? item.description : "")}</td>`,
        "</tr>",
      );
    }
    parts.push("</tbody></table>");
  }
  return parts;
}

function responseSection(responses: DocSiteResponse[]): string {
  if (responses.length === 0) return "";
  const parts: string[] = ["<h4>响应示例</h4>"];
  for (const response of responses) {
    parts.push(
      `<p class="resp-line">${methodBadge(String(response.status))} <strong>${esc(response.name)}</strong>${response.description ? ` — ${mdInline(response.description)}` : ""}</p>`,
    );
    parts.push(...responseParamHtml(response.tables));
    if (response.text.trim() !== "") {
      parts.push(`<pre><code class="${esc(response.lang)}">${esc(response.text)}</code></pre>`);
    }
  }
  return parts.join("\n");
}

/** 页内调试按钮：URL / JSON 体都取已归一化的 payload 字段。 */
function debugButton(request: DocSiteRequest): string {
  const jsonBody = request.body && request.body.lang === "json" ? request.body.text : "";
  return `<div class="debug-row"><button type="button" class="debug-btn" data-method="${esc(request.method.toUpperCase())}" data-url="${esc(request.url)}"${jsonBody.trim() ? ` data-body="${esc(jsonBody)}"` : ""}>调试</button><span class="debug-hint">浏览器 fetch 发送，目标服务需允许跨域（CORS）</span></div><pre class="debug-out" hidden></pre>`;
}

/** 接口卡片格式化器：输入是 DocSitePayload 里的 DocSiteRequest，不再从 snapshot 重投影。 */
function requestSection(request: DocSiteRequest, index: number, options: DocSiteOptions = {}): string {
  return [
    `<section class="api" id="api-${index}">`,
    `<h2>${methodBadge(request.method)} ${esc(request.name)}</h2>`,
    request.summary ? `<p class="summary">${mdInline(request.summary)}</p>` : "",
    `<p class="url mono">${esc(request.method.toUpperCase())} ${esc(request.url)}</p>`,
    request.description.trim() !== "" ? `<div class="desc">${mdBlocks(request.description)}</div>` : "",
    paramTable(request),
    bodySection(request.body),
    responseSection(request.responses),
    options.debug ? debugButton(request) : "",
    "</section>",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

/** 结构化错误码表；rows / columns 直接取 payload 章节，没有有效行时整个表格省略。 */
function errorCodeTableHtml(chapter: DocSiteChapter): string {
  const rows = chapter.errorCodes?.rows ?? [];
  if (rows.length === 0) return "";
  const columns = chapter.errorCodes?.columns ?? DOC_SITE_ERROR_CODE_COLUMNS;
  const head = columns.map((column) => `<th>${esc(column)}</th>`).join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell, index) => `<td${index === 0 ? ' class="mono"' : ""}>${mdInline(cell)}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<h4>错误码对照表</h4><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** 公共章节与接口卡片共用同一套 .api 样式，目录锚点形如 #page-auth。 */
function chapterSection(chapter: DocSiteChapter): string {
  return [
    `<section class="api chapter" id="page-${esc(chapter.slug)}">`,
    `<h2>${esc(chapter.title)}</h2>`,
    chapter.body.trim() !== "" ? `<div class="desc">${mdBlocks(chapter.body)}</div>` : "",
    errorCodeTableHtml(chapter),
    "</section>",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function chaptersToc(chapters: DocSiteChapter[]): string {
  if (chapters.length === 0) return "";
  return (["guide", "reference", "changelog"] as const)
    .map((group) => {
      const items = chapters.filter((chapter) => chapter.group === group);
      if (items.length === 0) return "";
      const links = items
        .map(
          (chapter) =>
            `<li><a href="#page-${esc(chapter.slug)}">${esc(chapter.title)}</a></li>`,
        )
        .join("");
      return `<li class="toc-collection"><div class="toc-name">${esc(docPageGroupLabel(group))}</div><ul>${links}</ul></li>`;
    })
    .join("");
}

/**
 * 本地单文件 HTML 是调试产物：调用方可能显式传入完整活动环境变量，期望把
 * URL / 请求体里残留的 {{模板}} 也补全（含凭据类变量）。buildDocSitePayload
 * 出于公开文档安全只替换非敏感变量，所以这里在**数据层、转义之前**再用调用方
 * 的原始变量表补一次。它只作用于本次导出的 payload 副本，不改动 docSitePayload
 * 的脱敏收口，也不影响网页版 / 桌面端预览。
 */
function resolveVariables(value: unknown, variables: Record<string, string>): unknown {
  if (typeof value === "string") return substitute(value, variables);
  if (Array.isArray(value)) return value.map((item) => resolveVariables(item, variables));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = resolveVariables(child, variables);
    return out;
  }
  return value;
}

/** 生成整个文档站 HTML（含样式与目录，单文件可直接打开）。 */
export function exportDocSiteHtml(
  snapshot: WorkspaceSnapshot,
  title = "API 文档",
  options: DocSiteOptions = {},
): string {
  // 唯一数据来源：桌面端预览、单文件 HTML、Markdown、网页版共用这份投影，
  // 导出器这里只保留 HTML 格式化，不再从 snapshot 重投影参数表 / 请求体 / URL。
  const variables = options.variables ?? {};
  let payload: DocSitePayload = buildDocSitePayload(snapshot, { title, variables });
  // 显式传入变量时（本地调试导出），把 publicVariables 过滤掉的敏感 {{模板}}
  // 也用原始变量表补齐；无变量时保持零开销、输出与之前完全一致。
  if (Object.keys(variables).length > 0) {
    payload = resolveVariables(payload, variables) as DocSitePayload;
  }
  const requestIndex = new Map<DocSiteRequest, number>();
  let index = 0;
  for (const collection of payload.collections) {
    for (const request of collection.requests) {
      requestIndex.set(request, index);
      index += 1;
    }
  }
  const total = payload.totalRequests;

  const chapterToc = chaptersToc(payload.chapters);
  const chapterContent = payload.chapters.map(chapterSection).join("\n");

  // 目录与正文都按文件夹层级分组：顺序与侧边栏一致（根级接口在前，
  // 文件夹按路径字母序），多级路径逐级嵌套，目录用 <details> 原生折叠。
  const apiToc = payload.collections
    .map((collection) => {
      if (collection.requests.length === 0) return "";
      return `<li class="toc-collection"><div class="toc-name">${esc(collection.name)}</div>${renderTocTree(
        buildFolderTree(folderOutline(folderGroups(collection.requests))),
        0,
        requestIndex,
      )}</li>`;
    })
    .join("");
  const toc = chapterToc + apiToc;

  const content = payload.collections
    .map((collection) => {
      if (collection.requests.length === 0) return "";
      const outline = folderOutline(folderGroups(collection.requests));
      return [
        `<h2 class="collection-title">${COLLECTION_ICON_SVG}${esc(collection.name)}<small>${collection.requests.length} 个接口</small></h2>`,
        ...outline
          .map((node) => {
            // 层级文件夹标题：多级路径逐级缩进（正文是线性文档，不折叠）。
            // 子树接口数由 folderOutline 下沉到 node.count，渲染层不再重算。
            const head =
              node.path === "" || node.requests.length > 0
                ? ""
                : `<h2 class="folder-title" style="padding-left:${(node.depth - 1) * TREE_INDENT}px" title="${esc(node.path)}">${FOLDER_ICON_SVG}${esc(node.name)}<small>${node.count} 个接口</small></h2>`;
            const sections = node.requests
              .map((item) => requestSection(item, requestIndex.get(item) ?? 0, options))
              .join("\n");
            return [head, sections].filter((part) => part !== "").join("\n");
          })
          .filter((part) => part !== ""),
      ].join("\n");
    })
    .join("\n");
  const fullContent = [chapterContent, content].filter((part) => part !== "").join("\n");

  const generatedAt = new Date().toLocaleString();
  const debugAssets = options.debug
    ? `
  <style>
  .debug-row { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
  .debug-btn { border: 1px solid #0969da; color: #0969da; background: #fff; border-radius: 6px; padding: 3px 12px; font-size: 12px; cursor: pointer; }
  .debug-btn:hover { background: #0969da; color: #fff; }
  .debug-hint { color: #57606a; font-size: 11px; }
  .debug-out { margin-top: 8px; max-height: 320px; overflow: auto; white-space: pre-wrap; }
  </style>
<script>
(function () {
  document.querySelectorAll(".debug-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var section = btn.closest("section");
      var out = section.querySelector(".debug-out");
      out.hidden = false;
      out.textContent = "请求中…";
      var init = { method: btn.dataset.method, headers: {} };
      if (btn.dataset.body && btn.dataset.method !== "GET" && btn.dataset.method !== "HEAD") {
        init.headers["Content-Type"] = "application/json";
        init.body = btn.dataset.body;
      }
      fetch(btn.dataset.url, init).then(function (resp) {
        return resp.text().then(function (text) {
          out.textContent = resp.status + " " + resp.statusText + "\\n\\n" + text.slice(0, 20000);
        });
      }).catch(function (error) {
        out.textContent = "调试失败：" + error.message + "\\n（浏览器 CORS 限制：目标服务需允许跨域，或改用桌面端调试）";
      });
    });
  });
})();
</script>`
    : "";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} · Reqora</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #1f2328; background: #f6f8fa; font-size: 14px; line-height: 1.6; }
  a { color: #0969da; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: #eff1f3; border-radius: 4px; padding: 1px 5px; }
  pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  .layout { display: flex; min-height: 100vh; }
  nav { width: 280px; flex-shrink: 0; background: #ffffff; border-right: 1px solid #d0d7de; padding: 16px 12px 32px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
  .brand { font-weight: 700; font-size: 15px; padding: 0 8px 12px; border-bottom: 1px solid #d0d7de; margin-bottom: 12px; }
  .brand small { display: block; font-weight: 400; color: #57606a; font-size: 11px; margin-top: 2px; }
  nav ul { list-style: none; margin: 0; padding: 0; }
  .toc-collection { margin-bottom: 10px; }
  details.toc-folder { margin-left: 14px; }
  details.toc-folder summary { display: flex; align-items: center; gap: 6px; font-size: 11.5px; padding: 4px 8px 2px; cursor: pointer; user-select: none; }
  details.toc-folder summary::-webkit-details-marker { display: none; }
  details.toc-folder summary::before { content: "▸"; display: inline-block; width: 10px; transition: transform .15s; color: #8b949e; }
  details.toc-folder[open] summary::before { transform: rotate(90deg); }
  .collection-title { display: flex; align-items: center; gap: 8px; font-size: 17px; font-weight: 700; color: #1f2328; margin: 32px 0 14px; padding: 0 0 8px; border-bottom: 1px solid #d0d7de; }
  .collection-title small { font-weight: 400; font-size: 11px; color: #8b949e; }
  .collection-title svg { flex-shrink: 0; }
  .folder-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: #57606a; margin: 28px 0 12px; }
  .folder-title small { font-weight: 400; font-size: 11px; color: #8b949e; }
  .folder-title svg { flex-shrink: 0; }
  .toc-name { font-weight: 600; font-size: 12px; color: #57606a; padding: 4px 8px; text-transform: uppercase; letter-spacing: .04em; }
  .toc-collection ul a { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 6px; font-size: 13px; color: #1f2328; }
  .toc-collection ul a:hover { background: #eff1f3; text-decoration: none; }
  .method { display: inline-block; color: #fff; font-size: 10px; font-weight: 700; border-radius: 4px; padding: 1px 6px; font-family: ui-monospace, monospace; letter-spacing: .03em; }
  main { flex: 1; min-width: 0; padding: 24px 32px 64px; }
  .page-head { margin-bottom: 20px; }
  .page-head h1 { font-size: 20px; margin: 0 0 4px; }
  .page-head .meta { color: #57606a; font-size: 12px; }
  .api { background: #ffffff; border: 1px solid #d0d7de; border-radius: 10px; padding: 20px 24px; margin-bottom: 20px; }
  .api h2 { display: flex; align-items: center; gap: 8px; font-size: 17px; margin: 0 0 6px; }
  .api .summary { color: #57606a; margin: 0 0 10px; }
  .api .url { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 8px 10px; font-size: 12.5px; word-break: break-all; margin: 0 0 14px; }
  .api h4 { font-size: 13px; margin: 16px 0 6px; color: #57606a; }
  .desc :is(h2, h3, h4, h5) { font-size: 14px; margin: 12px 0 4px; }
  table { border-collapse: collapse; width: 100%; margin: 4px 0 8px; font-size: 12.5px; }
  th, td { border: 1px solid #d0d7de; padding: 5px 9px; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; font-weight: 600; }
  td.mono { font-family: ui-monospace, monospace; }
  .tree-name { display: inline-block; }
  .tree-group td { background: #fbfcfd; font-weight: 600; }
  .resp-line { display: flex; align-items: center; gap: 6px; margin: 10px 0 4px; }
  @media (max-width: 900px) { nav { display: none; } }
</style>
</head>
<body>
<div class="layout">
  <nav>
    <div class="brand">${esc(title)}<small>Reqora 导出 · ${esc(generatedAt)}</small></div>
    <ul>${toc}</ul>
  </nav>
  <main>
    <div class="page-head">
      <h1>${esc(title)}</h1>
      <div class="meta">${payload.collections.length} 个集合 · ${total} 个接口 · 由 Reqora 导出于 ${esc(generatedAt)}</div>
    </div>
    ${fullContent || '<p>工作区还没有接口，先在应用中创建请求后再导出。</p>'}
  </main>
</div>
${debugAssets}
</body>
</html>
`;
}

// ------------------------------------------------- 加密分享（P1-6） ----

const PBKDF2_ITERATIONS = 200000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** AES-GCM 加密：输出 base64(salt[16] + iv[12] + cipher)，可被 decryptDocSitePayload 还原。 */
export async function encryptDocSitePayload(text: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(text),
    ),
  );
  const out = new Uint8Array(28 + cipher.length);
  out.set(salt, 0);
  out.set(iv, 16);
  out.set(cipher, 28);
  return bytesToBase64(out);
}

/** 解密 encryptDocSitePayload 的产物；密码错误抛错。测试与文档站解密器共用语义。 */
export async function decryptDocSitePayload(payload: string, password: string): Promise<string> {
  const bytes = base64ToBytes(payload);
  const salt = bytes.slice(0, 16);
  const iv = bytes.slice(16, 28);
  const cipher = bytes.slice(28);
  const key = await deriveKey(password, salt);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    cipher as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

const ENCRYPTED_SHELL_CSS = `body{margin:0;font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;width:min(420px,90vw);text-align:center}
.card h1{font-size:16px;margin:0 0 6px}
.card p{color:#8b949e;font-size:12.5px;margin:0 0 18px}
.card input{width:100%;box-sizing:border-box;border:1px solid #30363d;background:#0d1117;color:#e6edf3;border-radius:8px;padding:10px 12px;font-size:14px;outline:none}
.card input:focus{border-color:#0969da}
.card button{margin-top:12px;width:100%;border:none;background:#0969da;color:#fff;border-radius:8px;padding:10px;font-size:14px;cursor:pointer}
.card button:disabled{opacity:.6}
.card .err{color:#f85149;font-size:12px;margin-top:10px;min-height:16px}`;

/**
 * 生成加密文档站（P1-6）：整份文档（含调试脚本）AES-GCM 加密后内嵌进单文件
 * HTML，打开时要求输入密码，解密成功后整页替换为文档内容。密码不写入文件。
 */
export async function exportEncryptedDocSiteHtml(
  snapshot: WorkspaceSnapshot,
  password: string,
  title = "API 文档",
): Promise<string> {
  const trimmed = password.trim();
  if (!trimmed) throw new Error("加密密码不能为空");
  const document_ = exportDocSiteHtml(snapshot, title, {
    debug: true,
    variables: {},
  });
  const payload = await encryptDocSitePayload(document_, trimmed);
  const encoded = esc(payload);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} · 加密文档</title>
<style>${ENCRYPTED_SHELL_CSS}</style>
</head>
<body>
<div class="card">
  <h1>🔒 ${esc(title)}</h1>
  <p>此文档已加密（AES-GCM-256）。输入密码后在本页解密查看，密码不会通过网络传输。</p>
  <form id="unlock">
    <input type="password" id="pwd" placeholder="文档密码" autocomplete="off" autofocus>
    <button type="submit" id="go">解锁文档</button>
    <div class="err" id="err"></div>
  </form>
</div>
<script id="payload" type="text/plain">${encoded}</script>
<script>
(function () {
  var PAYLOAD = document.getElementById("payload").textContent.trim();
  var ITERATIONS = ${PBKDF2_ITERATIONS};
  function b64ToBytes(text) {
    var binary = atob(text);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function deriveKey(password, salt) {
    return crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]).then(function (baseKey) {
      return crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt, iterations: ITERATIONS, hash: "SHA-256" }, baseKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    });
  }
  document.getElementById("unlock").addEventListener("submit", function (event) {
    event.preventDefault();
    var button = document.getElementById("go");
    var error = document.getElementById("err");
    button.disabled = true;
    error.textContent = "";
    var bytes = b64ToBytes(PAYLOAD);
    var salt = bytes.slice(0, 16);
    var iv = bytes.slice(16, 28);
    var cipher = bytes.slice(28);
    deriveKey(document.getElementById("pwd").value, salt).then(function (key) {
      return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, cipher);
    }).then(function (plain) {
      var html = new TextDecoder().decode(plain);
      document.open();
      document.write(html);
      document.close();
    }).catch(function () {
      error.textContent = "密码错误或文档已损坏";
      button.disabled = false;
    });
  });
})();
</script>
</body>
</html>
`;
}
