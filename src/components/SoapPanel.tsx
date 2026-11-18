import { useState } from "react";
import {
  AlertTriangle,
  Cable,
  FileCode2,
  FileUp,
  Send,
  ShieldCheck,
  Wand2,
  XOctagon,
} from "lucide-react";
import { api } from "../lib/api";
import {
  buildSoapEnvelope,
  buildWsseHeader,
  parseSoapFault,
  parseWsdl,
  prettifyXml,
} from "../lib/soap";
import type { SoapEnvelopeSpec, SoapOperation, WsdlInfo } from "../lib/soap";
import { useWorkspace } from "../store/workspace";
import { useT } from "../i18n";
import type { SoapSpec } from "../types";
import { ProtocolBar } from "./ProtocolBar";
import { Badge, Button, Select, Spinner, inputClass } from "./ui";

interface WsInput {
  enabled: boolean;
  username: string;
  password: string;
}

const DEFAULT_SOAP: SoapSpec = { version: "1.1" };

/** 把未知对象安全当作字典读取，避免 any。 */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 从草稿里宽容读取已配置的 Basic 凭据（字段缺失时返回空，不报错）。 */
function readBasic(draft: unknown): { username?: string; password?: string } {
  const auth = record(record(draft).auth);
  return {
    username: str(auth.username) ?? str(auth.user),
    password: str(auth.password) ?? str(auth.pass),
  };
}

/** 从 WSDL 操作的 inputParts 生成参数占位（值为空串，便于用户填值）。 */
function partsToParameters(
  op: SoapOperation | null,
): Record<string, unknown> | undefined {
  if (!op || op.inputParts.length === 0) return undefined;
  const parameters: Record<string, unknown> = {};
  for (const part of op.inputParts) parameters[part.name] = "";
  return parameters;
}

/**
 * 生成 Envelope：用此处输入的凭据调用 buildWsseHeader 生成 WSSE 片段，
 * 通过 headerXml 交给 buildSoapEnvelope（不另设 wsSecurity，避免重复 Header）。
 * 留空时回退到请求中已解析的 Basic 凭据。parameters 来自 WSDL inputParts。
 */
function makeEnvelope(
  base: SoapSpec,
  ws: WsInput,
  authDraft: unknown,
  parameters?: Record<string, unknown>,
): string {
  const spec: SoapEnvelopeSpec = {
    version: base.version,
    operation: base.operation,
    namespace: base.namespace,
    parameters,
  };
  if (ws.enabled) {
    const basic = readBasic(authDraft);
    const user = ws.username.trim() || basic.username || "";
    const pass = ws.password || basic.password || "";
    spec.headerXml = buildWsseHeader(user, pass, { passwordType: "PasswordText" });
  }
  return buildSoapEnvelope(spec);
}

function formatBytes(count: number | undefined): string {
  if (count === undefined || Number.isNaN(count)) return "—";
  if (count < 1024) return `${count} B`;
  return `${(count / 1024).toFixed(1)} KB`;
}

/**
 * SOAP / WSDL 调试面板：导入 WSDL → 选择操作生成 Envelope 模板 → 编辑 XML
 * → 发送（body/Content-Type/SOAPAction 的转换由主会话 toSpec 负责）→ 展示
 * 美化后的响应并高亮 SOAP Fault。仿 TCP/WS 面板布局与 CSS 变量主题。
 */
