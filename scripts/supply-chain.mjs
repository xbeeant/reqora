#!/usr/bin/env node
/**
 * Reqora 供应链审计 + CycloneDX 1.6 SBOM 生成器（零第三方依赖，Node >= 22）。
 *
 *   依赖清单采集（离线可完成）：npm 安装树 / Cargo.lock / Gradle 声明与离线解析树
 *   依赖审计（联网，全部留痕）：npm audit / bun audit / OSV / cargo audit
 *   产物：sbom/reqora-<version>.cdx.json、dependency-audit.md、sbom-summary.md
 *
 * 用法：node scripts/supply-chain.mjs [--ci] [--offline] [--out <dir>] [--help]
 *
 * 约束：不在仓库内生成 package-lock.json；不修改 .npmrc；不读取任何含密钥的文件；
 *       生成物只含仓库相对路径，不含 token / 密码。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NPM_REGISTRY = "https://registry.npmjs.org";
const OSV_QUERYBATCH = "https://api.osv.dev/v1/querybatch";
const OSV_VULN = "https://api.osv.dev/v1/vulns";
const TOOL_NAME = "reqora-supply-chain";
const TOOL_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function shellQuote(s) {
  if (process.platform !== "win32") return String(s);
  const v = String(s);
  return /[\s&|<>^"']/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}

/**
 * 同步执行外部命令并留痕。Windows 下需要 shell:true 才能解析 npm.cmd / gradlew.bat；
 * Linux/macOS 直接 exec，避免无谓的 shell 注入面。命令参数均为本脚本内的常量或
 * 由 os.tmpdir() 生成的路径，不接受任意用户输入拼进命令行。
 */
function run(cmd, args, opts = {}) {
  const {
    cwd = ROOT,
    timeout = 120000,
    maxBuffer = 20 * 1024 * 1024,
    env,
  } = opts;
  const useShell = process.platform === "win32";
  const argv = useShell ? args.map(shellQuote) : args;
  const started = Date.now();
  let r;
  try {
    r = spawnSync(cmd, argv, {
      cwd,
      encoding: "utf8",
      shell: useShell,
      windowsHide: true,
      timeout,
      maxBuffer,
      env: env || process.env,
    });
  } catch (e) {
    return {
      command: [cmd, ...args].join(" "),
      exitCode: null,
      signal: null,
      error: e.message,
      stdout: "",
      stderr: "",
      durationMs: Date.now() - started,
    };
  }
  return {
    command: [cmd, ...args].join(" "),
    exitCode: r.status,
    signal: r.signal,
    error: r.error ? r.error.message : null,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    durationMs: Date.now() - started,
  };
}

function firstLine(s) {
  return String(s || "").split(/\r?\n/).find((l) => l.trim())?.trim() || "";
}

function toolVersion(cmd, args = ["--version"], opts = {}) {
  const r = run(cmd, args, { timeout: 15000, ...opts });
  if (r.exitCode === 0) return firstLine(r.stdout) || firstLine(r.stderr) || "unknown";
  return "不可用";
}

