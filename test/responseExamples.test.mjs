/**
 * 保存响应示例的两条规则（去重 / 沿用已有字段说明）与字段表的对象层级投影。
 * 都是纯逻辑，不读 store、不发请求。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readWorkspaceSource } from "./helpers/workspaceSource.mjs";
import test from "node:test";
import { deriveResponseParams } from "../src/lib/responseParams.ts";
import {
  buildResponseExample,
  formatResponseExampleBody,
  inheritResponseParams,
  isDuplicateResponseExample,
  responseBodySignature,
  responseExampleHint,
} from "../src/lib/responseExamples.ts";
import { responseParamTreeRows } from "../src/lib/responseParamTree.ts";

const source = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

const row = (name, patch = {}) => ({
  id: `id-${name}`,
  name,
  location: "body",
  type: "string",
  required: false,
  example: "",
  description: "",
  ...patch,
});

test("responseBodySignature：键顺序 / 空白不影响比较，值或状态码变化则不同", () => {
  const a = responseBodySignature(200, '{"code":0,"data":{"id":1}}');
  const b = responseBodySignature(200, '{\n  "data": { "id": 1 },\n  "code": 0\n}');
  assert.equal(a, b);
  assert.notEqual(a, responseBodySignature(200, '{"code":0,"data":{"id":2}}'));
  assert.notEqual(a, responseBodySignature(500, '{"code":0,"data":{"id":1}}'));
  // 非 JSON 退化为去首尾空白的原文比较。
  assert.equal(responseBodySignature(200, "  hello "), responseBodySignature(200, "hello"));
  assert.notEqual(responseBodySignature(200, "hello"), responseBodySignature(200, "world"));
});

test("formatResponseExampleBody：JSON 正文格式化为缩进形式，非 JSON 原样保留", () => {
  const raw = '{"code":0,"data":{"id":1,"tags":["a","b"]}}';
  const pretty = formatResponseExampleBody(raw);
  assert.equal(
    pretty,
    [
      "{",
      '  "code": 0,',
      '  "data": {',
      '    "id": 1,',
      '    "tags": [',
      '      "a",',
      '      "b"',
      "    ]",
      "  }",
      "}",
    ].join("\n"),
  );
  // 幂等：已格式化的正文再格式化一次不变。
  assert.equal(formatResponseExampleBody(pretty), pretty);
  // 数组同样格式化。
  assert.equal(formatResponseExampleBody('[{"id":1}]'), '[\n  {\n    "id": 1\n  }\n]');
  // 非 JSON / 截断片段 / 空串保持原文。
  assert.equal(formatResponseExampleBody("plain text"), "plain text");
  assert.equal(formatResponseExampleBody('{"code":0'), '{"code":0');
  assert.equal(formatResponseExampleBody(""), "");
});

test("isDuplicateResponseExample：命中已有示例时不再重复入档", () => {
  const examples = [
    { status: 200, body: '{"code":0,"list":[{"id":"A1"}]}' },
    { status: 404, body: '{"code":404}' },
  ];
  assert.equal(
    isDuplicateResponseExample(examples, 200, '{"list":[{"id":"A1"}],"code":0}'),
    true,
  );
  assert.equal(isDuplicateResponseExample(examples, 200, '{"code":0,"list":[{"id":"A2"}]}'), false);
  assert.equal(isDuplicateResponseExample(examples, 400, '{"code":404}'), false);
  assert.equal(isDuplicateResponseExample([], 200, '{"code":0}'), false);
});

test("inheritResponseParams：新建示例沿用已有示例的说明与必填", () => {
  const previous = [
    [
      row("code", { type: "integer", required: true, description: "业务码" }),
      row("data.id", { description: "用户 ID" }),
      row("Authorization", { location: "header", description: "访问令牌" }),
    ],
    [
      row("code", { type: "integer", required: true, description: "业务码（新）" }),
      row("extra", { description: "上一次新增的字段" }),
    ],
  ];
  const derived = deriveResponseParams(
    JSON.stringify({ code: 0, data: { id: 42, name: "Amy" }, token: "secret" }),
  );
  const params = inheritResponseParams(derived, previous);
  const byName = new Map(params.map((item) => [item.name, item]));
  // 越新的示例越优先。
  assert.equal(byName.get("code")?.description, "业务码（新）");
  assert.equal(byName.get("code")?.required, true);
  assert.equal(byName.get("data.id")?.description, "用户 ID");
  // 本次新增的字段没有历史定义：不要凭空编说明。
  assert.equal(byName.get("data.name")?.description, "");
  // 每次保存都重新派生，示例值来自这次的响应。
  assert.equal(byName.get("data.id")?.example, "42");
  // 派生出的行 id 必须各自独立，避免多条示例共享同一个字段 id。
  assert.equal(new Set(params.map((item) => item.id)).size, params.length);
  // 没有历史示例时原样返回。
  assert.deepEqual(inheritResponseParams(derived, []), derived);
});

test("responseParamTreeRows：点路径还原成对象层级", () => {
  const rows = [
    row("code", { type: "integer" }),
    row("data.list[0].id"),
    row("data.list[0].total", { type: "number" }),
    row("data.tags", { type: "array<string>" }),
    row("X-Total-Count", { location: "header", type: "integer" }),
  ];
  const tree = responseParamTreeRows(rows);
  const shape = tree.map((node) => `${"  ".repeat(node.depth)}${node.label}:${node.containerType || "leaf"}`);
  assert.deepEqual(shape, [
    "code:leaf",
    "data:object",
    "  list:array<object>",
    "    id:leaf",
    "    total:leaf",
    "  tags:leaf",
    "X-Total-Count:leaf",
  ]);
  // 父级是派生出来的合成行（字段表里没有 data / list 这两行）。
  const data = tree.find((node) => node.label === "data");
  assert.equal(data?.item, null);
  assert.equal(data?.children, 2);
  // 叶子仍然指回原行，编辑时改的是真实那一条。
  assert.equal(tree.find((node) => node.label === "total")?.item?.name, "data.list[0].total");
  // 响应头不参与嵌套。
  assert.equal(tree.at(-1)?.item?.location, "header");
});

test("responseParamTreeRows：同名字段跨多条数组元素合并到同一层级", () => {
  const tree = responseParamTreeRows([
    row("list[0].id"),
    row("list[1].id"),
    row("list[1].name"),
  ]);
  const shape = tree.map((node) => `${"  ".repeat(node.depth)}${node.label}`);
  assert.deepEqual(shape, ["list", "  id", "  name"]);
  assert.equal(tree[0].children, 2);
});

test("store：两个保存入口复用 buildResponseExample 与 writeDoc（单一实现）", () => {
  const store = readWorkspaceSource();
  const lib = source("../src/lib/responseExamples.ts");
  // 去重 / 字段继承规则集中在 buildResponseExample 这一份实现里。
  assert.match(lib, /isDuplicateResponseExample\(base\.responses, response\.status, response\.body\)/);
  assert.match(lib, /inheritResponseParams\(/);
  assert.match(lib, /deriveResponseParams\(/);
  // 两个入口都只通过 buildResponseExample 走这一套规则（不再各自实现）。
  assert.equal(store.match(/buildResponseExample\(/g)?.length, 2);
  // 写回集合的代码也只保留一份 helper，两个入口各调用一次。
  assert.equal(store.match(/writeDoc\(/g)?.length, 2);
});

// --------------------------------------- buildResponseExample / hint -------

const httpResponse = (patch = {}) => ({
  status: 200,
  body: '{"code":"abc"}',
  headers: [{ name: "content-type", value: "application/json" }],
  ...patch,
});

const docBase = (responses = [], patch = {}) => ({
  summary: "接口摘要",
  description: "说明",
  owner: "me",
  status: "开发中",
  tags: ["t1"],
  paramMeta: { "q:1": { description: "meta", type: "string" } },
  responses,
  updatedAt: 1,
  ...patch,
});

test("buildResponseExample：命中去重时返回 duplicate 且不产出 doc", () => {
  const existing = {
    id: "e1", name: "旧", status: 200, contentType: "application/json",
    body: '{"code":"abc"}', description: "", params: [],
  };
  const result = buildResponseExample(httpResponse(), docBase([existing]), {
    name: "示例 200", description: "",
  });
  assert.equal(result.result, "duplicate");
  assert.equal(result.doc, null);
  assert.equal(result.example, null);
});

test("buildResponseExample：新增时组装 doc、保留文档元数据与 options", () => {
  const base = docBase();
  const result = buildResponseExample(httpResponse(), base, {
    name: "手动命名", description: "来自用例「X」",
  });
  assert.equal(result.result, "added");
  const doc = result.doc;
  assert.equal(doc.responses.length, 1);
  // ...base：文档元数据不能丢。
  assert.equal(doc.summary, "接口摘要");
  assert.equal(doc.owner, "me");
  assert.deepEqual(doc.tags, ["t1"]);
  assert.deepEqual(doc.paramMeta, { "q:1": { description: "meta", type: "string" } });
  assert.notEqual(doc.updatedAt, 1);
  const ex = result.example;
  assert.equal(doc.responses[0], ex);
  assert.equal(ex.name, "手动命名");
  assert.equal(ex.description, "来自用例「X」");
  assert.equal(ex.status, 200);
  assert.equal(ex.contentType, "application/json");
  // JSON 响应体保存时即格式化，文档视图 / 导出链路直接复用 example.body。
  assert.equal(ex.body, '{\n  "code": "abc"\n}');
  assert.ok(typeof ex.id === "string" && ex.id.length > 0);
});

test("buildResponseExample：JSON 正文落库为格式化文本，非 JSON 与截断正文原样保存", () => {
  const result = buildResponseExample(
    httpResponse({ body: '{"code":"abc","list":[1,2]}' }),
    docBase(),
    { name: "示例 200", description: "" },
  );
  assert.equal(result.result, "added");
  assert.equal(result.example.body, '{\n  "code": "abc",\n  "list": [\n    1,\n    2\n  ]\n}');
  // 字段表仍按本次响应体派生，示例值不受格式化影响。
  assert.equal(result.example.params.find((item) => item.name === "code")?.example, "abc");

  const text = buildResponseExample(httpResponse({ body: "plain text" }), docBase(), {
    name: "示例 200", description: "",
  });
  assert.equal(text.example.body, "plain text");

  const truncated = buildResponseExample(
    httpResponse({ body: '{"code":0', truncated: true }),
    docBase(),
    { name: "示例 200", description: "" },
  );
  assert.equal(truncated.example.body, '{"code":0');
});

test("buildResponseExample：格式化后的示例仍能与原始响应正确判重", () => {
  const saved = buildResponseExample(httpResponse(), docBase(), {
    name: "示例 200", description: "",
  }).example;
  const base = docBase([saved]);
  // 新响应的原文和已存示例的格式化文本键顺序 / 空白不同，但内容一致 → duplicate。
  assert.equal(
    buildResponseExample(httpResponse({ body: '{ "code" : "abc" }' }), base, {
      name: "示例 200", description: "",
    }).result,
    "duplicate",
  );
  assert.equal(
    buildResponseExample(httpResponse({ body: '{"code":"changed"}' }), base, {
      name: "示例 200", description: "",
    }).result,
    "added",
  );
});

test("文档视图 / mock 预览复用同一份格式化逻辑", () => {
  const view = source("../src/components/ApiDocView.tsx");
  assert.match(view, /formatResponseExampleBody\(example\.body\)/);
  const docs = source("../src/lib/docs.ts");
  assert.match(docs, /import \{ formatResponseExampleBody \}/);
  assert.doesNotMatch(docs, /JSON\.stringify\(JSON\.parse\(example\.body\)/);
});

test("buildResponseExample：字段说明 / 必填沿用已有示例", () => {
  const previous = {
    id: "e1", name: "旧", status: 200, contentType: "application/json",
    body: '{"code":"old"}', description: "",
    params: [row("code", { required: true, description: "字段说明" })],
  };
  const result = buildResponseExample(httpResponse(), docBase([previous]), {
    name: "示例 200", description: "",
  });
  assert.equal(result.result, "added");
  const field = result.example.params.find((item) => item.name === "code");
  assert.ok(field, "应按响应体派生出 code 字段");
  assert.equal(field.description, "字段说明");
  assert.equal(field.required, true);
});

test("两个保存入口行为一致：去重 / 继承 / 文档组装只共享一份实现", () => {
  const previous = {
    id: "e1", name: "旧", status: 200, contentType: "application/json",
    body: '{"code":"old"}', description: "",
    params: [row("code", { required: true, description: "字段说明" })],
  };
  const base = docBase([previous]);
  const response = httpResponse();
  // 文档入口 vs 用例入口：仅 name / description 不同。
  const docEntry = buildResponseExample(response, base, { name: "示例 200", description: "" });
  const caseEntry = buildResponseExample(response, base, {
    name: "示例 200", description: "来自用例「A」",
  });
  assert.equal(docEntry.result, "added");
  assert.equal(caseEntry.result, "added");
  // 去重规则、字段继承、文档组装完全一致（派生字段 id 每次随机，比较内容）。
  const withoutId = (params) => params.map(({ id, ...rest }) => rest);
  assert.deepEqual(withoutId(docEntry.example.params), withoutId(caseEntry.example.params));
  assert.equal(docEntry.example.status, caseEntry.example.status);
  assert.equal(docEntry.example.contentType, caseEntry.example.contentType);
  assert.equal(docEntry.doc.summary, caseEntry.doc.summary);
  assert.equal(docEntry.doc.responses.length, caseEntry.doc.responses.length);
  // 仅两个入口各自允许的差异。
  assert.equal(docEntry.example.description, "");
  assert.equal(caseEntry.example.description, "来自用例「A」");
  // 相同响应在两条入口下都判为 duplicate。
  const sameAsExisting = httpResponse({ body: '{"code":"old"}' });
  assert.equal(
    buildResponseExample(sameAsExisting, base, { name: "示例 200", description: "" }).result,
    buildResponseExample(sameAsExisting, base, { name: "示例 200", description: "来自用例「A」" }).result,
  );
});

test("responseExampleHint：结果→文案映射两处入口集中且对外一致", () => {
  const cases = {
    doc: {
      added: "已新增一条返回示例，并按响应体生成响应参数表（字段说明沿用已有示例）",
      duplicate: "当前响应与已有示例的数据完全一致，没有重复保存",
      missing: "先发送一次请求再保存示例",
    },
    case: {
      added: "已新增一条返回示例，可在所属接口的「文档」标签查看与编辑（字段说明沿用了之前的示例）",
      duplicate: "这条响应与已有示例的数据完全一致，没有重复保存",
      missing: "保存失败：没有可用的响应或找不到所属接口",
    },
  };
  for (const variant of ["doc", "case"]) {
    for (const result of ["added", "duplicate", "missing"]) {
      assert.equal(responseExampleHint(result, variant), cases[variant][result]);
    }
  }
});
