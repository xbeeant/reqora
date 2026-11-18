/**
 * T3.2 · 单一数据契约护栏测试
 *
 * 三层防线（全部纯函数、零网络、毫秒级）：
 *   1. 生成物新鲜度：`src/lib/wireContract.gen.ts` 与 `docs/reqora-contract.v1.json`
 *      必须与从 Rust 源重新生成的结果字节一致 —— 手改生成物或改了 Rust 模型
 *      忘记跑 `bun run contract:gen` 都会在这里失败。
 *   2. 手写侧覆盖：Rust wire 模型的每个字段 / 枚举变体必须能在手写 TS 侧
 *      （src/types.ts + src/lib/wireSpec.ts）找到对应声明。新增字段漏改任一侧
 *      即构建失败 —— 这是「加一个字段要改三处」从人肉记忆变成 CI 门禁的一步。
 *   3. 解析器自检：源码结构变化导致解析器静默解析不到任何声明时，立即报警。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildContract, CONTRACT_OUTPUTS, TS_NAME_MAP } from "../scripts/generate-contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HANDWRITTEN_FILES = ["src/types.ts", "src/lib/wireSpec.ts"];

// ---------------------------------------------------------------------------
// 手写 TS 侧的最小解析（interface / type union）
// ---------------------------------------------------------------------------

function stripTsComments(src) {
  return src
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
      let inString = false;
      for (let i = 0; i < line.length - 1; i++) {
        const ch = line[i];
        if (ch === '"' || ch === "'" || ch === "`") inString = !inString;
        if (!inString && ch === "/" && line[i + 1] === "/") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** 解析 `export interface X extends Y { ... }`（花括号配对，支持嵌套）。 */
function parseInterfaces(src) {
  const out = new Map();
  const re = /export\s+interface\s+(\w+)(\s+extends\s+(\w+))?\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const [, name, , ext] = m;
    let depth = 0;
    let body = "";
    for (let i = re.lastIndex - 1; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
      if (depth > 0) body += ch;
    }
    out.set(name, { extends: ext ?? null, body });
  }
  return out;
}

/** interface 体的字段名集合（含 extends 链）。 */
function interfaceFields(interfaces, name, seen = new Set()) {
  const iface = interfaces.get(name);
  if (!iface) return seen;
  for (const m of iface.body.matchAll(/([A-Za-z_]\w*)\s*\??\s*:/g)) seen.add(m[1]);
  if (iface.extends) interfaceFields(interfaces, iface.extends, seen);
  return seen;
}

