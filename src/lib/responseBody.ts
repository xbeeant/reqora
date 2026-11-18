/**
 * Loading layer for spilled response bodies. The pure windowing helpers live
 * in ./bodyWindow.ts (zero imports) so they can be unit-tested under Node;
 * this module wires them to the Tauri `read_response_*` commands.
 */
import { api } from "./api.ts";
import type { BodyLines, ResponseData } from "../types.ts";
import { inlineLines, type BodyWindowCache } from "./bodyWindow.ts";

export {
  BODY_WINDOW_LINES,
  BodyWindowCache,
  inlineLines,
  windowFor,
} from "./bodyWindow.ts";
export type { LineWindow } from "./bodyWindow.ts";

/** Matches the Rust-side hard clamp of read_response_lines. */
const MAX_LINE_BATCH = 2000;

/** Fallback hint shown when a spill id is no longer available on disk. */
const STALE_BODY_HINT = "… 落盘内容已失效（仅保留最近 12 个响应），以下为内联预览 …";

export type BodyLinesReader = (
  bodyId: string,
  startLine: number,
  lineCount: number,
) => Promise<BodyLines>;

/**
 * Resolve a line window for a response. Small / inline responses are sliced
 * locally; spilled ones go through the cache and `read_response_lines`. A
 * stale or failing bodyRef degrades to the inline preview instead of throwing.
 */
export async function loadBodyLines(
  response: ResponseData,
  startLine: number,
  count: number,
  cache: BodyWindowCache,
  reader: BodyLinesReader = api.readResponseLines,
): Promise<string[]> {
  const start = Math.max(0, Math.floor(startLine) || 0);
  const wanted = Math.max(0, Math.floor(count) || 0);
  if (wanted === 0) return [];

  const inline = () => inlineLines(response.body ?? "", start, wanted);

  if (!response.bodyRef || response.truncated === false) return inline();

  const cached = cache.get(response.bodyRef, start, wanted);
  if (cached !== undefined) return cached;

  try {
    const result = await reader(response.bodyRef, start, wanted);
    const rows = result && Array.isArray(result.lines) ? result.lines : [];
    if (rows.length === 0) {
      return [STALE_BODY_HINT, ...inline()];
    }
    const stored = rows.slice(0, wanted);
    const base =
      result && typeof result.startLine === "number" && result.startLine >= 0
        ? Math.floor(result.startLine)
        : start;
    cache.put(response.bodyRef, base, stored.length, stored);
    return stored;
  } catch {
    return [STALE_BODY_HINT, ...inline()];
  }
}

/**
 * Materialize the complete decoded body for post-script sandboxes.
 *
 * Line windows are used rather than raw byte slices: a byte slice ending in
 * the middle of a multi-byte UTF-8 sequence would be lossy-decoded twice and
 * corrupt the text. Lines are split only on `\n` on the Rust side, so joining
 * them with `\n` reproduces LF/CRLF bodies byte-for-byte, including a
 * trailing newline (the final empty line).
 */
export async function materializeResponseBody(
  response: ResponseData,
): Promise<string> {
  if (!response.bodyRef || !response.truncated) return response.body ?? "";
  const totalLines = Math.max(1, Math.floor(response.totalLines ?? 1));
  const lines: string[] = [];
  for (let start = 0; start < totalLines; start += MAX_LINE_BATCH) {
    const count = Math.min(MAX_LINE_BATCH, totalLines - start);
    const result = await api.readResponseLines(response.bodyRef, start, count);
    if (!result || !Array.isArray(result.lines) || result.lines.length === 0) break;
    lines.push(...result.lines);
    if (result.lines.length < count) break;
  }
  return lines.join("\n");
}