export function SoapPanel() {
  const t = useT();
  const draft = useWorkspace((state) => state.draft);
  const setDraft = useWorkspace((state) => state.setDraft);
  const response = useWorkspace((state) => state.response);
  const send = useWorkspace((state) => state.send);
  const isSending = useWorkspace((state) => state.isSending);
  const sendError = useWorkspace((state) => state.sendError);

  const soap = draft.soap ?? DEFAULT_SOAP;

  const [wsdl, setWsdl] = useState<WsdlInfo | null>(null);
  const [wsdlFileName, setWsdlFileName] = useState("");
  const [selectedOp, setSelectedOp] = useState("");
  const [selectedOperation, setSelectedOperation] = useState<SoapOperation | null>(null);
  const [importError, setImportError] = useState("");
  const [wsEnabled, setWsEnabled] = useState(false);
  const [wsUser, setWsUser] = useState("");
  const [wsPass, setWsPass] = useState("");

  const wsInput: WsInput = {
    enabled: wsEnabled,
    username: wsUser,
    password: wsPass,
  };

  const doSend = () => {
    if (isSending) return;
    void send();
  };

  const handleImport = async () => {
    setImportError("");
    try {
      const picked = await api.pickAndReadText();
      if (!picked || !picked.content) return;
      const info = parseWsdl(picked.content);
      setWsdl(info);
      setWsdlFileName(picked.name);
      setSelectedOp("");
      setSelectedOperation(null);
      setDraft({ soap: { ...soap, version: info.version, wsdlUrl: picked.name } });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSelectOperation = (name: string) => {
    setSelectedOp(name);
    if (!wsdl || !name) {
      setSelectedOperation(null);
      return;
    }
    const op = wsdl.operations.find((item) => item.name === name);
    if (!op) {
      setSelectedOperation(null);
      return;
    }
    setSelectedOperation(op);
    const next: SoapSpec = {
      ...soap,
      version: op.version,
      operation: op.name,
      soapAction: op.soapAction,
      namespace: op.namespace,
      endpoint: op.endpoint ?? soap.endpoint,
    };
    next.envelope = makeEnvelope(next, wsInput, draft, partsToParameters(op));
    setDraft({ soap: next, url: op.endpoint ?? wsdl.endpoint ?? draft.url });
  };

  const handleGenerate = () => {
    const envelope = makeEnvelope(
      soap,
      wsInput,
      draft,
      partsToParameters(selectedOperation),
    );
    setDraft({ soap: { ...soap, envelope } });
  };

  const bodyText = response?.body ?? "";
  let prettyBody = bodyText;
  try {
    prettyBody = prettifyXml(bodyText);
  } catch {
    prettyBody = bodyText;
  }
  let fault: ReturnType<typeof parseSoapFault> = null;
  try {
    fault = parseSoapFault(bodyText);
  } catch {
    fault = null;
  }

  return (
    <div className="wb-ws">
      <ProtocolBar />

      <div className="wb-ws-toolbar">
        <FileCode2 className="h-4 w-4 text-brand-500" />
        <span className="text-xs font-semibold text-ink">SOAP</span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-faint"
          title={draft.url}
        >
          {draft.url || "—"}
        </span>
        <Button
          size="sm"
          variant="primary"
          disabled={isSending || !draft.url.trim() || !(soap.envelope ?? "").trim()}
          onClick={doSend}
        >
          {isSending ? (
            <Spinner className="h-3.5 w-3.5" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          {t("protocol.common.send")}
        </Button>
      </div>

      {sendError && (
        <div className="wb-banner wb-banner-danger">
          <XOctagon className="h-3.5 w-3.5" />
          <span className="truncate font-medium">{sendError.message}</span>
          {sendError.code ? (
            <span className="shrink-0 font-mono text-2xs opacity-80">
              {sendError.code}
            </span>
          ) : null}
        </div>
      )}

      <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {/* ---------------------------------------------------------------- WSDL */}
        <section className="rounded-lg border border-surface-border bg-surface p-3">
          <h3 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-ink">
            <FileCode2 className="h-3.5 w-3.5 text-brand-500" />
            WSDL
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => void handleImport()}>
              <FileUp className="h-3.5 w-3.5" />
              {t("protocol.soap.importWsdl")}
            </Button>
            {wsdl && (
              <span className="truncate text-2xs text-ink-faint" title={wsdlFileName}>
                {t("protocol.soap.wsdlInfo", {
                  name: wsdlFileName,
                  count: wsdl.operations.length,
                  version: wsdl.version,
                })}
              </span>
            )}
            {!wsdl && (
              <span className="text-2xs text-ink-faint">
                {t("protocol.soap.wsdlHint")}
              </span>
            )}
          </div>

          {importError && (
            <div className="wb-banner wb-banner-danger mt-2 rounded-md">
              <AlertTriangle className="h-3.5 w-3.5" />
              {importError}
            </div>
          )}

          {wsdl && wsdl.warnings.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-2xs text-amber-600">
              {wsdl.warnings.map((warning, index) => (
                <li key={index}>⚠ {warning}</li>
              ))}
            </ul>
          )}

          {wsdl && (
            <label className="mt-2.5 block">
              <span className="mb-1 block text-xs text-ink-soft">
                {t("protocol.soap.operation")}
              </span>
              <Select
                className={inputClass}
                value={selectedOp}
                aria-label={t("protocol.soap.operationAria")}
                onChange={(event) => handleSelectOperation(event.target.value)}
              >
                <option value="">{t("protocol.soap.selectOperation")}</option>
                {wsdl.operations.map((op) => (
                  <option key={op.name} value={op.name}>
                    {op.name}
                    {op.soapAction ? `  ·  ${op.soapAction}` : ""}
                  </option>
                ))}
              </Select>
            </label>
          )}
        </section>

        {/* ---------------------------------------------------------------- 请求配置 */}
        <section className="rounded-lg border border-surface-border bg-surface p-3">
          <h3 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-ink">
            <Cable className="h-3.5 w-3.5 text-brand-500" />
            {t("protocol.soap.requestConfig")}
          </h3>

          <div className="space-y-2.5">
            <div>
              <span className="mb-1 block text-xs text-ink-soft">
                {t("protocol.soap.soapVersion")}
              </span>
              <div className="wb-segment" role="group" aria-label={t("protocol.soap.soapVersion")}>
                {(["1.1", "1.2"] as const).map((version) => (
                  <button
                    key={version}
                    type="button"
                    className={soap.version === version ? "active" : ""}
                    aria-pressed={soap.version === version}
                    onClick={() => setDraft({ soap: { ...soap, version } })}
                  >
                    SOAP {version}
                  </button>
                ))}
              </div>
            </div>

            <label className="block">
              <span className="mb-1 block text-xs text-ink-soft">SOAPAction</span>
              <input
                className={`${inputClass} font-mono text-xs`}
                value={soap.soapAction ?? ""}
                spellCheck={false}
                placeholder={t("protocol.soap.soapActionPlaceholder")}
                aria-label="SOAPAction"
                onChange={(event) =>
                  setDraft({ soap: { ...soap, soapAction: event.target.value } })
                }
              />
            </label>

            <div className="rounded-md border border-surface-border bg-surface-sunken p-2.5">
              <label className="flex items-center gap-2 text-xs font-medium text-ink">
                <ShieldCheck className="h-3.5 w-3.5 text-brand-500" />
                <input
                  type="checkbox"
                  className="accent-brand-500"
                  checked={wsEnabled}
                  aria-label={t("protocol.soap.wsSecurityAria")}
                  onChange={(event) => setWsEnabled(event.target.checked)}
                />
                {t("protocol.soap.wsSecurity")}
              </label>
              {wsEnabled && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="mb-1 block text-2xs text-ink-soft">
                      {t("protocol.soap.username")}
                    </span>
                    <input
                      className={`${inputClass} text-xs`}
                      value={wsUser}
                      autoComplete="off"
                      spellCheck={false}
                      aria-label={t("protocol.soap.usernameAria")}
                      placeholder={t("protocol.soap.username")}
                      onChange={(event) => setWsUser(event.target.value)}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-2xs text-ink-soft">
                      {t("protocol.soap.password")}
                    </span>
                    <input
                      type="password"
                      className={`${inputClass} text-xs`}
                      value={wsPass}
                      autoComplete="new-password"
                      aria-label={t("protocol.soap.passwordAria")}
                      placeholder={t("protocol.soap.password")}
                      onChange={(event) => setWsPass(event.target.value)}
                    />
                  </label>
                </div>
              )}
              <p className="mt-1.5 text-2xs leading-relaxed text-ink-faint">
                {t("protocol.soap.wsSecurityNote")}
              </p>
            </div>

            <label className="block">
              <span className="mb-1 block text-xs text-ink-soft">
                {t("protocol.soap.envelopeLabel")}
              </span>
              <textarea
                className={`${inputClass} h-52 resize-y font-mono text-xs`}
                value={soap.envelope ?? ""}
                spellCheck={false}
                aria-label="SOAP Envelope XML"
                placeholder={t("protocol.soap.envelopePlaceholder")}
                onChange={(event) =>
                  setDraft({ soap: { ...soap, envelope: event.target.value } })
                }
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.ctrlKey || event.metaKey || !event.shiftKey)
                  ) {
                    event.preventDefault();
                    doSend();
                  }
                }}
              />
            </label>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-2xs text-ink-faint">
                {t("protocol.soap.contentTypeNote")}
              </span>
              <Button size="sm" variant="secondary" onClick={handleGenerate}>
                <Wand2 className="h-3.5 w-3.5" />
                {t("protocol.soap.generateEnvelope")}
              </Button>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- 响应 */}
        <section className="rounded-lg border border-surface-border bg-surface p-3">
          <h3 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-ink">
            <Cable className="h-3.5 w-3.5 text-brand-500" />
            {t("protocol.soap.response")}
          </h3>

          {isSending && !response && (
            <div className="flex items-center gap-2 py-4 text-xs text-ink-faint">
              <Spinner className="h-4 w-4" />
              {t("protocol.soap.sending")}
            </div>
          )}

          {response ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge tone={fault ? "danger" : "success"}>{response.status}</Badge>
                <span className="text-ink-faint">
                  {response.timings?.totalMs ?? "—"} ms · {formatBytes(response.size)}
                  {response.bodyKind ? ` · ${response.bodyKind}` : ""}
                </span>
                {fault && <Badge tone="danger">SOAP Fault</Badge>}
              </div>

              {fault && (
                <div className="flex flex-col gap-1 rounded-md border border-surface-border bg-surface-sunken p-2.5 text-xs">
                  <div className="flex items-center gap-1.5 font-semibold text-red-600">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    SOAP Fault · {fault.code || "Fault"}
                  </div>
                  <div className="break-words text-ink">
                    <span className="text-ink-faint">{t("protocol.soap.faultMessage")}</span>
                    {fault.message || t("protocol.soap.noFaultMessage")}
                  </div>
                  {fault.detail && (
                    <pre className="scrollbar-thin mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-surface p-2 font-mono text-2xs text-ink">
                      {fault.detail}
                    </pre>
                  )}
                </div>
              )}

              <pre className="scrollbar-thin max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-surface-border bg-surface-sunken p-2.5 font-mono text-2xs text-ink">
                {prettyBody || t("protocol.soap.emptyBody")}
              </pre>
            </div>
          ) : (
            !isSending &&
            !sendError && (
              <div className="rounded-lg border border-dashed border-surface-border px-4 py-6 text-center">
                <FileCode2 className="mx-auto mb-2 h-6 w-6 text-ink-faint" />
                <p className="text-xs leading-relaxed text-ink-soft">
                  {t("protocol.soap.emptyDesc")}
                </p>
              </div>
            )
          )}
        </section>
      </div>
    </div>
  );
}
