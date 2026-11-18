/**
 * GENERATED FILE — DO NOT EDIT BY HAND · reqora.wire.v1
 *
 * Rust serde wire 契约的 TS 镜像，由 `scripts/generate-contract.mjs` 从
 *   src-tauri/crates/reqora-core/src/models.rs
 *   src-tauri/crates/reqora-core/src/service/timing.rs
 * 生成。字段 / 变体名严格按 serde 真实线上行为命名（含 struct 变体字段
 * 必须显式 rename 的 serde#1615 语义）。
 *
 * 重新生成：`bun run contract:gen`　校验漂移：`bun run contract:check`
 * 手写侧的覆盖护栏：`test/contractSync.test.mjs`
 */

export type Variables = Record<string, string>;

export interface KeyValue {
  id?: string;
  key?: string;
  value?: string;
  enabled?: boolean;
}

export interface FormPart {
  id?: string;
  key?: string;
  value?: string;
  enabled?: boolean;
  file?: boolean;
  fileName?: string;
  contentType?: string;
}

export type BodySpec =
  { type: "none" }
  | { type: "json"; content?: string; }
  | { type: "raw"; content?: string; contentType?: string; }
  | { type: "formUrlEncoded"; items?: KeyValue[]; }
  | { type: "formData"; items?: FormPart[]; }
  | { type: "binary"; data?: string; fileName?: string; contentType?: string; }
  | { type: "graphql"; query?: string; variables?: string; }
  ;

export type ApiKeyLocation = "header" | "query";

export type AuthSpec =
  { type: "none" }
  | { type: "bearer"; token?: string; }
  | { type: "basic"; username?: string; password?: string; }
  | { type: "apiKey"; key?: string; value?: string; location?: ApiKeyLocation; }
  | { type: "oauth2"; grant?: string; authUrl?: string; tokenUrl?: string; clientId?: string; clientSecret?: string; scope?: string; audience?: string; redirectUri?: string; state?: string; username?: string; password?: string; pkce?: boolean; codeVerifier?: string; code?: string; accessToken?: string; refreshToken?: string; tokenType?: string; expiresAt?: number; tokenPrefix?: string; clientAuth?: string; }
  | { type: "awsSigV4"; accessKeyId?: string; secretAccessKey?: string; sessionToken?: string; region?: string; service?: string; signQuery?: boolean; expiresIn?: number; unsignedPayload?: boolean; }
  | { type: "mtls"; certPem?: string; keyPem?: string; caPem?: string; p12Base64?: string; passphrase?: string; minTlsVersion?: string; serverName?: string; }
  ;

export interface RequestSpec {
  id?: string;
  name?: string;
  method: string;
  url: string;
  headers?: KeyValue[];
  query?: KeyValue[];
  body?: BodySpec;
  auth?: AuthSpec;
  variables?: Variables;
  timeoutSecs?: number;
  followRedirects?: boolean;
  verifyTls?: boolean;
  proxyUrl?: string;
  useCookies?: boolean;
  httpVersion?: string;
}

export interface ResponseHeader {
  name: string;
  value: string;
}

export interface ResponsePayload {
  requestId: string;
  status: number;
  statusText: string;
  ok: boolean;
  timeMs: number;
  size: number;
  url: string;
  resolvedUrl: string;
  missingVariables: string[];
  headers: ResponseHeader[];
  body: string;
  bodyKind: string;
  truncated: boolean;
  timings: ResponseTimings;
  rawRequest: string;
  rawResponse: string;
  bodyRef?: string;
  contentEncoding?: string;
  totalLines: number;
  inlineBytes: number;
}

/** A byte window into a spooled response body, returned by `read_response_body`. */
export interface BodySlice {
  bodyId: string;
  offset: number;
  length: number;
  total: number;
  encoding: string;
  data: string;
}

/** A page of decoded lines, returned by `read_response_lines`. Lines carry no newline characters; binary bodies return each line's bytes as base64. */
export interface BodyLines {
  bodyId: string;
  startLine: number;
  lineCount: number;
  totalLines: number;
  lines: string[];
}

/** Metadata about a spooled response body, returned by `response_body_info`. */
export interface BodyInfo {
  bodyId: string;
  size: number;
  totalLines: number;
  bodyKind: string;
  contentEncoding: string;
}

export interface RuntimeInfo {
  status: string;
  version: string;
  timeoutSecs: number;
  maxResponseBytes: number;
  logLevel: string;
  workspacePath: string;
}

/** Phase breakdown returned to the UI. All durations are milliseconds. */
export interface ResponseTimings {
  dnsMs: number;
  tcpMs: number;
  tlsMs: number;
  tlsMerged: boolean;
  serverMs: number;
  transferMs: number;
  totalMs: number;
  reused: boolean;
  protocol: string;
}

