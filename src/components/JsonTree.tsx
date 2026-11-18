import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { childPath } from "../lib/jsonpath.ts";
import { useT } from "../i18n";

interface NodeProps {
  name?: string;
  value: unknown;
  depth: number;
  last: boolean;
  path: string;
  filtering: boolean;
  exactPaths?: Set<string>;
  ancestorPaths?: Set<string>;
  onlyMatches: boolean;
  expandAll: boolean;
  onCopyPath?: (path: string) => void;
}

function Primitive({ value }: { value: unknown }) {
  if (value === null) return <span className="wb-json-null">null</span>;
  if (value === undefined) return <span className="wb-json-null">undefined</span>;
  switch (typeof value) {
    case "string":
      return <span className="wb-json-string">"{value}"</span>;
    case "number":
      return <span className="wb-json-number">{String(value)}</span>;
    case "boolean":
      return <span className="wb-json-bool">{String(value)}</span>;
    default:
      return <span>{String(value)}</span>;
  }
}

function Node({
  name,
  value,
  depth,
  last,
  path,
  filtering,
  exactPaths,
  ancestorPaths,
  onlyMatches,
  expandAll,
  onCopyPath,
}: NodeProps) {
  const t = useT();
  const isObject = typeof value === "object" && value !== null;
  const isArray = Array.isArray(value);
  const entries = isObject
    ? isArray
      ? (value as unknown[]).map((item, index) => [String(index), item] as const)
      : Object.entries(value as Record<string, unknown>)
    : [];
  const isExact = exactPaths?.has(path) ?? false;
  const isAncestor = ancestorPaths?.has(path) ?? false;
  const visible = !filtering || !onlyMatches || isExact || isAncestor;
  const [open, setOpen] = useState(expandAll || depth < 2 || (filtering && isAncestor));

  // Keep ancestors of JSONPath matches open whenever the filter changes.
  useEffect(() => {
    if (expandAll || (filtering && isAncestor)) setOpen(true);
  }, [expandAll, filtering, isAncestor]);

  if (!visible) return null;

  const label = name === undefined ? null : (
    <>
      <span className="wb-json-key">{isArray ? name : `"${name}"`}</span>
      <span className="wb-json-meta">: </span>
    </>
  );
  const copyButton = onCopyPath ? (
    <button
      type="button"
      className="wb-json-copy"
      title={t("response.tree.copyPath", { path })}
      aria-label={t("response.tree.copyPath", { path })}
      onClick={() => onCopyPath(path)}
    >
      <Copy className="h-3 w-3" />
    </button>
  ) : null;
  const rowClass = `wb-json-row ${isExact ? "wb-json-row-hit" : ""}`;

  if (!isObject) {
    return (
      <div className={rowClass} style={{ paddingLeft: depth * 16 }}>
        {label}
        <Primitive value={value} />
        {!last && <span className="wb-json-meta">,</span>}
        {copyButton}
      </div>
    );
  }

  const openBracket = isArray ? "[" : "{";
  const closeBracket = isArray ? "]" : "}";

  return (
    <>
      <div className={rowClass} style={{ paddingLeft: depth * 16 }}>
        <span
          className="wb-json-toggle"
          role="button"
          tabIndex={0}
          aria-label={open ? t("response.tree.collapse") : t("response.tree.expand")}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") setOpen((current) => !current);
          }}
        >
          {open ? "▾" : "▸"}
        </span>
        <span>
          {label}
          <span className="wb-json-meta">{openBracket}</span>
          {!open && (
            <>
              <span className="wb-json-meta"> … {t("response.tree.items", { count: entries.length })} … {closeBracket}</span>
              {!last && <span className="wb-json-meta">,</span>}
            </>
          )}
        </span>
        {copyButton}
      </div>

      {open && (
        <>
          {entries.map(([key, childValue], index) => (
            <Node
              key={key}
              name={isArray ? undefined : key}
              value={childValue}
              depth={depth + 1}
              last={index === entries.length - 1}
              path={childPath(path, key)}
              filtering={filtering}
              exactPaths={exactPaths}
              ancestorPaths={ancestorPaths}
              onlyMatches={onlyMatches}
              expandAll={expandAll}
              onCopyPath={onCopyPath}
            />
          ))}
          <div className="wb-json-row" style={{ paddingLeft: depth * 16 + 14 }}>
            <span className="wb-json-meta">
              {closeBracket}
              {!last && ","}
            </span>
          </div>
        </>
      )}
    </>
  );
}

export interface JsonTreeProps {
  data: unknown;
  /** True while a JSONPath filter is applied (even if it produced 0 matches). */
  filtering?: boolean;
  exactPaths?: Set<string>;
  ancestorPaths?: Set<string>;
  /** Hide branches that contain no match. */
  onlyMatches?: boolean;
  expandAll?: boolean;
  onCopyPath?: (path: string) => void;
}

/** Read-only, collapsible JSON viewer. React escapes all text — no innerHTML. */
export function JsonTree({
  data,
  filtering = false,
  exactPaths,
  ancestorPaths,
  onlyMatches = false,
  expandAll = false,
  onCopyPath,
}: JsonTreeProps) {
  return (
    <div className="wb-json-tree">
      <Node
        value={data}
        depth={0}
        last
        path="$"
        filtering={filtering}
        exactPaths={exactPaths}
        ancestorPaths={ancestorPaths}
        onlyMatches={onlyMatches}
        expandAll={expandAll}
        onCopyPath={onCopyPath}
      />
    </div>
  );
}
