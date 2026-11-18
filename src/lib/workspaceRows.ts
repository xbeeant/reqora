/**
 * 统一行模型（row model）：桌面端 SQLite、协作后端 MySQL 与前端同步协议
 * 三方共用的存储语义。之前整个协作空间快照被压成一个 JSON 大字段（后端
 * longtext / 本地拆分 JSON 文件），现在按「项目 → 文件夹(集合) → 接口」
 * 结构化成行：
 *
 * - 每行 = 一个实体（集合 / 接口 / 环境 / 用例 / 场景 / 套件 / 公共构件），
 *   标量列（method / url / name / folder_path 等）独立存储，可做字段级比对；
 *   行内剩余结构（headers / body / doc / steps ...）作为一个 JSON payload。
 * - 每行携带 `updatedAt`（毫秒）与 `deleted`（软删标记），这是行级合并
 *   （per-row last-writer-wins）的唯一依据；`version` 只是通知序号，
 *   不参与冲突判定。
 * - 本机域（history / trash / dbConnections / mcpServers / 接口修订历史 /
 *   theme / settings 中的凭据字段）不进入行协议，见 lib/cloudSync.ts。
 *
 * 同步边界（第一版刻意保持简单，后续可细化）：headers/query/body 等是行内
 * payload，不拆子行；合并粒度 = 实体行。
 */

import type {
  ApiCase,
  AuthSpec,
  CodeTemplate,
  Collection,
  DataModel,
  DocPage,
  Environment,
  RequestDraft,
  ScriptSnippet,
  TestScenario,
  TestSuite,
  TombstoneKind,
  WorkspaceSettings,
  WorkspaceSnapshot,
  WorkspaceTombstone,
} from "../types.ts";
import { restoreRedacted } from "./redact.ts";

/** 行内 JSON payload 的通用形状。 */
type RowData = Record<string, unknown>;

export interface FolderRow {
  id: string;
  updatedAt: number;
  deleted?: boolean;
  name: string;
  /** 集合级鉴权；上传前已被 stripForUpload 脱敏（凭据为空串）。 */
  auth?: AuthSpec | null;
  position: number;
  /**
   * 集合级行内 payload，目前只有 `folders`（显式登记的空文件夹路径列表，
   * 见 Collection.folders）。旧快照 / 旧服务端没有该字段，缺省即可。
   */
  data?: RowData;
}

/** method / url 独立成列，便于字段级比对；其余字段在 data 里。 */
export interface RequestRow {
  id: string;
  updatedAt: number;
  deleted?: boolean;
  folderId: string;
  folderPath: string;
  name: string;
  method: string;
  url: string;
  protocol: string;
  position: number;
  data: RowData;
}

export interface EnvironmentRow {
  id: string;
  updatedAt: number;
  deleted?: boolean;
  name: string;
  position: number;
  data: RowData;
}

export interface CaseRow {
  id: string;
  updatedAt: number;
  deleted?: boolean;
  requestId: string;
  caseGroup: string;
  name: string;
  enabled: boolean;
  /** Git-native 同步文件用它还原用例顺序；服务端行集可缺省。 */
  position?: number;
  data: RowData;
}

export interface ScenarioRow {
  id: string;
  updatedAt: number;
  deleted?: boolean;
  name: string;
  position: number;
  data: RowData;
}

export interface SuiteRow {
  id: string;
  updatedAt: number;
  deleted?: boolean;
  name: string;
  position: number;
  data: RowData;
}

/** 低频共享构件：公共文档章节 / 数据模型 / 脚本片段 / 代码模板。 */
export interface ArtifactRow {
  id: string;
  updatedAt: number;
  deleted?: boolean;
  kind: "docPage" | "dataModel" | "scriptSnippet" | "codeTemplate";
  name: string;
  position: number;
  data: RowData;
}

export interface WorkspaceMetaRow {
  seeded?: boolean;
  activeEnvironmentId?: string | null;
  /** 共享设置子集（不含本机凭据字段，由 stripForUpload 裁剪）。 */
  settings?: Partial<WorkspaceSettings>;
}

/** 任意共享域的行（行级 delta 载荷的元素类型）。 */
export type AnyRow =
  | FolderRow
  | RequestRow
  | EnvironmentRow
  | CaseRow
  | ScenarioRow
  | SuiteRow
  | ArtifactRow;

