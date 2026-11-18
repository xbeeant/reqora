// Regression coverage for two production complaints:
//   1. "写数据失败 / 无权限" with no log file to inspect.
//   2. MCP writes landed in a different data root than the desktop app.
//
// Kept in one file because both fixes are small, pure Node modules.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";

import { appDataDir, resolveDataRoot } from "../bin/workspaceStore.mjs";
import { createMcpLogger, mcpLogDir, mcpLogPath } from "../bin/mcpLogger.mjs";
import { createMcpServer } from "../bin/mcpServer.mjs";

const temp = () => mkdtempSync(join(tmpdir(), "reqora-diag-"));

// ------------------------------------------------------- data root alignment ----

test("appDataDir 与桌面端 lib.rs 一致：统一为 ~/.reqora", () => {
  assert.equal(appDataDir(), join(homedir(), ".reqora"));
  assert.equal(mcpLogDir(), join(homedir(), ".reqora", "logs"));
  assert.equal(mcpLogPath(), join(homedir(), ".reqora", "logs", "reqora-mcp.log"));
});

test("resolveDataRoot：无指针 / null / 自定义根 / 损坏指针", () => {
  const base = temp();
  assert.equal(resolveDataRoot(base), base);

  writeFileSync(join(base, "data_root.json"), JSON.stringify({ dataRoot: null }));
  assert.equal(resolveDataRoot(base), base);

  const moved = temp();
  writeFileSync(join(base, "data_root.json"), JSON.stringify({ dataRoot: moved }));
  assert.equal(resolveDataRoot(base), moved);

  writeFileSync(join(base, "data_root.json"), JSON.stringify({ dataRoot: "relative-root" }));
  assert.ok(isAbsolute(resolveDataRoot(base)));

  writeFileSync(join(base, "data_root.json"), "{ broken json");
  assert.equal(resolveDataRoot(base), base);
});

// ------------------------------------------------------------- MCP log file ----

test("createMcpLogger：每行一条 JSON、换行不会伪造日志行、可 tail", () => {
  const dir = temp();
  const logger = createMcpLogger({ dir, echo: false });
  logger.error("write.failed", "EACCES: permission denied", { tool: "reqora_create_case" });
  logger.info("server.log", "第一行\n第二行");

  const lines = logger.tail();
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.level, "error");
  assert.equal(first.source, "mcp");
  assert.equal(first.event, "write.failed");
  assert.equal(first.tool, "reqora_create_case");
  assert.ok(!lines[1].includes("\n"), "message 中的换行必须被 JSON 转义");
  assert.equal(JSON.parse(lines[1]).message, "第一行\n第二行");
});

test("createMcpLogger：超过上限时轮转，不因 .1 已存在而失败", () => {
  const dir = temp();
  const logger = createMcpLogger({ dir, echo: false });
  writeFileSync(logger.path, "x".repeat(2 * 1024 * 1024));
  writeFileSync(`${logger.path}.1`, "old");
  logger.info("server.log", "after rotation");

  assert.ok(existsSync(`${logger.path}.1`));
  assert.equal(readFileSync(`${logger.path}.1`, "utf8").length, 2 * 1024 * 1024);
  assert.equal(logger.tail().length, 1);
  assert.equal(logger.lastError, null);
});

// ------------------------------------------------- actionable write failures ----

/** A store that fails on read, enough to drive tools/call through its error path. */
function failingStore(message) {
  return {
    path: "/tmp/fake-project",
    projectId: "default",
    projectName: "测试项目",
    kind: "sqlite",
    readSnapshot: async () => {
      throw new Error(message);
    },
    readRev: async () => ({ rev: 1, writer: "mcp", updatedAt: 0 }),
  };
}

async function callTool(server, name) {
  return server.handle({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name, arguments: {} },
  });
}

test("写入失败返回体包含原因分类、处理建议与日志文件路径", async () => {
  const dir = temp();
  const logger = createMcpLogger({ dir, echo: false });
  const server = createMcpServer({
    store: failingStore("attempt to write a readonly database"),
    allowWrite: true,
    logger,
  });

  const response = await callTool(server, "reqora_workspace_overview");
  assert.equal(response.id, 7);
  assert.equal(response.result.isError, true);
  const text = response.result.content[0].text;
  assert.match(text, /原因：MCP 服务以只读方式运行/);
  assert.match(text, /处理建议：.*--allow-write/);
  assert.match(text, /错误日志：/);
  assert.ok(text.includes(logger.path));

  const logged = logger.tail().map((line) => JSON.parse(line));
  assert.ok(logged.some((row) => row.event === "tool.failed" && row.level === "error"));
});

test("缺 --allow-write 时，工具拒绝信息同样带修复建议并落盘", async () => {
  const dir = temp();
  const logger = createMcpLogger({ dir, echo: false });
  const server = createMcpServer({ store: failingStore("unused"), allowWrite: false, logger });

  const response = await callTool(server, "reqora_create_case");
  assert.equal(response.result.isError, true);
  const text = response.result.content[0].text;
  assert.match(text, /--allow-write/);
  assert.match(text, /错误日志：/);
  assert.ok(logger.tail().some((line) => JSON.parse(line).tool === "reqora_create_case"));
});
