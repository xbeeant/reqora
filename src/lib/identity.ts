/**
 * 协作后端的外部身份集成客户端契约。
 *
 * 这一层只负责「协议形状」：能力发现、OIDC 授权 URL / 回调解析、SSO 换发本地
 * JWT、SCIM 载荷与审计留存计划。所有密钥运算都发生在服务端；本文件不持有
 * client secret、不解析 id_token 为可信身份（验签由后端完成），也不改变桌面端
 * 本地数据与同步脱敏语义。
 *
 * 支持的边界见 docs/IDENTITY_AND_AUDIT.md 与 README「支持边界」章节。
 */

import { base64Url } from "./authProviders.ts";

export type LoginMethodType =
  | "local"
  | "oidc"
  | "saml"
  | "ldap"
  | "header"
  | "scim"
  | "pat";

/** README「支持边界」表的机器可读镜像，供设置页展示与测试断言。 */
export interface LoginMethodSpec {
  readonly type: LoginMethodType;
  readonly label: string;
  readonly detail: string;
  readonly unsupported: string;
}

export const SUPPORTED_LOGIN_METHODS: readonly LoginMethodSpec[] = Object.freeze([
  {
    type: "local",
    label: "本地账号口令",
    detail: "BCrypt 口令 + 15 分钟 HS256 访问令牌 + 轮换 refresh token",
    unsupported: "无内置 MFA / 自助找回",
  },
  {
    type: "oidc",
    label: "OIDC 1.0 授权码 + PKCE",
    detail: "discovery / JWKS 验签 / iss·aud·exp·iat·nonce / 一次性 state",
    unsupported: "implicit、hybrid、device flow、外部 IdP token 刷新",
  },
  {
    type: "saml",
    label: "SAML 2.0 SP-initiated",
    detail: "签名 Response/Assertion、Conditions、Audience、InResponseTo",
    unsupported: "IdP-initiated、SLO、加密断言、metadata 自动刷新",
  },
  {
    type: "ldap",
    label: "LDAP / AD 简单绑定",
    detail: "JNDI simple bind，建议 ldaps://",
    unsupported: "Kerberos / SPNEGO、StartTLS 协商、嵌套组解析",
  },
  {
    type: "header",
    label: "反向代理可信头 SSO",
    detail: "可信代理 CIDR + HMAC-SHA256 + 时间戳防重放",
    unsupported: "不校验公网来源的 X-Forwarded-* 头",
  },
  {
    type: "scim",
    label: "SCIM 2.0 用户/组供给",
    detail: "独立 Bearer token（只存摘要）、PATCH、软停用",
    unsupported: "bulk、ETag、组→本地角色自动映射",
  },
  {
    type: "pat",
    label: "个人访问令牌",
    detail: "CLI / CI 用，可设有效期与撤销，只存 SHA-256 摘要",
    unsupported: "不写入桌面端本机凭据库、不参与工作区同步",
  },
]);

export interface ProviderView {
  id: string;
  type: string;
  label: string;
  startPath: string;
}

export interface IdentityCapabilities {
  enabled: boolean;
  methods: ProviderView[];
  scim: boolean;
  pat: boolean;
  jitProvisioning: boolean;
  linkByEmail: boolean;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  user: Record<string, unknown>;
}

export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
  requestId?: string;
  timestamp?: number;
}

export interface OidcStartResult {
  authorizationUrl: string;
  state: string;
  expiresAt: string;
  requestId?: string | null;
}

export interface OidcCallbackPayload {
  providerId: string;
  code: string;
  state: string;
  redirectUri?: string;
}

export interface ParsedCallback {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
}

export type FetchLike = typeof fetch;

/** RFC 7636 S256 PKCE，供桌面端直连 IdP 的场景与协议一致性测试使用。 */
export async function generatePkcePair(): Promise<{ verifier: string; challenge: string }> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = base64Url(raw);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export interface AuthorizationUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  scopes?: string;
  codeChallenge?: string;
  codeChallengeMethod?: "S256" | "plain";
}

export function buildAuthorizationUrl(baseUrl: string, params: AuthorizationUrlParams): string {
  const url = new URL(baseUrl);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", params.scopes ?? "openid profile email");
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  if (params.codeChallenge) {
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", params.codeChallengeMethod ?? "S256");
  }
  return url.toString();
}

/** 校验 state 后再返回 code；state 不匹配一律抛错，绝不把 code 交给调用方。 */
export function parseAuthorizationCallback(input: string | URL, expectedState: string): ParsedCallback {
  const url = input instanceof URL ? input : new URL(input, "http://localhost");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");
  if (state !== expectedState) {
    throw new Error("OIDC state 不匹配，拒绝处理回调（疑似 CSRF / 重放）");
  }
  return {
    code: url.searchParams.get("code"),
    state,
    error,
    errorDescription,
  };
}

function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, "") + path;
}

