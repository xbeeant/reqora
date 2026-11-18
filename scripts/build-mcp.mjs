#!/usr/bin/env node
// Bundle the MCP server into ONE self-contained file for distribution.
//
// Why: the MCP service is spread across `bin/*.mjs` (entry, protocol, storage,
// requester, vault) and `src/lib/*.ts` (tool catalog, scenario runner, scripts,
// …) that is shares with the desktop app. Distributing / publishing the MCP
// service used to require shipping both trees plus a Node version with type
// stripping. After this script there is a single `dist-mcp/mcp.mjs` that runs
// on any Node >= 22 — no src/, no tsc, no extra deps.
//
// Usage:
//   node scripts/build-mcp.mjs            # build dist-mcp/
//   node scripts/build-mcp.mjs --check    # build + smoke test the artifact
//
// The bundler is rolldown (already required by Vite 8). Everything relative is
// inlined; `node:*` builtins (including the lazy `node:sqlite`) stay external.
//
// Output layout — `dist-mcp/` is a publish-ready standalone package:
//   dist-mcp/mcp.mjs         the whole server (starts with a node shebang)
//   dist-mcp/package.json    manifest so the folder can be `npm publish`ed
//                            as `reqora-mcp` without the rest of the repo
//   dist-mcp/README.md       minimal client-config instructions
//   dist-mcp/reqora-send[.exe]  OPTIONAL companion: the Rust sidecar for the
//                            current platform, discovered next to mcp.mjs.
//                            Without it the server runs in explicit Node
//                            fetch diagnostic mode (capability differences
//                            are reported instead of claimed as parity).

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { rolldown } from "rolldown";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "bin", "mcp.mjs");
const outDir = join(root, "dist-mcp");
const outFile = join(outDir, "mcp.mjs");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const version = `v${pkg.version}`;

async function bundle() {
  const bundle = await rolldown({
    input: entry,
    platform: "node",
    resolve: {
      // src/lib imports both "./id.ts" (explicit) and "../types" (extensionless).
      extensions: [".ts", ".tsx", ".mjs", ".js"],
    },
  });
  try {
    const { output } = await bundle.generate({
      format: "esm",
      // One file — the whole point. Dynamic relative imports (node:sqlite stays
      // external and keeps its runtime laziness) are inlined into the module.
      codeSplitting: false,
      minify: false,
      // The entry keeps its own `#!/usr/bin/env node`; no banner needed.
    });
    const chunk = output.find((item) => item.type === "chunk" && item.isEntry);
    if (!chunk) throw new Error("rolldown 未产出入口 chunk");
    // node:* builtins legitimately stay external (incl. the lazy node:sqlite);
    // anything else means a relative/bare import escaped the bundle.
    const unexpected = chunk.imports.filter((spec) => !spec.startsWith("node:"));
    if (unexpected.length > 0) {
      throw new Error(`bundle 仍引用非内置模块：${unexpected.join(", ")}`);
    }
    if (!chunk.code.startsWith("#!")) {
      chunk.code = `#!/usr/bin/env node\n${chunk.code}`;
    }
    return chunk.code;
  } finally {
    await bundle.close();
  }
}

/** Publish-ready manifest for the dist-mcp folder itself. */
function standalonePackageJson() {
  const baseDescription = pkg.description.replace(/\s*This package ships.*$/i, "").trim();
  return {
    name: "reqora-mcp",
    version: pkg.version,
    description: `${baseDescription} — standalone MCP server (single bundled file, no sources needed).`,
    license: pkg.license,
    author: pkg.author,
    repository: pkg.repository,
    homepage: pkg.homepage,
    bugs: pkg.bugs,
    keywords: ["mcp", "model-context-protocol", "api-testing", "http", "ai-tools"],
    type: "module",
    engines: pkg.engines,
    bin: { "reqora-mcp": "mcp.mjs" },
    // The platform-specific sidecar is optional; npm silently skips missing
    // entries, so the same manifest works for all three OS targets.
    files: ["mcp.mjs", "README.md", "reqora-send", "reqora-send.exe"],
    os: ["darwin", "linux", "win32"],
  };
}

