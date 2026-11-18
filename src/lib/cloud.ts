/**
 * Typed API client for the Reqora cloud backend (server/docs/API.md).
 *
 * Collaboration is ROW-LEVEL BIDIRECTIONAL SYNC: the desktop snapshot is split
 * into entity rows (lib/workspaceRows.ts, the same shape as the backend's
 * ws_entity table), the client downloads the full row set, merges per row by
 * `updatedAt` (last-writer-wins), uploads only the rows where the local side
 * wins (credentials redacted first), and rebuilds the local shared domains
 * from the server's merged response. The connection settings (address,
 * resolved project id, token pair) live in WebView localStorage — outside the
 * workspace snapshot, so they are never synced or overwritten.
 * The token pair is persisted so one login survives restarts; it never goes
 * into URLs. 401 triggers one refresh-then-retry; 5xx/network errors retry up
 * to 3 times; 4xx failures surface the server's Chinese message.
 *
 * The backend stores structured rows (see server/db/migration) and exposes
 * GET/POST /workspace/rows only.
 */

import { acceptLanguage, t } from "../i18n/index.ts";
import {
  clearCloudSession as clearStoredSession,
  cloudBaseUrl,
  cloudProjectFor,
  cloudSession,
  cloudStoredUser,
  forgetCloudProject,
  setCloudBaseUrl,
  setCloudSession,
  type CloudProjectRef,
} from "./cloudConnection.ts";
import type { WorkspaceRowsPayload } from "./workspaceRows.ts";

export interface CloudUser {
  id: number;
  username: string;
  email: string;
  displayName: string;
  status: number;
  superAdmin: boolean;
  roles: string[];
  permissions: string[];
}

export interface CloudTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  user: CloudUser;
}

export interface CloudProject {
  id: number;
  name: string;
  slug: string;
  description: string;
  status: string;
  ownerId: number;
  memberRole: string;
  createdAt: string;
  updatedAt: string;
  orgId?: number | null;
}

export interface CloudOrg {
  id: number;
  name: string;
  slug: string;
  description: string;
  ownerId: number;
  memberRole: string;
  status: string;
  createdAt: string;
}

export interface CloudOrgMember {
  userId: number;
  username: string;
  displayName: string;
  role: string;
  joinedAt: string;
}

export interface CloudInvite {
  id: number;
  orgId: number;
  role: string;
  label: string;
  expiresAt: string;
  maxUses: number;
  usedCount: number;
  status: string;
  createdAt: string;
}

export interface CloudInviteCreated {
  invite: CloudInvite;
  /** Raw token is returned exactly once; never persisted server-side. */
  token: string;
}

export interface CloudInviteAccepted {
  orgId: number;
  orgName: string;
  role: string;
}

export interface CloudPage<T> {
  records: T[];
  total: number;
  page: number;
  size: number;
}

export interface CloudHead {
  projectId: number;
  version: number;
  updatedAt: string | null;
}

export class CloudError extends Error {
  readonly code: number;
  readonly status: number;
  readonly requestId: string;
  readonly retryable: boolean;

  constructor(code: number, status: number, message: string, requestId = "") {
    super(message);
    this.name = "CloudError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.retryable = status === 0 || status >= 500;
  }
}

/**
 * The address is the ONLY setting the user has to type. Tokens, the resolved
 * collaboration space and the import log are persisted by cloudConnection.ts
 * (WebView localStorage), never in the workspace snapshot.
 */
export function configureCloud(url: string): void {
  setCloudBaseUrl(url);
}

