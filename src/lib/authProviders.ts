/**
 * OAuth 2.0 / AWS SigV4 / mTLS 认证纯逻辑核心。
 *
 * 本模块刻意零运行时依赖：仅使用 WebCrypto（globalThis.crypto.subtle）、
 * TextEncoder、URL、btoa/atob 等浏览器与 Node 22 均内置的 API，因此桌面
 * WebView 与零依赖 CLI 都能直接 import（Node 22 原生擦除类型）。
 *
 * 约定：
 *  - 任何密钥都不得进入 authSummary / 抛出的错误信息 / 日志。
 *  - HMAC 链与 sha256 摘要统一走 WebCrypto；canonicalRequest 因签名是同步
 *    返回值，内部用一份等价的纯 JS SHA-256 计算 payloadHash（结果一致）。
 */

/* -------------------------------------------------------------------------- */
/* 类型                                                                        */
/* -------------------------------------------------------------------------- */

export type AuthType =
  | "none"
  | "inherit"
  | "bearer"
  | "basic"
  | "apiKey"
  | "oauth2"
  | "awsSigV4"
  | "mtls";

export type OAuth2Grant =
  | "authorizationCode"
  | "clientCredentials"
  | "password"
  | "implicit";

export interface OAuth2Auth {
  type: "oauth2";
  grant: OAuth2Grant;
  authUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  audience?: string;
  redirectUri?: string;
  state?: string;
  username?: string;
  password?: string;
  pkce?: boolean;
  codeVerifier?: string;
  code?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: number;
  tokenPrefix?: string;
  clientAuth?: "body" | "basic";
}

export interface AwsSigV4Auth {
  type: "awsSigV4";
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
  signQuery?: boolean;
  expiresIn?: number;
  unsignedPayload?: boolean;
}

export interface MtlsAuth {
  type: "mtls";
  certPem?: string;
  keyPem?: string;
  caPem?: string;
  p12Base64?: string;
  passphrase?: string;
  minTlsVersion?: "1.2" | "1.3";
  serverName?: string;
}

export interface SigV4Options {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
  timestamp?: Date;
  signQuery?: boolean;
  expiresIn?: number;
  unsignedPayload?: boolean;
}

/* -------------------------------------------------------------------------- */
/* 脱敏字段                                                                    */
/* -------------------------------------------------------------------------- */

/** 用于脱敏 / 打码的敏感字段名（含常见别名）。 */
export const AUTH_SECRET_FIELDS: readonly string[] = Object.freeze([
  "token",
  "password",
  "clientSecret",
  "secretAccessKey",
  "sessionToken",
  "accessToken",
  "refreshToken",
  "code",
  "codeVerifier",
  "keyPem",
  "certPem",
  "caPem",
  "p12Base64",
  "passphrase",
  "value",
  "state",
  // 常见别名 / 敏感请求头
  "secret",
  "apiKey",
  "privateKey",
  "idToken",
  "client_secret",
  "authorization",
  "secretKey",
  "cookie",
]);

