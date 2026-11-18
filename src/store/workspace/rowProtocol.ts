import { stableStringify } from "../../lib/cloudSync.ts";
import {
  artifactToRow,
  caseToRow,
  environmentToRow,
  folderToRow,
  requestToRow,
  scenarioToRow,
  suiteToRow,
  tombstoneToRow,
} from "../../lib/workspaceRows.ts";
import type {
  AnyRow,
  WorkspaceDeltaPayload,
} from "../../lib/workspaceRows.ts";
import type { ApiCase } from "../../types.ts";
import type { CodeTemplate } from "../../types.ts";
import type { Collection } from "../../types.ts";
import type { DataModel } from "../../types.ts";
import type { DocPage } from "../../types.ts";
import type { Environment } from "../../types.ts";
import type { RequestDraft } from "../../types.ts";
import type { ScriptSnippet } from "../../types.ts";
import type { TestScenario } from "../../types.ts";
import type { TestSuite } from "../../types.ts";
import type { TombstoneKind } from "../../types.ts";
import type { WorkspaceSnapshot } from "../../types.ts";
import type { WorkspaceTombstone } from "../../types.ts";

// ------------------------------------------------ row-protocol stamping ----

/** 只在行协议里共享的实体及其位置（位置变化 = 移动 / 排序，也要同步）。 */
export interface TrackedEntity {
  kind: TombstoneKind;
  id: string;
  placement: string;
  entity: Record<string, unknown>;
}

export const VOLATILE_KEYS = ["updatedAt", "contentUpdatedAt"] as const;
/** 请求的元数据字段：改名 / 移动 / 文档编辑不算“接口内容变更”。 */
export const REQUEST_METADATA_KEYS = ["name", "folder", "doc", "description"] as const;

export function trackEntities(snapshot: WorkspaceSnapshot): Map<string, TrackedEntity> {
  const tracked = new Map<string, TrackedEntity>();
  const add = (
    kind: TombstoneKind,
    id: string,
    placement: string,
    entity: object,
  ) => {
    tracked.set(`${kind}:${id}`, {
      kind,
      id,
      placement,
      entity: entity as Record<string, unknown>,
    });
  };

  (snapshot.collections ?? []).forEach((collection, index) => {
    add("folder", collection.id, `folder:${index}`, collection);
    (collection.items ?? []).forEach((item, itemIndex) => {
      add("request", item.id, `request:${collection.id}:${itemIndex}`, item);
    });
  });
  (snapshot.environments ?? []).forEach((item, index) =>
    add("environment", item.id, `environment:${index}`, item),
  );
  (snapshot.cases ?? []).forEach((item) => add("case", item.id, "case", item));
  (snapshot.scenarios ?? []).forEach((item, index) =>
    add("scenario", item.id, `scenario:${index}`, item),
  );
  (snapshot.suites ?? []).forEach((item, index) => add("suite", item.id, `suite:${index}`, item));
  (snapshot.docPages ?? []).forEach((item, index) =>
    add("docPage", item.id, `docPage:${index}`, item),
  );
  (snapshot.dataModels ?? []).forEach((item, index) =>
    add("dataModel", item.id, `dataModel:${index}`, item),
  );
  (snapshot.scriptLibrary ?? []).forEach((item, index) =>
    add("scriptSnippet", item.id, `scriptSnippet:${index}`, item),
  );
  (snapshot.codeTemplates ?? []).forEach((item, index) =>
    add("codeTemplate", item.id, `codeTemplate:${index}`, item),
  );
  return tracked;
}

export function signatureOf(
  kind: TombstoneKind,
  entity: Record<string, unknown>,
  contentOnly: boolean,
): string {
  const omitted: readonly string[] =
    kind === "folder"
      ? [...VOLATILE_KEYS, "items"]
      : kind === "request" && contentOnly
        ? [...VOLATILE_KEYS, ...REQUEST_METADATA_KEYS]
        : VOLATILE_KEYS;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entity)) {
    if (!omitted.includes(key)) copy[key] = value;
  }
  return stableStringify(copy);
}

