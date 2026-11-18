import test from "node:test";
import assert from "node:assert/strict";
import {
  generateFromSchema,
  modelRefResolver,
  parseSchemaText,
  schemaFieldRows,
  schemaFromExample,
  validateJsonSchema,
} from "../src/lib/jsonschema.ts";

test("parseSchemaText：合法 / 非法 / 空", () => {
  const ok = parseSchemaText('{"type":"object"}');
  assert.equal(ok.error, null);
  assert.deepEqual(ok.schema, { type: "object" });

  const bad = parseSchemaText("{not-json}");
  assert.equal(ok.schema === null, false);
  assert.match(bad.error ?? "", /不是合法 JSON/);

  const empty = parseSchemaText("   ");
  assert.match(empty.error ?? "", /为空/);

  const arrayRoot = parseSchemaText("[]");
  assert.match(arrayRoot.error ?? "", /根节点必须是对象/);
});

test("schemaFromExample：推断嵌套结构并标记必填", () => {
  const schema = schemaFromExample({ id: 1, name: "Alice", tags: ["a"], active: true, score: 1.5 });
  assert.equal(schema.type, "object");
  const props = schema.properties;
  assert.equal(props.id.type, "integer");
  assert.equal(props.name.type, "string");
  assert.equal(props.tags.type, "array");
  assert.equal(props.tags.items.type, "string");
  assert.equal(props.active.type, "boolean");
  assert.equal(props.score.type, "number");
  assert.deepEqual([...schema.required].sort(), ["active", "id", "name", "score", "tags"]);
});

test("validateJsonSchema：类型不匹配报 error", () => {
  const schema = { type: "object", properties: { id: { type: "integer" } }, required: ["id"] };
  const findings = validateJsonSchema({ id: "not-a-number" }, schema);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "error");
  assert.match(findings[0].message, /期望类型 integer，实际 string/);
});

test("validateJsonSchema：缺少必填字段", () => {
  const schema = { type: "object", properties: { id: { type: "integer" } }, required: ["id", "name"] };
  const findings = validateJsonSchema({ id: 1 }, schema);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /缺少必填字段 name/);
  assert.equal(findings[0].path, "name");
});

test("validateJsonSchema：enum 与数组 items", () => {
  const schema = {
    type: "object",
    properties: {
      role: { type: "string", enum: ["admin", "user"] },
      tags: { type: "array", items: { type: "string" } },
    },
  };
  assert.equal(validateJsonSchema({ role: "guest", tags: ["a"] }, schema).length, 1);
  const nested = validateJsonSchema({ role: "user", tags: ["a", 3] }, schema);
  assert.equal(nested.length, 1);
  assert.match(nested[0].message, /tags\[1\]/);
});

test("validateJsonSchema：nullable 与 union type", () => {
  const schema = { type: ["string", "null"], properties: {} };
  assert.equal(validateJsonSchema(null, schema).length, 0);
  assert.equal(validateJsonSchema("hi", schema).length, 0);
  assert.equal(validateJsonSchema(3, schema).length, 1);

  const nullable = { type: "string", nullable: true };
  assert.equal(validateJsonSchema(null, nullable).length, 0);
  assert.equal(validateJsonSchema(9, nullable).length, 1);
});

test("validateJsonSchema：本地 $ref 指针解析", () => {
  const schema = {
    type: "object",
    properties: { owner: { $ref: "#/definitions/User" } },
    definitions: { User: { type: "object", properties: { name: { type: "string" } } } },
  };
  assert.equal(validateJsonSchema({ owner: { name: "a" } }, schema).length, 0);
  const findings = validateJsonSchema({ owner: { name: 5 } }, schema);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /owner\.name/);
});

test("validateJsonSchema：model:// 引用经 resolver 解析，失败降级 warning", () => {
  const schema = { type: "object", properties: { user: { $ref: "model://User" } } };
  const resolver = modelRefResolver([
    { name: "User", schemaText: '{"type":"object","properties":{"id":{"type":"integer"}}}' },
  ]);
  assert.equal(validateJsonSchema({ user: { id: 1 } }, schema, resolver).length, 0);
  const bad = validateJsonSchema({ user: { id: "x" } }, schema, resolver);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].level, "error");

  const missing = validateJsonSchema({ user: { id: "x" } }, schema, () => null);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].level, "warning");
  assert.match(missing[0].message, /无法解析/);
});

test("generateFromSchema：example / default / enum / format 优先级与类型兜底", () => {
  assert.equal(generateFromSchema({ type: "string", example: "hi" }), "hi");
  assert.equal(generateFromSchema({ type: "string", default: "yo", example: "hi" }), "hi");
  assert.equal(generateFromSchema({ type: "integer" }), 1);
  assert.equal(generateFromSchema({ type: "number" }), 1.5);
  assert.equal(generateFromSchema({ type: "boolean" }), true);
  assert.equal(generateFromSchema({ type: "string", format: "email" }), "user@example.com");
  assert.equal(generateFromSchema({ type: "string", format: "uuid" }), "00000000-0000-4000-8000-000000000000");
  assert.deepEqual(generateFromSchema({ type: "string", enum: ["a", "b"] }), "a");
  assert.deepEqual(generateFromSchema({ type: "array", items: { type: "integer" } }), [1]);
});

test("generateFromSchema：对象全字段 + $ref 递归", () => {
  const schema = {
    type: "object",
    properties: {
      id: { type: "integer" },
      profile: { $ref: "#/definitions/Profile" },
    },
    definitions: {
      Profile: { type: "object", properties: { nickname: { type: "string" } } },
    },
  };
  const value = generateFromSchema(schema);
  assert.deepEqual(value, { id: 1, profile: { nickname: "string" } });
});

test("generateFromSchema：model:// 循环引用有深度护栏", () => {
  const models = [
    {
      name: "A",
      schemaText: '{"type":"object","properties":{"b":{"$ref":"model://B"}}}',
    },
    {
      name: "B",
      schemaText: '{"type":"object","properties":{"a":{"$ref":"model://A"}}}',
    },
  ];
  const value = generateFromSchema(parseSchemaText(models[0].schemaText).schema, modelRefResolver(models));
  assert.equal(typeof value, "object");
  assert.ok(JSON.stringify(value).length < 5000);
});

test("schemaFieldRows：字段表派生", () => {
  const rows = schemaFieldRows({
    type: "object",
    properties: {
      id: { type: "integer", description: "主键" },
      note: { type: ["string", "null"] },
    },
    required: ["id"],
  });
  assert.deepEqual(
    rows,
    [
      { name: "id", type: "integer", required: true, description: "主键" },
      { name: "note", type: "string | null", required: false, description: "" },
    ],
  );
});
