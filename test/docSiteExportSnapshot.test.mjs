/**
 * 文档站导出快照：在「导出器消费 DocSitePayload」重构前后锁定四条路径的关键结构，
 * 保证合并只是去掉重复投影、不改变对外输出。
 *
 * - 文件夹分组：多级标题（正文 / 目录）、Heading 降级、payload.folder
 * - 响应示例：标题 / 描述 / 代码块
 * - 响应参数树：对象层级（data → orders[0] → total）、[0] 折叠、Header 平铺
 * - 网页版 payload 归一化：buildDocSitePayload → normalizeDocSitePayload 往返
 *
 * 断言刻意落在「关键结构 / 标题 / 字段」上，避免把生成时间戳、徽标颜色等
 * 易变细节写死；重构只换数据来源，这些结构必须逐字保持一致。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { exportDocSiteHtml } from "../src/lib/docsite.ts";
import { exportMarkdown } from "../src/lib/transfer.ts";
import {
  buildDocSitePayload,
  normalizeDocSitePayload,
  folderGroups,
  folderOutline,
} from "../src/lib/docSitePayload.ts";
import { responseParamTreeRows, TREE_INDENT } from "../src/lib/responseParamTree.ts";

const doc = (overrides = {}) => ({
  summary: "",
  description: "",
  owner: "",
  status: "",
  tags: [],
  paramMeta: {},
  responses: [],
  updatedAt: 0,
  ...overrides,
});

const request = (overrides) => ({
  id: overrides.id,
  name: overrides.name,
  method: overrides.method ?? "GET",
  url: overrides.url ?? "/",
  folder: overrides.folder,
  query: [],
  headers: [],
  body: { type: "none" },
  auth: { type: "none" },
  doc: doc(),
  updatedAt: 0,
  ...overrides,
});

/** 一份覆盖四条导出路径的最小工作区。 */
function snapshot() {
  return {
    collections: [
      {
        id: "c1",
        name: "订单服务",
        items: [
          request({ id: "r0", name: "健康检查", url: "/health" }),
          request({
            id: "r1",
            name: "创建订单",
            method: "POST",
            url: "https://api.example.com/orders",
            folder: "订单/写入",
            query: [{ id: "q1", key: "source", value: "app", enabled: true }],
            headers: [{ id: "h1", key: "X-Trace", value: "t-1", enabled: true }],
            body: { type: "json", content: '{"sku":"A1"}' },
            doc: doc({
              summary: "创建一笔订单",
              description: "## 说明\n\n调用前请先鉴权。",
              paramMeta: {
                "q:q1": { type: "string", required: true, example: "app", description: "来源" },
              },
              responses: [
                {
                  id: "e1",
                  name: "成功",
                  status: 200,
                  contentType: "application/json",
                  body: '{"code":0}',
                  description: "创建成功",
                  params: [
                    { id: "p1", name: "code", location: "body", type: "integer", required: true, example: "0", description: "状态码" },
                    { id: "p2", name: "data.id", location: "body", type: "integer", required: true, example: "7", description: "订单 ID" },
                    { id: "p3", name: "data.orders[0].total", location: "body", type: "number", required: false, example: "9", description: "金额" },
                    { id: "p4", name: "X-Rate-Limit", location: "header", type: "string", required: false, example: "100", description: "限流额度" },
                  ],
                },
              ],
            }),
          }),
          request({
            id: "r2",
            name: "订单列表",
            url: "https://api.example.com/orders",
            folder: "订单/读取",
          }),
        ],
      },
    ],
    docPages: [
      { id: "pg1", slug: "quickstart", title: "快速开始", group: "guide", body: "## 欢迎\n\n先鉴权。", errorCodes: [], order: 0 },
    ],
    environments: [],
    activeEnvironmentId: null,
    codeTemplates: [],
  };
}

