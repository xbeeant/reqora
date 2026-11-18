/**
 * Unified, machine-local application configuration.
 *
 * Consolidates the "config layer" that used to be a handful of unrelated
 * `localStorage` keys (collaboration server address, doc-site base, MCP-expose
 * options, side-view / layout prefs) into a single document at
 * `~/.reqora/config.json` on desktop, with a `localStorage` mirror as the
 * browser / test fallback.
 *
 * Why a file instead of WebView storage:
 *  - It survives clearing the WebView cache / rebuilding the data directory
 *    (the exact failure that used to silently drop the collaboration server
 *    address — see the `example.com` incident).
 *  - It can be backed up / migrated together with the rest of `~/.reqora`.
 *
 * Secrets (token pairs, local-vault values) are deliberately NOT stored here.
 * They stay encrypted at rest in the WebView's storage, exactly as before.
 *
 * Persistence model (mirrors `syncStateStore`):
 *  - Desktop: primary store is the on-disk config file, read/written through
 *    the `load_app_config` / `save_app_config` IPC commands. If IPC is
 *    unavailable (headless tests) it degrades to a `localStorage` mirror.
 *  - Browser / Node: the `localStorage` mirror is the only store.
 *
 * A single serial queue guards every write so concurrent updates from
 * different modules (cloud connection vs. MCP-expose) cannot clobber each
 * other. All access goes through this module — no other file should read or
 * write the raw config document.
 */

import type { CloudUser } from "./cloud.ts";
import type { CloudProjectRef, CloudImportRecord } from "./cloudConnection.ts";
import { api } from "./api.ts";

const VERSION = 1;

/** Only ever holds non-secret fields; the token pair stays in WebView storage. */
export interface CollabConfig {
  baseUrl: string;
  user: CloudUser | null;
  projects: Record<string, CloudProjectRef>;
  lastImport: CloudImportRecord | null;
  lastImportError: string | null;
}

export interface McpExposeConfig {
  command?: string;
  args?: string;
  allowWrite?: boolean;
  revealSecrets?: boolean;
  environment?: string;
  client?: string;
}

/** 数据同步通道：本地（不同步）/ 自托管服务端协作 / Git-native 双向文件。 */
export type SyncMode = "local" | "server" | "git";

/** 按本地项目 id 记忆的同步通道配置（不含任何凭据）。 */
export interface SyncModeConfig {
  mode: SyncMode;
  /** Git-native 的工作目录（用户用目录选择器挑选，非任意路径输入）。 */
  gitDir?: string;
  /** 自动同步心跳是否允许 git pull；commit/push 永远由用户显式触发。 */
  gitAutoPull?: boolean;
  /** 上次带数据转换的目标通道，供设置页展示。 */
  convertedFrom?: SyncMode;
}

export interface AppConfig {
  version: number;
  collab?: CollabConfig;
  docSiteBase?: string;
  mcpExpose?: McpExposeConfig;
  /** 每个本地项目选择的同步通道；缺省 = server（兼容既有协作行为）。 */
  syncModes?: Record<string, SyncModeConfig>;
  /** Side rail selection in the main window. */
  sideView?: string;
  /** Request detail editor/response arrangement. */
  layout?: string;
}

/** Single on-disk / mirror document, plus a couple of legacy key names. */
const STORAGE_KEY = "reqora.appConfig.v1";
const LEGACY_COLLAB_KEY = "reqora.cloudConnection.v1";
const LEGACY_DOCSITE_KEY = "reqora.docSiteBase";
const LEGACY_SIDEVIEW_KEY = "reqora.sideView";
const LEGACY_LAYOUT_KEY = "reqora.layout";
const LEGACY_MCP_KEYS = [
  "reqora.mcp.expose.command",
  "reqora.mcp.expose.args",
  "reqora.mcp.expose.write",
  "reqora.mcp.expose.secrets",
  "reqora.mcp.expose.env",
  "reqora.mcp.expose.client",
];

function defaultCollab(): CollabConfig {
  return {
    baseUrl: "",
    user: null,
    projects: {},
    lastImport: null,
    lastImportError: null,
  };
}

function isDesktop(): boolean {
  return typeof globalThis !== "undefined" && "__TAURI_INTERNALS__" in globalThis;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function safeParse(raw: string | null): AppConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as AppConfig;
    }
  } catch {
    /* corrupt payload: treat as absent */
  }
  return null;
}

