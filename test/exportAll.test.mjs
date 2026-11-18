/**
 * T2.6 · `reqora export --all` 一键全量可退出包。
 *
 * 用最小夹具跑一次 CLI（子进程，--out <tmpdir> --no-evidence），断言：
 * MANIFEST 的 sha256 / bytes 与实际文件一致、连续两次生成内容一致、
 * 包内不含明文私密值、未带走资产被显式列出、Bruno 清单展开成真实目录、
 * 测试资产与环境变量名清单落到 assets/、全部格式各导出一份。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { EXPORT_FORMATS } from "../src/lib/exportFormats.ts";
import { rmTemp } from "../scripts/rm-temp.mjs";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = join(REPO, "bin", "reqora.mjs");
const SECRET = "sk-live-canaryA1b2c3d4e5f6g7h8";

const row = (id, key, value, extra = {}) => ({ id, key, value, enabled: true, ...extra });

/** 最小但完整、全字段带稳定 id 的快照：normalizeSnapshot 不会补随机 uid。 */
function snapshot() {
  return {
    version: 1, seeded: false,
    collections: [{
      id: "col1", name: "订单服务", folders: ["用户/archive"],
      items: [{
        id: "r1", name: "创建订单", method: "POST", url: "{{baseUrl}}/v1/orders",
        folder: "用户/详情",
        headers: [
          row("h1", "Accept", "application/json"),
          row("h2", "Authorization", `Bearer ${SECRET}`, { secret: true }),
        ],
        query: [],
        body: { type: "json", content: '{"password":"{{password}}"}' },
        auth: { type: "bearer", token: SECRET },
        // 脚本里嵌明文凭据，必须被两道脱敏闸门清掉。
        preScript: `setHeader('X-T', '{{token}}');\nconst leak = '${SECRET}';`,
        postScript: "log('done');",
        assertions: [{ id: "a1", enabled: true, name: "状态", source: "status", path: "", op: "eq", value: "200" }],
        doc: { summary: "下单", description: "", owner: "", status: "", tags: [], paramMeta: {}, responses: [], updatedAt: 1 },
      }],
    }],
    environments: [{
      id: "env1", name: "本地",
      variables: [
        row("v1", "baseUrl", "https://api.example.com"),
        row("v2", "token", SECRET, { secret: true }),
      ],
    }],
    activeEnvironmentId: "env1",
    history: [], trash: [], cases: [], scenarios: [], suites: [], scriptLibrary: [],
    settings: { timeoutSecs: 30, followRedirects: true, verifyTls: true },
  };
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** 递归收集目录下所有文件（相对路径 → Buffer），顺序稳定。 */
function collectFiles(dir, prefix = "") {
  const out = new Map();
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (st.isDirectory()) {
      for (const [key, value] of collectFiles(full, rel)) out.set(key, value);
    } else if (st.isFile()) {
      out.set(rel, readFileSync(full));
    }
  }
  return out;
}

// ---------------------------------------------------------------- 夹具 ----

const root = mkdtempSync(join(tmpdir(), "reqora-exportall-"));
const wsDir = join(root, "ws");
const out1 = join(root, "out1");
const out2 = join(root, "out2");
mkdirSync(wsDir, { recursive: true });
writeFileSync(join(wsDir, "workspace.json"), JSON.stringify(snapshot()), "utf8");

function runExport(out, extra = []) {
  return spawnSync(process.execPath, [CLI, "export", "--all",
    "--workspace", wsDir, "--out", out, "--no-evidence", ...extra],
  { encoding: "utf8", cwd: REPO, timeout: 120_000 });
}

const run1 = runExport(out1);
const run2 = runExport(out2);

after(() => rmTemp(root));

const manifest = existsSync(join(out1, "MANIFEST.json"))
  ? JSON.parse(readFileSync(join(out1, "MANIFEST.json"), "utf8"))
  : null;
const allFiles = existsSync(out1) ? collectFiles(out1) : new Map();

// ---------------------------------------------------------------- 测试 ----

