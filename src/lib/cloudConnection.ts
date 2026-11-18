/**
 * Connection settings for the Reqora collaboration backend.
 *
 * Local workspace data and cloud data are deliberately isolated. Everything
 * that describes the *connection* lives here, in WebView localStorage — outside
 * the workspace snapshot, so it can never be synced to the backend, overwritten
 * by a remote response, or lost when the user switches local projects.
 *
 * Persisted fields:
 *  - baseUrl / user / projects / lastImport / lastImportError: plain JSON
 *    under `reqora.cloudConnection.v1` (no secrets here).
 *  - session: access/refresh token pair, AES-256-GCM **encrypted** under a
 *    separate key (`reqora.cloudSession.v1`). The key is a non-extractable
 *    WebCrypto key in IndexedDB; the plaintext only ever exists in memory.
 *    See lib/localVault.ts for the format and the fail-closed behaviour.
 *
 * `initializeCloudConnection()` must be awaited once at startup before any
 * read: it decrypts the persisted session (and migrates old plaintext ones).
 * All accessors stay synchronous afterwards by reading an in-memory snapshot.
 *
 * localStorage is unavailable in the Node test runner and can be blocked in
 * some embedded WebViews; a module-level fallback keeps a single session
 * consistent in those environments.
 */

import type { CloudUser } from "./cloud.ts";
import { isSealed, openLocalSecret, sealLocalSecret } from "./localVault.ts";

export interface CloudSession {
  access: string;
  refresh: string;
}

/** A collaboration space (backend project) resolved for one local project. */
export interface CloudProjectRef {
  id: number;
  name: string;
  slug: string;
}

export interface CloudImportRecord {
  at: number;
  version: number;
  projectId: number;
  projectName: string;
  localProjectId: string;
}

export interface CloudConnectionState {
  baseUrl: string;
  session: CloudSession | null;
  user: CloudUser | null;
  /** Keyed by local project id, so switching projects never mixes spaces. */
  projects: Record<string, CloudProjectRef>;
  lastImport: CloudImportRecord | null;
  lastImportError: string | null;
}

const STORAGE_KEY = "reqora.cloudConnection.v1";
/** Only ever holds an opaque envelope, never a plaintext token. */
const SESSION_KEY = "reqora.cloudSession.v1";

/**
 * 构建期注入的默认协作服务器地址（REQORA_COLLAB_SERVER_URL）。
 * P0：未配置时保持为空字符串，不再回退 example.com 占位地址——协作入口
 * 会据此禁用并给出部署引导，避免把凭据/请求发往一个示例域名。
 * Node 测试环境没有 Vite define，`typeof` 保护让这里保持同一默认值。
 */
const BUILTIN_COLLAB_BASE_URL =
  typeof __REQORA_COLLAB_SERVER_URL__ === "string" && __REQORA_COLLAB_SERVER_URL__.trim()
    ? __REQORA_COLLAB_SERVER_URL__.trim().replace(/\/+$/, "")
    : "";

export const DEFAULT_CLOUD_BASE_URL = BUILTIN_COLLAB_BASE_URL;

/** True only when a real, usable collaboration backend URL is configured.
 * The historical `example.com` placeholder (still possible in old persisted
 * state) is treated as unconfigured. */
