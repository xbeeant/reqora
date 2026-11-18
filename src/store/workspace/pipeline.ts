import { ApiClientError } from "../../lib/api.ts";
import { api } from "../../lib/api.ts";
import { isAbort } from "../../lib/api.ts";
import { sendRequest } from "../../lib/api.ts";
import { streamRequest } from "../../lib/api.ts";
import { uid } from "../../lib/id.ts";
import { materializeResponseBody } from "../../lib/responseBody.ts";
import { evaluateAssertions } from "../../lib/scripts.ts";
import { runScript } from "../../lib/scripts.ts";
import { DEFAULT_MERGE_CONFIG } from "../../lib/sse.ts";
import { createSseMerger } from "../../lib/sse.ts";
import { isEventStreamResponse } from "../../lib/sse.ts";
import { isNdjsonResponse } from "../../lib/sse.ts";
import { parseNdjsonText } from "../../lib/sse.ts";
import { parseSseText } from "../../lib/sse.ts";
import { shouldUseStream } from "../../lib/sse.ts";
import { sseToResponseData } from "../../lib/sse.ts";
import type { RequestDraft } from "../../types.ts";
import type { ResponseData } from "../../types.ts";
import type { ScriptOutcome } from "../../types.ts";
import type { ScriptTest } from "../../types.ts";
import type { SseDone } from "../../types.ts";
import type { SseMeta } from "../../types.ts";
import type { SseState } from "../../types.ts";
import type { WorkspaceSettings } from "../../types.ts";
import { clone } from "./helpers.ts";
import { emptySseState } from "./helpers.ts";
import { toClientError } from "./helpers.ts";
import { t } from "../../i18n/index.ts";

export interface PipelineOptions {
  variables: Record<string, string>;
  settings: WorkspaceSettings;
  signal: AbortSignal;
  startedAt: number;
  /** Live SSE callback: streaming merges publish on every frame. */
  onSse: (sse: SseState) => void;
  /** Force the buffered path so the response always carries a spooled bodyRef. */
  forceBuffered?: boolean;
  /** Skip materialising a spilled body for scripts (download runs keep it on disk). */
  skipFullBodyMaterialization?: boolean;
}

export interface PipelineResult {
  response: ResponseData | null;
  outcome: ScriptOutcome;
  sse: SseState;
  error: ApiClientError | null;
  aborted: boolean;
  /** 脚本跑完后的完整变量表（setVar / unsetVar 的结果），供场景步骤回写。 */
  activeVariables: Record<string, string>;
  /**
   * The request and variable map at the exact moment the transport was called
   * (after pre scripts, before post scripts changed `variables`). Run history
   * freezes this pair so it can store resolved parameter values.
   */
  sentRequest: RequestDraft | null;
  sentVariables: Record<string, string>;
}

/**
 * The single execution pipeline shared by `send` (debug tab) and `runCase` /
 * `runCases` (case runs): pre-script -> HTTP (buffered or SSE stream) ->
 * post-script -> declarative assertions. Pure with respect to the store: all
 * live writes happen through `options.onSse`; everything else is returned to
 * the caller, which decides how to place it in the store.
 */
