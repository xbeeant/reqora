import { api } from "../../../lib/api.ts";
import { DRAFT_SYSTEM_PROMPT } from "../../../lib/ai.ts";
import { buildDraftPrompt } from "../../../lib/ai.ts";
import { parseRequestDraft } from "../../../lib/ai.ts";
import type { OpenTab } from "../../../types.ts";
import { uid } from "../../../lib/id.ts";
import { messageOf } from "../helpers.ts";
import { clone } from "../helpers.ts";
import { firstInvokableMethod } from "../helpers.ts";
import { t } from "../../../i18n/index.ts";
import type { StoreContext } from "../context.ts";
import type { GrpcStreamMessage } from "../../../types.ts";
import type { IntegrationsSlice } from "../types.ts";

export const createIntegrationsSlice = (ctx: StoreContext): IntegrationsSlice => {
  const { set, get, mutate } = ctx;
  return {
    // ---- MCP 服务器 ----
    setMcpModalOpen: (open) => {
      set({ mcpModalOpen: open, mcpError: null });
      if (!open) set({ mcpCallResult: null });
    },

    saveMcpServers: (servers) => {
      mutate((snapshot) => ({ ...snapshot, mcpServers: servers }));
    },

    mcpConnect: async (config) => {
      set({ mcpBusy: config.name, mcpError: null });
      try {
        const result = await api.mcpConnect(config);
        set((state) => ({
          mcpConnections: { ...state.mcpConnections, [config.name]: result },
          mcpBusy: null,
        }));
        return true;
      } catch (error) {
        set({ mcpBusy: null, mcpError: messageOf(error) });
        return false;
      }
    },

    mcpDisconnect: async (name) => {
      set((state) => {
        const connections = { ...state.mcpConnections };
        delete connections[name];
        return { connections, mcpCallResult: null };
      });
      try {
        await api.mcpDisconnect(name);
      } catch {
        // Connection is already gone from the UI; nothing to surface.
      }
    },

    mcpCallTool: async (server, tool, args) => {
      set({ mcpBusy: server, mcpError: null });
      try {
        const outcome = await api.mcpCall(server, tool, args);
        set({
          mcpBusy: null,
          mcpCallResult: { server, tool, outcome },
        });
      } catch (error) {
        set({ mcpBusy: null, mcpError: messageOf(error) });
      }
    },

    clearMcpCallResult: () => set({ mcpCallResult: null, mcpError: null }),

    // ---- AI 生成接口 ----
    setAiModalOpen: (open) => {
      set({ aiModalOpen: open, aiError: null });
      if (!open) set({ aiDraft: null });
    },

    aiGenerate: async (description) => {
      const settings = get().snapshot.settings;
      set({ aiBusy: true, aiError: null, aiDraft: null });
      try {
        const output = await api.aiChat({
          baseUrl: settings.aiBaseUrl ?? "",
          apiKey: settings.aiApiKey ?? "",
          model: settings.aiModel ?? "",
          system: DRAFT_SYSTEM_PROMPT,
          user: buildDraftPrompt(description),
        });
        const { draft, error } = parseRequestDraft(output);
        if (!draft) {
          set({ aiBusy: false, aiError: error ?? t("store.ai.parseFailed") });
          return false;
        }
        set({ aiBusy: false, aiDraft: draft });
        return true;
      } catch (error) {
        set({ aiBusy: false, aiError: messageOf(error) });
        return false;
      }
    },

    importAiDraft: (collectionId) => {
      const draft = get().aiDraft;
      if (!draft) return;
      const request = clone(draft);
      const target =
        collectionId ??
        get().activeCollectionId ??
        get().snapshot.collections[0]?.id;
      const exists = get().snapshot.collections.some(
        (collection) => collection.id === target,
      );
      if (target && exists) {
        mutate((snapshot) => ({
          ...snapshot,
          collections: snapshot.collections.map((collection) =>
            collection.id === target
              ? { ...collection, items: [...collection.items, request] }
              : collection,
          ),
        }));
      }
      const tab: OpenTab = { kind: "request", id: request.id };
      set({
        draft: request,
        activeTab: tab,
        activeCollectionId: target ?? null,
        tabs: [...get().tabs, tab],
        aiDraft: null,
        aiModalOpen: false,
      });
    },

    discardAiDraft: () => set({ aiDraft: null, aiError: null }),

    // ---- gRPC 调试 ----
    setGrpcModalOpen: (open) => {
      set({ grpcModalOpen: open, grpcError: null });
      if (!open) set({ grpcResult: null });
    },

    pickProto: async () => {
      set({ grpcBusy: "compile", grpcError: null, grpcResult: null });
      try {
        const files = await api.pickProtoFiles();
        const schema = await api.grpcCompile(files);
        set({
          grpcFiles: files,
          grpcSchema: schema,
          grpcBusy: null,
          grpcMethodPath: firstInvokableMethod(schema),
        });
      } catch (error) {
        set({ grpcBusy: null, grpcError: messageOf(error) });
      }
    },

    // 无 .proto 时：通过 gRPC server reflection 从服务器拉取 service 定义。
    grpcReflect: async () => {
      const address = get().grpcAddress.trim();
      if (!address) {
        set({ grpcError: t("store.grpc.addressRequired") });
        return;
      }
      set({ grpcBusy: "reflect", grpcError: null, grpcResult: null });
      try {
        const schema = await api.grpcReflect(address, {
          verifyTls: get().grpcVerifyTls,
          caPem: get().grpcCaPem.trim() || undefined,
        });
        set({
          grpcFiles: [],
          grpcSchema: schema,
          grpcBusy: null,
          grpcMethodPath: firstInvokableMethod(schema),
        });
      } catch (error) {
        set({ grpcBusy: null, grpcError: messageOf(error) });
      }
    },

    selectGrpcMethod: (path) =>
      set({ grpcMethodPath: path, grpcResult: null, grpcError: null }),

    setGrpcAddress: (address) => set({ grpcAddress: address }),
    setGrpcMessage: (message) => set({ grpcMessage: message }),
    setGrpcVerifyTls: (verifyTls) => set({ grpcVerifyTls: verifyTls }),
    setGrpcCaPem: (caPem) => set({ grpcCaPem: caPem }),

    grpcInvoke: async () => {
      const {
        grpcSchema,
        grpcMethodPath,
        grpcAddress,
        grpcMessage,
        grpcVerifyTls,
        grpcCaPem,
      } = get();
      if (!grpcSchema || !grpcMethodPath) return;
      // path = /pkg.Service/Method
      const withoutSlash = grpcMethodPath.replace(/^\//, "");
      const idx = withoutSlash.lastIndexOf("/");
      const service = withoutSlash.slice(0, idx);
      const method = withoutSlash.slice(idx + 1);
      set({ grpcBusy: "invoke", grpcError: null, grpcResult: null });
      try {
        const result = await api.grpcInvoke({
          descriptorId: grpcSchema.descriptorId,
          address: grpcAddress.trim(),
          service,
          method,
          messageJson: grpcMessage,
          headers: {},
          verifyTls: grpcVerifyTls,
          caPem: grpcCaPem.trim() || undefined,
        });
        set({ grpcBusy: null, grpcResult: result });
      } catch (error) {
        set({ grpcBusy: null, grpcError: messageOf(error) });
      }
    },

    // ---- gRPC client / bidirectional streaming ----
    grpcStreamStart: async () => {
      const state = get();
      const schema = state.grpcSchema;
      const path = (state.grpcMethodPath || "").trim();
      if (!schema?.descriptorId || !path || !state.grpcAddress.trim()) {
        set({ grpcError: t("store.grpc.streamPrereq") });
        return;
      }
      const parts = path.replace(/^\//, "").split("/");
      if (parts.length < 2) {
        set({ grpcError: t("store.grpc.badMethodPath") });
        return;
      }
      const method = parts.pop() as string;
      const service = parts.join("/");
      const sessionId = uid();
      const initial = state.grpcMessage.trim() ? [state.grpcMessage] : [];
      set({
        grpcStreamBusy: true,
        grpcError: null,
        grpcStream: {
          sessionId,
          status: "open",
          messages: [],
        },
      });
      const push = (direction: "in" | "out", json: unknown, atMs: number) =>
        set((prev) => {
          const session = prev.grpcStream;
          if (!session || session.sessionId !== sessionId) return {};
          return {
            grpcStream: {
              ...session,
              messages: [...session.messages, { direction, json, atMs }].slice(-500),
            },
          };
        });
      try {
        await api.grpcStreamStart(
          {
            descriptorId: schema.descriptorId,
            address: state.grpcAddress.trim(),
            service,
            method,
            headers: {},
            initialMessages: initial,
            verifyTls: state.grpcVerifyTls,
            caPem: state.grpcCaPem.trim() || undefined,
          },
          sessionId,
          (raw) => {
            const message = raw as GrpcStreamMessage;
            if (!message || typeof message !== "object") return;
            if (message.kind === "message") {
              push(message.direction === "out" ? "out" : "in", message.json, message.atMs);
            } else if (message.kind === "done") {
              set((prev) => ({
                grpcStream: prev.grpcStream
                  ? { ...prev.grpcStream, status: "closed", statusCode: message.status }
                  : prev.grpcStream,
                grpcStreamBusy: false,
              }));
            } else if (message.kind === "error") {
              set((prev) => ({
                grpcStream: prev.grpcStream
                  ? { ...prev.grpcStream, status: "error", error: message.message }
                  : prev.grpcStream,
                grpcError: message.message,
                grpcStreamBusy: false,
              }));
            }
          },
        );
        initial.forEach((item, index) => push("out", item, index));
        set({ grpcStreamBusy: false });
      } catch (error) {
        set({ grpcError: messageOf(error), grpcStreamBusy: false });
      }
    },

    grpcStreamSend: async (message) => {
      const state = get();
      const session = state.grpcStream;
      if (!session || session.status !== "open") return;
      const text = (message ?? state.grpcMessage).trim();
      if (!text) return;
      try {
        await api.grpcStreamSend(session.sessionId, text);
      } catch (error) {
        set({ grpcError: messageOf(error) });
      }
    },

    grpcStreamClose: async () => {
      const session = get().grpcStream;
      if (!session) return;
      try {
        await api.grpcStreamClose(session.sessionId);
      } catch (error) {
        set({ grpcError: messageOf(error) });
      }
    },

    grpcStreamCancel: async () => {
      const session = get().grpcStream;
      if (!session) return;
      try {
        await api.grpcStreamCancel(session.sessionId);
      } catch (error) {
        set({ grpcError: messageOf(error) });
      }
      set({ grpcStream: null, grpcStreamBusy: false });
    },
  };
};
