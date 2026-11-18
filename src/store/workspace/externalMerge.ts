/**
 * 外部增量刷新：把 Rust `load_workspace_delta` 返回的「已装配实体」合并进
 * 内存快照。内存快照保持完整（云同步 / CRDT / 导出路径无需改动），这里只
 * 替换变化的行，避免每次 MCP / CLI 写入都重载整份 ~25 MiB 快照。
 *
 * 合并遵循「位置 / 父级必须自洽」原则：一旦外部写入与内存索引不一致
 * （例如行被移动、父集合不存在、版本落后），返回 null 让调用方整份重载
 * 自愈 —— 顺序和引用关系只能由 DB 权威重建。
 */
import type {
  Collection,
  WorkspaceSnapshot,
  WorkspaceTombstone,
} from "../../types.ts";

export interface ExternalDeltaEntry {
  domain: string;
  position?: number;
  parentId?: string | null;
  item?: Record<string, unknown>;
  deleted?: boolean;
  tombstone?: WorkspaceTombstone;
}

export interface ExternalDeltaPayload {
  /** 调用方版本领先于磁盘（项目库被替换）→ 只能整份重载。 */
  reset?: boolean;
  rev: number;
  writer?: string;
  entries?: ExternalDeltaEntry[];
  /** history / trash / revisions / meta 也有变化：这些表没有实体行可合并，
   * 只能整份重载，否则外部写入会被静默漏掉。 */
  auxChanged?: boolean;
  auxTables?: string[];
}

type AnyRecord = Record<string, unknown>;
type DomainArrays = Record<string, AnyRecord[]>;

/** 简单域：域键与快照字段一一对应；requests / collections 另行处理。 */
const SIMPLE_DOMAINS: Record<string, keyof WorkspaceSnapshot> = {
  environments: "environments",
  cases: "cases",
  scenarios: "scenarios",
  suites: "suites",
  docPages: "docPages",
  dataModels: "dataModels",
  scriptLibrary: "scriptLibrary",
  codeTemplates: "codeTemplates",
  dbConnections: "dbConnections",
  mcpServers: "mcpServers",
};

/** 墓碑类型 → 活动实体所在的域（用于从内存快照移除对应实体）。 */
const TOMBSTONE_DOMAINS: Record<string, string> = {
  folder: "collections",
  request: "requests",
  environment: "environments",
  case: "cases",
  scenario: "scenarios",
  suite: "suites",
  docPage: "docPages",
  dataModel: "dataModels",
  scriptSnippet: "scriptLibrary",
  codeTemplate: "codeTemplates",
};

function idOf(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const id = (value as AnyRecord).id;
  return typeof id === "string" ? id : "";
}

/** 声誉数组引用优先：没被改动的域保持原引用，避免 zustand 选择器误触发。 */
function domainFromSnapshot(snapshot: WorkspaceSnapshot, domain: string): AnyRecord[] | null {
  if (domain === "collections") return snapshot.collections as unknown as AnyRecord[];
  if (domain === "requests") return null; // 请求挂在集合内部，走专用路径
  const key = SIMPLE_DOMAINS[domain];
  if (!key) return null;
  const value = snapshot[key];
  return Array.isArray(value) ? (value as unknown as AnyRecord[]) : [];
}

/** 按 position 插入 / 替换。位置不对说明内存索引已漂移，交给整份重载。 */
function putAt(array: AnyRecord[], item: AnyRecord, position: number, id: string): boolean {
  const index = array.findIndex((entry) => idOf(entry) === id);
  if (index >= 0) {
    if (index !== position) return false;
    array[index] = item;
    return true;
  }
  if (!Number.isInteger(position) || position < 0 || position > array.length) return false;
  array.splice(position, 0, item);
  return true;
}

function removeId(array: AnyRecord[], id: string): AnyRecord[] {
  return array.filter((entry) => idOf(entry) !== id);
}

/**
 * 增量合并。返回 null = 无法安全合并，调用方必须整份重载。
 * `delta.entries` 的顺序由 Rust 端按 (kind, position, id) 排序：新行先于
 * 后续被它挤位的行，因此逐条 splice 后位置自然对齐。
 */
