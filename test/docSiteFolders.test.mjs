import test from "node:test";
import assert from "node:assert/strict";
import {
  folderGroups,
  folderOutline,
  folderHiddenByAncestor,
  buildDocSitePayload,
  normalizeDocSitePayload,
} from "../src/lib/docSitePayload.ts";
import { exportDocSiteHtml } from "../src/lib/docsite.ts";
import { exportMarkdown } from "../src/lib/transfer.ts";

// 最小快照：一个集合，根级接口 + 两个文件夹（字母序 WS < SSE 会被 localeCompare 排序验证）。
const request = (overrides) => ({
  id: overrides.id,
  name: overrides.name,
  method: overrides.method ?? "GET",
  url: overrides.url ?? "/",
  folder: overrides.folder,
  body: { type: "none" },
  query: [],
  headers: [],
  auth: { type: "none" },
  ...overrides,
});

const snapshot = () => ({
  collections: [
    {
      name: "集合A",
      items: [
        request({ id: "r1", name: "根接口", url: "/root" }),
        request({ id: "r2", name: "SSE 调试", url: "/sse", folder: "流式/SSE" }),
        request({ id: "r3", name: "WS 调试", url: "/ws", folder: "流式/WS" }),
        request({ id: "r4", name: "列表", url: "/list", folder: "业务" }),
      ],
    },
  ],
  docPages: [],
  environments: [],
  activeEnvironmentId: null,
  codeTemplates: [],
});

test("folderGroups：根级接口在前、同前缀文件夹有序、深度与展示名正确", () => {
  const groups = folderGroups(snapshot().collections[0].items);
  // 根级接口永远排最前。
  assert.equal(groups[0].folder, "");
  assert.deepEqual(groups[0].requests.map((r) => r.id), ["r1"]);
  // 其余组是三个文件夹，路径集合完整（不依赖 locale 的排序规则）。
  assert.deepEqual(
    groups.slice(1).map((group) => group.folder).sort(),
    ["业务", "流式/SSE", "流式/WS"].sort(),
  );
  // 同前缀的文件夹保持后缀字母序（不依赖 locale 的中文排序规则）。
  const stream = groups.filter((group) => group.folder.startsWith("流式/"));
  assert.deepEqual(stream.map((group) => group.folder), ["流式/SSE", "流式/WS"]);
  // 组内保持原数组顺序。
  assert.ok(stream.every((group) => group.requests.length === 1));
  // 深度与展示名。
  const sse = groups.find((group) => group.folder === "流式/SSE");
  assert.equal(sse.depth, 2);
  assert.equal(sse.name, "SSE");
  const biz = groups.find((group) => group.folder === "业务");
  assert.equal(biz.depth, 1);
  assert.equal(biz.name, "业务");
});

test("folderGroups：容错——undefined folder 视为根、空路径段被忽略", () => {
  const groups = folderGroups([
    { id: "a", folder: undefined },
    { id: "b", folder: "  " },
    { id: "c", folder: "x/y" },
  ]);
  assert.deepEqual(groups.map((group) => group.folder), ["", "x/y"]);
  assert.equal(groups[0].requests.length, 2);
});

test("buildDocSitePayload：请求携带 folder 字段，totalRequests 不变", () => {
  const payload = buildDocSitePayload(snapshot());
  assert.equal(payload.totalRequests, 4);
  assert.deepEqual(
    payload.collections[0].requests.map((r) => [r.id, r.folder]),
    [
      ["r1", ""],
      ["r2", "流式/SSE"],
      ["r3", "流式/WS"],
      ["r4", "业务"],
    ],
  );
});

test("normalizeDocSitePayload：folder 往返保留；旧版 payload 缺 folder 归一为空串", () => {
  const payload = buildDocSitePayload(snapshot());
  const roundTrip = normalizeDocSitePayload(JSON.parse(JSON.stringify(payload)));
  assert.deepEqual(
    roundTrip.collections[0].requests.map((r) => r.folder),
    ["", "流式/SSE", "流式/WS", "业务"],
  );

  const legacy = JSON.parse(JSON.stringify(payload));
  for (const item of legacy.collections[0].requests) delete item.folder;
  const normalized = normalizeDocSitePayload(legacy);
  assert.ok(normalized.collections[0].requests.every((r) => r.folder === ""));
});

test("folderOutline：多级路径逐级生成标题节点，兄弟分组共享父级只出现一次", () => {
  const outline = folderOutline(folderGroups(snapshot().collections[0].items));
  // 根级接口最先。
  assert.deepEqual(outline[0], { path: "", name: "", depth: 0, count: 1, requests: outline[0].requests });
  assert.equal(outline[0].requests.length, 1);
  // 一级标题节点恰好两个：业务、流式（先后由 localeCompare 决定，不硬编码）。
  const depth1 = outline.filter((node) => node.depth === 1 && node.requests.length === 0);
  assert.deepEqual(
    depth1.map((node) => node.path).sort(),
    ["业务", "流式"].sort(),
  );
  // 每个多级路径都先有标题节点、后有携带接口的叶子节点。
  const streamNodes = outline.filter((node) => node.path.startsWith("流式/"));
  assert.deepEqual(
    streamNodes.map((node) => [node.path, node.requests.length]),
    [
      ["流式/SSE", 0],
      ["流式/SSE", 1],
      ["流式/WS", 0],
      ["流式/WS", 1],
    ],
  );
  // 「流式」标题节点只出现一次（SSE 与 WS 共享父级）。
  assert.equal(outline.filter((node) => node.path === "流式").length, 1);
  // 深层叶子节点挂在完整路径下。
  const sseLeaf = outline.find((node) => node.path === "流式/SSE" && node.requests.length > 0);
  assert.equal(sseLeaf.depth, 2);
  assert.equal(sseLeaf.name, "SSE");
  assert.deepEqual(sseLeaf.requests.map((r) => r.id), ["r2"]);
});

