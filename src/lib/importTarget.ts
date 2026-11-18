import type {
  BodySpec,
  Collection,
  Environment,
  KeyValue,
  ParamMeta,
  RequestDraft,
} from "../types.ts";

/**
 * Where imported requests should land.
 *
 * Historically every import (cURL / HAR / Postman / OpenAPI) created a brand
 * new collection — a pasted cURL command always produced a lonely "cURL 导入"
 * collection. The import dialog now lets the user pick an existing collection
 * and folder instead. All the placement maths lives here so `node --test` can
 * cover it without React / zustand.
 *
 * `Collection.items` is a flat array; hierarchy is expressed by the
 * `RequestDraft.folder` `"父/子"` path (see collectionTree.ts).
 */
export interface ImportTarget {
  /** Existing collection id. Missing / unknown id => create new collection(s). */
  collectionId?: string | null;
  /** Override the auto-detected name when a single new collection is created. */
  newCollectionName?: string;
  /** keep = leave parsed folders intact; root = flatten everything to the
   * collection root; prefix = put everything under `folder`. */
  folderMode?: "keep" | "root" | "prefix";
  /** Prefix path used by `folderMode: "prefix"`; an empty value is the root. */
  folder?: string;
  /** In prefix mode, keep Postman folders / OpenAPI tags as sub-folders.
   * Defaults to true so importing a Postman collection into "商城" still
   * yields "商城/用户/登录" instead of flattening the whole tree. */
  preserveSourceFolders?: boolean;
}

/** Sentinel option values used by the dialog; real folders are plain paths. */
export const KEEP_FOLDER = "__keep__";
export const ROOT_FOLDER = "__root__";
export const NEW_FOLDER = "__new__";
export const NEW_COLLECTION = "__new_collection__";

const RESERVED = new Set<string>([KEEP_FOLDER, ROOT_FOLDER, NEW_FOLDER]);

/** Trim segments, drop empty / dot segments and normalise separators. */
export function normalizeFolderPath(input: string): string {
  return (input ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..")
    .join("/");
}

/**
 * Every folder path in a collection, including intermediate ancestors
 * (`"a/b/c"` yields `a`, `a/b`, `a/b/c`), deduplicated and sorted.
 * 显式登记的空文件夹（`Collection.folders`）同样计入。
 */
export function listFolderPaths(
  collections: Collection[],
  collectionId: string,
): string[] {
  const collection = collections.find((item) => item.id === collectionId);
  const paths = new Set<string>();
  const add = (input: string) => {
    const segments = normalizeFolderPath(input).split("/").filter(Boolean);
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      // Never let a stored folder collide with a sentinel option value.
      if (!RESERVED.has(prefix)) paths.add(prefix);
    }
  };
  for (const item of collection?.items ?? []) add(item.folder ?? "");
  for (const folder of collection?.folders ?? []) add(folder);
  return [...paths].sort((left, right) => left.localeCompare(right));
}

/** Final `RequestDraft.folder` for one imported request. */
export function resolveImportFolder(
  target: ImportTarget | undefined,
  sourceFolder: string,
): string {
  const source = normalizeFolderPath(sourceFolder ?? "");
  const mode = target?.folderMode ?? "keep";
  if (mode === "keep") return source;
  if (mode === "root") return "";
  const prefix = normalizeFolderPath(target?.folder ?? "");
  const child = target?.preserveSourceFolders === false ? "" : source;
  return [prefix, child].filter(Boolean).join("/");
}

// ------------------------------------------------- interface identity ----

/**
 * 接口唯一识别的 URL 归一化。规则（针对「重复导入同一份定义」）：
 *
 * - `?query` / `#fragment` 不计入身份：所有导入器都把 query 拆成独立行，
 *   但用户手写的请求可能把 query 留在 URL 里，两边必须能匹配到同一个接口；
 *   花括号内的 `?` / `#`（模板表达式）不会被误切。
 * - `scheme://host` 按 RFC 大小写不敏感做小写化，path 大小写敏感保持原样；
 *   含 `{{ }}` 模板的 host 不改写，避免把两个不同的变量名视作同一个。
 * - **路径变量算在 URL 里**：`:id` 与 `{id}` 统一成 `{id}`，但变量名不同
 *   （`:id` vs `:userId`）仍是两个不同接口；`{{变量}}` 原样保留、不解析，
 *   这样身份与当前激活的环境无关。
 * - query 行、请求体、header 都不参与身份判定：同名接口的这些定义由导入源
 *   覆盖更新，正是重复导入要做的事。
 */
