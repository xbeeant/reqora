import { useEffect, useRef } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Network,
  Radio,
  Send,
  Upload,
  Wand2,
  XOctagon,
} from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { useT } from "../i18n";
import { Badge, Button, Modal, Spinner, inputClass } from "./ui";

/** 会话状态徽标文案 key；键用 string 放宽，避免与 store 状态字面量硬耦合。 */
const STATUS_LABEL_KEY: Record<string, string> = {
  open: "protocol.grpc.status.open",
  closed: "protocol.grpc.status.closed",
  error: "protocol.status.error",
  none: "protocol.grpc.status.none",
};

const STATUS_TONE: Record<string, string> = {
  open: "wb-tone wb-tone-ok",
  closed: "wb-tone wb-tone-muted",
  error: "wb-tone wb-tone-danger",
  none: "wb-tone wb-tone-muted",
};

/** 时间线 JSON 渲染：字符串原样展示，其余美化，循环引用等异常安全降级。 */
function formatJson(value: unknown, emptyText: string): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? emptyText;
  } catch {
    return String(value);
  }
}

/**
 * gRPC 调试台：选择 .proto（protox 纯 Rust 编译，无需 protoc）→
 * 浏览 service / method → unary 走一次 invoke，client/server/bidi streaming
 * 走长连接会话（grpcStream*），可连续发送多条并实时查看消息时间线。
 */
