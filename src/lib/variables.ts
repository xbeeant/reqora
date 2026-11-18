import type { KeyValue } from "../types.ts";
import { DYNAMIC_VARIABLES } from "./dynamic.ts";
import { pathVariableKeys, variablesFrom } from "./template.ts";

export type VariableSource = "environment" | "path" | "dynamic";

export interface VariableSuggestion {
  /** Matched / displayed name, without the `{{ }}` wrapper. */
  key: string;
  /** Exact text inserted at the caret (defaults to `{{key}}`). */
  insert: string;
  source: VariableSource;
  /** Preview of an environment variable's current value. */
  value?: string;
  /** One-line explanation shown next to the suggestion. */
  detail?: string;
}

export const VARIABLE_SOURCE_LABELS: Record<VariableSource, string> = {
  environment: "环境变量",
  path: "路径参数",
  dynamic: "动态变量",
};

/**
 * Everything the `{{` autocomplete can offer for the current request:
 * the active environment's variables, path variables discovered in the URL,
 * and the built-in dynamic tokens. Order matters — environment first, then
 * path parameters, then the (long) dynamic list.
 */
export function collectVariableSuggestions(input: {
  environmentVariables?: KeyValue[];
  url?: string;
}): VariableSuggestion[] {
  const out: VariableSuggestion[] = [];
  const taken = new Set<string>();

  const variables = variablesFrom(input.environmentVariables ?? []);
  for (const [key, value] of Object.entries(variables)) {
    taken.add(key);
    out.push({ key, insert: `{{${key}}}`, source: "environment", value });
  }

  for (const key of pathVariableKeys(input.url ?? "")) {
    if (taken.has(key)) continue;
    taken.add(key);
    out.push({
      key,
      // Path parameters are referenced as `:key` in the URL, not `{{key}}`.
      insert: `:${key}`,
      source: "path",
      detail: "URL 路径参数，值在 Params → 路径参数 中填写",
    });
  }

  for (const item of DYNAMIC_VARIABLES) {
    if (taken.has(item.key)) continue;
    taken.add(item.key);
    out.push({
      key: item.key,
      insert: `{{${item.key}}}`,
      source: "dynamic",
      detail: item.group ? `${item.group} · ${item.description}` : item.description,
    });
  }

  return out;
}

/** Prefix matches first, then substring matches; capped for a compact menu. */
export function filterVariableSuggestions(
  suggestions: readonly VariableSuggestion[],
  query: string,
  limit = 12,
): VariableSuggestion[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return suggestions.slice(0, limit) as VariableSuggestion[];
  const starts: VariableSuggestion[] = [];
  const includes: VariableSuggestion[] = [];
  for (const item of suggestions) {
    const key = item.key.toLowerCase();
    if (key.startsWith(needle)) starts.push(item);
    else if (key.includes(needle)) includes.push(item);
  }
  return [...starts, ...includes].slice(0, limit);
}
