import type {
  RequestDraft,
  ResponseData,
  ResponseTimings,
  SseFormat,
  SseFrame,
  SseMergeConfig,
} from "../types";
// Explicit .ts extension: Vite/tsc use bundler resolution and Node 22's native
// type stripping (used by test/sse.test.mjs) needs a real file path.
import { selectPath } from "./scripts.ts";

/**
 * SSE merge engine.
 *
 * Apifox's "自动合并" is the reference: recognise `text/event-stream`, then
 * turn a series of delta fragments into readable text *while the stream is
 * still arriving*. This module is pure data-in/data-out so the same code also
 * works on a fully buffered SSE body (the fallback path).
 */

export const DEFAULT_MERGE_CONFIG: SseMergeConfig = {
  mode: "auto",
  jsonPath: "$.choices[0].delta.content",
  reasoningPath: "",
};

export const FORMAT_LABELS: Record<SseFormat, string> = {
  openai: "OpenAI / DeepSeek 兼容",
  gemini: "Gemini",
  claude: "Claude (Messages)",
  genericJson: "通用 JSON",
  plainText: "纯文本片段",
  custom: "自定义 JSONPath",
  unknown: "尚未识别",
};

const CONTENT_PATHS: Record<Exclude<SseFormat, "custom" | "unknown">, string[]> = {
  openai: [
    "$.choices[0].delta.content",
    "$.choices[0].message.content",
    "$.choices[0].text",
    "$.delta.text",
    "$.output_text",
  ],
  gemini: [
    "$.candidates[0].content.parts[0].text",
    "$.candidates[0].text",
    "$.text",
  ],
  claude: [
    "$.delta.text",
    "$.completion",
    "$.content_block.text",
    "$.text",
  ],
  genericJson: [
    "$.content",
    "$.text",
    "$.answer",
    "$.message.content",
    "$.message",
    "$.delta",
    "$.output",
    "$.result",
    "$.data.text",
    "$.reply",
  ],
  plainText: [],
};

const REASONING_PATHS = [
  "$.choices[0].delta.reasoning_content",
  "$.choices[0].delta.reasoning",
  "$.choices[0].message.reasoning_content",
  "$.reasoning_content",
  "$.reasoning",
  "$.thinking",
  "$.thought",
];