// ---------------------------------------------------------------------------
// In-memory cache + single-flight load
// ---------------------------------------------------------------------------

let cache: AppConfig = { version: VERSION };
let loaded = false;
let loadPromise: Promise<void> | null = null;

/** Serialised write queue — all mutations go through `update`. */
let tail: Promise<unknown> = Promise.resolve();
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.then(work, work);
  tail = result.catch(() => undefined);
  return result;
}

async function readRaw(): Promise<AppConfig> {
  if (isDesktop()) {
    try {
      const raw = await api.loadAppConfig();
      if (typeof raw === "string" && raw) {
        const parsed = safeParse(raw);
        if (parsed) return parsed;
      }
    } catch {
      // Fall through to the localStorage mirror below.
    }
  }
  return readLocalMirror();
}

function readLocalMirror(): AppConfig {
  return safeParse(storage()?.getItem(STORAGE_KEY) ?? "") ?? { version: VERSION };
}

async function writeRaw(config: AppConfig): Promise<void> {
  if (isDesktop()) {
    try {
      await api.saveAppConfig(JSON.stringify(config));
      return;
    } catch {
      // IPC unavailable (headless): keep the localStorage mirror in sync.
    }
  }
  const store = storage();
  if (store) {
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      // Quota / privacy mode: persistence is best effort.
    }
  }
}

/**
 * Fold the old per-feature `localStorage` keys into the unified document, then
 * delete them so each value lives in exactly one place. Runs once at load;
 * idempotent across restarts because the legacy keys are removed on first run.
 */
function migrateLegacy(base: AppConfig): boolean {
  const store = storage();
  if (!store) return false;
  let changed = false;

  // 旧键存在即视为「尚未迁移完成」，无论统一配置里是否已有 collab（重置 /
  // 默认值也会写入一个空 collab）。合并语义：统一配置里已有的真实数据优先，
  // 旧键只补空位——迁移幂等，且绝不会把用户已在新版改过的值回退成旧值。
  const legacyCollab = safeParse(store.getItem(LEGACY_COLLAB_KEY));
  if (legacyCollab && typeof legacyCollab === "object") {
    const l = legacyCollab as unknown as Record<string, unknown>;
    const legacyProjects: Record<string, CloudProjectRef> = {};
    const rawProjects = l.projects as Record<string, CloudProjectRef> | undefined;
    if (rawProjects && typeof rawProjects === "object") {
      for (const [key, value] of Object.entries(rawProjects)) {
        if (value && typeof value.id === "number" && value.id > 0) {
          legacyProjects[key] = {
            id: value.id,
            name: typeof value.name === "string" ? value.name : "",
            slug: typeof value.slug === "string" ? value.slug : "",
          };
        }
      }
    }
    const current = base.collab ?? defaultCollab();
    base.collab = {
      baseUrl: current.baseUrl || (typeof l.baseUrl === "string" ? l.baseUrl : ""),
      user: current.user ?? ((l.user as CloudUser | null) ?? null),
      projects:
        Object.keys(current.projects).length > 0 ? current.projects : legacyProjects,
      lastImport: current.lastImport ?? ((l.lastImport as CloudImportRecord | null) ?? null),
      lastImportError:
        current.lastImportError ??
        (typeof l.lastImportError === "string" ? l.lastImportError : null),
    };
    changed = true;
  }

  if (base.docSiteBase === undefined) {
    const v = store.getItem(LEGACY_DOCSITE_KEY);
    if (v !== null) {
      base.docSiteBase = v;
      changed = true;
    }
  }

  if (!base.mcpExpose) {
    const command = store.getItem(LEGACY_MCP_KEYS[0]);
    const args = store.getItem(LEGACY_MCP_KEYS[1]);
    const write = store.getItem(LEGACY_MCP_KEYS[2]);
    const secrets = store.getItem(LEGACY_MCP_KEYS[3]);
    const env = store.getItem(LEGACY_MCP_KEYS[4]);
    const client = store.getItem(LEGACY_MCP_KEYS[5]);
    if ([command, args, write, secrets, env, client].some((v) => v !== null)) {
      base.mcpExpose = {
        command: command ?? undefined,
        args: args ?? undefined,
        allowWrite: write === "1",
        revealSecrets: secrets === "1",
        environment: env ?? undefined,
        client: client ?? undefined,
      };
      changed = true;
    }
  }

  if (base.sideView === undefined) {
    const v = store.getItem(LEGACY_SIDEVIEW_KEY);
    if (v !== null) {
      base.sideView = v;
      changed = true;
    }
  }

  if (base.layout === undefined) {
    const v = store.getItem(LEGACY_LAYOUT_KEY);
    if (v !== null) {
      base.layout = v;
      changed = true;
    }
  }

  if (changed) {
    for (const key of [
      LEGACY_COLLAB_KEY,
      LEGACY_DOCSITE_KEY,
      LEGACY_SIDEVIEW_KEY,
      LEGACY_LAYOUT_KEY,
      ...LEGACY_MCP_KEYS,
    ]) {
      store.removeItem(key);
    }
  }
  return changed;
}