/**
 * 行级增量保存载荷（save_workspace_rows）。只携带本次编辑实际触达的行，
 * 由前端 pending 队列累积、400ms 防抖后发送；Rust 侧逐行 upsert（列级
 * diff 语义与整份保存一致），并发语义（workspace_rev CAS）也保持不变。
 */
export interface WorkspaceDeltaPayload {  rows: Partial<
    Pick<
      WorkspaceRowsPayload,
      "folders" | "requests" | "environments" | "cases" | "scenarios" | "suites" | "artifacts"
    >
  >;
  history?: { id: string; at: number; data: unknown }[];
  /** 辅助表裁剪（history 200 条 / trash 200 条 / 每接口 20 条修订的淘汰）。 */
  historyDeletes?: string[];
  trash?: { id: string; deletedAt: number; data: unknown }[];
  trashDeletes?: string[];
  revisions?: { requestId: string; id: string; at: number; data: unknown }[];
  revisionDeletes?: { requestId: string; id: string }[];
  meta?: {
    seeded?: boolean;
    activeEnvironmentId?: string | null;
    theme?: string;
    settings?: Partial<WorkspaceSettings>;
  };
}

export interface WorkspaceRowsPayload {
  folders: FolderRow[];
  requests: RequestRow[];
  environments: EnvironmentRow[];
  cases: CaseRow[];
  scenarios: ScenarioRow[];
  suites: SuiteRow[];
  artifacts: ArtifactRow[];
  meta?: WorkspaceMetaRow;
}

const rowOf = (updatedAt: unknown): number =>
  typeof updatedAt === "number" && updatedAt > 0 ? updatedAt : 0;

const omit = <T extends object>(item: T, keys: readonly string[]): RowData => {
  const result: RowData = {};
  for (const [key, value] of Object.entries(item as RowData)) {
    if (!keys.includes(key)) result[key] = value;
  }
  return result;
};

const sortedByPosition = <T extends { position: number }>(rows: T[]): T[] =>
  [...rows].sort((left, right) => left.position - right.position);

// ---------------------------------------------- 单实体 → 行（delta 保存共用） ----
//
// snapshotToRows（整份物化）与行级增量保存（save_workspace_rows 的前端载荷）
// 共用同一组单实体转换，避免两套转换逻辑漂移。

export function folderToRow(collection: Collection, position: number): FolderRow {
  return {
    id: collection.id,
    name: collection.name,
    auth: collection.auth ?? null,
    position,
    updatedAt: rowOf((collection as { updatedAt?: number }).updatedAt),
    data: (collection.folders ?? []).length > 0 ? { folders: collection.folders } : {},
  };
}

export function requestToRow(item: RequestDraft, folderId: string, position: number): RequestRow {
  return {
    id: item.id,
    folderId,
    folderPath: item.folder ?? "",
    name: item.name,
    method: item.method,
    url: item.url,
    protocol: item.protocol ?? "http",
    position,
    updatedAt: rowOf(item.updatedAt),
    data: omit(item, ["id", "folder", "name", "method", "url", "protocol", "updatedAt"]),
  };
}

export function environmentToRow(environment: Environment, position: number): EnvironmentRow {
  return {
    id: environment.id,
    name: environment.name,
    position,
    updatedAt: rowOf((environment as { updatedAt?: number }).updatedAt),
    data: omit(environment, ["id", "name", "updatedAt"]),
  };
}

export function caseToRow(item: ApiCase, position?: number): CaseRow {
  return {
    id: item.id,
    requestId: item.requestId,
    caseGroup: item.group,
    name: item.name,
    enabled: item.enabled,
    ...(typeof position === "number" ? { position } : {}),
    updatedAt: rowOf(item.updatedAt),
    data: omit(item, ["id", "requestId", "group", "name", "enabled", "updatedAt"]),
  };
}

export function scenarioToRow(item: TestScenario, position: number): ScenarioRow {
  return {
    id: item.id,
    name: item.name,
    position,
    updatedAt: rowOf(item.updatedAt),
    data: omit(item, ["id", "name", "updatedAt"]),
  };
}

export function suiteToRow(item: TestSuite, position: number): SuiteRow {
  return {
    id: item.id,
    name: item.name,
    position,
    updatedAt: rowOf(item.updatedAt),
    data: omit(item, ["id", "name", "updatedAt"]),
  };
}

export type ArtifactKind = ArtifactRow["kind"];