function normalizeSecretKey(key: string): string {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

const SECRET_FIELD_SET: Set<string> = new Set(
  AUTH_SECRET_FIELDS.map(normalizeSecretKey),
);

/** 判断一个字段名是否属于敏感字段（大小写、连字符、下划线均不敏感）。 */
export function isSecretAuthField(key: string): boolean {
  return SECRET_FIELD_SET.has(normalizeSecretKey(key));
}

/* -------------------------------------------------------------------------- */
/* 通用小工具                                                                  */
/* -------------------------------------------------------------------------- */

const TE = new TextEncoder();

function base64Standard(input: string): string {
  const bytes = TE.encode(input);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

function bodyBytes(body?: string | Uint8Array): Uint8Array {
  if (body === undefined || body === null || body === "") return new Uint8Array(0);
  if (typeof body === "string") return TE.encode(body);
  return body;
}

/** 转成纯 ArrayBuffer，满足 WebCrypto 的 BufferSource 严格类型。 */
function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(u.byteLength);
  copy.set(u);
  return copy.buffer;
}

function isObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isValidUrl(s: unknown): boolean {
  if (typeof s !== "string" || !s.trim()) return false;
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

function isHttpUrl(s: unknown): boolean {
  if (typeof s !== "string" || !s.trim()) return false;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* 纯 JS SHA-256（同步）—— 仅 canonicalRequest 内部使用，结果与 WebCrypto 一致 */
/* -------------------------------------------------------------------------- */

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256HexSync(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? TE.encode(data) : data;
  const bitLen = bytes.length * 8;
  const total = Math.ceil((bytes.length + 1 + 8) / 64) * 64;
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const dv = new DataView(msg.buffer);
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(total - 4, bitLen >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3];
    let e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 8; i++) out += h[i].toString(16).padStart(8, "0");
  return out;
}

/** WebCrypto SHA-256，返回小写 hex。 */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? TE.encode(data) : data;
  const buf = await globalThis.crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return hex(new Uint8Array(buf));
}

/* -------------------------------------------------------------------------- */
/* 默认值 / 归一化 / 校验 / 标签 / 摘要                                        */
/* -------------------------------------------------------------------------- */

const AUTH_TYPES: AuthType[] = [
  "none", "inherit", "bearer", "basic", "apiKey", "oauth2", "awsSigV4", "mtls",
];

/** 返回该类型的完整默认对象（含所有必填字段）。 */
export function defaultAuth(type: AuthType): any {
  switch (type) {
    case "inherit":
      return { type: "inherit" };
    case "bearer":
      return { type: "bearer", token: "", tokenPrefix: "Bearer" };
    case "basic":
      return { type: "basic", username: "", password: "" };
    case "apiKey":
      return { type: "apiKey", key: "", value: "", location: "header" };
    case "oauth2":
      return {
        type: "oauth2",
        grant: "authorizationCode",
        authUrl: "", tokenUrl: "", clientId: "", clientSecret: "",
        scope: "", audience: "", redirectUri: "", state: "",
        username: "", password: "", pkce: false, codeVerifier: "",
        code: "", accessToken: "", refreshToken: "", tokenType: "Bearer",
        expiresAt: 0, tokenPrefix: "Bearer", clientAuth: "body",
      };
    case "awsSigV4":
      return {
        type: "awsSigV4",
        accessKeyId: "", secretAccessKey: "", sessionToken: "",
        region: "us-east-1", service: "execute-api",
        signQuery: false, expiresIn: 3600, unsignedPayload: false,
      };
    case "mtls":
      return {
        type: "mtls",
        certPem: "", keyPem: "", caPem: "", p12Base64: "", passphrase: "",
        minTlsVersion: "1.2", serverName: "",
      };
    case "none":
    default:
      return { type: "none" };
  }
}

/** 容错补全默认值；未知 type 降级 none。 */
export function normalizeAuth(raw: unknown): any {
  let r: Record<string, any> = {};
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      if (isObject(p)) r = p;
    } catch {
      r = {};
    }
  } else if (isObject(raw)) {
    r = raw;
  }
  const type: AuthType = AUTH_TYPES.includes(r.type) ? r.type : "none";
  const merged: Record<string, any> = { ...defaultAuth(type) };
  for (const [k, v] of Object.entries(r)) {
    if (k === "type") continue;
    if (v !== undefined) merged[k] = v;
  }
  merged.type = type;
  if (type === "oauth2") {
    if (!["authorizationCode", "clientCredentials", "password", "implicit"].includes(merged.grant)) {
      merged.grant = "authorizationCode";
    }
    if (!["body", "basic"].includes(merged.clientAuth)) merged.clientAuth = "body";
  }
  if (type === "apiKey") {
    // 以 location 为准；in / addTo 仅作旧数据兼容读取，绝不输出。
    const rawLoc = r.location ?? r.in ?? r.addTo;
    const loc = rawLoc !== undefined ? String(rawLoc).toLowerCase() : "header";
    merged.location = loc === "query" ? "query" : "header";
    delete merged.in;
    delete merged.addTo;
  }
  if (type === "mtls") {
    if (!["1.2", "1.3"].includes(merged.minTlsVersion)) merged.minTlsVersion = "1.2";
  }
  return merged;
}

