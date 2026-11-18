import { useEffect, useRef } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Cable,
  Plus,
  PlugZap,
  Radio,
  Send,
  Trash2,
  X,
  XOctagon,
} from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { useT } from "../i18n";
import { ProtocolBar } from "./ProtocolBar";
import { Button, Select, Spinner, inputClass } from "./ui";
import type { MqttSpec, MqttTimelineEntry } from "../types";

type MqttStatus = "connecting" | "open" | "closed" | "error";

const STATUS_LABEL_KEY: Record<MqttStatus, string> = {
  connecting: "protocol.status.connecting",
  open: "protocol.status.open",
  closed: "protocol.status.closed",
  error: "protocol.status.error",
};

const STATUS_TONE: Record<MqttStatus, string> = {
  connecting: "wb-tone wb-tone-warn",
  open: "wb-tone wb-tone-ok",
  closed: "wb-tone wb-tone-muted",
  error: "wb-tone wb-tone-danger",
};

/** 兜底值：旧草稿没有 mqtt 字段时，表单仍可编辑。 */
const DEFAULT_MQTT: MqttSpec = {
  url: "mqtt://localhost:1883",
  version: "3.1.1",
  keepAliveSecs: 60,
  cleanSession: true,
  topic: "",
  qos: 0,
  retain: false,
};

const QOS_OPTIONS: { value: "0" | "1" | "2"; labelKey: string }[] = [
  { value: "0", labelKey: "protocol.mqtt.qos0" },
  { value: "1", labelKey: "protocol.mqtt.qos1" },
  { value: "2", labelKey: "protocol.mqtt.qos2" },
];

function toQos(value: string): 0 | 1 | 2 {
  const n = Number(value);
  return n === 1 || n === 2 ? n : 0;
}

function TimelineRow({ entry }: { entry: MqttTimelineEntry }) {
  const t = useT();
  if (entry.direction === "sys") {
    return (
      <div className="wb-ws-sys">
        <span>{entry.label ?? t("protocol.timeline.system")}</span>
        {entry.at ? (
          <time>{new Date(entry.at).toLocaleTimeString("zh-CN")}</time>
        ) : null}
      </div>
    );
  }

  const out = entry.direction === "out";
  return (
    <div className={`wb-ws-row ${out ? "out" : "in"}`}>
      <div className="wb-ws-bubble">
        <div className="wb-ws-bubble-head">
          {out ? (
            <ArrowUpFromLine className="h-3 w-3" />
          ) : (
            <ArrowDownToLine className="h-3 w-3" />
          )}
          <span>{out ? t("protocol.mqtt.publish") : t("protocol.mqtt.receive")}</span>
          {entry.topic ? (
            <span className="font-mono text-brand-600">{entry.topic}</span>
          ) : null}
          {entry.qos !== undefined ? <span>QoS {entry.qos}</span> : null}
          {entry.retain ? <span>{t("protocol.mqtt.retainBadge")}</span> : null}
          <span className="wb-ws-time">+{entry.atMs}ms</span>
        </div>
        <pre className="wb-ws-payload scrollbar-thin">
          {entry.data || t("protocol.common.empty")}
        </pre>
      </div>
    </div>
  );
}

/**
 * MQTT 调试面板：连接配置 → 订阅 / 取消订阅 → 发布消息 → 实时消息时间线。
 * 仿 WsPanel 的视觉语言（wb-ws-* / CSS 变量主题），由 useWorkspace 的
 * mqttSessions / mqttPublish / mqttSub* 状态与 actions 驱动。
 */