export async function executePipeline(
  input: RequestDraft,
  options: PipelineOptions,
): Promise<PipelineResult> {
  const { settings, signal, startedAt, onSse } = options;
  let request = input;
  let variables = options.variables;
  let sentRequest: RequestDraft | null = null;
  let sentVariables: Record<string, string> = {};
  // 每个出口都带上最新的变量表，供 runScenario 的 transport 折叠脚本变量；
  // 同时带上发送时刻的请求/变量快照，供历史记录解析真实参数值。
  const pack = (
    partial: Omit<PipelineResult, "activeVariables" | "sentRequest" | "sentVariables">,
  ): PipelineResult => ({
    ...partial,
    activeVariables: variables,
    sentRequest,
    sentVariables,
  });
  const timeoutMs = settings.scriptTimeoutMs ?? 2000;
  const mergeConfig = settings.sseMerge ?? DEFAULT_MERGE_CONFIG;
  const scriptTests = (tests: { name: string; ok: boolean; message: string }[]): ScriptTest[] =>
    tests.map((test) => ({ ...test, origin: "script" }));
  const outcome: ScriptOutcome = {
    logs: [],
    tests: [],
    mutations: [],
    assertions: [],
    error: null,
    preError: null,
    durationMs: 0,
  };

  // ---- 1. Pre-request script: mutates the request and the variable map ----
  // P1-8：全局前置钩子先执行（失败同样阻断发送），再执行请求级 pre 脚本。
  const globalPre =
    (settings.globalPreScript ?? "").trim() !== ""
      ? await runScript({
          code: settings.globalPreScript ?? "",
          phase: "pre",
          request,
          variables,
          timeoutMs,
        })
      : null;
  if (globalPre) {
    request = globalPre.request;
    variables = globalPre.variables;
    outcome.logs.push(...globalPre.logs);
    outcome.tests.push(...scriptTests(globalPre.tests));
    outcome.mutations.push(...globalPre.mutations);
    outcome.durationMs += globalPre.durationMs;
  }
  const pre = await runScript({
    code: request.preScript ?? "",
    phase: "pre",
    request,
    variables,
    timeoutMs,
  });
  request = pre.request;
  variables = pre.variables;
  outcome.logs.push(...pre.logs);
  outcome.tests.push(...scriptTests(pre.tests));
  outcome.mutations.push(...pre.mutations);
  outcome.preError = globalPre?.error ?? pre.error;
  outcome.durationMs += pre.durationMs;
  sentRequest = clone(request);
  sentVariables = { ...variables };

  // A broken pre script must never send a half-built request upstream.
  if (globalPre?.error || pre.error) {
    return pack({
      response: null,
      outcome,
      sse: emptySseState(),
      error: new ApiClientError({
        code: "SCRIPT_ERROR",
        message: t("store.pipeline.preScriptFailed", { error: String(globalPre?.error ?? pre.error) }),
        requestId: "-",
        retryable: false,
      }),
      aborted: false,
    });
  }
  if (signal.aborted) {
    return pack({ response: null, outcome, sse: emptySseState(), error: null, aborted: true });
  }

  // ---- 2. Post-response script + assertions, shared by every path ----
  const complete = async (
    response: ResponseData,
    sseInfo: { mergedText: string; reasoningText: string; frames: number } | null,
  ): Promise<ResponseData> => {
    // Large responses are spooled to disk and only carry a bounded inline
    // preview. Scripts and assertions still need the whole text, so fetch it
    // on demand here — and only when something actually consumes it. The
    // returned response keeps the preview + bodyRef for the virtual viewer.
    const needsFullBody =
      !options.skipFullBodyMaterialization &&
      ((request.postScript ?? "").trim() !== "" ||
        (settings.globalPostScript ?? "").trim() !== "" ||
        (request.assertions?.length ?? 0) > 0);
    const scriptResponse: ResponseData =
      needsFullBody && response.bodyRef && response.bodyKind !== "binary"
        ? { ...response, body: await materializeResponseBody(response) }
        : response;

    const post = await runScript({
      code: request.postScript ?? "",
      phase: "post",
      request,
      variables,
      response: scriptResponse,
      sse: sseInfo,
      timeoutMs,
    });
    // P1-8：请求级 post 之后执行全局后置钩子（读同一份响应）。
    // 与 CLI/MCP 的拼接式 post 脚本一致：全局钩子在请求级脚本产出的变量表之上
    // 执行，这样请求级 postScript 的 setVar 对全局钩子可见，最终变量表也不丢失。
    variables = post.variables;
    const globalPost =
      (settings.globalPostScript ?? "").trim() !== ""
        ? await runScript({
            code: settings.globalPostScript ?? "",
            phase: "post",
            request,
            variables,
            response: scriptResponse,
            sse: sseInfo,
            timeoutMs,
          })
        : null;
    variables = globalPost?.variables ?? variables;
    outcome.logs.push(...post.logs, ...(globalPost?.logs ?? []));
    outcome.tests.push(...scriptTests(post.tests), ...scriptTests(globalPost?.tests ?? []));
    outcome.mutations.push(...post.mutations, ...(globalPost?.mutations ?? []));
    outcome.assertions = evaluateAssertions(request.assertions, scriptResponse);
    outcome.error = post.error ?? globalPost?.error ?? null;
    outcome.durationMs += post.durationMs + (globalPost?.durationMs ?? 0);
    return response;
  };

  // ---------------------------------------------------------- buffered
  // Download runs always use this path: only `sendRequest` produces a spooled
  // bodyRef, which the native save command needs to copy the full raw bytes.
  if (!shouldUseStream(request) || options.forceBuffered) {
    try {
      const response = await sendRequest(request, { variables, settings, signal });
      const ndjson = isNdjsonResponse(response);
      if (isEventStreamResponse(response) || ndjson) {
        // Fallback: the server answered with a framed stream (SSE or NDJSON)
        // even though the request did not advertise streaming. Merge the
        // buffered body so the readable text and timeline are still available.
        const frames = ndjson ? parseNdjsonText(response.body) : parseSseText(response.body);
        const merger = createSseMerger(mergeConfig);
        let merged = merger.snapshot();
        for (const frame of frames) merged = merger.push(frame);
        const sse: SseState = {
          active: true,
          streaming: false,
          meta: null,
          frames: merged.frames,
          done: {
            frames: frames.length,
            bytes: response.size,
            elapsedMs: response.timeMs,
            truncated: response.truncated,
            cancelled: false,
            timings: response.timings,
            rawResponse: response.rawResponse,
          },
          error: null,
          format: merged.format,
          mergedText: merged.mergedText,
          reasoningText: merged.reasoningText,
          snippets: merged.snippets,
        };
        onSse(sse);
        const finalResponse: ResponseData = {
          ...response,
          body: merged.mergedText || response.body,
          bodyKind: "text",
        };
        await complete(finalResponse, {
          mergedText: merged.mergedText,
          reasoningText: merged.reasoningText,
          frames: frames.length,
        });
        return pack({ response: finalResponse, outcome, sse, error: null, aborted: false });
      }
      await complete(response, null);
      return pack({ response, outcome, sse: emptySseState(), error: null, aborted: false });
    } catch (error) {
      if (isAbort(error)) {
        return pack({ response: null, outcome, sse: emptySseState(), error: null, aborted: true });
      }
      return pack({ response: null, outcome, sse: emptySseState(), error: toClientError(error), aborted: false });
    }
  }

  // ---------------------------------------------------------- streaming
  // Rust keeps the connection open and pushes frames over a per-request
  // Channel. Text is merged on *every* frame, before the stream ends.
  const requestId = uid();
  const merger = createSseMerger(mergeConfig);
  // Channel callbacks run asynchronously; keep their results on an object so
  // the compiler does not narrow these fields to their initial values.
  const received: {
    meta: SseMeta | null;
    done: SseDone | null;
    error: string | null;
    nonSse: ResponseData | null;
  } = { meta: null, done: null, error: null, nonSse: null };
  let sse = emptySseState();

  const publish = (streaming: boolean) => {
    const merged = merger.snapshot();
    sse = {
      active: true,
      streaming,
      meta: received.meta,
      frames: merged.frames,
      done: received.done,
      error: received.error,
      format: merged.format,
      mergedText: merged.mergedText,
      reasoningText: merged.reasoningText,
      snippets: merged.snippets,
    };
    onSse(sse);
  };

  signal.addEventListener("abort", () => {
    void api.cancelStream(requestId);
  });

  try {
    await streamRequest(request, {
      variables,
      settings,
      signal,
      requestId,
      onMessage: (message) => {
        switch (message.kind) {
          case "meta":
            received.meta = message.meta;
            break;
          case "frame":
            merger.push(message.frame);
            break;
          case "done":
            received.done = {
              frames: message.frames,
              bytes: message.bytes,
              elapsedMs: message.elapsedMs,
              truncated: message.truncated,
              cancelled: message.cancelled,
              timings: message.timings,
              rawResponse: message.rawResponse,
            };
            break;
          case "nonSse":
            received.nonSse = message.response;
            break;
          case "error":
            received.error = message.message;
            break;
        }
        publish(true);
      },
    });
  } catch (error) {
    if (isAbort(error)) {
      return pack({ response: null, outcome, sse, error: null, aborted: true });
    }
    return pack({ response: null, outcome, sse, error: toClientError(error), aborted: false });
  }

  // Header said it was not an event stream: behave exactly like a normal
  // buffered response, without making a second request.
  if (received.nonSse) {
    await complete(received.nonSse, null);
    return pack({ response: received.nonSse, outcome, sse: emptySseState(), error: null, aborted: false });
  }

  const merged = merger.snapshot();
  if (!received.meta) {
    return pack({
      response: null,
      outcome,
      sse,
      error: new ApiClientError({
        code: "NETWORK_ERROR",
        message: received.error ?? t("store.pipeline.streamNoHeaders"),
        requestId,
        retryable: false,
      }),
      aborted: false,
    });
  }
  publish(false);
  const streamedResponse = sseToResponseData(
    received.meta,
    merged.frames,
    merged.mergedText,
    received.done?.elapsedMs ?? Date.now() - startedAt,
    requestId,
    received.done?.truncated ?? false,
    {
      timings: received.done?.timings ?? received.meta.timings,
      rawRequest: received.meta.rawRequest,
      rawResponse: received.done?.rawResponse,
    },
  );
  await complete(streamedResponse, {
    mergedText: merged.mergedText,
    reasoningText: merged.reasoningText,
    frames: merged.frames.length,
  });
  return pack({ response: streamedResponse, outcome, sse, error: null, aborted: false });
}