function required(errors: string[], value: unknown, label: string): void {
  if (typeof value !== "string" || !value.trim()) errors.push(`缺少${label}`);
}

/** 中文错误信息数组，校验必填项 / URL / PEM 形态。 */
export function validateAuth(auth: any): string[] {
  const errors: string[] = [];
  if (!isObject(auth)) return ["认证配置无效"];
  switch (auth.type) {
    case "none":
    case "inherit":
      break;
    case "bearer":
      required(errors, auth.token ?? auth.value, "Bearer 令牌");
      break;
    case "basic":
      required(errors, auth.username, "用户名");
      required(errors, auth.password, "密码");
      break;
    case "apiKey": {
      required(errors, auth.key ?? auth.name, "API Key 名称");
      required(errors, auth.value, "API Key 值");
      const loc = String(auth.location ?? auth.in ?? auth.addTo ?? "header").toLowerCase();
      if (loc !== "header" && loc !== "query") errors.push("API Key 位置必须为 header 或 query");
      break;
    }
    case "oauth2": {
      const grant = auth.grant;
      if (!["authorizationCode", "clientCredentials", "password", "implicit"].includes(grant)) {
        errors.push("OAuth 2.0 授权模式无效");
        break;
      }
      if (grant !== "implicit" && !isHttpUrl(auth.tokenUrl)) {
        errors.push("令牌端点 tokenUrl 必须是有效的 http(s) URL");
      }
      if ((grant === "authorizationCode" || grant === "implicit") && !isHttpUrl(auth.authUrl)) {
        errors.push("授权端点 authUrl 必须是有效的 http(s) URL");
      }
      if (grant === "authorizationCode" || grant === "clientCredentials" || grant === "implicit") {
        required(errors, auth.clientId, "客户端 ID（clientId）");
      }
      if (grant === "authorizationCode" && auth.redirectUri && !isValidUrl(auth.redirectUri)) {
        errors.push("重定向地址 redirectUri 不是有效的 URL");
      }
      if (grant === "password") {
        required(errors, auth.username, "用户名");
        required(errors, auth.password, "密码");
      }
      if (auth.clientAuth && !["body", "basic"].includes(auth.clientAuth)) {
        errors.push("客户端认证方式 clientAuth 无效");
      }
      if (auth.pkce && auth.codeVerifier) {
        const v = auth.codeVerifier;
        if (typeof v !== "string" || v.length < 43 || v.length > 128) {
          errors.push("PKCE codeVerifier 长度必须为 43~128 个字符");
        }
      }
      for (const f of ["authUrl", "tokenUrl"]) {
        const v = auth[f];
        if (typeof v === "string" && v.trim() && !isHttpUrl(v)) {
          errors.push(`${f} 不是有效的 http(s) URL`);
        }
      }
      break;
    }
    case "awsSigV4":
      required(errors, auth.accessKeyId, "AWS Access Key ID");
      required(errors, auth.secretAccessKey, "AWS Secret Access Key");
      required(errors, auth.region, "AWS 区域（region）");
      required(errors, auth.service, "AWS 服务（service）");
      if (auth.expiresIn !== undefined && auth.expiresIn !== null && auth.expiresIn !== "") {
        const n = Number(auth.expiresIn);
        if (!Number.isFinite(n) || n < 1 || n > 604800) {
          errors.push("预签名有效期 expiresIn 必须为 1~604800 秒");
        }
      }
      break;
    case "mtls": {
      const p12 = String(auth.p12Base64 ?? "").trim();
      const cert = String(auth.certPem ?? "").trim();
      const key = String(auth.keyPem ?? "").trim();
      const ca = String(auth.caPem ?? "").trim();
      if (!p12) {
        if (!cert) errors.push("缺少客户端证书（certPem）");
        else if (!cert.includes("BEGIN CERTIFICATE")) errors.push("客户端证书 certPem 不是有效的 PEM（缺少 BEGIN CERTIFICATE）");
        if (!key) errors.push("缺少私钥（keyPem）");
        else if (!key.includes("PRIVATE KEY")) errors.push("私钥 keyPem 不是有效的 PEM（缺少 PRIVATE KEY）");
      }
      if (ca && !ca.includes("BEGIN CERTIFICATE")) errors.push("CA 证书 caPem 不是有效的 PEM");
      if (auth.minTlsVersion && !["1.2", "1.3"].includes(auth.minTlsVersion)) {
        errors.push("最低 TLS 版本无效");
      }
      break;
    }
    default:
      errors.push(`未知的认证类型：${String(auth.type)}`);
  }
  return errors;
}