/**
 * Load (and migrate) the document exactly once. Safe to call repeatedly; the
 * first call wins and every later call waits on the same promise.
 */
export function ensureLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = (async () => {
      const current = await readRaw();
      const changed = migrateLegacy(current);
      cache = current;
      if (changed) await writeRaw(cache).catch(() => undefined);
      loaded = true;
    })();
  }
  return loadPromise;
}

/** Mutate the document atomically and persist it. */
function update(mutator: (config: AppConfig) => void): Promise<void> {
  return enqueue(async () => {
    await ensureLoaded();
    mutator(cache);
    await writeRaw(cache).catch(() => undefined);
  });
}

// ---------------------------------------------------------------------------
// Typed section accessors
// ---------------------------------------------------------------------------

export async function getCollab(): Promise<CollabConfig | null> {
  await ensureLoaded();
  return cache.collab ?? null;
}

export function setCollab(patch: Partial<CollabConfig>): Promise<void> {
  return update((config) => {
    config.collab = { ...defaultCollab(), ...(config.collab ?? {}), ...patch };
  });
}

export async function getDocSiteBase(): Promise<string> {
  await ensureLoaded();
  return cache.docSiteBase ?? "";
}

export function setDocSiteBase(value: string): Promise<void> {
  return update((config) => {
    config.docSiteBase = value;
  });
}

export async function getMcpExpose(): Promise<McpExposeConfig> {
  await ensureLoaded();
  return cache.mcpExpose ?? {};
}

export function setMcpExpose(patch: Partial<McpExposeConfig>): Promise<void> {
  return update((config) => {
    config.mcpExpose = { ...(config.mcpExpose ?? {}), ...patch };
  });
}

/** 默认沿用既有的服务端协作行为，升级用户不会被静默切换到新通道。 */
export const DEFAULT_SYNC_MODE: SyncModeConfig = { mode: "server" };

export async function getSyncModes(): Promise<Record<string, SyncModeConfig>> {
  await ensureLoaded();
  return cache.syncModes ?? {};
}

/** 同步读取已加载的缓存，供 store 初始化投影；未加载时返回缺省值。 */
export function peekSyncMode(projectId: string): SyncModeConfig {
  const entry = cache.syncModes?.[projectId];
  return entry && (entry.mode === "local" || entry.mode === "server" || entry.mode === "git")
    ? entry
    : DEFAULT_SYNC_MODE;
}

export function setSyncModeFor(
  projectId: string,
  patch: Partial<SyncModeConfig>,
): Promise<void> {
  return update((config) => {
    const current = config.syncModes?.[projectId] ?? { ...DEFAULT_SYNC_MODE };
    config.syncModes = {
      ...(config.syncModes ?? {}),
      [projectId]: { ...current, ...patch },
    };
  });
}

export async function getSideView(): Promise<string | null> {
  await ensureLoaded();
  return cache.sideView ?? null;
}

export function setSideView(value: string): Promise<void> {
  return update((config) => {
    config.sideView = value;
  });
}

export async function getLayout(): Promise<string | null> {
  await ensureLoaded();
  return cache.layout ?? null;
}

export function setLayout(value: string): Promise<void> {
  return update((config) => {
    config.layout = value;
  });
}

/**
 * Test-only: drop the in-memory cache so the next access re-reads storage and
 * re-runs the legacy migration. Mirrors `replaceCloudConnection` — a test
 * helper, never called by the app.
 */
export function __testResetAppConfig(): void {
  cache = { version: VERSION };
  loaded = false;
  loadPromise = null;
}
