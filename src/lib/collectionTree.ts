import type { Collection, RequestDraft } from "../types.ts";

/**
 * Pure operations on the collection tree.
 *
 * The hierarchy is NOT nested: `Collection.items` is a flat ordered array and
 * `RequestDraft.folder` holds a `"父/子"` path. So the visible order of
 * requests inside a folder IS their array index, and moving an item means
 * removing it and splicing it back at the right index (possibly in another
 * collection). Keeping this in a pure module lets `node --test` cover the
 * tricky index maths without mounting React / zustand.
 */

export interface RequestRef {
  collectionId: string;
  requestId: string;
}

export interface DropTarget {
  collectionId: string;
  /** Folder path to assign; "" means the collection root. */
  folder: string;
  /** Insert immediately BEFORE this request id (row's upper half). */
  beforeId?: string | null;
  /** Insert immediately AFTER this request id (row's lower half). */
  afterId?: string | null;
}

const folderOf = (item: RequestDraft): string => (item.folder ?? "").trim();

function isUnderFolder(folder: string, path: string): boolean {
  return folder === path || folder.startsWith(`${path}/`);
}

/** 规范化文件夹路径：逐段去空白、丢弃空段，返回 "a/b/c" 或 ""。 */
function normalizePath(input: string): string {
  return (input ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
}

/** 显式登记的空文件夹列表（Collection.folders）。 */
const explicitFoldersOf = (collection: Collection): string[] => collection.folders ?? [];

/** 把路径及其全部祖先加入显式文件夹列表（去重，其余保持原顺序）。 */
function withFolderAdded(folders: string[], path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  const set = new Set(folders);
  let prefix = "";
  for (const segment of segments) {
    prefix = prefix ? `${prefix}/${segment}` : segment;
    set.add(prefix);
  }
  return [...set];
}

/** 重命名显式文件夹列表里的 from → to（级联到全部子孙路径）。 */
function withFolderRenamed(folders: string[], from: string, to: string): string[] | null {
  let changed = false;
  const next = folders.map((folder) => {
    if (folder === from) {
      changed = true;
      return to;
    }
    if (folder.startsWith(`${from}/`)) {
      changed = true;
      return `${to}${folder.slice(from.length)}`;
    }
    return folder;
  });
  return changed ? next : null;
}

/** True when every item is the very same object in the very same slot. */
function unchanged(before: Collection[], after: Collection[]): boolean {
  return before.every(
    (collection, index) =>
      collection.items.length === after[index].items.length &&
      collection.items.every((item, itemIndex) => item === after[index].items[itemIndex]),
  );
}

/**
 * Move one request to a drop target: changes folder, collection AND order.
 * `beforeId` / `afterId` refer to rows in the target collection; if neither
 * resolves (e.g. the folder is empty) the request is appended after the last
 * request of that folder, or at the end of the collection.
 */
export function moveRequestInTree(
  collections: Collection[],
  source: RequestRef,
  target: DropTarget,
): Collection[] {
  const sourceCollection = collections.find((item) => item.id === source.collectionId);
  const request = sourceCollection?.items.find((item) => item.id === source.requestId);
  if (!request || !collections.some((item) => item.id === target.collectionId)) return collections;

  const folder = target.folder.trim();
  // Only add the `folder` key when it actually changes: a redundant field
  // would show up as a fake diff in collaboration-space snapshots.
  const moved: RequestDraft =
    folderOf(request) === folder ? request : { ...request, folder };

  const next = collections.map((collection) => {
    const remaining = collection.items.filter((item) => item.id !== source.requestId);
    if (collection.id !== target.collectionId) {
      return remaining.length === collection.items.length
        ? collection
        : { ...collection, items: remaining };
    }

    let at = -1;
    if (target.beforeId) at = remaining.findIndex((item) => item.id === target.beforeId);
    if (at < 0 && target.afterId) {
      const anchor = remaining.findIndex((item) => item.id === target.afterId);
      if (anchor >= 0) at = anchor + 1;
    }
    if (at < 0) {
      let last = -1;
      for (let index = 0; index < remaining.length; index += 1) {
        if (folderOf(remaining[index]) === folder) last = index;
      }
      at = last >= 0 ? last + 1 : remaining.length;
    }

    const items = [...remaining];
    items.splice(at, 0, moved);
    return { ...collection, items };
  });

  return unchanged(collections, next) ? collections : next;
}

/** Rename a request without touching `updatedAt` (cases must stay in sync). */
export function renameRequestInTree(
  collections: Collection[],
  requestId: string,
  name: string,
): Collection[] {
  const trimmed = name.trim();
  if (!trimmed) return collections;
  let changed = false;
  const next = collections.map((collection) => ({
    ...collection,
    items: collection.items.map((item) => {
      if (item.id !== requestId || item.name === trimmed) return item;
      changed = true;
      return { ...item, name: trimmed };
    }),
  }));
  return changed ? next : collections;
}

/** Rename a folder path, cascading to every nested sub-folder ("a" -> "b"). */
export function renameFolderInTree(
  collections: Collection[],
  collectionId: string,
  from: string,
  to: string,
): Collection[] {
  const source = from.trim();
  const destination = to.trim();
  // A folder cannot become its own descendant.
  if (!source || !destination || source === destination || destination.startsWith(`${source}/`)) {
    return collections;
  }
  const collection = collections.find((item) => item.id === collectionId);
  if (!collection) return collections;
  let changed = false;
  const items = collection.items.map((item) => {
    const folder = folderOf(item);
    let updated: string | null = null;
    if (folder === source) updated = destination;
    else if (folder.startsWith(`${source}/`)) {
      updated = `${destination}${folder.slice(source.length)}`;
    }
    if (updated === null || updated === item.folder) return item;
    changed = true;
    return { ...item, folder: updated };
  });
  // 显式登记的空文件夹同步改名。
  const explicit = withFolderRenamed(explicitFoldersOf(collection), source, destination);
  if (explicit) changed = true;
  return changed
    ? collections.map((item) =>
        item.id === collectionId
          ? { ...item, items, ...(explicit ? { folders: explicit } : {}) }
          : item,
      )
    : collections;
}

/**
 * 显式新建一个（可能为空的）文件夹：路径与全部祖先加入 `Collection.folders`。
 * 文件夹本身由请求的 folder 路径派生，这里只登记「尚无接口的空文件夹」；
 * 已存在的路径是幂等 no-op。路径为空 / 集合不存在时原样返回。
 */
export function createFolderInTree(
  collections: Collection[],
  collectionId: string,
  path: string,
): Collection[] {
  const normalized = normalizePath(path);
  const collection = collections.find((item) => item.id === collectionId);
  if (!normalized || !collection) return collections;
  if (explicitFoldersOf(collection).includes(normalized)) return collections;
  const folders = withFolderAdded(explicitFoldersOf(collection), normalized);
  return collections.map((item) => (item.id === collectionId ? { ...item, folders } : item));
}

/**
 * 删除文件夹：从显式列表移除该路径及全部子孙，其中的请求上移到被删文件夹
 * 的父文件夹（根文件夹的请求回到集合根目录）——删除文件夹不丢接口。
 */
export function deleteFolderInTree(
  collections: Collection[],
  collectionId: string,
  path: string,
): Collection[] {
  const source = normalizePath(path);
  const collection = collections.find((item) => item.id === collectionId);
  if (!source || !collection) return collections;
  const parent = source.split("/").slice(0, -1).join("/");
  let changed = explicitFoldersOf(collection).some((folder) => isUnderFolder(folder, source));
  const items = collection.items.map((item) => {
    const folder = folderOf(item);
    if (!isUnderFolder(folder, source)) return item;
    changed = true;
    const moved = folder === source ? parent : `${parent}${folder.slice(source.length)}`;
    return moved === item.folder ? item : { ...item, folder: moved };
  });
  if (!changed) return collections;
  const folders = explicitFoldersOf(collection).filter((folder) => !isUnderFolder(folder, source));
  return collections.map((item) =>
    item.id === collectionId ? { ...item, items, folders } : item,
  );
}

/**
 * Move a whole folder (with all its requests and sub-folders) into another
 * folder / collection. The folder keeps its own name; dropping on a root
 * promotes it to a top-level folder.
 */
export function moveFolderInTree(
  collections: Collection[],
  source: { collectionId: string; path: string },
  target: { collectionId: string; folder: string },
): Collection[] {
  const from = source.path.trim();
  const parent = target.folder.trim();
  const name = from.split("/").filter(Boolean).pop();
  if (!from || !name) return collections;
  const to = parent ? `${parent}/${name}` : name;
  if (to === from || to.startsWith(`${from}/`)) return collections;
  if (!collections.some((item) => item.id === target.collectionId)) return collections;

  if (source.collectionId === target.collectionId) {
    return renameFolderInTree(collections, source.collectionId, from, to);
  }

  const sourceCollection = collections.find((item) => item.id === source.collectionId);
  if (!sourceCollection) return collections;
  const moved = sourceCollection.items
    .filter((item) => isUnderFolder(folderOf(item), from))
    .map((item) => ({ ...item, folder: `${to}${folderOf(item).slice(from.length)}` }));
  // 显式登记的空文件夹跟随移动（含全部子孙路径）。
  const movedExplicit = explicitFoldersOf(sourceCollection).filter((folder) =>
    isUnderFolder(folder, from),
  );
  if (moved.length === 0 && movedExplicit.length === 0) return collections;
  const ids = new Set(moved.map((item) => item.id));
  const targetCollection = collections.find((item) => item.id === target.collectionId);
  const movedExplicitFull = movedExplicit.map(
    (folder) => `${to}${folder.slice(from.length)}`,
  );
  const targetFolders = movedExplicitFull.reduce(
    (acc, folder) => withFolderAdded(acc, folder),
    targetCollection ? explicitFoldersOf(targetCollection) : [],
  );
  return collections.map((collection) => {
    if (collection.id === source.collectionId) {
      return {
        ...collection,
        items: collection.items.filter((item) => !ids.has(item.id)),
        folders: explicitFoldersOf(collection).filter(
          (folder) => !isUnderFolder(folder, from),
        ),
      };
    }
    if (collection.id === target.collectionId && movedExplicitFull.length > 0) {
      return {
        ...collection,
        items: [...collection.items, ...moved],
        folders: targetFolders,
      };
    }
    if (collection.id === target.collectionId) {
      return { ...collection, items: [...collection.items, ...moved] };
    }
    return collection;
  });
}