async function unwrap<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: ApiEnvelope<T> | T;
  try {
    body = JSON.parse(text) as ApiEnvelope<T> | T;
  } catch {
    throw new Error(`响应不是 JSON：${text.slice(0, 120)}`);
  }
  if (!response.ok) {
    const message = isEnvelope(body) ? body.message : `HTTP ${response.status}`;
    throw new Error(message);
  }
  if (isEnvelope(body)) {
    if (body.code !== 0) throw new Error(body.message || `业务错误码 ${body.code}`);
    return body.data;
  }
  return body as T;
}

function isEnvelope<T>(value: ApiEnvelope<T> | T): value is ApiEnvelope<T> {
  return !!value && typeof value === "object" && "code" in value && "data" in value;
}

export async function fetchProviders(
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<IdentityCapabilities> {
  const response = await fetchImpl(joinUrl(baseUrl, "/api/v1/auth/providers"), {
    headers: { Accept: "application/json" },
  });
  return unwrap<IdentityCapabilities>(response);
}

export async function startOidcLogin(
  baseUrl: string,
  providerId: string,
  redirectUri?: string,
  fetchImpl: FetchLike = fetch,
): Promise<OidcStartResult> {
  const response = await fetchImpl(joinUrl(baseUrl, "/api/v1/auth/sso/oidc/start"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId, redirectUri }),
  });
  return unwrap<OidcStartResult>(response);
}

export async function completeOidcLogin(
  baseUrl: string,
  payload: OidcCallbackPayload,
  fetchImpl: FetchLike = fetch,
): Promise<TokenResponse> {
  const response = await fetchImpl(joinUrl(baseUrl, "/api/v1/auth/sso/oidc/callback"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return unwrap<TokenResponse>(response);
}

export interface ScimUserInput {
  userName: string;
  email?: string;
  displayName?: string;
  externalId?: string;
  active?: boolean;
}

export function scimUserPayload(input: ScimUserInput): Record<string, unknown> {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: input.userName,
    externalId: input.externalId,
    displayName: input.displayName ?? input.userName,
    emails: input.email ? [{ value: input.email, type: "work", primary: true }] : [],
    active: input.active ?? true,
  };
}

export function scimDeactivatePayload(): Record<string, unknown> {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", path: "active", value: false }],
  };
}

export interface AuditPolicy {
  retentionDays: number;
  legalHold: boolean;
  archiveEnabled: boolean;
  hashChain?: boolean;
  archiveDir?: string;
  purgeCron?: string;
  [key: string]: unknown;
}

export interface AuditRow {
  id: number;
  createdAt: string;
  legalHold?: number;
  [key: string]: unknown;
}

export interface RetentionPlan {
  purgeable: AuditRow[];
  retained: AuditRow[];
  archived: AuditRow[];
  reason: string;
  cutoffIso: string;
}

/**
 * 留存策略的参考模型（与服务端 AuditRetentionService 同语义），用于客户端
 * 预览与端到端契约测试：法务保全 > 关闭清理 > 先归档后清理 > 逐行 legal_hold。
 * 真正删除只发生在服务端；此函数不修改任何输入。
 */
export function planAuditRetention(
  rows: readonly AuditRow[],
  policy: AuditPolicy,
  now: Date = new Date(),
): RetentionPlan {
  const cutoff = new Date(now.getTime() - Math.max(policy.retentionDays, 0) * 86400000);
  if (policy.legalHold) {
    return {
      purgeable: [],
      retained: [...rows],
      archived: [],
      reason: "legal hold 开启，禁止任何清理",
      cutoffIso: cutoff.toISOString(),
    };
  }
  if (policy.retentionDays <= 0) {
    return {
      purgeable: [],
      retained: [...rows],
      archived: [],
      reason: "retentionDays=0，仅归档不清理",
      cutoffIso: cutoff.toISOString(),
    };
  }
  const purgeable: AuditRow[] = [];
  const retained: AuditRow[] = [];
  for (const row of rows) {
    const created = new Date(row.createdAt).getTime();
    const expired = Number.isFinite(created) && created < cutoff.getTime();
    if (expired && row.legalHold !== 1) purgeable.push(row);
    else retained.push(row);
  }
  return {
    purgeable,
    retained,
    archived: policy.archiveEnabled ? [...purgeable] : [],
    reason: "ok",
    cutoffIso: cutoff.toISOString(),
  };
}

export async function fetchAuditPolicy(
  baseUrl: string,
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<AuditPolicy> {
  const response = await fetchImpl(joinUrl(baseUrl, "/api/v1/audit/retention"), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return unwrap<AuditPolicy>(response);
}

export async function fetchAuditExport(
  baseUrl: string,
  accessToken: string,
  format: "jsonl" | "csv" = "jsonl",
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const response = await fetchImpl(
    joinUrl(baseUrl, `/api/v1/audit/export?format=${format}`),
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) throw new Error(`审计导出失败：HTTP ${response.status}`);
  return response.text();
}
