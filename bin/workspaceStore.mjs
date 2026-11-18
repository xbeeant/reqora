// Reqora workspace store — the one place out-of-app processes read (and, when
// explicitly allowed, write) a project's data.
//
// The desktop app persists a project as a SQLite database (`workspace.db`,
// WAL) whose row model mirrors the cloud backend: every interface, case,
// scenario, suite and document is one `entity` row, plus local-only tables for
// history / trash / revisions and a small `meta` table. Older projects may
// still be split JSON (`manifest.json` + `<domain>.json`) or a single
// `workspace.json` — both stay readable so upgrading never loses data.
//
// `readSnapshot()` rebuilds the exact same snapshot object the WebView holds
// (same field mapping as `src-tauri/src/storage.rs::rebuild_snapshot`), so the
// CLI, the MCP server and the app all agree on what a request/case looks like.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

// Node 22 strips TypeScript types natively, so the shared row→snapshot mapper
// (also used by the WebView and the sync protocol) is imported directly. The
// out-of-app processes must rebuild the exact same snapshot the app holds.
import { rowsToSnapshot } from "../src/lib/workspaceRows.ts";
import { openAtRest, sealAtRest } from "./vault.mjs";

// Row kinds — keep in sync with storage.rs.
const KIND_FOLDER = "folder";
const KIND_REQUEST = "request";
const KIND_ENVIRONMENT = "environment";
const KIND_CASE = "case";
const KIND_SCENARIO = "scenario";
const KIND_SUITE = "suite";
const KIND_ARTIFACT = "artifact";
const KIND_DB_CONNECTION = "dbConnection";
const KIND_MCP_SERVER = "mcpServer";

/**
 * Entity kinds that may be soft-deleted: exactly the kinds that participate in
 * the sync row protocol and therefore produce a tombstone on rebuild (same set
 * as the `KINDS` export / `storage.rs::tombstone_kind`). Local-only kinds
 * (dbConnection / mcpServer) and unknown kinds are rejected so an arbitrary id
 * can no longer be tombstoned as an unrelated entity.
 */
const DELETABLE_KINDS = new Set([
  KIND_FOLDER,
  KIND_REQUEST,
  KIND_ENVIRONMENT,
  KIND_CASE,
  KIND_SCENARIO,
  KIND_SUITE,
  KIND_ARTIFACT,
]);

const DB_FILE = "workspace.db";

const ROOT_POINTER_FILE = "data_root.json";

/**
 * App-data directory shared with the Tauri app and the MCP logger.
 * The desktop resolves it as `~/.reqora` on every platform
 * (`src-tauri/src/lib.rs`, `src-tauri/src/app_config.rs`), so out-of-app
 * processes must use the same path or CLI/MCP writes land in a different
 * data root than the running app.
 */
export function appDataDir() {
  return join(homedir(), ".reqora");
}

/**
 * Resolve the data root recorded by the desktop "迁移数据目录" setting.
 * Mirrors `src-tauri/src/projects.rs::root_dir`: a non-empty `dataRoot`
 * pointer wins; missing / null / malformed pointer falls back to `base`.
 * A relative pointer is resolved against `base` so the CLI never operates
 * on a CWD-dependent location.
 */
export function resolveDataRoot(base = appDataDir()) {
  try {
    const raw = JSON.parse(readFileSync(join(base, ROOT_POINTER_FILE), "utf8"));
    const configured = typeof raw?.dataRoot === "string" ? raw.dataRoot.trim() : "";
    if (!configured) return base;
    return isAbsolute(configured) ? configured : resolve(base, configured);
  } catch {
    return base;
  }
}

/** Registry lives under the active data root, not necessarily appDataDir. */
export function registryPath() {
  return join(resolveDataRoot(), "projects.json");
}