export function GrpcModal() {
  const t = useT();
  const open = useWorkspace((state) => state.grpcModalOpen);
  const setOpen = useWorkspace((state) => state.setGrpcModalOpen);
  const schema = useWorkspace((state) => state.grpcSchema);
  const methodPath = useWorkspace((state) => state.grpcMethodPath);
  const address = useWorkspace((state) => state.grpcAddress);
  const message = useWorkspace((state) => state.grpcMessage);
  const result = useWorkspace((state) => state.grpcResult);
  const grpcFiles = useWorkspace((state) => state.grpcFiles);
  const busy = useWorkspace((state) => state.grpcBusy);
  const error = useWorkspace((state) => state.grpcError);
  const pickProto = useWorkspace((state) => state.pickProto);
  const grpcReflect = useWorkspace((state) => state.grpcReflect);
  const selectGrpcMethod = useWorkspace((state) => state.selectGrpcMethod);
  const setGrpcAddress = useWorkspace((state) => state.setGrpcAddress);
  const setGrpcMessage = useWorkspace((state) => state.setGrpcMessage);
  const verifyTls = useWorkspace((state) => state.grpcVerifyTls);
  const caPem = useWorkspace((state) => state.grpcCaPem);
  const setGrpcVerifyTls = useWorkspace((state) => state.setGrpcVerifyTls);
  const setGrpcCaPem = useWorkspace((state) => state.setGrpcCaPem);
  const grpcInvoke = useWorkspace((state) => state.grpcInvoke);

  const grpcStream = useWorkspace((state) => state.grpcStream);
  const grpcStreamBusy = useWorkspace((state) => state.grpcStreamBusy);
  const grpcStreamStart = useWorkspace((state) => state.grpcStreamStart);
  const grpcStreamSend = useWorkspace((state) => state.grpcStreamSend);
  const grpcStreamClose = useWorkspace((state) => state.grpcStreamClose);
  const grpcStreamCancel = useWorkspace((state) => state.grpcStreamCancel);

  const close = () => setOpen(false);
  const selectedService = schema?.services.find((service) =>
    service.methods.some((m) => m.path === methodPath),
  );
  const selectedMethod = selectedService?.methods.find((m) => m.path === methodPath);
  const isStreaming =
    !!selectedMethod &&
    (selectedMethod.clientStreaming || selectedMethod.serverStreaming);

  const streamMessages = grpcStream?.messages ?? [];
  const streamStatus = grpcStream?.status ?? "none";
  const streamOpen = grpcStream?.status === "open";
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [streamMessages.length]);

  const sendStream = () => {
    if (!streamOpen || grpcStreamBusy || !message.trim()) return;
    void grpcStreamSend();
  };

  return (
    <Modal
      open={open}
      title={t("protocol.grpc.title")}
      description={t("protocol.grpc.description")}
      onClose={close}
      width="max-w-2xl"
      footer={
        <div className="flex items-center gap-2">
          {isStreaming ? (
            <Button
              variant="primary"
              disabled={
                !schema ||
                !methodPath ||
                !address.trim() ||
                busy !== null ||
                grpcStreamBusy ||
                streamOpen
              }
              onClick={() => void grpcStreamStart()}
            >
              {grpcStreamBusy ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <Radio className="h-3.5 w-3.5" />
              )}
              {t("protocol.grpc.startSession")}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!schema || !methodPath || busy !== null}
              onClick={() => void grpcInvoke()}
            >
              {busy === "invoke" ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <Radio className="h-3.5 w-3.5" />
              )}
              {t("protocol.grpc.invoke")}
            </Button>
          )}
          <Button variant="primary" onClick={close}>
            {t("protocol.grpc.done")}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="wb-banner wb-banner-danger">
            <XOctagon className="h-3.5 w-3.5" />
            {error}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void pickProto()} disabled={busy !== null}>
            {busy === "compile" ? (
              <Spinner className="h-3.5 w-3.5" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {t("protocol.grpc.pickProto")}
          </Button>
          <Button
            onClick={() => void grpcReflect()}
            disabled={busy !== null || !address.trim()}
            title={
              address.trim()
                ? t("protocol.grpc.reflectHint")
                : t("protocol.grpc.reflectNeedAddress")
            }
          >
            {busy === "reflect" ? (
              <Spinner className="h-3.5 w-3.5" />
            ) : (
              <Wand2 className="h-3.5 w-3.5" />
            )}
            {t("protocol.grpc.reflect")}
          </Button>
          {schema && (
            <span className="min-w-0 flex-1 truncate text-2xs text-ink-faint">
              {grpcFiles.length > 0
                ? t("protocol.grpc.compiledInfo", {
                    files: schema.files.join("、"),
                    count: schema.services.length,
                  })
                : t("protocol.grpc.reflectedInfo", { count: schema.services.length })}
            </span>
          )}
        </div>
        <p className="text-2xs text-ink-faint">{t("protocol.grpc.schemaHint")}</p>

        {schema && schema.services.length > 0 && (
          <div className="space-y-2">
            {schema.services.map((service) => (
              <div key={service.name} className="rounded-lg border border-surface-border p-2">
                <p className="mb-1.5 font-mono text-xs font-semibold text-ink">
                  {service.name}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {service.methods.map((method) => {
                    const selected = method.path === methodPath;
                    const flow =
                      method.clientStreaming && method.serverStreaming
                        ? "bidi"
                        : method.clientStreaming
                          ? "client-stream"
                          : method.serverStreaming
                            ? "stream"
                            : "";
                    return (
                      <button
                        key={method.path}
                        type="button"
                        title={`${method.inputType} → ${method.outputType}${flow ? ` · ${flow}` : ""}`}
                        onClick={() => selectGrpcMethod(method.path)}
                        className={`rounded-md border px-2 py-1 font-mono text-2xs transition ${
                          selected
                            ? "border-brand-400 bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300"
                            : "border-surface-border text-ink-soft hover:bg-surface-sunken"
                        }`}
                      >
                        {method.name}
                        {flow && <span className="ml-1 text-ink-faint">{flow}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-ink-soft">
              {t("protocol.grpc.address")}
            </span>
            <input
              className={`${inputClass} font-mono text-xs`}
              placeholder={t("protocol.grpc.addressPlaceholder")}
              value={address}
              onChange={(event) => setGrpcAddress(event.target.value)}
              aria-label={t("protocol.grpc.addressAria")}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-ink-soft">
              {t("protocol.grpc.method")}
            </span>
            <input
              readOnly
              className={`${inputClass} font-mono text-xs`}
              value={methodPath || t("protocol.grpc.noMethod")}
              aria-label={t("protocol.grpc.methodAria")}
            />
          </label>
        </div>

        {/* TLS：自签名 / 内网证书可跳过校验，或追加自定义 CA。仅对 https:// 地址生效。 */}
        <div className="rounded-lg border border-surface-border bg-surface-sunken px-3 py-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-soft">
              <input
                type="checkbox"
                className="accent-brand-500"
                checked={verifyTls}
                aria-label={t("protocol.grpc.verifyTls")}
                onChange={(event) => setGrpcVerifyTls(event.target.checked)}
              />
              {t("protocol.grpc.verifyTls")}
            </label>
            <span className="text-2xs text-ink-faint">
              {t("protocol.grpc.verifyTlsHint")}
            </span>
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-2xs text-ink-faint hover:text-ink-soft">
              {t("protocol.grpc.caPem")}
            </summary>
            <textarea
              className={`${inputClass} mt-2 h-20 resize-y font-mono text-2xs`}
              value={caPem}
              spellCheck={false}
              placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
              aria-label={t("protocol.grpc.caPem")}
              onChange={(event) => setGrpcCaPem(event.target.value)}
            />
            <span className="mt-1 block text-2xs text-ink-faint">
              {t("protocol.grpc.caPemHint")}
            </span>
          </details>
        </div>

        {selectedService && methodPath && (
          <p className="font-mono text-2xs text-ink-faint">
            {selectedService.methods.find((m) => m.path === methodPath)?.inputType} →{" "}
            {selectedService.methods.find((m) => m.path === methodPath)?.outputType}
            {isStreaming && (
              <span className="ml-2 text-brand-600">{t("protocol.grpc.streamingMode")}</span>
            )}
          </p>
        )}

        {/* ------------------------------------------------------------ unary 请求消息 */}
        {!isStreaming && (
          <label className="block">
            <span className="mb-1 block text-xs text-ink-soft">
              {t("protocol.grpc.requestMessage")}
            </span>
            <textarea
              className={`${inputClass} h-24 font-mono text-xs`}
              aria-label={t("protocol.grpc.requestMessageAria")}
              value={message}
              onChange={(event) => setGrpcMessage(event.target.value)}
            />
          </label>
        )}

        {/* ------------------------------------------------------------ 流式会话 */}
        {isStreaming && (
          <section className="rounded-lg border border-surface-border bg-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Radio className="h-3.5 w-3.5 text-brand-500" />
              <span className="text-xs font-semibold text-ink">
                {t("protocol.grpc.streamSession")}
              </span>
              <span className={STATUS_TONE[streamStatus] ?? "wb-tone wb-tone-muted"}>
                {t(STATUS_LABEL_KEY[streamStatus] ?? streamStatus)}
              </span>
              <span
                className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-faint"
                title={grpcStream?.sessionId}
              >
                {grpcStream?.sessionId ?? "—"}
              </span>
              <Button
                size="sm"
                variant="primary"
                disabled={!streamOpen || grpcStreamBusy || !message.trim()}
                onClick={sendStream}
              >
                <Send className="h-3.5 w-3.5" />
                {t("protocol.common.send")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!streamOpen}
                title={t("protocol.grpc.closeWriteTitle")}
                onClick={() => void grpcStreamClose()}
              >
                <Check className="h-3.5 w-3.5" />
                {t("protocol.grpc.closeWrite")}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={!grpcStream || grpcStreamBusy}
                onClick={() => void grpcStreamCancel()}
              >
                <XOctagon className="h-3.5 w-3.5" />
                {t("protocol.common.cancel")}
              </Button>
            </div>

            <label className="mt-2.5 block">
              <span className="mb-1 block text-xs text-ink-soft">
                {t("protocol.grpc.streamMessage")}
              </span>
              <textarea
                className={`${inputClass} h-20 resize-y font-mono text-xs`}
                aria-label={t("protocol.grpc.streamMessageAria")}
                value={message}
                spellCheck={false}
                placeholder={'{\n  "hello": "grpc"\n}'}
                onChange={(event) => setGrpcMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.ctrlKey || event.metaKey || !event.shiftKey)
                  ) {
                    event.preventDefault();
                    sendStream();
                  }
                }}
              />
              <span className="mt-1 block text-2xs text-ink-faint">
                {t("protocol.grpc.streamSendHint")}
              </span>
            </label>

            <div
              ref={timelineRef}
              className="scrollbar-thin mt-2.5 flex max-h-64 min-h-[140px] flex-col gap-2 overflow-y-auto rounded-md border border-surface-border bg-surface-muted p-3"
            >
              {streamMessages.length === 0 ? (
                <div className="wb-empty">
                  <Network className="mb-1 h-6 w-6 opacity-60" />
                  <p className="wb-empty-title">
                    {grpcStream
                      ? t("protocol.grpc.streamEmptyStarted")
                      : t("protocol.grpc.streamEmptyNotStarted")}
                  </p>
                  <p className="max-w-sm text-xs leading-relaxed text-ink-faint">
                    {grpcStream
                      ? t("protocol.grpc.streamEmptyStartedDesc")
                      : t("protocol.grpc.streamEmptyNotStartedDesc")}
                  </p>
                </div>
              ) : (
                streamMessages.map((entry, index) => {
                  const out = entry.direction === "out";
                  return (
                    <div key={index} className={`wb-ws-row ${out ? "out" : "in"}`}>
                      <div className="wb-ws-bubble">
                        <div className="wb-ws-bubble-head">
                          {out ? (
                            <ArrowUpFromLine className="h-3 w-3" />
                          ) : (
                            <ArrowDownToLine className="h-3 w-3" />
                          )}
                          <span>{out ? t("protocol.grpc.client") : t("protocol.grpc.server")}</span>
                          <span className="wb-ws-time">+{entry.atMs}ms</span>
                        </div>
                        <pre className="wb-ws-payload scrollbar-thin">
                          {formatJson(entry.json, t("protocol.common.empty"))}
                        </pre>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        )}

        {/* ------------------------------------------------------------ unary 结果 */}
        {!isStreaming && result && (
          <div className="rounded-lg border border-surface-border bg-surface-sunken p-3">
            <div className="mb-2 flex items-center gap-2 text-xs">
              <Badge tone={result.status === "OK" ? "success" : "danger"}>
                {result.status}
              </Badge>
              <span className="text-ink-faint">{result.elapsedMs} ms</span>
              <span className="text-ink-faint">
                {t("protocol.grpc.responseCount", { count: result.responses.length })}
              </span>
              {result.truncated && (
                <span className="text-amber-600">{t("protocol.grpc.truncated")}</span>
              )}
            </div>
            {result.responses.map((response, index) => (
              <pre
                key={index}
                className="scrollbar-thin mb-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-surface p-2 font-mono text-2xs text-ink"
              >
                {JSON.stringify(response, null, 2)}
              </pre>
            ))}
          </div>
        )}

        {!schema && !error && (
          <div className="rounded-lg border border-dashed border-surface-border px-4 py-6 text-center">
            <Network className="mx-auto mb-2 h-6 w-6 text-ink-faint" />
            <p className="text-xs text-ink-soft">
              {t("protocol.grpc.emptyDesc")}
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
