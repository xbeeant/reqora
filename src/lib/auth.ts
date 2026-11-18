/**
 * Collection-level auth inheritance.
 *
 * `inherit` is a **frontend-only** marker. Rust's `AuthSpec` is an
 * internally-tagged serde enum (`#[serde(tag = "type")]`), so sending an
 * unknown variant would make all four commands (`send_request`,
 * `stream_request`, `ws_connect`, `benchmark_run`) fail at deserialization.
 * Every request is therefore resolved to a concrete auth before it leaves the
 * WebView; `toWireAuth()` is the last line of defence inside the IPC adapter.
 *
 * This module is intentionally dependency-free so both the desktop app and the
 * zero-dependency CLI can import it (Node 22 strips the types natively).
 */

import type { ApiCase, AuthSpec, Collection, RequestDraft } from "../types.ts";

export const NONE_AUTH: AuthSpec = { type: "none" };

export function isInheritAuth(auth: AuthSpec | undefined | null): boolean {
  return auth?.type === "inherit";
}

/**
 * Locate the collection that owns any of the given ids, in priority order.
 * Cases keep a COPY of the interface request with a fresh id, so callers pass
 * the original interface id (`ApiCase.requestId`) as a fallback.
 */
export function findCollectionOfRequest(
  collections: Collection[] | undefined,
  ...requestIds: Array<string | undefined>
): Collection | undefined {
  if (!Array.isArray(collections)) return undefined;
  for (const id of requestIds) {
    if (!id) continue;
    const found = collections.find((collection) =>
      (collection.items ?? []).some((item) => item.id === id),
    );
    if (found) return found;
  }
  return undefined;
}

/**
 * Cases are editable copies with a NEW request id (`cases.ts:newCaseFromRequest`),
 * so `request.id` alone cannot find the owning collection. Map the copy back
 * to its interface id via the case list. Resolution stays live: changing the
 * collection auth immediately affects existing cases / case steps.
 */
export function caseOwnerRequestId(
  request: Pick<RequestDraft, "id">,
  cases: ApiCase[] | undefined,
): string | undefined {
  if (!Array.isArray(cases)) return undefined;
  const owner = cases.find((item) => item.request?.id === request.id);
  return owner?.requestId;
}

/** A collection cannot inherit from itself; an unset collection means none. */
export function collectionAuth(collection: Collection | undefined): AuthSpec {
  const auth = collection?.auth;
  return auth && !isInheritAuth(auth) ? auth : NONE_AUTH;
}

/** Resolve a request's auth to a concrete variant. */
export function resolveAuth(
  request: Pick<RequestDraft, "id" | "auth">,
  collections: Collection[] | undefined,
  ownerRequestId?: string,
): AuthSpec {
  const auth = request.auth;
  if (!auth) return NONE_AUTH;
  if (!isInheritAuth(auth)) return auth;
  return collectionAuth(findCollectionOfRequest(collections, request.id, ownerRequestId));
}

/**
 * Resolve in place on a draft, returning the same object when nothing changed.
 * `ownerRequestId` is the original interface id when `request` came from a case
 * or a case step; when omitted it is inferred from `cases`. Both the desktop
 * store and the CLI hold the full snapshot, so every send path gets the fix
 * even if a caller forgets to pass the id explicitly.
 */
export function resolveRequestAuth(
  request: RequestDraft,
  collections: Collection[] | undefined,
  ownerRequestId?: string,
  cases?: ApiCase[],
): RequestDraft {
  const owner =
    ownerRequestId ??
    (isInheritAuth(request.auth) ? caseOwnerRequestId(request, cases) : undefined);
  const auth = resolveAuth(request, collections, owner);
  return auth === request.auth ? request : { ...request, auth };
}

/**
 * IPC boundary guard: never hand an `inherit` marker to Rust. A request that
 * somehow bypassed `withGlobalHeaders` degrades to no auth instead of breaking
 * the command with a deserialization error.
 */
export function toWireAuth(auth: AuthSpec | undefined): AuthSpec {
  return auth && !isInheritAuth(auth) ? auth : NONE_AUTH;
}
