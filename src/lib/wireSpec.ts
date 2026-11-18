/**
 * The ONE place that builds the Rust `RequestSpec` wire contract.
 *
 * Both the desktop (Tauri IPC `send_request`) and the out-of-app shells
 * (CLI / MCP -> `reqora-send` sidecar) call this function, so the payload
 * handed to `reqora-core::HttpService` is byte-for-byte the same shape no
 * matter which shell started the request. Previously `api.ts::toSpec` and
 * `bin/requester.mjs` each assembled their own request, which is why CI could
 * disagree with the app about auth, variables, proxy or redirect behaviour.
 *
 * Deliberately dependency-free (only pure `./auth.ts` / `./template.ts`), so
 * Node 22 can strip the types and the MCP single-file bundle can inline it.
 *
 * IMPORTANT: `{{...}}` placeholders are intentionally left untouched. Rust's
 * single-pass resolver (`reqora-core::service::template`) is authoritative and
 * evaluates dynamic tokens such as `{{$uuid}}` freshly on every attempt. Path
 * variables (`:id` / `{id}`) are resolved here because they are URL-only UI
 * state, exactly as the desktop does it.
 */

import type { RequestDraft } from "../types.ts";
import { toWireAuth } from "./auth.ts";
import { applyPathVariables, variablesFrom } from "./template.ts";
import { buildSoapEnvelope, buildWsseHeader, soapActionHeader, soapContentType } from "./soap.ts";

/** "auto" | "http1" | "http2" | "http3" — mirrors Rust's RequestSpec. */
export type WireHttpVersion = "auto" | "http1" | "http2" | "http3";

/** Only the network-relevant subset of WorkspaceSettings crosses the wire. */
export interface WireSpecSettings {
  timeoutSecs?: number;
  followRedirects?: boolean;
  verifyTls?: boolean;
  proxyUrl?: string;
  manageCookies?: boolean;
  /** Global default; a request-level `httpVersion` overrides it. */
  httpVersion?: WireHttpVersion;
}

export interface WireSpecOptions {
  variables: Record<string, string>;
  settings: WireSpecSettings;
}

/** Mirrors `reqora-core::models::RequestSpec` (serde rename_all = "camelCase"). */
export interface WireSpec {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: unknown[];
  query: unknown[];
  body: unknown;
  auth: unknown;
  variables: Record<string, string>;
  timeoutSecs?: number;
  followRedirects?: boolean;
  verifyTls?: boolean;
  proxyUrl?: string;
  useCookies?: boolean;
  /** HTTP/1.1 / HTTP/2 / HTTP/3 (QUIC) policy for this request. */
  httpVersion?: WireHttpVersion;
}

/** Rust's `Variables` is a `BTreeMap<String, String>`; coerce script values. */
export function wireVariables(variables: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(variables ?? {})) {
    out[key] = String(value ?? "");
  }
  return out;
}

/**
 * SOAP is XML over HTTP, not a new transport: project the envelope into a
 * plain `raw` body plus the right Content-Type / SOAPAction header so the
 * existing reqwest sending chain (timings, raw wire, cookies, proxy, TLS,
 * HTTP/3) applies unchanged. WS-Security UsernameToken is inserted into the
 * SOAP header when requested. No secret ever reaches the wire spec here:
 * the auth spec and vault handle encryption / redaction.
 */
function soapProjection(request: RequestDraft): { headers: unknown[]; body: unknown } {
  const soap = request.soap ?? { version: "1.1" as const };
  const version = soap.version === "1.2" ? "1.2" : "1.1";
  const rawEnvelope = (soap.envelope ?? "").trim();
  const wsSecurity = Boolean(soap.wsSecurity);
  let envelope = rawEnvelope;

  if (wsSecurity && !/wsse:Security/i.test(envelope)) {
    const username = soap.username ?? "";
    const password = soap.password ?? "";
    const headerXml = buildWsseHeader(username, password, { passwordType: "PasswordText" });
    const bodyMatch = rawEnvelope.match(/<(?:\w+:)?Body\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Body>/i);
    envelope = buildSoapEnvelope({
      version,
      operation: soap.operation,
      namespace: soap.namespace,
      bodyXml: bodyMatch ? bodyMatch[1] : undefined,
      headerXml,
    });
  }
  if (!envelope) {
    envelope = buildSoapEnvelope({ version, operation: soap.operation, namespace: soap.namespace });
  }

  const headers = (request.headers ?? []).map((row) => ({ ...row })) as Array<{
    key?: string; value?: string; enabled?: boolean; [key: string]: unknown;
  }>;
  const action = soap.soapAction ?? "";
  const soapHeader = soapActionHeader({ soapAction: action, version });
  const existing = headers.find(
    (row) => typeof row.key === "string" && row.key.toLowerCase() === soapHeader.key.toLowerCase(),
  );
  if (existing) {
    if (soapHeader.key === "Content-Type") {
      existing.value = soapHeader.value;
    } else if (!String(existing.value ?? "").trim()) {
      existing.value = soapHeader.value;
    }
    existing.enabled = true;
  } else {
    headers.push({ key: soapHeader.key, value: soapHeader.value, enabled: true });
  }

  return {
    headers,
    body: { type: "raw", content: envelope, contentType: soapContentType(version) },
  };
}

export function toWireSpec(request: RequestDraft, options: WireSpecOptions): WireSpec {
  const settings = options.settings ?? {};
  const url = applyPathVariables(request.url, variablesFrom(request.pathVariables ?? []));
  const isSoap = request.protocol === "soap" || Boolean(request.soap);
  const projected = isSoap ? soapProjection(request) : null;
  return {
    id: request.id,
    name: request.name,
    method: isSoap ? "POST" : request.method,
    url,
    headers: projected?.headers ?? request.headers ?? [],
    query: request.query ?? [],
    body: projected?.body ?? request.body ?? { type: "none" },
    // `inherit` is a frontend-only marker and would break Rust's tagged enum.
    auth: toWireAuth(request.auth),
    variables: wireVariables(options.variables),
    timeoutSecs: settings.timeoutSecs,
    followRedirects: settings.followRedirects,
    verifyTls: settings.verifyTls,
    proxyUrl: settings.proxyUrl?.trim() || undefined,
    useCookies: settings.manageCookies ?? true,
    httpVersion: request.httpVersion ?? settings.httpVersion ?? "auto",
  };
}