export function artifactToRow(
  kind: ArtifactKind,
  item: Record<string, unknown>,
  position: number,
): ArtifactRow {
  const nameKey = kind === "docPage" ? "title" : "name";
  return {
    kind,
    id: item.id as string,
    name: ((item[nameKey] as string | undefined) ?? ""),
    position,
    updatedAt: rowOf(item.updatedAt),
    data: omit(item, ["id", nameKey]),
  };
}

/** 墓碑 → 单条删除行（标量列留空，LWW 只看 id / updatedAt / deleted）。 */
export function tombstoneToRow(
  tombstone: WorkspaceTombstone,
): FolderRow | RequestRow | EnvironmentRow | CaseRow | ScenarioRow | SuiteRow | ArtifactRow {
  const base = { id: tombstone.id, updatedAt: rowOf(tombstone.updatedAt), deleted: true as const };
  switch (tombstone.kind) {
    case "folder":
      return { ...base, name: "", auth: null, position: 0 };
    case "request":
      return {
        ...base,
        folderId: "",
        folderPath: "",
        name: "",
        method: "",
        url: "",
        protocol: "http",
        position: 0,
        data: {},
      };
    case "environment":
      return { ...base, name: "", position: 0, data: {} };
    case "case":
      return {
        ...base,
        requestId: "",
        caseGroup: "",
        name: "",
        enabled: false,
        data: {},
      };
    case "scenario":
      return { ...base, name: "", position: 0, data: {} };
    case "suite":
      return { ...base, name: "", position: 0, data: {} };
    case "docPage":
    case "dataModel":
    case "scriptSnippet":
    case "codeTemplate":
      return { ...base, kind: tombstone.kind, name: "", position: 0, data: {} };
  }
}

/**
 * 墓碑 → 删除行。只携带行级合并必需的 id / updatedAt / deleted，其余标量列
 * 留空；服务端 LWW 用 updatedAt 决定墓碑是否覆盖对方版本。已经在同一快照
 * 里的活行优先（墓碑与活行不应共存，防御性跳过）。
 */
function appendTombstones(
  tombstones: WorkspaceTombstone[] | undefined,
  rows: Omit<WorkspaceRowsPayload, "meta">,
): void {
  const live = new Set<string>();
  const remember = (kind: TombstoneKind, id: string) => live.add(`${kind}:${id}`);
  for (const row of rows.folders) remember("folder", row.id);
  for (const row of rows.requests) remember("request", row.id);
  for (const row of rows.environments) remember("environment", row.id);
  for (const row of rows.cases) remember("case", row.id);
  for (const row of rows.scenarios) remember("scenario", row.id);
  for (const row of rows.suites) remember("suite", row.id);
  for (const row of rows.artifacts) remember(row.kind, row.id);

  for (const tombstone of tombstones ?? []) {
    const key = `${tombstone.kind}:${tombstone.id}`;
    if (live.has(key)) continue;
    const row = tombstoneToRow(tombstone);
    switch (tombstone.kind) {
      case "folder":
        rows.folders.push(row as FolderRow);
        break;
      case "request":
        rows.requests.push(row as RequestRow);
        break;
      case "environment":
        rows.environments.push(row as EnvironmentRow);
        break;
      case "case":
        rows.cases.push(row as CaseRow);
        break;
      case "scenario":
        rows.scenarios.push(row as ScenarioRow);
        break;
      case "suite":
        rows.suites.push(row as SuiteRow);
        break;
      default:
        rows.artifacts.push(row as ArtifactRow);
        break;
    }
    live.add(key);
  }
}

