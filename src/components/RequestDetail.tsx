import { useEffect, useRef, useState } from "react";
import {
  Clock,
  FileText,
  FlaskConical,
  Gauge,
  Layers,
  PenLine,
  Play,
  RefreshCw,
  Save,
  Wand2,
} from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { useT } from "../i18n";
import { isCaseStale } from "../lib/cases.ts";
import { responseExampleHint } from "../lib/responseExamples.ts";
import type { DetailTab } from "../types";
import { ApiDocView } from "./ApiDocView";
import { BenchmarkPanel } from "./BenchmarkPanel";
import { CasePanel } from "./CasePanel";
import { HistoryRunList } from "./HistoryRunList";
import { MockPanel } from "./MockPanel";
import { RevisionList } from "./RevisionList";
import { ScenarioPanel } from "./ScenarioPanel";
import { SuitePanel } from "./SuitePanel";
import { RequestEditor } from "./RequestEditor";
import { ResponseViewer } from "./ResponseViewer";
import { WsPanel } from "./WsPanel";
import { TcpPanel } from "./TcpPanel";
import { MqttPanel } from "./MqttPanel";
import { SoapPanel } from "./SoapPanel";
import { Button, InlineRenameInput } from "./ui";

type Layout = "split" | "stacked";

const LAYOUT_KEY = "reqora.layout";

const DETAIL_TABS: { id: DetailTab; labelKey: string; icon: typeof Play }[] = [
  { id: "docs", labelKey: "request.detail.tab.docs", icon: FileText },
  { id: "edit", labelKey: "request.detail.tab.edit", icon: PenLine },
  { id: "debug", labelKey: "request.detail.tab.debug", icon: Play },
  { id: "history", labelKey: "request.detail.tab.history", icon: Clock },
  { id: "revisions", labelKey: "request.detail.tab.revisions", icon: Layers },
  { id: "benchmark", labelKey: "request.detail.tab.benchmark", icon: Gauge },
  { id: "cases", labelKey: "request.detail.tab.cases", icon: FlaskConical },
  { id: "mock", labelKey: "request.detail.tab.mock", icon: Wand2 },
];

/** A frozen snapshot may only be inspected, sent and load-tested. */
const READONLY_TABS: DetailTab[] = ["debug", "history", "revisions", "benchmark"];

/** Shared editor/response split with a draggable divider. */
function DebugSplit({ layout }: { layout: Layout }) {
  const [ratio, setRatio] = useState(0.52);
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const next =
        layout === "split"
          ? (event.clientX - rect.left) / rect.width
          : (event.clientY - rect.top) / rect.height;
      if (rect.width === 0 || rect.height === 0) return;
      setRatio(Math.min(0.75, Math.max(0.25, next)));
    };
    const onUp = () => {
      draggingRef.current = false;
      setDragging(false);
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [layout]);

  const paneStyle =
    layout === "split"
      ? { width: `calc(${ratio * 100}% - 3px)`, flex: "0 0 auto" }
      : { height: `calc(${ratio * 100}% - 3px)`, flex: "0 0 auto" };
  const otherStyle = { flex: "1 1 0%", minWidth: 0, minHeight: 0 };

  return (
    <div ref={containerRef} className={`wb-split ${layout === "stacked" ? "stacked" : ""}`}>
      <div style={paneStyle} className="wb-pane">
        <RequestEditor />
      </div>
      <div
        role="separator"
        aria-orientation={layout === "split" ? "vertical" : "horizontal"}
        className={`wb-splitter ${dragging ? "dragging" : ""}`}
        onPointerDown={(event) => {
          event.preventDefault();
          draggingRef.current = true;
          setDragging(true);
          document.body.style.cursor = layout === "split" ? "col-resize" : "row-resize";
        }}
      />
      <div style={otherStyle} className="wb-pane">
        <ResponseViewer />
      </div>
    </div>
  );
}

