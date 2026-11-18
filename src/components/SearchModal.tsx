import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, FileText, FlaskConical, Search, Send } from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { useLang, useT } from "../i18n";

type Hit =
  | { kind: "request"; id: string; collectionId: string; method: string; title: string; sub: string }
  | { kind: "case"; id: string; method: string; title: string; sub: string }
  | { kind: "doc"; id: string; collectionId: string; method: string; title: string; sub: string };

const METHOD_CLASS: Record<string, string> = {
  GET: "wb-method-get",
  POST: "wb-method-post",
  PUT: "wb-method-put",
  PATCH: "wb-method-patch",
  DELETE: "wb-method-delete",
  HEAD: "wb-method-head",
  OPTIONS: "wb-method-options",
  WS: "wb-method-ws",
};

/**
 * Apifox-style global search (⌘K): jumps straight to an interface, a case or
 * its documentation tab from anywhere.
 */
export function SearchModal() {
  const open = useWorkspace((state) => state.searchModalOpen);
  const setOpen = useWorkspace((state) => state.setSearchModalOpen);
  // 只订阅搜索涉及的两个域；useMemo 依赖也收窄到域数组。
  const collections = useWorkspace((state) => state.snapshot.collections);
  const cases = useWorkspace((state) => state.snapshot.cases);
  const openTab = useWorkspace((state) => state.openTab);
  const setDetailTab = useWorkspace((state) => state.setDetailTab);

  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();
  // hits 的 useMemo 内含译文，语言切换时需重算。
  const lang = useLang();

  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const hits = useMemo<Hit[]>(() => {
    const needle = query.trim().toLowerCase();
    const result: Hit[] = [];
    for (const collection of collections) {
      for (const request of collection.items) {
        const haystack = `${request.name} ${request.url} ${request.folder ?? ""} ${request.doc?.summary ?? ""}`.toLowerCase();
        if (needle && !haystack.includes(needle)) continue;
        const method = request.protocol === "ws" ? "WS" : request.method;
        result.push({
          kind: "request",
          id: request.id,
          collectionId: collection.id,
          method,
          title: request.name,
          sub: request.url || t("shell.noUrl"),
        });
        if (request.doc && (request.doc.summary || request.doc.description)) {
          result.push({
            kind: "doc",
            id: request.id,
            collectionId: collection.id,
            method,
            title: t("shell.docHit", { name: request.name }),
            sub: request.doc.summary || request.description || request.url,
          });
        }
      }
    }
    for (const caseItem of cases) {
      const haystack = `${caseItem.name} ${caseItem.group} ${caseItem.request.name}`.toLowerCase();
      if (needle && !haystack.includes(needle)) continue;
      result.push({
        kind: "case",
        id: caseItem.id,
        method: caseItem.request.method,
        title: caseItem.name,
        sub: t("shell.caseHit", {
          name: caseItem.request.name,
          group: caseItem.group,
        }),
      });
    }
    return result.slice(0, 40);
  }, [collections, cases, query, lang]);

  if (!open) return null;

  const jump = (hit: Hit) => {
    if (hit.kind === "case") {
      openTab({ kind: "case", id: hit.id });
    } else {
      openTab({ kind: "request", id: hit.id });
      if (hit.kind === "doc") setDetailTab("docs");
    }
    setOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-slate-900/35 p-6 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("shell.globalSearch")}
        className="flex max-h-[62vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-surface-border bg-surface shadow-panel"
      >
        <div className="flex items-center gap-2 border-b border-surface-border px-4 py-3">
          <Search className="h-4 w-4 text-ink-faint" />
          <input
            ref={inputRef}
            className="w-full border-0 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
            placeholder={t("shell.searchPlaceholder")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setHighlight((current) => Math.min(current + 1, hits.length - 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setHighlight((current) => Math.max(current - 1, 0));
              }
              if (event.key === "Enter") {
                const hit = hits[highlight];
                if (hit) jump(hit);
              }
            }}
          />
          <kbd className="wb-kbd">Esc</kbd>
        </div>
        <div className="scrollbar-thin flex-1 overflow-y-auto p-1.5">
          {hits.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-ink-faint">
              {query ? t("shell.noResults") : t("shell.searchHint")}
            </p>
          ) : (
            hits.map((hit, index) => {
              const Icon = hit.kind === "case" ? FlaskConical : hit.kind === "doc" ? FileText : Send;
              return (
                <button
                  key={`${hit.kind}-${hit.id}-${index}`}
                  type="button"
                  className={`wb-search-row ${index === highlight ? "active" : ""}`}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => jump(hit)}
                >
                  <span className={`wb-method !w-auto !text-[9px] ${METHOD_CLASS[hit.method] ?? ""}`}>
                    {hit.method}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-xs text-ink">{hit.title}</span>
                    <span className="ml-2 text-2xs text-ink-faint">{hit.sub}</span>
                  </span>
                  <Icon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                  {index === highlight && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-ink-faint" />}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