/** 快照 → 行。只含共享域；本机域由调用方自行处理（不进同步协议）。 */
export function snapshotToRows(snapshot: WorkspaceSnapshot): WorkspaceRowsPayload {
  const folders: FolderRow[] = [];
  const requests: RequestRow[] = [];

  (snapshot.collections ?? []).forEach((collection, collectionIndex) => {
    folders.push(folderToRow(collection, collectionIndex));
    (collection.items ?? []).forEach((item, itemIndex) => {
      requests.push(requestToRow(item, collection.id, itemIndex));
    });
  });

  const environments: EnvironmentRow[] = (snapshot.environments ?? []).map(
    (environment, index) => environmentToRow(environment, index),
  );

  const cases: CaseRow[] = (snapshot.cases ?? []).map((item) => caseToRow(item));

  const scenarios: ScenarioRow[] = (snapshot.scenarios ?? []).map((item, index) =>
    scenarioToRow(item, index),
  );

  const suites: SuiteRow[] = (snapshot.suites ?? []).map((item, index) => suiteToRow(item, index));

  const artifacts: ArtifactRow[] = [
    ...(snapshot.docPages ?? []).map((item: DocPage, index) =>
      artifactToRow("docPage", item as unknown as Record<string, unknown>, index),
    ),
    ...(snapshot.dataModels ?? []).map((item: DataModel, index) =>
      artifactToRow("dataModel", item as unknown as Record<string, unknown>, index),
    ),
    ...(snapshot.scriptLibrary ?? []).map((item: ScriptSnippet, index) =>
      artifactToRow("scriptSnippet", item as unknown as Record<string, unknown>, index),
    ),
    ...(snapshot.codeTemplates ?? []).map((item: CodeTemplate, index) =>
      artifactToRow("codeTemplate", item as unknown as Record<string, unknown>, index),
    ),
  ];

  const rows: WorkspaceRowsPayload = {
    folders,
    requests,
    environments,
    cases,
    scenarios,
    suites,
    artifacts,
    meta: {
      seeded: snapshot.seeded,
      activeEnvironmentId: snapshot.activeEnvironmentId,
      settings: snapshot.settings,
    },
  };
  appendTombstones(snapshot.tombstones, rows);
  return rows;
}