test("folderHiddenByAncestor：任一祖先折叠即隐藏，自身折叠不影响祖先判定", () => {
  const collapsed = new Set(["流式"]);
  assert.ok(folderHiddenByAncestor("流式/SSE", collapsed));
  assert.ok(folderHiddenByAncestor("流式/WS/消息", collapsed));
  assert.ok(!folderHiddenByAncestor("业务", collapsed));
  // 一级路径没有祖先，永远不被 ancestor 判定隐藏。
  assert.ok(!folderHiddenByAncestor("流式", new Set(["流式"])));
});

test("exportDocSiteHtml：目录与正文按文件夹层级分组并带标题", () => {
  const html = exportDocSiteHtml(snapshot(), "测试文档");
  // 正文：多级文件夹逐级标题（「流式」父级 + SSE/WS 子级），全文不再出现合并路径标题。
  assert.match(html, /class="folder-title"[^>]*>[\s\S]*?流式</);
  assert.match(html, /title="流式\/SSE"/);
  assert.match(html, /class="folder-title"[^>]*>[\s\S]*?业务</);
  // 目录：文件夹以可折叠 details 呈现。
  assert.match(html, /<details open class="toc-folder"><summary[^>]*>[\s\S]*?流式</);
  assert.match(html, /<summary[^>]*>[\s\S]*?SSE</);
  // 接口锚点数量不变（4 个）。
  assert.equal(html.match(/<section class="api" id="api-\d+">/g)?.length, 4);
});

test("exportDocSiteHtml：正文按 集合 → 文件夹(可嵌套) → 接口 呈现", () => {
  const html = exportDocSiteHtml(snapshot(), "测试文档");
  // 正文最外层是集合标题，携带集合内接口总数。
  assert.match(html, /class="collection-title"[^>]*>[\s\S]*?集合A<small>4 个接口<\/small>/);
  // 层级顺序：集合标题 → 文件夹标题 → 接口卡片。
  const collectionAt = html.indexOf('class="collection-title"');
  const folderAt = html.indexOf('class="folder-title"');
  const apiAt = html.indexOf('<section class="api"');
  assert.ok(collectionAt >= 0, "正文应包含集合标题");
  assert.ok(collectionAt < folderAt, "集合标题应排在文件夹标题之前");
  assert.ok(collectionAt < apiAt, "集合标题应排在接口卡片之前");
  // 根级接口按既有规则排在文件夹之前，故不比较 folderAt 与 apiAt。
});

test("exportDocSiteHtml：多个集合各自成组", () => {
  const snap = snapshot();
  snap.collections.push({
    id: "c2",
    name: "集合B",
    items: [request({ id: "r5", name: "B 接口", url: "/b", folder: "后台/管理" })],
  });
  const html = exportDocSiteHtml(snap, "测试文档");
  assert.match(html, /class="collection-title"[^>]*>[\s\S]*?集合A/);
  assert.match(html, /class="collection-title"[^>]*>[\s\S]*?集合B<small>1 个接口<\/small>/);
  assert.equal(html.match(/class="collection-title"/g)?.length, 2);
  // 每个集合内部仍保留多级文件夹标题。
  assert.match(html, /title="后台\/管理"/);
});

test("exportMarkdown：多级文件夹按层级降级标题", () => {
  const md = exportMarkdown(snapshot());
  const headings = md.split("\n").filter((line) => line.startsWith("#"));
  assert.equal(headings[0], "# 集合A");
  assert.equal(headings[1], "## GET /root 根接口");
  // 一级文件夹 ##、其下接口 ###；二级文件夹 ###、其下接口 ####。
  assert.ok(headings.includes("## 业务"));
  assert.ok(headings.includes("### GET /list 列表"));
  assert.ok(headings.includes("## 流式"));
  assert.ok(headings.includes("### SSE"));
  assert.ok(headings.includes("### WS"));
  assert.ok(headings.includes("#### GET /sse SSE 调试"));
  assert.ok(headings.includes("#### GET /ws WS 调试"));
  // 顺序：## 流式 在 ### SSE 之前，### SSE 在 #### 接口之前。
  const indexOf = (line) => headings.indexOf(line);
  assert.ok(indexOf("## 流式") < indexOf("### SSE"));
  assert.ok(indexOf("### SSE") < indexOf("#### GET /sse SSE 调试"));
  assert.ok(indexOf("### WS") < indexOf("#### GET /ws WS 调试"));
});
