/**
 * 协议 v2 的 REST transport（追加式变更日志端点）。
 *
 * 刻意不复用 lib/cloud.ts 的内部请求封装：v2 是新协议、新端点、新错误语义，
 * 独立实现便于灰度与回退，也避免为了一条探测请求改动现有 LWW 客户端。
 * 认证沿用同一套加密会话（cloudConnection.ts），令牌格式与旧客户端一致。
 *
 * 端点契约见 docs/SYNC_PROTOCOL_V2.md 第 5 节；服务端实现见
 * server/.../workspace/CrdtSyncController.java。
 */
import {
  cloudBaseUrl,
  cloudSession,
  cloudStoredUser,
  setCloudSession,
} from "./cloudConnection.ts";
import type {
  CrdtBootstrap,
  CrdtChangesPage,
  CrdtPostResult,
  CrdtTransport,
} from "./crdtSync.ts";
import { bytesToBase64, changeHash, type CrdtChange } from "./crdtDoc.ts";

/** 与旧客户端的 CloudError 语义平行，但不依赖它（旧客户端保持只读）。 */
export class CrdtRequestError extends Error {
  readonly status: number;
  readonly code: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, code: number, retryable: boolean) {
    super(message);
    this.name = "CrdtRequestError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

interface ApiEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

export interface CloudCrdtOptions {
  /** 覆盖服务器地址（测试 / 多租户）。缺省取 cloudConnection 的 baseUrl。 */
  baseUrl?: string;
  /** 覆盖 fetch（测试注入）。 */
  fetchFn?: typeof fetch;
  /** 5xx 重试次数，默认 3。 */
  retries?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 401 时刷新一次访问令牌并重写会话；失败抛错，绝不带着旧令牌重试。 */
async function refreshSession(
  baseUrl: string,
  fetchFn: typeof fetch,
): Promise<void> {
  const session = cloudSession();
  if (!session?.refresh) throw new CrdtRequestError("cloud session expired", 401, 1008, false);
  const response = await fetchFn(`${baseUrl}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: session.refresh }),
  });
  if (!response.ok) throw new CrdtRequestError("cloud session refresh failed", 401, 1008, false);
  const envelope = (await response.json()) as ApiEnvelope<{
    accessToken?: string;
    refreshToken?: string;
    user?: unknown;
  }>;
  const data = envelope.data;
  if (!data?.accessToken || !data?.refreshToken || (envelope.code ?? 0) !== 0) {
    throw new CrdtRequestError("cloud session refresh failed", 401, 1008, false);
  }
  setCloudSession(
    { access: data.accessToken, refresh: data.refreshToken },
    (data.user as never) ?? cloudStoredUser(),
  );
}

async function requestJson<T>(
  baseUrl: string,
  fetchFn: typeof fetch,
  path: string,
  init: RequestInit = {},
  options: { retries?: number; allowNotFound?: boolean } = {},
): Promise<T | null> {
  const retries = options.retries ?? 3;
  let refreshed = false;
  let lastError: CrdtRequestError | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const session = cloudSession();
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
    };
    if (session?.access) headers.authorization = `Bearer ${session.access}`;
    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}${path}`, { ...init, headers });
    } catch (error) {
      lastError = new CrdtRequestError(
        error instanceof Error ? error.message : String(error),
        0,
        0,
        true,
      );
      if (attempt < retries) {
        await sleep(100 * (attempt + 1));
        continue;
      }
      throw lastError;
    }

    if (response.status === 404 && options.allowNotFound) return null;
    if (response.status === 401 && !refreshed) {
      refreshed = true;
      await refreshSession(baseUrl, fetchFn);
      attempt -= 1; // 刷新后重试同一请求，不计入 5xx 预算
      continue;
    }
    if (response.status >= 500) {
      lastError = new CrdtRequestError(
        `cloud crdt request failed: HTTP ${response.status}`,
        response.status,
        0,
        true,
      );
      if (attempt < retries) {
        await sleep(100 * (attempt + 1));
        continue;
      }
      throw lastError;
    }

    let envelope: ApiEnvelope<T>;
    try {
      envelope = (await response.json()) as ApiEnvelope<T>;
    } catch {
      throw new CrdtRequestError("cloud crdt response is not JSON", response.status, 0, false);
    }
    const code = envelope.code ?? (response.ok ? 0 : response.status);
    if (!response.ok || code !== 0) {
      // 1004 = 目标不存在：旧服务端/未初始化的空间同样按「不支持」处理。
      if (options.allowNotFound && (code === 1004 || response.status === 404)) return null;
      throw new CrdtRequestError(
        envelope.message || `cloud crdt request failed: ${code}`,
        response.status,
        code,
        response.status >= 500,
      );
    }
    return (envelope.data ?? null) as T | null;
  }
  throw lastError ?? new CrdtRequestError("cloud crdt request failed", 0, 0, true);
}