// ------------------------------------------------------- dirty collection ----

/**
 * 一次 mutate 产生的变更行。`entity` 为 stamp 后的完整实体；删除时为 null，
 * 此时 `tombstone` 必然存在。持久化层只把 dirty 行发给 `save_workspace_rows`，
 * 不再携带整份快照。
 */
export interface DirtyEntry {
  kind: TombstoneKind;
  id: string;
  entity: Record<string, unknown> | null;
  /** request 行需要：所属集合 id 与位置；folder / 其他域为位置。 */
  collectionId?: string | null;
  position?: number;
  tombstone?: WorkspaceTombstone;
}

/** history / trash / revisions 三张辅助表的变更行（按 id 差分，均只增不改）。 */
export interface AuxDirty {
  history: { id: string; at: number; data: unknown }[];
  historyDeletes: string[];
  trash: { id: string; deletedAt: number; data: unknown }[];
  trashDeletes: string[];
  revisions: { requestId: string; id: string; at: number; data: unknown }[];
  revisionDeletes: { requestId: string; id: string }[];
}

export interface StampOutcome {
  stamped: WorkspaceSnapshot;
  dirty: DirtyEntry[];
  aux: AuxDirty;
}

interface StampResult {
  entity: Record<string, unknown>;
  changed: boolean;
}

/**
 * 给发生变化的行刷新 `updatedAt`；请求内容变化时同时刷新 `contentUpdatedAt`。
 *
 * 快路径：所有 slice 都是不可变更新（map + spread），实体内容未变时其对象
 * 引用跨 mutate 保持不变 —— 引用相等 + 位置相等即可直接返回，跳过原本对
 * 每个实体都要做的两次 stableStringify（在 25 MiB 级快照上每次编辑都是
 * O(全库字节数)）。引用不同才回退到内容指纹比较，防御就地改写的情况。
 */
export function stampEntity(
  kind: TombstoneKind,
  placement: string,
  entity: Record<string, unknown>,
  previous: Map<string, TrackedEntity>,
  now: number,
): StampResult {
  const prior = previous.get(`${kind}:${entity.id as string}`);
  if (!prior) {
    return {
      entity: {
        ...entity,
        updatedAt: now,
        ...(kind === "request" ? { contentUpdatedAt: now } : {}),
      },
      changed: true,
    };
  }
  if (entity === prior.entity && placement === prior.placement) {
    return { entity, changed: false };
  }
  const changed = signatureOf(kind, entity, false) !== signatureOf(kind, prior.entity, false);
  const moved = placement !== prior.placement;
  if (!changed && !moved) return { entity, changed: false };
  const stamped: Record<string, unknown> = { ...entity, updatedAt: now };
  if (
    kind === "request" &&
    changed &&
    signatureOf(kind, entity, true) !== signatureOf(kind, prior.entity, true)
  ) {
    stamped.contentUpdatedAt = now;
  }
  return { entity: stamped, changed: true };
}

type DomainContext = (item: Record<string, unknown>, index: number) => {
  collectionId?: string | null;
  position?: number;
};

function stampDomain(
  kind: TombstoneKind,
  items: Record<string, unknown>[] | undefined,
  previousIndex: Map<string, TrackedEntity>,
  now: number,
  liveKeys: Set<string>,
  dirty: DirtyEntry[],
  placementOf: (index: number, item: Record<string, unknown>) => string,
  contextOf?: DomainContext,
): { rows: Record<string, unknown>[]; changedCount: number } {
  const rows: Record<string, unknown>[] = [];
  let changedCount = 0;
  (items ?? []).forEach((item, index) => {
    const placement = placementOf(index, item);
    liveKeys.add(`${kind}:${item.id as string}`);
    const result = stampEntity(kind, placement, item, previousIndex, now);
    if (result.changed) {
      changedCount += 1;
      dirty.push({
        kind,
        id: item.id as string,
        entity: result.entity,
        ...(contextOf?.(item, index) ?? {}),
      });
    }
    rows.push(result.entity);
  });
  return { rows, changedCount };
}