export function clearCloudSession(): void {
  clearStoredSession();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function friendly(code: number, message: string | undefined): string {
  if (message && message.trim()) return message;
  switch (code) {
    case 1002:
    case 1008:
      return t("cloud.error.sessionExpired");
    case 1003:
      return t("cloud.error.forbidden");
    case 1009:
      return t("cloud.error.conflict");
    case 5000:
      return t("cloud.error.serviceUnavailable");
    default:
      return t("cloud.error.requestFailed");
  }
}

async function refreshSession(): Promise<boolean> {
  const refresh = cloudSession()?.refresh;
  const baseUrl = cloudBaseUrl();
  if (!refresh || !baseUrl) return false;
  try {
    const response = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": acceptLanguage() },
      body: JSON.stringify({ refreshToken: refresh }),
    });
    const payload = (await response.json().catch(() => null)) as {
      code?: number;
      data?: CloudTokens;
    } | null;
    if (response.ok && payload?.code === 0 && payload.data) {
      // Persist the rotated pair so the next app start is still logged in.
      setCloudSession(
        { access: payload.data.accessToken, refresh: payload.data.refreshToken },
        payload.data.user ?? cloudStoredUser(),
      );
      return true;
    }
  } catch {
    // fall through to clearing the session
  }
  clearStoredSession();
  return false;
}

interface RequestOptions {
  body?: unknown;
  /** 原始字节请求体（内容寻址对象上传）；与 body 互斥，跳过 JSON 预检。 */
  binaryBody?: Uint8Array;
  /** 响应为原始字节（对象下载），不走 JSON envelope 解析。 */
  raw?: boolean;
  auth?: boolean;
  attempt?: number;
  refreshed?: boolean;
}

/**
 * 发请求前的轻量校验。注意：JSON.stringify 会把 NaN / Infinity 转成 null，
 * 请求体语法几乎总是合法的 —— HttpMessageNotReadableException 的原因在服务端
 * （DTO 类型不匹配、请求体缺失、Jackson 读取约束等），不是脏数字。
 * 这里拦的是「body 被序列化成非对象（null / 数字 / 字符串 / 数组）」这类
 * Spring @RequestBody 必然无法反序列化的情况，并把上下文写进调试台。
 */
function assertValidJsonBody(body: string, method: string, path: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const matched = /position (\d+)/.exec(detail);
    const at = matched ? Number(matched[1]) : null;
    const snippet =
      at === null
        ? body.slice(0, 200)
        : body.slice(Math.max(0, at - 80), Math.min(body.length, at + 80));
    console.error("[cloud] 请求体不是合法 JSON，服务端会拒绝", { method, path, detail, snippet });
    throw new CloudError(
      1001,
      0,
      t("cloud.error.invalidJsonBody", { detail, snippet }),
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("[cloud] 请求体不是 JSON 对象，@RequestBody 无法反序列化", {
      method,
      path,
      body: body.slice(0, 200),
    });
    throw new CloudError(
      1001,
      0,
      t("cloud.error.bodyNotJsonObject", { body: body.slice(0, 200) }),
    );
  }
}

