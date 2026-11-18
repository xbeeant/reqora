import { api } from "../../../lib/api.ts";
import { sendRequest } from "../../../lib/api.ts";
import { dbSpecFromConfig } from "../../../lib/scenario.ts";
import { evaluateDbStep } from "../../../lib/scenario.ts";
import { moveStep } from "../../../lib/scenario.ts";
import { newDbStep } from "../../../lib/scenario.ts";
import { newWaitStep } from "../../../lib/scenario.ts";
import { resolveDbConnectionUrl } from "../../../lib/scenario.ts";
import { stepFromCase } from "../../../lib/scenario.ts";
import { stepFromRequest } from "../../../lib/scenario.ts";
import { runScenario as runScenarioEngine } from "../../../lib/scenarioRunner.ts";
import { uid } from "../../../lib/id.ts";
import { INTROSPECTION_QUERY } from "../../../lib/graphql.ts";
import { parseIntrospection } from "../../../lib/graphql.ts";
import { variablesFrom } from "../../../lib/template.ts";
import { resolveRequestDraft } from "../../../lib/resolveRequest.ts";
import type { DbQueryResult } from "../../../types.ts";
import type { TestScenario } from "../../../types.ts";
import type { WsClientMessage } from "../../../types.ts";
import type { WsSessionState } from "../../../types.ts";
import type { TcpDebugSpec } from "../../../types.ts";
import { messageOf } from "../helpers.ts";
import { clone } from "../helpers.ts";
import { withGlobalHeaders } from "../helpers.ts";
import { executePipeline } from "../pipeline.ts";
import { buildHistoryStep, buildScenarioRunRecord } from "../../../lib/historyRecord.ts";
import type { HistoryResponseCapture } from "../../../lib/historyRecord.ts";
import type { HistoryRunStep } from "../../../types.ts";
import { historyContextOf } from "./history.ts";
import { t } from "../../../i18n/index.ts";
import type { StoreContext } from "../context.ts";
import { parseMqttUrl } from "../../../lib/mqtt.ts";
import type { MqttSessionState } from "../../../types.ts";
import type { MqttTimelineEntry } from "../../../types.ts";
import type { MqttClientMessage } from "../../../types.ts";
import type { ProtocolsSlice } from "../types.ts";