/** 辅助表差分：按 id 判定新增 / 删除，行内容只增不改。 */export function diffAux(previous: WorkspaceSnapshot, next: WorkspaceSnapshot): AuxDirty {
  const aux: AuxDirty = {
    history: [],
    historyDeletes: [],
    trash: [],
    trashDeletes: [],
    revisions: [],
    revisionDeletes: [],
  };

  const previousHistory = new Map(
    (previous.history ?? []).map((entry) => [entry.id as string, entry]),
  );
  const nextHistoryIds = new Set<string>();
  for (const entry of next.history ?? []) {
    nextHistoryIds.add(entry.id as string);
    if (!previousHistory.has(entry.id as string)) {
      aux.history.push({ id: entry.id as string, at: entry.at as number, data: entry });
    }
  }
  for (const [id] of previousHistory) {
    if (!nextHistoryIds.has(id)) aux.historyDeletes.push(id);
  }

  const previousTrash = new Map(
    (previous.trash ?? []).map((entry) => [entry.id as string, entry]),
  );
  const nextTrashIds = new Set<string>();
  for (const entry of next.trash ?? []) {
    nextTrashIds.add(entry.id as string);
    if (!previousTrash.has(entry.id as string)) {
      aux.trash.push({
        id: entry.id as string,
        deletedAt: entry.deletedAt as number,
        data: entry,
      });
    }
  }
  for (const [id] of previousTrash) {
    if (!nextTrashIds.has(id)) aux.trashDeletes.push(id);
  }

  const previousRevisions = previous.revisions ?? {};
  const nextRevisions = next.revisions ?? {};
  for (const [requestId, revisions] of Object.entries(nextRevisions)) {
    const previousIds = new Set(
      (previousRevisions[requestId] ?? []).map((revision) => revision.id as string),
    );
    for (const revision of revisions ?? []) {
      if (previousIds.has(revision.id as string)) continue;
      aux.revisions.push({
        requestId,
        id: revision.id as string,
        at: revision.at as number,
        data: revision,
      });
    }
  }
  for (const [requestId, revisions] of Object.entries(previousRevisions)) {
    const nextIds = new Set(
      (nextRevisions[requestId] ?? []).map((revision) => revision.id as string),
    );
    for (const revision of revisions ?? []) {
      if (!nextIds.has(revision.id as string)) {
        aux.revisionDeletes.push({ requestId, id: revision.id as string });
      }
    }
  }
  return aux;
}

// ------------------------------------------------- dirty → delta payload ----

/** DirtyEntry 的域 → delta 载荷里的 rows 键。 */
const DIRTY_DOMAIN: Record<
  DirtyEntry["kind"],
  keyof WorkspaceDeltaPayload["rows"]
> = {
  folder: "folders",
  request: "requests",
  environment: "environments",
  case: "cases",
  scenario: "scenarios",
  suite: "suites",
  docPage: "artifacts",
  dataModel: "artifacts",
  scriptSnippet: "artifacts",
  codeTemplate: "artifacts",
};

/**
 * 单条 dirty 行 → 行模型行（活行走单实体转换，删除走墓碑行）。
 * 与 snapshotToRows 共用同一组转换函数，保证两条保存通道产出完全一致。
 */
export function dirtyEntryToRow(entry: DirtyEntry): AnyRow {
  if (!entry.entity) {
    return tombstoneToRow(
      entry.tombstone ?? { kind: entry.kind, id: entry.id, updatedAt: Date.now() },
    );
  }
  const entity = entry.entity;
  switch (entry.kind) {
    case "folder":
      return folderToRow(entity as unknown as Collection, entry.position ?? 0);
    case "request":
      return requestToRow(
        entity as unknown as RequestDraft,
        entry.collectionId ?? "",
        entry.position ?? 0,
      );
    case "environment":
      return environmentToRow(entity as unknown as Environment, entry.position ?? 0);
    case "case":
      return caseToRow(entity as unknown as ApiCase);
    case "scenario":
      return scenarioToRow(entity as unknown as TestScenario, entry.position ?? 0);
    case "suite":
      return suiteToRow(entity as unknown as TestSuite, entry.position ?? 0);
    case "docPage":
    case "dataModel":
    case "scriptSnippet":
    case "codeTemplate":
      return artifactToRow(entry.kind, entity, entry.position ?? 0);
  }
}

