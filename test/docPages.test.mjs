import test from "node:test";
import assert from "node:assert/strict";
import {
  DOC_PAGE_GROUPS,
  DOC_SITE_ERROR_CODE_COLUMNS,
  builtinDocPages,
  docPageGroupLabel,
  docPagesToMarkdown,
  errorCodeRowsForTable,
  moveDocPage,
  newDocPage,
  newErrorCodeRow,
  normalizeDocPages,
  slugifyDocTitle,
} from "../src/lib/docPages.ts";

test("slugifyDocTitle：中文、空白、特殊字符与回退值", () => {
  assert.equal(slugifyDocTitle("接口鉴权 流程"), "接口鉴权-流程");
  assert.equal(slugifyDocTitle("  A_B  "), "a-b");
  assert.equal(slugifyDocTitle("a  --  b"), "a-b");
  assert.equal(slugifyDocTitle("!!"), "section");
  assert.equal(slugifyDocTitle("", "fallback"), "fallback");
});

test("docPageGroupLabel / DOC_PAGE_GROUPS：未知分组回退为指南", () => {
  assert.equal(docPageGroupLabel("guide"), "指南");
  assert.equal(docPageGroupLabel("reference"), "参考");
  assert.equal(docPageGroupLabel("changelog"), "更新日志");
  assert.equal(docPageGroupLabel("unknown"), "指南");
  assert.equal(DOC_PAGE_GROUPS.length, 3);
});

test("normalizeDocPages：兼容旧形状、slug 去重、分组与错误码归一化", () => {
  const pages = normalizeDocPages([
    { title: "接口鉴权" },
    { title: "接口鉴权", group: "reference", body: "正文", errorCodes: [{ code: "1002" }] },
    null,
    "bad",
    { title: "更新日志", group: "changelog", slug: "v2-0" },
    { group: "nonsense" },
  ]);
  assert.equal(pages.length, 4);
  assert.equal(pages[0].slug, "接口鉴权");
  assert.equal(pages[1].slug, "接口鉴权-2");
  assert.equal(pages[1].group, "reference");
  assert.equal(pages[1].body, "正文");
  assert.equal(pages[1].errorCodes.length, 1);
  assert.equal(pages[1].errorCodes[0].code, "1002");
  assert.equal(pages[1].errorCodes[0].message, "");
  assert.equal(pages[2].slug, "v2-0");
  assert.equal(pages[3].group, "guide");
  assert.equal(pages[3].title, "未命名章节");
  assert.ok(pages.every((page) => typeof page.id === "string" && page.id.length > 0));
  assert.deepEqual(normalizeDocPages(undefined), []);
  assert.deepEqual(normalizeDocPages({}), []);
});

test("moveDocPage：只在合法范围内交换且返回新数组", () => {
  const pages = normalizeDocPages([{ title: "A" }, { title: "B" }, { title: "C" }]);
  const moved = moveDocPage(pages, pages[1].id, -1);
  assert.deepEqual(moved.map((page) => page.title), ["B", "A", "C"]);
  assert.deepEqual(pages.map((page) => page.title), ["A", "B", "C"]);
  assert.equal(moveDocPage(pages, pages[0].id, -1), pages);
  assert.equal(moveDocPage(pages, pages[2].id, 1), pages);
  assert.equal(moveDocPage(pages, "missing", 1), pages);
});

test("errorCodeRowsForTable / docPagesToMarkdown：过滤空行、竖线转义、heading 参数", () => {
  const page = {
    ...newDocPage("错误码"),
    body: "## 统一结构",
    errorCodes: [
      {
        ...newErrorCodeRow(),
        code: "1002",
        httpStatus: "401",
        message: "未登录|失效",
        description: "描述",
        solution: "重新登录",
      },
      newErrorCodeRow(),
    ],
  };
  const rows = errorCodeRowsForTable(page);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], ["1002", "401", "未登录|失效", "描述", "重新登录"]);

  const md = docPagesToMarkdown([page], "##");
  assert.ok(md.startsWith("## 错误码"));
  assert.ok(md.includes("## 统一结构"));
  assert.ok(md.includes("| 错误码 | HTTP | 说明 | 描述 | 处理建议 |"));
  assert.ok(md.includes("未登录\\|失效"));
  assert.ok(docPagesToMarkdown([]) === "");
  assert.equal(DOC_SITE_ERROR_CODE_COLUMNS.length, 5);
});

test("builtinDocPages：四个骨架章节，slug 唯一且错误码有示例行", () => {
  const pages = builtinDocPages();
  assert.equal(pages.length, 4);
  assert.deepEqual(pages.map((page) => page.slug), ["quickstart", "auth", "flow", "errors"]);
  assert.equal(new Set(pages.map((page) => page.slug)).size, pages.length);
  assert.ok(pages.every((page) => page.body.trim().length > 0));
  const errors = pages.find((page) => page.slug === "errors");
  assert.equal(errors.group, "reference");
  assert.ok(errorCodeRowsForTable(errors).length >= 2);
});