/** 行 → 快照（只重组共享域；本机域保持调用方传入的 base 不变）。 */
export function rowsToSnapshot(
  rows: WorkspaceRowsPayload,
  base?: WorkspaceSnapshot,
): WorkspaceSnapshot {
  const baseSnapshot: WorkspaceSnapshot =
    base ??
    ({
      version: 1,
      seeded: false,
      collections: [],
      environments: [],
      activeEnvironmentId: null,
      history: [],
      cases: [],
      scenarios: [],
      trash: [],
      settings: { timeoutSecs: 30, followRedirects: true, verifyTls: true },
    } as unknown as WorkspaceSnapshot);

  const itemsByFolder = new Map<string, RequestDraft[]>();
  for (const row of sortedByPosition(rows.requests ?? [])) {
    if (row.deleted) continue;
    const request = {
      ...(row.data as unknown as RequestDraft),
      id: row.id,
      folder: row.folderPath,
      name: row.name,
      method: row.method,
      url: row.url,
      protocol: (row.protocol === "ws" || row.protocol === "tcp" || row.protocol === "mqtt" || row.protocol === "soap" ? row.protocol : "http") as
        | "http"
        | "ws"
        | "tcp"
        | "mqtt"
        | "soap",
      updatedAt: row.updatedAt,
    } as RequestDraft;
    const list = itemsByFolder.get(row.folderId) ?? [];
    list.push(request);
    itemsByFolder.set(row.folderId, list);
  }

  const collections: Collection[] = sortedByPosition(rows.folders ?? [])
    .filter((row) => !row.deleted)
    .map((row) => ({
      id: row.id,
      name: row.name,
      auth: row.auth ?? undefined,
      // 显式登记的空文件夹列表（缺失 / 非法时按无空文件夹处理）。
      ...(Array.isArray((row.data as { folders?: unknown } | undefined)?.folders)
        ? { folders: (row.data as { folders: string[] }).folders }
        : {}),
      items: itemsByFolder.get(row.id) ?? [],
      updatedAt: row.updatedAt,
    } as unknown as Collection));

  const environments: Environment[] = sortedByPosition(rows.environments ?? [])
    .filter((row) => !row.deleted)
    .map(
      (row) =>
        ({
          ...(row.data as unknown as Environment),
          id: row.id,
          name: row.name,
          updatedAt: row.updatedAt,
        }) as unknown as Environment,
    );

  // 用例没有独立的 position 列，但 Git-native 文件按 id 排序写出，
  // 归一化时补的 position 保留了原始顺序；这里统一按 position 还原，
  // 避免「同步一次后用例顺序被改成 id 字典序」这种静默数据变化。
  const cases: ApiCase[] = sortedByPosition(
    (rows.cases ?? []).map((row, index) => ({
      ...row,
      position: typeof row.position === "number" && Number.isFinite(row.position)
        ? row.position
        : index,
    })),
  )
    .filter((row) => !row.deleted)
    .map(
      (row) =>
        ({
          ...(row.data as unknown as ApiCase),
          id: row.id,
          requestId: row.requestId,
          group: row.caseGroup,
          name: row.name,
          enabled: row.enabled,
          updatedAt: row.updatedAt,
        }) as unknown as ApiCase,
    );

  const scenarios: TestScenario[] = sortedByPosition(rows.scenarios ?? [])
    .filter((row) => !row.deleted)
    .map(
      (row) =>
        ({
          ...(row.data as unknown as TestScenario),
          id: row.id,
          name: row.name,
          updatedAt: row.updatedAt,
        }) as unknown as TestScenario,
    );

  const suites: TestSuite[] = sortedByPosition(rows.suites ?? [])
    .filter((row) => !row.deleted)
    .map(
      (row) =>
        ({
          ...(row.data as unknown as TestSuite),
          id: row.id,
          name: row.name,
          updatedAt: row.updatedAt,
        }) as unknown as TestSuite,
    );

  const docPages: DocPage[] = [];
  const dataModels: DataModel[] = [];
  const scriptLibrary: ScriptSnippet[] = [];
  const codeTemplates: CodeTemplate[] = [];
  for (const row of sortedByPosition(rows.artifacts ?? [])) {
    if (row.deleted) continue;
    if (row.kind === "docPage") {
      docPages.push({ ...(row.data as unknown as DocPage), id: row.id, title: row.name });
    } else if (row.kind === "dataModel") {
      dataModels.push({ ...(row.data as unknown as DataModel), id: row.id, name: row.name });
    } else if (row.kind === "scriptSnippet") {
      scriptLibrary.push({
        ...(row.data as unknown as ScriptSnippet),
        id: row.id,
        name: row.name,
      });
    } else if (row.kind === "codeTemplate") {
      codeTemplates.push({
        ...(row.data as unknown as CodeTemplate),
        id: row.id,
        name: row.name,
      });
    }
  }

  const tombstones: WorkspaceTombstone[] = [];
  const rowKeys = new Set<string>();
  const collectTombstone = (
    kind: TombstoneKind,
    id: string,
    updatedAt: number,
    deleted: boolean | undefined,
  ) => {
    rowKeys.add(`${kind}:${id}`);
    if (deleted) tombstones.push({ kind, id, updatedAt });
  };
  for (const row of rows.folders ?? []) {
    collectTombstone("folder", row.id, row.updatedAt, row.deleted);
  }
  for (const row of rows.requests ?? []) {
    collectTombstone("request", row.id, row.updatedAt, row.deleted);
  }
  for (const row of rows.environments ?? []) {
    collectTombstone("environment", row.id, row.updatedAt, row.deleted);
  }
  for (const row of rows.cases ?? []) {
    collectTombstone("case", row.id, row.updatedAt, row.deleted);
  }
  for (const row of rows.scenarios ?? []) {
    collectTombstone("scenario", row.id, row.updatedAt, row.deleted);
  }
  for (const row of rows.suites ?? []) {
    collectTombstone("suite", row.id, row.updatedAt, row.deleted);
  }
  for (const row of rows.artifacts ?? []) {
    collectTombstone(row.kind, row.id, row.updatedAt, row.deleted);
  }
  // 本地尚未同步的墓碑也必须保留，否则下一次同步会忘记删除。
  for (const tombstone of baseSnapshot.tombstones ?? []) {
    if (!rowKeys.has(`${tombstone.kind}:${tombstone.id}`)) tombstones.push(tombstone);
  }

  return {
    ...baseSnapshot,
    collections,
    environments,
    cases,
    scenarios,
    suites,
    docPages,
    dataModels,
    scriptLibrary,
    codeTemplates,
    tombstones,
    ...(rows.meta?.activeEnvironmentId !== undefined
      ? { activeEnvironmentId: rows.meta.activeEnvironmentId }
      : {}),
    ...(rows.meta?.settings ? { settings: { ...baseSnapshot.settings, ...rows.meta.settings } } : {}),
    ...(rows.meta?.seeded !== undefined ? { seeded: rows.meta.seeded } : {}),
  };
}

// ------------------------------------------------ 行级合并（双向同步） ----

export interface MergeOutcome {
  /** 合并后的远端行（已在凭据上做了本地回填），用于写回本地快照。 */
  remote: WorkspaceRowsPayload;
  /** 本地比远端新的行，调用方把它们上传给服务端。 */
  localChanges: WorkspaceRowsPayload;
  /** 被远端软删标记删除的本地行 id（按域分组）。 */
  removed: string[];
}

