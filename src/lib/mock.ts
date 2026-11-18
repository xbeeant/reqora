import type { DataModel, MockRule, RequestDraft, WorkspaceSnapshot } from "../types.ts";
import { uid } from "./id.ts";
import { generateFromSchema, modelRefResolver, parseSchemaText } from "./jsonschema.ts";
import { generateMockBody } from "./docs.ts";
import { substitute } from "./template.ts";

/**
 * Extracts the path portion of a request URL, resolving environment
 * variables. Keeps `{param}`-style OpenAPI path templates intact; a leading
 * origin (`http://host` or `{{baseUrl}}`) is stripped when present.
 */
export function extractPath(url: string, variables: Record<string, string>): string {
  let candidate = url.trim();
  if (!candidate) return "/";
  // Resolve variables first so `{{baseUrl}}/users` becomes `https://host/users`
  // or a plain `/users` when the variable only holds a path.
  candidate = substitute(candidate, variables);
  // Strip scheme://host[:port]
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate);
  if (withScheme) {
    try {
      const parsed = new URL(candidate);
      return `${parsed.pathname === "/" ? "" : parsed.pathname}`;
    } catch {
      return "/";
    }
  }
  // Protocol-relative or variable-prefixed origin: cut at the first "/" that
  // starts the path. `{{baseUrl}}/users` after substitution has no scheme but
  // may still carry a host segment.
  if (!candidate.startsWith("/")) {
    const slash = candidate.indexOf("/");
    candidate = slash >= 0 ? candidate.slice(slash) : "/";
  }
  // Strip query string — mock matching is path-only.
  const query = candidate.indexOf("?");
  const path = query >= 0 ? candidate.slice(0, query) : candidate;
  return path || "/";
}

/** Picks the best mock body for a request: saved example first, model schema second, synthesis last. */
function mockBodyFor(
  request: RequestDraft,
  models: DataModel[],
): { body: string; status: number; contentType: string } {
  const doc = request.doc;
  const example = doc?.responses.find((item) => item.body.trim()) ?? doc?.responses[0];
  if (example && example.body.trim()) {
    return {
      body: example.body,
      status: example.status || 200,
      contentType: example.contentType || "application/json",
    };
  }
  // A bound data model without an example body: generate representative data
  // from its JSON Schema (full-field, format-aware).
  if (example?.modelId) {
    const model = models.find((item) => item.id === example.modelId);
    if (model) {
      const parsed = parseSchemaText(model.schemaText);
      if (parsed.schema) {
        const generated = generateFromSchema(parsed.schema, modelRefResolver(models));
        return {
          body: JSON.stringify(generated, null, 2),
          status: example.status || 200,
          contentType: example.contentType || "application/json",
        };
      }
    }
  }
  if (doc) {
    return {
      body: generateMockBody(request, doc),
      status: 200,
      contentType: "application/json",
    };
  }
  return {
    body: JSON.stringify({ message: `Mock: ${request.name}`, ok: true }),
    status: 200,
    contentType: "application/json",
  };
}

/**
 * Builds the mock server rule list from the whole workspace: one rule per
 * HTTP interface that has a URL path. Later duplicates of the same
 * method+path are skipped (first definition wins).
 */
export function buildMockRules(
  snapshot: WorkspaceSnapshot,
  variables: Record<string, string>,
): MockRule[] {
  const rules: MockRule[] = [];
  const seen = new Set<string>();
  for (const collection of snapshot.collections) {
    for (const request of collection.items) {
      if (request.protocol === "ws") continue;
      const path = extractPath(request.url, variables);
      if (!path || path === "/") continue;
      const key = `${request.method} ${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { body, status, contentType } = mockBodyFor(request, snapshot.dataModels ?? []);
      rules.push({
        id: uid(),
        method: request.method,
        path,
        status,
        contentType,
        body,
        delayMs: 0,
        description: request.doc?.summary || request.name,
        // Smart rendering is on by default: `@token` placeholders in example
        // bodies generate fresh data per request (Mock.js-flavoured subset).
        smart: true,
        conditions: [],
      });
    }
  }
  return rules;
}

/** The URL a client should call for one mock rule on the running server. */
export function mockUrlFor(port: number | null, rule: MockRule): string {
  return `http://127.0.0.1:${port ?? 0}${rule.path}`;
}