export function MqttPanel() {
  const t = useT();
  const draft = useWorkspace((state) => state.draft);
  const session = useWorkspace((state) => state.mqttSessions[state.draft.id]);
  const mqttPublish = useWorkspace((state) => state.mqttPublish);
  const mqttSubInput = useWorkspace((state) => state.mqttSubInput);
  const mqttSubQos = useWorkspace((state) => state.mqttSubQos);
  const mqttBusy = useWorkspace((state) => state.mqttBusy);
  const connectMqtt = useWorkspace((state) => state.connectMqtt);
  const disconnectMqtt = useWorkspace((state) => state.disconnectMqtt);
  const publishMqtt = useWorkspace((state) => state.publishMqtt);
  const subscribeMqtt = useWorkspace((state) => state.subscribeMqtt);
  const unsubscribeMqtt = useWorkspace((state) => state.unsubscribeMqtt);
  const clearMqttTimeline = useWorkspace((state) => state.clearMqttTimeline);
  const setMqttDraft = useWorkspace((state) => state.setMqttDraft);
  const setMqttPublish = useWorkspace((state) => state.setMqttPublish);
  const setMqttSubInput = useWorkspace((state) => state.setMqttSubInput);
  const setMqttSubQos = useWorkspace((state) => state.setMqttSubQos);

  const mqtt = draft.mqtt ?? DEFAULT_MQTT;
  const status = (session?.status ?? "closed") as MqttStatus;
  const live = status === "open" || status === "connecting";
  const subscriptions: { topic: string; qos: 0 | 1 | 2 }[] =
    session?.subscriptions ?? mqtt.subscriptions ?? [];
  const messages: MqttTimelineEntry[] = session?.messages ?? [];
  const timelineRef = useRef<HTMLDivElement>(null);

  // 新消息到达时自动滚到底部（最多 500 条由 store 保证）。
  useEffect(() => {
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const doSubscribe = () => {
    if (!live || mqttBusy || !mqttSubInput.trim()) return;
    void subscribeMqtt();
  };

  const doPublish = () => {
    if (!live || mqttBusy || !mqttPublish.topic.trim()) return;
    void publishMqtt();
  };

  return (
    <div className="wb-ws">
      <ProtocolBar />

      <div className="wb-ws-toolbar">
        <Radio className="h-4 w-4 text-brand-500" />
        <span className="text-xs font-semibold text-ink">MQTT</span>
        <span className={STATUS_TONE[status]}>{t(STATUS_LABEL_KEY[status])}</span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-faint"
          title={mqtt.url}
        >
          {mqtt.url || draft.url || "—"}
        </span>
        {messages.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={clearMqttTimeline}
            title={t("protocol.common.clearHistory")}
            aria-label={t("protocol.common.clearHistory")}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("protocol.common.clear")}
          </Button>
        )}
        {live ? (
          <Button
            size="sm"
            variant="danger"
            disabled={mqttBusy}
            onClick={() => void disconnectMqtt()}
          >
              <XOctagon className="h-3.5 w-3.5" />
              {t("protocol.common.disconnect")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={mqttBusy}
              onClick={() => void connectMqtt()}
            >
              {mqttBusy ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <PlugZap className="h-3.5 w-3.5" />
              )}
              {t("protocol.common.connect")}
            </Button>
          )}
      </div>

      {session?.error && (
        <div className="wb-banner wb-banner-danger">
          <XOctagon className="h-3.5 w-3.5" />
          {session.error}
        </div>
      )}

      <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {/* ---------------------------------------------------------------- 连接配置 */}
        <section className="rounded-lg border border-surface-border bg-surface p-3">
          <h3 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-ink">
            <Cable className="h-3.5 w-3.5 text-brand-500" />
            {t("protocol.mqtt.connectionConfig")}
          </h3>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="col-span-2 block">
              <span className="mb-1 block text-xs text-ink-soft">
                {t("protocol.mqtt.brokerUrl")}
              </span>
              <input
                className={`${inputClass} font-mono text-xs`}
                value={mqtt.url}
                spellCheck={false}
                placeholder="mqtt://localhost:1883"
                aria-label={t("protocol.mqtt.brokerUrlAria")}
                onChange={(event) => setMqttDraft({ url: event.target.value })}
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs text-ink-soft">
                {t("protocol.mqtt.clientId")}
              </span>
              <input
                className={`${inputClass} font-mono text-xs`}
                value={mqtt.clientId ?? ""}
                spellCheck={false}
                placeholder={t("protocol.mqtt.clientIdPlaceholder")}
                aria-label={t("protocol.mqtt.clientIdAria")}
                onChange={(event) => setMqttDraft({ clientId: event.target.value })}
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs text-ink-soft">
                {t("protocol.mqtt.version")}
              </span>
              <Select
                className={inputClass}
                value={mqtt.version}
                aria-label={t("protocol.mqtt.version")}
                onChange={(event) =>
                  setMqttDraft({ version: event.target.value as "3.1.1" | "5" })
                }
              >
                <option value="3.1.1">MQTT 3.1.1</option>
                <option value="5">MQTT 5</option>
              </Select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs text-ink-soft">
                {t("protocol.mqtt.keepAlive")}
              </span>
              <input
                type="number"
                min={0}
                max={65535}
                className={`${inputClass} font-mono text-xs`}
                value={mqtt.keepAliveSecs}
                aria-label={t("protocol.mqtt.keepAliveAria")}
                onChange={(event) =>
                  setMqttDraft({
                    keepAliveSecs: Math.max(0, Number(event.target.value) || 0),
                  })
                }
              />
            </label>

            <label className="flex items-center gap-2 self-end pb-2 text-xs text-ink-soft">
              <input
                type="checkbox"
                className="accent-brand-500"
                checked={mqtt.cleanSession}
                aria-label={t("protocol.mqtt.cleanSessionAria")}
                onChange={(event) =>
                  setMqttDraft({ cleanSession: event.target.checked })
                }
              />
              {t("protocol.mqtt.cleanSession")}
            </label>

            <label className="block">
              <span className="mb-1 block text-xs text-ink-soft">
                {t("protocol.mqtt.username")}
              </span>
              <input
                className={`${inputClass} text-xs`}
                value={mqtt.username ?? ""}
                autoComplete="off"
                spellCheck={false}
                aria-label={t("protocol.mqtt.usernameAria")}
                onChange={(event) => setMqttDraft({ username: event.target.value })}
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs text-ink-soft">
                {t("protocol.mqtt.password")}
              </span>
              <input
                type="password"
                className={`${inputClass} text-xs`}
                value={mqtt.password ?? ""}
                autoComplete="new-password"
                aria-label={t("protocol.mqtt.passwordAria")}
                onChange={(event) => setMqttDraft({ password: event.target.value })}
              />
            </label>
          </div>
        </section>

        {/* ---------------------------------------------------------------- 订阅 */}
        <section className="rounded-lg border border-surface-border bg-surface p-3">
          <h3 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-ink">
            <Plus className="h-3.5 w-3.5 text-brand-500" />
            {t("protocol.mqtt.subscribeTopic")}
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={`${inputClass} min-w-[160px] flex-1 font-mono text-xs`}
              value={mqttSubInput}
              spellCheck={false}
              placeholder={t("protocol.mqtt.topicFilterPlaceholder")}
              aria-label={t("protocol.mqtt.subscribeTopicAria")}
              onChange={(event) => setMqttSubInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  doSubscribe();
                }
              }}
            />
            <Select
              className={`${inputClass} !w-44`}
              value={String(mqttSubQos)}
              aria-label={t("protocol.mqtt.subQosAria")}
              onChange={(event) => setMqttSubQos(toQos(event.target.value))}
            >
              {QOS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="primary"
              disabled={!live || mqttBusy || !mqttSubInput.trim()}
              onClick={doSubscribe}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("protocol.mqtt.subscribe")}
            </Button>
          </div>

          {subscriptions.length > 0 ? (
            <ul className="mt-2.5 flex flex-wrap gap-1.5">
              {subscriptions.map((sub, index) => (
                <li
                  key={`${sub.topic}:${index}`}
                  className="inline-flex items-center gap-1.5 rounded-md border border-surface-border bg-surface-sunken px-2 py-1 text-[11px]"
                >
                  <span className="font-mono text-ink">{sub.topic}</span>
                  <span className="wb-tone wb-tone-info">QoS {sub.qos}</span>
                  <button
                    type="button"
                    className="inline-flex h-4 w-4 items-center justify-center rounded text-ink-faint hover:bg-surface hover:text-red-600 disabled:opacity-40"
                    title={t("protocol.mqtt.unsubscribe")}
                    aria-label={t("protocol.mqtt.unsubscribeTopic", { topic: sub.topic })}
                    disabled={!live || mqttBusy}
                    onClick={() => void unsubscribeMqtt(sub.topic)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2.5 text-xs text-ink-faint">
              {t("protocol.mqtt.noSubscriptions")}
            </p>
          )}
        </section>

        {/* ---------------------------------------------------------------- 发布 */}
        <section className="rounded-lg border border-surface-border bg-surface p-3">
          <h3 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-ink">
            <Send className="h-3.5 w-3.5 text-brand-500" />
            {t("protocol.mqtt.publishTitle")}
          </h3>
          <div className="space-y-2">
            <label className="block">
              <span className="mb-1 block text-xs text-ink-soft">
                {t("protocol.mqtt.publishTopic")}
              </span>
              <input
                className={`${inputClass} font-mono text-xs`}
                value={mqttPublish.topic}
                spellCheck={false}
                placeholder={t("protocol.mqtt.publishTopicPlaceholder")}
                aria-label={t("protocol.mqtt.publishTopicAria")}
                onChange={(event) => setMqttPublish({ topic: event.target.value })}
              />
            </label>

            <div className="flex flex-wrap items-center gap-4">
              <label className="block">
                <span className="mb-1 block text-xs text-ink-soft">QoS</span>
                <Select
                  className={`${inputClass} !w-44`}
                  value={String(mqttPublish.qos)}
                  aria-label={t("protocol.mqtt.publishQosAria")}
                  onChange={(event) =>
                    setMqttPublish({ qos: toQos(event.target.value) })
                  }
                >
                  {QOS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex items-center gap-1.5 pt-4 text-xs text-ink-soft">
                <input
                  type="checkbox"
                  className="accent-brand-500"
                  checked={mqttPublish.retain}
                  aria-label={t("protocol.mqtt.retainAria")}
                  onChange={(event) =>
                    setMqttPublish({ retain: event.target.checked })
                  }
                />
                {t("protocol.mqtt.retain")}
              </label>
            </div>

            <label className="block">
              <span className="mb-1 block text-xs text-ink-soft">
                {t("protocol.mqtt.payload")}
              </span>
              <textarea
                className={`${inputClass} h-24 resize-y font-mono text-xs`}
                value={mqttPublish.payload}
                spellCheck={false}
                placeholder={'{\n  "hello": "mqtt"\n}'}
                aria-label={t("protocol.mqtt.payloadAria")}
                onChange={(event) => setMqttPublish({ payload: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.ctrlKey || event.metaKey || !event.shiftKey)) {
                    event.preventDefault();
                    doPublish();
                  }
                }}
              />
            </label>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-2xs text-ink-faint">
                {t("protocol.common.enterSendHint")}
              </span>
              <Button
                size="sm"
                variant="primary"
                disabled={!live || mqttBusy || !mqttPublish.topic.trim()}
                onClick={doPublish}
              >
                {mqttBusy ? (
                  <Spinner className="h-3.5 w-3.5" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                {t("protocol.mqtt.publishBtn")}
              </Button>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- 消息时间线 */}
        <section className="flex flex-col overflow-hidden rounded-lg border border-surface-border bg-surface">
          <div className="flex shrink-0 items-center gap-2 border-b border-surface-border px-3 py-2">
            <Cable className="h-3.5 w-3.5 text-brand-500" />
            <h3 className="text-xs font-semibold text-ink">
              {t("protocol.mqtt.timeline")}
            </h3>
            <span className="wb-tone wb-tone-muted">
              {t("protocol.common.msgCount", { count: messages.length })}
            </span>
            {!live && (
              <span className="ml-auto text-2xs text-ink-faint">
                {t("protocol.mqtt.notConnected")}
              </span>
            )}
          </div>
          <div
            ref={timelineRef}
            className="scrollbar-thin flex max-h-80 min-h-[168px] flex-col gap-2 overflow-y-auto bg-surface-muted p-3"
          >
            {messages.length === 0 ? (
              <div className="wb-empty">
                <Radio className="mb-1 h-7 w-7 opacity-60" />
                <p className="wb-empty-title">{t("protocol.common.noMessages")}</p>
                <p className="max-w-sm text-xs leading-relaxed text-ink-faint">
                  {t("protocol.mqtt.timelineEmptyDesc")}
                </p>
              </div>
            ) : (
              messages.map((entry, index) => (
                <TimelineRow key={index} entry={entry} />
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