const ROW_DOMAINS = [
  "folders",
  "requests",
  "environments",
  "cases",
  "scenarios",
  "suites",
  "artifacts",
] as const;

type RowDomain = (typeof ROW_DOMAINS)[number];

/**
 * 凭据回填：远端行的凭据在上传前被置空，行合并获胜时不能把本地真实凭据
 * 洗成空串。委托给 `restoreRedacted`，覆盖 auth / KeyValue / 环境变量 /
 * 用例请求 / 场景步骤 / 文档正文等所有脱敏位置。
 */
export function restoreRowCredentials(remote: RowData, local: RowData): RowData {
  return restoreRedacted(remote, local) as RowData;
}

/**
 * 服务端返回的全量行：逐行用上传前的本地行回填凭据。远端独有的行没有本地
 * 依据，保持脱敏结果（协作者需要自己填）。
 */
export function restoreRowsCredentials(
  rows: WorkspaceRowsPayload,
  local: WorkspaceRowsPayload,
): WorkspaceRowsPayload {
  const restored = {} as Record<RowDomain, unknown[]>;
  for (const domain of ROW_DOMAINS) {
    const byId = new Map(
      (local[domain] ?? []).map((row) => [row.id, row as unknown as RowData]),
    );
    restored[domain] = (rows[domain] ?? []).map((row) => {
      const localRow = byId.get(row.id);
      return localRow
        ? restoreRowCredentials(row as unknown as RowData, localRow)
        : row;
    });
  }
  return {
    ...(restored as unknown as Omit<WorkspaceRowsPayload, "meta">),
    ...(rows.meta !== undefined ? { meta: rows.meta } : {}),
  };
}

/**
 * 双向行级合并：每行按 updatedAt 胜出（相同 id），远端软删传播删除。
 * 远端获胜的行做凭据回填后返回；本地获胜的行进入 localChanges 待上传。
 *
 * 相等时间戳的收敛规则（两端必须一致，否则同时编辑会来回抖动）：
 * - 墓碑优先于同时间戳的活行：删除是显式动作，不能被并列的旧内容复活。
 * - 双方都活时以服务端版本为准，客户端不上传（服务端事务里已是该版本）。
 */
export function mergeRows(
  local: WorkspaceRowsPayload,
  remote: WorkspaceRowsPayload,
): MergeOutcome {
  const localByDomain = new Map<RowDomain, Map<string, RowData>>(
    ROW_DOMAINS.map((domain) => [
      domain,
      new Map((local[domain] ?? []).map((row) => [row.id, row as unknown as RowData])),
    ]),
  );
  const remoteIds = new Map<RowDomain, Set<string>>(
    ROW_DOMAINS.map((domain) => [
      domain,
      new Set((remote[domain] ?? []).map((row) => row.id)),
    ]),
  );

  const remoteMerged = {} as Record<RowDomain, unknown[]>;
  const localChanges = {} as Record<RowDomain, unknown[]>;
  const removed: string[] = [];

  for (const domain of ROW_DOMAINS) {
    const localMap = localByDomain.get(domain) ?? new Map<string, RowData>();
    const mergedRows: unknown[] = [];
    const changedRows: unknown[] = [];
    for (const remoteRow of (remote[domain] ?? []) as unknown as Array<
      RowData & { id: string; updatedAt: number; deleted?: boolean }
    >) {
      const localRow = localMap.get(remoteRow.id);
      if (!localRow) {
        // 远端本地都没有的墓碑不必进入本地快照：本地本来就没有该实体。
        if (!remoteRow.deleted) mergedRows.push(remoteRow);
        continue;
      }
      const localAt = Number(localRow.updatedAt ?? 0);
      const localDeleted = localRow.deleted === true;
      const remoteAt = remoteRow.updatedAt;

      if (localDeleted && remoteRow.deleted) {
        // 双方都删了：保留较新的墓碑；相等时以服务端墓碑为准。
        if (localAt > remoteAt) {
          mergedRows.push(localRow);
          changedRows.push(localRow);
        } else {
          mergedRows.push(remoteRow);
        }
        continue;
      }
      if (localDeleted) {
        // 本地墓碑 vs 远端活行：本地更新或相等 → 墓碑胜出并上传；
        // 远端更新 → 以远端为准（另一端在删除后重新创建/恢复了该行）。
        if (localAt >= remoteAt) {
          mergedRows.push(localRow);
          changedRows.push(localRow);
        } else {
          mergedRows.push(remoteRow);
        }
        continue;
      }
      if (remoteRow.deleted) {
        // 本地活行 vs 远端墓碑：本地更新 → 复活并上传；否则墓碑胜出。
        if (localAt > remoteAt) {
          mergedRows.push(localRow);
          changedRows.push(localRow);
        } else {
          removed.push(remoteRow.id);
        }
        continue;
      }
      // 双方都活：远端更新、或时间戳相等（服务端为准）→ 采用远端；
      // 仅本地严格更新时保留本地并上传。
      if (localAt > remoteAt) {
        mergedRows.push(localRow);
        changedRows.push(localRow);
      } else {
        mergedRows.push(restoreRowCredentials(remoteRow, localRow));
      }
    }
    // 本地独有（远端没有的 id）也要上传——新建的行 / 尚未同步的墓碑。
    const remoteIdSet = remoteIds.get(domain) ?? new Set<string>();
    for (const localRow of localMap.values()) {
      if (!remoteIdSet.has(localRow.id as string)) {
        mergedRows.push(localRow);
        changedRows.push(localRow);
      }
    }
    remoteMerged[domain] = mergedRows;
    localChanges[domain] = changedRows;
  }

  return {
    remote: {
      ...(remoteMerged as unknown as Omit<WorkspaceRowsPayload, "meta">),
      meta: remote.meta ?? local.meta,
    },
    localChanges: localChanges as unknown as WorkspaceRowsPayload,
    removed,
  };
}