function standaloneReadme() {
  return `# reqora-mcp

Reqora（驿）MCP 服务的**单文件发行版**：\`mcp.mjs\` 把协议实现、项目存储、
请求执行、场景编排全部内联，只依赖 Node.js（>= ${pkg.engines.node.replace(">=", "").trim()}），
不需要源码、不需要构建。

## 挂到 AI 客户端

\`\`\`jsonc
{
  "mcpServers": {
    "reqora": {
      "command": "node",
      "args": ["/abs/path/to/dist-mcp/mcp.mjs", "--workspace", "/abs/path/to/project"],
      // 允许 AI 写入（新建/修改接口、用例、场景）时追加
      // "args": ["/abs/path/to/dist-mcp/mcp.mjs", "--workspace", "...", "--allow-write"]
    }
  }
}
\`\`\`

全局安装后也可直接用命令：

\`\`\`bash
npm install -g reqora-mcp
reqora-mcp --help          # 查看全部选项
reqora-mcp --config        # 打印各客户端可粘贴的配置片段
\`\`\`

\`--workspace\` 指向桌面端的项目数据目录（含 \`workspace.db\`）或项目 id / 名称。
默认只读；\`--allow-write\` 开启写入。详细工具目录与安全模型见主仓库 \`docs/MCP.md\`。

省略 \`--workspace\` 时读取桌面端当前激活项目：默认注册表在 \`~/.reqora/projects.json\`；在设置里迁移过数据目录时以 \`~/.reqora/data_root.json\` 的 \`dataRoot\` 为准。

## 错误日志

启动、写入失败与每次 \`tools/call\` 异常都会写入 \`~/.reqora/logs/reqora-mcp.log\`（桌面端为同目录的 \`errors.log\`，界面「查看错误日志」可打开）。
写入失败时工具返回体还会按原因分类给出处理建议（\`--allow-write\` 缺失 / 数据库只读或被占用 / 目录无权限 / 版本落后）并附上日志路径，不必再依赖客户端是否显示 stderr。

## 请求引擎与 sidecar

同目录的 \`reqora-send\`（Windows 为 \`reqora-send.exe\`）是可选的 Rust 引擎二进制，
与桌面端共用 \`reqora-core::service::http::HttpService\`。有它时代理、自签证书、
Cookie Jar、mTLS、SigV4 presign、分段计时与原始报文与桌面一致。

没有它（或设置 \`REQORA_ENGINE=node\`）时服务仍可运行，但会进入**显式诊断模式**：
降级到 Node \`fetch\`，在结果 \`note\` 与 \`reqora.run.v1\` 的 \`engine.transport\`
如实标为 \`node-fetch\` 并输出能力差异清单，不会假装三端一致。完整清单见主仓库
\`docs/ENGINE.md\`。跨平台分发时请为各平台单独构建 sidecar（\`bun run engine:build\`）。
`;
}

/** P0: ship the Rust sidecar next to the single-file bundle when it has been
 * built. Discovery in bin/engineClient.mjs already looks in this directory. */
function copySidecar() {
  const exe = process.platform === "win32" ? "reqora-send.exe" : "reqora-send";
  const candidates = [
    join(root, "dist-engine", `${process.platform}-${process.arch}`, exe),
    join(root, "dist-engine", exe),
    join(root, "src-tauri", "target", "release", exe),
    join(root, "src-tauri", "target", "debug", exe),
  ];
  const source = candidates.find((candidate) => existsSync(candidate));
  if (!source) {
    console.warn(
      `[build-mcp] ⚠ 未找到 ${exe}：单文件包仍可运行，但会走 Node fetch 显式诊断模式。先执行 bun run engine:build 再打包即可随包分发。`,
    );
    return null;
  }
  const target = join(outDir, exe);
  copyFileSync(source, target);
  return target;
}

/**
 * 删除构建中间目录。Windows 上回收站 / 文件占用可能让递归删除失败；
 * 清理只是收尾动作，不该把已经成功的打包冒烟测试变成失败。
 * 先带重试，最终仍失败只告警（目录已不存在时直接视为成功）。
 */
