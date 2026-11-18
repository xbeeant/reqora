#!/usr/bin/env node
/**
 * T3.2 · 单一数据契约生成器（P2）
 *
 * 从 Rust 线模型（`reqora-core::models` + `service::timing::ResponseTimings`）
 * 生成两份确定性产物，提交进仓库：
 *   1. `src/lib/wireContract.gen.ts`  —— Rust serde wire 形状的 TS 镜像（参考快照）
 *   2. `docs/reqora-contract.v1.json` —— JSON Schema（draft 2020-12），供 agent /
 *      外部工具机器可读地消费同一份契约
 *
 * 设计约束：
 *   - 零第三方依赖：自带一个针对本项目 Rust 子集（pub struct / tagged enum /
 *     serde 常用属性）的最小解析器，不引入 ts-rs / schemars 等构建期依赖。
 *   - 忠实建模 serde 语义，尤其是**容器级 `rename_all` 只重命名枚举变体名，
 *     不作用于 struct 变体的字段**（serde-rs/serde#1615）。变体字段想用
 *     camelCase 必须显式 `rename`。曾经正是这个语义差导致 Raw body 的
 *     `contentType` 与 Binary 的 `fileName` 被 Rust 引擎静默丢弃——生成器按
 *     serde 真实行为命名，护栏测试（test/contractSync.test.mjs）据此把这类
 *     漂移挡在 CI 门口。
 *   - 输出确定性：不含时间戳 / 随机值，字段与变体按源码声明序排列，同一份
 *     源码反复生成字节一致。
 *
 * 用法：
 *   node scripts/generate-contract.mjs          # 生成 / 覆盖产物
 *   node scripts/generate-contract.mjs --check  # 只比对，漂移时退出码 1
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Rust wire 模型来源（相对仓库根）。ResponseTimings 单独从 timing.rs 摘取。 */
const RUST_SOURCES = [
  {
    file: "src-tauri/crates/reqora-core/src/models.rs",
    include: null, // 全部 pub 声明
  },
  {
    file: "src-tauri/crates/reqora-core/src/service/timing.rs",
    include: new Set(["ResponseTimings"]),
  },
];

/** 生成产物（相对仓库根）。 */
export const CONTRACT_OUTPUTS = {
  ts: "src/lib/wireContract.gen.ts",
  schema: "docs/reqora-contract.v1.json",
};

/** 契约名（schema `$id` 与 TS 文件头引用）。 */
export const CONTRACT_NAME = "reqora.wire.v1";

/**
 * Rust 类型 → 手写 TS 对应物的名字映射。手写侧可以改名（前端语义命名），
 * 护栏测试用它定位「这一侧必须覆盖 Rust 字段」的 TS 声明。
 */
export const TS_NAME_MAP = {
  // wireSpec.ts 的线类型是 RequestSpec 的唯一构造出口（wireSpec.ts::toWireSpec）
  RequestSpec: { file: "src/lib/wireSpec.ts", name: "WireSpec" },
  // 前端历史命名：Rust ResponsePayload 在 TS 侧叫 ResponseData
  ResponsePayload: { file: "src/types.ts", name: "ResponseData" },
};

// ---------------------------------------------------------------------------
// Rust 子集解析
// ---------------------------------------------------------------------------