// ------------------------------------------------ 基线三方合并（冲突提醒） ----

/** 一条冲突：本地与云端都相对基线修改过的行，两个版本都留存供用户裁决。 */
export interface ThreeWayConflict {
  domain: RowDomain;
  id: string;
  /** 展示名（远端/本地行的 name，缺省用 id）。 */
  name: string;
  /** 基线版本（上次成功同步的服务端行）；字段级三方合并的共同祖先。 */
  base: RowData | null;
  /** 本地版本（完整行，含墓碑语义）；null 表示本地已没有该行。 */
  local: RowData | null;
  /** 云端版本；null 表示服务端已没有该行（被硬删）。 */
  remote: RowData | null;
}

export interface ThreeWayOutcome {
  /** 合并后的远端行（已做凭据回填），用于写回本地快照。 */
  remote: WorkspaceRowsPayload;
  /** 待上传的行（本地获胜且确实变更过；冲突行不自动上传）。 */
  localChanges: WorkspaceRowsPayload;
  /** 被远端删除传播掉的本地行 id。 */
  removed: string[];
  /** 双方都修改过的冲突行（保留本地版本，待用户裁决）。 */
  conflicts: ThreeWayConflict[];
}

/** 稳定字符串化：键递归排序后序列化，用于内容相等比较（与服务端往返后的键序无关）。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

const rowsEqual = (a: RowData | null, b: RowData | null): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return stableStringify(a) === stableStringify(b);
};

/**
 * 基线三方合并：以「上次成功同步时的服务端行集」为共同祖先，
 * - 仅本地变 → 保留本地并上传；
 * - 仅云端变 → 采用云端（凭据回填）；
 * - 双方都变 → **冲突**：本地保留自己的版本（绝不静默覆盖/丢失），不上传，
 *   记入 conflicts 交由用户裁决（用本地 / 用云端）。
 * 无基线（首次同步 / 基线失效）时退化为现有 LWW 语义，不产生冲突——
 * 第一轮同步的目的就是建立基线。相等时间戳与墓碑的收敛规则同 `mergeRows`。
 */