/** Editor shown when a case tab is active: stale hint + save-case button. */
function CaseEditor({ caseId, layout }: { caseId: string; layout: Layout }) {
  const t = useT();
  const caseItem = useWorkspace((state) =>
    state.snapshot.cases.find((item) => item.id === caseId),
  );
  const draft = useWorkspace((state) => state.draft);
  const requests = useWorkspace((state) => state.snapshot.collections);
  const response = useWorkspace((state) => state.response);
  const updateCase = useWorkspace((state) => state.updateCase);
  const syncCase = useWorkspace((state) => state.syncCase);
  const saveCaseResponseExample = useWorkspace((state) => state.saveCaseResponseExample);
  const [editingName, setEditingName] = useState(false);
  const [exampleHint, setExampleHint] = useState<string | null>(null);
  // Case tabs have their own host (no interface detail tab bar), so they keep
  // a compact copy of the same debug/history/revisions/load-test switcher.
  const [caseTab, setCaseTab] = useState<"debug" | "history" | "revisions" | "benchmark">(
    "debug",
  );

  if (!caseItem) return null;
  const baseRequest = requests
    .flatMap((collection) => collection.items)
    .find((item) => item.id === caseItem.requestId);
  const stale = isCaseStale(caseItem, baseRequest);

  const saveCase = () => {
    updateCase(caseId, { request: { ...draft, updatedAt: 0 } });
  };

  const saveExample = () => {
    const result = saveCaseResponseExample(caseId);
    setExampleHint(responseExampleHint(result, "case"));
    setTimeout(() => setExampleHint(null), 2500);
  };

  // syncCase also refreshes the draft when this case tab is active.
  return (
    <div className="wb-detail-case">
      <div className="wb-detail-case-bar">
        <span className="wb-mini-badge">{caseItem.group}</span>
        {editingName ? (
          <InlineRenameInput
            value={caseItem.name}
            onCommit={(next) => {
              updateCase(caseId, { name: next });
              setEditingName(false);
            }}
            onCancel={() => setEditingName(false)}
            className="min-w-0 max-w-[280px] flex-1"
            ariaLabel={t("request.detail.case.rename.aria")}
          />
        ) : (
          <span
            className="min-w-0 flex-1 cursor-text truncate text-[12px] font-medium text-ink"
            title={t("request.detail.case.rename.title")}
            onDoubleClick={() => setEditingName(true)}
          >
            {caseItem.name}
          </span>
        )}
        {stale && (
          <button
            type="button"
            className="wb-chip !h-7 !px-2.5 !text-amber-600"
            title={t("request.detail.case.stale.title")}
            onClick={() => syncCase(caseId)}
          >
            <RefreshCw className="h-3 w-3" />
            {t("request.detail.case.stale")}
          </button>
        )}
        {caseItem.expectedStatus !== undefined && (
          <span className="text-2xs text-ink-faint">
            {t("request.detail.case.expectedStatus", { status: caseItem.expectedStatus })}
          </span>
        )}
        <Button
          size="sm"
          disabled={!response}
          title={response
            ? t("request.detail.case.saveExample.title")
            : t("request.detail.case.saveExample.title.disabled")}
          onClick={saveExample}
        >
          <Save className="h-3.5 w-3.5" />
          {t("request.detail.case.saveExample")}
        </Button>
        <Button size="sm" onClick={saveCase} title={t("request.detail.case.saveCase.title")}>
          <Save className="h-3.5 w-3.5" />
          {t("request.detail.case.saveCase")}
        </Button>
      </div>
      {exampleHint && <p className="wb-detail-case-desc">{exampleHint}</p>}
      {caseItem.description && (
        <p className="wb-detail-case-desc">{caseItem.description}</p>
      )}
      <div className="wb-detail-tabs" role="tablist" aria-label={t("request.detail.tabs.aria")}>
        {([
          { id: "debug", labelKey: "request.detail.tab.debug", icon: Play },
          { id: "history", labelKey: "request.detail.tab.history", icon: Clock },
          { id: "revisions", labelKey: "request.detail.tab.revisions", icon: Layers },
          { id: "benchmark", labelKey: "request.detail.tab.benchmark", icon: Gauge },
        ] as const).map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={caseTab === item.id}
              className={`wb-detail-tab ${caseTab === item.id ? "active" : ""}`}
              onClick={() => setCaseTab(item.id)}
            >
              <Icon className="h-3.5 w-3.5" />
              {t(item.labelKey)}
            </button>
          );
        })}
      </div>
      {caseTab === "debug" && <DebugSplit layout={layout} />}
      {caseTab === "history" && <HistoryRunList subjectId={caseId} />}
      {caseTab === "revisions" && <RevisionList subjectId={caseItem.requestId} />}
      {caseTab === "benchmark" && (
        <div className="wb-detail-pane scrollbar-thin">
          <BenchmarkPanel />
        </div>
      )}
    </div>
  );
}

/**
 * Apifox-style interface detail host: docs / edit / debug / run history /
 * revisions / load test / cases / Mock, plus the case editor when a case tab
 * occupies the centre. Frozen tabs only expose the read-only subset.
 */