async function fetchJson(url, options = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await resp.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON 响应，保留 text 供留痕 */
    }
    return { ok: resp.ok, status: resp.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function purlValue(v) {
  return String(v).replace(/\+/g, "%2B").replace(/ /g, "%20");
}

function purlNpm(name, version) {
  return `pkg:npm/${name}@${purlValue(version)}`;
}
function purlCargo(name, version) {
  return `pkg:cargo/${name}@${purlValue(version)}`;
}
function purlMaven(group, artifact, version) {
  return `pkg:maven/${group}/${artifact}@${purlValue(version)}`;
}

function parseNameVersion(s) {
  // "@scope/name@1.2.3" / "name@1.2.3" / "name@1.2.3(peer@x)"
  const clean = String(s).replace(/\(.*$/, "").trim();
  const i = clean.lastIndexOf("@");
  if (i <= 0) return null;
  const name = clean.slice(0, i);
  const version = clean.slice(i + 1);
  if (!name || !version || !/^[0-9]/.test(version)) return null;
  return { name, version };
}

function mdCell(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/**
 * 产物不得暴露生成者的用户目录（工具 stderr 常带绝对路径）。
 * 当前用户目录及其他账户的 home 路径统一替换为 ~。
 */
function redactHome(value) {
  let text = String(value ?? "");
  const home = os.homedir().replace(/[\\/]+$/, "");
  if (home) {
    const escaped = home
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\\\\/g, "[\\\\/]");
    text = text.replace(new RegExp(escaped, "g"), "~");
  }
  // 工具输出可能来自其他账户（sudo / CI runner 等），同样脱敏。
  text = text.replace(/(?:\/Users|\/home)\/[^/\s"'`,;)]+/g, "~");
  text = text.replace(/[A-Za-z]:\\Users\\[^\\\s"'`,;)]+/gi, "~");
  return text;
}

function writeText(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, redactHome(content), { encoding: "utf8" });
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function licenseEntry(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  return { expression: s };
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const HELP = `Reqora 供应链审计 + CycloneDX 1.6 SBOM 生成器（零第三方依赖）

用法:
  node scripts/supply-chain.mjs [选项]

选项:
  --ci         CI 模式：发现可靠来源的 high/critical 漏洞时以非零码退出；
               若联网审计工具全部不可用（审计不完整）同样以非零码退出。
  --offline    跳过所有需要联网的审计步骤（npm audit 的临时 lock 生成、OSV、
               bun audit），并在报告中明确标注「未执行」。依赖清单采集仍照常进行。
  --out <dir>  产物输出目录（默认 sbom，相对仓库根；也接受绝对路径）。
  --help, -h   显示本帮助并以 0 退出。

产物（写入 --out 目录）:
  reqora-<version>.cdx.json   CycloneDX 1.6 JSON SBOM
  dependency-audit.md         人类可读审计报告
  sbom-summary.md             组件统计与复跑命令

说明:
  npm audit 会在系统临时目录里生成一次性 package-lock.json 后执行，绝不在仓库内
  写入 lockfile。.npmrc 指向 npmmirror，故用 --registry 显式指向官方源；bun audit
  对该镜像的 bulk advisory 端点返回 404 属已知情况，会被如实记录为「工具不可用」。
`;

function parseArgs(argv) {
  const opts = { ci: false, offline: false, out: "sbom", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ci") opts.ci = true;
    else if (a === "--offline") opts.offline = true;
    else if (a === "--out") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) {
        console.error("--out 需要一个目录参数");
        process.exit(2);
      }
      opts.out = v;
    } else if (a === "--help" || a === "-h") opts.help = true;
    else {
      console.error(`未知参数: ${a}\n使用 --help 查看用法。`);
      process.exit(2);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// 环境探测
// ---------------------------------------------------------------------------

function collectEnvironment() {
  let gradleWrapper = "不可用";
  try {
    const props = fs.readFileSync(
      path.join(ROOT, "server", "gradle", "wrapper", "gradle-wrapper.properties"),
      "utf8",
    );
    const m = props.match(/gradle-([0-9][0-9.]+)-(?:bin|all)\.zip/);
    if (m) gradleWrapper = m[1];
  } catch {
    /* 缺失则保持不可用 */
  }
  const cargoAudit = run("cargo", ["audit", "--version"], { timeout: 15000 });
  return {
    platform: `${process.platform} ${os.release()} (${process.arch})`,
    node: process.version,
    npm: toolVersion("npm"),
    bun: toolVersion("bun"),
    cargo: toolVersion("cargo"),
    java: (() => {
      const r = run("java", ["-version"], { timeout: 15000 });
      return firstLine(r.stderr) || firstLine(r.stdout) || "不可用";
    })(),
    gradleWrapper,
    cargoAudit: cargoAudit.exitCode === 0 ? firstLine(cargoAudit.stdout) : "未安装",
    cargoAuditProbe: cargoAudit,
  };
}

// ---------------------------------------------------------------------------
// 依赖清单采集 —— npm
// ---------------------------------------------------------------------------

function npmLicense(name) {
  const p = path.join(ROOT, "node_modules", ...name.split("/"), "package.json");
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const l = j.license ?? j.licenses;
    if (typeof l === "string") return l;
    if (Array.isArray(l)) return l[0]?.type ?? l[0]?.name ?? null;
    if (l && typeof l === "object") return l.type ?? l.name ?? null;
  } catch {
    /* node_modules 不存在（如 CI）或该包无 package.json */
  }
  return null;
}

function parseFallbackLock() {
  const candidates = [
    { file: "bun.lock", kind: "bun" },
  ];
  for (const c of candidates) {
    const full = path.join(ROOT, c.file);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, "utf8");
    const found = new Map();
    // packages: { "name": ["name@version", "url", {...}, "integrity"], ... }
    const re = /\["([^"]+@[0-9][^"]*)"\s*,/g;
    for (const m of text.matchAll(re)) {
      const nv = parseNameVersion(m[1]);
      if (nv) found.set(`${nv.name}@${nv.version}`, nv);
    }
    if (found.size) {
      return {
        ok: true,
        source: `回退解析 ${c.file}`,
        packages: [...found.values()],
        note: `npm ls 不可用，组件来自 ${c.file} 的 lockfile 记录（非实际安装树）`,
      };
    }
  }
  return {
    ok: false,
    source: "无",
    packages: [],
    note: "npm ls 失败且 bun.lock 无法解析，npm 侧仅有声明信息",
  };
}

function collectNpm(packageJson) {
  const declared = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
  };
  const declaredNames = Object.keys(declared);

  let installed = [];
  let source = "npm ls --all --json";
  let note = "";
  let lsProblems = [];
  const directRefsHints = []; // { name, version }

  const ls = run("npm", ["ls", "--all", "--json"], { timeout: 90000 });
  let tree = null;
  if (ls.exitCode === 0 || ls.exitCode === 1) {
    try {
      tree = JSON.parse(ls.stdout);
    } catch {
      tree = null;
    }
  }
  // CI 上 checkout 后通常没有 node_modules：npm ls 可能返回有效 JSON 但
  // dependencies 为空对象。此时必须回退到 lockfile，不能把「0 个组件」当作成功采集。
  if (tree && tree.dependencies && Object.keys(tree.dependencies).length > 0) {
    const map = new Map();
    const edges = []; // { parent: "name@version", child: "name@version" }
    const keyOf = (name, info) => `${name}@${info.version}`;
    let skippedNoVersion = 0;
    // npm ls 会把未安装的 optional / 平台特定依赖列成空对象 {}（无 version）。
    // 这类节点不是实际安装的组件，必须排除，否则会生成 @0.0.0 的假 purl，
    // 进而在 OSV 查询里因版本小于所有受影响区间而产生假阳性漏洞。
    function walk(node, isRoot) {
      for (const [name, info] of Object.entries(node.dependencies || {})) {
        if (!info || !info.version) {
          skippedNoVersion++;
          continue;
        }
        const pk = keyOf(name, info);
        if (!map.has(pk)) map.set(pk, { name, version: info.version });
        if (isRoot) {
          directRefsHints.push({ name, version: info.version });
          edges.push({ parent: "__ROOT__", child: pk });
        }
        for (const [childName, childInfo] of Object.entries(info.dependencies || {})) {
          if (!childInfo || !childInfo.version) continue;
          edges.push({ parent: pk, child: keyOf(childName, childInfo) });
        }
        walk(info, false);
      }
    }
    walk({ dependencies: tree.dependencies }, true);
    installed = [...map.values()];
    lsProblems = Array.isArray(tree.problems) ? tree.problems : [];
    const notes = [];
    if (lsProblems.length) notes.push(`npm ls 报告 ${lsProblems.length} 条 problems（已记录，不视为失败）`);
    if (skippedNoVersion) notes.push(`已排除 ${skippedNoVersion} 个未安装/无版本的可选或平台特定依赖占位节点`);
    if (ls.exitCode === 1) notes.push("npm ls 退出码 1（存在 problems），仍按安装树采集");
    note = notes.join("；");
    source = "npm ls --all --json";
    return {
      ok: true,
      source,
      note,
      exitCode: ls.exitCode,
      command: ls.command,
      packages: installed,
      edges,
      directRefsHints,
      declaredNames,
      lsProblems,
      skippedNoVersion,
    };
  }

  const fb = parseFallbackLock();
  // 回退时：声明侧给出的 name 用作直接依赖提示，版本从 lockfile 里按 name 匹配
  for (const name of declaredNames) {
    const hit = fb.packages.find((p) => p.name === name);
    directRefsHints.push({ name, version: hit?.version || null });
  }
  return {
    ok: fb.ok,
    source: fb.source,
    note: [fb.note, `npm ls: exitCode=${ls.exitCode}, error=${ls.error || "无"}`].join("；"),
    exitCode: ls.exitCode,
    command: ls.command,
    packages: fb.packages,
    edges: [],
    directRefsHints,
    declaredNames,
    lsProblems: [],
    fallbackUsed: true,
  };
}

// ---------------------------------------------------------------------------
// 依赖清单采集 —— Rust (Cargo.lock)
// ---------------------------------------------------------------------------

function collectCargo() {
  const file = path.join(ROOT, "src-tauri", "Cargo.lock");
  const text = fs.readFileSync(file, "utf8");
  const blocks = text.split(/^\[\[package\]\]\s*$/m).slice(1);
  const all = [];
  for (const b of blocks) {
    const name = (b.match(/^name = "(.+)"$/m) || [])[1];
    const version = (b.match(/^version = "(.+)"$/m) || [])[1];
    const source = (b.match(/^source = "(.+)"$/m) || [])[1] || null;
    const checksum = (b.match(/^checksum = "(.+)"$/m) || [])[1] || null;
    if (name && version) all.push({ name, version, source, checksum });
  }
  // 无 source 的是本地工作区包（项目本体），不作为第三方组件
  const packages = all.filter((p) => p.source).map(({ name, version, checksum }) => ({
    name,
    version,
    checksum,
  }));
  const local = all.filter((p) => !p.source).map((p) => `${p.name}@${p.version}`);

  // Cargo.toml 的 [dependencies] 段作为「直接依赖」提示
  let directNames = [];
  try {
    const ct = fs.readFileSync(path.join(ROOT, "src-tauri", "Cargo.toml"), "utf8");
    const seg = ct.split(/^\[dependencies\]\s*$/m)[1]?.split(/^\[/m)[0] || "";
    for (const line of seg.split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z0-9_-]+)\s*=/);
      if (m) directNames.push(m[1]);
    }
  } catch {
    /* Cargo.toml 缺失则无直接依赖提示 */
  }
  return {
    ok: true,
    source: "src-tauri/Cargo.lock",
    packages,
    localPackages: local,
    directNames,
    note: `共 ${all.length} 个 [[package]]，其中 ${local.length} 个本地工作区包已排除，纳入 ${packages.length} 个第三方 crate`,
  };
}

// ---------------------------------------------------------------------------
// 依赖清单采集 —— Maven (build.gradle.kts + 离线解析树)
// ---------------------------------------------------------------------------

function collectMavenDeclared() {
  const file = path.join(ROOT, "server", "build.gradle.kts");
  const text = fs.readFileSync(file, "utf8");
  const vars = {};
  for (const m of text.matchAll(/val\s+(\w+)\s*=\s*"([^"]+)"/g)) vars[m[1]] = m[2];
  const springBootPlugin = (text.match(/id\("org\.springframework\.boot"\)\s+version\s+"([^"]+)"/) || [])[1] || null;

  const coords = [];
  const re = /(?:implementation|api|compileOnly|runtimeOnly|annotationProcessor|testImplementation|testCompileOnly|testRuntimeOnly|testAnnotationProcessor|platform)\s*\(\s*"([^"]+)"\s*\)/g;
  for (const m of text.matchAll(re)) {
    const raw = m[1];
    const expanded = raw.replace(/\$(\w+)/g, (_, k) => vars[k] ?? "");
    const parts = expanded.split(":");
    if (parts.length < 2) continue;
    const [group, artifact, version] = parts;
    coords.push({ group, artifact, version: version || null, raw });
  }
  return {
    file: "server/build.gradle.kts",
    vars,
    springBootPlugin,
    coords,
    note: `声明侧共 ${coords.length} 个坐标；其中 ${coords.filter((c) => !c.version).length} 个版本由 BOM 管理`,
  };
}

function collectMavenResolved(declared) {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "gradlew.bat" : "./gradlew";
  const args = ["-q", "dependencies", "--configuration", "runtimeClasspath", "--offline", "--no-daemon"];
  const r = run(cmd, args, { cwd: path.join(ROOT, "server"), timeout: 240000 });
  const command = `${cmd} ${args.join(" ")}`;
  if (r.exitCode !== 0) {
    return {
      ok: false,
      command,
      exitCode: r.exitCode,
      error: r.error,
      packages: [],
      note: `Gradle 离线解析树不可用（exitCode=${r.exitCode}${r.error ? `, ${r.error}` : ""}）；Maven 侧仅使用声明侧坐标，非完整传递依赖`,
      raw: r,
    };
  }
  const packages = new Map();
  for (const line of r.stdout.split(/\r?\n/)) {
    if (/\(c\)/.test(line)) continue; // dependency constraint，不是实际依赖
    const m = line.match(/([\w.-]+):([\w.-]+)(?::([\w.+-]+))?(?:\s*->\s*([\w.+-]+))?/);
    if (!m) continue;
    const group = m[1];
    const artifact = m[2];
    const version = m[4] || m[3]; // 冲突解析后版本优先
    if (!version) continue;
    const key = `${group}:${artifact}:${version}`;
    if (!packages.has(key)) packages.set(key, { group, artifact, version });
  }
  const list = [...packages.values()];
  return {
    ok: true,
    command,
    exitCode: r.exitCode,
    packages: list,
    note: `从 runtimeClasspath 解析树提取 ${list.length} 个去重的 group:artifact:version（含传递依赖，已排除 (c) 约束行）`,
    raw: r,
  };
}

// ---------------------------------------------------------------------------
// 严重性
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MODERATE", "LOW", "UNKNOWN"];

function normalizeSeverity(v) {
  const s = String(v || "").toUpperCase();
  if (s.includes("CRIT")) return "CRITICAL";
  if (s.includes("HIGH")) return "HIGH";
  if (s.includes("MODERATE") || s.includes("MEDIUM")) return "MODERATE";
  if (s.includes("LOW")) return "LOW";
  if (s.includes("INFO")) return "LOW";
  return "UNKNOWN";
}

/** 从 CVSS v3.x vector 计算 base score，用于没有 database_specific.severity 的条目。 */
function cvssV3BaseScore(vector) {
  const parts = {};
  for (const kv of String(vector).split("/")) {
    const [k, v] = kv.split(":");
    if (k && v) parts[k] = v;
  }
  if (!parts.AV || !parts.AC || !parts.UI || !parts.C || !parts.I || !parts.A) return null;
  const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[parts.AV];
  const AC = { L: 0.77, H: 0.44 }[parts.AC];
  const UI = { N: 0.85, R: 0.62 }[parts.UI];
  const C = { H: 0.56, L: 0.22, N: 0 }[parts.C];
  const I = { H: 0.56, L: 0.22, N: 0 }[parts.I];
  const A = { H: 0.56, L: 0.22, N: 0 }[parts.A];
  const changed = /^CVSS:3\.[01]\//.test(String(vector)) && parts.S === "C";
  const PR = changed
    ? { N: 0.85, L: 0.68, H: 0.5 }[parts.PR]
    : { N: 0.85, L: 0.62, H: 0.27 }[parts.PR];
  if ([AV, AC, PR, UI, C, I, A].some((x) => x === undefined)) return null;
  const iss = 1 - (1 - C) * (1 - I) * (1 - A);
  const impact = changed
    ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15)
    : 6.42 * iss;
  const exploitability = 8.22 * AV * AC * PR * UI;
  if (impact <= 0) return 0;
  const raw = changed
    ? Math.min(1.08 * (impact + exploitability), 10)
    : Math.min(impact + exploitability, 10);
  return Math.ceil(raw * 10) / 10;
}

function severityFromOsv(vuln) {
  const ds = vuln?.database_specific?.severity;
  if (ds) return { severity: normalizeSeverity(ds), basis: `database_specific.severity=${ds}` };
  for (const s of vuln?.severity || []) {
    if (s.type === "CVSS_V3" || s.type === "CVSS_V4") {
      const score = s.type === "CVSS_V3" ? cvssV3BaseScore(s.score) : null;
      if (score !== null) {
        const sev = score >= 9 ? "CRITICAL" : score >= 7 ? "HIGH" : score >= 4 ? "MODERATE" : "LOW";
        return { severity: sev, basis: `${s.type} base=${score}` };
      }
      return { severity: "UNKNOWN", basis: `${s.type} vector（未计算 base score）` };
    }
  }
  return { severity: "UNKNOWN", basis: "OSV 条目未提供定性严重性" };
}

function emptyBuckets() {
  return Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0]));
}

