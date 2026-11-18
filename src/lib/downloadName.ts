/**
 * Zero-import naming helper for the "send and download" action.
 *
 * Kept dependency-free so it can be unit-tested under plain Node. The shape
 * is intentionally structural: `ResponseData` and `RequestDraft` both satisfy
 * it without importing the (Tauri-flavoured) domain types here.
 */

export interface DownloadNameSource {
  headers?: { name: string; value: string }[];
  url?: string;
  resolvedUrl?: string;
}

const EXT_BY_MIME: Record<string, string> = {
  "application/json": ".json",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "application/x-tar": ".tar",
  "application/xml": ".xml",
  "application/octet-stream": ".bin",
  "application/msword": ".doc",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/xml": ".xml",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "audio/mpeg": ".mp3",
  "video/mp4": ".mp4",
};

const HAS_EXTENSION = /\.[a-z0-9]{1,10}$/i;

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** RFC 6266: `filename*` (with optional charset/language) wins over `filename`. */
export function fileNameFromContentDisposition(value: string | undefined): string | null {
  if (!value) return null;
  const star = /filename\*\s*=\s*([^;]+)/i.exec(value);
  if (star) {
    const raw = star[1].trim().replace(/^["']|["']$/g, "");
    const parts = raw.split("'");
    const encoded = parts.length >= 3 ? parts.slice(2).join("'") : raw;
    return decodeParam(encoded);
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]*))/i.exec(value);
  if (plain) return (plain[1] ?? plain[2] ?? plain[3] ?? "").trim();
  return null;
}

/** Last path segment of a URL; template segments (`{{id}}`) are not file names. */
function fromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const path = url.split(/[?#]/, 1)[0] ?? "";
  const last = path.split(/[\\/]/).filter(Boolean).pop();
  if (!last || last.includes("{") || last.includes("}")) return null;
  return decodeParam(last);
}

/** Keep Unicode file names, drop only characters illegal on Windows / POSIX. */
function safe(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .split(/[\\/]/).pop()!
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
}

function extensionFor(contentType: string): string {
  const mime = contentType.split(";", 1)[0].trim().toLowerCase();
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  if (mime.startsWith("text/")) return ".txt";
  if (mime.startsWith("image/")) {
    const subtype = mime.slice(6).split("+", 1)[0];
    return /^[a-z0-9]{1,8}$/.test(subtype) ? `.${subtype}` : ".bin";
  }
  return ".bin";
}

/**
 * Choose a safe default for the native "save as" dialog:
 * Content-Disposition → URL path (when it looks like a file) → request name.
 */
export function suggestDownloadFileName(
  response: DownloadNameSource,
  requestName: string,
  fallbackUrl = "",
): string {
  const headers = response.headers ?? [];
  const headerValue = (name: string) =>
    headers.find((header) => header.name.toLowerCase() === name)?.value ?? "";

  const fromHeader = safe(fileNameFromContentDisposition(headerValue("content-disposition")));
  const fromPath = safe(fromUrl(response.resolvedUrl || response.url || fallbackUrl));
  const fromName = safe(requestName);

  const base =
    fromHeader ||
    (fromPath && HAS_EXTENSION.test(fromPath) ? fromPath : "") ||
    fromName ||
    fromPath ||
    "download";
  if (HAS_EXTENSION.test(base)) return base;
  return `${base}${extensionFor(headerValue("content-type"))}`;
}
