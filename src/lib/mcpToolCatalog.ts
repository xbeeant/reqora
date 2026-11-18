/**
 * Single source of truth for the MCP tool catalog.
 *
 * Consumers:
 * - `bin/mcpServer.mjs` registers the tools and asserts these counts at startup.
 * - `bin/mcp.mjs --config` and `src/lib/mcpExpose.ts` render the desktop's
 *   "对外提供" panel and the CLI config snippets.
 *
 * Keep this module free of Node-only imports: it is bundled into the WebView
 * as well as loaded by Node 22's native TypeScript support.
 */

export interface McpToolSummary {
  total: number;
  readOnly: number;
  write: number;
}

/** 19 read/run tools are always listed (15 + 4 evidence-chain readers);
 * the 7 write tools need --allow-write. */
export const MCP_TOOL_SUMMARY: McpToolSummary = {
  total: 26,
  readOnly: 19,
  write: 7,
};

/** Names of the tools that are hidden and rejected without --allow-write. */
export const MCP_WRITE_TOOL_NAMES = [
  "reqora_create_request",
  "reqora_update_request",
  "reqora_delete_request",
  "reqora_create_case",
  "reqora_update_case",
  "reqora_create_scenario",
  "reqora_update_scenario",
] as const;
