import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_SERVER_NAME,
  MCP_TOOL_SUMMARY,
  buildMcpSnippets,
  mcpServerArgs,
  mcpStdioEntry,
  pickSnippet,
  shellQuote,
} from "../src/lib/mcpExpose.ts";
import {
  MCP_TOOL_SUMMARY as CATALOG_SUMMARY,
  MCP_WRITE_TOOL_NAMES,
} from "../src/lib/mcpToolCatalog.ts";

const base = {
  command: "node",
  entryArgs: ["/repo/bin/mcp.mjs"],
  workspace: "/data/projects/default",
};

test("参数按 --workspace → --env → --reveal-secrets → --allow-write 排列", () => {
  assert.deepEqual(mcpServerArgs(base), ["/repo/bin/mcp.mjs", "--workspace", "/data/projects/default"]);
  assert.deepEqual(
    mcpServerArgs({ ...base, environment: "staging", revealSecrets: true, allowWrite: true }),
    [
      "/repo/bin/mcp.mjs",
      "--workspace",
      "/data/projects/default",
      "--env",
      "staging",
      "--reveal-secrets",
      "--allow-write",
    ],
  );
});

test("没有工作区路径时不生成空的 --workspace", () => {
  const args = mcpServerArgs({ ...base, workspace: "   " });
  assert.equal(args.includes("--workspace"), false);
});

test("启动命令留空时回落到 node", () => {
  assert.deepEqual(mcpStdioEntry({ ...base, command: "" }).command, "node");
});

test("shell 引用只为含空格或特殊字符的值加引号", () => {
  assert.equal(shellQuote("/repo/bin/mcp.mjs"), "/repo/bin/mcp.mjs");
  assert.equal(shellQuote("--allow-write"), "--allow-write");
  assert.equal(shellQuote("/Users/me/My Repo/bin/mcp.mjs"), '"/Users/me/My Repo/bin/mcp.mjs"');
  assert.equal(shellQuote('a"b'), '"a\\"b"');
});

test("四种客户端片段齐全，且 JSON 可解析", () => {
  const snippets = buildMcpSnippets({ ...base, allowWrite: true });
  assert.deepEqual(
    snippets.map((item) => item.id),
    ["claudeCode", "claudeDesktop", "cursor", "vscode"],
  );

  const desktop = JSON.parse(
    snippets.find((item) => item.id === "claudeDesktop").text,
  );
  assert.equal(desktop.mcpServers[MCP_SERVER_NAME].command, "node");
  assert.deepEqual(desktop.mcpServers[MCP_SERVER_NAME].args, [
    "/repo/bin/mcp.mjs",
    "--workspace",
    "/data/projects/default",
    "--allow-write",
  ]);

  const cursor = JSON.parse(snippets.find((item) => item.id === "cursor").text);
  assert.deepEqual(cursor.mcpServers[MCP_SERVER_NAME].args.at(-1), "--allow-write");

  const vscode = JSON.parse(snippets.find((item) => item.id === "vscode").text);
  assert.equal(vscode.servers[MCP_SERVER_NAME].type, "stdio");
  assert.equal(vscode.servers[MCP_SERVER_NAME].command, "node");
});

test("Claude Code 片段是一条可执行命令，含引号兜底", () => {
  const snippet = buildMcpSnippets({
    ...base,
    entryArgs: ["/Users/me/My Repo/bin/mcp.mjs"],
  }).find((item) => item.id === "claudeCode");
  assert.equal(snippet.language, "shell");
  assert.match(
    snippet.text,
    /^claude mcp add reqora -- node "\/Users\/me\/My Repo\/bin\/mcp\.mjs" --workspace \/data\/projects\/default$/u,
  );
});

test("选中的客户端失效时回落到第一个片段", () => {
  const snippets = buildMcpSnippets(base);
  assert.equal(pickSnippet(snippets, "nope").id, "claudeCode");
  assert.equal(pickSnippet(snippets, "vscode").id, "vscode");
});

test("工具数量口径从 catalog 动态推导，mcpExpose 与 catalog 对齐", () => {
  // catalog 是 single source of truth（mcpServer 启动时按它校验注册数量）。
  // mcpExpose 直接 re-export，二者必须完全一致，避免面板与服务端漂移。
  assert.deepEqual(MCP_TOOL_SUMMARY, CATALOG_SUMMARY);
  // 写入工具数由名字列表推导，不硬编码任何数字。
  assert.equal(CATALOG_SUMMARY.write, MCP_WRITE_TOOL_NAMES.length);
  // 三个字段必须自洽：任一字段单独漂移都会让下面的等式失败。
  assert.equal(CATALOG_SUMMARY.total, CATALOG_SUMMARY.readOnly + CATALOG_SUMMARY.write);
  assert.equal(MCP_TOOL_SUMMARY.readOnly, CATALOG_SUMMARY.total - MCP_WRITE_TOOL_NAMES.length);
  assert.ok(CATALOG_SUMMARY.readOnly > 0 && CATALOG_SUMMARY.write > 0 && CATALOG_SUMMARY.total > 0);
});