/** 解析 `export type X = A | B | {...}` union，返回每个成员的 tag 与字段集。 */
function parseUnion(src, name) {
  const start = src.match(new RegExp(`export\\s+type\\s+${name}\\s*=`));
  assert.ok(start, `手写 TS 侧缺少 export type ${name}`);
  let depth = 0;
  let end = start.index;
  for (let i = start.index; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{" || ch === "(") depth++;
    else if (ch === "}" || ch === ")") depth--;
    else if (depth === 0 && ch === ";") {
      end = i;
      break;
    }
  }
  const unionSrc = src.slice(start.index, end);
  const members = [];
  let cur = "";
  depth = 0;
  const parts = [];
  for (const ch of unionSrc) {
    if (ch === "{" || ch === "(") depth++;
    if (ch === "}" || ch === ")") depth--;
    if (depth === 0 && ch === "|") {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  for (const raw of parts) {
    const part = raw.replace(/\/\*[\s\S]*?\*\//g, " ").trim();
    if (!part || part.startsWith("export")) continue;
    if (part.startsWith("{")) {
      const tag = part.match(/type\s*:\s*"([^"]+)"/)?.[1] ?? null;
      const fields = new Set([...part.matchAll(/([A-Za-z_]\w*)\s*\??\s*:/g)].map((m) => m[1]));
      members.push({ tag, fields, inline: true });
    } else {
      const ident = part.match(/([A-Za-z_]\w*)/)?.[1];
      if (!ident) continue;
      const tag =
        interfaces.get(ident)?.body.match(/(?:^|[;{])\s*type\s*\??\s*:\s*"([^"]+)"/)?.[1] ?? null;
      members.push({ tag, fields: interfaceFields(interfaces, ident), inline: false, ident });
    }
  }
  return members;
}

const interfaces = (() => {
  const all = new Map();
  for (const file of HANDWRITTEN_FILES) {
    for (const [name, iface] of parseInterfaces(stripTsComments(readFileSync(join(ROOT, file), "utf8")))) {
      all.set(name, iface);
    }
  }
  return all;
})();

const unionSources = Object.fromEntries(
  HANDWRITTEN_FILES.map((file) => [file, stripTsComments(readFileSync(join(ROOT, file), "utf8"))]),
);

/** 解析手写侧的 tagged union（在哪个文件里找到就在哪个文件里解析）。 */
function findUnion(name) {
  for (const [, src] of Object.entries(unionSources)) {
    if (new RegExp(`export\\s+type\\s+${name}\\s*=`).test(src)) return parseUnion(src, name);
  }
  return null;
}

function tsNameFor(rustName) {
  return TS_NAME_MAP[rustName] ?? { file: "src/types.ts", name: rustName };
}

const contract = buildContract();

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

test("contract: 解析器自检 —— Rust 侧 14 个 wire 类型全部被识别", () => {
  const names = contract.decls.map((d) => d.name);
  for (const expected of [
    "Variables", "KeyValue", "FormPart", "BodySpec", "ApiKeyLocation", "AuthSpec",
    "RequestSpec", "ResponseHeader", "ResponsePayload", "BodySlice", "BodyLines",
    "BodyInfo", "RuntimeInfo", "ResponseTimings",
  ]) {
    assert.ok(names.includes(expected), `解析器丢失了 ${expected}（源码结构变化？）`);
  }
  assert.equal(names.length, 14, `期望 14 个声明，实际 ${names.length}：${names.join(", ")}`);
});

test("contract: 生成物与 Rust 源重新生成的结果字节一致", () => {
  for (const [rel, content] of [
    [CONTRACT_OUTPUTS.ts, contract.ts],
    [CONTRACT_OUTPUTS.schema, contract.schema],
  ]) {
    const current = readFileSync(join(ROOT, rel), "utf8");
    assert.equal(
      current,
      content,
      `${rel} 与重新生成结果不一致 —— 改了 Rust 模型后请运行 \`bun run contract:gen\`，不要手改生成物`,
    );
  }
});

test("contract: 每个 Rust struct 字段在手写 TS 接口中都有对应声明", () => {
  const structsWithTs = contract.decls.filter(
    (d) => d.kind === "struct" && interfaces.has(tsNameFor(d.name).name),
  );
  assert.ok(structsWithTs.length >= 10, `应至少覆盖 10 个有 TS 对应物的 struct，实际 ${structsWithTs.length}`);
  const problems = [];
  for (const decl of structsWithTs) {
    const mapped = tsNameFor(decl.name);
    const tsFields = interfaceFields(interfaces, mapped.name);
    for (const f of decl.fields) {
      if (!tsFields.has(f.wire)) {
        problems.push(`${decl.name}.${f.wire} 缺少于 ${mapped.file} 的 ${mapped.name}`);
      }
    }
  }
  assert.deepEqual(problems, [], [
    "Rust wire 字段在手写 TS 侧缺失（新增字段漏改另一侧）：",
    ...problems,
    "修复：在 types.ts / wireSpec.ts 补声明，或运行 bun run contract:gen 后核对语义。",
  ].join("\n"));
});

test("contract: 每个 tagged 枚举变体的 tag 与字段在手写 TS union 中都有对应", () => {
  const tagged = contract.decls.filter((d) => d.kind === "enum" && d.tagged);
  assert.equal(tagged.length, 2, "期望 BodySpec 与 AuthSpec 两个 tagged enum");
  for (const decl of tagged) {
    const members = findUnion(decl.name);
    assert.ok(members, `手写 TS 侧缺少 export type ${decl.name} union`);
    const problems = [];
    for (const variant of decl.variants) {
      const member = members.find((m) => m.tag === variant.wire);
      if (!member) {
        problems.push(`${decl.name} 变体 "${variant.wire}" 在手写 TS union 中缺失`);
        continue;
      }
      for (const f of variant.fields) {
        if (!member.fields.has(f.wire)) {
          problems.push(`${decl.name}::${variant.name} 字段 ${f.wire} 在 union 成员 ${member.ident ?? variant.wire} 中缺失`);
        }
      }
    }
    assert.deepEqual(problems, [], [
      `枚举 ${decl.name} 与手写 TS union 漂移：`,
      ...problems,
    ].join("\n"));
  }
});

test("contract: 简单枚举取值在手写 TS 中存在", () => {
  const simple = contract.decls.filter((d) => d.kind === "enum" && !d.tagged);
  const apiKeyMember = findUnion("AuthSpec")?.find((m) => m.tag === "apiKey");
  for (const decl of simple) {
    if (decl.name === "ApiKeyLocation") {
      // 手写侧没有独立的 ApiKeyLocation 类型，取值内联在 AuthSpec 的 apiKey 成员里
      assert.ok(apiKeyMember, "AuthSpec union 中缺少 apiKey 成员");
      const body = unionSources["src/types.ts"];
      for (const v of decl.variants) {
        assert.ok(
          new RegExp(`location\\s*:\\s*[^;]*"${v.wire}"`).test(body),
          `ApiKeyLocation 取值 "${v.wire}" 在手写 TS 中缺失`,
        );
      }
      continue;
    }
    assert.fail(`新增了未处理的简单枚举 ${decl.name}，请在此补对应断言`);
  }
});