function removeBestEffort(target) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      return;
    } catch (error) {
      if (!existsSync(target)) return;
      if (attempt === 2) {
        console.warn(`[build-mcp] ⚠ 清理 ${target} 失败（不影响产物）：${error.message}`);
      }
    }
  }
}

/** Minimal project fixture — same schema as test/mcp.test.mjs, so the bundled
 * server has a real workspace.db to open during the smoke test.
 * 放在系统临时目录而非仓库内：不污染工作区，也避开部分盘符回收站不可用的问题。 */
async function makeTempProject() {
  const dir = mkdtempSync(join(tmpdir(), "reqora-build-mcp-"));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(dir, "workspace.db"));
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE entity (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, parent_id TEXT,
      folder_path TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
      method TEXT, url TEXT, protocol TEXT, auth TEXT,
      position INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
      case_group TEXT, sub_kind TEXT, updated_at INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE history (id TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE trash (id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE request_revision (
      request_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL,
      data TEXT NOT NULL, PRIMARY KEY (request_id, id)
    );
  `);
  db.prepare("INSERT INTO meta (key, value) VALUES ('settings', ?)").run(
    JSON.stringify({ timeoutSecs: 5, followRedirects: true }),
  );
  db.prepare(
    `INSERT INTO entity (id, kind, parent_id, folder_path, name, method, url, protocol,
      position, enabled, case_group, sub_kind, updated_at, deleted, data)
     VALUES ('req-1', 'request', NULL, '', '取用户', 'GET', 'https://example.test/users/:id', 'http',
      0, 1, NULL, NULL, 1, 0, '{}')`,
  ).run();
  db.close();
  return dir;
}

async function main() {
  console.log(`[build-mcp] 打包 ${version}：bin/mcp.mjs → dist-mcp/mcp.mjs`);
  const started = Date.now();
  const code = await bundle();

  removeBestEffort(outDir);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, code, "utf8");
  writeFileSync(join(outDir, "package.json"), `${JSON.stringify(standalonePackageJson(), null, 2)}\n`, "utf8");
  writeFileSync(join(outDir, "README.md"), standaloneReadme(), "utf8");
  const sidecar = copySidecar();
  if (sidecar) console.log(`[build-mcp] 已随包分发 Rust sidecar：${sidecar}`);

  const kb = (statSync(outFile).size / 1024).toFixed(1);
  console.log(`[build-mcp] 产物 ${(Date.now() - started) / 1000}s：${outFile}（${kb} KB）`);

  if (!process.argv.includes("--check")) return;

  // Smoke test: --help, --config, and one JSON-RPC handshake over stdio —
  // all against a throwaway project so no desktop data is required.
  const workspace = await makeTempProject();
  const withWorkspace = ["--workspace", workspace];
  const check = (argv, input) =>
    spawnSync(process.execPath, [outFile, ...withWorkspace, ...argv], {
      input,
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
  let failed = false;
  const help = check(["--help"]);
  failed ||= help.status !== 0 || !help.stdout.includes("reqora mcp");
  const config = check(["--config"]);
  failed ||= config.status !== 0 || !config.stdout.includes('"mcpServers"');
  const handshake = check(
    [],
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "build-check", version: "0" } } })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
  );
  const toolsOk =
    handshake.status === 0 &&
    handshake.stdout.includes('"serverInfo"') &&
    handshake.stdout.includes('"tools"');
  failed ||= !toolsOk;

  if (failed) {
    console.error("[build-mcp] 冒烟测试未通过");
    for (const [name, result] of [["--help", help], ["--config", config], ["stdio", handshake]]) {
      console.error(`--- ${name} (exit=${result.status})\n${(result.stderr || result.stdout || "").slice(0, 800)}`);
    }
    process.exit(1);
  }
  const toolCount = (handshake.stdout.match(/"name":"reqora_/g) ?? []).length;
  console.log(`[build-mcp] 冒烟测试通过：--help / --config / stdio 握手（tools/list 返回 ${toolCount} 个工具）`);
  removeBestEffort(workspace);
}

main().catch((error) => {
  console.error(`[build-mcp] 失败：${error?.stack ?? error}`);
  process.exit(1);
});