const TEMPLATE_MASK = /\{\{\s*[^{}]+?\s*\}\}/g;
const PATH_VAR_TOKEN = /:([A-Za-z_$][A-Za-z0-9_$-]*)|\{([A-Za-z_$][A-Za-z0-9_$-]*)\}/g;

export function canonicalRequestUrl(raw: string): string {
  let url = (raw ?? "").trim();
  if (url === "") return "";

  // 1) 只在花括号外截断 query / fragment。
  let depth = 0;
  let cut = url.length;
  for (let index = 0; index < url.length; index += 1) {
    const char = url[index];
    if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (char === "?" || char === "#")) {
      cut = index;
      break;
    }
  }
  url = url.slice(0, cut);

  // 2) scheme / host 大小写归一化；模板化的 host 跳过，避免误并不同变量。
  const prefix = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(url);
  if (prefix && !prefix[2].includes("{")) {
    const at = prefix[2].lastIndexOf("@");
    const userinfo = at >= 0 ? prefix[2].slice(0, at + 1) : "";
    const host = (at >= 0 ? prefix[2].slice(at + 1) : prefix[2]).toLowerCase();
    url = `${prefix[1].toLowerCase()}://${userinfo}${host}${url.slice(prefix[0].length)}`;
  }

  // 3) 统一路径变量写法，仅在 path 段扫描（避开端口、userinfo、模板）。
  const scheme = url.indexOf("://");
  const start = scheme >= 0
    ? (url.indexOf("/", scheme + 3) >= 0 ? url.indexOf("/", scheme + 3) : url.length)
    : 0;
  if (start >= url.length) return url;
  // 用等长 NUL 遮罩 {{...}}，索引不变；替换仍作用在原串上以保留模板原文。
  const maskedPath = url.replace(TEMPLATE_MASK, (match) => "\0".repeat(match.length)).slice(start);
  const scanner = new RegExp(PATH_VAR_TOKEN.source, "g");
  const edits: { from: number; to: number; text: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(maskedPath)) !== null) {
    const from = start + match.index;
    edits.push({ from, to: from + match[0].length, text: `{${match[1] ?? match[2]}}` });
  }
  if (edits.length === 0) return url;
  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    out += url.slice(cursor, edit.from) + edit.text;
    cursor = edit.to;
  }
  return out + url.slice(cursor);
}

/**
 * 接口身份 = 目标文件夹 + 协议 + 请求方法 + URL（含路径变量）。
 * 空 URL 返回 null：这种残缺请求一律新增，不参与覆盖匹配。
 */
export function requestIdentityKey(
  item: Pick<RequestDraft, "method" | "url" | "folder" | "protocol">,
): string | null {
  const url = canonicalRequestUrl(item.url ?? "");
  if (url === "") return null;
  const method = String(item.method ?? "GET").trim().toUpperCase();
  const protocol = String(item.protocol ?? "http").trim().toLowerCase();
  return `${normalizeFolderPath(item.folder ?? "")}\0${protocol}\0${method}\0${url}`;
}

// --------------------------------------------------------- merge rows ----

/**
 * 沿用旧行的 id：doc.paramMeta 以 `q:<rowId>` / `h:<rowId>` 为键，
 * 行协议的内容指纹也包含行 id。重复导入若换掉整批行 id，会同时
 * 丢掉用户写的参数说明，并让「用例是否过期」被误判为已变更。
 */
