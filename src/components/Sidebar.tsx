import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  BookOpen,
  ChevronRight,
  Clock,
  Copy,
  Database,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Layers,
  ListChecks,
  Lock,
  Pencil,
  Play,
  Plus,
  Search,
  Settings2,
  Trash2,
  X,
  RefreshCw,
} from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { useT } from "../i18n";
import { isCaseStale, sortCases } from "../lib/cases.ts";
import { docPageGroupLabel } from "../lib/docPages.ts";
import {
  folderGroups,
  folderHiddenByAncestor,
  folderOutline,
} from "../lib/docSitePayload.ts";
import { listFolderPaths, normalizeFolderPath } from "../lib/importTarget.ts";
import { runtimeLabel } from "../lib/runtimeLabel.ts";
import type { ApiCase, HistoryRunKind, HttpMethod, RequestDraft } from "../types";
import type { SideView } from "./ActivityRail";
import { CollectionAuthModal } from "./CollectionAuthModal";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button, EmptyState, IconButton, InlineRenameInput, Select } from "./ui";

const methodClass = (method: HttpMethod) => `wb-method-${method.toLowerCase()}`;

const historyKindLabel = (kind: HistoryRunKind, t: (key: string) => string) =>
  kind === "api"
    ? t("shell.history.kindApi")
    : kind === "case"
      ? t("shell.history.kindCase")
      : kind === "benchmark"
        ? t("shell.history.kindBenchmark")
        : t("shell.history.kindScenario");

interface FolderNode {
  name: string;
  path: string;
  folders: FolderNode[];
  requests: RequestDraft[];
}

interface GroupedCollection {
  id: string;
  name: string;
  loose: RequestDraft[];
  folders: FolderNode[];
}

type DragItem =
  | { kind: "request"; collectionId: string; requestId: string }
  | { kind: "folder"; collectionId: string; path: string };

interface InsertHint {
  requestId: string;
  position: "before" | "after";
}

/**
 * Right-click menu for folder moves. Dragging is the primary gesture, but a
 * menu keeps moving possible when drag is unavailable (e.g. touch input) and
 * makes the destination folders discoverable.
 */
type TreeMenuTarget =
  | {
      kind: "request";
      collectionId: string;
      requestId: string;
      folder: string;
    }
  | {
      kind: "folder";
      collectionId: string;
      path: string;
    };

type TreeMenu = TreeMenuTarget & { x: number; y: number };

/** Unique drop-zone key so folders with the same path in two collections don't clash. */
const dropKey = (collectionId: string, folder: string) => `${collectionId}::${folder}`;

/** Builds a nested folder tree from "a/b/c" folder paths on requests. */
function buildFolderTree(paths: Map<string, RequestDraft[]>): FolderNode[] {
  const root: FolderNode[] = [];
  const nodeByPath = new Map<string, FolderNode>();
  for (const [path, items] of [...paths.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const segments = path.split("/").map((segment) => segment.trim()).filter(Boolean);
    if (segments.length === 0) continue;
    let prefix = "";
    let list = root;
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let node = nodeByPath.get(prefix);
      if (!node) {
        node = { name: segment, path: prefix, folders: [], requests: [] };
        nodeByPath.set(prefix, node);
        list.push(node);
      }
      list = node.folders;
    }
    // The deepest node for this exact path receives the requests.
    const target = nodeByPath.get(path);
    if (target) target.requests.push(...items);
  }
  return root;
}

function countFolder(node: FolderNode): number {
  return (
    node.requests.length +
    node.folders.reduce((sum, child) => sum + countFolder(child), 0)
  );
}

const caseResultClass = (ok: boolean | undefined, failed: boolean) =>
  failed ? "wb-case-fail" : ok ? "wb-case-pass" : "wb-case-idle";

