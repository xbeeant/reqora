/**
 * 供应链产物离线校验（node:test）。
 *
 * 只读取已生成的 sbom/ 产物与脚本 --help 输出，不发起任何网络请求，
 * 因此在无网络环境（例如 CI 上传产物后的离线校验步骤）也能通过。
 *
 * 复跑：node --test test/supplyChain.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SBOM_DIR = path.join(ROOT, "sbom");
const SCRIPT = path.join(ROOT, "scripts", "supply-chain.mjs");
const AUDIT_MD = path.join(SBOM_DIR, "dependency-audit.md");
const SUMMARY_MD = path.join(SBOM_DIR, "sbom-summary.md");

function findSbomFile() {
  const files = fs.existsSync(SBOM_DIR)
    ? fs.readdirSync(SBOM_DIR).filter((f) => f.endsWith(".cdx.json")).sort()
    : [];
  assert.ok(files.length > 0, "sbom/ 下应存在 reqora-<version>.cdx.json");
  return path.join(SBOM_DIR, files[files.length - 1]);
}

function readSbom() {
  return JSON.parse(fs.readFileSync(findSbomFile(), "utf8"));
}

test("生成的 SBOM 结构合法（CycloneDX 1.6）", () => {
  const bom = readSbom();
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(bom.specVersion, "1.6");
  assert.match(String(bom.serialNumber || ""), /^urn:uuid:/);
  assert.equal(typeof bom.version, "number");
  assert.ok(bom.metadata, "缺少 metadata");
  assert.ok(bom.metadata.timestamp, "缺少 metadata.timestamp");
  assert.ok(bom.metadata.tools, "缺少 metadata.tools");
  assert.ok(bom.metadata.component, "缺少 metadata.component");
  assert.equal(bom.metadata.component.type, "application");
  assert.ok(bom.metadata.component["bom-ref"], "缺少项目本体 bom-ref");
  assert.ok(bom.metadata.component.purl, "缺少项目本体 purl");
});

test("组件数量非零且 bom-ref 唯一", () => {
  const bom = readSbom();
  assert.ok(Array.isArray(bom.components), "components 必须是数组");
  assert.ok(bom.components.length > 0, "components 数量必须非零");
  const refs = bom.components.map((c) => c["bom-ref"]);
  assert.equal(new Set(refs).size, refs.length, "组件 bom-ref 必须唯一");
  assert.ok(!refs.includes(bom.metadata.component["bom-ref"]), "项目本体 bom-ref 不能与组件冲突");
  for (const c of bom.components) {
    for (const k of ["type", "name", "version", "purl", "bom-ref", "scope", "group"]) {
      assert.ok(c[k], `组件 ${c["bom-ref"]} 缺少字段 ${k}`);
    }
    assert.ok(["npm", "cargo", "maven"].includes(c.group), `未知生态 group: ${c.group}`);
  }
});

test("dependencies 引用完整，且存在项目本体 → 直接依赖关系", () => {
  const bom = readSbom();
  assert.ok(Array.isArray(bom.dependencies), "dependencies 必须是数组");
  const allRefs = new Set([
    ...bom.components.map((c) => c["bom-ref"]),
    bom.metadata.component["bom-ref"],
  ]);
  for (const d of bom.dependencies) {
    assert.ok(allRefs.has(d.ref), `dependencies[].ref 不存在: ${d.ref}`);
    for (const dep of d.dependsOn || []) {
      assert.ok(allRefs.has(dep), `dependsOn 引用的 ref 不存在: ${dep}`);
    }
  }
  const rootDep = bom.dependencies.find((d) => d.ref === bom.metadata.component["bom-ref"]);
  assert.ok(rootDep, "缺少项目本体的 dependencies 条目");
  assert.ok(rootDep.dependsOn && rootDep.dependsOn.length > 0, "项目本体 → 直接依赖关系不能为空");
});

test("dependency-audit.md 有明确结论且不含占位符", () => {
  assert.ok(fs.existsSync(AUDIT_MD), "缺少 sbom/dependency-audit.md");
  const md = fs.readFileSync(AUDIT_MD, "utf8");
  assert.ok(md.length > 200, "审计报告过短");
  assert.match(md, /工具不可用|无高危/, "报告需含「工具不可用」或「无高危」结论之一");
  const placeholder = /TODO|TBD|PLACEHOLDER|FIXME|待填写|待补充|\{\{[^}]*\}\}|<\s*(id|dir|version|name|value|insert|fill)\s*>/i;
  assert.ok(!placeholder.test(md), "审计报告不应含明显占位符");
});

test("sbom-summary.md 存在且含组件统计与复跑命令", () => {
  assert.ok(fs.existsSync(SUMMARY_MD), "缺少 sbom/sbom-summary.md");
  const md = fs.readFileSync(SUMMARY_MD, "utf8");
  assert.match(md, /组件统计/);
  assert.match(md, /node scripts\/supply-chain\.mjs/);
});

test("scripts/supply-chain.mjs --help 子进程可正常退出", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--help"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(r.error, undefined, `--help 启动失败: ${r.error?.message || ""}`);
  assert.equal(r.status, 0, `--help 应以 0 退出，实际 ${r.status}`);
  for (const flag of ["--ci", "--offline", "--out", "--help"]) {
    assert.ok(r.stdout.includes(flag), `--help 输出应包含 ${flag}`);
  }
});