function mergeRows<T extends KeyValue>(
  existingRows: T[] | undefined,
  incomingRows: T[] | undefined,
): { rows: T[]; idMap: Map<string, string> } {
  const source = Array.isArray(existingRows) ? existingRows : [];
  const used = new Set<number>();
  const idMap = new Map<string, string>();
  const rows = (Array.isArray(incomingRows) ? incomingRows : []).map((row, index) => {
    const key = row?.key ?? "";
    if (key === "") return row;
    let match = !used.has(index) && source[index]?.key === key ? index : -1;
    if (match < 0) match = source.findIndex((old, at) => !used.has(at) && old?.key === key);
    if (match < 0) return row;
    used.add(match);
    const oldId = source[match].id;
    if (typeof row.id === "string" && typeof oldId === "string") idMap.set(row.id, oldId);
    return { ...row, id: oldId };
  });
  return { rows, idMap };
}

function mergeBody(
  existing: BodySpec | undefined,
  incoming: BodySpec | undefined,
): { body: BodySpec; idMap: Map<string, string> } {
  const next = incoming ?? ({ type: "none" } as BodySpec);
  const prev = existing ?? ({ type: "none" } as BodySpec);
  if (next.type === "formUrlEncoded") {
    if (prev.type !== "formUrlEncoded") return { body: next, idMap: new Map() };
    const merged = mergeRows(prev.items ?? [], next.items ?? []);
    return { body: { type: "formUrlEncoded", items: merged.rows }, idMap: merged.idMap };
  }
  if (next.type === "formData") {
    if (prev.type !== "formData") return { body: next, idMap: new Map() };
    const merged = mergeRows(prev.items ?? [], next.items ?? []);
    return { body: { type: "formData", items: merged.rows }, idMap: merged.idMap };
  }
  return { body: next, idMap: new Map() };
}

function remapParamMeta(
  meta: Record<string, ParamMeta> | undefined,
  idMap: Map<string, string>,
): Record<string, ParamMeta> {
  const out: Record<string, ParamMeta> = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    const prefix = key.slice(0, 2);
    const id = key.slice(2);
    out[prefix + (prefix === "q:" || prefix === "h:" ? (idMap.get(id) ?? id) : id)] = value;
  }
  return out;
}

/**
 * 覆盖规则：导入源拥有「接口定义」（name / method / url / headers / query /
 * body / auth / description / doc 说明与参数表）；本地身份与本地独有数据保留
 * （id、脚本、断言、路径变量取值、流式偏好、文档归属/状态/标签/响应示例、
 * 用例与历史引用）。这样重复导入既能刷新定义，又不会清空用户在本机的工作。
 */
export function mergeImportedRequest(
  existing: RequestDraft,
  incoming: RequestDraft,
): RequestDraft {
  const headers = mergeRows(existing.headers, incoming.headers);
  const query = mergeRows(existing.query, incoming.query);
  const body = mergeBody(existing.body, incoming.body);
  const idMap = new Map<string, string>([
    ...headers.idMap,
    ...query.idMap,
    ...body.idMap,
  ]);
  const liveRowIds = new Set(
    [...headers.rows, ...query.rows].map((row) => row.id).filter((id) => typeof id === "string"),
  );
  // 旧文档里指向已被删除的参数行的说明不再保留。
  const localMeta: Record<string, ParamMeta> = {};
  for (const [key, value] of Object.entries(existing.doc?.paramMeta ?? {})) {
    const prefix = key.slice(0, 2);
    if ((prefix === "q:" || prefix === "h:") && !liveRowIds.has(key.slice(2))) continue;
    localMeta[key] = value;
  }
  const oldDoc = existing.doc;
  const newDoc = incoming.doc;
  return {
    ...incoming,
    id: existing.id,
    headers: headers.rows,
    query: query.rows,
    body: body.body,
    preScript: existing.preScript ?? "",
    postScript: existing.postScript ?? "",
    assertions: existing.assertions ?? [],
    pathVariables: existing.pathVariables ?? [],
    stream: existing.stream ?? "auto",
    doc: {
      ...(newDoc ?? {}),
      ...(oldDoc ?? {}),
      // 说明文字 / 参数表来自导入源
      summary: newDoc?.summary ?? "",
      description: newDoc?.description ?? "",
      paramMeta: { ...localMeta, ...remapParamMeta(newDoc?.paramMeta, idMap) },
      // 文档资产属于本地工作
      owner: oldDoc?.owner ?? "",
      status: oldDoc?.status ?? "开发中",
      tags: oldDoc?.tags ?? [],
      responses: oldDoc?.responses ?? [],
      updatedAt: oldDoc?.updatedAt ?? 0,
    },
    // 行协议的 stampSharedChanges 会按内容指纹决定是否刷新；沿用旧时间戳，
    // 让「导入一份完全相同的文件」不产生修订、也不把用例误标成已变更。
    updatedAt: existing.updatedAt ?? 0,
    contentUpdatedAt: existing.contentUpdatedAt ?? existing.updatedAt ?? 0,
  };
}