// ---------------------------------------------------------------------------
// 审计执行（每个工具都留痕）
// ---------------------------------------------------------------------------

function newExecution(tool, version, command) {
  return {
    tool,
    version,
    command,
    timestamp: nowIso(),
    exitCode: null,
    signal: null,
    error: null,
    durationMs: 0,
    status: "ok", // ok | failed | unavailable | skipped
    reason: "",
    advisoryCount: 0,
    severityBuckets: emptyBuckets(),
    detail: "",
  };
}

function auditNpm(packageJson, offline, env) {
  const ex = newExecution("npm audit", env.npm, "(临时目录) npm audit --json");
  if (offline) {
    ex.status = "skipped";
    ex.reason = "--offline：跳过联网步骤（临时 lock 生成与 audit 均未执行）";
    return { execution: ex, findings: [] };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reqora-supply-chain-"));
  const findings = [];
  try {
    const minimal = {
      name: packageJson.name,
      version: packageJson.version,
      private: true,
      dependencies: packageJson.dependencies || {},
      devDependencies: packageJson.devDependencies || {},
    };
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify(minimal, null, 2), "utf8");
    const npmEnv = { ...process.env, npm_config_registry: NPM_REGISTRY };
    const install = run(
      "npm",
      ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", `--registry=${NPM_REGISTRY}`],
      { cwd: tmp, timeout: 180000, env: npmEnv },
    );
    if (install.exitCode !== 0) {
      ex.status = "failed";
      ex.exitCode = install.exitCode;
      ex.error = install.error;
      ex.reason = `临时 package-lock.json 生成失败（exitCode=${install.exitCode}${install.error ? `, ${install.error}` : ""}）；未执行 audit，不记为 0 漏洞`;
      ex.detail = firstLine(install.stderr);
      ex.command = `${install.command} ; (临时目录) npm audit --json`;
      return { execution: ex, findings };
    }
    const audit = run("npm", ["audit", "--json", `--registry=${NPM_REGISTRY}`], {
      cwd: tmp,
      timeout: 180000,
      env: npmEnv,
    });
    ex.command = `${install.command} ; ${audit.command}（均在临时目录 ${path.basename(tmp)}）`;
    ex.exitCode = audit.exitCode;
    ex.signal = audit.signal;
    ex.error = audit.error;
    ex.durationMs = install.durationMs + audit.durationMs;
    let parsed = null;
    try {
      parsed = JSON.parse(audit.stdout);
    } catch {
      parsed = null;
    }
    if (!parsed || !parsed.metadata || !parsed.metadata.vulnerabilities) {
      ex.status = "failed";
      ex.reason = `audit 输出不是有效的 npm audit JSON${audit.error ? `（${audit.error}）` : ""}`;
      ex.detail = firstLine(audit.stderr) || firstLine(audit.stdout);
      return { execution: ex, findings };
    }
    const summary = parsed.metadata.vulnerabilities;
    ex.status = "ok";
    ex.reason = audit.exitCode === 0 ? "执行成功，未发现 advisory" : `执行成功（audit 退出码 ${audit.exitCode} 表示发现 advisory）`;
    ex.severityBuckets = {
      CRITICAL: summary.critical || 0,
      HIGH: summary.high || 0,
      MODERATE: summary.moderate || 0,
      LOW: (summary.low || 0) + (summary.info || 0),
      UNKNOWN: 0,
    };
    ex.advisoryCount = Object.values(ex.severityBuckets).reduce((a, b) => a + b, 0);
    for (const [name, v] of Object.entries(parsed.vulnerabilities || {})) {
      const sev = normalizeSeverity(v.severity);
      findings.push({
        source: "npm audit",
        id: (v.via || []).map((x) => (typeof x === "string" ? x : x.title || x.url)).filter(Boolean).slice(0, 3).join("; ") || name,
        component: name,
        severity: sev,
        summary: v.isDirect ? "直接依赖" : "传递依赖",
        fix: v.fixAvailable ? (v.fixAvailable === true ? "可自动修复（npm audit fix）" : `建议升级至 ${v.fixAvailable.version || "较新版本"}`) : "暂无官方修复，建议评估替代或缓解",
        basis: `npm audit severity=${v.severity}`,
      });
    }
    ex.detail = `metadata.vulnerabilities=${JSON.stringify(summary)}`;
    return { execution: ex, findings };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    } catch {
      /* 临时目录清理失败不影响产物 */
    }
  }
}