async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const baseUrl = cloudBaseUrl();
  if (!baseUrl) {
    throw new CloudError(0, 0, t("cloud.error.noBaseUrl"));
  }
  const attempt = options.attempt ?? 0;
  const headers: Record<string, string> = {
    "X-Request-Id": crypto.randomUUID(),
    // 后台响应语言跟随客户端当前界面语言。
    "accept-language": acceptLanguage(),
  };
  if (options.binaryBody !== undefined) {
    headers["content-type"] = "application/octet-stream";
  } else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const session = cloudSession();
  if (options.auth !== false && session) headers.authorization = `Bearer ${session.access}`;
  const bodyText =
    options.binaryBody === undefined && options.body !== undefined
      ? JSON.stringify(options.body)
      : undefined;
  // 上传前先自己解析一遍：非法 token / 截断的 JSON 就地报告，而不是等服务端 400。
  if (bodyText !== undefined) assertValidJsonBody(bodyText, method, path);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: (options.binaryBody ?? bodyText) as BodyInit | undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    if (attempt < 3) {
      await delay(150 * (attempt + 1));
      return request<T>(method, path, { ...options, attempt: attempt + 1 });
    }
    throw new CloudError(0, 0, t("cloud.offline"));
  }

  if (response.status === 401 && !options.refreshed && (await refreshSession())) {
    return request<T>(method, path, { ...options, refreshed: true, attempt: 0 });
  }
  if (response.status >= 500 && attempt < 3) {
    await delay(150 * (attempt + 1));
    return request<T>(method, path, { ...options, attempt: attempt + 1 });
  }

  // 原始字节模式（对象下载）：成功直接回字节；失败响应仍是 JSON envelope，
  // 解析出 code/message 后按常规错误上抛。
  if (options.raw) {
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        code?: number;
        message?: string;
        requestId?: string;
      } | null;
      const code = payload?.code ?? 5000;
      throw new CloudError(
        code,
        response.status,
        friendly(code, payload?.message) ||
          t("cloud.error.httpFailed", { status: response.status }),
        payload?.requestId ?? "",
      );
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer) as unknown as T;
  }

  const payload = (await response.json().catch(() => null)) as {
    code?: number;
    message?: string;
    requestId?: string;
    data?: T;
  } | null;
  if (!response.ok || payload?.code !== 0) {
    const code = payload?.code ?? 5000;
    const serverMessage = friendly(code, payload?.message);
    if (response.status === 400) {
      // 旧版后端把 Jackson 原因吞掉且不打日志；客户端至少留下请求指纹与
      // 请求体预览，可用同一个 requestId 去服务端日志对账，或直接重放请求。
      const detailVersion = response.headers?.get?.("X-Reqora-Error-Detail") ?? "";
      console.warn("[cloud/400] 后端拒绝请求", {
        method,
        path,
        status: response.status,
        code,
        requestId: payload?.requestId ?? headers["X-Request-Id"],
        serverMessage,
        bodyBytes: bodyText?.length ?? 0,
        bodyPreview: bodyText?.slice(0, 1500) ?? "",
        errorDetailVersion: detailVersion || "(无：后端仍是旧版异常处理器)",
      });
    }
    const detailVersion = response.headers?.get?.("X-Reqora-Error-Detail") ?? "";
    throw new CloudError(
      code,
      response.status,
      response.status === 400
        ? t(
            detailVersion === "v2"
              ? "cloud.error.http400DetailV2"
              : "cloud.error.http400DetailLegacy",
            { message: serverMessage },
          )
        : serverMessage,
      payload?.requestId ?? "",
    );
  }
  return payload.data as T;
}

/** Login persists the token pair so one login survives app restarts. */
export async function cloudLogin(username: string, password: string): Promise<CloudTokens> {
  const tokens = await request<CloudTokens>("POST", "/api/v1/auth/login", {
    auth: false,
    body: { username, password },
  });
  setCloudSession(
    { access: tokens.accessToken, refresh: tokens.refreshToken },
    tokens.user ?? null,
  );
  return tokens;
}

export async function cloudLogout(refreshToken?: string): Promise<void> {
  const refresh = refreshToken ?? cloudSession()?.refresh;
  try {
    await request<void>("POST", "/api/v1/auth/logout", {
      auth: false,
      body: { refreshToken: refresh },
    });
  } finally {
    clearStoredSession();
  }
}

export const cloudListProjects = (keyword = "") =>
  request<CloudPage<CloudProject>>(
    "GET",
    `/api/v1/projects?size=100${keyword ? `&keyword=${encodeURIComponent(keyword)}` : ""}`,
  );

export const cloudCreateProject = (
  name: string,
  slug: string,
  description = "",
  orgId?: number | null,
) =>
  request<CloudProject>("POST", "/api/v1/projects", {
    body: { name, slug, description, ...(orgId ? { orgId } : {}) },
  });

// ---- Organizations & invitations ----

export const cloudCreateOrg = (name: string, slug: string, description = "") =>
  request<CloudOrg>("POST", "/api/v1/orgs", { body: { name, slug, description } });

export const cloudListOrgs = () => request<CloudOrg[]>("GET", "/api/v1/orgs");

export const cloudOrgMembers = (orgId: number) =>
  request<CloudOrgMember[]>("GET", `/api/v1/orgs/${orgId}/members`);