/** 中文显示名。 */
export function authLabel(auth: any): string {
  const t = isObject(auth) ? auth.type : "none";
  switch (t) {
    case "inherit": return "继承上级";
    case "bearer": return "Bearer Token";
    case "basic": return "Basic 认证";
    case "apiKey": return "API Key";
    case "oauth2": return "OAuth 2.0";
    case "awsSigV4": return "AWS SigV4";
    case "mtls": return "mTLS 双向证书";
    case "none":
    default: return "无认证";
  }
}

/** 不含任何密钥的描述，用于文档 / 导出。 */
export function authSummary(auth: any): string {
  if (!isObject(auth)) return "无认证";
  switch (auth.type) {
    case "inherit":
      return "继承上级认证";
    case "bearer":
      return "Bearer Token 认证";
    case "basic":
      return `Basic 认证（用户名：${auth.username || "未设置"}）`;
    case "apiKey": {
      const loc = String(auth.location ?? auth.in ?? auth.addTo ?? "header").toLowerCase();
      return `API Key 认证（${loc === "query" ? "查询参数" : "请求头"} ${auth.key ?? auth.name ?? ""}）`;
    }
    case "oauth2": {
      const map: Record<string, string> = {
        authorizationCode: "授权码模式",
        clientCredentials: "客户端凭证模式",
        password: "密码模式",
        implicit: "隐式模式",
      };
      const tokenState = auth.accessToken ? "已获取访问令牌" : "未获取访问令牌";
      return `OAuth 2.0（${map[auth.grant] ?? "未知模式"}，${tokenState}）`;
    }
    case "awsSigV4":
      return `AWS SigV4 签名（区域 ${auth.region ?? ""}，服务 ${auth.service ?? ""}${auth.signQuery ? "，查询参数预签名" : ""}）`;
    case "mtls": {
      const n = normalizeMtls(auth as any);
      const desc = n.kind === "pem" ? "PEM 证书" : n.kind === "pkcs12" ? "PKCS#12 证书" : "未配置证书";
      return `mTLS 双向证书（${desc}）`;
    }
    case "none":
    default:
      return "无认证";
  }
}

/* -------------------------------------------------------------------------- */
/* OAuth 2.0 / PKCE                                                            */
/* -------------------------------------------------------------------------- */

/** 生成 PKCE verifier / challenge（S256，base64url 无 padding）。 */
export async function generatePkcePair(): Promise<{ verifier: string; challenge: string; method: "S256" }> {
  const random = new Uint8Array(32);
  globalThis.crypto.getRandomValues(random);
  const verifier = base64Url(random); // 32 字节 -> 43 字符
  const digest = await globalThis.crypto.subtle.digest("SHA-256", TE.encode(verifier));
  const challenge = base64Url(new Uint8Array(digest));
  return { verifier, challenge, method: "S256" };
}

/** 构造授权端点 URL（authorizationCode / implicit）。 */
export function buildAuthorizeUrl(auth: OAuth2Auth, state: string, challenge?: string): string {
  const responseType = auth.grant === "implicit" ? "token" : "code";
  const params: Array<[string, string]> = [["response_type", responseType]];
  if (auth.clientId) params.push(["client_id", auth.clientId]);
  if (auth.redirectUri) params.push(["redirect_uri", auth.redirectUri]);
  if (auth.scope) params.push(["scope", auth.scope]);
  params.push(["state", state]);
  if (auth.audience) params.push(["audience", auth.audience]);
  if (challenge) {
    params.push(["code_challenge", challenge]);
    params.push(["code_challenge_method", "S256"]);
  }
  const query = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const base = auth.authUrl || "";
  if (!base) return `?${query}`;
  const sep = base.includes("?")
    ? base.endsWith("?") || base.endsWith("&") ? "" : "&"
    : "?";
  return `${base}${sep}${query}`;
}

