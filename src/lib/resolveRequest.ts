/**
 * Freeze a request into the concrete values that were actually sent.
 *
 * The desktop transport resolves `{{...}}` in Rust (`service::template`),
 * single-pass and authoritative, and never sends the resolved request back to
 * the WebView. Run history therefore used to store the raw draft, so opening
 * an old run showed `{{token}}` instead of the value the server received.
 *
 * This helper mirrors `prepare()` in `reqora-core/src/service/http.rs` on the
 * frontend, using the very same variable map that was handed to the transport
 * (environment variables plus pre-script `setVar`). `substitute` is the same
 * single-pass resolver the CLI uses as its authoritative path, so a variable
 * value containing another placeholder stays verbatim here too.
 *
 * Scripts, assertions and documentation are deliberately left untouched:
 * they are code/definitions, not parameters, and the transport never resolves
 * them either.
 *
 * One deliberate boundary: dynamic tokens such as `{{$uuid}}` are evaluated
 * independently here and in Rust, so their random value may differ from the
 * exact bytes sent. `response.rawRequest` remains the authoritative wire dump
 * for those; user-defined variables (the common case) are exact.
 */
import { applyPathVariables, substitute, variablesFrom } from "./template.ts";
import type { AuthSpec, BodySpec, FormPart, KeyValue, RequestDraft } from "../types.ts";

type Variables = Record<string, string>;

const sub = (text: string | undefined, variables: Variables): string =>
  substitute(text ?? "", variables);

function subRows(rows: KeyValue[] | undefined, variables: Variables): KeyValue[] {
  return (rows ?? []).map((row) => ({
    ...row,
    key: sub(row.key, variables),
    value: sub(row.value, variables),
  }));
}

/** File parts carry binary/base64 payloads — Rust never substitutes those. */
function subFormParts(parts: FormPart[] | undefined, variables: Variables): FormPart[] {
  return (parts ?? []).map((part) => ({
    ...part,
    key: sub(part.key, variables),
    value: part.file ? part.value : sub(part.value, variables),
  }));
}

function subBody(body: BodySpec | undefined, variables: Variables): BodySpec {
  const spec = body ?? ({ type: "none" } as BodySpec);
  switch (spec.type) {
    case "json":
      return { ...spec, content: sub(spec.content, variables) };
    case "raw":
      // contentType is a literal, not a parameter — Rust leaves it alone.
      return { ...spec, content: sub(spec.content, variables) };
    case "formUrlEncoded":
      return { ...spec, items: subRows(spec.items, variables) };
    case "formData":
      return { ...spec, items: subFormParts(spec.items, variables) };
    case "graphql":
      return {
        ...spec,
        query: sub(spec.query, variables),
        variables: sub(spec.variables, variables),
      };
    default:
      return spec;
  }
}

/** Walk every string in the tagged auth union, like Rust's walk_auth_strings. */
function subAuth(auth: AuthSpec | undefined, variables: Variables): AuthSpec {
  if (!auth || typeof auth !== "object") return { type: "none" } as AuthSpec;
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return sub(value, variables);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) out[key] = walk(child);
      return out;
    }
    return value;
  };
  return walk(auth) as AuthSpec;
}

/** Return a new draft with every substituted parameter replaced by its value. */
export function resolveRequestDraft(request: RequestDraft, variables: Variables): RequestDraft {
  const pathVariables = subRows(request.pathVariables, variables);
  return {
    ...request,
    // Order matters: path variables are injected into the URL path first and
    // their own `{{...}}` values are resolved in the same pass as the URL.
    url: sub(
      applyPathVariables(request.url ?? "", variablesFrom(request.pathVariables ?? [])),
      variables,
    ),
    pathVariables: request.pathVariables ? pathVariables : undefined,
    headers: subRows(request.headers, variables),
    query: subRows(request.query, variables),
    body: subBody(request.body, variables),
    auth: subAuth(request.auth, variables),
  };
}