export const cloudLeaveOrg = (orgId: number) =>
  request<void>("POST", `/api/v1/orgs/${orgId}/leave`, { body: {} });

export const cloudCreateInvite = (
  orgId: number,
  payload: { role?: string; maxUses?: number; expiresInHours?: number; label?: string },
) =>
  request<CloudInviteCreated>(
    "POST",
    `/api/v1/orgs/${orgId}/invitations`,
    { body: payload },
  );

export const cloudListInvites = (orgId: number) =>
  request<CloudInvite[]>("GET", `/api/v1/orgs/${orgId}/invitations`);

export const cloudAcceptInvite = (token: string) =>
  request<CloudInviteAccepted>(
    "POST",
    `/api/v1/invitations/${encodeURIComponent(token)}/accept`,
    { body: {} },
  );

export const cloudHead = (projectId: number) =>
  request<CloudHead>("GET", `/api/v1/projects/${projectId}/workspace/head`);

/** 服务端返回的全量行集（含软删墓碑与通知序号 version）。 */
export interface CloudRowsResponse extends WorkspaceRowsPayload {
  projectId: number;
  version: number;
  /**
   * true = 响应是完整行集（普通 GET /rows，或 cursor 落后于墓碑回收水位
   * 时的退化全量）。full 响应必须整体替换本地视图而不是叠加基线——被
   * 回收的删除墓碑不会出现在增量里，叠加基线会让已删的行复活。
   */
  full?: boolean;
}

/** 下载：协作空间的完整行集（含墓碑，客户端负责过滤）。 */
export const cloudGetRows = (projectId: number) =>
  request<CloudRowsResponse>("GET", `/api/v1/projects/${projectId}/workspace/rows`);

/** 上传：只送本地获胜的行（已脱敏）；响应是服务端合并后的全量行集。 */
export const cloudSyncRows = (projectId: number, payload: WorkspaceRowsPayload) =>
  request<CloudRowsResponse>("POST", `/api/v1/projects/${projectId}/workspace/rows`, {
    body: payload,
  });

/** 分片上传确认：服务端逐行合并后只回「接受的行 + 版本号」，不回全量行集。 */
export interface CloudSyncAck {
  projectId: number;
  version: number;
  accepted: Array<{ id: string; updatedAt: number; applied?: boolean }>;
}

/**
 * 分片模式上传（?ackOnly=true）：每块变更行 POST 一次，响应只有确认信息；
 * 所有块传完后用 cloudGetRows 做一次全量拉取。服务端不支持该参数时仍会
 * 返回全量行集（旧版兼容），客户端按分片循环调用不受影响。
 */
export const cloudSyncRowsAck = (projectId: number, payload: WorkspaceRowsPayload) =>
  request<CloudSyncAck>(
    "POST",
    `/api/v1/projects/${projectId}/workspace/rows?ackOnly=true`,
    { body: payload },
  );

/**
 * 增量拉取（?since=<rowVersion 游标>）：只回服务端在游标之后写入/变更的行
 * （含墓碑）。旧版服务端忽略该参数返回全量，调用方 overlay 后语义不变。
 * cursor=0 时即全量引导。
 */
export const cloudGetRowsSince = (projectId: number, since: number) =>
  request<CloudRowsResponse>(
    "GET",
    `/api/v1/projects/${projectId}/workspace/rows?since=${Math.max(0, Math.floor(since))}`,
  );

// ---- 内容寻址对象（大字段旁路） ----

/** 上传对象（原始字节）；幂等，hash 用于服务端校验内容一致性。 */
export const cloudPutObject = (projectId: number, content: Uint8Array, hash: string) =>
  request<{ hash: string; size: number }>(
    "POST",
    `/api/v1/projects/${projectId}/workspace/objects?hash=${hash}`,
    { binaryBody: content },
  );

/** 下载对象（原始字节）。对象缺失会抛 NOT_FOUND —— 行无法水合即同步失败。 */
export const cloudGetObject = (projectId: number, hash: string) =>
  request<Uint8Array>("GET", `/api/v1/projects/${projectId}/workspace/objects/${hash}`, {
    raw: true,
  });

