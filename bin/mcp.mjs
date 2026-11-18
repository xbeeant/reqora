#!/usr/bin/env node
// Reqora MCP server entry — stdio transport for AI clients.
//
// Usage (from an AI client's MCP config):
//   node /path/to/reqora/bin/mcp.mjs --workspace "/path/to/project" [--allow-write]
//
// Usage (human):
//   reqora mcp --help
//   reqora mcp --config            # print ready-to-paste client config
//   reqora mcp                     # start the server on stdin/stdout
//
// Protocol: Model Context Protocol over stdio — newline-delimited JSON-RPC 2.0.
// stdout carries protocol frames ONLY; every log line goes to stderr.

import process from "node:process";
import readline from "node:readline";

import { buildMcpSnippets, mcpStdioEntry, MCP_SERVER_NAME } from "../src/lib/mcpExpose.ts";
import { parseArgs as parseCliArgs } from "./cliArgs.mjs";
import { createMcpServer } from "./mcpServer.mjs";
import { createMessageQueue } from "./mcpIo.mjs";
import { createMcpLogger } from "./mcpLogger.mjs";
import { WorkspaceStore, appDataDir } from "./workspaceStore.mjs";

/** Option spec shared with `bin/reqora.mjs` (single parseArgs implementation). */
const ARGS_SPEC = {
  defaults: {
    workspace: null,
    allowWrite: process.env.REQORA_MCP_ALLOW_WRITE === "1",
    maxBodyBytes: 16_384,
    environment: null,
    revealSecrets: false,
    config: false,
    help: false,
  },
  options: [
    {
      key: "workspace",
      flags: ["--workspace", "-w"],
      value: true,
      label: "<路径>",
      description: "项目数据目录 / 项目 id / 项目名（默认用桌面端当前项目）",
    },
    {
      key: "allowWrite",
      flags: ["--allow-write"],
      description: "允许修改数据（新建/修改/删除接口、用例、场景）",
    },
    {
      key: "maxBodyBytes",
      flags: ["--max-body-bytes"],
      value: true,
      label: "<n>",
      coerce: (raw, args) => Number(raw) || args.maxBodyBytes,
      description: "响应体截断字节数，默认 16384",
    },
    { key: "environment", flags: ["--env"], value: true, label: "<名称>", description: "默认环境" },
    {
      key: "revealSecrets",
      flags: ["--reveal-secrets"],
      description: "返回真实鉴权/变量值（默认打码）",
    },
    { key: "config", flags: ["--config"], description: "打印 AI 客户端可粘贴的 MCP 配置" },
    { key: "help", flags: ["--help", "-h"], description: "显示帮助" },
  ],
};

const parseArgs = (argv) => parseCliArgs(argv, ARGS_SPEC);

function usage() {
  return `Reqora MCP 服务（把接口管理、用例管理、自动执行、场景编排交给 AI 调用）

用法：
  reqora mcp [选项]

选项：
  -w, --workspace <路径>   项目数据目录 / 项目 id / 项目名（默认用桌面端当前项目）
      --allow-write        允许修改数据（新建/修改/删除接口、用例、场景）
      --env <名称>          默认环境
      --max-body-bytes <n> 响应体截断字节数，默认 16384
      --reveal-secrets     返回真实鉴权/变量值（默认打码；勾选「私密」的变量除外）
      --config             打印 AI 客户端可粘贴的 MCP 配置
  -h, --help

环境变量：
  REQORA_WORKSPACE 同 --workspace
  REQORA_MCP_ALLOW_WRITE=1                       同 --allow-write

客户端配置示例（Claude Desktop / Claude Code / Cursor / VS Code 通用）：
  {
    "mcpServers": {
      "reqora": {
        "command": "node",
        "args": ["${process.argv[1]}", "--workspace", "${appDataDir() ?? "<项目目录>"}/projects/default"]
      }
    }
  }

数据位置（macOS）：~/Library/Application Support/com.xbeeant.reqora/projects/<项目 id>/workspace.db
只读工具不需要 --allow-write；写入会递增共享工作区版本号，桌面端打开同一项目时会自动检测冲突，并提示刷新（保留外部改动）或备份后覆盖，不会再静默覆盖。
`;
}

/** Same snippets as the desktop "对外提供" panel — one implementation. */
function configSnippet(args) {
  const options = {
    command: "node",
    entryArgs: [process.argv[1]],
    workspace: args.workspace ?? "",
    environment: args.environment ?? "",
    revealSecrets: args.revealSecrets,
    allowWrite: args.allowWrite,
  };
  const snippets = buildMcpSnippets(options);
  const byId = Object.fromEntries(snippets.map((snippet) => [snippet.id, snippet.text]));
  const withoutWorkspace = mcpStdioEntry({ ...options, workspace: "" });
  return {
    说明:
      "把下面任一片段合并进 AI 客户端的 MCP 配置。省略 --workspace 时使用桌面端当前项目；客户端与服务不在同一台机器时请显式写出绝对路径。",
    claudeDesktopAndCursor: { mcpServers: { [MCP_SERVER_NAME]: withoutWorkspace } },
    claudeCode: byId.claudeCode,
    vscode: JSON.parse(byId.vscode),
    npm: { mcpServers: { [MCP_SERVER_NAME]: { command: "npx", args: ["-y", "reqora", "mcp"] } } },
    tools: `启动后客户端会列出 ${MCP_SERVER_NAME}_* 工具；先调 ${MCP_SERVER_NAME}_workspace_overview 熟悉项目。`,
    safety: "默认只读；写入需加 --allow-write，且建议在桌面端关闭该项目时使用。",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args.config) {
    process.stdout.write(`${JSON.stringify(configSnippet(args), null, 2)}\n`);
    return;
  }

  // Persistent log next to the desktop app's errors.log: stdout belongs to
  // the MCP protocol and most clients hide stderr, so every startup and
  // failure must also be inspectable on disk.
  const logger = createMcpLogger({ echo: false });

  let store;
  try {
    store = WorkspaceStore.open(args.workspace, { allowWrite: args.allowWrite });
  } catch (error) {
    logger.error("startup.failed", error?.message ?? String(error));
    process.stderr.write(`[reqora-mcp] ${error.message}\n`);
    process.exit(2);
  }

  const server = createMcpServer({
    store,
    allowWrite: args.allowWrite,
    logger,
    defaults: {
      environment: args.environment,
      maxBodyBytes: args.maxBodyBytes,
      revealSecrets: args.revealSecrets,
    },
  });

  const log = (message) => process.stderr.write(`[reqora-mcp] ${message}\n`);
  const startup = `项目 ${store.projectName ?? store.projectId ?? "?"} → ${store.path}（${store.kind}，` +
    `${server.toolCount} 个工具，写入${args.allowWrite ? "已开启" : "关闭"}）`;
  logger.info("server.start", startup);
  log(startup);

  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  // Serialize handling: tools run network calls, and stdout frames must not
  // interleave in a different order than they were requested. The queue also
  // turns any handler failure into a JSON-RPC error frame.
  const io = createMessageQueue({ handle: (message) => server.handle(message), write, log });
  rl.on("line", (line) => io.enqueue(line));

  const shutdown = () => {
    io.settled.finally(() => {
      store.close();
      process.exit(0);
    });
  };
  rl.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (process.stdin.isTTY) {
    log("检测到交互式终端：本服务应由 AI 客户端通过 stdio 启动。仍然继续读取 stdin。");
  }
}

main().catch((error) => {
  process.stderr.write(`[reqora-mcp] 启动失败：${error?.stack ?? error}\n`);
  process.exit(1);
});