/** 解析 token 端点响应，兼容 expires_in / expires_at，容忍 JSON 字符串。 */
export function parseTokenResponse(
  payload: unknown,
  now: number = Date.now(),
): { accessToken: string; refreshToken?: string; tokenType: string; expiresAt?: number; scope?: string } {
  let p: any = payload;
  if (typeof payload === "string") {
    try {
      p = JSON.parse(payload);
    } catch {
      p = {};
    }
  }
  if (!isObject(p)) p = {};
  const accessToken = String(p.access_token ?? p.accessToken ?? "");
  const tokenType = String(p.token_type ?? p.tokenType ?? "Bearer") || "Bearer";
  const out: {
    accessToken: string;
    refreshToken?: string;
    tokenType: string;
    expiresAt?: number;
    scope?: string;
  } = { accessToken, tokenType };

  const refresh = p.refresh_token ?? p.refreshToken;
  if (refresh !== undefined && refresh !== null && refresh !== "") out.refreshToken = String(refresh);

  const expIn = p.expires_in ?? p.expiresIn;
  const expAt = p.expires_at ?? p.expiresAt;
  if (expIn !== undefined && expIn !== null && expIn !== "") {
    const n = Number(expIn);
    if (Number.isFinite(n)) out.expiresAt = now + n * 1000;
  } else if (expAt !== undefined && expAt !== null && expAt !== "") {
    if (typeof expAt === "number" || /^\d+(\.\d+)?$/.test(String(expAt))) {
      let ms = Number(expAt);
      if (ms < 1e12) ms *= 1000; // 秒 -> 毫秒
      out.expiresAt = ms;
    } else {
      const t = Date.parse(String(expAt));
      if (!Number.isNaN(t)) out.expiresAt = t;
    }
  }
  if (p.scope !== undefined && p.scope !== null) out.scope = String(p.scope);
  return out;
}

/** 默认提前 60s；有 refreshToken 且过期（或无 accessToken）返回 true。 */
export function tokenNeedsRefresh(auth: OAuth2Auth, now: number = Date.now(), skewMs: number = 60000): boolean {
  if (!isObject(auth) || auth.type !== "oauth2") return false;
  if (!auth.refreshToken) return false;
  if (!auth.accessToken) return true;
  const e = auth.expiresAt;
  if (!e || !Number.isFinite(e)) return false;
  return now + skewMs >= e;
}

function oauth2Expired(auth: any, now: number = Date.now(), skewMs: number = 60000): boolean {
  const e = auth?.expiresAt;
  return typeof e === "number" && Number.isFinite(e) && e > 0 && now + skewMs >= e;
}

/** 合并 token，保留旧 refreshToken 若新值缺失。 */
export function mergeOAuth2Token(
  auth: OAuth2Auth,
  token: ReturnType<typeof parseTokenResponse>,
): OAuth2Auth {
  return {
    ...auth,
    accessToken: token.accessToken ?? auth.accessToken,
    refreshToken: token.refreshToken ?? auth.refreshToken,
    tokenType: token.tokenType ?? auth.tokenType ?? "Bearer",
    expiresAt: token.expiresAt ?? auth.expiresAt,
  };
}

/** 生成 token 端点请求（clientAuth=basic 时加 Authorization）。 */
export function oauth2TokenRequest(
  auth: OAuth2Auth,
  mode: "authorizationCode" | "clientCredentials" | "password" | "refreshToken",
  code?: string,
  codeVerifier?: string,
): { url: string; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  const params: Array<[string, string]> = [];
  const push = (k: string, v: unknown): void => {
    if (v !== undefined && v !== null && v !== "") params.push([k, String(v)]);
  };
  const clientId = auth.clientId ?? "";
  const clientSecret = auth.clientSecret ?? "";
  if (auth.clientAuth === "basic") {
    headers["Authorization"] = `Basic ${base64Standard(`${clientId}:${clientSecret}`)}`;
  } else {
    push("client_id", clientId);
    push("client_secret", clientSecret);
  }
  switch (mode) {
    case "authorizationCode":
      push("grant_type", "authorization_code");
      push("code", code ?? auth.code);
      push("redirect_uri", auth.redirectUri);
      push("code_verifier", codeVerifier ?? auth.codeVerifier);
      break;
    case "clientCredentials":
      push("grant_type", "client_credentials");
      push("scope", auth.scope);
      push("audience", auth.audience);
      break;
    case "password":
      push("grant_type", "password");
      push("username", auth.username);
      push("password", auth.password);
      push("scope", auth.scope);
      push("audience", auth.audience);
      break;
    case "refreshToken":
      push("grant_type", "refresh_token");
      push("refresh_token", auth.refreshToken);
      push("scope", auth.scope);
      break;
  }
  const body = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return { url: auth.tokenUrl ?? "", headers, body };
}