export function threeWayMerge(
  local: WorkspaceRowsPayload,
  remote: WorkspaceRowsPayload,
  baseline: WorkspaceRowsPayload | null,
  options?: { skipIds?: Set<string> },
): ThreeWayOutcome {
  // 无基线（首次同步 / 换绑后基线失效）：退化为现有 LWW 语义建立基线，
  // 不产生冲突——否则所有行都会被误判为「双方都改了」。
  if (!baseline) {
    const fallback = mergeRows(local, remote);
    return { ...fallback, removed: [], conflicts: [] };
  }
  const skip = options?.skipIds;
  const localByDomain = new Map<RowDomain, Map<string, RowData>>(
    ROW_DOMAINS.map((domain) => [
      domain,
      new Map((local[domain] ?? []).map((row) => [row.id, row as unknown as RowData])),
    ]),
  );
  const remoteByDomain = new Map<RowDomain, Map<string, RowData>>(
    ROW_DOMAINS.map((domain) => [
      domain,
      new Map((remote[domain] ?? []).map((row) => [row.id, row as unknown as RowData])),
    ]),
  );
  const baseByDomain = new Map<RowDomain, Map<string, RowData>>(
    ROW_DOMAINS.map((domain) => [
      domain,
      new Map(
        ((baseline?.[domain] ?? []) as unknown as RowData[]).map((row) => [
          String(row.id),
          row,
        ]),
      ),
    ]),
  );

  const remoteMerged = {} as Record<RowDomain, unknown[]>;
  const localChanges = {} as Record<RowDomain, unknown[]>;
  const conflicts: ThreeWayConflict[] = [];

  for (const domain of ROW_DOMAINS) {
    const localMap = localByDomain.get(domain) ?? new Map<string, RowData>();
    const remoteMap = remoteByDomain.get(domain) ?? new Map<string, RowData>();
    const baseMap = baseByDomain.get(domain) ?? new Map<string, RowData>();
    const mergedRows: unknown[] = [];
    const changedRows: unknown[] = [];

    // 收集该域所有出现过的 id（本地 ∪ 远端）。
    const ids = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);
    for (const id of ids) {
      const L = localMap.get(id) ?? null;
      const R = remoteMap.get(id) ?? null;
      const B = baseMap.get(id) ?? null;
      const lDeleted = L?.deleted === true;

      // 挂起中的冲突行：保留本地版本，不上传、不覆盖、不重复报告。
      if (skip?.has(`${domain}:${id}`)) {
        if (L) mergedRows.push(L as RowData);
        continue;
      }

      if (!L && !R) continue;

      if (L && R) {
        if (rowsEqual(L, R)) {
          // 两端内容一致（含时钟偏差导致的相同修改）：收敛，采用云端。
          mergedRows.push(lDeleted ? L : (R as RowData));
          if (B) continue;
          // 两端同时新建了同一行：以上传云端版本为准建立基线，无需上传。
          continue;
        }
        const lChanged = !rowsEqual(L, B);
        const rChanged = !rowsEqual(R, B);
        if (!lChanged && !rChanged) {
          mergedRows.push(R as RowData); // 理论不可达（内容不同至少一方变了）。
        } else if (lChanged && !rChanged) {
          mergedRows.push(L as RowData);
          changedRows.push(L as RowData);
        } else if (!lChanged && rChanged) {
          mergedRows.push(restoreRowCredentials(R as RowData, L as RowData));
        } else {
          // 双方都改了：冲突。本地保留本地版本，不上传，等用户裁决。
          conflicts.push({
            domain,
            id,
            name: String((R as RowData).name || (L as RowData).name || id),
            base: B as RowData,
            local: L as RowData,
            remote: R as RowData,
          });
          mergedRows.push(L as RowData);
        }
        continue;
      }

      if (L && !R) {
        if (!B) {
          // 本地新建（或尚未同步的墓碑）：上传。
          mergedRows.push(L as RowData);
          changedRows.push(L as RowData);
        } else if (lDeleted) {
          // 本地已删（墓碑）且服务端也没了：收敛的删除，丢弃墓碑。
        } else {
          // 服务端没有该行但基线有（被硬删），本地还是活行：冲突（云端侧=删除）。
          conflicts.push({
            domain,
            id,
            name: String((L as RowData).name || id),
            base: B as RowData,
            local: L as RowData,
            remote: null,
          });
          mergedRows.push(L as RowData);
        }
        continue;
      }

      // !L && R
      if (!B) {
        // 云端新建：合并进本地。
        mergedRows.push(R as RowData);
      } else {
        // 基线有、本地无（本地删除已被清理）而云端还有：采用云端版本。
        mergedRows.push(R as RowData);
      }
    }

    remoteMerged[domain] = mergedRows;
    localChanges[domain] = changedRows;
  }

  return {
    remote: {
      ...(remoteMerged as unknown as Omit<WorkspaceRowsPayload, "meta">),
      meta: remote.meta ?? local.meta,
    },
    localChanges: localChanges as unknown as WorkspaceRowsPayload,
    removed: [],
    conflicts,
  };
}