export function isCloudServerConfigured(url?: string): boolean {
  const raw = (url ?? readCloudConnection().baseUrl ?? "").trim();
  if (!raw || /(^|\/\/|\.)example\.(com|org|net)(?:\/|:|$)/i.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function defaultState(): CloudConnectionState {
  return {
    baseUrl: DEFAULT_CLOUD_BASE_URL,
    session: null,
    user: null,
    projects: {},
    lastImport: null,
    lastImportError: null,
  };
}

let memoryFallback: CloudConnectionState | null = null;
/** Decrypted, synchronous source of truth once the module has been read. */
let volatile: CloudConnectionState | null = null;
let sealSequence = 0;
let pendingSeal: Promise<void> = Promise.resolve();

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Tolerate older / partially corrupted payloads instead of throwing at boot. */
function sanitize(raw: string): CloudConnectionState {
  const fallback = defaultState();
  let parsed: Partial<CloudConnectionState>;
  try {
    parsed = JSON.parse(raw) as Partial<CloudConnectionState>;
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;

  // `session` is only accepted here so `initializeCloudConnection()` can
  // migrate a legacy plaintext login into the encrypted store. New writes
  // always strip it from the main payload.
  const session =
    parsed.session &&
    typeof parsed.session.access === "string" &&
    typeof parsed.session.refresh === "string"
      ? { access: parsed.session.access, refresh: parsed.session.refresh }
      : null;

  const projects: Record<string, CloudProjectRef> = {};
  if (parsed.projects && typeof parsed.projects === "object") {
    for (const [key, value] of Object.entries(parsed.projects)) {
      if (value && typeof value.id === "number" && Number.isFinite(value.id) && value.id > 0) {
        projects[key] = {
          id: value.id,
          name: typeof value.name === "string" ? value.name : "",
          slug: typeof value.slug === "string" ? value.slug : "",
        };
      }
    }
  }

  const lastImport =
    parsed.lastImport && typeof parsed.lastImport === "object" && typeof parsed.lastImport.at === "number"
      ? (parsed.lastImport as CloudImportRecord)
      : null;

  return {
    baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : DEFAULT_CLOUD_BASE_URL,
    session,
    user: parsed.user && typeof parsed.user === "object" ? (parsed.user as CloudUser) : null,
    projects,
    lastImport,
    lastImportError:
      typeof parsed.lastImportError === "string" ? parsed.lastImportError : null,
  };
}

function parseSession(raw: string): CloudSession | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CloudSession>;
    return parsed && typeof parsed.access === "string" && typeof parsed.refresh === "string"
      ? { access: parsed.access, refresh: parsed.refresh }
      : null;
  } catch {
    return null;
  }
}

export function readCloudConnection(): CloudConnectionState {
  if (volatile) return volatile;
  const store = storage();
  if (!store) return memoryFallback ?? (memoryFallback = defaultState());
  try {
    const raw = store.getItem(STORAGE_KEY);
    volatile = raw ? sanitize(raw) : defaultState();
  } catch {
    volatile = defaultState();
  }
  return volatile;
}

/** Write everything except the token pair. Tokens never enter this payload. */
function persistCore(state: CloudConnectionState): CloudConnectionState {
  volatile = state;
  const store = storage();
  if (!store) {
    memoryFallback = state;
    return state;
  }
  try {
    const { session: _session, ...rest } = state;
    store.setItem(STORAGE_KEY, JSON.stringify(rest));
  } catch {
    memoryFallback = state;
  }
  return state;
}

/**
 * Asynchronously seal the token pair. On any failure the storage key is
 * removed — the session stays usable in memory for this run, but no plaintext
 * is written. A sequence number prevents an older seal from landing after a
 * newer logout/login.
 */
async function writeSealedSession(
  store: Storage,
  session: CloudSession | null,
): Promise<void> {
  const sequence = ++sealSequence;
  if (!session) {
    if (sequence === sealSequence) {
      try {
        store.removeItem(SESSION_KEY);
      } catch {
        /* storage disabled */
      }
    }
    return;
  }
  let sealed: string | null = null;
  try {
    sealed = await sealLocalSecret(JSON.stringify(session));
  } catch {
    sealed = null;
  }
  if (sequence !== sealSequence) return;
  try {
    if (sealed) store.setItem(SESSION_KEY, sealed);
    else store.removeItem(SESSION_KEY);
  } catch {
    /* storage disabled */
  }
}

function persist(state: CloudConnectionState): CloudConnectionState {
  persistCore(state);
  const store = storage();
  pendingSeal = store ? writeSealedSession(store, state.session) : Promise.resolve();
  return state;
}

/** Await the last encrypted write (used at shutdown and by tests). */
export function flushCloudConnection(): Promise<void> {
  return pendingSeal;
}

/**
 * Boot step: decrypt the persisted session and migrate any legacy plaintext
 * token out of the main payload. Safe to call more than once (tests simulate a
 * restart with it). Never leaves plaintext tokens on disk.
 */
export async function initializeCloudConnection(): Promise<void> {
  volatile = null;
  const store = storage();
  if (!store) return;
  let base: CloudConnectionState;
  try {
    const raw = store.getItem(STORAGE_KEY);
    base = raw ? sanitize(raw) : defaultState();
  } catch {
    base = defaultState();
  }

  let session: CloudSession | null = base.session;
  let sealed: string | null = null;
  let needSeal = true;
  try {
    sealed = store.getItem(SESSION_KEY);
  } catch {
    /* storage disabled */
  }
  if (sealed) {
    if (isSealed(sealed)) {
      const opened = await openLocalSecret(sealed);
      if (opened) {
        session = parseSession(opened);
        // Keep the existing envelope: no need to rewrite a valid ciphertext.
        needSeal = false;
      } else {
        // IndexedDB may be temporarily unavailable. Stay logged out for this
        // run, but do NOT delete the envelope — a transient failure must not
        // destroy the user's saved login.
        session = null;
        needSeal = false;
      }
    } else {
      // Unknown value under the session key: never treat it as credentials,
      // and remove it below.
      session = null;
    }
  }

  const state: CloudConnectionState = { ...base, session };
  persistCore(state);
  pendingSeal = needSeal ? writeSealedSession(store, state.session) : Promise.resolve();
  await pendingSeal;
}

export function writeCloudConnection(
  patch: Partial<CloudConnectionState>,
): CloudConnectionState {
  return persist({ ...readCloudConnection(), ...patch });
}

/** Wipe everything (used by tests and by "forget this backend"). */
export function resetCloudConnection(): CloudConnectionState {
  return persist(defaultState());
}

/** Replace the whole state (test helper). */
export function replaceCloudConnection(state: CloudConnectionState): CloudConnectionState {
  return persist(sanitize(JSON.stringify(state)));
}

export function normalizeCloudBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function cloudBaseUrl(): string {
  // 归一化放在读取端而不是写入端：地址输入框是受控组件，若每次敲键都剥掉
  // 尾部 "/"，用户永远打不出 http:// —— `/` 一落进输入框就被存取链路吃掉。
  return normalizeCloudBaseUrl(readCloudConnection().baseUrl);
}

export function setCloudBaseUrl(url: string): string {
  // 原样保存用户输入（含中间输入态），归一化由 cloudBaseUrl() 在消费端完成。
  writeCloudConnection({ baseUrl: url });
  return url;
}

export function cloudSession(): CloudSession | null {
  return readCloudConnection().session;
}

export function cloudStoredUser(): CloudUser | null {
  return readCloudConnection().user;
}

export function setCloudSession(session: CloudSession, user: CloudUser | null): void {
  writeCloudConnection({ session, user });
}

/** Drop the token pair and cached profile; keep the address and import log. */
export function clearCloudSession(): void {
  writeCloudConnection({ session: null, user: null });
}

/**
 * The backend identity changed. Tokens and resolved project ids belong to the
 * old server, so they must not be reused against the new one.
 */
export function switchCloudServer(url: string): string {
  // 与 setCloudBaseUrl 一致：原样保存，读取端（cloudBaseUrl()）负责归一化。
  writeCloudConnection({
    baseUrl: url,
    session: null,
    user: null,
    projects: {},
    lastImport: null,
    lastImportError: null,
  });
  return url;
}

export function cloudProjectFor(localProjectId: string): CloudProjectRef | null {
  return readCloudConnection().projects[localProjectId] ?? null;
}

export function setCloudProjectFor(localProjectId: string, project: CloudProjectRef): void {
  const state = readCloudConnection();
  writeCloudConnection({ projects: { ...state.projects, [localProjectId]: project } });
}

export function forgetCloudProject(localProjectId: string): void {
  const projects = { ...readCloudConnection().projects };
  delete projects[localProjectId];
  writeCloudConnection({ projects });
}

export function cloudLastImport(): CloudImportRecord | null {
  return readCloudConnection().lastImport;
}

export function cloudLastImportError(): string | null {
  return readCloudConnection().lastImportError;
}

export function setCloudImportResult(record: CloudImportRecord): void {
  writeCloudConnection({ lastImport: record, lastImportError: null });
}

export function setCloudImportError(message: string | null): void {
  writeCloudConnection({ lastImportError: message });
}