/** 去掉测试模块与普通注释，保留 `///` 文档注释（会带进生成物）。 */
function stripNoise(src) {
  const cut = src.indexOf("#[cfg(test)]");
  if (cut >= 0) src = src.slice(0, cut);
  return src
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (t.startsWith("///") || t.startsWith("//!")) return line; // 保留文档
      if (t.startsWith("//")) return "";
      // 剥离代码行里引号外的 `//` 行注释（字符串内的 URL 不受影响）
      let inString = false;
      for (let i = 0; i < line.length - 1; i++) {
        const ch = line[i];
        if (ch === '"') inString = !inString;
        if (!inString && ch === "/" && line[i + 1] === "/") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** 按顶层分隔符切分，忽略尖括号 / 括号 / 花括号 / 字符串内的分隔符。 */
function splitTopLevel(body, sep = ",") {
  const parts = [];
  let cur = "";
  let depth = 0;
  let inString = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      cur += ch;
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      cur += ch;
      continue;
    }
    if ("<([{".includes(ch)) depth++;
    else if (">)]}".includes(ch)) depth--;
    if (depth === 0 && ch === sep) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const DOC_RE = /^\s*\/\/\/\s?(.*)$/;

/** 从一段声明文本里拆出文档行 / 属性 / 剩余代码。 */
function peelPart(part) {
  const doc = [];
  const attrs = [];
  const codeLines = [];
  for (const line of part.split("\n")) {
    const d = line.match(DOC_RE);
    if (d) doc.push(d[1].trim());
    else codeLines.push(line);
  }
  let rest = codeLines.join("\n");
  const attrMatches = rest.match(/#\[[^\]]*\]/g) ?? [];
  for (const a of attrMatches) attrs.push(a);
  rest = rest.replace(/#\[[^\]]*\]/g, " ").trim();
  return { doc, attrs, rest };
}

/** 解析 serde 属性内容（`#[serde(...)]` 括号内文本）。 */
function parseSerde(inner) {
  const out = { rename: null, renameAll: null, tag: null, hasDefault: false, skipIf: false };
  for (const item of splitTopLevel(inner)) {
    const m = item.match(/^(\w+)\s*(?:=\s*"([^"]*)")?\s*$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "rename") out.rename = value;
    else if (key === "rename_all") out.renameAll = value;
    else if (key === "tag") out.tag = value;
    else if (key === "default") out.hasDefault = true;
    else if (key === "skip_serializing_if") out.skipIf = true;
  }
  return out;
}

/** 收集一段属性里所有 serde(...) 与 #[default] 标记。 */
function collectAttrs(attrs) {
  const serde = { rename: null, renameAll: null, tag: null, hasDefault: false, skipIf: false };
  let isDefault = false;
  for (const a of attrs) {
    const s = a.match(/^#\[\s*serde\s*\(([\s\S]*)\)\s*\]$/);
    if (s) {
      const parsed = parseSerde(s[1]);
      serde.rename = parsed.rename ?? serde.rename;
      serde.renameAll = parsed.renameAll ?? serde.renameAll;
      serde.tag = parsed.tag ?? serde.tag;
      serde.hasDefault = serde.hasDefault || parsed.hasDefault;
      serde.skipIf = serde.skipIf || parsed.skipIf;
    }
    if (/^#\[\s*default\s*\]$/.test(a)) isDefault = true;
  }
  return { serde, isDefault };
}

/** serde `rename_all`：枚举容器只作用于**变体名**；变体字段需显式 rename。 */
function variantWireName(name, serde, enumRenameAll) {
  if (serde.rename) return serde.rename;
  if (
    (serde.renameAll === "camelCase" || serde.renameAll === "lowerCamelCase") ||
    (enumRenameAll === "camelCase" || enumRenameAll === "lowerCamelCase")
  ) {
    return name.charAt(0).toLowerCase() + name.slice(1);
  }
  return name;
}

const snakeToCamel = (s) => s.replace(/_([a-zA-Z0-9])/g, (_, c) => c.toUpperCase());

function fieldWireName(raw, serde) {
  if (serde.rename) return serde.rename;
  // serde 默认字段名就是源码名；enum 变体字段不继承容器 rename_all（#1615），
  // 只有 struct 容器上的 rename_all = "camelCase" 才会转成 camelCase。
  if (serde.renameAll === "camelCase") return snakeToCamel(raw);
  return raw;
}

/** Rust 类型表达式 → { ts, opt }（仅覆盖本项目用到的子集）。 */
function rustTypeToTs(type) {
  const t = type.trim();
  const optM = t.match(/^Option\s*<\s*([\s\S]+?)\s*>$/);
  if (optM) return { ts: rustTypeToTs(optM[1]).ts, opt: true };
  const mapM = t.match(/^(?:BTreeMap|HashMap)\s*<\s*([^,<>]+?)\s*,\s*([\s\S]+?)\s*>$/);
  if (mapM) return { ts: `Record<${rustTypeToTs(mapM[1]).ts}, ${rustTypeToTs(mapM[2]).ts}>`, opt: false };
  const vecM = t.match(/^(?:Vec|Array)\s*<\s*([\s\S]+?)\s*>$/);
  if (vecM) return { ts: `${rustTypeToTs(vecM[1]).ts}[]`, opt: false };
  const prim = {
    String: "string",
    "&'static str": "string",
    "&str": "string",
    bool: "boolean",
    u8: "number", u16: "number", u32: "number", u64: "number", usize: "number",
    i8: "number", i16: "number", i32: "number", i64: "number", isize: "number",
    f32: "number", f64: "number",
  }[t];
  return { ts: prim ?? t, opt: false };
}

/** 解析一个字段（struct 字段或 enum struct 变体的字段）。 */
function parseField(part, containerRenameAll) {
  const { doc, attrs, rest } = peelPart(part);
  if (!rest) return null;
  const m = rest.match(/^(?:(?:pub|pub\(crate\))\s+)?([a-z_][a-z0-9_]*)\s*:\s*([\s\S]+)$/);
  if (!m) return null;
  const [, raw, type] = m;
  const { serde } = collectAttrs(attrs);
  // 字段继承容器 rename_all 的场景只有 struct 容器（enum 变体字段不继承，#1615）
  const effective = { ...serde };
  if (!effective.rename && !effective.renameAll && containerRenameAll === "camelCase" && containerIsStruct) {
    effective.renameAll = "camelCase";
  }
  const wire = fieldWireName(raw, effective);
  const { ts, opt } = rustTypeToTs(type);
  return {
    raw,
    wire,
    ts,
    optional: opt || serde.hasDefault,
    doc: doc.join(" "),
  };
}

// containerIsStruct 由调用侧注入（模块级变量仅限本解析器内部使用）
let containerIsStruct = false;

/**
 * 把顶层切分前先保护文档注释：文档里的逗号 / 花括号不应参与切分。
 * 返回替换后的文本与还原函数。
 */
function protectDocs(text) {
  const docs = [];
  const replaced = text
    .split("\n")
    .map((line) => {
      const d = line.match(DOC_RE);
      if (!d) return line;
      docs.push(d[1].trim());
      return `\u0000${docs.length - 1}\u0000`;
    })
    .join("\n");
  return {
    text: replaced,
    restore(part) {
      return part.replace(/\u0000(\d+)\u0000/g, (_, i) => `/// ${docs[Number(i)]}`);
    },
  };
}

function parseStructBody(body, renameAll) {
  containerIsStruct = true;
  const { text, restore } = protectDocs(body);
  const fields = splitTopLevel(text)
    .map((p) => parseField(restore(p), renameAll))
    .filter(Boolean);
  containerIsStruct = false;
  return fields;
}

function parseVariant(part, enumRenameAll) {
  const { text, restore } = protectDocs(part);
  const codeLines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const rest = codeLines.join(" ").trim();
  if (!rest) return null;
  // 只取变体名**之前**的属性；字段属性在花括号内，交给 parseField 处理。
  const m = rest.match(/^((?:#\[[^\]]*\]\s*)*)(\w+)\s*(?:\{([\s\S]*)\})?\s*$/);
  if (!m) return null;
  const [, attrText, name, innerRaw] = m;
  const { serde, isDefault } = collectAttrs(attrText.match(/#\[[^\]]*\]/g) ?? []);
  const wire = variantWireName(name, serde, enumRenameAll);
  const inner = innerRaw ? restore(innerRaw) : null;
  // 关键：enum 变体的字段不继承容器 rename_all（serde#1615）
  containerIsStruct = false;
  const fields = inner ? splitTopLevel(inner).map((p) => parseField(p, null)).filter(Boolean) : [];
  const docLines = codeLines
    .filter((l) => l.startsWith("\u0000"))
    .map((l) => restore(l).replace(/^\/\/\/\s?/, ""));
  return { name, wire, unit: !inner, fields, doc: docLines.join(" "), isDefault };
}

/** 提取单份 Rust 源里的 pub 声明。 */
function parseRustSource(src) {
  const text = stripNoise(src);
  const lines = text.split("\n");
  const decls = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*pub\s+(struct|enum|type)\s+(\w+)/);
    if (!m) continue;
    const [, kind, name] = m;
    // 向上收集紧邻的属性 / 文档块（遇到代码行即停）
    const doc = [];
    let attrsText = "";
    for (let j = i - 1; j >= 0; j--) {
      const t = lines[j].trim();
      if (!t) continue;
      if (t.startsWith("///")) doc.unshift(t.replace(/^\/\/\/\s?/, "").trim());
      else if (t.startsWith("#[")) attrsText = lines[j] + "\n" + attrsText;
      else break;
    }
    const { serde, isDefault } = collectAttrs(attrsText.match(/#\[[^\]]*\]/g) ?? []);
    if (kind === "type") {
      const rhs = lines[i].match(/^.*?=\s*([^;]+);/);
      decls.push({ kind, name, doc, serde, aliasTs: rhs ? rustTypeToTs(rhs[1]).ts : name });
      continue;
    }
    // 找到声明体 `{` 并做行级花括号配对（跳过文档行）
    let depth = 0;
    let body = "";
    let opened = false;
    for (let j = i; j < lines.length; j++) {
      if (lines[j].trim().startsWith("///")) continue;
      for (const ch of lines[j]) {
        if (ch === "{") {
          depth++;
          opened = true;
          if (depth === 1) continue; // 吃掉开括号本身
        } else if (ch === "}") {
          depth--;
          if (depth === 0 && opened) { opened = false; break; }
          if (depth < 0) break;
        }
        if (opened) body += ch;
      }
      if (!opened) break;
      body += "\n";
    }
    if (kind === "struct") {
      decls.push({ kind, name, doc, serde, fields: parseStructBody(body, serde.renameAll) });
    } else {
      const { text: protectedBody, restore: restoreBody } = protectDocs(body);
      const variants = splitTopLevel(protectedBody)
        .map((p) => parseVariant(restoreBody(p), serde.renameAll))
        .filter(Boolean);
      decls.push({
        kind,
        name,
        doc,
        serde,
        variants,
        tagged: Boolean(serde.tag),
      });
    }
  }
  return decls;
}

// ---------------------------------------------------------------------------
// 产物生成
// ---------------------------------------------------------------------------

function renderTs(decls) {
  const out = [];
  out.push("/**");
  out.push(` * GENERATED FILE — DO NOT EDIT BY HAND · ${CONTRACT_NAME}`);
  out.push(" *");
  out.push(" * Rust serde wire 契约的 TS 镜像，由 `scripts/generate-contract.mjs` 从");
  out.push(" *   src-tauri/crates/reqora-core/src/models.rs");
  out.push(" *   src-tauri/crates/reqora-core/src/service/timing.rs");
  out.push(" * 生成。字段 / 变体名严格按 serde 真实线上行为命名（含 struct 变体字段");
  out.push(" * 必须显式 rename 的 serde#1615 语义）。");
  out.push(" *");
  out.push(" * 重新生成：`bun run contract:gen`　校验漂移：`bun run contract:check`");
  out.push(" * 手写侧的覆盖护栏：`test/contractSync.test.mjs`");
  out.push(" */");
  out.push("");
  for (const d of decls) {
    if (d.doc.length) out.push(`/** ${d.doc.join(" ")} */`);
    if (d.kind === "type") {
      out.push(`export type ${d.name} = ${d.aliasTs};`);
      out.push("");
      continue;
    }
    if (d.kind === "struct") {
      out.push(`export interface ${d.name} {`);
      for (const f of d.fields) {
        if (f.doc) out.push(`  /** ${f.doc} */`);
        out.push(`  ${f.wire}${f.optional ? "?" : ""}: ${f.ts};`);
      }
      out.push("}");
      out.push("");
      continue;
    }
    // enum
    if (!d.tagged) {
      const values = d.variants.map((v) => `"${v.wire}"`).join(" | ");
      out.push(`export type ${d.name} = ${values};`);
      out.push("");
      continue;
    }
    const tag = d.serde.tag;
    out.push(`export type ${d.name} =`);
    d.variants.forEach((v, idx) => {
      const prefix = idx === 0 ? "  " : "  | ";
      if (v.doc) out.push(`  /** ${v.doc} */`);
      if (v.unit) {
        out.push(`${prefix}{ ${tag}: "${v.wire}" }`);
      } else {
        const body = [` ${tag}: "${v.wire}";`, ...v.fields.map((f) => ` ${f.wire}${f.optional ? "?" : ""}: ${f.ts};`)].join("");
        out.push(`${prefix}{${body} }`);
      }
    });
    out.push("  ;");
    out.push("");
  }
  return out.join("\n");
}

function schemaForType(d, declByName) {
  const ref = (name) => ({ $ref: `#/$defs/${name}` });
  if (d.kind === "type") {
    const m = d.aliasTs.match(/^Record<\s*(\w+)\s*,\s*(\w+)\s*>$/);
    if (m) return { type: "object", additionalProperties: { type: m[2] === "string" ? "string" : {} } };
    return {};
  }
  if (d.kind === "struct") {
    const properties = {};
    const required = [];
    for (const f of d.fields) {
      const prop = scalarSchema(f.ts, declByName, ref);
      if (f.doc) prop.description = f.doc;
      properties[f.wire] = prop;
      if (!f.optional) required.push(f.wire);
    }
    const schema = { type: "object", properties };
    if (required.length) schema.required = required;
    return schema;
  }
  // enum
  if (!d.tagged) {
    return { type: "string", enum: d.variants.map((v) => v.wire) };
  }
  const tag = d.serde.tag;
  return {
    anyOf: d.variants.map((v) => {
      const properties = { [tag]: { const: v.wire } };
      const required = [tag];
      for (const f of v.fields) {
        const prop = scalarSchema(f.ts, declByName, ref);
        if (f.doc) prop.description = f.doc;
        properties[f.wire] = prop;
        if (!f.optional) required.push(f.wire);
      }
      const variant = { type: "object", properties };
      if (required.length) variant.required = required;
      return variant;
    }),
  };
}

function scalarSchema(ts, declByName, ref) {
  if (ts === "string") return { type: "string" };
  if (ts === "boolean") return { type: "boolean" };
  if (ts === "number") return { type: "number" };
  if (ts.endsWith("[]")) {
    return { type: "array", items: scalarSchema(ts.slice(0, -2), declByName, ref) };
  }
  const rec = ts.match(/^Record<\s*(\w+)\s*,\s*(\w+)\s*>$/);
  if (rec) {
    return { type: "object", additionalProperties: scalarSchema(rec[2], declByName, ref) };
  }
  if (declByName.has(ts)) return { ...ref(ts) };
  return {}; // 未知引用：留空，不编造
}

function renderSchema(decls) {
  const declByName = new Map(decls.map((d) => [d.name, d]));
  const defs = {};
  for (const d of decls) {
    const s = schemaForType(d, declByName);
    if (d.doc.length) s.description = d.doc.join(" ");
    defs[d.name] = s;
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://reqora.dev/schemas/${CONTRACT_NAME}.json`,
    title: CONTRACT_NAME,
    description:
      "Reqora Rust 引擎 wire DTO 契约（由 scripts/generate-contract.mjs 从 reqora-core 源码生成）。字段命名严格遵循 serde 真实行为。",
    $defs: defs,
  };
}

/** 生成两份产物的完整文本。 */
export function buildContract() {
  const decls = [];
  for (const source of RUST_SOURCES) {
    const src = readFileSync(join(ROOT, source.file), "utf8");
    let parsed = parseRustSource(src);
    if (source.include) parsed = parsed.filter((d) => source.include.has(d.name));
    decls.push(...parsed);
  }
  const names = decls.map((d) => d.name);
  if (new Set(names).size !== names.length) {
    throw new Error("duplicate type name across sources");
  }
  return {
    decls,
    ts: renderTs(decls) + "\n",
    schema: JSON.stringify(renderSchema(decls), null, 2) + "\n",
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function firstDiff(a, b) {
  const al = a.split("\n");
  const bl = b.split("\n");
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) return i + 1;
  }
  return -1;
}

function main() {
  const check = process.argv.includes("--check");
  const contract = buildContract();
  const targets = [
    [CONTRACT_OUTPUTS.ts, contract.ts],
    [CONTRACT_OUTPUTS.schema, contract.schema],
  ];
  // 生成器以 LF 落盘；Windows / autocrlf 环境下工作区文件可能被 checkout 成 CRLF。
  // 契约比对的是内容，行尾风格交给 git，不作为漂移（与护栏测试保持一致）。
  const normalizeEol = (text) => (text === null ? null : text.replace(/\r\n/g, "\n"));
  let drifted = false;
  for (const [rel, content] of targets) {
    const abs = join(ROOT, rel);
    let current = null;
    try {
      current = readFileSync(abs, "utf8");
    } catch {
      /* 不存在视为漂移 */
    }
    if (normalizeEol(current) === normalizeEol(content)) {
      console.log(`ok   ${rel}`);
      continue;
    }
    drifted = true;
    if (check) {
      const line = current === null ? "-" : firstDiff(normalizeEol(current), normalizeEol(content));
      console.error(`drift ${rel}${line > 0 ? ` (first diff at line ${line})` : " (missing)"}`);
    } else {
      writeFileSync(abs, content);
      console.log(`wrote ${rel}`);
    }
  }
  if (check && drifted) {
    console.error("\n契约产物与 Rust 源不一致。运行 `bun run contract:gen` 重新生成，");
    console.error("并按护栏测试提示同步手写 TS 侧（types.ts / wireSpec.ts）。");
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) main();