// ---- 文档站分享（服务端只存 JSON，网页版由同一个 SPA 渲染） ----

export interface CloudDocSiteView {
  id: number;
  projectId: number;
  title: string;
  status: string;
  expiresAt: string | null;
  viewCount: number;
  createdAt: string | null;
}

export interface CloudDocSitePublished {
  share: CloudDocSiteView;
  /** 明文令牌只在发布/轮换时返回一次。 */
  token: string;
  /** 服务端拼好的可复制链接；同源托管时按请求 origin 自动生成，跨源且未配置时为空串。 */
  url: string;
}

export interface CloudDocSiteOptions {
  title?: string;
  /** 不传表示永不过期。 */
  expiresInHours?: number;
}

export const cloudPublishDocSite = (
  projectId: number,
  payload: Record<string, unknown>,
  options: CloudDocSiteOptions = {},
) =>
  request<CloudDocSitePublished>("POST", `/api/v1/projects/${projectId}/doc-sites`, {
    body: { payload, ...options },
  });

export const cloudListDocSites = (projectId: number) =>
  request<CloudDocSiteView[]>("GET", `/api/v1/projects/${projectId}/doc-sites`);

/** 原链接不变，只更新内容。 */
export const cloudUpdateDocSite = (
  projectId: number,
  shareId: number,
  payload: Record<string, unknown>,
  options: CloudDocSiteOptions = {},
) =>
  request<CloudDocSiteView>("PUT", `/api/v1/projects/${projectId}/doc-sites/${shareId}`, {
    body: { payload, ...options },
  });

/** 换取新令牌：旧链接立即失效，同时充当「复制链接」动作。 */
export const cloudRotateDocSiteToken = (projectId: number, shareId: number) =>
  request<CloudDocSitePublished>(
    "POST",
    `/api/v1/projects/${projectId}/doc-sites/${shareId}/token`,
    { body: {} },
  );

export const cloudRevokeDocSite = (projectId: number, shareId: number) =>
  request<void>("DELETE", `/api/v1/projects/${projectId}/doc-sites/${shareId}`);

/** The collaboration space chosen for row-level sync. */
export interface CloudImportTarget extends CloudProjectRef {
  created: boolean;
  reused: boolean;
}

/**
 * The deterministic default slug (`reqora-<local project id>`) a local project
 * would map to. The picker uses it to prefill "新建协作空间" and to preselect
 * an existing space with the same slug — it is a *suggestion*, never an
 * automatic binding.
 */
export function cloudProjectSlugFor(localProjectId: string): string {
  const suffix = localProjectId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const candidate = `reqora-${suffix}`.slice(0, 119);
  return /^[a-z0-9][a-z0-9-]{1,119}$/.test(candidate)
    ? candidate
    : `reqora-${Date.now().toString(36)}`;
}

/**
 * Resolve the backend project the given local project is *explicitly bound to*.
 *
 * There is deliberately no auto-create and no fallback to "any writable
 * space": silently picking a collaboration space could upload rows into a
 * project the user never chose. When no binding exists (or the bound space no
 * longer exists on the server) this returns `null` and the caller must let the
 * user pick / create a space first. Only an existing cached binding is
 * validated here — `cloudHead` is the cheap liveness check. Row content is
 * never touched. Returns `{ created: false, reused: true }` for a live binding.
 */
export async function ensureCloudProject(
  localProjectId: string,
): Promise<CloudImportTarget | null> {
  const cached = cloudProjectFor(localProjectId);
  if (!cached) return null;
  try {
    await cloudHead(cached.id);
    return { ...cached, created: false, reused: true };
  } catch (error) {
    // Offline: keep the cached target and let the import surface the offline
    // error instead of churning the mapping. A 403/404 means it is gone.
    if (error instanceof CloudError && error.status === 0) throw error;
    forgetCloudProject(localProjectId);
    return null;
  }
}