export function mergeExternalDelta(
  snapshot: WorkspaceSnapshot,
  delta: ExternalDeltaPayload,
): WorkspaceSnapshot | null {
  // 辅助表（history / trash / revisions / meta）无法按实体行合并：即使本次
  // 同时有实体行变化，也必须整份重载，避免只合并一半导致 UI 少数据。
  if (delta.reset || delta.auxChanged || !Array.isArray(delta.entries)) return null;

  const arrays: DomainArrays = {
    collections: (snapshot.collections as unknown as AnyRecord[]).slice(),
    tombstones: (snapshot.tombstones ?? []).slice() as unknown as AnyRecord[],
  };
  const touched = new Set<string>();
  const ensure = (domain: string): AnyRecord[] | null => {
    if (!arrays[domain]) {
      const base = domainFromSnapshot(snapshot, domain);
      if (base === null) return null;
      arrays[domain] = base.slice();
    }
    touched.add(domain);
    return arrays[domain];
  };
  /** 修改集合内的 items 时必须复制集合对象（zustand / React 引用语义）。 */
  const patchCollections = (
    id: string,
    update: (collection: AnyRecord, items: AnyRecord[]) => AnyRecord[],
  ): boolean => {
    const list = arrays.collections;
    const index = list.findIndex((collection) => idOf(collection) === id);
    if (index < 0) return false;
    const collection = list[index];
    const oldItems = Array.isArray(collection.items) ? (collection.items as AnyRecord[]) : [];
    const items = update(collection, oldItems);
    if (items === oldItems) return true;
    list[index] = { ...collection, items };
    touched.add("collections");
    return true;
  };

  for (const entry of delta.entries) {
    if (!entry || typeof entry.domain !== "string") return null;

    if (entry.deleted) {
      const tombstone = entry.tombstone;
      if (!tombstone || typeof tombstone.kind !== "string" || !tombstone.id) return null;
      const tombstones = arrays.tombstones;
      const index = tombstones.findIndex(
        (row) => row.kind === tombstone.kind && row.id === tombstone.id,
      );
      if (index >= 0) tombstones[index] = tombstone as unknown as AnyRecord;
      else tombstones.push(tombstone as unknown as AnyRecord);
      touched.add("tombstones");

      const domain = entry.domain || TOMBSTONE_DOMAINS[tombstone.kind];
      if (domain === "requests") {
        let changed = false;
        arrays.collections = arrays.collections.map((collection) => {
          if (!Array.isArray(collection.items)) return collection;
          const items = collection.items as AnyRecord[];
          if (!items.some((item) => idOf(item) === tombstone.id)) return collection;
          changed = true;
          return { ...collection, items: removeId(items, tombstone.id) };
        });
        if (changed) touched.add("collections");
      } else if (domain === "collections") {
        const before = arrays.collections.length;
        arrays.collections = removeId(arrays.collections, tombstone.id);
        if (arrays.collections.length !== before) touched.add("collections");
      } else {
        const array = ensure(domain);
        if (array === null) return null;
        arrays[domain] = removeId(array, tombstone.id);
      }
      continue;
    }

    const item = entry.item;
    const id = idOf(item);
    if (!item || !id) return null;

    if (entry.domain === "collections") {
      // 集合行只带元数据（items: []）：原位替换元数据，保留内存里的接口列表。
      const index = arrays.collections.findIndex((collection) => idOf(collection) === id);
      if (index >= 0) {
        const position = entry.position ?? index;
        if (index !== position) return null; // 集合顺序漂移
        const previous = arrays.collections[index];
        const items = previous.items;
        arrays.collections[index] = { ...item, items };
      } else if (!putAt(arrays.collections, item, entry.position ?? arrays.collections.length, id)) {
        return null;
      }
      touched.add("collections");
      continue;
    }

    if (entry.domain === "requests") {
      const parentId = entry.parentId;
      // 行级位置是权威索引：缺位置 / 父级一律整份重载。
      if (!parentId || !Number.isInteger(entry.position)) return null;
      const position = entry.position as number;
      // 移动过的请求（旧父集合里还在）不能简单插入：整份重载自愈。
      const elsewhere = arrays.collections.some(
        (collection) =>
          idOf(collection) !== parentId &&
          Array.isArray(collection.items) &&
          (collection.items as AnyRecord[]).some((row) => idOf(row) === id),
      );
      if (elsewhere) return null;
      if (!arrays.collections.some((collection) => idOf(collection) === parentId)) return null;
      patchCollections(
        parentId,
        (_collection, items) => {
          const next = items.slice();
          return putAt(next, item, position, id) ? next : items;
        },
      );
      const collection = arrays.collections.find((row) => idOf(row) === parentId);
      const items = Array.isArray(collection?.items) ? (collection.items as AnyRecord[]) : [];
      if (items.findIndex((row) => idOf(row) === id) !== position) return null;
      continue;
    }

    const array = ensure(entry.domain);
    if (array === null) return null; // 未知域：不猜，整份重载
    if (!putAt(array, item, entry.position ?? array.length, id)) return null;
  }

  if (touched.size === 0) return snapshot;
  let result = snapshot;
  for (const domain of touched) {
    if (domain === "tombstones") {
      result = {
        ...result,
        tombstones: arrays.tombstones as unknown as WorkspaceTombstone[],
      };
    } else if (domain === "collections") {
      result = { ...result, collections: arrays.collections as unknown as Collection[] };
    } else if (domain === "requests") {
      continue; // 请求变更已体现在 collections
    } else {
      const key = SIMPLE_DOMAINS[domain];
      if (key) {
        result = { ...result, [key]: arrays[domain] } as WorkspaceSnapshot;
      }
    }
  }
  return result;
}