/* -------------------------------------------------------------------------- */
/* AWS SigV4                                                                   */
/* -------------------------------------------------------------------------- */

function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function amzTimestamp(date: Date): { amzDate: string; shortDate: string } {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, shortDate: amzDate.slice(0, 8) };
}

function scopeString(shortDate: string, region: string, service: string): string {
  return `${shortDate}/${region}/${service}/aws4_request`;
}

function splitUrl(raw: string): { host: string; pathname: string; params: Array<[string, string]> } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    u = new URL(raw, "https://localhost");
  }
  const params: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams) params.push([k, v]);
  return { host: u.host, pathname: u.pathname || "/", params };
}

/** URI-encode 每段路径，先解码再编码以避免双重编码（S3）。 */
function canonicalUri(pathname: string): string {
  if (!pathname) return "/";
  return pathname
    .split("/")
    .map((seg) => {
      let decoded = seg;
      if (/%[0-9A-Fa-f]{2}/.test(seg)) {
        try {
          decoded = decodeURIComponent(seg);
        } catch {
          decoded = seg;
        }
      }
      return rfc3986(decoded);
    })
    .join("/");
}

/** query 参数按键再按值排序并 RFC3986 编码。 */
function canonicalQuery(entries: Array<[string, string]>): string {
  const encoded = entries.map(([k, v]) => [rfc3986(k), rfc3986(v)] as [string, string]);
  encoded.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  return encoded.map(([k, v]) => `${k}=${v}`).join("&");
}

function buildCanonicalHeaders(input: Record<string, string>): { headers: string; signed: string } {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    const name = k.toLowerCase().trim();
    const value = String(v ?? "").trim().replace(/\s+/g, " ");
    lower[name] = value;
  }
  const names = Object.keys(lower).sort();
  const headers = names.map((n) => `${n}:${lower[n]}\n`).join("");
  return { headers, signed: names.join(";") };
}

interface CanonicalData {
  canonical: string;
  signed: string;
  payloadHash: string;
  amzDate: string;
  shortDate: string;
  scope: string;
  headerMap: Record<string, string>;
}

function headerSigningData(o: SigV4Options): CanonicalData {
  const date = o.timestamp ?? new Date();
  const { amzDate, shortDate } = amzTimestamp(date);
  const scope = scopeString(shortDate, o.region, o.service);
  const { host, pathname, params } = splitUrl(o.url);
  const uri = canonicalUri(pathname);
  const query = canonicalQuery(params);
  const payloadHash = o.unsignedPayload ? "UNSIGNED-PAYLOAD" : sha256HexSync(bodyBytes(o.body));

  const headerMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    const lk = k.toLowerCase();
    if (lk === "authorization") continue;
    headerMap[lk] = String(v ?? "");
  }
  headerMap["host"] = host;
  headerMap["x-amz-date"] = amzDate;
  headerMap["x-amz-content-sha256"] = o.unsignedPayload ? "UNSIGNED-PAYLOAD" : payloadHash;
  if (o.sessionToken) headerMap["x-amz-security-token"] = o.sessionToken;

  const { headers: canonicalHeaders, signed } = buildCanonicalHeaders(headerMap);
  const canonical =
    o.method.toUpperCase() + "\n" +
    uri + "\n" +
    query + "\n" +
    canonicalHeaders + "\n" +
    signed + "\n" +
    payloadHash;
  return { canonical, signed, payloadHash, amzDate, shortDate, scope, headerMap };
}

