import type { RequestDraft, RequestRevision } from "../types.ts";
import { uid } from "./id.ts";

/**
 * 接口变更历史（P1-7）：保存接口时把被覆盖的旧版本快照推入
 * `snapshot.revisions[requestId]`（新在前，每接口上限 REVISION_CAP）。
 * 纯函数：指纹、diff 摘要、push 归一。
 */

export const REVISION_CAP = 20;

/** 内容指纹：只取「会影响请求行为」的字段，文档元数据变化不算版本变更。 */
export function requestFingerprint(request: RequestDraft): string {
  return JSON.stringify({
    protocol: request.protocol ?? "http",
    method: request.method,
    url: request.url,
    headers: request.headers,
    query: request.query,
    body: request.body,
    auth: request.auth,
    preScript: request.preScript ?? "",
    postScript: request.postScript ?? "",
    assertions: request.assertions ?? [],
    stream: request.stream ?? "auto",
  });
}

/**
 * 当前版本相对某个历史快照的变更摘要（人类可读，中文）。
 * 空数组 = 两者内容指纹一致。
 */
export function revisionDiff(current: RequestDraft, previous: RequestDraft): string[] {
  const changes: string[] = [];
  if (current.protocol !== previous.protocol) {
    changes.push(`协议 ${previous.protocol ?? "http"} → ${current.protocol ?? "http"}`);
  }
  if (current.method !== previous.method) {
    changes.push(`方法 ${previous.method} → ${current.method}`);
  }
  if (current.url !== previous.url) {
    changes.push(`URL 已修改`);
  }
  const enabled = (rows: { enabled: boolean; key: string; value: string }[]) =>
    rows
      .filter((row) => row.enabled && row.key.trim() !== "")
      .map((row) => `${row.key}: ${row.value}`);
  const currentHeaders = enabled(current.headers);
  const previousHeaders = enabled(previous.headers);
  if (JSON.stringify(currentHeaders) !== JSON.stringify(previousHeaders)) {
    changes.push(`请求头 ${previousHeaders.length} → ${currentHeaders.length} 条`);
  }
  const currentQuery = enabled(current.query);
  const previousQuery = enabled(previous.query);
  if (JSON.stringify(currentQuery) !== JSON.stringify(previousQuery)) {
    changes.push(`Query 参数 ${previousQuery.length} → ${currentQuery.length} 条`);
  }
  if (JSON.stringify(current.body) !== JSON.stringify(previous.body)) {
    changes.push(`请求体已修改（${bodyKindLabel(previous.body.type)} → ${bodyKindLabel(current.body.type)}）`);
  }
  if (JSON.stringify(current.auth) !== JSON.stringify(previous.auth)) {
    changes.push(`鉴权配置已修改`);
  }
  if ((current.preScript ?? "") !== (previous.preScript ?? "")) changes.push("前置脚本已修改");
  if ((current.postScript ?? "") !== (previous.postScript ?? "")) changes.push("后置脚本已修改");
  if (JSON.stringify(current.assertions ?? []) !== JSON.stringify(previous.assertions ?? [])) {
    changes.push(`断言 ${previous.assertions?.length ?? 0} → ${current.assertions?.length ?? 0} 条`);
  }
  if ((current.stream ?? "auto") !== (previous.stream ?? "auto")) changes.push("流式模式已修改");
  return changes;
}

function bodyKindLabel(type: string): string {
  const labels: Record<string, string> = {
    none: "无",
    json: "JSON",
    raw: "Raw",
    formUrlEncoded: "表单",
    formData: "form-data",
    binary: "二进制",
    graphql: "GraphQL",
  };
  return labels[type] ?? type;
}

/** push 修订：与最新快照指纹一致时跳过；新在前并截断到上限。 */
export function pushRevision(
  revisions: Record<string, RequestRevision[]>,
  requestId: string,
  previous: RequestDraft,
): Record<string, RequestRevision[]> {
  const existing = revisions[requestId] ?? [];
  const fingerprint = requestFingerprint(previous);
  if (existing.length > 0 && requestFingerprint(existing[0].snapshot) === fingerprint) {
    return revisions;
  }
  const revision: RequestRevision = { id: uid(), at: Date.now(), snapshot: previous };
  return {
    ...revisions,
    [requestId]: [revision, ...existing].slice(0, REVISION_CAP),
  };
}

export function normalizeRevisions(
  raw: Record<string, RequestRevision[]> | undefined,
): Record<string, RequestRevision[]> {
  const out: Record<string, RequestRevision[]> = {};
  for (const [requestId, list] of Object.entries(raw ?? {})) {
    if (!Array.isArray(list)) continue;
    const cleaned = list
      .filter(
        (item): item is RequestRevision =>
          item !== null &&
          typeof item === "object" &&
          typeof item.snapshot === "object" &&
          item.snapshot !== null,
      )
      .slice(0, REVISION_CAP)
      .map((item) => ({
        id: typeof item.id === "string" && item.id ? item.id : uid(),
        at: typeof item.at === "number" ? item.at : 0,
        snapshot: item.snapshot,
      }));
    if (cleaned.length > 0) out[requestId] = cleaned;
  }
  return out;
}