/** 把一个协作空间绑定成 v2 transport。 */
export function createCloudCrdtTransport(
  projectId: number,
  options: CloudCrdtOptions = {},
): CrdtTransport {
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const root = (options.baseUrl ?? cloudBaseUrl()).replace(/\/+$/, "");
  const base = `/api/v1/projects/${projectId}/workspace/crdt`;
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    async bootstrap(): Promise<CrdtBootstrap | null> {
      const data = await requestJson<CrdtBootstrap>(root, fetchFn, `${base}/bootstrap`, {}, {
        allowNotFound: true,
        retries: 0,
      });
      if (!data) return null;
      return {
        genesis: typeof data.genesis === "string" ? data.genesis : null,
        snapshot:
          data.snapshot && typeof data.snapshot.doc === "string"
            ? { doc: data.snapshot.doc, seq: Number(data.snapshot.seq) || 0 }
            : null,
        heads: Array.isArray(data.heads) ? data.heads : [],
        cursor: Number(data.cursor) || 0,
        version: Number(data.version) || 0,
      };
    },

    async createGenesis(genesis: string): Promise<CrdtBootstrap> {
      const data = await requestJson<CrdtBootstrap>(
        root,
        fetchFn,
        `${base}/bootstrap`,
        json({ genesis }),
      );
      if (!data || typeof data.genesis !== "string") {
        throw new CrdtRequestError("crdt bootstrap did not return a genesis", 200, 0, false);
      }
      return {
        genesis: data.genesis,
        snapshot:
          data.snapshot && typeof data.snapshot.doc === "string"
            ? { doc: data.snapshot.doc, seq: Number(data.snapshot.seq) || 0 }
            : null,
        heads: Array.isArray(data.heads) ? data.heads : [],
        cursor: Number(data.cursor) || 0,
        version: Number(data.version) || 0,
      };
    },

    async changes(since: number, limit = 500): Promise<CrdtChangesPage> {
      const data = await requestJson<CrdtChangesPage>(
        root,
        fetchFn,
        `${base}/changes?since=${Math.max(0, Math.floor(since))}&limit=${limit}`,
      );
      return {
        changes: Array.isArray(data?.changes) ? data.changes : [],
        cursor: Number(data?.cursor) || since,
        version: Number(data?.version) || 0,
      };
    },

    async postChanges(changes: CrdtChange[]): Promise<CrdtPostResult> {
      if (changes.length === 0) {
        return { accepted: [], duplicates: [], cursor: 0, version: 0 };
      }
      const data = await requestJson<CrdtPostResult>(
        root,
        fetchFn,
        `${base}/changes`,
        json({
          // hash 由 Automerge decodeChange 给出，是 change 的内容寻址 id；
          // 服务端用它做 (project_id, hash) 唯一键，重复点击只记一次。
          changes: changes.map((change) => ({
            hash: changeHash(change),
            payload: bytesToBase64(change),
          })),
        }),
      );
      return {
        accepted: Array.isArray(data?.accepted) ? data.accepted : [],
        duplicates: Array.isArray(data?.duplicates) ? data.duplicates : [],
        cursor: Number(data?.cursor) || 0,
        version: Number(data?.version) || 0,
      };
    },

    async postSnapshot(doc: string, heads: string[], seq: number): Promise<void> {
      await requestJson<null>(root, fetchFn, `${base}/snapshot`, json({ doc, heads, seq }), {
        retries: 0,
      });
    },
  };
}