/** 严格按 AWS SigV4 生成规范请求（header 签名模式）。 */
export function canonicalRequest(o: SigV4Options & { timestamp?: Date }): {
  canonical: string;
  signedHeaders: string;
  payloadHash: string;
  amzDate: string;
  shortDate: string;
  scope: string;
} {
  const d = headerSigningData(o);
  return {
    canonical: d.canonical,
    signedHeaders: d.signed,
    payloadHash: d.payloadHash,
    amzDate: d.amzDate,
    shortDate: d.shortDate,
    scope: d.scope,
  };
}

async function hmac(keyBytes: Uint8Array | string, data: string): Promise<Uint8Array> {
  const raw = typeof keyBytes === "string" ? TE.encode(keyBytes) : keyBytes;
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw", toArrayBuffer(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", cryptoKey, toArrayBuffer(TE.encode(data)));
  return new Uint8Array(sig);
}

async function signingKey(secret: string, shortDate: string, region: string, service: string): Promise<Uint8Array> {
  let k = await hmac("AWS4" + secret, shortDate);
  k = await hmac(k, region);
  k = await hmac(k, service);
  k = await hmac(k, "aws4_request");
  return k;
}

function presignData(o: SigV4Options, date: Date): {
  canonical: string;
  amzDate: string;
  shortDate: string;
  scope: string;
  allParams: Array<[string, string]>;
} {
  const { amzDate, shortDate } = amzTimestamp(date);
  const scope = scopeString(shortDate, o.region, o.service);
  const { host, pathname, params } = splitUrl(o.url);
  const uri = canonicalUri(pathname);
  const expires = Math.max(1, Math.min(604800, Math.floor(o.expiresIn ?? 3600)));
  const extra: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${o.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expires)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  if (o.sessionToken) extra.push(["X-Amz-Security-Token", o.sessionToken]);
  const allParams: Array<[string, string]> = [...params, ...extra];
  const query = canonicalQuery(allParams);
  const canonicalHeaders = `host:${host}\n`;
  const canonical =
    o.method.toUpperCase() + "\n" +
    uri + "\n" +
    query + "\n" +
    canonicalHeaders + "\n" +
    "host" + "\n" +
    "UNSIGNED-PAYLOAD";
  return { canonical, amzDate, shortDate, scope, allParams };
}

