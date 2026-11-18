import { ApiClientError } from "../../lib/api.ts";
import { resolveRequestAuth } from "../../lib/auth.ts";
import { uid } from "../../lib/id.ts";
import { mergeGlobalHeaders } from "../../lib/environment.ts";
import { t } from "../../i18n/index.ts";
import type { OpenTab } from "../../types.ts";
import type { GrpcSchema } from "../../types.ts";
import type { RequestDraft } from "../../types.ts";
import type { SseState } from "../../types.ts";
import type { TrashEntry } from "../../types.ts";
import type { TrashPayload } from "../../types.ts";
import type { WorkspaceSnapshot } from "../../types.ts";

export function messageOf(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return t("store.error.unknown");
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 所有真实发请求路径的唯一准备钩子（send / runCase / runScenario / 套件 /
 * 压测 / GraphQL 内省 / WebSocket）。两件事都在这里完成，且都不写回用户
 * 保存的请求定义：
 * 1. 把请求级的 `auth: inherit` 解析成集合上的具体鉴权——Rust 的 AuthSpec
 *    是 internally-tagged 枚举，绝不能把 inherit 这个前端标记下发过去；
 *    用例 / 场景用例步骤里的请求是带新 id 的副本，因此还要按
 *    `ApiCase.requestId` 回退到原接口所属集合（集合鉴权改动即时生效）；
 * 2. 合并当前环境的全局 Header，请求内同名头优先。
 *
 * `ownerRequestId` 可显式传入；省略时 resolveRequestAuth 会从 snapshot.cases
 * 自动反查，覆盖用例 tab 下的 send / 压测 / 内省 / WebSocket 等所有路径。
 */
export function withGlobalHeaders(
  request: RequestDraft,
  snapshot: WorkspaceSnapshot,
  ownerRequestId?: string,
): RequestDraft {
  const resolved = resolveRequestAuth(
    request,
    snapshot.collections,
    ownerRequestId,
    snapshot.cases,
  );
  const environment = snapshot.environments.find(
    (item) => item.id === snapshot.activeEnvironmentId,
  );
  const headers = mergeGlobalHeaders(resolved.headers, environment?.headers);
  return headers === resolved.headers ? resolved : { ...resolved, headers };
}

/**
 * Cloud and local data are isolated by construction: remote row payloads are
 * never applied wholesale. The only cloud sync path is `cloudImport`, which
 * merges per row (`workspaceRows.ts`) and rebuilds only the shared domains
 * (collections / environments / cases / scenarios / suites / artifacts) from
 * the server's merged response; local-only state and credentials never leave
 * this machine.
 */

export const MAX_HISTORY = 100;

export function emptySseState(): SseState {
  return {
    active: false,
    streaming: false,
    meta: null,
    frames: [],
    done: null,
    error: null,
    format: "unknown",
    mergedText: "",
    reasoningText: "",
    snippets: [],
  };
}

export function sameTab(left: OpenTab, right: OpenTab): boolean {
  return left.kind === right.kind && left.id === right.id;
}

export function toClientError(error: unknown): ApiClientError {
  if (error instanceof ApiClientError) return error;
  return new ApiClientError({
    code: "UNKNOWN",
    message: messageOf(error),
    requestId: "-",
    retryable: false,
  });
}
/** Cap mirrored with storage.rs MAX_TRASH: drop the oldest entries first. */
export const MAX_TRASH_ENTRIES = 200;

export function pushTrash(entries: TrashEntry[], payload: TrashPayload): TrashEntry[] {
  const next = [...entries, { id: uid(), deletedAt: Date.now(), payload }];
  return next.length > MAX_TRASH_ENTRIES
    ? next.slice(next.length - MAX_TRASH_ENTRIES)
    : next;
}
/** 默认选中第一个非客户端流式的 method（客户端/双向流暂不支持）。 */
export function firstInvokableMethod(schema: GrpcSchema): string {
  return schema.services.flatMap((service) => service.methods).find((m) => !m.clientStreaming)
    ?.path ?? "";
}
