import { useEffect, useMemo, useState } from "react";
import { EMPTY_DATA_MODELS } from "../lib/defaults.ts";
import { Copy, Globe, Play, RefreshCw, Server, Square, Wand2 } from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { useT } from "../i18n";
import { generateMockBody } from "../lib/docs.ts";
import { generateFromSchema, modelRefResolver, parseSchemaText } from "../lib/jsonschema";
import { mockUrlFor } from "../lib/mock.ts";
import { Button, Select, inputClass } from "./ui";
import type { MockRule } from "../types";

const METHOD_CLASS: Record<string, string> = {
  GET: "wb-method-get",
  POST: "wb-method-post",
  PUT: "wb-method-put",
  PATCH: "wb-method-patch",
  DELETE: "wb-method-delete",
  HEAD: "wb-method-head",
  OPTIONS: "wb-method-options",
};

function RulesTable({ rules, port }: { rules: MockRule[]; port: number | null }) {
  const t = useT();
  if (rules.length === 0) {
    return (
      <p className="wb-hint !py-6 text-center">
        {t("protocol.mock.noRules")}
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-surface-border">
      <table className="wb-table">
        <thead>
          <tr>
            <th className="!w-20">{t("protocol.mock.colMethod")}</th>
            <th>{t("protocol.mock.colPath")}</th>
            <th className="!w-16">{t("protocol.mock.colStatus")}</th>
            <th className="!w-44">{t("protocol.mock.colDesc")}</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.id}>
              <td>
                <span className={`wb-method !w-auto !text-[9px] ${METHOD_CLASS[rule.method] ?? ""}`}>
                  {rule.method}
                </span>
              </td>
              <td className="font-mono">
                <div className="flex items-center gap-1.5">
                  <span className="truncate" title={rule.path}>{rule.path}</span>
                  {rule.smart && <span className="wb-mini-badge">{t("protocol.mock.smart")}</span>}
                  {(rule.conditions?.length ?? 0) > 0 && (
                    <span
                      className="wb-mini-badge"
                      title={rule.conditions!
                        .map(
                          (condition) =>
                            `${condition.source}.${condition.key} ${condition.op} ${
                              condition.value || t("protocol.mock.exists")
                            }`,
                        )
                        .join("\n")}
                    >
                      {t("protocol.mock.conditions", { count: rule.conditions!.length })}
                    </span>
                  )}
                </div>
                {port != null && (
                  <button
                    type="button"
                    className="mt-0.5 block max-w-full truncate text-left text-[10px] text-brand-600 hover:underline"
                    title={t("protocol.mock.copyUrl")}
                    onClick={() => void navigator.clipboard.writeText(mockUrlFor(port, rule))}
                  >
                    {mockUrlFor(port, rule)}
                  </button>
                )}
              </td>
              <td className="font-mono text-[11px]">{rule.status}</td>
              <td className="truncate text-ink-faint" title={rule.description}>{rule.description || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Apifox-style Mock panel, two halves:
 * 1. Local mock server — one-click start/stop, rule table, access log.
 * 2. Zero-config mock data preview per interface.
 */
export function MockPanel() {
  const t = useT();
  const draft = useWorkspace((state) => state.draft);
  const doc = draft.doc;
  const models = useWorkspace((state) => state.snapshot.dataModels ?? EMPTY_DATA_MODELS);
  const mock = useWorkspace((state) => state.mock);
  const mockBusy = useWorkspace((state) => state.mockBusy);
  const mockError = useWorkspace((state) => state.mockError);
  const startMock = useWorkspace((state) => state.startMock);
  const stopMock = useWorkspace((state) => state.stopMock);
  const refreshMockStatus = useWorkspace((state) => state.refreshMockStatus);
  const getMockRules = useWorkspace((state) => state.getMockRules);

  const [exampleId, setExampleId] = useState<string>("");
  const [portInput, setPortInput] = useState("4523");
  const [rules, setRules] = useState<MockRule[]>([]);
  const [activeTab, setActiveTab] = useState<"server" | "preview">("server");

  const mockBody = useMemo(() => {
    if (!doc) return "";
    // Selected example bound to a data model: generate from the model schema
    // (falls back to the raw example body when the model is missing/broken).
    if (exampleId) {
      if (exampleId === "::requestModel") {
        const model = models.find((item) => item.id === doc.requestModelId);
        if (model) {
          const parsed = parseSchemaText(model.schemaText);
          if (parsed.schema) {
            return JSON.stringify(generateFromSchema(parsed.schema, modelRefResolver(models)), null, 2);
          }
        }
      }
      const example = doc.responses.find((item) => item.id === exampleId);
      const model = example?.modelId
        ? models.find((item) => item.id === example.modelId)
        : undefined;
      if (model) {
        const parsed = parseSchemaText(model.schemaText);
        if (parsed.schema) {
          return JSON.stringify(generateFromSchema(parsed.schema, modelRefResolver(models)), null, 2);
        }
      }
    }
    return generateMockBody(draft, doc, exampleId || undefined);
  }, [draft, doc, exampleId, models]);

  // Poll access log while the server is running (2s, matching Apifox's live feel).
  useEffect(() => {
    if (!mock.running) return;
    const timer = setInterval(() => void refreshMockStatus(), 2000);
    return () => clearInterval(timer);
  }, [mock.running, refreshMockStatus]);

  const refreshRules = () => setRules(getMockRules());
  useEffect(refreshRules, [getMockRules]);

  const start = () => {
    const port = Number.parseInt(portInput, 10);
    void startMock(Number.isFinite(port) ? port : 4523);
  };

  return (
    <div className="wb-mock scrollbar-thin">
      <div className="wb-mock-tabs">
        <button
          type="button"
          className={`wb-cfg-tab ${activeTab === "server" ? "active" : ""}`}
          onClick={() => setActiveTab("server")}
        >
          <Server className="h-3.5 w-3.5" />
          {t("protocol.mock.serverTab")}
          {mock.running && <span className="wb-mini-badge">{t("protocol.mock.running")}</span>}
        </button>
        <button
          type="button"
          className={`wb-cfg-tab ${activeTab === "preview" ? "active" : ""}`}
          onClick={() => setActiveTab("preview")}
        >
          <Wand2 className="h-3.5 w-3.5" />
          {t("protocol.mock.previewTab")}
        </button>
      </div>

      {activeTab === "server" && (
        <div className="wb-mock-server">
          <div className="wb-mock-toolbar">
            <span className={`wb-status-dot ${mock.running ? "" : "offline"}`} />
            <span className="text-xs font-semibold text-ink">
              {mock.running
                ? t("protocol.mock.serverRunning", { port: mock.port ?? 0 })
                : t("protocol.mock.notRunning")}
            </span>
            <span className="wb-chip !h-6 !cursor-default !px-2 !text-[10px]">
              {t("protocol.mock.servedCount", { count: mock.requestsServed })}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <input
                className={`${inputClass} !h-7 !w-24 !py-0 font-mono !text-[11px]`}
                value={portInput}
                disabled={mock.running}
                aria-label={t("protocol.mock.portAria")}
                onChange={(event) => setPortInput(event.target.value.replace(/\D/g, ""))}
                placeholder={t("protocol.mock.portPlaceholder")}
              />
              {mock.running ? (
                <Button size="sm" variant="danger" disabled={mockBusy} onClick={() => void stopMock()}>
                  <Square className="h-3.5 w-3.5" />
                  {t("protocol.mock.stop")}
                </Button>
              ) : (
                <Button size="sm" variant="primary" disabled={mockBusy} onClick={start}>
                  <Play className="h-3.5 w-3.5" />
                  {t("protocol.mock.start")}
                </Button>
              )}
              <Button size="sm" variant="ghost" title={t("protocol.mock.refresh")} onClick={refreshRules}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {mockError && (
            <div className="wb-banner wb-banner-danger">
              <Globe className="h-3.5 w-3.5" />
              {mockError}
            </div>
          )}

          {mock.running && (
            <div className="wb-chip !h-7 !cursor-default !gap-2 !text-[11px]">
              <Copy className="h-3 w-3" />
              {t("protocol.mock.requestHintPrefix")}
              <code className="font-mono text-brand-600">http://127.0.0.1:{mock.port}/…</code>
              {t("protocol.mock.requestHintSuffix")}
            </div>
          )}

          <RulesTable rules={rules} port={mock.port} />

          <div className="wb-hint">
            <Wand2 className="h-3.5 w-3.5 shrink-0" />
            <span>
              {t("protocol.mock.smartHint1")}
              <code className="mx-1 font-mono text-brand-600">@token</code>
              {t("protocol.mock.smartHint2")}
              <code className="font-mono">@cname @name @email @phone @idCard @integer(1,100) @float(0,100) @boolean @guid @url @ip @date @datetime @time @province @city @ctitle @cparagraph @string(8) @increment</code>
              {t("protocol.mock.smartHint3")}
              <code className="mx-1 font-mono text-brand-600">{'{{request.query.userId}}'}</code>
              {t("protocol.mock.smartHint4")}
            </span>
          </div>

          {mock.running && mock.log.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-surface-border">
              <div className="border-b border-surface-border bg-surface-muted px-3 py-1.5 text-2xs font-semibold text-ink-soft">
                {t("protocol.mock.accessLog", { count: mock.log.length })}
              </div>
              <div className="max-h-40 overflow-y-auto scrollbar-thin">
                {[...mock.log].reverse().map((entry, index) => (
                  <div key={`${entry.at}-${index}`} className="flex items-center gap-2 px-3 py-1 font-mono text-[10.5px]">
                    <span className="text-ink-faint">{new Date(entry.at).toLocaleTimeString("zh-CN")}</span>
                    <span className={`wb-method !w-auto !text-[9px] ${METHOD_CLASS[entry.method] ?? ""}`}>
                      {entry.method}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{entry.path}</span>
                    <span className={entry.status < 400 ? "text-emerald-600" : "text-red-500"}>{entry.status}</span>
                    <span className="text-ink-faint">{entry.durationMs}ms</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === "preview" && doc && (
        <div className="wb-mock-preview">
          <div className="wb-mock-toolbar">
            <Wand2 className="h-4 w-4 text-brand-500" />
            <span className="text-xs font-semibold text-ink">{t("protocol.mock.dataTitle")}</span>
            <Select
              className="!h-7 !w-56 !py-0 !text-[11px]"
              value={exampleId}
              aria-label={t("protocol.mock.sourceAria")}
              onChange={(event) => setExampleId(event.target.value)}
            >
              <option value="">{t("protocol.mock.autoGenerate")}</option>
              {doc.responses.map((example) => (
                <option key={example.id} value={example.id}>
                  {t("protocol.mock.exampleOption", {
                    name: example.name,
                    status: example.status,
                  })}
                  {example.modelId && models.some((model) => model.id === example.modelId)
                    ? t("protocol.mock.exampleModelSuffix", {
                        model:
                          models.find((model) => model.id === example.modelId)?.name ?? "",
                      })
                    : ""}
                </option>
              ))}
              {doc.requestModelId && models.some((model) => model.id === doc.requestModelId) && (
                <option value="::requestModel">
                  {t("protocol.mock.modelOption", {
                    name:
                      models.find((model) => model.id === doc.requestModelId)?.name ?? "",
                  })}
                </option>
              )}
            </Select>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void navigator.clipboard.writeText(mockBody)}
            >
              <Copy className="h-3.5 w-3.5" />
              {t("protocol.common.copy")}
            </Button>
            <span className="ml-auto text-2xs text-ink-faint">
              {t("protocol.mock.previewHint")}
            </span>
          </div>
          <pre className="wb-mock-body scrollbar-thin">{mockBody}</pre>
        </div>
      )}
    </div>
  );
}