export function Sidebar({ view }: { view: SideView }) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Keys: "<collection id>" | "req:<request id>" | "folder:<collection id>|<path>".
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [authCollectionId, setAuthCollectionId] = useState<string | null>(null);
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);

  // 只订阅侧栏渲染所需的域；settings / theme / history 等变化不再触发整棵
  // 侧栏重渲染（行级更新后未变域的数组引用保持稳定）。
  const cases = useWorkspace((state) => state.snapshot.cases);
  const collections = useWorkspace((state) => state.snapshot.collections);
  const scenarios = useWorkspace((state) => state.snapshot.scenarios);
  const suites = useWorkspace((state) => state.snapshot.suites);
  const docPages = useWorkspace((state) => state.snapshot.docPages);
  const dataModels = useWorkspace((state) => state.snapshot.dataModels);
  const activeTab = useWorkspace((state) => state.activeTab);
  const runtime = useWorkspace((state) => state.runtime);
  const addCollection = useWorkspace((state) => state.addCollection);
  const addScenario = useWorkspace((state) => state.addScenario);
  const deleteScenario = useWorkspace((state) => state.deleteScenario);
  const runScenario = useWorkspace((state) => state.runScenario);
  const runningScenarioId = useWorkspace((state) => state.runningScenarioId);
  const addSuite = useWorkspace((state) => state.addSuite);
  const deleteSuite = useWorkspace((state) => state.deleteSuite);
  const runSuite = useWorkspace((state) => state.runSuite);
  const runningSuiteId = useWorkspace((state) => state.runningSuiteId);
  const activeScenarioId =
    activeTab?.kind === "scenario" ? activeTab.id : null;
  const renameCollection = useWorkspace((state) => state.renameCollection);
  const deleteCollection = useWorkspace((state) => state.deleteCollection);
  const createFolder = useWorkspace((state) => state.createFolder);
  const deleteFolder = useWorkspace((state) => state.deleteFolder);
  const newRequest = useWorkspace((state) => state.newRequest);
  const selectRequest = useWorkspace((state) => state.selectRequest);
  const deleteRequest = useWorkspace((state) => state.deleteRequest);
  // 统一执行历史：接口 / 用例 / 场景，数据来自 Rust 侧独立的加密 SQLite。
  const historyRuns = useWorkspace((state) => state.historyRuns);
  const historySelectedId = useWorkspace((state) => state.historySelectedId);
  const historyKind = useWorkspace((state) => state.historyKind);
  const historyHasMore = useWorkspace((state) => state.historyHasMore);
  const historyLoadingMore = useWorkspace((state) => state.historyLoadingMore);
  const historyCursor = useWorkspace((state) => state.historyCursor);
  const historyError = useWorkspace((state) => state.historyError);
  const historyLoading = useWorkspace((state) => state.historyLoading);
  const selectHistoryRun = useWorkspace((state) => state.selectHistoryRun);
  const setHistoryKind = useWorkspace((state) => state.setHistoryKind);
  const setHistorySearch = useWorkspace((state) => state.setHistorySearch);
  const loadMoreHistory = useWorkspace((state) => state.loadMoreHistory);
  const loadHistory = useWorkspace((state) => state.loadHistory);
  const clearHistoryRuns = useWorkspace((state) => state.clearHistoryRuns);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const openTab = useWorkspace((state) => state.openTab);
  const setDetailTab = useWorkspace((state) => state.setDetailTab);
  const deleteCase = useWorkspace((state) => state.deleteCase);
  const syncCase = useWorkspace((state) => state.syncCase);
  const runCase = useWorkspace((state) => state.runCase);
  const runningCaseIds = useWorkspace((state) => state.runningCaseIds);
  const moveRequestTo = useWorkspace((state) => state.moveRequestTo);
  const moveFolderTo = useWorkspace((state) => state.moveFolderTo);
  const renameRequest = useWorkspace((state) => state.renameRequest);
  const renameFolder = useWorkspace((state) => state.renameFolder);
  const duplicateRequest = useWorkspace((state) => state.duplicateRequest);
  const openDocPages = useWorkspace((state) => state.openDocPages);
  const addDocPage = useWorkspace((state) => state.addDocPage);

  const [dragging, setDragging] = useState<DragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [insertHint, setInsertHint] = useState<InsertHint | null>(null);
  const [treeMenu, setTreeMenu] = useState<TreeMenu | null>(null);
  /** 正在新建文件夹：{ collectionId, parent }（parent 为 "" 表示集合根目录）。 */
  const [creatingFolder, setCreatingFolder] = useState<{ collectionId: string; parent: string } | null>(null);
  const [pendingFolderDelete, setPendingFolderDelete] = useState<{ collectionId: string; path: string } | null>(null);
  const t = useT();

  // Esc closes the right-click menu; the overlay below handles click-away.
  useEffect(() => {
    if (!treeMenu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTreeMenu(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [treeMenu]);

  const activeRequestId = activeTab?.kind === "request" ? activeTab.id : null;
  const activeCaseId = activeTab?.kind === "case" ? activeTab.id : null;
  const needle = query.trim().toLowerCase();

  const caseCountByRequest = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of cases) {
      counts.set(item.requestId, (counts.get(item.requestId) ?? 0) + 1);
    }
    return counts;
  }, [cases]);

  const caseById = useMemo(
    () => new Map(cases.map((item) => [item.id, item])),
    [cases],
  );

  const requestById = useMemo(() => {
    const map = new Map<string, { request: RequestDraft; collectionId: string }>();
    for (const collection of collections) {
      for (const item of collection.items) map.set(item.id, { request: item, collectionId: collection.id });
    }
    return map;
  }, [collections]);

  const groups = useMemo<GroupedCollection[]>(
    () =>
      collections.map((collection) => {
        const loose: RequestDraft[] = [];
        const folderMap = new Map<string, RequestDraft[]>();
        for (const item of collection.items) {
          if (needle && !`${item.name} ${item.url} ${item.folder ?? ""}`.toLowerCase().includes(needle)) {
            continue;
          }
          const folder = item.folder?.trim() ?? "";
          if (!folder) {
            loose.push(item);
          } else {
            const list = folderMap.get(folder) ?? [];
            list.push(item);
            folderMap.set(folder, list);
          }
        }
        // 显式登记的空文件夹（Collection.folders）也进入目录树；搜索时只看
        // 命中的接口，空文件夹不参与过滤。
        if (!needle) {
          for (const path of collection.folders ?? []) {
            const normalized = normalizeFolderPath(path);
            if (normalized && !folderMap.has(normalized)) folderMap.set(normalized, []);
          }
        }
        return {
          id: collection.id,
          name: collection.name,
          loose,
          folders: buildFolderTree(folderMap),
        };
      }),
    [collections, needle],
  );

  const groupedCases = useMemo(() => {
    const list = sortCases(
      needle
        ? cases.filter((item) =>
            `${item.name} ${item.group} ${item.request.name}`.toLowerCase().includes(needle),
          )
        : cases,
    );
    const byRequest = new Map<string, ApiCase[]>();
    for (const item of list) {
      const bucket = byRequest.get(item.requestId) ?? [];
      bucket.push(item);
      byRequest.set(item.requestId, bucket);
    }
    return [...byRequest.entries()];
  }, [cases, needle]);

  // 文档视图：按「集合 → 文件夹」分组，顺序与接口视图的侧边栏一致
  // （集合按原顺序，根级接口在前，文件夹按路径 localeCompare 排序）。
  const docGroups = useMemo(() => {
    return collections.map((collection) => {
      const matched = collection.items.filter((item) =>
        needle
          ? `${item.name} ${item.url} ${item.doc?.summary ?? ""}`.toLowerCase().includes(needle)
          : true,
      );
      return { collectionId: collection.id, name: collection.name, groups: folderGroups(matched) };
    });
  }, [collections, needle]);
  const docRequestsTotal = docGroups.reduce(
    (sum, entry) => sum + entry.groups.reduce((count, group) => count + group.requests.length, 0),
    0,
  );
  // 文档视图的集合折叠状态（按集合 id，默认全部展开）。文档目录按
  // 「集合 → 文件夹(可嵌套) → 接口」呈现，集合与文件夹各自可独立折叠。
  const [collapsedDocCollections, setCollapsedDocCollections] = useState<Set<string>>(new Set());
  const toggleDocCollectionCollapse = (collectionId: string) => {
    setCollapsedDocCollections((prev) => {
      const next = new Set(prev);
      if (next.has(collectionId)) next.delete(collectionId);
      else next.add(collectionId);
      return next;
    });
  };
  // 文档视图的文件夹折叠状态（按完整路径，默认全部展开）。
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const toggleFolderCollapse = (path: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // 公共章节与接口文档共用侧栏搜索框。
  const visibleDocPages = useMemo(() => {
    const all = docPages ?? [];
    return needle
      ? all.filter((page) =>
          `${page.title} ${page.slug} ${page.body}`.toLowerCase().includes(needle),
        )
      : all;
  }, [docPages, needle]);

  const createAndOpenDocPage = () => {
    addDocPage();
    const pages = useWorkspace.getState().snapshot.docPages ?? [];
    openDocPages(pages[pages.length - 1]?.id ?? null);
  };

  // Rust already applies the search term to every page, including rows that
  // have not been fetched yet. Filtering again here would hide older matches.
  const history = historyRuns;

  // Debounce the sidebar search into a server-side (Rust) query.
  useEffect(() => {
    if (view !== "history") return;
    const timer = window.setTimeout(() => setHistorySearch(needle), 220);
    return () => window.clearTimeout(timer);
  }, [needle, view, setHistorySearch]);

  // Infinite scrolling. Re-arming the observer on every cursor advance also
  // covers sparse searches, where a page can contain zero visible rows.
  useEffect(() => {
    if (
      view !== "history" ||
      !historyHasMore ||
      historyLoadingMore ||
      historyLoading
    ) {
      return;
    }
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMoreHistory();
        }
      },
      { root, rootMargin: "200px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    view,
    historyHasMore,
    historyLoadingMore,
    historyLoading,
    historyCursor,
    loadMoreHistory,
  ]);

  const startEditing = (key: string, name: string) => {
    setEditingId(key);
    setEditName(name);
  };

  /**
   * Rows are `draggable`, and Chromium / WebKit skip the `dblclick` event once
   * the second press turns into a drag (a real mouse almost always moves a
   * pixel or two). `MouseEvent.detail >= 2` marks that second press, so start
   * renaming there and cancel the pending drag with preventDefault(); keeping
   * `onDoubleClick` as well covers environments that never set `detail`.
   */
  const renameOnDoublePress = (event: React.MouseEvent, key: string, name: string) => {
    if (event.detail < 2) return;
    event.preventDefault();
    event.stopPropagation();
    startEditing(key, name);
  };

  /** Right-click menu → rename, for when the double-click gesture is missed. */
  const startEditingFromMenu = () => {
    const menu = treeMenu;
    if (!menu) return;
    setTreeMenu(null);
    if (menu.kind === "request") {
      const request = collections
        .find((collection) => collection.id === menu.collectionId)
        ?.items.find((item) => item.id === menu.requestId);
      if (request) startEditing(`req:${request.id}`, request.name);
    } else {
      const name = menu.path.split("/").filter(Boolean).pop() ?? menu.path;
      startEditing(`folder:${menu.collectionId}|${menu.path}`, name);
    }
  };

  const commitEditing = (name?: string) => {
    const key = editingId;
    const value = (name ?? editName).trim();
    setEditingId(null);
    setEditName("");
    if (!key || !value) return;
    if (key.startsWith("req:")) {
      renameRequest(key.slice(4), value);
    } else if (key.startsWith("newfolder:")) {
      // 新建文件夹：key 形如 "newfolder:<collection id>|<parent path>"。
      const rest = key.slice(10);
      const divider = rest.indexOf("|");
      if (divider < 0) return;
      const collectionId = rest.slice(0, divider);
      const parent = rest.slice(divider + 1);
      const segment = value.split("/").filter(Boolean).pop();
      if (!segment) return;
      createFolder(collectionId, parent ? `${parent}/${segment}` : segment);
      setCreatingFolder(null);
    } else if (key.startsWith("folder:")) {
      const rest = key.slice(7);
      const divider = rest.indexOf("|");
      if (divider < 0) return;
      const collectionId = rest.slice(0, divider);
      const path = rest.slice(divider + 1);
      // Only the last segment is renamed — the parent path stays intact and a
      // typed "/" can never create a nested path by accident.
      const segment = value.split("/").filter(Boolean).pop();
      if (!segment) return;
      const parent = path.split("/").slice(0, -1).join("/");
      renameFolder(collectionId, path, parent ? `${parent}/${segment}` : segment);
    } else {
      renameCollection(key, value);
    }
  };

  /** 开始在指定集合 / 父文件夹下新建文件夹（出现内联输入行）。 */
  const startCreatingFolder = (collectionId: string, parent: string) => {
    setTreeMenu(null);
    setCreatingFolder({ collectionId, parent });
    setEditingId(`newfolder:${collectionId}|${parent}`);
    setEditName("");
    // 展开目标父级，让输入行立即可见。
    setCollapsed((current) => ({
      ...current,
      [collectionId]: false,
      ...(parent ? { [parent]: false } : {}),
    }));
  };

  const cancelCreatingFolder = () => {
    setEditingId(null);
    setCreatingFolder(null);
  };

  /** 新建文件夹的内联输入行（复用重命名输入框）。 */
  const newFolderRow = (depth: number): ReactNode => (
    <div className="wb-tree-folder" style={{ paddingLeft: 8 + depth * 14 }}>
      <FolderOpen className="h-3 w-3" />
      <InlineRenameInput
        value={editName}
        onCommit={commitEditing}
        onCancel={cancelCreatingFolder}
        className="flex-1"
        ariaLabel={t("shell.newFolderName")}
      />
    </div>
  );

  const clearDrag = () => {
    setDragging(null);
    setDropTarget(null);
    setInsertHint(null);
  };

  /** A folder cannot be dropped onto itself or one of its own descendants. */
  const canDropIntoFolder = (path: string): boolean => {
    if (!dragging) return false;
    if (dragging.kind !== "folder") return true;
    return path !== dragging.path && !path.startsWith(`${dragging.path}/`);
  };

  const performDrop = (
    event: ReactDragEvent<HTMLElement>,
    collectionId: string,
    folder: string,
    anchor?: { beforeId?: string; afterId?: string },
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (dragging?.kind === "request") {
      moveRequestTo(
        { collectionId: dragging.collectionId, requestId: dragging.requestId },
        { collectionId, folder, ...anchor },
      );
    } else if (dragging?.kind === "folder") {
      moveFolderTo(
        { collectionId: dragging.collectionId, path: dragging.path },
        { collectionId, folder },
      );
    }
    // Always reveal where the item landed, even if the destination was folded.
    setCollapsed((current) => ({
      ...current,
      [collectionId]: false,
      ...(folder ? { [folder]: false } : {}),
    }));
    clearDrag();
  };

  const openRequest = (collectionId: string, request: RequestDraft) => {
    selectRequest(collectionId, request);
  };

  /** All folder paths (including ancestors) present in a collection, sorted. */
  const folderPathsIn = (collectionId: string): string[] =>
    listFolderPaths(collections, collectionId);

  const openTreeMenu = (event: React.MouseEvent, menu: TreeMenuTarget) => {
    event.preventDefault();
    event.stopPropagation();
    // Keep the fixed-position panel inside the viewport even near the edges.
    setTreeMenu({
      ...menu,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 230)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 320)),
    });
  };

  const moveRequestFromMenu = (target: string) => {
    if (!treeMenu || treeMenu.kind !== "request" || target === treeMenu.folder) {
      setTreeMenu(null);
      return;
    }
    moveRequestTo(
      { collectionId: treeMenu.collectionId, requestId: treeMenu.requestId },
      { collectionId: treeMenu.collectionId, folder: target },
    );
    // Reveal the destination if it was folded.
    setCollapsed((current) => ({
      ...current,
      [treeMenu.collectionId]: false,
      ...(target ? { [target]: false } : {}),
    }));
    setTreeMenu(null);
  };

  const moveFolderFromMenu = (target: string) => {
    if (!treeMenu || treeMenu.kind !== "folder") return;
    const currentParent = treeMenu.path.split("/").slice(0, -1).join("/");
    if (target === currentParent) {
      setTreeMenu(null);
      return;
    }
    moveFolderTo(
      { collectionId: treeMenu.collectionId, path: treeMenu.path },
      { collectionId: treeMenu.collectionId, folder: target },
    );
    setCollapsed((current) => ({
      ...current,
      [treeMenu.collectionId]: false,
      ...(target ? { [target]: false } : {}),
    }));
    setTreeMenu(null);
  };

  const requestRow = (collectionId: string, request: RequestDraft, indented: boolean) => {
    const count = caseCountByRequest.get(request.id) ?? 0;
    const folder = request.folder?.trim() ?? "";
    const isEditing = editingId === `req:${request.id}`;
    const hint =
      dragging?.kind === "request" && insertHint?.requestId === request.id
        ? insertHint.position
        : null;
    const isDragging = dragging?.kind === "request" && dragging.requestId === request.id;
    // A folder dropped on a row moves into that row's folder (no precise
    // insertion point), so highlight the whole row instead of showing a line.
    const rowDropKey = `row:${collectionId}:${request.id}`;
    const isFolderDrop = dropTarget === rowDropKey;
    return (
      <div
        key={request.id}
        className={`wb-tree-row group ${activeRequestId === request.id ? "active" : ""} ${
          isDragging ? "opacity-40" : ""
        } ${isFolderDrop ? "wb-drop-target" : ""} ${
          hint === "before" ? "wb-drop-before" : hint === "after" ? "wb-drop-after" : ""
        }`}
        style={{ paddingLeft: indented ? 34 : 22 }}
        title={t("shell.reqRowHint", { method: request.method, url: request.url })}
        draggable={!isEditing}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          // Some webviews cancel a drag that never writes data; the payload is
          // irrelevant because `dragging` state drives the drop logic.
          event.dataTransfer.setData("text/plain", request.id);
          setDragging({ kind: "request", collectionId, requestId: request.id });
        }}
        onDragEnd={clearDrag}
        onContextMenu={(event) =>
          openTreeMenu(event, {
            kind: "request",
            collectionId,
            requestId: request.id,
            folder,
          })
        }
        onDragOver={(event) => {
          if (!dragging) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
          if (dragging.kind === "folder") {
            setInsertHint(null);
            setDropTarget(canDropIntoFolder(folder) ? rowDropKey : null);
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          setInsertHint({
            requestId: request.id,
            position: event.clientY < rect.top + rect.height / 2 ? "before" : "after",
          });
          setDropTarget(null);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target && insertHint?.requestId === request.id) {
            setInsertHint(null);
          }
        }}
        onDrop={(event) => {
          // Recompute from the event so the exact drop point is used even if
          // the hint state has not been flushed yet.
          const rect = event.currentTarget.getBoundingClientRect();
          const position = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
          performDrop(
            event,
            collectionId,
            folder,
            position === "before" ? { beforeId: request.id } : { afterId: request.id },
          );
        }}
        onClick={() => openRequest(collectionId, request)}
      >
        <span className={`wb-method !w-[42px] ${methodClass(request.method)}`}>
          {request.method}
        </span>
        {isEditing ? (
          <InlineRenameInput
            value={editName}
            onCommit={commitEditing}
            onCancel={() => setEditingId(null)}
            className="flex-1"
            ariaLabel={t("shell.renameApi")}
          />
        ) : (
          <span
            className="min-w-0 flex-1 truncate"
            onMouseDown={(event) => renameOnDoublePress(event, `req:${request.id}`, request.name)}
            onDoubleClick={(event) => {
              event.stopPropagation();
              startEditing(`req:${request.id}`, request.name);
            }}
          >
            {request.name}
          </span>
        )}
        {count > 0 && (
          <span className="wb-mini-badge" title={t("shell.caseCount", { count })}>{count}</span>
        )}
        <button
          type="button"
          className="wb-icon-btn !h-5 !w-5 opacity-0 group-hover:opacity-100"
          title={t("shell.duplicateApi")}
          aria-label={t("shell.duplicateApi")}
          onClick={(event) => {
            event.stopPropagation();
            duplicateRequest(collectionId, request.id);
          }}
        >
          <Copy className="h-3 w-3" />
        </button>
        <button
          type="button"
          className="wb-icon-btn !h-5 !w-5 opacity-0 group-hover:opacity-100"
          title={t("shell.deleteRequest")}
          aria-label={t("shell.deleteRequest")}
          onClick={(event) => {
            event.stopPropagation();
            deleteRequest(collectionId, request.id);
          }}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    );
  };

  /** Recursive nested folder tree (Apifox 风格多级目录) with drop targets. */
  const folderNode = (collectionId: string, node: FolderNode, depth: number): ReactNode => {
    const collapsedFlag = collapsed[node.path] ?? false;
    const key = dropKey(collectionId, node.path);
    const isDropTarget = dropTarget === key && canDropIntoFolder(node.path);
    const total = countFolder(node);
    const isEditing = editingId === `folder:${collectionId}|${node.path}`;
    const isDragging =
      dragging?.kind === "folder" &&
      dragging.collectionId === collectionId &&
      dragging.path === node.path;
    return (
      <div key={node.path}>
        <div
          className={`wb-tree-folder group cursor-pointer ${isDropTarget ? "wb-drop-target" : ""} ${
            isDragging ? "opacity-40" : ""
          }`}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable={!isEditing}
          title={t("shell.folderRowHint")}
          onClick={() => {
            // Do not collapse while the name is being edited on this row.
            if (isEditing) return;
            setCollapsed((current) => ({ ...current, [node.path]: !current[node.path] }));
          }}
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", node.path);
            setDragging({ kind: "folder", collectionId, path: node.path });
          }}
          onDragEnd={clearDrag}
          onContextMenu={(event) =>
            openTreeMenu(event, { kind: "folder", collectionId, path: node.path })
          }
          onDragOver={(event) => {
            if (!dragging) return;
            // Always claim the event: dropping a folder on itself must not
            // bubble to the collection root and look like "promote to root".
            event.stopPropagation();
            if (!canDropIntoFolder(node.path)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropTarget(key);
            setInsertHint(null);
          }}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target && dropTarget === key) setDropTarget(null);
          }}
          onDrop={(event) => performDrop(event, collectionId, node.path)}
        >
          {collapsedFlag ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          <FolderOpen className="h-3 w-3" />
          {isEditing ? (
            <InlineRenameInput
              value={editName}
              onCommit={commitEditing}
              onCancel={() => setEditingId(null)}
              className="flex-1"
              ariaLabel={t("shell.renameFolder")}
            />
          ) : (
            <span
              className="flex-1 truncate"
              onMouseDown={(event) =>
                renameOnDoublePress(event, `folder:${collectionId}|${node.path}`, node.name)
              }
              onDoubleClick={(event) => {
                event.stopPropagation();
                startEditing(`folder:${collectionId}|${node.path}`, node.name);
              }}
            >
              {node.name}
            </span>
          )}
          <button
            type="button"
            className="wb-icon-btn !h-4 !w-4 opacity-0 group-hover:opacity-100"
            title={t("shell.newSubfolder")}
            aria-label={t("shell.newSubfolder")}
            onClick={(event) => {
              event.stopPropagation();
              startCreatingFolder(collectionId, node.path);
            }}
          >
            <FolderPlus className="h-3 w-3" />
          </button>
          <span className="wb-mini-badge">{total}</span>
        </div>
        {!collapsedFlag && (
          <>
            {creatingFolder?.collectionId === collectionId &&
              creatingFolder.parent === node.path &&
              newFolderRow(depth + 1)}
            {node.folders.map((child) => folderNode(collectionId, child, depth + 1))}
            {node.requests.map((request) => requestRow(collectionId, request, true))}
          </>
        )}
      </div>
    );
  };

  const caseRow = (caseItem: ApiCase) => {
    const stale = isCaseStale(caseItem, requestById.get(caseItem.requestId)?.request);
    const running = runningCaseIds.includes(caseItem.id);
    const run = caseItem.lastRun;
    return (
      <div
        key={caseItem.id}
        className={`wb-tree-row group ${activeCaseId === caseItem.id ? "active" : ""}`}
        style={{ paddingLeft: 34 }}
        title={caseItem.description || caseItem.name}
        onClick={() => openTab({ kind: "case", id: caseItem.id })}
      >
        <span className="wb-mini-badge !text-[9px]">{caseItem.group}</span>
        <span className="min-w-0 flex-1 truncate">{caseItem.name}</span>
        {stale && (
          <button
            type="button"
            className="wb-icon-btn !h-5 !w-5"
            title={t("shell.caseStaleHint")}
            aria-label={t("shell.syncFromApi")}
            onClick={(event) => {
              event.stopPropagation();
              syncCase(caseItem.id);
            }}
          >
            <RefreshCw className="h-3 w-3 text-amber-500" />
          </button>
        )}
        <button
          type="button"
          className={`wb-icon-btn !h-5 !w-5 opacity-0 group-hover:opacity-100 ${running ? "!opacity-100" : ""}`}
          title={t("shell.runCase")}
          aria-label={t("shell.runCase")}
          onClick={(event) => {
            event.stopPropagation();
            void runCase(caseItem.id);
          }}
        >
          <Play className={`h-3 w-3 ${running ? "animate-pulse text-brand-500" : ""}`} />
        </button>
        <button
          type="button"
          className="wb-icon-btn !h-5 !w-5 opacity-0 group-hover:opacity-100"
          title={t("shell.deleteCase")}
          aria-label={t("shell.deleteCase")}
          onClick={(event) => {
            event.stopPropagation();
            deleteCase(caseItem.id);
          }}
        >
          <Trash2 className="h-3 w-3" />
        </button>
        {run && (
          <span className={caseResultClass(run.ok, run.failed > 0)} title={t("shell.caseStatus", { status: run.status ?? "ERR", timeMs: run.timeMs })}>
            {run.ok ? t("shell.pass") : run.failed > 0 ? t("shell.failedCount", { count: run.failed }) : run.status ?? "ERR"}
          </span>
        )}
      </div>
    );
  };

  return (
    <aside className="wb-sidebar">
      <div className="wb-sidebar-search">
        <Search className="h-3.5 w-3.5 shrink-0" />
        <input
          value={query}
          placeholder={t("shell.searchPh")}
          aria-label={t("shell.search")}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <button type="button" aria-label={t("shell.clearSearch")} onClick={() => setQuery("")}>
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      <div className="wb-section-head">
        <span className="flex-1">
          {view === "apis" && t("shell.countApis", { count: collections.reduce((sum, c) => sum + c.items.length, 0) })}
          {view === "cases" && t("shell.countCases", { count: cases.length })}
          {view === "scenarios" && t("shell.countScenarios", { count: scenarios.length })}
          {view === "docs" && t("shell.countDocs", { count: docRequestsTotal + visibleDocPages.length })}
          {view === "models" && t("shell.countModels", { count: (dataModels ?? []).length })}
          {view === "history" && t("shell.countHistory", { count: historyRuns.length })}
        </span>
        {view === "apis" && (
          <>
            <IconButton label={t("shell.newCollection")} className="!h-6 !w-6" onClick={addCollection}>
              <FolderPlus className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton label={t("shell.newRequest")} className="!h-6 !w-6" onClick={() => newRequest()}>
              <Plus className="h-3.5 w-3.5" />
            </IconButton>
          </>
        )}
        {view === "scenarios" && (
          <>
            <IconButton
              label={t("shell.newScenario")}
              className="!h-6 !w-6"
              onClick={() => openTab({ kind: "scenario", id: addScenario() })}
            >
              <Plus className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton
              label={t("shell.newSuite")}
              className="!h-6 !w-6"
              onClick={() => openTab({ kind: "suite", id: addSuite() })}
            >
              <Layers className="h-3.5 w-3.5" />
            </IconButton>
          </>
        )}
        {view === "history" && historyRuns.length > 0 && (
          <button
            type="button"
            className="text-[10px] font-medium text-ink-faint hover:text-ink"
            onClick={() => setConfirmClearHistory(true)}
          >
            {t("shell.clear")}
          </button>
        )}
      </div>

      <div className="wb-tree scrollbar-thin" ref={scrollRef}>
        {view === "apis" && (
          <>
            {groups.length === 0 ? (
              <EmptyState
                icon={<FolderPlus className="h-7 w-7" />}
                title={t("shell.emptyCollections")}
                description={t("shell.emptyCollectionsDesc")}
                action={
                  <Button size="sm" onClick={addCollection}>
                    <Plus className="h-3.5 w-3.5" />
                    {t("shell.newCollection")}
                  </Button>
                }
              />
            ) : (
              groups.map((group) => (
                <div
                  key={group.id}
                  className={`mb-1 ${dropTarget === dropKey(group.id, "") ? "wb-drop-target" : ""}`}
                  onDragOver={(event) => {
                    // Rows and folders stop propagation, so reaching here means
                    // "collection root" (including dropping on the header).
                    if (!dragging) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setDropTarget(dropKey(group.id, ""));
                    setInsertHint(null);
                  }}
                  onDrop={(event) => performDrop(event, group.id, "")}
                >
                  <div className="group flex items-center gap-1">
                    <button
                      type="button"
                      className="wb-tree-group min-w-0 flex-1"
                      onClick={() =>
                        setCollapsed((current) => ({ ...current, [group.id]: !current[group.id] }))
                      }
                    >
                      {collapsed[group.id] ? (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <Folder className="h-3.5 w-3.5 shrink-0 text-brand-500" />
                      {editingId === group.id ? (
                        <InlineRenameInput
                          value={editName}
                          onCommit={commitEditing}
                          onCancel={() => setEditingId(null)}
                          className="flex-1"
                          ariaLabel={t("shell.renameCollection")}
                        />
                      ) : (
                        <>
                          <span
                            className="min-w-0 flex-1 truncate"
                            onDoubleClick={(event) => {
                              event.stopPropagation();
                              startEditing(group.id, group.name);
                            }}
                          >
                            {group.name}
                          </span>
                          <span className="wb-mini-badge">
                            {group.loose.length + group.folders.reduce((sum, folder) => sum + countFolder(folder), 0)}
                          </span>
                        </>
                      )}
                    </button>
                    <div className="hidden shrink-0 group-hover:flex">
                      <IconButton label={t("shell.newRequest")} className="!h-6 !w-6" onClick={() => newRequest(group.id)}>
                        <Plus className="h-3 w-3" />
                      </IconButton>
                      <IconButton
                        label={t("shell.newSubfolder")}
                        className="!h-6 !w-6"
                        onClick={() => startCreatingFolder(group.id, "")}
                      >
                        <FolderTree className="h-3 w-3" />
                      </IconButton>
                      <IconButton label={t("shell.collectionAuth")} className="!h-6 !w-6" onClick={() => setAuthCollectionId(group.id)}>
                        <Lock className="h-3 w-3" />
                      </IconButton>
                      <IconButton label={t("shell.deleteCollection")} className="!h-6 !w-6" onClick={() => setPendingDelete(group.id)}>
                        <Trash2 className="h-3 w-3" />
                      </IconButton>
                    </div>
                  </div>

                  {!collapsed[group.id] && (
                    <>
                      {creatingFolder?.collectionId === group.id &&
                        creatingFolder.parent === "" &&
                        newFolderRow(0)}
                      {group.loose.map((request) => requestRow(group.id, request, false))}
                      {group.folders.map((node) => folderNode(group.id, node, 0))}
                      {group.loose.length === 0 && group.folders.length === 0 && (
                        <p className="px-6 py-2 text-2xs text-ink-faint">
                          {needle ? t("shell.noMatchApi") : t("shell.emptyCollectionHint")}
                        </p>
                      )}
                    </>
                  )}
                </div>
              ))
            )}
          </>
        )}

        {view === "cases" && (
          <>
            {groupedCases.length === 0 ? (
              <EmptyState
                icon={<Play className="h-7 w-7" />}
                title={needle ? t("shell.noMatchCase") : t("shell.emptyCases")}
                description={t("shell.emptyCasesDesc")}
              />
            ) : (
              groupedCases.map(([requestId, items]) => {
                const base = requestById.get(requestId);
                return (
                  <div key={requestId} className="mb-1">
                    <div className="wb-tree-folder">
                      <span className={`wb-method !w-auto !text-[9px] ${methodClass(base?.request.method ?? "GET")}`}>
                        {base?.request.method ?? "GET"}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{base?.request.name ?? t("shell.deletedApi")}</span>
                      <span className="wb-mini-badge">{items.length}</span>
                    </div>
                    {items.map(caseRow)}
                  </div>
                );
              })
            )}
          </>
        )}

        {view === "scenarios" && (
          <>
            {scenarios.length === 0 ? (
              <EmptyState
                icon={<ListChecks className="h-7 w-7" />}
                title={needle ? t("shell.noMatchScenario") : t("shell.emptyScenarios")}
                description={t("shell.emptyScenariosDesc")}
                action={
                  <Button size="sm" onClick={() => openTab({ kind: "scenario", id: addScenario() })}>
                    <Plus className="h-3.5 w-3.5" />
                    {t("shell.newScenario")}
                  </Button>
                }
              />
            ) : (
              scenarios
                .filter((item) => !needle || `${item.name} ${item.description ?? ""}`.toLowerCase().includes(needle))
                .map((scenario) => {
                  const run = scenario.lastRun;
                  const running = runningScenarioId === scenario.id;
                  return (
                    <div
                      key={scenario.id}
                      className={`wb-tree-row group ${activeScenarioId === scenario.id ? "active" : ""}`}
                      style={{ paddingLeft: 22 }}
                      title={scenario.description || scenario.name}
                      onClick={() => openTab({ kind: "scenario", id: scenario.id })}
                    >
                      <ListChecks className="h-3.5 w-3.5 shrink-0 text-brand-500" />
                      <span className="min-w-0 flex-1 truncate">{scenario.name}</span>
                      {running && (
                        <span className="wb-mini-badge !text-brand-600" title={t("shell.running")}>{t("shell.running")}</span>
                      )}
                      {!running && run && (
                        <span className={run.failed > 0 ? "wb-case-fail" : "wb-case-pass"} title={t("shell.passRatio", { passed: run.passed, total: run.total })}>
                          {run.failed > 0 ? t("shell.failedCount", { count: run.failed }) : `${run.passed}/${run.total}`}
                        </span>
                      )}
                      <button
                        type="button"
                        className={`wb-icon-btn !h-5 !w-5 opacity-0 group-hover:opacity-100 ${running ? "!opacity-100" : ""}`}
                        title={t("shell.runScenario")}
                        aria-label={t("shell.runScenario")}
                        onClick={(event) => {
                          event.stopPropagation();
                          void runScenario(scenario.id);
                        }}
                      >
                        <Play className={`h-3 w-3 ${running ? "animate-pulse text-brand-500" : ""}`} />
                      </button>
                      <button
                        type="button"
                        className="wb-icon-btn !h-5 !w-5 opacity-0 group-hover:opacity-100"
                        title={t("shell.deleteScenario")}
                        aria-label={t("shell.deleteScenario")}
                        onClick={(event) => {
                          event.stopPropagation();
                          deleteScenario(scenario.id);
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                      <span className="wb-mini-badge">{t("shell.stepCount", { count: scenario.steps.length })}</span>
                    </div>
                  );
                })
            )}

            {(suites ?? []).length > 0 && (
              <div className="mt-2 px-5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                {t("shell.suites")}
              </div>
            )}
            {(suites ?? [])
              .filter((item) => !needle || `${item.name} ${item.description ?? ""}`.toLowerCase().includes(needle))
              .map((suite) => {
                const run = suite.lastRun;
                const running = runningSuiteId === suite.id;
                return (
                  <div
                    key={suite.id}
                    className={`wb-tree-row group ${activeTab?.kind === "suite" && activeTab.id === suite.id ? "active" : ""}`}
                    style={{ paddingLeft: 22 }}
                    title={suite.description || suite.name}
                    onClick={() => openTab({ kind: "suite", id: suite.id })}
                  >
                    <Layers className="h-3.5 w-3.5 shrink-0 text-brand-500" />
                    <span className="min-w-0 flex-1 truncate">{suite.name}</span>
                    {running && (
                      <span className="wb-mini-badge !text-brand-600" title={t("shell.running")}>{t("shell.running")}</span>
                    )}
                    {!running && run && (
                      <span
                        className={run.failed > 0 ? "wb-case-fail" : "wb-case-pass"}
                        title={t("shell.passRatio", { passed: run.passed, total: run.total })}
                      >
                        {run.failed > 0 ? t("shell.failedCount", { count: run.failed }) : `${run.passed}/${run.total}`}
                      </span>
                    )}
                    <button
                      type="button"
                      className={`wb-icon-btn !h-5 !w-5 opacity-0 group-hover:opacity-100 ${running ? "!opacity-100" : ""}`}
                      title={t("shell.runSuite")}
                      aria-label={t("shell.runSuite")}
                      onClick={(event) => {
                        event.stopPropagation();
                        void runSuite(suite.id);
                      }}
                    >
                      <Play className={`h-3 w-3 ${running ? "animate-pulse text-brand-500" : ""}`} />
                    </button>
                    <button
                      type="button"
                      className="wb-icon-btn !h-5 !w-5 opacity-0 group-hover:opacity-100"
                      title={t("shell.deleteSuite")}
                      aria-label={t("shell.deleteSuite")}
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteSuite(suite.id);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                    <span className="wb-mini-badge">{t("shell.itemCount", { count: suite.items.length })}</span>
                  </div>
                );
              })}
          </>
        )}

        {view === "docs" && (
          <>
            <div className="mt-2 flex items-center gap-1 px-5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
              <BookOpen className="h-3 w-3" />
              <span className="flex-1">{t("shell.docPagesCount", { count: visibleDocPages.length })}</span>
              <IconButton
                label={t("shell.manageDocPages")}
                className="!h-5 !w-5"
                onClick={() => openDocPages()}
              >
                <Settings2 className="h-3 w-3" />
              </IconButton>
              <IconButton
                label={t("shell.newDocPage")}
                className="!h-5 !w-5"
                onClick={createAndOpenDocPage}
              >
                <Plus className="h-3 w-3" />
              </IconButton>
            </div>
            {visibleDocPages.length === 0 ? (
              <div className="px-5 py-1.5 text-[11px] text-ink-faint">
                {needle ? t("shell.noMatchDocPage") : t("shell.emptyDocPages")}
              </div>
            ) : (
              visibleDocPages.map((page) => (
                <div
                  key={page.id}
                  className="wb-tree-row group"
                  style={{ paddingLeft: 22 }}
                  title={t("shell.docPageTitle", { slug: page.slug })}
                  onClick={() => openDocPages(page.id)}
                >
                  <BookOpen className="h-3.5 w-3.5 shrink-0 text-brand-500" />
                  <span className="min-w-0 flex-1 truncate">{page.title || t("shell.untitledPage")}</span>
                  <span className="wb-mini-badge">{docPageGroupLabel(page.group)}</span>
                </div>
              ))
            )}

            <div className="mt-2 px-5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
              {t("shell.apiDocsCount", { count: docRequestsTotal })}
            </div>
            {docRequestsTotal === 0 ? (
              <EmptyState
                icon={<FileText className="h-7 w-7" />}
                title={needle ? t("shell.noMatchDoc") : t("shell.emptyDocs")}
                description={t("shell.emptyDocsDesc")}
              />
            ) : (
              docGroups.map((entry) => {
                const collectionCount = entry.groups.reduce(
                  (count, group) => count + group.requests.length,
                  0,
                );
                if (collectionCount === 0) return null;
                const collectionCollapsed = collapsedDocCollections.has(entry.collectionId);
                return (
                  <div key={`doc-collection-${entry.collectionId}`}>
                    {/* 集合层：文档目录按「集合 → 文件夹(可嵌套) → 接口」三级呈现。 */}
                    <button
                      type="button"
                      className="wb-tree-group"
                      style={{ paddingLeft: 14 }}
                      title={entry.name}
                      onClick={() => toggleDocCollectionCollapse(entry.collectionId)}
                      aria-expanded={!collectionCollapsed}
                    >
                      {collectionCollapsed ? (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <Layers className="h-3.5 w-3.5 shrink-0 text-brand-500" />
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      <span className="wb-mini-badge">{collectionCount}</span>
                    </button>
                    {!collectionCollapsed &&
                      folderOutline(entry.groups).map((node) => {
                        // folderOutline 对同一 path 会先后产出「标题节点 + 叶子节点」，
                        // 两类节点的 key 必须不同，否则折叠切换重渲染时 React
                        // 按 key 复用出错，文件夹行会重复出现。
                        const folderKey = `${entry.collectionId}::folder::${node.path}`;
                        const reqsKey = `${entry.collectionId}::reqs::${node.path || "root"}`;
                        // 纯文件夹标题节点：可点击折叠，折叠后子孙（子文件夹与接口）全部隐藏。
                        if (node.path !== "" && node.requests.length === 0) {
                          if (folderHiddenByAncestor(node.path, collapsedFolders)) return null;
                          const collapsed = collapsedFolders.has(node.path);
                          const subtreeCount = entry.groups
                            .filter((group) => group.folder === node.path || group.folder.startsWith(`${node.path}/`))
                            .reduce((count, group) => count + group.requests.length, 0);
                          return (
                            <div
                              key={folderKey}
                              className={`wb-tree-row group cursor-pointer select-none ${collapsed ? "" : "open"}`}
                              style={{ paddingLeft: 22 + (node.depth - 1) * 12 }}
                              title={collapsed ? t("shell.expandFolder", { path: node.path }) : t("shell.collapseFolder", { path: node.path })}
                              onClick={() => toggleFolderCollapse(node.path)}
                              role="button"
                              aria-expanded={!collapsed}
                            >
                              <ChevronRight
                                className={`h-3 w-3 shrink-0 text-ink-faint transition-transform ${collapsed ? "" : "rotate-90"}`}
                              />
                              <Folder className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                              <span className="min-w-0 flex-1 truncate">{node.name}</span>
                              <span className="wb-mini-badge">{subtreeCount}</span>
                            </div>
                          );
                        }
                        // 接口节点：自身或任一祖先被折叠时隐藏。
                        if (
                          collapsedFolders.has(node.path) ||
                          folderHiddenByAncestor(node.path, collapsedFolders)
                        ) {
                          return null;
                        }
                        return (
                          <Fragment key={reqsKey}>
                            {node.requests.map((request) => {
                              const doc = request.doc;
                              return (
                                <div
                                  key={request.id}
                                  className={`wb-tree-row group ${activeRequestId === request.id ? "active" : ""}`}
                                  style={{ paddingLeft: 22 + node.depth * 12 }}
                                  title={doc?.summary || request.name}
                                  onClick={() => {
                                    selectRequest(entry.collectionId, request);
                                    setDetailTab("docs");
                                  }}
                                >
                                  <span className={`wb-method !w-[42px] ${methodClass(request.method)}`}>
                                    {request.method}
                                  </span>
                                  <span className="min-w-0 flex-1 truncate">{request.name}</span>
                                  {doc && (
                                    <span className="wb-mini-badge" title={t("shell.docStatus")}>{doc.status}</span>
                                  )}
                                </div>
                              );
                            })}
                          </Fragment>
                        );
                      })}
                  </div>
                );
              })
            )}
          </>
        )}

        {view === "models" && (
          <EmptyState
            icon={<Database className="h-7 w-7" />}
            title={t("core.view.models")}
            description={t("shell.modelsDesc")}
          />
        )}

        {view === "history" && (
          <>
            <div className="wb-history-filters">
              <Select
                className="!h-7 !min-w-0 !flex-1 !py-0 !text-[11px]"
                value={historyKind}
                aria-label={t("shell.history.kindLabel")}
                onChange={(event) =>
                  setHistoryKind(event.target.value as HistoryRunKind | "all")
                }
              >
                <option value="all">{t("shell.history.allKinds")}</option>
                <option value="api">{t("shell.history.kindApi")}</option>
                <option value="case">{t("shell.history.kindCase")}</option>
                <option value="scenario">{t("shell.history.kindScenario")}</option>
                <option value="benchmark">{t("shell.history.kindBenchmark")}</option>
              </Select>
            </div>
            {history.length === 0 ? (
              historyLoading || historyLoadingMore ? (
                <div className="wb-history-more">{t("shell.history.loadingMore")}</div>
              ) : (
                <EmptyState
                  icon={<Clock className="h-7 w-7" />}
                  title={needle ? t("shell.noMatchHistory") : t("shell.emptyHistory")}
                  description={t("shell.history.emptyDesc")}
                />
              )
            ) : (
              history.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`wb-history-row group ${historySelectedId === entry.id ? "selected" : ""}`}
                  onClick={() => void selectHistoryRun(entry.id)}
                  title={`${entry.name} · ${entry.projectName}`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`wb-history-kind kind-${entry.kind}`}>
                      {historyKindLabel(entry.kind, t)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink">
                      {entry.name || entry.subjectName}
                    </span>
                    <span
                      className={`font-mono text-[10px] font-bold ${
                        entry.ok && (entry.status === null || entry.status < 400)
                          ? "text-emerald-600"
                          : "text-red-500"
                      }`}
                    >
                      {entry.status ?? "ERR"}
                    </span>
                  </div>
                  <div className="mt-1 truncate pl-[50px] font-mono text-[10px] text-ink-faint">
                    {entry.method ? `${entry.method} ` : ""}{entry.url || entry.error || "—"}
                  </div>
                  <div className="mt-0.5 pl-[50px] text-[10px] text-ink-faint">
                    {new Date(entry.at).toLocaleString("zh-CN")} · {entry.timeMs} ms
                    {entry.kind === "scenario" && ` · ${entry.passed}/${entry.total}`}
                    {entry.kind === "benchmark" &&
                      ` · ${(entry.rps ?? 0).toFixed(1)} req/s · P95 ${Math.round(entry.p95Ms ?? 0)} ms`}
                    {entry.failed > 0 && ` · ${entry.failed} ${t("shell.history.failed")}`}
                  </div>
                </button>
              ))
            )}
            {/* Kept in the DOM even when empty: sparse searches may need to
                walk several pages before the first visible row appears. */}
            <div ref={sentinelRef} className="wb-history-more">
              {historyLoadingMore ? (
                <span>{t("shell.history.loadingMore")}</span>
              ) : historyError ? (
                <button
                  type="button"
                  className="wb-history-retry"
                  onClick={() => void loadHistory()}
                >
                  {historyError} · {t("shell.history.retry")}
                </button>
              ) : history.length > 0 && !historyHasMore ? (
                <span>{t("shell.history.allLoaded")}</span>
              ) : null}
            </div>
          </>
        )}
      </div>

      {treeMenu && (() => {
        const paths = folderPathsIn(treeMenu.collectionId);
        const current =
          treeMenu.kind === "request"
            ? treeMenu.folder
            : treeMenu.path.split("/").slice(0, -1).join("/");
        // A folder cannot be moved into itself or one of its descendants.
        const targets =
          treeMenu.kind === "request"
            ? paths
            : paths.filter(
                (path) =>
                  path !== treeMenu.path && !path.startsWith(`${treeMenu.path}/`),
              );
        const move = (target: string) =>
          treeMenu.kind === "request"
            ? moveRequestFromMenu(target)
            : moveFolderFromMenu(target);
        return (
          <>
            <div
              className="fixed inset-0 z-40"
              onMouseDown={() => setTreeMenu(null)}
              onContextMenu={(event) => {
                event.preventDefault();
                setTreeMenu(null);
              }}
            />
            <div
              role="menu"
              className="fixed z-50 min-w-[210px] overflow-hidden rounded-md border border-surface-border bg-surface py-1 shadow-xl"
              style={{ left: treeMenu.x, top: treeMenu.y }}
            >
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs text-ink hover:bg-brand-50/70"
                onClick={startEditingFromMenu}
              >
                <Pencil className="h-3 w-3 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate">
                  {treeMenu.kind === "request" ? t("shell.renameApi") : t("shell.renameFolder")}
                </span>
              </button>
              {treeMenu.kind === "folder" && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs text-ink hover:bg-brand-50/70"
                    onClick={() => startCreatingFolder(treeMenu.collectionId, treeMenu.path)}
                  >
                    <FolderPlus className="h-3 w-3 shrink-0 text-ink-faint" />
                    <span className="min-w-0 flex-1 truncate">{t("shell.newSubfolder")}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs text-ink hover:bg-brand-50/70"
                    onClick={() => {
                      setPendingFolderDelete({
                        collectionId: treeMenu.collectionId,
                        path: treeMenu.path,
                      });
                      setTreeMenu(null);
                    }}
                  >
                    <Trash2 className="h-3 w-3 shrink-0 text-ink-faint" />
                    <span className="min-w-0 flex-1 truncate">{t("shell.deleteFolder")}</span>
                  </button>
                </>
              )}
              <div className="my-1 border-t border-surface-border" />
              <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                {treeMenu.kind === "request" ? t("shell.moveApiTo") : t("shell.moveFolderTo")}
              </div>
              <div className="max-h-64 overflow-y-auto">
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs text-ink hover:bg-brand-50/70"
                  onClick={() => move("")}
                >
                  <Folder className="h-3 w-3 shrink-0 text-brand-500" />
                  <span className="min-w-0 flex-1 truncate">{t("shell.rootFolder")}</span>
                  {current === "" && <span className="text-brand-600">✓</span>}
                </button>
                {targets.map((path) => (
                  <button
                    key={path}
                    type="button"
                    role="menuitem"
                    title={path}
                    className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs text-ink hover:bg-brand-50/70"
                    onClick={() => move(path)}
                  >
                    <FolderOpen className="h-3 w-3 shrink-0 text-ink-faint" />
                    <span className="min-w-0 flex-1 truncate">{path}</span>
                    {current === path && <span className="text-brand-600">✓</span>}
                  </button>
                ))}
                {targets.length === 0 && (
                  <p className="px-2.5 py-1 text-[11px] text-ink-faint">
                    {t("shell.noOtherFolders")}
                  </p>
                )}
              </div>
            </div>
          </>
        );
      })()}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("shell.deleteCollection")}
        message={t("shell.deleteCollectionMsg", {
          name:
            collections.find((item) => item.id === pendingDelete)?.name ||
            t("shell.untitledCollection"),
        })}
        confirmLabel={t("shell.deleteCollection")}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) deleteCollection(pendingDelete);
          setPendingDelete(null);
        }}
      />

      <ConfirmDialog
        open={pendingFolderDelete !== null}
        title={t("shell.deleteFolder")}
        message={
          pendingFolderDelete
            ? t("shell.deleteFolderMsg", {
                name: pendingFolderDelete.path.split("/").pop() || pendingFolderDelete.path,
              })
            : ""
        }
        confirmLabel={t("shell.deleteFolder")}
        onCancel={() => setPendingFolderDelete(null)}
        onConfirm={() => {
          if (pendingFolderDelete) {
            deleteFolder(pendingFolderDelete.collectionId, pendingFolderDelete.path);
          }
          setPendingFolderDelete(null);
        }}
      />

      <ConfirmDialog
        open={confirmClearHistory}
        title={t("shell.history.clear")}
        message={t("shell.history.clearConfirm")}
        confirmLabel={t("shell.history.clear")}
        onCancel={() => setConfirmClearHistory(false)}
        onConfirm={() => {
          // Never clear other projects' history from a project-scoped view.
          void clearHistoryRuns("project");
          setConfirmClearHistory(false);
        }}
      />

      <CollectionAuthModal
        collectionId={authCollectionId}
        onClose={() => setAuthCollectionId(null)}
      />

      <div className="wb-sidebar-foot">
        <div className="flex items-center gap-2">
          <span className={`wb-status-dot ${runtime ? "" : "offline"}`} />
          <span className="min-w-0 flex-1 truncate text-[10px] text-ink-faint">
            {runtimeLabel(runtime)}
          </span>
          {caseById.size > 0 && (
            <span className="text-[10px] text-ink-faint">{t("shell.caseBadge", { count: caseById.size })}</span>
          )}
        </div>
      </div>
    </aside>
  );
}