const html = () => exportDocSiteHtml(snapshot(), "订单 API");
const markdown = () => exportMarkdown(snapshot());
const payload = () =>
  buildDocSitePayload(snapshot(), {
    title: "订单 API",
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

// ---------------------------------------------------------- 路径 1：文件夹分组 ----

test("快照/文件夹分组：HTML 正文与目录的多级标题、Markdown 降级标题、payload.folder", () => {
  const h = html();
  // 正文：一级父级「订单」+ 二级「写入 / 读取」，均带子树接口计数。
  assert.match(h, /class="folder-title"[^>]*title="订单"/);
  assert.match(h, /<small>2 个接口<\/small>/);
  assert.match(h, /class="folder-title"[^>]*title="订单\/写入"/);
  assert.match(h, /class="folder-title"[^>]*title="订单\/读取"/);
  // 目录：文件夹以可折叠 details 呈现。
  assert.match(h, /<details open class="toc-folder">/);
  // 接口锚点按集合内顺序编号，根级接口最前。
  assert.match(h, /<section class="api" id="api-0">/);
  assert.match(h, /<section class="api" id="api-1">/);
  assert.match(h, /<section class="api" id="api-2">/);
  // 公共章节仍在目录与正文里。
  assert.match(h, /href="#page-quickstart"/);
  assert.match(h, /id="page-quickstart"/);

  const md = markdown();
  const headings = md.split("\n").filter((line) => line.startsWith("#"));
  assert.equal(headings[0], "# 订单服务");
  assert.ok(headings.includes("## 订单"));
  assert.ok(headings.includes("### 写入"));
  assert.ok(headings.includes("### 读取"));
  // 一级文件夹在二级文件夹之前。
  assert.ok(headings.indexOf("## 订单") < headings.indexOf("### 写入"));

  const p = payload();
  assert.deepEqual(
    p.collections[0].requests.map((r) => [r.id, r.folder]),
    [
      ["r0", ""],
      ["r1", "订单/写入"],
      ["r2", "订单/读取"],
    ],
  );
  assert.equal(p.totalRequests, 3);
});

// ------------------------------------------------------------ 路径 2：响应示例 ----

test("快照/响应示例：HTML / Markdown / payload 的标题、描述与代码块", () => {
  const h = html();
  assert.ok(h.includes("<h4>响应示例</h4>"));
  assert.ok(h.includes("<strong>成功</strong>"));
  assert.ok(h.includes("创建成功"));
  assert.ok(h.includes('<pre><code class="json">{&quot;code&quot;:0}</code></pre>'));

  const md = markdown();
  assert.ok(md.includes("**响应示例**"));
  assert.ok(md.includes("成功（200）：创建成功"));
  assert.ok(md.includes("```json\n{\"code\":0}\n```"));

  const p = payload();
  const response = p.collections[0].requests[1].responses[0];
  assert.equal(response.name, "成功");
  assert.equal(response.status, 200);
  assert.equal(response.description, "创建成功");
  assert.equal(response.text, '{"code":0}');
  assert.equal(response.lang, "json");
});

// ---------------------------------------------------------- 路径 3：响应参数树 ----

test("快照/响应参数树：对象层级、[0] 折叠与 Header 平铺在 HTML / Markdown / payload 一致", () => {
  const h = html();
  // Body / Header 两张字段表标题。
  assert.ok(h.includes("<h4>响应参数（Body）</h4>"));
  assert.ok(h.includes("<h4>响应参数（Header）</h4>"));
  // 父级只读行：data（object）与 orders（array<object>），共两行 tree-group。
  assert.equal(h.match(/<tr class="tree-group">/g)?.length, 2);
  assert.ok(h.includes("array&lt;object&gt;"));
  // 缩进层级：id 在 depth 1（14px），total 在 depth 2（28px），[0] 折叠进 orders。
  assert.match(h, /style="padding-left:14px">id<\/span>/);
  assert.match(h, /style="padding-left:28px">total<\/span>/);
  assert.ok(h.includes(">orders</span>"));
  // Header 表按平铺行渲染：X-Rate-Limit 不带 tree-group、不带缩进。
  const headerTable = h.slice(h.indexOf("<h4>响应参数（Header）</h4>"), h.indexOf("</tbody></table>", h.indexOf("<h4>响应参数（Header）</h4>")));
  assert.ok(headerTable.includes("X-Rate-Limit"));
  assert.ok(!headerTable.includes("tree-group"));
  assert.ok(!headerTable.includes("padding-left"));

  const md = markdown();
  assert.ok(md.includes("**响应参数（Body）**"));
  assert.ok(md.includes("**响应参数（Header）**"));
  // 父级加粗只读行 + 全角空格缩进（一级 1 个、二级 2 个）。
  assert.ok(md.includes("| **data** | object | 否 |"));
  assert.ok(md.includes("| **　orders** | array<object> | 否 |"));
  assert.ok(md.includes("| 　id | integer | 是 | 订单 ID | 7 |"));
  assert.ok(md.includes("| 　　total | number | 否 | 金额 | 9 |"));
  // Header 表平铺：X-Rate-Limit 不带全角空格缩进。
  assert.ok(md.includes("| X-Rate-Limit | string | 否 | 限流额度 | 100 |"));

  const p = payload();
  const tables = p.collections[0].requests[1].responses[0].tables;
  assert.deepEqual(tables.map((t) => t.label), ["响应参数（Body）", "响应参数（Header）"]);
  assert.deepEqual(tables[0].rows.map((r) => r.name), ["code", "data.id", "data.orders[0].total"]);
  assert.deepEqual(tables[1].rows.map((r) => r.name), ["X-Rate-Limit"]);
  assert.equal(tables[1].rows[0].example, "100");
});

// ------------------------------------------- 路径 4：网页版 payload 归一化往返 ----

test("快照/payload 归一化：build → JSON → normalize 保留 folder / 表 / 体 / 响应结构", () => {
  const built = payload();
  const roundTrip = normalizeDocSitePayload(JSON.parse(JSON.stringify(built)));
  assert.ok(roundTrip);
  assert.equal(roundTrip.title, "订单 API");
  assert.equal(roundTrip.generatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(roundTrip.totalRequests, built.totalRequests);
  assert.equal(roundTrip.chapters.length, built.chapters.length);
  assert.equal(roundTrip.chapters[0].slug, "quickstart");

  const req = roundTrip.collections[0].requests[1];
  assert.equal(req.folder, "订单/写入");
  assert.equal(req.method, "POST");
  assert.deepEqual(req.tables, built.collections[0].requests[1].tables);
  assert.deepEqual(req.body, built.collections[0].requests[1].body);
  assert.deepEqual(req.responses, built.collections[0].requests[1].responses);
  assert.deepEqual(req.snippets, built.collections[0].requests[1].snippets);
});

// ------------------------------------------- 重构后契约：树行 / location / count ----

test("契约：ResponseParamTreeRow 统一 isGroup / indent / leafName / TREE_INDENT，保留旧字段", () => {
  assert.equal(TREE_INDENT, 14);
  const rows = responseParamTreeRows([
    { name: "data.orders[0].total", location: "body" },
    { name: "X-Rate-Limit", location: "header" },
  ]);
  const byKey = (key) => rows.find((row) => row.key === key);

  const data = byKey("b:data");
  assert.equal(data.isGroup, true, "父级判定统一为 children > 0");
  assert.equal(data.children, 1);
  assert.equal(data.depth, 0, "depth 向后兼容保留");
  assert.equal(data.indent, 0);
  assert.equal(data.leafName, "data");
  assert.equal(data.label, "data", "label 向后兼容保留");
  assert.equal(data.containerType, "object");
  assert.equal(data.item, null, "item 向后兼容保留");

  const orders = byKey("b:data.orders");
  assert.equal(orders.isGroup, true);
  assert.equal(orders.indent, TREE_INDENT, "indent = depth * TREE_INDENT");
  assert.equal(orders.leafName, "orders", "[0] 下标折叠进父层 array 标记");
  assert.equal(orders.containerType, "array<object>");

  const total = byKey("b:data.orders.total");
  assert.equal(total.isGroup, false);
  assert.equal(total.indent, 2 * TREE_INDENT);
  assert.equal(total.leafName, "total");
  assert.ok(total.item, "叶子保留原行");

  const header = byKey("h:X-Rate-Limit");
  assert.equal(header.isGroup, false);
  assert.equal(header.indent, 0);
  assert.equal(header.leafName, "X-Rate-Limit");
  assert.ok(header.item, "Header 平铺行仍带 item，可被平铺渲染");
});

test("契约：payload 保留 location，网页版 Header 表走平铺分支而非 body 树", () => {
  const built = payload();
  const roundTrip = normalizeDocSitePayload(JSON.parse(JSON.stringify(built)));
  const tables = roundTrip.collections[0].requests[1].responses[0].tables;
  const header = tables.find((t) => t.label === "响应参数（Header）");
  const body = tables.find((t) => t.label === "响应参数（Body）");
  assert.equal(header.rows[0].location, "header");
  assert.equal(body.rows[0].location, "body");

  // 网页版把 header 表送进 responseParamTreeRows：命中 header 分支，得到平铺行。
  const tree = responseParamTreeRows(header.rows);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].key, "h:X-Rate-Limit");
  assert.equal(tree[0].isGroup, false);
  assert.equal(tree[0].indent, 0);
});

test("契约：FolderOutlineNode.count 下沉子树计数，标题节点可直接读取", () => {
  const outline = folderOutline(folderGroups(snapshot().collections[0].items));
  const orderTitle = outline.find((n) => n.path === "订单" && n.requests.length === 0);
  assert.equal(orderTitle.count, 2, "订单/写入 + 订单/读取");
  const writeTitle = outline.find((n) => n.path === "订单/写入" && n.requests.length === 0);
  assert.equal(writeTitle.count, 1);
  const root = outline.find((n) => n.path === "" && n.requests.length > 0);
  assert.equal(root.count, 1, "根级健康检查");
});
