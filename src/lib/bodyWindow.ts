/**
 * Zero-dependency windowing primitives for the virtualized response body
 * viewer. Kept free of any Tauri / React imports so Node's native test runner
 * can load this module directly (type-only syntax is erasable).
 */

/** Number of lines fetched per on-demand window. */
export const BODY_WINDOW_LINES = 200;

export interface LineWindow {
  startLine: number;
  count: number;
  offsetTop: number;
}

/** Split inline text on newlines and return a 0-based line window. */
export function inlineLines(text: string, startLine: number, count: number): string[] {
  const all = text.split("\n");
  const start = Math.max(0, Math.min(Math.floor(startLine) || 0, all.length));
  const wanted = Math.max(0, Math.floor(count) || 0);
  return all.slice(start, Math.min(all.length, start + wanted));
}

/**
 * Compute the visible (plus overscan) line window for a scroll position.
 * Every input is clamped so a negative scrollTop, an empty body, or a
 * viewport taller than the remaining lines stays inside [0, totalLines).
 */
export function windowFor(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number,
  totalLines: number,
): LineWindow {
  const total = Math.max(0, Math.floor(totalLines) || 0);
  const row = rowHeight > 0 ? rowHeight : 1;
  const pad = Math.max(0, Math.floor(overscan) || 0);
  const top = Math.max(0, scrollTop || 0);

  const firstVisible = Math.min(Math.floor(top / row), Math.max(0, total - 1));
  const visible = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / row) + 1);
  const startLine = Math.max(0, Math.min(firstVisible - pad, Math.max(0, total - 1)));
  const endLine = Math.min(total, Math.max(startLine, firstVisible + visible + pad));
  return {
    startLine,
    count: Math.max(0, endLine - startLine),
    offsetTop: startLine * row,
  };
}

interface CacheEntry {
  bodyId: string;
  startLine: number;
  lines: string[];
}

function cacheKey(bodyId: string, startLine: number, count: number): string {
  return `${bodyId}\u0000${startLine}\u0000${count}`;
}

/**
 * LRU cache of decoded line windows, keyed by bodyId. Adjacent cached windows
 * are stitched together when they fully cover a requested range.
 */
export class BodyWindowCache {
  capacity: number;
  windows: Map<string, CacheEntry> = new Map();

  constructor(capacity = 24) {
    this.capacity = Math.max(1, Math.floor(capacity) || 1);
  }

  touch(key: string, entry: CacheEntry): void {
    this.windows.delete(key);
    this.windows.set(key, entry);
  }

  get(bodyId: string, startLine: number, count: number): string[] | undefined {
    const start = Math.max(0, Math.floor(startLine) || 0);
    const wanted = Math.max(0, Math.floor(count) || 0);
    if (wanted === 0) return [];

    const exactKey = cacheKey(bodyId, start, wanted);
    const exact = this.windows.get(exactKey);
    if (exact) {
      this.touch(exactKey, exact);
      return exact.lines.slice(0, wanted);
    }

    // Assemble the request from any cached windows of the same body.
    const byLine = new Map<number, string>();
    const touched: string[] = [];
    for (const [key, entry] of this.windows) {
      if (entry.bodyId !== bodyId) continue;
      const end = entry.startLine + entry.lines.length;
      if (end <= start || entry.startLine >= start + wanted) continue;
      for (let i = 0; i < entry.lines.length; i++) {
        byLine.set(entry.startLine + i, entry.lines[i]);
      }
      touched.push(key);
    }
    for (let i = 0; i < wanted; i++) {
      if (!byLine.has(start + i)) return undefined;
    }
    for (const key of touched) {
      const entry = this.windows.get(key);
      if (entry) this.touch(key, entry);
    }
    return Array.from({ length: wanted }, (_, i) => byLine.get(start + i) ?? "");
  }

  put(bodyId: string, startLine: number, count: number, lines: string[]): void {
    const start = Math.max(0, Math.floor(startLine) || 0);
    const stored = lines.slice(0, Math.max(0, Math.floor(count) || 0));
    const key = cacheKey(bodyId, start, stored.length);
    this.windows.delete(key);
    this.windows.set(key, { bodyId, startLine: start, lines: stored });
    while (this.windows.size > this.capacity) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }

  has(bodyId: string, startLine: number, count: number): boolean {
    return this.get(bodyId, startLine, count) !== undefined;
  }

  clear(bodyId?: string): void {
    if (bodyId === undefined) {
      this.windows.clear();
      return;
    }
    for (const [key, entry] of this.windows) {
      if (entry.bodyId === bodyId) this.windows.delete(key);
    }
  }
}