export function RequestDetail() {
  const t = useT();
  const activeTab = useWorkspace((state) => state.activeTab);
  const detailTab = useWorkspace((state) => state.detailTab);
  const setDetailTab = useWorkspace((state) => state.setDetailTab);
  const draftProtocol = useWorkspace((state) => state.draft.protocol);
  const draftId = useWorkspace((state) => state.draft.id);
  const historyTabRecords = useWorkspace((state) => state.historyTabRecords);
  const revisionTabRecords = useWorkspace((state) => state.revisionTabRecords);
  const caseCount = useWorkspace(
    (state) => state.snapshot.cases.filter((item) => item.requestId === state.draft.id).length,
  );
  const isReadOnly =
    activeTab?.kind === "history" || activeTab?.kind === "revision";
  // A frozen tab never inherits a leftover edit/docs/cases sub-tab from the
  // previously active request; it always lands on the debug split.
  const effectiveTab: DetailTab =
    isReadOnly && !READONLY_TABS.includes(detailTab) ? "debug" : detailTab;
  const visibleTabs = isReadOnly
    ? DETAIL_TABS.filter((item) => READONLY_TABS.includes(item.id))
    : DETAIL_TABS;
  // Both frozen tab kinds keep the id of the request they came from, so the
  // run list and the revision list still show the right interface.
  const subjectId =
    activeTab?.kind === "history"
      ? historyTabRecords[activeTab.id]?.subjectId ?? null
      : activeTab?.kind === "revision"
        ? revisionTabRecords[activeTab.id]?.requestId ?? null
        : activeTab?.kind === "request"
          ? activeTab.id
          : draftId;
  const [layout, setLayout] = useState<Layout>(() =>
    localStorage.getItem(LAYOUT_KEY) === "stacked" ? "stacked" : "split",
  );

  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, layout);
  }, [layout]);

  if (activeTab?.kind === "case") {
    return <CaseEditor caseId={activeTab.id} layout={layout} />;
  }

  if (activeTab?.kind === "scenario") {
    return <ScenarioPanel scenarioId={activeTab.id} />;
  }

  if (activeTab?.kind === "suite") {
    return <SuitePanel suiteId={activeTab.id} />;
  }

  return (
    <div className="wb-detail">
      <div className="wb-detail-tabs" role="tablist" aria-label={t("request.detail.tabs.aria")}>
        {visibleTabs.map((tab) => {
          const Icon = tab.icon;
          const active = effectiveTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`wb-detail-tab ${active ? "active" : ""}`}
              onClick={() => setDetailTab(tab.id)}
            >
              <Icon className="h-3.5 w-3.5" />
              {t(tab.labelKey)}
              {tab.id === "cases" && caseCount > 0 && (
                <span className="wb-mini-badge">{caseCount}</span>
              )}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-1 pr-2">
          <button
            type="button"
            className={`wb-icon-btn !h-7 !w-7 ${layout === "split" ? "active" : ""}`}
            title={t("request.detail.layout.split")}
            aria-label={t("request.detail.layout.split")}
            onClick={() => setLayout("split")}
          >
            <span className="text-[10px]">◫</span>
          </button>
          <button
            type="button"
            className={`wb-icon-btn !h-7 !w-7 ${layout === "stacked" ? "active" : ""}`}
            title={t("request.detail.layout.stacked")}
            aria-label={t("request.detail.layout.stacked")}
            onClick={() => setLayout("stacked")}
          >
            <span className="text-[10px]">⊟</span>
          </button>
        </div>
      </div>
      {effectiveTab === "docs" && <ApiDocView />}
      {effectiveTab === "edit" && (
        <div className="wb-detail-pane scrollbar-thin">
          <RequestEditor />
        </div>
      )}
      {effectiveTab === "debug" &&
        (isReadOnly ? (
          // Protocol panels own live sessions and editable controls; the
          // frozen snapshot always uses the plain editor/response split.
          <DebugSplit layout={layout} />
        ) : draftProtocol === "mqtt" ? (
          <MqttPanel />
        ) : draftProtocol === "soap" ? (
          <SoapPanel />
        ) : draftProtocol === "ws" ? (
          <WsPanel />
        ) : draftProtocol === "tcp" ? (
          <TcpPanel />
        ) : (
          <DebugSplit layout={layout} />
        ))}
      {effectiveTab === "cases" && <CasePanel />}
      {effectiveTab === "mock" && <MockPanel />}
      {effectiveTab === "history" && <HistoryRunList subjectId={subjectId} />}
      {effectiveTab === "revisions" && (
        <RevisionList subjectId={subjectId} readOnly={isReadOnly} />
      )}
      {effectiveTab === "benchmark" && (
        <div className="wb-detail-pane scrollbar-thin">
          <BenchmarkPanel />
        </div>
      )}
    </div>
  );
}