/** 把 dirty 行按域分组并转成行，得到 save_workspace_rows 的 rows 载荷。 */
export function deltaRowsFromDirty(
  dirty: DirtyEntry[],
): WorkspaceDeltaPayload["rows"] {
  const rows: WorkspaceDeltaPayload["rows"] = {};
  for (const entry of dirty) {
    const domain = DIRTY_DOMAIN[entry.kind];
    if (!rows[domain]) rows[domain] = [];
    (rows[domain] as unknown[]).push(dirtyEntryToRow(entry));
  }
  return rows;
}

/**
 * 行协议写入前的统一收口：任何共享实体一旦变化就刷新 `updatedAt`，删除则
 * 生成墓碑。这样所有编辑动作都不必各自记得 bump 时间戳（漏一个就会让改动
 * 永远同步不出去），同时 `contentUpdatedAt` 只跟真正的接口内容走，改名 /
 * 移动 / 文档不会把用例误标成“接口已变更”。
 *
 * 返回值除 stamp 后的快照外，还携带本次的 dirty 行与辅助表差分，供
 * `commit()` 累积进 pending 队列，最终以行级 delta 持久化。
 */
export function stampSharedChanges(
  previous: WorkspaceSnapshot,
  next: WorkspaceSnapshot,
): StampOutcome {
  const now = Date.now();
  const previousIndex = trackEntities(previous);
  const liveKeys = new Set<string>();
  const dirty: DirtyEntry[] = [];

  const collections = (next.collections ?? []).map((collection, index) => {
    liveKeys.add(`folder:${collection.id}`);
    const folder = stampDomain(
      "folder",
      [collection as unknown as Record<string, unknown>],
      previousIndex,
      now,
      liveKeys,
      dirty,
      () => `folder:${index}`,
      () => ({ position: index }),
    );
    const items = stampDomain(
      "request",
      (collection.items ?? []) as unknown as Record<string, unknown>[],
      previousIndex,
      now,
      liveKeys,
      dirty,
      (itemIndex) => `request:${collection.id}:${itemIndex}`,
      (_item, itemIndex) => ({ collectionId: collection.id, position: itemIndex }),
    );
    // 整个集合（含全部接口行）都未变化时保留原对象引用：域级 selector 依赖
    // 引用稳定性跳过重渲染。
    if (folder.changedCount === 0 && items.changedCount === 0) return collection;
    const stampedCollection = folder.rows[0] as unknown as Collection;
    return {
      ...stampedCollection,
      items: (items.changedCount === 0
        ? collection.items
        : (items.rows as unknown as Collection["items"])),
    };
  });

  const environments = stampDomain(
    "environment",
    (next.environments ?? []) as unknown as Record<string, unknown>[],
    previousIndex,
    now,
    liveKeys,
    dirty,
    (index) => `environment:${index}`,
    (_item, index) => ({ position: index }),
  );
  const environmentsOut = (
    environments.changedCount === 0 ? (next.environments ?? []) : environments.rows
  ) as Environment[];

  const cases = stampDomain(
    "case",
    (next.cases ?? []) as unknown as Record<string, unknown>[],
    previousIndex,
    now,
    liveKeys,
    dirty,
    () => "case",
  );
  const casesOut = (cases.changedCount === 0 ? (next.cases ?? []) : cases.rows) as ApiCase[];

  const scenarios = stampDomain(
    "scenario",
    (next.scenarios ?? []) as unknown as Record<string, unknown>[],
    previousIndex,
    now,
    liveKeys,
    dirty,
    (index) => `scenario:${index}`,
    (_item, index) => ({ position: index }),
  );
  const scenariosOut = (
    scenarios.changedCount === 0 ? (next.scenarios ?? []) : scenarios.rows
  ) as TestScenario[];

  const suites = stampDomain(
    "suite",
    (next.suites ?? []) as unknown as Record<string, unknown>[],
    previousIndex,
    now,
    liveKeys,
    dirty,
    (index) => `suite:${index}`,
    (_item, index) => ({ position: index }),
  );
  const suitesOut = (suites.changedCount === 0 ? (next.suites ?? []) : suites.rows) as TestSuite[];

  const docPages = stampDomain(
    "docPage",
    (next.docPages ?? []) as unknown as Record<string, unknown>[],
    previousIndex,
    now,
    liveKeys,
    dirty,
    (index) => `docPage:${index}`,
    (_item, index) => ({ position: index }),
  );
  const docPagesOut = (
    docPages.changedCount === 0 ? (next.docPages ?? []) : docPages.rows
  ) as DocPage[];

  const dataModels = stampDomain(
    "dataModel",
    (next.dataModels ?? []) as unknown as Record<string, unknown>[],
    previousIndex,
    now,
    liveKeys,
    dirty,
    (index) => `dataModel:${index}`,
    (_item, index) => ({ position: index }),
  );
  const dataModelsOut = (
    dataModels.changedCount === 0 ? (next.dataModels ?? []) : dataModels.rows
  ) as DataModel[];

  const scriptLibrary = stampDomain(
    "scriptSnippet",
    (next.scriptLibrary ?? []) as unknown as Record<string, unknown>[],
    previousIndex,
    now,
    liveKeys,
    dirty,
    (index) => `scriptSnippet:${index}`,
    (_item, index) => ({ position: index }),
  );
  const scriptLibraryOut = (
    scriptLibrary.changedCount === 0 ? (next.scriptLibrary ?? []) : scriptLibrary.rows
  ) as ScriptSnippet[];

  const codeTemplates = stampDomain(
    "codeTemplate",
    (next.codeTemplates ?? []) as unknown as Record<string, unknown>[],
    previousIndex,
    now,
    liveKeys,
    dirty,
    (index) => `codeTemplate:${index}`,
    (_item, index) => ({ position: index }),
  );
  const codeTemplatesOut = (
    codeTemplates.changedCount === 0 ? (next.codeTemplates ?? []) : codeTemplates.rows
  ) as CodeTemplate[];

  // 墓碑：显式保留未同步的删除；本次被删掉、且没有重新出现的实体补一条。
  const tombstones: WorkspaceTombstone[] = [];
  const seen = new Set<string>();
  for (const tombstone of next.tombstones ?? previous.tombstones ?? []) {
    const key = `${tombstone.kind}:${tombstone.id}`;
    if (liveKeys.has(key) || seen.has(key)) continue;
    tombstones.push(tombstone);
    seen.add(key);
  }
  for (const [key, tracked] of previousIndex) {
    if (liveKeys.has(key) || seen.has(key)) continue;
    const tombstone: WorkspaceTombstone = {
      kind: tracked.kind,
      id: tracked.id,
      updatedAt: now,
    };
    tombstones.push(tombstone);
    seen.add(key);
    dirty.push({ kind: tracked.kind, id: tracked.id, entity: null, tombstone });
  }

  const stamped: WorkspaceSnapshot = {
    ...next,
    collections: collections as Collection[],
    environments: environmentsOut,
    cases: casesOut,
    scenarios: scenariosOut,
    suites: suitesOut,
    docPages: docPagesOut,
    dataModels: dataModelsOut,
    scriptLibrary: scriptLibraryOut,
    codeTemplates: codeTemplatesOut,
    tombstones,
  };
  return { stamped, dirty, aux: diffAux(previous, next) };
}