export interface RequestMergeResult {
  items: RequestDraft[];
  added: number;
  overwritten: number;
  /** Ids of the existing rows that were replaced (kept stable on merge). */
  overwrittenIds: string[];
  /** 同一批导入中身份重复的请求数量（全部保留，不静默丢数据）。 */
  duplicateIncoming: number;
}

/**
 * 只与「目标集合里已经存在的」请求比对，作用域限定在同一目标文件夹。
 *
 * 同键的已有请求可能不止一个（用户此前手工复制过 / 旧版本遗留），用队列
 * 依次覆盖：第 n 个导入项覆盖第 n 个已有项，多出来的追加，绝不删除已有项。
 * 这样 HAR 里同一端点的多条抓包不会互相吞掉，且反复导入会收敛到稳定条目。
 */
export function mergeImportedRequests(
  existingItems: RequestDraft[],
  incomingItems: RequestDraft[],
): RequestMergeResult {
  const buckets = new Map<string, number[]>();
  existingItems.forEach((item, index) => {
    const key = requestIdentityKey(item);
    if (key === null) return;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(index);
    else buckets.set(key, [index]);
  });
  const cursors = new Map<string, number>();
  const seenIncoming = new Set<string>();
  const items = [...existingItems];
  const overwrittenIds: string[] = [];
  let added = 0;
  let overwritten = 0;
  let duplicateIncoming = 0;
  for (const incoming of incomingItems) {
    const key = requestIdentityKey(incoming);
    if (key === null) {
      items.push(incoming);
      added += 1;
      continue;
    }
    if (seenIncoming.has(key)) duplicateIncoming += 1;
    seenIncoming.add(key);
    const bucket = buckets.get(key) ?? [];
    const cursor = cursors.get(key) ?? 0;
    if (cursor < bucket.length) {
      const at = bucket[cursor];
      items[at] = mergeImportedRequest(items[at], incoming);
      overwrittenIds.push(items[at].id);
      cursors.set(key, cursor + 1);
      overwritten += 1;
    } else {
      items.push(incoming);
      added += 1;
    }
  }
  return { items, added, overwritten, overwrittenIds, duplicateIncoming };
}

export interface EnvironmentMergeResult {
  environments: Environment[];
  added: number;
  merged: number;
}

/**
 * 环境按名称去重，避免重复导入时每轮都追加一份同名环境。同名时保留 id
 * 与本地已填好的变量值（token / 密码不能被默认空值冲掉），只补入新变量。
 * 新建集合/环境只影响 incoming，不动已有环境。
 */
export function mergeImportedEnvironments(
  existing: Environment[] | undefined,
  incoming: Array<Omit<Environment, "id">> | undefined,
  makeId: () => string,
): EnvironmentMergeResult {
  const environments = [...(existing ?? [])];
  const byName = new Map<string, number>();
  environments.forEach((item, index) => {
    const name = item.name?.trim();
    if (name && !byName.has(name)) byName.set(name, index);
  });
  let added = 0;
  let merged = 0;
  for (const raw of incoming ?? []) {
    const name = (raw.name ?? "").trim();
    const at = name ? byName.get(name) : undefined;
    if (at === undefined) {
      environments.push({ ...raw, id: makeId(), name: name || raw.name });
      if (name) byName.set(name, environments.length - 1);
      added += 1;
      continue;
    }
    const current = environments[at];
    const variables = [...(current.variables ?? [])];
    for (const row of raw.variables ?? []) {
      const index = variables.findIndex((item) => item.key === row.key);
      if (index < 0) {
        variables.push(row);
      } else {
        const old = variables[index];
        variables[index] = {
          ...row,
          id: old.id,
          value: old.value,
          enabled: old.enabled,
          ...(old.secret === true ? { secret: true } : {}),
        };
      }
    }
    environments[at] = {
      ...current,
      variables,
      // 全局请求头是本机配置，导入文件不带这项。
      headers: current.headers ?? [],
    };
    merged += 1;
  }
  return { environments, added, merged };
}