function parseJson(data: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function firstString(root: unknown, paths: string[]): string {
  for (const path of paths) {
    const value = selectPath(root, path);
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return "";
}

export function detectSseFormat(data: string): SseFormat {
  if (!data.trim() || data.trim() === "[DONE]") return "unknown";
  const object = parseJson(data);
  if (!object) return "plainText";
  if ("choices" in object) return "openai";
  if ("candidates" in object) return "gemini";
  if (typeof object.type === "string" && object.type.startsWith("content_block")) return "claude";
  if (typeof object.type === "string" && object.type.startsWith("message_")) return "claude";
  if ("completion" in object) return "claude";
  if (object.type === "response.output_text.delta" || "delta" in object) return "openai";
  return "genericJson";
}

export interface MergeSnapshot {
  format: SseFormat;
  mergedText: string;
  reasoningText: string;
  snippets: string[];
  frames: SseFrame[];
}

export interface SseMerger {
  push: (frame: SseFrame) => MergeSnapshot;
  snapshot: () => MergeSnapshot;
}

/**
 * Incremental merger: every frame immediately updates `mergedText`, so the UI
 * can render the answer being typed out instead of waiting for `Done`.
 */
export function createSseMerger(config: SseMergeConfig = DEFAULT_MERGE_CONFIG): SseMerger {
  const frames: SseFrame[] = [];
  const snippets: string[] = [];
  let format: SseFormat = config.mode === "jsonPath" ? "custom" : "unknown";
  let mergedText = "";
  let reasoningText = "";

  const snapshot = (): MergeSnapshot => ({
    format,
    mergedText,
    reasoningText,
    snippets: [...snippets],
    frames: [...frames],
  });

  const push = (frame: SseFrame): MergeSnapshot => {
    frames.push(frame);
    let text = "";
    let reasoning = "";
    const data = frame.data.trim();

    if (config.mode !== "off" && data && data !== "[DONE]" && frame.event !== "error") {
      if (config.mode === "rawText") {
        text = frame.data;
        format = "plainText";
      } else if (config.mode === "jsonPath") {
        const object = parseJson(data);
        if (object) {
          text = firstString(object, config.jsonPath ? [config.jsonPath] : []);
          if (config.reasoningPath) {
            reasoning = firstString(object, [config.reasoningPath]);
          }
        }
        format = "custom";
      } else {
        const object = parseJson(data);
        if (!object) {
          format = "plainText";
          text = frame.data;
        } else {
          if (format === "unknown") format = detectSseFormat(data);
          const bucket = format === "custom" || format === "unknown" ? "genericJson" : format;
          text = firstString(object, CONTENT_PATHS[bucket]);
          reasoning = firstString(object, REASONING_PATHS);
          // Custom models often nest the fragment deeper; fall back to the
          // generic field list when the built-in paths found nothing.
          if (!text && bucket !== "genericJson") {
            text = firstString(object, CONTENT_PATHS.genericJson);
          }
        }
      }
    } else if (config.mode === "off" && format === "unknown") {
      format = "plainText";
    }

    mergedText += text;
    reasoningText += reasoning;
    snippets.push(text);
    return snapshot();
  };

  return { push, snapshot };
}

/**
 * Client-side framing for a *buffered* SSE body. Used when a request was sent
 * through the ordinary buffered path but the server still answered with
 * `text/event-stream` — the merge still happens, just after the fact.
 */
export function parseSseText(raw: string): SseFrame[] {
  const frames: SseFrame[] = [];
  let dataLines: string[] = [];
  let eventName = "";
  let eventId = "";
  let rawLines: string[] = [];
  let seq = 0;

  const dispatch = () => {
    if (dataLines.length === 0 && !eventName && !eventId) {
      rawLines = [];
      return;
    }
    seq += 1;
    frames.push({
      seq,
      atMs: 0,
      event: eventName || "message",
      id: eventId,
      data: dataLines.join("\n"),
      raw: rawLines.join("\n"),
    });
    dataLines = [];
    eventName = "";
    eventId = "";
    rawLines = [];
  };

  for (const line of raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    const text = line.replace(/^\uFEFF/, "");
    if (text === "") {
      dispatch();
      continue;
    }
    rawLines.push(text);
    if (text.startsWith(":")) continue;
    const colon = text.indexOf(":");
    const name = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "data") dataLines.push(value);
    else if (name === "event") eventName = value;
    else if (name === "id" && !value.includes("\0")) eventId = value;
  }
  dispatch();
  return frames;
}

/** Does this request look like a streaming / SSE call? */
export function shouldUseStream(request: RequestDraft): boolean {
  const mode = request.stream ?? "auto";
  if (mode === "on") return true;
  if (mode === "off") return false;

  const acceptsEventStream = request.headers.some(
    (item) =>
      item.enabled &&
      item.key.trim().toLowerCase() === "accept" &&
      item.value.toLowerCase().includes("event-stream"),
  );
  if (acceptsEventStream) return true;

  const bodyText =
    request.body.type === "json" || request.body.type === "raw"
      ? request.body.content
      : "";
  if (/"stream"\s*:\s*true/i.test(bodyText)) return true;

  return /(?:[?&])stream=true/i.test(request.url);
}

export function isEventStreamResponse(response: ResponseData): boolean {
  return response.headers.some(
    (header) =>
      header.name.toLowerCase() === "content-type" &&
      header.value.toLowerCase().includes("text/event-stream"),
  );
}

/** Does this response declare newline-delimited JSON? */
export function isNdjsonResponse(response: ResponseData): boolean {
  return response.headers.some((header) => {
    const name = header.name.toLowerCase();
    const value = header.value.toLowerCase();
    return (
      name === "content-type" &&
      (value.includes("ndjson") || value.includes("jsonl") || value.includes("jsonlines"))
    );
  });
}

/** Client-side framing for a buffered NDJSON body: one frame per non-empty line. */
export function parseNdjsonText(raw: string): SseFrame[] {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => ({
      seq: index + 1,
      atMs: 0,
      event: "ndjson",
      id: "",
      data: line,
      raw: line,
    }));
}

/** Build the normal ResponseData a post script / assertion sees after a stream. */
export function sseToResponseData(
  meta: {
    status: number;
    statusText: string;
    ok: boolean;
    url: string;
    resolvedUrl: string;
    headers: ResponseData["headers"];
    missingVariables: string[];
  },
  frames: SseFrame[],
  mergedText: string,
  elapsedMs: number,
  requestId: string,
  truncated: boolean,
  extra: {
    timings?: ResponseTimings;
    rawRequest?: string;
    rawResponse?: string;
  } = {},
): ResponseData {
  const isNdjson = frames.length > 0 && frames.every((frame) => frame.event === "ndjson");
  const rawBody = isNdjson
    ? frames.map((frame) => frame.data).join("\n")
    : frames
        .map((frame) => `data: ${frame.data.replace(/\n/g, "\ndata: ")}`)
        .join("\n\n");
  const body = mergedText || rawBody;
  return {
    requestId,
    status: meta.status,
    statusText: meta.statusText,
    ok: meta.ok,
    timeMs: elapsedMs,
    size: rawBody.length,
    url: meta.url,
    resolvedUrl: meta.resolvedUrl,
    missingVariables: meta.missingVariables,
    headers: meta.headers,
    body,
    bodyKind: "text",
    truncated,
    ...(extra.timings ? { timings: extra.timings } : {}),
    ...(extra.rawRequest !== undefined ? { rawRequest: extra.rawRequest } : {}),
    ...(extra.rawResponse !== undefined ? { rawResponse: extra.rawResponse } : {}),
  };
}
