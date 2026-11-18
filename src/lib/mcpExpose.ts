/**
 * Ready-to-paste MCP client configs for exposing *this* workspace to an AI
 * client (the reverse direction of `McpModal`'s server list).
 *
 * `bin/mcp.mjs --config` consumes this same module, so CLI snippets and the
 * desktop panel can never drift apart:
 * - `--workspace <dir>` picks the project (omitted → desktop's active project)
 * - `--allow-write` adds the write tools; without it they are not even listed
 * - `--reveal-secrets` returns real auth values instead of `***`
 *   (except variables the user explicitly marked 私密 / private in the UI)
 * - `--env <name>` pins the default environment
 *
 * Everything here is a pure function over plain strings so it can be unit
 * tested without a DOM.
 */

export type McpClientId = "claudeCode" | "claudeDesktop" | "cursor" | "vscode";

export interface McpExposeOptions {
  /** Interpreter or package runner, e.g. `node` / `npx`. */
  command: string;
  /** Arguments before the flags, e.g. `["/repo/bin/mcp.mjs"]`. */
  entryArgs: string[];
  /** Absolute project data directory. */
  workspace: string;
  allowWrite?: boolean;
  revealSecrets?: boolean;
  /** Default environment name. */
  environment?: string;
}

export interface McpSnippet {
  id: McpClientId;
  label: string;
  language: "shell" | "json";
  /** Where the client keeps this config. */
  location: string;
  hint: string;
  text: string;
}

/** Server key used by every client config. */
export const MCP_SERVER_NAME = "reqora";

// Tool counts live in one place, shared with the MCP server itself (which
// asserts the numbers at startup). Re-exported so existing UI imports keep
// working.
export { MCP_TOOL_SUMMARY } from "./mcpToolCatalog.ts";
export type { McpToolSummary } from "./mcpToolCatalog.ts";

/** `entryArgs` + the flags this workspace needs, in a stable order. */
export function mcpServerArgs(options: McpExposeOptions): string[] {
  const args = [...options.entryArgs];
  const workspace = options.workspace.trim();
  if (workspace) args.push("--workspace", workspace);
  const environment = options.environment?.trim();
  if (environment) args.push("--env", environment);
  if (options.revealSecrets) args.push("--reveal-secrets");
  if (options.allowWrite) args.push("--allow-write");
  return args;
}

/** Quote for a POSIX shell only when the value would otherwise split. */
export function shellQuote(value: string): string {
  if (value !== "" && /^[\w@%+=:,./-]+$/u.test(value)) return value;
  return `"${value.replace(/(["\\$`])/gu, "\\$1")}"`;
}

/** The `{ command, args }` shape shared by Claude / Cursor / VS Code. */
export function mcpStdioEntry(options: McpExposeOptions): { command: string; args: string[] } {
  return {
    command: options.command.trim() || "node",
    args: mcpServerArgs(options),
  };
}

export function buildMcpSnippets(options: McpExposeOptions): McpSnippet[] {
  const entry = mcpStdioEntry(options);
  const commandLine = [entry.command, ...entry.args].map(shellQuote).join(" ");
  const json = (payload: unknown) => JSON.stringify(payload, null, 2);

  return [
    {
      id: "claudeCode",
      label: "Claude Code",
      language: "shell",
      location: "终端执行一次，写入 ~/.claude.json",
      hint: "在项目根目录执行，重开会话即可看到 reqora_* 工具。",
      text: `claude mcp add ${MCP_SERVER_NAME} -- ${commandLine}`,
    },
    {
      id: "claudeDesktop",
      label: "Claude Desktop",
      language: "json",
      location: "~/Library/Application Support/Claude/claude_desktop_config.json",
      hint: "合并进已有的 mcpServers，保存后重启 Claude。",
      text: json({ mcpServers: { [MCP_SERVER_NAME]: entry } }),
    },
    {
      id: "cursor",
      label: "Cursor",
      language: "json",
      location: "<项目>/.cursor/mcp.json（或全局 ~/.cursor/mcp.json）",
      hint: "保存后在 Settings → MCP 里点刷新。",
      text: json({ mcpServers: { [MCP_SERVER_NAME]: entry } }),
    },
    {
      id: "vscode",
      label: "VS Code",
      language: "json",
      location: "<项目>/.vscode/mcp.json",
      hint: "保存后命令面板执行 MCP: List Servers，再 Start Server。",
      text: json({ servers: { [MCP_SERVER_NAME]: { type: "stdio", ...entry } } }),
    },
  ];
}

/** Which snippet the user last looked at; falls back to the first entry. */
export function pickSnippet(
  snippets: McpSnippet[],
  id: string | null | undefined,
): McpSnippet {
  return snippets.find((item) => item.id === id) ?? snippets[0];
}
