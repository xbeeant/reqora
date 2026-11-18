/** Pure helpers for the "smart" response views. Kept framework-free so the
 * Node 22 test runner can import them directly. */

import type { ResponseData, ResponseTimings } from "../types";

const BITMAP_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/tiff",
]);

/** Base64 prefixes of common image signatures, used when Content-Type lies. */
const MAGIC: [string, string][] = [
  ["iVBORw0KGgo", "image/png"],
  ["/9j/", "image/jpeg"],
  ["R0lGOD", "image/gif"],
  ["UklGR", "image/webp"],
  ["Qk0", "image/bmp"],
  ["AAABAA", "image/x-icon"],
];

export interface ImagePreview {
  mime: string;
  dataUrl: string;
  /** True when the MIME came from the bytes rather than the Content-Type. */
  sniffed: boolean;
}

export function headerValue(response: ResponseData, name: string): string {
  const target = name.toLowerCase();
  return (
    response.headers.find((header) => header.name.toLowerCase() === target)?.value ?? ""
  );
}

/**
 * Decide whether a binary response can be rendered as an image. SVG is
 * intentionally excluded: it is XML, not a bitmap stream, and rendering it via
 * a data: URL would be an unnecessary XSS surface.
 */
export function detectImage(response: ResponseData): ImagePreview | null {
  if (!response.body || response.bodyKind !== "binary") return null;
  const contentType = headerValue(response, "content-type");
  const declared = contentType.split(";")[0].trim().toLowerCase();
  if (declared === "image/svg+xml") return null;

  const base64 = response.body.replace(/\s/g, "");
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    return null;
  }

  let mime = BITMAP_MIMES.has(declared) ? declared : "";
  let sniffed = false;
  if (!mime) {
    for (const [prefix, candidate] of MAGIC) {
      if (base64.startsWith(prefix)) {
        mime = candidate;
        sniffed = true;
        break;
      }
    }
  }
  if (!mime) return null;
  return { mime, dataUrl: `data:${mime};base64,${base64}`, sniffed };
}

export interface TimingRow {
  key: "dns" | "tcp" | "tls" | "server" | "transfer";
  label: string;
  ms: number;
  hint: string;
  /** TCP + TLS are measured together on https; render them as one bar. */
  merged: boolean;
}

/** Five-row breakdown. Every number comes straight from Rust checkpoints. */
export function timingRows(timings: ResponseTimings): TimingRow[] {
  return [
    {
      key: "dns",
      label: "DNS",
      ms: timings.dnsMs,
      hint: timings.reused ? "未发生解析（连接复用 / 字面 IP）" : "域名解析",
      merged: false,
    },
    {
      key: "tcp",
      label: "TCP",
      ms: timings.tcpMs,
      hint: timings.tlsMerged ? "TCP 连接 + TLS 握手" : "TCP 连接",
      merged: false,
    },
    {
      key: "tls",
      label: "TLS",
      ms: timings.tlsMs,
      hint: timings.tlsMerged
        ? "并入上方连接阶段（reqwest 不单独暴露握手耗时）"
        : "明文请求，无 TLS 握手",
      merged: timings.tlsMerged,
    },
    {
      key: "server",
      label: "服务器处理",
      ms: timings.serverMs,
      hint: "等待首字节（服务器处理 + 网络往返）",
      merged: false,
    },
    {
      key: "transfer",
      label: "传输",
      ms: timings.transferMs,
      hint: "读取响应体",
      merged: false,
    },
  ];
}

export interface TimingSegment extends TimingRow {
  /** Percentage of the total timeline. */
  width: number;
  offset: number;
}

/** Waterfall offsets; the four real phases always add up to totalMs. */
export function timingSegments(timings: ResponseTimings): TimingSegment[] {
  const rows = timingRows(timings).filter((row) => !row.merged);
  const denominator = Math.max(timings.totalMs, 1);
  let offset = 0;
  return rows.map((row) => {
    const width = Math.max((row.ms / denominator) * 100, row.ms > 0 ? 0.6 : 0);
    const segment = { ...row, width, offset };
    offset += width;
    return segment;
  });
}

export function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms} ms`;
}

/** True when the backend supplied both wire-message reconstructions. */
export function hasRawExchange(response: ResponseData): boolean {
  return typeof response.rawRequest === "string" && typeof response.rawResponse === "string";
}