export const createProtocolsSlice = (ctx: StoreContext): ProtocolsSlice => {
  const { set, get, mutate } = ctx;
  return {
    // ---- GraphQL introspection ----

    introspect: async () => {
      const state = get();
      if (state.introspecting) return;
      if (state.draft.body.type !== "graphql") {
        set({ introspectionError: t("store.graphql.notGraphql") });
        return;
      }
      if (!state.draft.url.trim()) {
        set({ introspectionError: t("store.send.urlRequired") });
        return;
      }
      const environment = state.snapshot.environments.find(
        (item) => item.id === state.snapshot.activeEnvironmentId,
      );
      set({ introspecting: true, introspectionError: null });
      try {
        // 直接走 sendRequest：不经过脚本管线，也不写请求历史。
        const response = await sendRequest(
          withGlobalHeaders(
            {
              ...clone(state.draft),
              name: "IntrospectionQuery",
              body: {
                type: "json",
                content: JSON.stringify({ query: INTROSPECTION_QUERY }),
              },
            },
            get().snapshot,
          ),
          {
            variables: variablesFrom(environment?.variables ?? []),
            settings: state.snapshot.settings,
          },
        );
        const schema = parseIntrospection(response);
        set({ introspecting: false, introspectionSchema: schema });
      } catch (error) {
        set({ introspecting: false, introspectionError: messageOf(error), introspectionSchema: null });
      }
    },

    clearIntrospection: () =>
      set({ introspectionSchema: null, introspectionError: null }),

    duplicateScenario: (id) => {
      const state = get();
      const source = state.snapshot.scenarios.find((item) => item.id === id);
      if (!source) return;
      const now = Date.now();
      const copy: TestScenario = {
        ...clone(source),
        id: uid(),
        name: `${source.name} 副本`,
        steps: source.steps.map((step) => ({ ...step, id: uid() })),
        createdAt: now,
        updatedAt: now,
        lastRun: undefined,
        runHistory: undefined,
      };
      mutate((snapshot) => ({
        ...snapshot,
        scenarios: [...snapshot.scenarios, copy],
      }));
    },

    addScenarioStepFromCase: (scenarioId, caseId) => {
      const state = get();
      const caseItem = state.snapshot.cases.find((item) => item.id === caseId);
      const scenario = state.snapshot.scenarios.find((item) => item.id === scenarioId);
      if (!caseItem || !scenario) return;
      const step = stepFromCase(caseItem);
      mutate((snapshot) => ({
        ...snapshot,
        scenarios: snapshot.scenarios.map((item) =>
          item.id === scenarioId
            ? { ...item, steps: [...item.steps, step], updatedAt: Date.now() }
            : item,
        ),
      }));
    },

    addScenarioDbStep: (scenarioId) => {
      mutate((snapshot) => ({
        ...snapshot,
        scenarios: snapshot.scenarios.map((item) =>
          item.id === scenarioId
            ? { ...item, steps: [...item.steps, newDbStep()], updatedAt: Date.now() }
            : item,
        ),
      }));
    },

    addScenarioWaitStep: (scenarioId) => {
      mutate((snapshot) => ({
        ...snapshot,
        scenarios: snapshot.scenarios.map((item) =>
          item.id === scenarioId
            ? { ...item, steps: [...item.steps, newWaitStep()], updatedAt: Date.now() }
            : item,
        ),
      }));
    },

    addScenarioStepFromDraft: (scenarioId) => {
      const state = get();
      const scenario = state.snapshot.scenarios.find((item) => item.id === scenarioId);
      if (!scenario) return;
      const step = stepFromRequest(state.draft);
      mutate((snapshot) => ({
        ...snapshot,
        scenarios: snapshot.scenarios.map((item) =>
          item.id === scenarioId
            ? { ...item, steps: [...item.steps, step], updatedAt: Date.now() }
            : item,
        ),
      }));
    },

    updateScenarioStep: (scenarioId, stepId, patch) => {
      mutate((snapshot) => ({
        ...snapshot,
        scenarios: snapshot.scenarios.map((item) =>
          item.id === scenarioId
            ? {
                ...item,
                steps: item.steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step)),
                updatedAt: Date.now(),
              }
            : item,
        ),
      }));
    },

    deleteScenarioStep: (scenarioId, stepId) => {
      mutate((snapshot) => ({
        ...snapshot,
        scenarios: snapshot.scenarios.map((item) =>
          item.id === scenarioId
            ? {
                ...item,
                steps: item.steps.filter((step) => step.id !== stepId),
                updatedAt: Date.now(),
              }
            : item,
        ),
      }));
    },

    moveScenarioStep: (scenarioId, stepId, direction) => {
      mutate((snapshot) => ({
        ...snapshot,
        scenarios: snapshot.scenarios.map((item) =>
          item.id === scenarioId
            ? { ...item, steps: moveStep(item.steps, stepId, direction), updatedAt: Date.now() }
            : item,
        ),
      }));
    },

    runScenario: async (id) => {
      const state = get();
      if (state.runningScenarioId) return;
      const scenario = state.snapshot.scenarios.find((item) => item.id === id);
      if (!scenario) return;
      const environment = state.snapshot.environments.find(
        (item) => item.id === state.snapshot.activeEnvironmentId,
      );
      const startedAt = Date.now();
      // 采集每个 HTTP 步骤的完整响应。transport 每调用一次入队一次；onStep
      // 在折叠步骤完成时把队列里的响应全部归属给该步骤（循环步骤可有多份）。
      const pendingCaptures: HistoryResponseCapture[] = [];
      const historySteps: HistoryRunStep[] = [];
      set({ runningScenarioId: id });
      try {
        // 编排规则只有一份实现（src/lib/scenarioRunner.ts）：停用跳过、条件门、
        // 等待、固定次数 / 遍历数组循环、步骤提取、失败中断、数据集多轮。
        // 这里只注入执行器——HTTP 走 executePipeline，数据库走 Rust 桥。
        const run = await runScenarioEngine(scenario, {
          cases: state.snapshot.cases,
          baseVariables: variablesFrom(environment?.variables ?? []),
          // 桌面端把「第 n/N 轮」放在 note 上，运行列表里的步骤名保持原样。
          roundLabelTarget: "note",
          transport: async (request, variables, ownerRequestId) => {
            const stepStart = Date.now();
            const pipelineInput = withGlobalHeaders(clone(request), get().snapshot, ownerRequestId);
            const result = await executePipeline(
              pipelineInput,
              {
                variables,
                settings: get().snapshot.settings,
                signal: new AbortController().signal,
                startedAt: stepStart,
                // 场景执行不走实时视图：SSE 只参与结果汇总，不写入 UI state。
                onSse: () => {},
              },
            );
            const outgoing = result.sentRequest ?? pipelineInput;
            pendingCaptures.push({
              request: resolveRequestDraft(outgoing, result.sentVariables),
              requestTemplate: clone(request),
              response: result.response,
              outcome: result.outcome,
              error: result.error?.message ?? result.outcome.error ?? null,
              timeMs: result.response?.timeMs ?? Date.now() - stepStart,
            });
            return {
              response: result.response,
              timeMs: result.response?.timeMs ?? Date.now() - stepStart,
              error: result.error?.message ?? result.outcome.error ?? null,
              preError: result.outcome.preError ?? null,
              tests: result.outcome.tests,
              assertions: result.outcome.assertions,
              aborted: result.aborted,
              // 与 CLI/MCP 一致：把 pre/post 脚本的 setVar 结果回传给编排器，
              // 供 mergeScriptVariables 折叠进后续步骤的变量表。
              activeVariables: result.activeVariables,
            };
          },
          dbTransport: async (step, variables) => {
            if (step.source.kind !== "db") {
              return { ok: false, timeMs: 0, passed: 0, failed: 1, error: t("store.scenario.notDbStep") };
            }
            const config = step.source.db;
            const stepStart = Date.now();
            let dbResult: DbQueryResult | null = null;
            let dbFailure: string | undefined;
            try {
              dbResult = await api.dbQuery(
                dbSpecFromConfig(
                  {
                    ...config,
                    url: resolveDbConnectionUrl(config, get().snapshot.dbConnections ?? []),
                  },
                  variables,
                ),
              );
            } catch (queryError) {
              dbFailure = messageOf(queryError);
            }
            const evaluated = evaluateDbStep(config, dbResult, dbFailure);
            return {
              status: null,
              ok: evaluated.failed === 0 && !evaluated.error,
              timeMs: dbResult?.elapsedMs ?? Date.now() - stepStart,
              passed: evaluated.passed,
              failed: evaluated.failed,
              error: evaluated.error,
              extracted: evaluated.extracted,
            };
          },
          onStep: (stepResult) => {
            const owned = pendingCaptures.splice(0);
            historySteps.push(buildHistoryStep({
              seq: historySteps.length,
              result: stepResult,
              captures: owned,
            }));
          },
        });

        const summary = run.summary;
        const MAX_HISTORY = 50;
        mutate((snapshot) => ({
          ...snapshot,
          scenarios: snapshot.scenarios.map((item) => {
            if (item.id !== id) return item;
            const history = [summary, ...(item.runHistory ?? [])].slice(0, MAX_HISTORY);
            return { ...item, lastRun: summary, runHistory: history };
          }),
        }));
        // 极少数编排分支（如循环参数解析失败）不触发 onStep：把剩余响应
        // 单独归档，绝不让已发生的 HTTP 响应在历史里丢失。
        if (pendingCaptures.length > 0) {
          historySteps.push(buildHistoryStep({
            seq: historySteps.length,
            result: {
              stepId: "unassigned",
              name: t("store.history.unassignedStep"),
              status: null,
              ok: false,
              skipped: false,
              timeMs: 0,
              passed: 0,
              failed: 0,
              extracted: {},
            },
            captures: pendingCaptures.splice(0),
          }));
        }
        get().appendHistory(buildScenarioRunRecord({
          context: historyContextOf(get()),
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          summary: run.summary,
          steps: historySteps,
          startedAt,
          error: run.ok ? null : t("store.history.scenarioFailed"),
        }));
      } finally {
        set({ runningScenarioId: null });
      }
    },

    // ---- WebSocket debugging ----

    connectWs: async () => {
      const state = get();
      if (state.draft.protocol !== "ws") return;
      const requestId = state.draft.id;
      const existing = state.wsSessions[requestId];
      if (existing && (existing.status === "open" || existing.status === "connecting")) {
        await get().closeWs();
      }
      const sessionId = uid();
      const session: WsSessionState = {
        sessionId,
        requestId,
        status: "connecting",
        url: state.draft.url,
        headers: [],
        messages: [],
        error: null,
      };
      const pushMessage = (requestId: string, entry: WsSessionState["messages"][number]) => {
        set((current) => {
          const target = current.wsSessions[requestId];
          if (!target || target.sessionId !== sessionId) return current;
          return {
            wsSessions: {
              ...current.wsSessions,
              [requestId]: {
                ...target,
                messages: [...target.messages, entry].slice(-500),
              },
            },
          };
        });
      };

      set((current) => ({
        wsSessions: { ...current.wsSessions, [requestId]: session },
      }));
      get().pushConsole({ level: "info", source: "ws", text: t("store.ws.connecting", { url: state.draft.url }) });

      const environment = state.snapshot.environments.find(
        (item) => item.id === state.snapshot.activeEnvironmentId,
      );
      const spec = withGlobalHeaders(clone(state.draft), get().snapshot);
      try {
        await api.wsConnect(
          spec,
          {
            variables: variablesFrom(environment?.variables ?? []),
            settings: state.snapshot.settings,
          },
          sessionId,
          (message: WsClientMessage) => {
            const current = get().wsSessions[requestId];
            if (!current) return;
            switch (message.kind) {
              case "open":
                set((state2) => ({
                  wsSessions: {
                    ...state2.wsSessions,
                    [requestId]: {
                      ...state2.wsSessions[requestId],
                      status: "open",
                      url: message.url,
                      handshakeStatus: message.status,
                      headers: message.headers,
                      connectedAt: Date.now(),
                      messages: [
                        ...state2.wsSessions[requestId].messages,
                        { id: uid(), direction: "sys", data: "", atMs: 0, at: Date.now(), label: t("store.ws.connected", { url: message.url }) },
                      ],
                    },
                  },
                }));
                get().pushConsole({ level: "info", source: "ws", text: t("store.ws.connectedLog", { url: message.url }) });
                break;
              case "message":
                pushMessage(requestId, {
                  id: uid(),
                  direction: "in",
                  data: message.data,
                  atMs: message.atMs,
                  binary: message.binary,
                  at: Date.now(),
                });
                break;
              case "closed":
                set((state2) => ({
                  wsSessions: {
                    ...state2.wsSessions,
                    [requestId]: {
                      ...state2.wsSessions[requestId],
                      status: "closed",
                      closedAt: Date.now(),
                      closeCode: message.code,
                      closeReason: message.reason,
                      messages: [
                        ...state2.wsSessions[requestId].messages,
                        {
                          id: uid(),
                          direction: "sys",
                          data: "",
                          atMs: 0,
                          at: Date.now(),
                          label: t("store.ws.closed") +
                            (message.code != null
                              ? t("store.ws.closedDetail", { detail: `${message.code}${message.reason ? ` ${message.reason}` : ""}` })
                              : ""),
                        },
                      ],
                    },
                  },
                }));
                get().pushConsole({ level: "info", source: "ws", text: t("store.ws.closedLog") });
                break;
              case "error":
                set((state2) => ({
                  wsSessions: {
                    ...state2.wsSessions,
                    [requestId]: {
                      ...state2.wsSessions[requestId],
                      status: "error",
                      error: message.message,
                      messages: [
                        ...state2.wsSessions[requestId].messages,
                        { id: uid(), direction: "sys", data: "", atMs: 0, at: Date.now(), label: message.message, error: true },
                      ],
                    },
                  },
                }));
                get().pushConsole({ level: "error", source: "ws", text: `✕ WS ${message.message}` });
                break;
            }
          },
        );
      } catch (error) {
        const message = messageOf(error);
        set((current2) => ({
          wsSessions: {
            ...current2.wsSessions,
            [requestId]: {
              ...current2.wsSessions[requestId],
              status: "error",
              error: message,
              messages: [
                ...(current2.wsSessions[requestId]?.messages ?? []),
                { id: uid(), direction: "sys", data: "", atMs: 0, at: Date.now(), label: message, error: true },
              ],
            },
          },
        }));
        get().pushConsole({ level: "error", source: "ws", text: t("store.ws.connectFailed", { message }) });
      }
    },

    sendWsMessage: async (text) => {
      const state = get();
      if (state.activeTab?.kind !== "request") return;
      const requestId = state.activeTab.id;
      const session = state.wsSessions[requestId];
      if (!session || session.status !== "open") return;
      try {
        const atMs = await api.wsSend(session.sessionId, text);
        set((current) => ({
          wsSessions: {
            ...current.wsSessions,
            [requestId]: {
              ...current.wsSessions[requestId],
              messages: [
                ...current.wsSessions[requestId].messages,
                { id: uid(), direction: "out", data: text, atMs, at: Date.now() },
              ],
            },
          },
        }));
        get().pushConsole({ level: "info", source: "ws", text: t("store.ws.sentMessage", { count: text.length }) });
      } catch (error) {
        get().pushConsole({ level: "error", source: "ws", text: t("store.ws.sendFailed", { message: messageOf(error) }) });
      }
    },

    closeWs: async () => {
      const state = get();
      if (state.activeTab?.kind !== "request") return;
      const requestId = state.activeTab.id;
      const session = state.wsSessions[requestId];
      if (!session) return;
      try {
        await api.wsClose(session.sessionId);
      } catch {
        // Session may already be gone; treat as closed either way.
      }
      set((current) => {
        const target = current.wsSessions[requestId];
        if (!target) return current;
        return {
          wsSessions: {
            ...current.wsSessions,
            [requestId]: {
              ...target,
              status: target.status === "open" ? "closed" : target.status,
              closedAt: Date.now(),
              messages: [
                ...target.messages,
                { id: uid(), direction: "sys", data: "", atMs: 0, at: Date.now(), label: t("store.ws.disconnectedManual") },
              ],
            },
          },
        };
      });
    },

    clearWsTimeline: () => {
      const state = get();
      if (state.activeTab?.kind !== "request") return;
      const requestId = state.activeTab.id;
      set((current) => {
        const target = current.wsSessions[requestId];
        if (!target) return current;
        return {
          wsSessions: { ...current.wsSessions, [requestId]: { ...target, messages: [] } },
        };
      });
    },

    // ---- TCP raw socket debugging ----
    runTcpDebug: async () => {
      const state = get();
      if (state.draft.protocol !== "tcp") return;
      const environment = state.snapshot.environments.find(
        (item) => item.id === state.snapshot.activeEnvironmentId,
      );
      const spec: TcpDebugSpec = {
        address: state.draft.url.trim(),
        encoding: state.tcpEncoding,
        payload: state.tcpPayload,
        newline: state.tcpNewline,
        connectTimeoutMs: 10000,
        readTimeoutMs: state.tcpReadTimeoutMs,
        variables: variablesFrom(environment?.variables ?? []),
      };
      set({ tcpRunning: true, tcpError: null });
      try {
        const result = await api.tcpDebug(spec);
        set({ tcpRunning: false, tcpResult: result });
      } catch (error) {
        set({ tcpRunning: false, tcpError: messageOf(error) });
      }
    },

    setTcpPayload: (payload) => set({ tcpPayload: payload }),
    setTcpEncoding: (encoding) => set({ tcpEncoding: encoding }),
    setTcpNewline: (newline) => set({ tcpNewline: newline }),
    setTcpReadTimeoutMs: (ms) => set({ tcpReadTimeoutMs: ms }),
    clearTcpResult: () => set({ tcpResult: null, tcpError: null }),


    // ---- MQTT 3.1.1 / 5.0 ----
    setMqttDraft: (patch) => {
      const draft = get().draft;
      const current = draft.mqtt ?? {
        url: draft.url || "mqtt://127.0.0.1:1883",
        version: "3.1.1" as const,
        keepAliveSecs: 60,
        cleanSession: true,
        topic: "",
        qos: 0 as const,
        retain: false,
      };
      get().setDraft({ mqtt: { ...current, ...patch } });
    },

    setMqttPublish: (patch) =>
      set((state) => ({ mqttPublish: { ...state.mqttPublish, ...patch } })),
    setMqttSubInput: (value) => set({ mqttSubInput: value }),
    setMqttSubQos: (qos) => set({ mqttSubQos: qos }),

    connectMqtt: async () => {
      const state = get();
      const draft = state.draft;
      const mqtt = draft.mqtt;
      const url = (mqtt?.url || draft.url || "").trim();
      if (!url) {
        set({ mqttBusy: false });
        get().pushConsole({ level: "error", source: "mqtt", text: t("store.mqtt.brokerRequired") });
        return;
      }
      let parsed: { host: string; port: number; useTls: boolean; transport: string; path?: string; username?: string; password?: string };
      try {
        parsed = parseMqttUrl(url);
      } catch (error) {
        get().pushConsole({ level: "error", source: "mqtt", text: messageOf(error) });
        return;
      }
      const sessionId = uid();
      const requestId = draft.id;
      const startedAt = Date.now();
      const openSession = (next: Partial<MqttSessionState>) =>
        set((prev) => {
          const base: MqttSessionState = prev.mqttSessions[requestId] ?? {
            sessionId,
            status: "connecting",
            messages: [],
            subscriptions: [],
          };
          return {
            mqttSessions: {
              ...prev.mqttSessions,
              [requestId]: { ...base, ...next },
            },
          };
        });
      const append = (entry: MqttTimelineEntry) =>
        set((prev) => {
          const base: MqttSessionState = prev.mqttSessions[requestId] ?? {
            sessionId,
            status: "open",
            messages: [],
            subscriptions: [],
          };
          if (base.sessionId !== sessionId) return {};
          return {
            mqttSessions: {
              ...prev.mqttSessions,
              [requestId]: { ...base, messages: [...base.messages, entry].slice(-500) },
            },
          };
        });
      const line = (direction: "in" | "out" | "sys", text: string, extra: Partial<MqttTimelineEntry> = {}) =>
        append({ direction, data: text, at: Date.now(), atMs: Date.now() - startedAt, ...extra });

      set({ mqttBusy: true });
      openSession({ sessionId, status: "connecting", messages: [], subscriptions: [], error: undefined });
      const spec = {
        host: parsed.host,
        port: parsed.port,
        useTls: parsed.useTls,
        clientId: mqtt?.clientId || `reqora-${sessionId.slice(0, 8)}`,
        username: mqtt?.username ?? parsed.username,
        password: mqtt?.password ?? parsed.password,
        version: mqtt?.version ?? "3.1.1",
        keepAliveSecs: mqtt?.keepAliveSecs ?? 60,
        cleanSession: mqtt?.cleanSession ?? true,
        path: parsed.path,
      };
      try {
        await api.mqttConnect(spec, sessionId, (raw) => {
          const message = raw as MqttClientMessage;
          if (!message || typeof message !== "object") return;
          switch (message.kind) {
            case "open":
              openSession({ status: "open", connectedAt: Date.now() });
              line("sys", t("store.mqtt.connected", { url }));
              break;
            case "subscribed":
              openSession({ subscriptions: (message.topics ?? []).map((topic) => ({ topic, qos: 0 })) });
              line("sys", t("store.mqtt.subscribed", { topics: message.topics.join(", ") }));
              break;
            case "unsubscribed":
              line("sys", t("store.mqtt.unsubscribed", { topics: message.topics.join(", ") }));
              break;
            case "message":
              line("in", message.payload, { topic: message.topic, qos: message.qos as 0 | 1 | 2, retain: message.retain });
              break;
            case "published":
              line("out", t("store.mqtt.published", { topic: message.topic }), { topic: message.topic, qos: message.qos as 0 | 1 | 2, retain: message.retain });
              break;
            case "reconnecting":
              line("sys", t("store.mqtt.reconnecting", { attempt: message.attempt }));
              break;
            case "closed":
              openSession({ status: "closed" });
              line("sys", t("store.mqtt.closed", { reason: message.reason }));
              set({ mqttBusy: false });
              break;
            case "error":
              openSession({ status: "error", error: message.message });
              line("sys", t("store.mqtt.error", { message: message.message }), { error: true });
              set({ mqttBusy: false });
              break;
          }
        });
        // Subscribe to the configured topics on connect.
        const topics = (mqtt?.subscriptions ?? []).filter((item) => item.topic.trim());
        if (topics.length) {
          await api.mqttSubscribe(sessionId, topics.map((item) => ({ topic: item.topic, qos: item.qos })));
        }
        set({ mqttBusy: false });
      } catch (error) {
        openSession({ status: "error", error: messageOf(error) });
        get().pushConsole({ level: "error", source: "mqtt", text: messageOf(error) });
        set({ mqttBusy: false });
      }
    },

    disconnectMqtt: async () => {
      const session = get().mqttSessions[get().draft.id];
      if (!session) return;
      set({ mqttBusy: true });
      try {
        await api.mqttDisconnect(session.sessionId);
        set({ mqttBusy: false });
      } catch (error) {
        get().pushConsole({ level: "error", source: "mqtt", text: messageOf(error) });
        set({ mqttBusy: false });
      }
    },

    publishMqtt: async () => {
      const state = get();
      const session = state.mqttSessions[state.draft.id];
      if (!session || session.status !== "open" || !state.mqttPublish.topic.trim()) return;
      set({ mqttBusy: true });
      try {
        await api.mqttPublish(
          session.sessionId,
          state.mqttPublish.topic,
          state.mqttPublish.payload,
          state.mqttPublish.qos,
          state.mqttPublish.retain,
        );
        set({ mqttBusy: false });
      } catch (error) {
        get().pushConsole({ level: "error", source: "mqtt", text: messageOf(error) });
        set({ mqttBusy: false });
      }
    },

    subscribeMqtt: async () => {
      const state = get();
      const session = state.mqttSessions[state.draft.id];
      const topic = state.mqttSubInput.trim();
      if (!session || session.status !== "open" || !topic) return;
      set({ mqttBusy: true });
      try {
        await api.mqttSubscribe(session.sessionId, [{ topic, qos: state.mqttSubQos }]);
        const draft = state.draft;
        const current = draft.mqtt ?? {
          url: draft.url || "mqtt://127.0.0.1:1883",
          version: "3.1.1" as const,
          keepAliveSecs: 60,
          cleanSession: true,
          topic,
          qos: state.mqttSubQos,
          retain: false,
        };
        const subscriptions = (current.subscriptions ?? []).filter((item) => item.topic !== topic);
        get().setDraft({
          mqtt: {
            ...current,
            subscriptions: [...subscriptions, { topic, qos: state.mqttSubQos }],
          },
        });
        set({ mqttBusy: false, mqttSubInput: "" });
      } catch (error) {
        get().pushConsole({ level: "error", source: "mqtt", text: messageOf(error) });
        set({ mqttBusy: false });
      }
    },

    unsubscribeMqtt: async (topic) => {
      const state = get();
      const session = state.mqttSessions[state.draft.id];
      if (!session) return;
      try {
        await api.mqttUnsubscribe(session.sessionId, [topic]);
        const current = state.draft.mqtt;
        if (current?.subscriptions) {
          get().setDraft({
            mqtt: {
              ...current,
              subscriptions: current.subscriptions.filter((item) => item.topic !== topic),
            },
          });
        }
      } catch (error) {
        get().pushConsole({ level: "error", source: "mqtt", text: messageOf(error) });
      }
    },

    clearMqttTimeline: () => {
      const requestId = get().draft.id;
      set((prev) => {
        const session = prev.mqttSessions[requestId];
        if (!session) return {};
        return {
          mqttSessions: { ...prev.mqttSessions, [requestId]: { ...session, messages: [] } },
        };
      });
    },
  };
};