function auditBun(offline, env) {
  const ex = newExecution("bun audit", env.bun, "bun audit --json --omit=dev");
  if (offline) {
    ex.status = "skipped";
    ex.reason = "--offline：跳过联网步骤（未执行）";
    return { execution: ex, findings: [] };
  }
  const r = run("bun", ["audit", "--json", "--omit=dev"], { timeout: 60000 });
  ex.exitCode = r.exitCode;
  ex.signal = r.signal;
  ex.error = r.error;
  ex.durationMs = r.durationMs;
  const errLines = `${r.stderr}\n${r.stdout}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const err = errLines.filter((l) => /404|error|advisories|not (found|supported)/i.test(l)).slice(0, 3).join(" | ")
    || errLines.slice(0, 3).join(" | ");
  // 已知情况：本机 .npmrc 指向 npmmirror，其 bulk advisory 端点返回 404；
  // 其他环境（如 CI）也可能是 bun 未安装，同样记为「工具不可用」。
  const is404 = /404/.test(err);
  ex.status = "unavailable";
  ex.reason = `工具不可用：exitCode=${r.exitCode}${r.error ? `, ${r.error}` : ""}；${is404 ? "镜像 bulk advisory 端点不支持（404）" : "bun 未安装或审计请求未成功"}；未获得任何 advisory，不记为 0 漏洞`;
  ex.detail = err.slice(0, 400);
  ex.advisoryCount = 0;
  return { execution: ex, findings: [] };
}

function auditCargo(offline, env) {
  const ex = newExecution("cargo audit", env.cargoAudit === "未安装" ? "未安装" : env.cargoAudit, "cargo audit --json（未执行：未安装）");
  if (env.cargoAudit === "未安装") {
    ex.status = "skipped";
    ex.reason = "cargo-audit 未安装；按约束不联网安装，跳过。Rust 侧漏洞改由 OSV（RustSec）覆盖";
    ex.detail = firstLine(env.cargoAuditProbe?.stderr) || "cargo: no such command `audit`";
    return { execution: ex, findings: [] };
  }
  if (offline) {
    ex.status = "skipped";
    ex.reason = "--offline：跳过（cargo audit 需读取在线 advisory 数据库）";
    return { execution: ex, findings: [] };
  }
  const r = run("cargo", ["audit", "--json"], { cwd: path.join(ROOT, "src-tauri"), timeout: 120000 });
  ex.exitCode = r.exitCode;
  ex.durationMs = r.durationMs;
  ex.error = r.error;
  ex.command = "cargo audit --json";
  ex.status = r.exitCode === 0 || r.stdout.trim() ? "ok" : "failed";
  ex.reason = r.exitCode === 0 ? "执行成功" : `执行结束（exitCode=${r.exitCode}）`;
  ex.detail = firstLine(r.stderr) || firstLine(r.stdout);
  return { execution: ex, findings: [] };
}

async function auditOsv(purls, offline, env) {
  const started = Date.now();
  const ex = newExecution(
    "OSV",
    "api.osv.dev/v1 (querybatch + vulns)",
    `POST ${OSV_QUERYBATCH} ; GET ${OSV_VULN}/*`,
  );
  if (offline) {
    ex.status = "skipped";
    ex.reason = `--offline：跳过联网步骤，未查询 ${purls.length} 个 purl`;
    return { execution: ex, findings: [] };
  }
  const findings = [];
  const purlHits = new Map(); // purl -> [ids]
  const batches = chunk(purls, 100);
  let okBatches = 0;
  let failedBatches = 0;
  const batchErrors = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const body = { queries: batch.map((purl) => ({ package: { purl } })) };
    let res;
    try {
      res = await fetchJson(
        OSV_QUERYBATCH,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        45000,
      );
    } catch (e) {
      res = { ok: false, status: 0, json: null, text: e.message };
    }
    if (!res.ok || !res.json || !Array.isArray(res.json.results)) {
      failedBatches++;
      batchErrors.push(`第 ${i + 1} 批 HTTP ${res.status}${res.text ? `: ${String(res.text).slice(0, 120)}` : ""}`);
      continue;
    }
    okBatches++;
    res.json.results.forEach((result, idx) => {
      const ids = (result?.vulns || []).map((v) => v.id).filter(Boolean);
      if (ids.length) purlHits.set(batch[idx], ids);
    });
    if (i < batches.length - 1) await sleep(200);
  }
  // HTTP API 没有进程退出码；此处以 HTTP 状态代替，并在 detail 中说明。
  ex.exitCode = okBatches ? "HTTP 200" : "HTTP 失败";
  ex.detail = `querybatch ${batches.length} 批（每批 ≤100）：成功 ${okBatches}，失败 ${failedBatches}（HTTP API 无进程退出码，列中记录 HTTP 状态）`;
  if (batchErrors.length) ex.detail += `；${batchErrors.slice(0, 3).join("；")}`;

  const allIds = [...new Set([...purlHits.values()].flat())];
  const idMeta = new Map();
  const limitedIds = allIds.slice(0, 80); // 详情查询上限，避免脚本在异常情况下跑太久
  for (const id of limitedIds) {
    let res;
    try {
      res = await fetchJson(`${OSV_VULN}/${encodeURIComponent(id)}`, {}, 30000);
    } catch (e) {
      res = { ok: false, status: 0, json: null, text: e.message };
    }
    if (res.ok && res.json) idMeta.set(id, res.json);
    await sleep(80);
  }

  for (const [purl, ids] of purlHits) {
    for (const id of ids) {
      const v = idMeta.get(id);
      const { severity, basis } = v ? severityFromOsv(v) : { severity: "UNKNOWN", basis: "详情未取到，严重性未知" };
      findings.push({
        source: "OSV",
        id,
        component: purl,
        severity,
        summary: v?.summary || v?.details?.split(/\r?\n/)[0]?.slice(0, 160) || "（无摘要）",
        fix: "升级到该 advisory 的 patched 版本；无修复版本时评估缓解措施或替换组件",
        basis,
      });
    }
  }
  ex.severityBuckets = emptyBuckets();
  for (const f of findings) ex.severityBuckets[f.severity] = (ex.severityBuckets[f.severity] || 0) + 1;
  ex.advisoryCount = findings.length;
  ex.timestamp = nowIso();
  ex.durationMs = Date.now() - started;

  if (okBatches === 0) {
    ex.status = "unavailable";
    ex.reason = `OSV 全部 ${batches.length} 批查询失败（网络/服务不可用）；未获得任何结果，不记为 0 漏洞`;
    return { execution: ex, findings: [] };
  }
  ex.status = "ok";
  ex.reason = failedBatches
    ? `部分成功：${okBatches}/${batches.length} 批可用，${failedBatches} 批失败（失败批次的组件未覆盖，已在第 6 节说明）`
    : `全部 ${okBatches} 批查询成功，命中 ${allIds.length} 个 advisory id，已取详情 ${idMeta.size} 个`;
  ex.detail += `；命中组件 ${purlHits.size} 个、去重 id ${allIds.length} 个${allIds.length > limitedIds.length ? `（详情查询上限 ${limitedIds.length}，其余仅保留 id）` : ""}`;
  return { execution: ex, findings, partialBatches: failedBatches, batchCount: batches.length };
}

// ---------------------------------------------------------------------------
// SBOM 构建
// ---------------------------------------------------------------------------

function buildSbom(packageJson, collections, env) {
  const version = packageJson.version;
  const rootRef = "reqora-application";
  const components = [];
  const directRefs = new Set();
  const seen = new Set();
  const edgesByRef = new Map(); // ref -> Set<ref>

  function addComponent(c) {
    if (seen.has(c["bom-ref"])) return c["bom-ref"];
    seen.add(c["bom-ref"]);
    components.push(c);
    return c["bom-ref"];
  }
  function addEdge(from, to) {
    if (from === to) return;
    if (!edgesByRef.has(from)) edgesByRef.set(from, new Set());
    edgesByRef.get(from).add(to);
  }

  // --- npm --- (scope / group 区分生态，group = "npm")
  const npmRefByKey = new Map();
  for (const p of collections.npm.packages) {
    const purl = purlNpm(p.name, p.version);
    const lic = licenseEntry(npmLicense(p.name));
    const ref = addComponent({
      type: "library",
      "bom-ref": purl,
      group: "npm",
      name: p.name,
      version: p.version,
      purl,
      scope: "required",
      ...(lic ? { licenses: [lic] } : {}),
      properties: [
        { name: "reqora:ecosystem", value: "npm" },
        { name: "reqora:source", value: collections.npm.source },
      ],
    });
    npmRefByKey.set(`${p.name}@${p.version}`, ref);
  }
  for (const hint of collections.npm.directRefsHints) {
    let ref = hint.version ? npmRefByKey.get(`${hint.name}@${hint.version}`) : null;
    if (!ref) {
      const hit = [...npmRefByKey.entries()].find(([k]) => k.startsWith(`${hint.name}@`));
      ref = hit?.[1] || null;
    }
    if (ref) directRefs.add(ref);
  }
  for (const e of collections.npm.edges) {
    if (e.parent === "__ROOT__") {
      const ref = npmRefByKey.get(e.child);
      if (ref) directRefs.add(ref);
      continue;
    }
    const from = npmRefByKey.get(e.parent);
    const to = npmRefByKey.get(e.child);
    if (from && to) addEdge(from, to);
  }

  // --- cargo ---
  const cargoRefByName = new Map();
  for (const p of collections.cargo.packages) {
    const purl = purlCargo(p.name, p.version);
    const ref = addComponent({
      type: "library",
      "bom-ref": purl,
      group: "cargo",
      name: p.name,
      version: p.version,
      purl,
      scope: "required",
      ...(p.checksum ? { hashes: [{ alg: "SHA-256", content: p.checksum }] } : {}),
      properties: [
        { name: "reqora:ecosystem", value: "cargo" },
        { name: "reqora:source", value: "src-tauri/Cargo.lock" },
      ],
    });
    if (!cargoRefByName.has(p.name)) cargoRefByName.set(p.name, ref);
  }
  for (const name of collections.cargo.directNames) {
    const ref = cargoRefByName.get(name);
    if (ref) directRefs.add(ref);
  }

  // --- maven ---
  const mavenRefByGa = new Map();
  const mavenPackages = collections.mavenResolved.ok
    ? collections.mavenResolved.packages
    : collections.mavenDeclared.coords
        .filter((c) => c.version)
        .map(({ group, artifact, version }) => ({ group, artifact, version }));
  for (const p of mavenPackages) {
    const purl = purlMaven(p.group, p.artifact, p.version);
    const ref = addComponent({
      type: "library",
      "bom-ref": purl,
      group: "maven",
      name: `${p.group}:${p.artifact}`,
      version: p.version,
      purl,
      scope: "required",
      properties: [
        { name: "reqora:ecosystem", value: "maven" },
        { name: "reqora:maven:groupId", value: p.group },
        { name: "reqora:source", value: collections.mavenResolved.ok ? "gradle runtimeClasspath --offline" : "server/build.gradle.kts（仅声明侧）" },
      ],
    });
    if (!mavenRefByGa.has(`${p.group}:${p.artifact}`)) mavenRefByGa.set(`${p.group}:${p.artifact}`, ref);
  }
  for (const c of collections.mavenDeclared.coords) {
    const ref = mavenRefByGa.get(`${c.group}:${c.artifact}`);
    if (ref) directRefs.add(ref);
  }

  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: nowIso(),
      tools: {
        components: [
          {
            type: "application",
            author: "Reqora",
            name: TOOL_NAME,
            version: TOOL_VERSION,
          },
        ],
      },
      component: {
        type: "application",
        "bom-ref": rootRef,
        name: packageJson.name,
        version,
        description: String(packageJson.description || "").slice(0, 300),
        purl: purlNpm(packageJson.name, version),
        ...(packageJson.license ? { licenses: [licenseEntry(packageJson.license)] } : {}),
      },
      properties: [
        { name: "reqora:node", value: env.node },
        { name: "reqora:platform", value: env.platform },
        { name: "reqora:componentCount", value: String(components.length) },
      ],
    },
    components,
    dependencies: [],
  };

  // 项目本体 → 直接依赖
  bom.dependencies.push({ ref: rootRef, dependsOn: [...directRefs].sort() });
  // 每个组件都有一条 dependencies 记录；npm 安装树的父子关系作为 dependsOn
  for (const c of components) {
    const deps = edgesByRef.get(c["bom-ref"]);
    bom.dependencies.push({
      ref: c["bom-ref"],
      dependsOn: deps ? [...deps].sort() : [],
    });
  }
  return { bom, rootRef, directRefCount: directRefs.size, npmEdges: collections.npm.edges.length };
}

/** 结构自检：必填字段、bom-ref 唯一、dependencies 引用的 ref 都存在。 */
function validateSbom(bom) {
  const errors = [];
  for (const k of ["bomFormat", "specVersion", "serialNumber", "version"]) {
    if (bom[k] === undefined || bom[k] === null || bom[k] === "") errors.push(`缺少顶层字段 ${k}`);
  }
  if (bom.bomFormat !== "CycloneDX") errors.push("bomFormat 必须为 CycloneDX");
  if (bom.specVersion !== "1.6") errors.push("specVersion 必须为 1.6");
  if (!/^urn:uuid:/.test(String(bom.serialNumber || ""))) errors.push("serialNumber 必须是 urn:uuid:*");
  if (!bom.metadata) errors.push("缺少 metadata");
  else {
    if (!bom.metadata.timestamp) errors.push("缺少 metadata.timestamp");
    if (!bom.metadata.tools) errors.push("缺少 metadata.tools");
    const mc = bom.metadata.component;
    if (!mc) errors.push("缺少 metadata.component");
    else {
      for (const k of ["type", "bom-ref", "name", "version", "purl"]) {
        if (!mc[k]) errors.push(`metadata.component 缺少 ${k}`);
      }
      if (mc.type !== "application") errors.push("metadata.component.type 必须为 application");
    }
  }
  if (!Array.isArray(bom.components) || bom.components.length === 0) {
    errors.push("components[] 为空");
  }
  const refs = new Set();
  for (const c of bom.components || []) {
    for (const k of ["type", "name", "version", "purl", "bom-ref", "scope", "group"]) {
      if (!c[k]) errors.push(`组件 ${c.name || c["bom-ref"]} 缺少 ${k}`);
    }
    if (refs.has(c["bom-ref"])) errors.push(`bom-ref 重复: ${c["bom-ref"]}`);
    refs.add(c["bom-ref"]);
  }
  const allRefs = new Set([...refs]);
  if (bom.metadata?.component?.["bom-ref"]) {
    if (refs.has(bom.metadata.component["bom-ref"])) {
      errors.push("metadata.component.bom-ref 与某个组件 bom-ref 冲突");
    }
    allRefs.add(bom.metadata.component["bom-ref"]);
  }
  if (!Array.isArray(bom.dependencies)) errors.push("缺少 dependencies[]");
  else {
    const rootRef = bom.metadata?.component?.["bom-ref"];
    for (const d of bom.dependencies) {
      if (!allRefs.has(d.ref)) errors.push(`dependencies[].ref 不存在: ${d.ref}`);
      for (const dep of d.dependsOn || []) {
        if (!allRefs.has(dep)) errors.push(`dependencies[].dependsOn 引用不存在: ${dep}`);
      }
    }
    const rootDep = bom.dependencies.find((d) => d.ref === rootRef);
    if (!rootDep || !rootDep.dependsOn || rootDep.dependsOn.length === 0) {
      errors.push("缺少「项目本体 → 直接依赖」的 ref 关系");
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

function componentStats(bom) {
  const stats = {};
  for (const c of bom.components) {
    const g = c.group || "unknown";
    if (!stats[g]) stats[g] = { count: 0, licenses: 0, hashes: 0 };
    stats[g].count++;
    if (c.licenses?.length) stats[g].licenses++;
    if (c.hashes?.length) stats[g].hashes++;
  }
  return stats;
}

function buildAuditReport(ctx) {
  const {
    opts, env, packageJson, collections, executions, findings, bom, sbomRel,
    validationErrors, osvInfo, stats,
  } = ctx;
  const mode = [opts.ci ? "--ci" : null, opts.offline ? "--offline" : null].filter(Boolean).join(" ") || "默认（联网）";
  const L = [];
  L.push("# Reqora 依赖审计报告");
  L.push("");
  L.push(`- 生成时间：${nowIso()}`);
  L.push(`- 运行模式：${mode}`);
  L.push(`- 项目版本：${packageJson.version}`);
  L.push(`- SBOM 文件：\`${sbomRel}\`（CycloneDX ${bom.specVersion}）`);
  L.push(`- 结构自检：${validationErrors.length === 0 ? "通过（validateSbom 无错误）" : `未通过（${validationErrors.length} 项）`}`);
  L.push("");
  L.push("> 本报告由 `scripts/supply-chain.mjs` 自动生成。所有审计工具的退出码、耗时、成功/失败原因均逐条留痕；网络失败与工具不可用一律不记为「0 漏洞」。");
  L.push("");

  L.push("## 1. 环境");
  L.push("");
  L.push("| 项 | 值 |");
  L.push("| --- | --- |");
  for (const [k, v] of Object.entries({
    "操作系统": env.platform,
    "Node.js": env.node,
    "npm": env.npm,
    "bun": env.bun,
    "cargo": env.cargo,
    "Java": env.java,
    "Gradle Wrapper": env.gradleWrapper,
    "cargo-audit": env.cargoAudit,
  })) {
    L.push(`| ${mdCell(k)} | ${mdCell(v)} |`);
  }
  L.push("");

  L.push("## 2. 组件清单（依赖来源）");
  L.push("");
  L.push("| 生态 | 来源 | 组件数 | 说明 |");
  L.push("| --- | --- | ---: | --- |");
  L.push(`| npm | ${mdCell(collections.npm.source)} | ${stats.npm?.count || 0} | ${mdCell(collections.npm.note || "实际安装树；声明侧依赖见 package.json")} |`);
  L.push(`| cargo | src-tauri/Cargo.lock | ${stats.cargo?.count || 0} | ${mdCell(collections.cargo.note)} |`);
  L.push(`| maven | ${mdCell(collections.mavenResolved.ok ? collections.mavenResolved.command : "server/build.gradle.kts（仅声明侧）")} | ${stats.maven?.count || 0} | ${mdCell(collections.mavenResolved.ok ? collections.mavenResolved.note : collections.mavenResolved.note)} |`);
  L.push(`| **合计** | — | **${bom.components.length}** | CycloneDX \`components[]\` 去重后数量 |`);
  L.push("");
  L.push(`- npm 声明侧：\`package.json\` 共 ${collections.npm.declaredNames.length} 个直接依赖（dependencies + devDependencies）。`);
  L.push(`- Maven 声明侧：\`server/build.gradle.kts\` 共 ${collections.mavenDeclared.coords.length} 个坐标${collections.mavenDeclared.springBootPlugin ? `，Spring Boot 插件版本 ${collections.mavenDeclared.springBootPlugin}` : ""}；${collections.mavenDeclared.note}。`);
  if (!collections.mavenResolved.ok) {
    L.push("- **Maven 侧为「仅声明侧，非完整传递依赖」**：Gradle 离线解析树不可用，未采集 BOM 管理的传递依赖版本。");
  }
  L.push(`- Rust 本地工作区包（不作为第三方组件）：${collections.cargo.localPackages.join("、") || "无"}。`);
  L.push(`- 项目本体 → 直接依赖的依赖关系：${ctx.directRefCount} 条 ref；\`dependencies[]\` 共 ${bom.dependencies.length} 条。`);
  L.push("");

  L.push("## 3. 审计工具执行结果（全部留痕）");
  L.push("");
  L.push("| 工具 | 版本 | 状态 | 退出码 / HTTP 状态 | 耗时(ms) | advisory 数 | CRITICAL | HIGH | MODERATE | LOW | UNKNOWN | 命令 |");
  L.push("| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const ex of executions) {
    const b = ex.severityBuckets;
    L.push(`| ${mdCell(ex.tool)} | ${mdCell(ex.version)} | ${mdCell(ex.status)} | ${ex.exitCode ?? "—"} | ${ex.durationMs} | ${ex.advisoryCount} | ${b.CRITICAL} | ${b.HIGH} | ${b.MODERATE} | ${b.LOW} | ${b.UNKNOWN} | \`${mdCell(ex.command)}\` |`);
  }
  L.push("");
  L.push("状态含义：`ok` = 成功执行并取得可靠结果；`failed` = 执行但结果无效；`unavailable` = 工具/服务不可用；`skipped` = 按约束或 --offline 未执行。**后三者一律不提供「0 漏洞」结论。**");
  L.push("");
  L.push("各工具说明：");
  L.push("");
  for (const ex of executions) {
    L.push(`- **${ex.tool}**（${ex.status}，${ex.timestamp}）：${ex.reason}${ex.detail ? ` 细节：${ex.detail}` : ""}`);
  }
  L.push("");

  L.push("### 3.1 工具不可用（如实记录，不计入通过也不计入漏洞）");
  L.push("");
  const unavailable = executions.filter((e) => e.status === "unavailable" || e.status === "skipped" || e.status === "failed");
  if (unavailable.length === 0) {
    L.push("- 本次全部审计工具均成功执行，无「工具不可用」条目。");
  } else {
    for (const ex of unavailable) {
      L.push(`- **${ex.tool}**：\`${ex.status}\` — ${ex.reason}`);
    }
  }
  L.push("");
  L.push("已知情况：仓库 `.npmrc` 指向 npmmirror，\`bun audit\` 在本机请求该镜像的 bulk advisory 端点返回 404（CI 等环境也可能是 bun 未安装），两种情况都记为「工具不可用」；脚本不会篡改仓库配置绕过，npm 生态的审计由 npm audit（显式 \`--registry\` 指向官方源）+ OSV 覆盖。");
  L.push("");

  L.push("## 4. 高危 / 严重漏洞清单");
  L.push("");
  const high = findings.filter((f) => f.severity === "CRITICAL" || f.severity === "HIGH");
  const reliableSources = new Set(executions.filter((e) => e.status === "ok").map((e) => e.tool));
  const reliableHigh = high.filter((f) => reliableSources.has(f.source));
  if (reliableHigh.length === 0) {
    const allOk = executions.filter((e) => e.tool === "npm audit" || e.tool === "OSV").every((e) => e.status === "ok");
    if (allOk) {
      L.push("**无高危漏洞**：本次可靠来源（npm audit / OSV）未发现 high/critical 级别的 advisory。");
    } else {
      L.push("**未能完成完整审计**：部分联网审计工具不可用，故不给出「无高危漏洞」结论，也不把未覆盖部分记为「0 漏洞」。请在网络可用时复跑（见第 7 节）。");
    }
  } else {
    L.push(`共发现 **${reliableHigh.length}** 条 high/critical 级发现（来源可靠）：`);
    L.push("");
    L.push("| 来源 | ID | 组件 | 严重性 | 摘要 | 严重性依据 |");
    L.push("| --- | --- | --- | --- | --- | --- |");
    for (const f of reliableHigh) {
      L.push(`| ${mdCell(f.source)} | ${mdCell(f.id)} | \`${mdCell(f.component)}\` | ${mdCell(f.severity)} | ${mdCell(f.summary)} | ${mdCell(f.basis)} |`);
    }
  }
  L.push("");
  const bucket = emptyBuckets();
  for (const f of findings) bucket[f.severity] = (bucket[f.severity] || 0) + 1;
  const other = findings.filter((f) => !reliableHigh.includes(f));
  if (other.length) {
    L.push(`另有 ${other.length} 条中低危 / 严重性未知的发现。全部发现按严重性分桶：`);
    L.push("");
    L.push("| 严重性 | 条数 |");
    L.push("| --- | ---: |");
    for (const s of SEVERITY_ORDER) L.push(`| ${s} | ${bucket[s]} |`);
    L.push("");
  }
  if (findings.length) {
    L.push("### 4.1 全部发现明细（含严重性未知，便于人工复核）");
    L.push("");
    L.push("> OSV 的 RustSec 条目多数不提供定性严重性或 CVSS 向量，这类发现统一标为 UNKNOWN 并在此逐条列出；UNKNOWN 不等于无风险，也不触发 --ci 失败。同一漏洞可能同时存在 GHSA 与 RUSTSEC 两个 id，此处按 OSV 返回的 id 原样保留，未做跨 id 去重。");
    L.push("");
    L.push("| # | 来源 | ID | 组件 | 严重性 | 摘要 | 处置建议 |");
    L.push("| ---: | --- | --- | --- | --- | --- | --- |");
    findings.forEach((f, i) => {
      L.push(`| ${i + 1} | ${mdCell(f.source)} | ${mdCell(f.id)} | \`${mdCell(f.component)}\` | ${mdCell(f.severity)} | ${mdCell(f.summary).slice(0, 120)} | ${mdCell(f.fix).slice(0, 90)} |`);
    });
    L.push("");
  }

  L.push("## 5. 处置建议");
  L.push("");
  if (reliableHigh.length) {
    L.push("1. 优先处理上表中的 high/critical 条目：升级到 advisory 标注的 patched 版本，或用 \`npm audit fix\` / 升级 Cargo 依赖 / 升级 Maven BOM 版本。");
    L.push("2. 若组件暂无修复版本，评估缓解措施（关闭受影响功能、加输入校验、替换组件），并在 SECURITY.md 中记录例外。");
    L.push("3. 修复后复跑本脚本并对比 \`sbom/\` 产物，确认 advisory 数下降。");
  } else {
    L.push("1. 保持当前依赖版本，按第 7 节的定时/推送流程持续复跑（OSV 数据库随时间更新，今天无漏洞不代表明天无漏洞）。");
    L.push("2. 对「工具不可用」的条目在具备条件时补齐（例如安装 cargo-audit、在能访问官方源的机器上复跑 npm audit）。");
    L.push("3. 依赖升级后重新生成 SBOM，确保 bom-ref 与实际版本一致。");
  }
  L.push(`4. 上表中 ${bucket.UNKNOWN} 条严重性为 UNKNOWN 的发现（OSV/RustSec 未提供定性严重性或 CVSS 向量）需安排人工复核，确认受影响版本与当前用法下是否可被触发；UNKNOWN 既不计入 high/critical，也不视为无风险。`);
  L.push("");

  L.push("## 6. 哪些没查到 / 为什么");
  L.push("");
  L.push("- **bun audit**：本机为镜像 404（其他环境可能是 bun 未安装），记为工具不可用；其本应覆盖的 npm 生态已由 npm audit + OSV 覆盖。");
  L.push("- **cargo audit**：未安装且按约束不联网安装，状态 skipped；Rust 侧由 OSV（含 RustSec 条目）覆盖。");
  L.push(`- **RustSec 条目的严重性**：OSV 中 ${bucket.UNKNOWN} 条 RustSec advisory 未提供定性严重性与 CVSS 向量，脚本如实标为 UNKNOWN 并在 4.1 节逐条列出，未凭空判定级别；这部分风险需人工复核。`);
  if (opts.offline) {
    L.push("- **npm audit / OSV / bun audit**：\`--offline\` 模式下全部未执行（依赖清单采集仍照常完成），**审计未执行**，本报告不构成漏洞结论。");
  }
  const osvEx = executions.find((e) => e.tool === "OSV");
  if (osvEx?.status === "skipped" || osvEx?.status === "unavailable") {
    L.push(`- **OSV**：${osvEx.reason}。受影响组件本次未做漏洞查询，请联网复跑。`);
  } else if (osvEx?.status === "ok" && osvInfo?.partialBatches) {
    L.push(`- **OSV 部分批次失败**：${osvInfo.batchCount} 批中 ${osvInfo.partialBatches} 批未返回结果，这些批次的 purl 本次未覆盖（失败不等于无漏洞）。`);
  }
  if (!collections.mavenResolved.ok) {
    L.push("- **Maven 传递依赖**：Gradle 离线解析树不可用，SBOM 中 Maven 组件为「仅声明侧，非完整传递依赖」，未解析到的传递依赖不会被 OSV 查询。");
  }
  if (collections.npm.fallbackUsed) {
    L.push("- **npm 实际安装树**：\`npm ls\` 不可用，组件来自 lockfile 记录，可能与实际 \`node_modules\` 存在偏差。");
  }
  L.push("- **动态/运行时依赖**：仅覆盖 lockfile 与安装树中可见的静态组件；不含运行时动态下载、Tauri 打包时链入的操作系统库、以及容器基础镜像内的系统包。详见 `docs/SUPPLY_CHAIN.md` 的支持边界。");
  L.push("- **无漏洞 ≠ 已认证**：OSV 结果随时间变化，且本流程不含第三方签名认证 / 无 SLA。");
  L.push("");

  L.push("## 7. 复跑命令");
  L.push("");
  L.push("```bash");
  L.push("node scripts/supply-chain.mjs                 # 联网：完整审计 + SBOM");
  L.push("node scripts/supply-chain.mjs --offline       # 无网络：仅采集 + SBOM，报告标注审计未执行");
  L.push("node scripts/supply-chain.mjs --ci            # CI：发现可靠 high/critical 或审计不完整时非零退出");
  L.push("node scripts/supply-chain.mjs --out sbom/foo  # 自定义输出目录");
  L.push("node --test test/supplyChain.test.mjs         # 离线校验已生成产物");
  L.push("```");
  L.push("");
  return L.join("\n") + "\n";
}

function buildSummaryReport(ctx) {
  const { opts, packageJson, bom, sbomRel, validationErrors, collections, stats, directRefCount, executions } = ctx;
  const L = [];
  L.push("# SBOM 摘要");
  L.push("");
  L.push(`- 生成时间：${nowIso()}`);
  L.push(`- 文件：\`${sbomRel}\``);
  L.push(`- 项目：${packageJson.name}@${packageJson.version}`);
  L.push(`- 格式：${bom.bomFormat} ${bom.specVersion}`);
  L.push(`- serialNumber：\`${bom.serialNumber}\``);
  L.push(`- metadata.timestamp：${bom.metadata.timestamp}`);
  L.push(`- 运行模式：${opts.ci ? "--ci " : ""}${opts.offline ? "--offline" : "默认（联网）"}`);
  L.push("");
  L.push("## 组件统计");
  L.push("");
  L.push("| 生态（group） | 组件数 | 含 license | 含 hash |");
  L.push("| --- | ---: | ---: | ---: |");
  for (const [g, s] of Object.entries(stats)) {
    L.push(`| ${mdCell(g)} | ${s.count} | ${s.licenses} | ${s.hashes} |`);
  }
  L.push(`| **合计** | **${bom.components.length}** | **${Object.values(stats).reduce((a, s) => a + s.licenses, 0)}** | **${Object.values(stats).reduce((a, s) => a + s.hashes, 0)}** |`);
  L.push("");
  L.push("三个生态通过每个组件的 `group` 字段（npm / cargo / maven）与 `properties[reqora:ecosystem]` 区分；scope 统一为 required。");
  L.push("");
  L.push("## 依赖关系与校验");
  L.push("");
  L.push(`- \`metadata.component\`（项目本体，type=application）→ 直接依赖 ref：${directRefCount} 条。`);
  L.push(`- \`dependencies[]\` 条目数：${bom.dependencies.length}（每个组件一条，含 npm 安装树父子关系）。`);
  L.push(`- \`validateSbom()\` 自检：${validationErrors.length === 0 ? "通过" : "未通过"} — ${validationErrors.length === 0 ? "必填字段齐全、bom-ref 唯一、所有 dependencies 引用的 ref 均存在" : validationErrors.join("；")}`);
  L.push("");
  L.push("## 依赖来源");
  L.push("");
  L.push(`- npm：${collections.npm.source}（${collections.npm.note}）`);
  L.push(`- cargo：src-tauri/Cargo.lock`);
  L.push(`- maven：${collections.mavenResolved.ok ? collections.mavenResolved.command : "server/build.gradle.kts（仅声明侧，非完整传递依赖）"}`);
  L.push("");
  L.push("## 审计工具");
  L.push("");
  for (const ex of executions) {
    L.push(`- ${ex.tool}：${ex.status}，advisory=${ex.advisoryCount}（CRITICAL ${ex.severityBuckets.CRITICAL} / HIGH ${ex.severityBuckets.HIGH} / MODERATE ${ex.severityBuckets.MODERATE} / LOW ${ex.severityBuckets.LOW} / UNKNOWN ${ex.severityBuckets.UNKNOWN}）`);
  }
  L.push("");
  L.push("## 复跑命令");
  L.push("");
  L.push("```bash");
  L.push("node scripts/supply-chain.mjs");
  L.push("node scripts/supply-chain.mjs --offline");
  L.push("node scripts/supply-chain.mjs --ci");
  L.push("node scripts/supply-chain.mjs --out sbom/foo");
  L.push("node --test test/supplyChain.test.mjs");
  L.push("```");
  L.push("");
  L.push("说明与边界见 `docs/SUPPLY_CHAIN.md`，逐工具留痕见 `sbom/dependency-audit.md`。");
  L.push("");
  return L.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const outDir = path.resolve(ROOT, opts.out);
  fs.mkdirSync(outDir, { recursive: true });
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

  console.log(`[supply-chain] 模式：${opts.ci ? "--ci " : ""}${opts.offline ? "--offline" : "联网"}；输出：${path.relative(ROOT, outDir).split(path.sep).join("/") || "."}`);

  console.log("[supply-chain] 探测环境…");
  const env = collectEnvironment();

  console.log("[supply-chain] 采集依赖清单（npm / cargo / maven）…");
  const collections = {
    npm: collectNpm(packageJson),
    cargo: collectCargo(),
    mavenDeclared: collectMavenDeclared(),
  };
  collections.mavenResolved = collectMavenResolved(collections.mavenDeclared);
  console.log(
    `[supply-chain] 采集完成：npm=${collections.npm.packages.length} cargo=${collections.cargo.packages.length} maven=${collections.mavenResolved.ok ? collections.mavenResolved.packages.length : collections.mavenDeclared.coords.filter((c) => c.version).length}`,
  );

  // 先构建 SBOM 以得到 purl 列表（OSV 用），审计完成后再写文件
  const { bom, rootRef, directRefCount } = buildSbom(packageJson, collections, env);
  const purls = bom.components.map((c) => c.purl);

  const executions = [];
  const findings = [];
  let osvInfo = null;

  console.log("[supply-chain] 执行 npm audit（临时目录）…");
  const a1 = auditNpm(packageJson, opts.offline, env);
  executions.push(a1.execution);
  findings.push(...a1.findings);

  console.log("[supply-chain] 执行 bun audit…");
  const a2 = auditBun(opts.offline, env);
  executions.push(a2.execution);
  findings.push(...a2.findings);

  console.log(`[supply-chain] 执行 OSV（${purls.length} 个 purl）…`);
  const a3 = await auditOsv(purls, opts.offline, env);
  executions.push(a3.execution);
  findings.push(...a3.findings);
  osvInfo = a3;

  console.log("[supply-chain] 检查 cargo audit…");
  const a4 = auditCargo(opts.offline, env);
  executions.push(a4.execution);
  findings.push(...a4.findings);

  const validationErrors = validateSbom(bom);
  if (validationErrors.length) {
    console.error(`[supply-chain] SBOM 自检未通过：\n  - ${validationErrors.join("\n  - ")}`);
  } else {
    console.log("[supply-chain] SBOM 自检通过");
  }

  // 把审计执行摘要写进 SBOM 的 metadata.properties（留痕，不含敏感值）
  bom.metadata.properties.push(
    { name: "reqora:audit:mode", value: opts.offline ? "offline" : "online" },
    { name: "reqora:audit:tools", value: executions.map((e) => `${e.tool}=${e.status}`).join(",") },
    { name: "reqora:audit:advisories", value: String(findings.length) },
  );

  const sbomFile = path.join(outDir, `reqora-${packageJson.version}.cdx.json`);
  writeText(sbomFile, JSON.stringify(bom, null, 2) + "\n");
  const sbomRel = path.relative(ROOT, sbomFile).split(path.sep).join("/");

  const stats = componentStats(bom);
  const ctx = {
    opts, env, packageJson, collections, executions, findings, bom, sbomRel,
    validationErrors, osvInfo, stats, directRefCount, rootRef,
  };
  const auditRel = writeText(path.join(outDir, "dependency-audit.md"), buildAuditReport(ctx));
  const summaryRel = writeText(path.join(outDir, "sbom-summary.md"), buildSummaryReport(ctx));

  console.log(`[supply-chain] 产物：${sbomRel}、${auditRel}、${summaryRel}`);
  console.log(`[supply-chain] 组件 ${bom.components.length} 个；审计发现 ${findings.length} 条`);
  for (const ex of executions) {
    console.log(`  - ${ex.tool}: ${ex.status} (advisory=${ex.advisoryCount}, exitCode=${ex.exitCode ?? "—"})`);
  }

  // ---- CI 退出判定 ----
  if (opts.ci) {
    const reliableSources = new Set(executions.filter((e) => e.status === "ok").map((e) => e.tool));
    const reliableHigh = findings.filter(
      (f) => (f.severity === "CRITICAL" || f.severity === "HIGH") && reliableSources.has(f.source),
    );
    if (reliableHigh.length) {
      console.error(`[supply-chain][ci] 失败：可靠来源发现 ${reliableHigh.length} 条 high/critical 漏洞`);
      process.exit(1);
    }
    const keyTools = executions.filter((e) => e.tool === "npm audit" || e.tool === "OSV");
    const anyReliable = keyTools.some((e) => e.status === "ok");
    if (!anyReliable) {
      console.error("[supply-chain][ci] 失败：npm audit 与 OSV 均未取得可靠结果，审计不完整（不能判定为通过）");
      process.exit(2);
    }
    if (validationErrors.length) {
      console.error("[supply-chain][ci] 失败：SBOM 结构自检未通过");
      process.exit(3);
    }
    const unknownCount = findings.filter((f) => f.severity === "UNKNOWN").length;
    if (unknownCount) {
      console.warn(`[supply-chain][ci] 警告：${unknownCount} 条 OSV 发现严重性未知，需人工复核（见 sbom/dependency-audit.md 4.1 节）`);
    }
    const notOk = executions.filter(
      (e) => (e.tool === "npm audit" || e.tool === "OSV") && e.status !== "ok",
    );
    if (notOk.length) {
      console.warn(`[supply-chain][ci] 警告：关键审计工具未全部成功（${notOk.map((e) => `${e.tool}=${e.status}`).join(", ")}），其未覆盖部分不视为通过，请查看报告第 3.1 / 6 节`);
    }
    console.log("[supply-chain][ci] 通过：未发现可靠来源的 high/critical 漏洞，且至少一项关键审计工具成功");
  } else if (validationErrors.length) {
    process.exit(3);
  }
}

main().catch((e) => {
  console.error("[supply-chain] 未捕获异常：", e?.stack || e);
  process.exit(1);
});