test("CLI 以 --out 跑通并写出 MANIFEST.json", () => {
  assert.equal(run1.status, 0, `第一次导出失败：${run1.stderr || run1.stdout}`);
  assert.equal(run2.status, 0, `第二次导出失败：${run2.stderr || run2.stdout}`);
  assert.match(run1.stdout, /导出包已写入/);
  assert.match(run1.stdout, /格式 20\/21 · 文件 27 个/);
  assert.match(run1.stdout, /跳过的格式：docsite-encrypted/);
  assert.ok(manifest, "应写出 MANIFEST.json");
  assert.equal(manifest.schema, "reqora.export.v1");
  assert.equal(manifest.generated_from, "Reqora");
  assert.equal(manifest.readable_without_reqora, true);
  assert.match(manifest.note, /本包可在没装 Reqora 的机器上阅读/);
  assert.equal(manifest.deterministic, true);
  assert.equal(manifest.evidence_included, false, "--no-evidence 应生效");
  assert.equal(manifest.timestamp_policy, "deterministic-by-default");
});

test("MANIFEST 的每个文件：相对路径 / 格式 id / 字节数 / sha256 与实际一致", () => {
  assert.ok(manifest.files.length > 0, "files 不能为空");
  assert.ok(manifest.files.every((f) => typeof f.path === "string" && typeof f.format === "string"));
  for (const file of manifest.files) {
    const full = join(out1, file.path);
    assert.ok(existsSync(full), `MANIFEST 列出的文件不存在：${file.path}`);
    const buffer = readFileSync(full);
    assert.equal(buffer.length, file.bytes, `字节数不匹配：${file.path}`);
    assert.equal(sha256(buffer), file.sha256, `sha256 不匹配：${file.path}`);
  }
  // 文件顺序稳定（写盘顺序可复现）。
  const paths = manifest.files.map((f) => f.path);
  assert.deepEqual(paths, [...paths].sort(), "files 应按相对路径排序");
});

test("连续两次生成内容一致（默认确定性，含 MANIFEST 无时间戳差异）", () => {
  const a = collectFiles(out1);
  const b = collectFiles(out2);
  assert.deepEqual([...a.keys()], [...b.keys()], "两次生成的文件清单应一致");
  for (const [rel, bufA] of a) {
    assert.ok(b.has(rel), `第二次生成缺少 ${rel}`);
    assert.deepEqual(bufA, b.get(rel), `两次生成内容不一致：${rel}`);
  }
  // 显式确认 docsite HTML 里没有时间戳被写进内容。
  const docsite = a.get("exports/reqora-api-docs.html");
  assert.ok(docsite, "应有未加密文档站导出");
  assert.ok(docsite.toString("utf8").includes("确定性导出·未写时间戳"),
    "docsite 时间戳应被归一化，而不是写入实际时间");
  assert.ok(manifest.warnings.some((line) => line.includes("时间戳已归一化")),
    "归一化行为应在 MANIFEST.warnings 里显式声明");
});

test("包内所有文件都不含明文私密值", () => {
  assert.ok(allFiles.size > 0);
  for (const [rel, buffer] of allFiles) {
    const text = buffer.toString("utf8");
    assert.ok(!text.includes(SECRET), `包内文件含明文私密值：${rel}`);
    assert.ok(!text.includes(`Bearer ${SECRET}`), `包内文件含 Bearer 凭据：${rel}`);
  }
  // 私密变量只带名字，值不进包。
  const names = readFileSync(join(out1, "assets/environment-variable-names.txt"), "utf8");
  assert.ok(names.includes("baseUrl") && names.includes("token"));
  assert.ok(!names.includes(SECRET), "环境变量名清单不得含值");
  assert.ok(!names.includes("https://api.example.com"), "环境变量值不得出现在名单里");
});

test("未带走的资产被 MANIFEST 显式列出", () => {
  assert.ok(Array.isArray(manifest.not_included) && manifest.not_included.length > 0);
  const joined = manifest.not_included.map((item) => `${item.asset} ${item.reason ?? ""}`).join("\n");
  for (const keyword of [
    "请求历史", "回收站", "本机凭据", "私密变量值", "同步基线", "OS keychain 主密钥", "运行历史",
  ]) {
    assert.ok(joined.includes(keyword), `not_included 缺少：${keyword}`);
  }
  assert.ok(manifest.not_included.every((item) => typeof item.asset === "string" && typeof item.reason === "string"),
    "每项未带走资产都应给出名称与原因");
});

