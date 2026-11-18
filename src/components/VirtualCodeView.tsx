import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n";
import { BODY_WINDOW_LINES, windowFor } from "../lib/bodyWindow.ts";

export interface VirtualCodeViewProps {
  /** Static lines, used when no async loader is supplied. */
  lines?: string[];
  totalLines: number;
  rowHeight?: number;
  highlight?: boolean;
  onLoadWindow?: (startLine: number, count: number) => Promise<string[]>;
  bodyId?: string;
  className?: string;
}

const DEFAULT_ROW_HEIGHT = 20;
const OVERSCAN = 12;

/** Token highlighting for a single line. Never uses innerHTML. */
function HighlightedCode({ text }: { text: string }) {
  const nodes = useMemo(() => {
    const parts: ReactNode[] = [];
    const pattern =
      /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
    let lastIndex = 0;
    let key = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
      if (match[1]) {
        parts.push(
          <span key={key++} className={match[2] ? "wb-json-key" : "wb-json-string"}>
            {match[1]}
          </span>,
        );
        if (match[2]) parts.push(<span key={key++}>{match[2]}</span>);
      } else if (match[3]) {
        parts.push(
          <span key={key++} className="wb-json-number">
            {match[3]}
          </span>,
        );
      } else if (match[4]) {
        parts.push(
          <span key={key++} className="wb-json-bool">
            {match[4]}
          </span>,
        );
      }
      lastIndex = pattern.lastIndex;
    }
    parts.push(text.slice(lastIndex));
    return parts;
  }, [text]);
  return <>{nodes}</>;
}

interface LoadedWindow {
  start: number;
  rows: string[];
}

/**
 * Dependency-free row virtualization: a fixed-height spacer plus a translated
 * visible-row container. Fetches line windows on demand via `onLoadWindow`.
 */
export function VirtualCodeView({
  lines,
  totalLines,
  rowHeight = DEFAULT_ROW_HEIGHT,
  highlight = false,
  onLoadWindow,
  bodyId,
  className,
}: VirtualCodeViewProps) {
  const t = useT();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [loaded, setLoaded] = useState<LoadedWindow | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return undefined;
    const measure = () => setViewportHeight(element.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const safeTotal = Math.max(1, Math.floor(totalLines) || 1);
  const viewWindow = windowFor(
    scrollTop,
    viewportHeight || 400,
    rowHeight,
    OVERSCAN,
    safeTotal,
  );

  // Align fetches to a fixed line grid so scrolling reuses cached windows.
  const fetchStart = Math.floor(viewWindow.startLine / BODY_WINDOW_LINES) * BODY_WINDOW_LINES;
  const fetchEnd = Math.max(
    viewWindow.startLine + viewWindow.count,
    fetchStart + BODY_WINDOW_LINES,
  );
  const fetchCount = Math.max(
    0,
    Math.min(fetchEnd - fetchStart, safeTotal - fetchStart),
  );

  // A new bodyId invalidates everything fetched for the previous one.
  useEffect(() => {
    setLoaded(null);
    setScrollTop(0);
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [bodyId]);

  useEffect(() => {
    if (!onLoadWindow || fetchCount <= 0) return undefined;
    const seq = ++requestSeq.current;
    let active = true;
    onLoadWindow(fetchStart, fetchCount).then(
      (rows) => {
        if (active && seq === requestSeq.current) {
          setLoaded({ start: fetchStart, rows });
        }
      },
      () => {
        if (active && seq === requestSeq.current) {
          setLoaded({ start: fetchStart, rows: [] });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [onLoadWindow, fetchStart, fetchCount, bodyId]);

  const lineAt = (lineNo: number): string | undefined => {
    if (onLoadWindow) {
      if (!loaded) return undefined;
      const index = lineNo - loaded.start;
      return index >= 0 && index < loaded.rows.length ? loaded.rows[index] : undefined;
    }
    return lines ? lines[lineNo] : undefined;
  };

  const rows: ReactNode[] = [];
  for (let i = 0; i < viewWindow.count; i++) {
    const lineNo = viewWindow.startLine + i;
    const content = lineAt(lineNo);
    rows.push(
      <div key={lineNo} className="wb-vcode-row" style={{ height: rowHeight }}>
        <span className="wb-vcode-lineno">{lineNo + 1}</span>
        <span className="wb-vcode-line">
          {content === undefined ? (
            <span className="wb-vcode-placeholder">…</span>
          ) : highlight ? (
            <HighlightedCode text={content} />
          ) : (
            content
          )}
        </span>
      </div>,
    );
  }

  return (
    <div
      ref={viewportRef}
      className={`wb-vcode ${className ?? ""}`}
      role="region"
      aria-label={t("testing.vcode.aria")}
      tabIndex={0}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className="wb-vcode-spacer" style={{ height: safeTotal * rowHeight }}>
        <div
          className="wb-vcode-window"
          style={{ transform: `translateY(${viewWindow.offsetTop}px)` }}
        >
          {rows}
        </div>
      </div>
    </div>
  );
}