/** header 签名或 query 预签名。 */
export async function signAwsSigV4(o: SigV4Options): Promise<{
  headers: Record<string, string>;
  query: Record<string, string>;
  authorization: string;
  amzDate: string;
}> {
  const date = o.timestamp ?? new Date();
  if (o.signQuery) {
    const p = presignData(o, date);
    const stringToSign = `AWS4-HMAC-SHA256\n${p.amzDate}\n${p.scope}\n${await sha256Hex(p.canonical)}`;
    const kSigning = await signingKey(o.secretAccessKey, p.shortDate, o.region, o.service);
    const sig = hex(await hmac(kSigning, stringToSign));
    const query: Record<string, string> = {};
    for (const [k, v] of p.allParams) query[k] = v;
    query["X-Amz-Signature"] = sig;
    return { headers: {}, query, authorization: "", amzDate: p.amzDate };
  }
  const d = headerSigningData({ ...o, timestamp: date });
  const stringToSign = `AWS4-HMAC-SHA256\n${d.amzDate}\n${d.scope}\n${await sha256Hex(d.canonical)}`;
  const kSigning = await signingKey(o.secretAccessKey, d.shortDate, o.region, o.service);
  const sig = hex(await hmac(kSigning, stringToSign));
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${d.scope}, ` +
    `SignedHeaders=${d.signed}, Signature=${sig}`;
  const headers: Record<string, string> = { ...d.headerMap };
  headers["Authorization"] = authorization;
  return { headers, query: {}, authorization, amzDate: d.amzDate };
}

/* -------------------------------------------------------------------------- */
/* mTLS                                                                        */
/* -------------------------------------------------------------------------- */

/** PEM 时把 key+cert 拼成单一 PEM 供 reqwest Identity::from_pem；校验证书标记。 */
export function normalizeMtls(auth: MtlsAuth): {
  kind: "pem" | "pkcs12" | "none";
  identityPem?: string;
  caPem?: string;
  passphrase?: string;
} {
  const ca = String(auth?.caPem ?? "").trim();
  const passphrase = String(auth?.passphrase ?? "").trim();
  const extras = { caPem: ca || undefined, passphrase: passphrase || undefined };
  const p12 = String(auth?.p12Base64 ?? "").trim();
  if (p12) return { kind: "pkcs12", ...extras };

  const cert = String(auth?.certPem ?? "").trim();
  const key = String(auth?.keyPem ?? "").trim();
  if (!cert && !key) return { kind: "none" };
  const certOk = cert.includes("BEGIN CERTIFICATE") && cert.includes("END CERTIFICATE");
  const keyOk = key.includes("PRIVATE KEY");
  if (!certOk || !keyOk) return { kind: "none" };
  return { kind: "pem", identityPem: `${key}\n${cert}\n`, ...extras };
}

/* -------------------------------------------------------------------------- */
/* 统一应用（CLI / MCP）                                                       */
/* -------------------------------------------------------------------------- */

/** 统一给 CLI/MCP 用；返回注入后的 headers（不会修改入参）。 */
export async function applyAuthHeaders(
  auth: any,
  headers: Record<string, string>,
  options?: { url?: string; method?: string; body?: string; now?: number },
): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...(headers ?? {}) };
  if (!isObject(auth)) return out;
  switch (auth.type) {
    case "none":
    case "inherit":
    case "mtls":
      break;
    case "bearer": {
      const token = auth.token ?? auth.value ?? auth.bearer ?? "";
      const prefix = auth.tokenPrefix ?? "Bearer";
      if (token) out["Authorization"] = `${prefix} ${token}`.trim();
      break;
    }
    case "basic": {
      const u = auth.username ?? auth.user ?? "";
      const p = auth.password ?? "";
      out["Authorization"] = `Basic ${base64Standard(`${u}:${p}`)}`;
      break;
    }
    case "apiKey": {
      const loc = String(auth.location ?? auth.in ?? auth.addTo ?? "header").toLowerCase();
      if (loc === "header") {
        const k = auth.key ?? auth.name ?? "X-API-Key";
        const v = auth.value ?? "";
        if (k) out[k] = v;
      }
      break;
    }
    case "oauth2": {
      const now = options?.now;
      if (oauth2Expired(auth, now) || tokenNeedsRefresh(auth as any, now)) {
        throw new Error("OAuth 2.0 访问令牌已过期或即将过期，请先刷新令牌后再发送请求");
      }
      const token = auth.accessToken ?? auth.token ?? "";
      if (token) {
        const prefix = auth.tokenPrefix ?? auth.tokenType ?? "Bearer";
        out["Authorization"] = `${prefix} ${token}`.trim();
      }
      break;
    }
    case "awsSigV4": {
      const url = options?.url ?? "";
      if (!url) break;
      const signed = await signAwsSigV4({
        method: options?.method ?? "GET",
        url,
        headers: out,
        body: options?.body,
        accessKeyId: auth.accessKeyId,
        secretAccessKey: auth.secretAccessKey,
        sessionToken: auth.sessionToken,
        region: auth.region,
        service: auth.service,
        signQuery: auth.signQuery,
        expiresIn: auth.expiresIn,
        unsignedPayload: auth.unsignedPayload,
      });
      for (const [k, v] of Object.entries(signed.headers)) out[k] = v;
      break;
    }
    default:
      break;
  }
  return out;
}

/** apiKey(query) 的 query 注入；SigV4 预签名由调用方走 signAwsSigV4。 */
export function applyAuthQuery(auth: any, url: string): string {
  if (!isObject(auth) || auth.type !== "apiKey") return url;
  const loc = String(auth.location ?? auth.in ?? auth.addTo ?? "header").toLowerCase();
  if (loc !== "query") return url;
  const k = auth.key ?? auth.name ?? "key";
  const v = auth.value ?? "";
  const pair = `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
  if (!url) return `?${pair}`;
  const sep = url.includes("?")
    ? url.endsWith("?") || url.endsWith("&") ? "" : "&"
    : "?";
  return `${url}${sep}${pair}`;
}
