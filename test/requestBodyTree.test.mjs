/**
 * 请求 Body 字段的对象层级投影回归：
 * JSON 样例被 flattenJson 展平成 `specValueList[0].bid` 后，文档表格 / 文档站 /
 * 单文件 HTML / Markdown 导出都应还原成 `specValueList (array) → bid` 的层级，
 * 而不是把数组下标当成字段名平铺，也不把数组元素类型误标成 string。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { emptyDoc, emptySnapshot, normalizeRequest } from "../src/lib/defaults.ts";
import { bodyFieldRows, deriveParamSections } from "../src/lib/docs.ts";
import { requestBodyFieldTreeRows } from "../src/lib/responseParamTree.ts";
import { buildDocSitePayload } from "../src/lib/docSitePayload.ts";
import { exportDocSiteHtml } from "../src/lib/docsite.ts";
import { exportMarkdown } from "../src/lib/transfer.ts";

const SPEC_BODY = JSON.stringify({
  specName: "",
  productBidList: [""],
  specValueList: [{ bid: "", specValue: "", specValueMapping: "" }],
});

function specRequest() {
  return normalizeRequest({
    id: "r-spec",
    name: "规格接口",
    method: "POST",
    url: "/specs",
    body: { type: "json", content: SPEC_BODY },
    doc: emptyDoc(),
  });
}

function snapshotWith(request) {
  const snapshot = emptySnapshot();
  snapshot.collections = [{ id: "c1", name: "集合", items: [request] }];
  return snapshot;
}

test("请求 Body 字段树：标量数组与对象数组都折叠下标并标注 array", () => {
  const rows = bodyFieldRows({ type: "json", content: SPEC_BODY }).map((field) => ({
    name: field.name,
    location: "body",
  }));
  const view = requestBodyFieldTreeRows(rows);
  const byName = new Map(view.map((node) => [node.leafName, node]));

  assert.equal(byName.get("specName").isGroup, false);
  assert.equal(byName.get("productBidList").isGroup, true);
  assert.equal(byName.get("productBidList").containerType, "array", "标量数组也应标注 array");
  assert.equal(byName.get("specValueList").isGroup, true);
  assert.equal(byName.get("specValueList").containerType, "array");

  const children = view.filter((node) => node.depth > 0).map((node) => node.leafName);
  assert.deepEqual(children, ["bid", "specValue", "specValueMapping"]);
  assert.ok(view.every((node) => !node.leafName.includes("[0]")), "下标不进入展示名");
});

test("派生参数仍保留扁平稳定键，paramMeta 编辑不因层级投影丢失", () => {
  const sections = deriveParamSections(specRequest(), emptyDoc());
  const body = sections.find((section) => section.location === "body");
  assert.ok(body.rows.some((row) => row.key === "b:specValueList[0].bid"));
  assert.ok(body.rows.some((row) => row.key === "b:productBidList[0]"));
});

test("数组容器行携带可编辑 meta（示例值/类型/必填/说明）", () => {
  const doc = emptyDoc();
  doc.paramMeta = {
    "b:productBidList": { type: "array", required: true, example: "bid-1", description: "投标ID列表" },
    "b:specValueList": { type: "array", required: false, example: "[{}]", description: "规格值列表" },
  };
  const sections = deriveParamSections({ ...specRequest(), doc }, doc);
  const body = sections.find((section) => section.location === "body");
  const view = requestBodyFieldTreeRows(body.rows);
  const byName = new Map(view.map((node) => [node.leafName, node]));

  const scalar = byName.get("productBidList");
  assert.equal(scalar.isGroup, true, "标量数组也是容器分组行");
  assert.ok(scalar.item, "容器行携带 item，文档表格可编辑");
  assert.equal(scalar.item.key, "b:productBidList", "容器使用无下标的稳定 key");
  assert.equal(scalar.item.meta.example, "bid-1");
  assert.equal(scalar.item.meta.description, "投标ID列表");
  assert.equal(scalar.item.meta.required, true);

  const objectArray = byName.get("specValueList");
  assert.equal(objectArray.isGroup, true);
  assert.ok(objectArray.item, "对象数组容器也可编辑说明");
  assert.equal(objectArray.item.key, "b:specValueList");
  assert.equal(objectArray.item.meta.description, "规格值列表");
  assert.equal(objectArray.containerType, "array");
});

test("文档站请求参数表按层级渲染，Query / Header 仍平铺", () => {
  const doc = emptyDoc();
  doc.paramMeta = {
    "b:specValueList": { type: "array", required: false, example: "", description: "规格说明容器" },
  };
  const request = normalizeRequest({
    ...specRequest(),
    doc,
    query: [{ id: "q1", key: "page", value: "1", enabled: true }],
    headers: [{ id: "h1", key: "X-Trace", value: "t", enabled: true }],
  });
  const payload = buildDocSitePayload(snapshotWith(request));
  const tables = payload.collections[0].requests[0].tables;
  const body = tables.find((table) => table.label === "Body 字段");
  assert.ok(body.rows.some((row) => row.name === "specValueList[0].bid"), "payload 保持扁平源数据");

  const html = exportDocSiteHtml(snapshotWith(request));
  assert.ok(html.includes(">specValueList<"), "父级以字段名呈现");
  assert.ok(html.includes(">productBidList<"));
  assert.ok(html.includes(">array<"), "父级标注 array");
  assert.ok(html.includes("规格说明容器"), "容器说明进入导出页");
  assert.ok(!html.includes("specValueList[0].bid"), "导出页不再输出扁平点路径");
  assert.ok(html.includes(">page<"), "Query 参数仍平铺");
  assert.ok(html.includes(">X-Trace<"), "Header 参数仍平铺");
});

test("Markdown 导出的 Body 字段按对象层级缩进", () => {
  const doc = emptyDoc();
  doc.paramMeta = {
    "b:productBidList": { type: "array", required: false, example: "bid-1", description: "投标说明容器" },
    "b:productBidList[0]": { type: "string", required: false, example: "", description: "" },
    "b:specValueList": { type: "array", required: false, example: "", description: "" },
    "b:specValueList[0].bid": { type: "string", required: false, example: "", description: "" },
    "b:specValueList[0].specValue": { type: "string", required: false, example: "", description: "" },
    "b:specValueList[0].specValueMapping": { type: "string", required: false, example: "", description: "" },
  };
  const request = normalizeRequest({ ...specRequest(), doc });
  const md = exportMarkdown(snapshotWith(request));
  assert.ok(md.includes("**Body 字段**"));
  assert.ok(md.includes("specValueList"), "父级字段名出现");
  assert.ok(md.includes("productBidList"));
  assert.ok(!md.includes("specValueList[0].bid"), "不再输出扁平点路径");
  assert.ok(md.includes("bid"), "子字段出现");
  assert.ok(md.includes("投标说明容器"), "容器说明进入 Markdown");
  assert.ok(md.includes("bid-1"), "容器示例值进入 Markdown");
});
