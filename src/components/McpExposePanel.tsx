import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, ShieldCheck } from "lucide-react";
import { useT } from "../i18n";
import { useWorkspace } from "../store/workspace.ts";
import {
  MCP_TOOL_SUMMARY,
  buildMcpSnippets,
  pickSnippet,
} from "../lib/mcpExpose.ts";
import { Badge, Button, TabButton, inputClass } from "./ui";

/**
 * “对外提供”页签：把当前项目以 MCP 服务的形式交给 AI 客户端。
 *
 * 与上面的服务器列表方向相反——那边是 Reqora 连别人，这里是别人连 Reqora。
 * 片段由 `lib/mcpExpose.ts` 生成，参数顺序与 `bin/mcp.mjs` 的解析保持一致。
 */

const KEYS = {
  command: "reqora.mcp.expose.command",
  args: "reqora.mcp.expose.args",
  allowWrite: "reqora.mcp.expose.write",
  revealSecrets: "reqora.mcp.expose.secrets",
  environment: "reqora.mcp.expose.env",
  client: "reqora.mcp.expose.client",
} as const;

const DEFAULT_ARGS = "";

function readStored(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 隐私模式 / 配额满：忽略即可，配置本身仍可用，只是不被记住。
  }
}

export function McpExposePanel() {
  const t = useT();
  const projectsState = useWorkspace((state) => state.projectsState);

  const [command, setCommand] = useState(() => readStored(KEYS.command, "node"));
  const [argsText, setArgsText] = useState(() => readStored(KEYS.args, DEFAULT_ARGS));
  const [allowWrite, setAllowWrite] = useState(() => readStored(KEYS.allowWrite, "0") === "1");
  const [revealSecrets, setRevealSecrets] = useState(
    () => readStored(KEYS.revealSecrets, "0") === "1",
  );
  const [environment, setEnvironment] = useState(() => readStored(KEYS.environment, ""));
  const [clientId, setClientId] = useState<string>(() =>
    readStored(KEYS.client, "claudeDesktop"),
  );
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => writeStored(KEYS.command, command), [command]);
  useEffect(() => writeStored(KEYS.args, argsText), [argsText]);
  useEffect(() => writeStored(KEYS.allowWrite, allowWrite ? "1" : "0"), [allowWrite]);
  useEffect(() => writeStored(KEYS.revealSecrets, revealSecrets ? "1" : "0"), [revealSecrets]);
  useEffect(() => writeStored(KEYS.environment, environment), [environment]);
  useEffect(() => writeStored(KEYS.client, clientId), [clientId]);
  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const workspace = projectsState?.dataDirectory ?? "";
  const activeProject =
    projectsState?.projects.find((item) => item.id === projectsState.activeProjectId) ?? null;
  const entryArgs = useMemo(
    () =>
      argsText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    [argsText],
  );

  const snippets = useMemo(
    () =>
      buildMcpSnippets({
        command,
        entryArgs,
        workspace,
        allowWrite,
        revealSecrets,
        environment,
      }),
    [command, entryArgs, workspace, allowWrite, revealSecrets, environment],
  );
  const active = pickSnippet(snippets, clientId);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(active.text);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => {
      setCopied(null);
      copyTimer.current = null;
    }, 1600);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-surface-border bg-surface-muted px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{t("tools.expose.currentProject")}</Badge>
          <span className="text-xs font-semibold text-ink">
            {activeProject?.name ?? t("tools.expose.notLoaded")}
          </span>
          <span
            className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-faint"
            title={workspace}
          >
            {workspace || t("tools.expose.dataDirUnknown")}
          </span>
        </div>
        <p className="mt-1.5 text-2xs text-ink-faint">
          {t("tools.expose.summary1", {
            total: MCP_TOOL_SUMMARY.total,
            readOnly: MCP_TOOL_SUMMARY.readOnly,
            write: MCP_TOOL_SUMMARY.write,
          })}
          <code className="font-mono">--allow-write</code>
          {t("tools.expose.summary2")}
        </p>
      </div>

      <div className="grid grid-cols-[128px_1fr] gap-3">
        <label className="block">
          <span className="mb-1 block text-xs text-ink-soft">{t("tools.expose.command")}</span>
          <input
            className={`${inputClass} font-mono text-xs`}
            value={command}
            placeholder="node"
            onChange={(event) => setCommand(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-ink-soft">
            {t("tools.expose.args")}
          </span>
          <textarea
            className={`${inputClass} h-16 font-mono text-xs`}
            value={argsText}
            placeholder={t("tools.expose.argsPlaceholder")}
            onChange={(event) => setArgsText(event.target.value)}
          />
        </label>
      </div>

      <div className="space-y-2">
        <label className="flex items-start gap-2 text-xs text-ink-soft">
          <input
            type="checkbox"
            className="mt-0.5 h-3.5 w-3.5 accent-brand-500"
            checked={allowWrite}
            onChange={(event) => setAllowWrite(event.target.checked)}
          />
          <span>
            {t("tools.expose.allowWrite")}（<code className="font-mono text-2xs">--allow-write</code>）
            <span className="block text-2xs text-ink-faint">
              {t("tools.expose.allowWriteHint")}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-xs text-ink-soft">
          <input
            type="checkbox"
            className="mt-0.5 h-3.5 w-3.5 accent-brand-500"
            checked={revealSecrets}
            onChange={(event) => setRevealSecrets(event.target.checked)}
          />
          <span>
            {t("tools.expose.revealSecrets")}（<code className="font-mono text-2xs">--reveal-secrets</code>）
            <span className="block text-2xs text-ink-faint">
              {t("tools.expose.revealSecretsHint")}
            </span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-xs text-ink-soft">
          <span className="shrink-0">
            {t("tools.expose.defaultEnv")}（<code className="font-mono text-2xs">--env</code>）
          </span>
          <input
            className={`${inputClass} h-7 max-w-56 font-mono text-2xs`}
            value={environment}
            placeholder={t("tools.expose.envPlaceholder")}
            onChange={(event) => setEnvironment(event.target.value)}
          />
        </label>
      </div>

      {entryArgs.length === 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-2xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {t("tools.expose.noEntry1")}{" "}
            <code className="font-mono">{t("tools.expose.repoScript")}</code>{" "}
            {t("tools.expose.noEntry2")} <code className="font-mono">npx</code>
            {t("tools.expose.noEntry3")}{" "}
            <code className="font-mono">-y reqora mcp</code>。
          </span>
        </div>
      )}

      <div className="rounded-lg border border-surface-border">
        <div className="scrollbar-thin flex items-center gap-1 overflow-x-auto border-b border-surface-border px-1">
          {snippets.map((snippet) => (
            <TabButton
              key={snippet.id}
              active={snippet.id === active.id}
              onClick={() => setClientId(snippet.id)}
            >
              {snippet.label}
            </TabButton>
          ))}
        </div>
        <div className="space-y-2 px-3 py-2.5">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="break-all font-mono text-2xs text-ink-faint">{active.location}</p>
              <p className="mt-0.5 text-2xs text-ink-soft">{active.hint}</p>
            </div>
            <Button size="sm" variant="primary" onClick={() => void copy()}>
              {copied === "ok" ? (
                <Check className="h-3 w-3" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
              {copied === "ok"
                ? t("tools.common.copied")
                : copied === "fail"
                  ? t("tools.common.copyFail")
                  : t("tools.common.copy")}
            </Button>
          </div>
          <pre
            className={`scrollbar-thin max-h-64 overflow-auto rounded-md border border-surface-border bg-surface-sunken p-2 font-mono text-2xs text-ink ${
              active.language === "shell" ? "whitespace-pre-wrap break-all" : ""
            }`}
          >
            {active.text}
          </pre>
        </div>
      </div>

      <p className="flex items-start gap-1.5 text-2xs text-ink-faint">
        <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" />
        <span>
          {t("tools.expose.security1")}
          <code className="font-mono">reqora mcp --config</code>
          {t("tools.expose.security2")}
        </span>
      </p>
    </div>
  );
}
