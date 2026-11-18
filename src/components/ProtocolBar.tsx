import { useMemo } from "react";
import { ArrowLeft, Cable } from "lucide-react";
import { collectVariableSuggestions } from "../lib/variables.ts";
import { useWorkspace } from "../store/workspace";
import { useT } from "../i18n";
import type { RequestProtocol } from "../types";
import { VariableInput } from "./VariableInput";

const PROTOCOLS: { id: RequestProtocol; label: string; hintKey: string }[] = [
  { id: "http", label: "HTTP", hintKey: "request.protocol.hint.http" },
  { id: "ws", label: "WS", hintKey: "request.protocol.hint.ws" },
  { id: "tcp", label: "TCP", hintKey: "request.protocol.hint.tcp" },
  { id: "mqtt", label: "MQTT", hintKey: "request.protocol.hint.mqtt" },
  { id: "soap", label: "SOAP", hintKey: "request.protocol.hint.soap" },
];

const PLACEHOLDER_KEY: Record<RequestProtocol, string> = {
  http: "request.protocol.placeholder.http",
  ws: "request.protocol.placeholder.ws",
  tcp: "request.protocol.placeholder.tcp",
  mqtt: "request.protocol.placeholder.mqtt",
  soap: "request.protocol.placeholder.soap",
};

/**
 * WS/TCP 专属面板会整体顶替「地址栏 + 协议切换器」的编辑区，导致进去后
 * 没有返回和换协议的入口。这里把三件事补回来：回到编辑页、切换协议、
 * 直接改地址。切换协议只改 draft.protocol，其他编辑内容原样保留。
 */
export function ProtocolBar() {
  const t = useT();
  const draft = useWorkspace((state) => state.draft);
  // 只订阅环境域 + 生效环境 id。
  const environments = useWorkspace((state) => state.snapshot.environments);
  const activeEnvironmentId = useWorkspace((state) => state.snapshot.activeEnvironmentId);
  const setDraft = useWorkspace((state) => state.setDraft);
  const setDetailTab = useWorkspace((state) => state.setDetailTab);
  const protocol: RequestProtocol = draft.protocol ?? "http";
  const activeEnvironment = environments.find(
    (environment) => environment.id === activeEnvironmentId,
  );
  const suggestions = useMemo(
    () =>
      collectVariableSuggestions({
        environmentVariables: activeEnvironment?.variables ?? [],
        url: draft.url,
      }),
    [activeEnvironment, draft.url],
  );

  return (
    <div className="wb-protocol-bar">
      <button
        type="button"
        className="wb-chip !h-7 shrink-0 !px-2 !text-[10.5px]"
        title={t("request.protocol.back.title")}
        onClick={() => setDetailTab("edit")}
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {t("request.protocol.back")}
      </button>
      <div className="wb-segment wb-segment-xs shrink-0" role="group" aria-label={t("request.protocol.switch.aria")}>
        {PROTOCOLS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={protocol === item.id ? "active" : ""}
            title={t(item.hintKey)}
            aria-pressed={protocol === item.id}
            onClick={() => setDraft({ protocol: item.id })}
          >
            {item.label}
          </button>
        ))}
      </div>
      <VariableInput
        className="wb-url-input !h-7 !py-0 !text-[11px]"
        value={draft.url}
        onChange={(url) => setDraft({ url })}
        suggestions={suggestions}
        spellCheck={false}
        ariaLabel={t("request.protocol.url.aria")}
        placeholder={t(PLACEHOLDER_KEY[protocol])}
      />
      <span className="hidden shrink-0 items-center gap-1 text-[10px] text-ink-faint xl:inline-flex">
        <Cable className="h-3 w-3" />
        {t("request.protocol.keepHint")}
      </span>
    </div>
  );
}
