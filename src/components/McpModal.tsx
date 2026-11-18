import { useState } from "react";
import { EMPTY_MCP_SERVERS } from "../lib/defaults.ts";
import {
  Plug,
  PlugZap,
  Play,
  Plus,
  Server,
  Share2,
  Trash2,
  Unplug,
  Wrench,
} from "lucide-react";
import { t, useT } from "../i18n";
import { useWorkspace } from "../store/workspace";
import type { McpServerConfig } from "../types";
import { Badge, Button, Modal, Spinner, TabButton, inputClass } from "./ui";
import { McpExposePanel } from "./McpExposePanel.tsx";

/** 空白服务器配置。 */
function emptyServer(): McpServerConfig {
  return {
    name: "",
    transport: "stdio",
    command: "npx",
    args: [],
    env: {},
    url: "",
    headers: {},
  };
}

/** "K=V" 行 → Record；忽略空行与没有 = 的行。 */
function parseKvLines(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return result;
}

/** Record → 按 key 排序的 "K=V" 行。 */
function formatKvLines(record: Record<string, string>): string {
  return Object.entries(record)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/** 编辑表单的本地形态（args/env/headers 用文本域承载）。 */
interface ServerForm {
  name: string;
  transport: "stdio" | "http";
  command: string;
  argsText: string;
  envText: string;
  url: string;
  headersText: string;
}

function toForm(server: McpServerConfig): ServerForm {
  return {
    name: server.name,
    transport: server.transport,
    command: server.command,
    argsText: server.args.join("\n"),
    envText: formatKvLines(server.env),
    url: server.url,
    headersText: formatKvLines(server.headers),
  };
}

function fromForm(form: ServerForm): McpServerConfig {
  return {
    name: form.name.trim(),
    transport: form.transport,
    command: form.command.trim(),
    args: form.argsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
    env: parseKvLines(form.envText),
    url: form.url.trim(),
    headers: parseKvLines(form.headersText),
  };
}

/**
 * 编辑后写回服务器列表（纯函数，便于测试）：
 * - 用 editing（旧名）定位并替换，而不是用新名判重；改名不会残留旧记录。
 * - 改成另一个已存在名称时返回冲突，绝不静默覆盖别人的配置。
 * - editing 为空串 / null 表示新建。
 */
export function upsertMcpServer(
  servers: readonly McpServerConfig[],
  editing: string | null,
  next: McpServerConfig,
): { ok: true; servers: McpServerConfig[] } | { ok: false; error: string } {
  const oldIndex =
    editing && editing !== "" ? servers.findIndex((item) => item.name === editing) : -1;
  // 目标名是否被「非本次编辑的记录」占用。
  const nameTaken = servers.some(
    (item, index) => index !== oldIndex && item.name === next.name,
  );
  if (nameTaken) {
    return { ok: false, error: t("tools.mcp.nameTaken", { name: next.name }) };
  }
  if (oldIndex === -1) {
    return { ok: true, servers: [...servers, next] };
  }
  const updated = servers.slice();
  updated[oldIndex] = next;
  return { ok: true, servers: updated };
}

export function McpModal() {
  const t = useT();
  const open = useWorkspace((state) => state.mcpModalOpen);
  const setOpen = useWorkspace((state) => state.setMcpModalOpen);
  const servers = useWorkspace((state) => state.snapshot.mcpServers ?? EMPTY_MCP_SERVERS);
  const connections = useWorkspace((state) => state.mcpConnections);
  const mcpBusy = useWorkspace((state) => state.mcpBusy);
  const mcpError = useWorkspace((state) => state.mcpError);
  const mcpCallResult = useWorkspace((state) => state.mcpCallResult);
  const saveMcpServers = useWorkspace((state) => state.saveMcpServers);
  const mcpConnect = useWorkspace((state) => state.mcpConnect);
  const mcpDisconnect = useWorkspace((state) => state.mcpDisconnect);
  const mcpCallTool = useWorkspace((state) => state.mcpCallTool);
  const clearMcpCallResult = useWorkspace((state) => state.clearMcpCallResult);

  /** 正在编辑的服务器名；null = 列表视图。空串 = 新建。 */
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<ServerForm>(toForm(emptyServer()));
  /** 改名冲突等表单级错误（就地展示，不走 store 的连接错误）。 */
  const [editError, setEditError] = useState<string | null>(null);
  /** 展开工具列表的连接名。 */
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 正在调用工具的参数 JSON 文本。 */
  const [toolArgs, setToolArgs] = useState<Record<string, string>>({});
  /** 两个方向：连别人的服务器 / 把自己交给 AI。 */
  const [view, setView] = useState<"servers" | "expose">("servers");

  const close = () => {
    setEditing(null);
    setEditError(null);
    setExpanded(null);
    setToolArgs({});
    setView("servers");
    clearMcpCallResult();
    setOpen(false);
  };

  const startAdd = () => {
    setForm(toForm(emptyServer()));
    setEditError(null);
    setEditing("");
  };
  const startEdit = (server: McpServerConfig) => {
    setForm(toForm(server));
    setEditError(null);
    // 记住旧名，保存时按旧名定位替换，避免改名变成追加。
    setEditing(server.name);
  };

  const saveServer = () => {
    const server = fromForm(form);
    if (!server.name) return;
    const result = upsertMcpServer(servers, editing, server);
    if (!result.ok) {
      setEditError(result.error);
      return;
    }
    setEditError(null);
    saveMcpServers(result.servers);
    setEditing(null);
  };

  const deleteServer = (name: string) => {
    void mcpDisconnect(name);
    saveMcpServers(servers.filter((item) => item.name !== name));
    if (expanded === name) setExpanded(null);
  };

  const patchForm = (patch: Partial<ServerForm>) =>
    setForm((current) => ({ ...current, ...patch }));

  // ---- 编辑视图 ----
  if (editing !== null) {
    return (
      <Modal
        open={open}
        title={editing ? t("tools.mcp.editTitle", { name: editing }) : t("tools.mcp.addTitle")}
        description={t("tools.mcp.editDesc")}
        onClose={() => {
          setEditing(null);
          setEditError(null);
        }}
        width="max-w-xl"
        footer={
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={saveServer} disabled={!form.name.trim()}>
              {t("tools.common.save")}
            </Button>
            <Button
              onClick={() => {
                setEditing(null);
                setEditError(null);
              }}
            >
              {t("tools.common.cancel")}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          {editError && (
            <p className="rounded border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-600">
              {editError}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs text-ink-soft">{t("tools.mcp.name")}</span>
              <input
                className={inputClass}
                value={form.name}
                placeholder="filesystem"
                onChange={(event) => patchForm({ name: event.target.value })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-ink-soft">{t("tools.mcp.transport")}</span>
              <select
                className={inputClass}
                value={form.transport}
                onChange={(event) =>
                  patchForm({ transport: event.target.value as "stdio" | "http" })
                }
              >
                <option value="stdio">{t("tools.mcp.transportStdio")}</option>
                <option value="http">{t("tools.mcp.transportHttp")}</option>
              </select>
            </label>
          </div>

          {form.transport === "stdio" ? (
            <>
              <label className="block">
                <span className="mb-1 block text-xs text-ink-soft">{t("tools.mcp.command")}</span>
                <input
                  className={inputClass}
                  value={form.command}
                  placeholder="npx / node / python ..."
                  onChange={(event) => patchForm({ command: event.target.value })}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-ink-soft">{t("tools.mcp.args")}</span>
                <textarea
                  className={`${inputClass} h-20 font-mono text-xs`}
                  value={form.argsText}
                  placeholder={"-y\n@modelcontextprotocol/server-everything"}
                  onChange={(event) => patchForm({ argsText: event.target.value })}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-ink-soft">{t("tools.mcp.env")}</span>
                <textarea
                  className={`${inputClass} h-16 font-mono text-xs`}
                  value={form.envText}
                  placeholder="API_KEY=xxx"
                  onChange={(event) => patchForm({ envText: event.target.value })}
                />
              </label>
            </>
          ) : (
              <>
                <label className="block">
                  <span className="mb-1 block text-xs text-ink-soft">{t("tools.mcp.url")}</span>
                  <input
                    className={`${inputClass} font-mono text-xs`}
                    value={form.url}
                    placeholder="https://example.com/mcp"
                    onChange={(event) => patchForm({ url: event.target.value })}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-ink-soft">{t("tools.mcp.headers")}</span>
                  <textarea
                    className={`${inputClass} h-16 font-mono text-xs`}
                    value={form.headersText}
                    placeholder="Authorization=Bearer xxx"
                    onChange={(event) => patchForm({ headersText: event.target.value })}
                  />
                </label>
              </>
            )}
          </div>
        </Modal>
      );
    }

    // ---- 列表视图 ----
    return (
      <Modal
        open={open}
        title="MCP"
        description={
          view === "servers"
            ? t("tools.mcp.descServers")
            : t("tools.mcp.descExpose")
        }
        onClose={close}
        width="max-w-2xl"
        footer={
          <div className="flex items-center gap-2">
            {view === "servers" && (
              <Button onClick={startAdd}>
                <Plus className="h-3.5 w-3.5" />
                {t("tools.mcp.addServer")}
              </Button>
            )}
            <Button variant="primary" onClick={close}>
              {t("tools.common.done")}
            </Button>
          </div>
        }
      >
        <div className="mb-3 flex items-center gap-1 border-b border-surface-border">
          <TabButton active={view === "servers"} onClick={() => setView("servers")}>
            <Plug className="h-3 w-3" />
            {t("tools.mcp.tabServers")}
          </TabButton>
          <TabButton active={view === "expose"} onClick={() => setView("expose")}>
            <Share2 className="h-3 w-3" />
            {t("tools.mcp.tabExpose")}
          </TabButton>
        </div>

        {view === "expose" ? (
          <McpExposePanel />
        ) : (
        <div className="space-y-3">
          {mcpError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              {mcpError}
            </div>
          )}

          {servers.length === 0 && (
            <div className="rounded-lg border border-dashed border-surface-border px-4 py-8 text-center">
              <Server className="mx-auto mb-2 h-6 w-6 text-ink-faint" />
              <p className="text-xs text-ink-soft">
                {t("tools.mcp.empty")}
              </p>
            </div>
          )}

          {servers.map((server) => {
            const connection = connections[server.name];
            const connected = Boolean(connection);
            const busy = mcpBusy === server.name;
            const isOpen = expanded === server.name;
            return (
              <div
                key={server.name}
                className="rounded-lg border border-surface-border bg-surface"
              >
                <div className="flex items-center gap-2 px-3 py-2">
                  <Plug
                    className={`h-4 w-4 shrink-0 ${connected ? "text-emerald-500" : "text-ink-faint"}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs font-semibold text-ink">
                        {server.name}
                      </span>
                      <Badge tone={connected ? "success" : "neutral"}>
                        {busy
                          ? t("tools.mcp.connecting")
                          : connected
                            ? t("tools.mcp.connected", { count: connection.tools.length })
                            : t("tools.mcp.disconnected")}
                      </Badge>
                      <span className="text-2xs text-ink-faint">
                        {server.transport === "stdio" ? server.command : server.url}
                      </span>
                    </div>
                    {connection?.serverInfo && (
                      <p className="truncate text-2xs text-ink-faint">
                        server: {connection.serverInfo}
                      </p>
                    )}
                  </div>
                  {busy && <Spinner className="h-3.5 w-3.5" />}
                  {connected ? (
                    <>
                      <Button size="sm" onClick={() => setExpanded(isOpen ? null : server.name)}>
                        <Wrench className="h-3 w-3" />
                        {t("tools.mcp.tools")}
                      </Button>
                      <Button size="sm" onClick={() => void mcpDisconnect(server.name)}>
                        <Unplug className="h-3 w-3" />
                        {t("tools.mcp.disconnect")}
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy}
                      onClick={() => void mcpConnect(server)}
                    >
                      <PlugZap className="h-3 w-3" />
                      {t("tools.mcp.connect")}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => startEdit(server)}>
                    {t("tools.common.edit")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => deleteServer(server.name)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>

                {isOpen && connection && (
                  <div className="border-t border-surface-border px-3 py-2">
                    {mcpCallResult && mcpCallResult.server === server.name && (
                      <div className="mb-3 rounded-md border border-surface-border bg-surface-sunken p-2">
                        <p className="mb-1 text-2xs text-ink-faint">
                          {t("tools.mcp.toolResult", { tool: mcpCallResult.tool })}
                          {mcpCallResult.outcome.isError && (
                            <span className="ml-1 text-red-600">{t("tools.mcp.isError")}</span>
                          )}
                        </p>
                        <pre className="scrollbar-thin max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-2xs text-ink">
                          {mcpCallResult.outcome.text || t("tools.mcp.emptyResult")}
                        </pre>
                      </div>
                    )}
                    {connection.tools.length === 0 && (
                      <p className="py-2 text-2xs text-ink-faint">{t("tools.mcp.noTools")}</p>
                    )}
                    <div className="space-y-2">
                      {connection.tools.map((tool) => {
                        const argsKey = `${server.name}:${tool.name}`;
                        const argsText = toolArgs[argsKey] ?? "{}";
                        return (
                          <div key={tool.name} className="rounded-md border border-surface-border p-2">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs font-semibold text-ink">
                                {tool.name}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-2xs text-ink-faint">
                                {tool.description ?? ""}
                              </span>
                              <Button
                                size="sm"
                                variant="primary"
                                disabled={busy}
                                onClick={() => {
                                  clearMcpCallResult();
                                  let args: Record<string, unknown> = {};
                                  try {
                                    const parsed = JSON.parse(argsText) as unknown;
                                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                                      args = parsed as Record<string, unknown>;
                                    }
                                  } catch {
                                    // 非法 JSON 按空参数处理；结果显示后可再修改重试。
                                    setToolArgs((current) => ({
                                      ...current,
                                      [argsKey]: "{}",
                                    }));
                                  }
                                  void mcpCallTool(server.name, tool.name, args);
                                }}
                              >
                                <Play className="h-3 w-3" />
                                {t("tools.mcp.call")}
                              </Button>
                            </div>
                            <textarea
                              className={`${inputClass} mt-1.5 h-14 font-mono text-2xs`}
                              aria-label={t("tools.mcp.toolArgsAria", { tool: tool.name })}
                              value={argsText}
                              onChange={(event) =>
                                setToolArgs((current) => ({
                                  ...current,
                                  [argsKey]: event.target.value,
                                }))
                              }
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