export interface ImportSummary {
  format: string;
  addedRequests: number;
  overwrittenRequests: number;
  duplicateIncoming: number;
  addedEnvironments: number;
  mergedEnvironments: number;
  warnings: string[];
}

export interface ImportPlacement {
  collections: Collection[];
  importedRequests: number;
  /** Incoming requests appended as brand-new rows. */
  addedRequests: number;
  /** Existing requests replaced by an incoming definition. */
  overwrittenRequests: number;
  /** Stable ids of overwritten rows, so the editor can refresh an open draft. */
  overwrittenRequestIds: string[];
  /** Incoming requests sharing an identity inside the same batch. */
  duplicateIncoming: number;
  /** Collection the requests landed in; null when no collection was written. */
  targetCollectionId: string | null;
  createdCollections: number;
}

/**
 * Apply a target to already-normalised imported collections.
 *
 * - an existing `collectionId` merges every incoming request into that
 *   collection (no new collection is created, environments are unaffected).
 *   Requests already present in the same target folder with the same
 *   method + URL are overwritten instead of being duplicated — this is what
 *   makes re-importing an updated spec behave sensibly;
 * - otherwise new collections are appended, preserving the parser's names
 *   unless the user supplied a replacement for a single collection. A brand
 *   new collection has no existing interfaces to collide with.
 *
 * Every supported format (Postman / Postman env / OpenAPI / HAR / cURL /
 * Insomnia) funnels through here, so the identity rule is identical for all.
 *
 * `makeId` is injected so tests stay deterministic. Neither input array nor
 * any of its items is mutated.
 */
export function placeImportedCollections(
  existing: Collection[],
  incoming: Collection[],
  target: ImportTarget | undefined,
  makeId: () => string,
): ImportPlacement {
  const withFolder = (item: RequestDraft): RequestDraft => {
    const folder = resolveImportFolder(target, item.folder ?? "");
    return folder === (item.folder ?? "") ? item : { ...item, folder };
  };

  const destination = target?.collectionId
    ? existing.find((collection) => collection.id === target.collectionId)
    : undefined;

  if (destination) {
    const imported = incoming.flatMap((collection) => collection.items.map(withFolder));
    if (imported.length === 0) {
      return {
        collections: existing,
        importedRequests: 0,
        addedRequests: 0,
        overwrittenRequests: 0,
        overwrittenRequestIds: [],
        duplicateIncoming: 0,
        targetCollectionId: destination.id,
        createdCollections: 0,
      };
    }
    const merged = mergeImportedRequests(destination.items ?? [], imported);
    return {
      collections: existing.map((collection) =>
        collection.id === destination.id
          ? { ...collection, items: merged.items }
          : collection,
      ),
      importedRequests: imported.length,
      addedRequests: merged.added,
      overwrittenRequests: merged.overwritten,
      overwrittenRequestIds: merged.overwrittenIds,
      duplicateIncoming: merged.duplicateIncoming,
      targetCollectionId: destination.id,
      createdCollections: 0,
    };
  }

  const override = target?.newCollectionName?.trim();
  const created: Collection[] = incoming.map((collection) => ({
    id: makeId(),
    name: incoming.length === 1 && override ? override : collection.name,
    items: collection.items.map(withFolder),
  }));
  const requestCount = created.reduce((sum, collection) => sum + collection.items.length, 0);
  let duplicateIncoming = 0;
  for (const collection of created) {
    const seen = new Set<string>();
    for (const item of collection.items) {
      const key = requestIdentityKey(item);
      if (key === null) continue;
      if (seen.has(key)) duplicateIncoming += 1;
      else seen.add(key);
    }
  }
  return {
    collections: [...existing, ...created],
    importedRequests: requestCount,
    addedRequests: requestCount,
    overwrittenRequests: 0,
    overwrittenRequestIds: [],
    duplicateIncoming,
    targetCollectionId: created[0]?.id ?? null,
    createdCollections: created.length,
  };
}