/** Read the project registry (`projects.json`); tolerant of a missing file. */
export function readRegistry() {
  const file = registryPath();
  if (!file || !existsSync(file)) {
    return { version: 1, activeProjectId: "default", projects: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return {
      version: raw.version ?? 1,
      activeProjectId: raw.activeProjectId ?? "default",
      projects: Array.isArray(raw.projects) ? raw.projects : [],
    };
  } catch {
    return { version: 1, activeProjectId: "default", projects: [] };
  }
}

/** Every known project with its resolved data directory. */
export function listProjects() {
  const registry = readRegistry();
  const root = resolveDataRoot();
  const projects = registry.projects.map((project) => {
    const dataDirectory = project.directory || (root ? join(root, "projects", project.id) : null);
    return {
      id: project.id,
      name: project.name,
      directory: project.directory ?? null,
      dataDirectory,
      active: project.id === registry.activeProjectId,
      exists: Boolean(dataDirectory && existsSync(dataDirectory)),
    };
  });
  // A registry-less install still has the managed default project.
  if (projects.length === 0 && root) {
    const fallback = join(root, "projects", "default");
    projects.push({
      id: "default",
      name: "默认项目",
      directory: null,
      dataDirectory: fallback,
      active: true,
      exists: existsSync(fallback),
    });
  }
  return { activeProjectId: registry.activeProjectId, projects };
}

function describeDir(dir) {
  if (!existsSync(dir)) return null;
  try {
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  if (existsSync(join(dir, DB_FILE))) return { kind: "sqlite", dir };
  if (existsSync(join(dir, "workspace.json"))) return { kind: "json", dir };
  if (existsSync(join(dir, "manifest.json"))) return { kind: "split", dir };
  return null;
}

/**
 * Resolve which project to work on.
 *
 * Priority: explicit argument (a directory, a `workspace.json` path, a project
 * id, or a project name) → `REQORA_WORKSPACE` → the
 * app's active project.
 */
export function resolveWorkspace(explicit) {
  const requested = explicit || process.env.REQORA_WORKSPACE || "";
  const { projects } = listProjects();

  if (requested) {
    const asPath = isAbsolute(requested) || requested.startsWith(".") || requested.includes("/");
    if (asPath) {
      const full = resolve(requested);
      const found = describeDir(full) ?? (existsSync(full) ? { kind: "file", dir: dirname(full), file: full } : null);
      if (!found) throw new Error(`工作区目录不可用：${full}`);
      const project = projects.find((item) => item.dataDirectory === full);
      return { ...found, projectId: project?.id ?? null, projectName: project?.name ?? null, source: "path" };
    }
    const project =
      projects.find((item) => item.id === requested) ??
      projects.find((item) => item.name === requested);
    if (!project) {
      throw new Error(
        `找不到项目「${requested}」。可用项目：${projects.map((item) => item.id).join(", ") || "（无）"}`,
      );
    }
    const found = project.dataDirectory ? describeDir(project.dataDirectory) : null;
    if (!found) throw new Error(`项目「${project.name}」还没有数据目录：${project.dataDirectory ?? "（无）"}`);
    return {
      ...found,
      projectId: project.id,
      projectName: project.name,
      source: "project",
    };
  }

  const active = projects.find((item) => item.active) ?? projects[0];
  if (active?.dataDirectory) {
    const found = describeDir(active.dataDirectory);
    if (found) {
      return { ...found, projectId: active.id, projectName: active.name, source: "active" };
    }
  }
  const root = resolveDataRoot();
  throw new Error(
    `找不到工作区。已查找：${active?.dataDirectory ?? join(root, "projects", "default")}\n` +
      `可用 --workspace <目录|项目 id|workspace.json> 或 REQORA_WORKSPACE 指定。`,
  );
}

function readJsonFile(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Legacy split JSON: `manifest.json` lists the domain keys. */
function readSplitWorkspace(dir) {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = readJsonFile(manifestPath);
  const snapshot = {};
  for (const key of manifest.keys ?? []) {
    const file = join(dir, `${key}.json`);
    if (existsSync(file)) snapshot[key] = readJsonFile(file);
  }
  return snapshot;
}

function readSimpleTable(db, table, orderColumn) {
  const rows = db.prepare(`SELECT data FROM ${table} ORDER BY ${orderColumn}, id`).all();
  return rows.map((row) => JSON.parse(row.data));
}

function readMeta(db) {
  const meta = {};
  for (const row of db.prepare("SELECT key, value FROM meta").all()) {
    try {
      meta[row.key] = JSON.parse(row.value);
    } catch (error) {
      // Some legacy keys store a plain (non-JSON) string, e.g. the one-time
      // import flag; keep those verbatim. But a corrupt value in a structured
      // key would otherwise be spread into the snapshot as a bogus object
      // (e.g. characters of a settings string), so surface it instead of
      // silently degrading the snapshot.
      if (["settings", "seeded", "activeEnvironmentId", "theme"].includes(row.key)) {
        throw new Error(`meta 项「${row.key}」不是合法 JSON：${error.message}`);
      }
      meta[row.key] = row.value;
    }
  }
  return meta;
}

function readRevisions(db) {
  const grouped = {};
  const rows = db
    .prepare("SELECT request_id, data FROM request_revision ORDER BY request_id, at, id")
    .all();
  for (const row of rows) {
    (grouped[row.request_id] ??= []).push(JSON.parse(row.data));
  }
  return Object.keys(grouped).length ? grouped : null;
}

/**
 * Decode an entity's JSON `data` column.
 *
 * The Rust side (`storage.rs::parse_data`) propagates a parse error instead of
 * substituting an empty object. Returning `{}` here was dangerous: any later
 * write-back of the snapshot would persist the empty object over the real
 * payload and silently lose data. Corrupt rows are therefore surfaced with the
 * row id/kind so they can be repaired rather than quietly dropped. `data` is
 * contractually a JSON object; a valid JSON value of another shape is treated
 * as corrupt for the same reason.
 *
 * An empty/absent column is legitimate (e.g. folders carry no data) → `{}`.
 */
function parseData(raw, row) {
  if (raw === null || raw === undefined || raw === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `entity 行 data 列不是合法 JSON（id=${row?.id ?? "?"}, kind=${row?.kind ?? "?"}）：${error.message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `entity 行 data 列应为 JSON 对象（id=${row?.id ?? "?"}, kind=${row?.kind ?? "?"}）`,
    );
  }
  return parsed;
}

/** Folder auth is a JSON-encoded AuthSpec; an unreadable value degrades to none. */
function parseFolderAuth(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Sub-kinds of `artifact` rows that participate in the sync row protocol. */
const ARTIFACT_SUB_KINDS = new Set(["docPage", "dataModel", "scriptSnippet", "codeTemplate"]);

/**
 * Adapt raw `entity` rows into the shared `WorkspaceRowsPayload` consumed by
 * `rowsToSnapshot` (src/lib/workspaceRows.ts), plus the two local-only domains
 * (dbConnections / mcpServers) that are deliberately NOT part of the sync row
 * protocol (see the workspaceRows.ts header comment).
 *
 * The column → field mapping stays identical to the desktop app's
 * `src-tauri/src/storage.rs::rebuild_snapshot` (and to the old
 * `snapshotFromRows` that used to live here):
 *   - every item takes id / name / updatedAt from its columns; the remaining
 *     structure comes from the JSON `data` payload;
 *   - request: folder=folder_path, method (default "GET"), url (default ""),
 *     protocol (default "http"), grouped under parent_id (its collection);
 *   - case: requestId=parent_id, group=case_group (default "其他"), enabled;
 *   - artifact: sub_kind selects docPage / dataModel / scriptSnippet /
 *     codeTemplate; docPage uses title=name;
 *   - deleted rows become tombstones and never reach the live snapshot
 *     objects. Tombstone kind mapping, position sorting, tombstones and default
 *     settings all come from rowsToSnapshot — there is no second copy here.
 * Keep `KIND_*` and this mapping in sync with storage.rs.
 *
 * `rows` must already be in `ORDER BY kind, position, id` order (the app's
 * save order): each per-domain array keeps that order, so rowsToSnapshot's
 * stable position sort reproduces the exact collection/item ordering.
 */
export function entityRowsToPayload(rows) {
  const payload = {
    folders: [],
    requests: [],
    environments: [],
    cases: [],
    scenarios: [],
    suites: [],
    artifacts: [],
  };
  const local = { dbConnections: [], mcpServers: [] };

  for (const row of rows) {
    const deleted = Boolean(row.deleted);
    // Deleted rows are tombstones only: like storage.rs, their data payload is
    // never decoded (a stale/corrupt payload on a tombstone must not break a
    // read). rowsToSnapshot turns the `deleted` flag into the tombstone.
    const data = deleted ? {} : parseData(row.data, row);
    const common = {
      id: row.id,
      name: row.name,
      updatedAt: row.updated_at,
      position: row.position ?? 0,
      deleted,
    };

    switch (row.kind) {
      case KIND_FOLDER:
        payload.folders.push({ ...common, auth: parseFolderAuth(row.auth) });
        break;
      case KIND_REQUEST:
        payload.requests.push({
          ...common,
          folderId: row.parent_id ?? "",
          folderPath: row.folder_path ?? "",
          method: row.method || "GET",
          url: row.url ?? "",
          protocol: row.protocol || "http",
          data,
        });
        break;
      case KIND_ENVIRONMENT:
        payload.environments.push({ ...common, data });
        break;
      case KIND_CASE:
        payload.cases.push({
          ...common,
          requestId: row.parent_id ?? "",
          caseGroup: row.case_group || "其他",
          enabled: Boolean(row.enabled),
          data,
        });
        break;
      case KIND_SCENARIO:
        payload.scenarios.push({ ...common, data });
        break;
      case KIND_SUITE:
        payload.suites.push({ ...common, data });
        break;
      case KIND_ARTIFACT:
        if (ARTIFACT_SUB_KINDS.has(row.sub_kind)) {
          payload.artifacts.push({
            ...common,
            kind: row.sub_kind,
            // rowsToSnapshot's artifact branch rebuilds the item by spreading
            // `data` and only reads id/name from the row — it does not stamp
            // `updatedAt`. storage.rs::rebuild_snapshot stamps updatedAt on
            // every item, so carry it inside `data` here to keep the CLI
            // snapshot field-for-field identical to the desktop app.
            data: { ...data, updatedAt: row.updated_at },
          });
        }
        break;
      case KIND_DB_CONNECTION:
        if (!deleted) {
          local.dbConnections.push({ ...data, id: row.id, name: row.name, updatedAt: row.updated_at });
        }
        break;
      case KIND_MCP_SERVER:
        if (!deleted) {
          local.mcpServers.push({ ...data, id: row.id, name: row.name, updatedAt: row.updated_at });
        }
        break;
      default:
        break;
    }
  }

  return { payload, local };
}

/**
 * Rebuild the full snapshot for a SQLite project.
 *
 * Shared domains come from rowsToSnapshot (single source of truth for the
 * row→snapshot mapping). The local-only domains — history / trash / revisions /
 * theme / dbConnections / mcpServers, which workspaceRows.ts explicitly keeps
 * out of the sync protocol — are supplied as the `base` that rowsToSnapshot
 * merges into. readMeta / readRevisions / readSimpleTable are CLI-local reads
 * kept here on purpose.
 */
function snapshotFromDb(db) {
  const rows = db
    .prepare(
      "SELECT id, kind, parent_id, folder_path, name, method, url, protocol, auth, enabled," +
        " case_group, sub_kind, updated_at, deleted, position, data" +
        " FROM entity ORDER BY kind, position, id",
    )
    .all();
  const { payload, local } = entityRowsToPayload(rows);
  const meta = readMeta(db);

  const base = {
    version: 1,
    seeded: meta.seeded ?? false,
    activeEnvironmentId: meta.activeEnvironmentId ?? null,
    history: readSimpleTable(db, "history", "at"),
    trash: readSimpleTable(db, "trash", "deleted_at"),
    settings: meta.settings ?? { timeoutSecs: 30, followRedirects: true, verifyTls: true },
    ...local,
  };
  if (meta.theme !== undefined && meta.theme !== null) base.theme = meta.theme;
  const revisions = readRevisions(db);
  if (revisions) base.revisions = revisions;

  // payload.meta is intentionally left undefined: seeded / activeEnvironmentId
  // / settings above already come from readMeta, so rowsToSnapshot keeps the
  // base values instead of overriding them.
  return rowsToSnapshot(payload, base);
}

/** Keys persisted as their own columns, so they never live inside `data`. */
const REQUEST_COLUMNS = ["id", "folder", "name", "method", "url", "protocol", "updatedAt"];
const CASE_COLUMNS = ["id", "requestId", "group", "name", "enabled", "updatedAt"];

function omitKeys(value, keys) {
  const out = {};
  for (const [key, item] of Object.entries(value ?? {})) {
    if (!keys.includes(key)) out[key] = item;
  }
  return out;
}

/**
 * One project's data. Reads are always available; `write()` throws unless the
 * caller opted in (`allowWrite`), because the desktop app keeps the whole
 * snapshot in memory and would overwrite outside edits on its next save.
 */
export class WorkspaceStore {
  constructor(target, { allowWrite = false } = {}) {
    this.target = target;
    this.allowWrite = allowWrite;
    this.dir = target.dir;
    this.kind = target.kind;
    this.db = null;
  }

  static open(explicitPath, options) {
    return new WorkspaceStore(resolveWorkspace(explicitPath), options);
  }

  get path() {
    return this.dir;
  }

  get projectId() {
    return this.target.projectId ?? null;
  }

  get projectName() {
    return this.target.projectName ?? null;
  }

  /**
   * Open the SQLite handle.
   *
   * Read-only processes (the default for the MCP server) MUST NOT hold a write
   * handle: a read-write connection may trigger WAL recovery / journal_mode
   * writes on open, which both mutates the project file behind the desktop
   * app's back and lets an accidental write slip through. `readOnly: true`
   * keeps every write — including PRAGMA journal_mode=WAL — blocked at the
   * SQLite level. Only a store explicitly constructed with `allowWrite` gets
   * a read-write handle (and #assertWritable gates all mutations anyway).
   */
  async #openDb() {
    if (this.kind !== "sqlite") throw new Error("当前工作区不是 SQLite 格式，无法写入");
    if (this.db) return this.db;
    let sqlite;
    try {
      sqlite = await import("node:sqlite");
    } catch {
      throw new Error("当前 Node 不支持 node:sqlite（需要 Node 22.5+）");
    }
    this.db = new sqlite.DatabaseSync(join(this.dir, DB_FILE), {
      readOnly: !this.allowWrite,
    });
    try {
      // Connection-local timeout, not a database write — safe in read-only
      // mode and avoids "database is locked" while the app saves.
      this.db.exec("PRAGMA busy_timeout = 5000");
    } catch {
      // older Node builds may not accept PRAGMA here; harmless
    }
    return this.db;
  }

  close() {
    try {
      this.db?.close();
    } catch {
      // ignore
    }
    this.db = null;
  }

  /** Read the full snapshot (normalized, exactly like the app sees it). */
  async readSnapshot() {
    let raw;
    if (this.kind === "sqlite") {
      const db = await this.#openDb();
      raw = snapshotFromDb(db);
    } else if (this.kind === "split") {
      raw = readSplitWorkspace(this.dir);
      if (!raw && existsSync(join(this.dir, "workspace.json"))) {
        raw = readJsonFile(join(this.dir, "workspace.json"));
      }
    } else if (this.kind === "json") {
      raw = readJsonFile(join(this.dir, "workspace.json"));
    } else if (this.kind === "file") {
      raw = readJsonFile(this.target.file);
    }
    if (!raw) throw new Error(`工作区中没有可读取的数据：${this.dir}`);
    // The desktop app seals credential-shaped values before writing SQLite.
    // Open them here so CLI / MCP keep seeing the same plaintext snapshot the
    // WebView holds; their own outbound masking then applies as before.
    const { normalizeSnapshot } = await import("../src/lib/defaults.ts");
    return normalizeSnapshot(openAtRest(raw));
  }

  async #assertWritable() {
    if (!this.allowWrite) {
      throw new Error(
        "写入未开启：MCP 服务需要以 --allow-write（或 REQORA_MCP_ALLOW_WRITE=1）启动才能修改项目数据",
      );
    }
    return this.#openDb();
  }

  /** Shared optimistic-lock counter (workspace_rev, created by the desktop's
   * Rust store). A missing table means a legacy / test database: report 0 and
   * never let the version check break a legitimate write. Plain SELECT, so it
   * is also safe on the default read-only connection. */
  async readRev() {
    if (this.kind !== "sqlite") return { rev: 0, writer: "init", updatedAt: 0 };
    try {
      const db = await this.#openDb();
      const row = db
        .prepare("SELECT rev, writer, updated_at FROM workspace_rev WHERE id = 1")
        .get();
      return row
        ? {
            rev: Number(row.rev ?? 0),
            writer: String(row.writer ?? "init"),
            updatedAt: Number(row.updated_at ?? 0),
          }
        : { rev: 0, writer: "init", updatedAt: 0 };
    } catch {
      return { rev: 0, writer: "init", updatedAt: 0 };
    }
  }

  /** Bump the counter in the SAME transaction as the row write. The desktop
   * passes the revision it loaded as `expectedRev`; if we moved it, its next
   * auto-save is rejected with WORKSPACE_CONFLICT instead of silently
   * overwriting this change. */
  #bumpRev(db, writer) {
    try {
      db.prepare(
        "UPDATE workspace_rev SET rev = rev + 1, writer = ?, updated_at = ? WHERE id = 1",
      ).run(writer, Date.now());
    } catch {
      // No workspace_rev table (legacy / hand-built test DB). The Rust store
      // creates it on open; out-of-process writes must still succeed.
    }
  }

  /** Run a row mutation and the revision bump atomically where possible. */
  #writeWithRev(db, statement, params) {
    let ownsTransaction = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      ownsTransaction = true;
    } catch {
      // Already inside a caller transaction, or an older node:sqlite build.
    }
    try {
      statement.run(...params);
      this.#bumpRev(db, "mcp");
      if (ownsTransaction) db.exec("COMMIT");
    } catch (error) {
      if (ownsTransaction) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Ignore a rollback failure; the original error is more useful.
        }
      }
      throw error;
    }
  }

  /** Next sort position for a kind/parent pair (appends to the end). */
  async nextPosition(kind, parentId = "") {
    const db = await this.#openDb();
    const row = db
      .prepare(
        "SELECT COALESCE(MAX(position) + 1, 0) AS next FROM entity" +
          " WHERE kind = ? AND COALESCE(parent_id, '') = ? AND deleted = 0",
      )
      .get(kind, parentId ?? "");
    return Number(row?.next ?? 0);
  }

  /** Keep an updated row where it was; only new rows get a fresh position. */
  async positionFor(kind, id, parentId = "") {
    if (id) {
      const db = await this.#openDb();
      const row = db.prepare("SELECT position FROM entity WHERE id = ?").get(id);
      if (row) return Number(row.position ?? 0);
    }
    return this.nextPosition(kind, parentId);
  }

  async #upsert(record) {
    const db = await this.#openDb();
    // Field-level sealing must happen on every out-of-app write too, otherwise
    // a CLI/MCP edit would put a credential back into SQLite as plaintext.
    const data = sealAtRest(record.data ?? {});
    const auth = record.auth ? sealAtRest(record.auth) : null;
    const statement = db.prepare(
      `INSERT INTO entity (id, kind, parent_id, folder_path, name, method, url, protocol, auth,
         position, enabled, case_group, sub_kind, updated_at, deleted, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind, parent_id = excluded.parent_id, folder_path = excluded.folder_path,
         name = excluded.name, method = excluded.method, url = excluded.url,
         protocol = excluded.protocol, auth = excluded.auth, position = excluded.position,
         enabled = excluded.enabled, case_group = excluded.case_group,
         sub_kind = excluded.sub_kind, updated_at = excluded.updated_at,
         deleted = excluded.deleted, data = excluded.data`,
    );
    this.#writeWithRev(db, statement, [
      record.id,
      record.kind,
      record.parentId ?? null,
      record.folderPath ?? "",
      record.name ?? "",
      record.method ?? null,
      record.url ?? null,
      record.protocol ?? null,
      auth ? JSON.stringify(auth) : null,
      record.position ?? 0,
      record.enabled === false ? 0 : 1,
      record.caseGroup ?? null,
      record.subKind ?? null,
      record.updatedAt ?? Date.now(),
      record.deleted ? 1 : 0,
      JSON.stringify(data),
    ]);
  }

  /** Insert or replace one interface inside a collection. */
  async putRequest(collectionId, request) {
    await this.#assertWritable();
    const position =
      typeof request.__position === "number"
        ? request.__position
        : await this.positionFor(KIND_REQUEST, request.id, collectionId);
    await this.#upsert({
      kind: KIND_REQUEST,
      id: request.id,
      name: request.name,
      updatedAt: request.updatedAt ?? Date.now(),
      parentId: collectionId,
      folderPath: request.folder ?? "",
      method: request.method ?? "GET",
      url: request.url ?? "",
      protocol: request.protocol ?? "http",
      position,
      data: omitKeys(request, [...REQUEST_COLUMNS, "__position"]),
    });
    return position;
  }

  async putCollection(collection) {
    await this.#assertWritable();
    await this.#upsert({
      kind: KIND_FOLDER,
      id: collection.id,
      name: collection.name,
      updatedAt: collection.updatedAt ?? Date.now(),
      auth: collection.auth ?? null,
      position: await this.positionFor(KIND_FOLDER, collection.id),
      data: {},
    });
  }

  async putCase(caseItem) {
    await this.#assertWritable();
    await this.#upsert({
      kind: KIND_CASE,
      id: caseItem.id,
      name: caseItem.name,
      updatedAt: caseItem.updatedAt ?? Date.now(),
      parentId: caseItem.requestId,
      caseGroup: caseItem.group ?? "其他",
      enabled: caseItem.enabled !== false,
      position: await this.positionFor(KIND_CASE, caseItem.id),
      data: omitKeys(caseItem, CASE_COLUMNS),
    });
  }

  async putScenario(scenario) {
    await this.#assertWritable();
    await this.#upsert({
      kind: KIND_SCENARIO,
      id: scenario.id,
      name: scenario.name,
      updatedAt: scenario.updatedAt ?? Date.now(),
      position: await this.positionFor(KIND_SCENARIO, scenario.id),
      data: omitKeys(scenario, ["id", "name", "updatedAt"]),
    });
  }

  async putSuite(suite) {
    await this.#assertWritable();
    await this.#upsert({
      kind: KIND_SUITE,
      id: suite.id,
      name: suite.name,
      updatedAt: suite.updatedAt ?? Date.now(),
      position: await this.positionFor(KIND_SUITE, suite.id),
      data: omitKeys(suite, ["id", "name", "updatedAt"]),
    });
  }

  /** Soft delete: the row becomes a tombstone so sync propagates the removal. */
  async deleteEntity(id) {
    await this.#assertWritable();
    const db = await this.#openDb();
    const existing = db.prepare("SELECT kind FROM entity WHERE id = ?").get(id);
    if (!existing) return false;
    if (!DELETABLE_KINDS.has(existing.kind)) {
      throw new Error(`不允许删除实体类型「${existing.kind}」（id=${id}）：仅同步协议内的实体可被软删`);
    }
    this.#writeWithRev(
      db,
      db.prepare("UPDATE entity SET deleted = 1, updated_at = ? WHERE id = ?"),
      [Date.now(), id],
    );
    return true;
  }
}

export const KINDS = {
  FOLDER: KIND_FOLDER,
  REQUEST: KIND_REQUEST,
  ENVIRONMENT: KIND_ENVIRONMENT,
  CASE: KIND_CASE,
  SCENARIO: KIND_SCENARIO,
  SUITE: KIND_SUITE,
  ARTIFACT: KIND_ARTIFACT,
};