test("EXPORT_FORMATS 全部格式各导出一份，加密格式显式跳过", () => {
  for (const spec of EXPORT_FORMATS) {
    if (spec.encrypted) continue;
    assert.ok(existsSync(join(out1, "exports", spec.fileName)), `缺少格式导出：${spec.id} (${spec.fileName})`);
  }
  assert.equal(manifest.formats.length, EXPORT_FORMATS.length, "formats 应覆盖注册表全部格式");
  assert.ok(manifest.formats.every((item) => typeof item.id === "string" && typeof item.family === "string"));
  assert.ok(manifest.skipped_formats.some((item) => item.id === "docsite-encrypted"));
  assert.match(manifest.skipped_formats.find((item) => item.id === "docsite-encrypted").reason,
    /不可确定性复现|无法确定性复现/);
});

test("测试资产 / 环境变量名清单 / Bruno 目录都落到预期位置", () => {
  // T2.1 测试资产同时落 exports/ 与 assets/。
  assert.ok(existsSync(join(out1, "assets/reqora.test.v1.yaml")));
  const assets = readFileSync(join(out1, "assets/reqora.test.v1.yaml"), "utf8");
  assert.match(assets, /^schema: "reqora\.test\.v1"/m);
  assert.ok(!assets.includes(SECRET));
  assert.deepEqual(
    readFileSync(join(out1, "assets/reqora.test.v1.yaml"), "utf8"),
    readFileSync(join(out1, "exports/reqora.test.v1.yaml"), "utf8"),
    "assets/ 与 exports/ 的测试资产应字节一致",
  );
  assert.ok(existsSync(join(out1, "assets/environment-variable-names.txt")),
    "环境变量名清单应单独成文件");

  // Bruno 清单展开成 exports/bruno/ 真实目录，而不是只留一个 JSON 清单。
  assert.ok(existsSync(join(out1, "exports/bruno/bruno.json")));
  assert.ok(existsSync(join(out1, "exports/bruno/WARNINGS.md")));
  const bruFiles = [...allFiles.keys()].filter((rel) => rel.startsWith("exports/bruno/") && rel.endsWith(".bru"));
  assert.ok(bruFiles.length > 0, "应展开出 .bru 文件");
  assert.ok(bruFiles.some((rel) => rel.includes("folder.bru")), "应展开出 folder.bru");
  const firstBru = readFileSync(join(out1, bruFiles.find((rel) => !rel.endsWith("folder.bru"))), "utf8");
  assert.ok(firstBru.includes("meta {") && firstBru.includes("headers {"),
    "展开后的 .bru 内容应是真实块文本，不是 JSON 清单片段");
  // 清单原文仍保留在 exports/ 供核对。
  const brunoManifest = JSON.parse(readFileSync(join(out1, "exports/reqora-bruno.json"), "utf8"));
  assert.equal(brunoManifest.schema, "reqora.bruno.v1");
});

test("--no-timestamp 只是显式声明，输出仍完全确定性", () => {
  const out3 = join(root, "out3");
  const run3 = runExport(out3, ["--no-timestamp"]);
  assert.equal(run3.status, 0, run3.stderr || run3.stdout);
  const m3 = JSON.parse(readFileSync(join(out3, "MANIFEST.json"), "utf8"));
  assert.equal(m3.timestamp_policy, "explicit-no-timestamp");
  assert.equal(m3.deterministic, true);
  const a = collectFiles(out1);
  const c = collectFiles(out3);
  assert.deepEqual([...a.keys()], [...c.keys()]);
  // MANIFEST 里只有 policy 字段不同，files 段（含 sha256）应完全一致。
  assert.deepEqual(m3.files, manifest.files, "--no-timestamp 不应改变文件内容与 sha256");
});
