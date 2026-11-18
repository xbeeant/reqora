import { useSyncExternalStore } from "react";
import "./locales/index.ts";
import { dicts } from "./dicts.ts";
import type { Lang } from "./dicts.ts";

export type { Lang } from "./dicts.ts";
export { registerDict } from "./dicts.ts";

const STORAGE_KEY = "reqora.lang";
const listeners = new Set<() => void>();

function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "zh" || stored === "en") return stored;
  } catch {
    // localStorage unavailable (e.g. privacy mode) — fall through to detection.
  }
  const nav = typeof navigator !== "undefined" ? navigator.language : "zh-CN";
  return nav && nav.toLowerCase().startsWith("zh") ? "zh" : "en";
}

let current: Lang = detectLang();

function applyDocumentLang(lang: Lang): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }
}
applyDocumentLang(current);

export function getLang(): Lang {
  return current;
}

/** Switch the UI language, persist the choice and re-render subscribed components. */
export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ignore persistence failures
  }
  applyDocumentLang(lang);
  listeners.forEach((fn) => fn());
}

export function subscribeLang(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reactive language value for components. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribeLang, getLang, getLang);
}

/**
 * Translate a key in the current language, with `{name}`-style interpolation.
 * Falls back: current lang → zh → raw key.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  let text = dicts[current][key] ?? dicts.zh[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      // split/join 而不是 replaceAll：tsconfig 的 lib 目标低于 ES2021。
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/** Hook returning the translator; components re-render when the language changes. */
export function useT(): typeof t {
  useSyncExternalStore(subscribeLang, getLang, getLang);
  return t;
}

/** Accept-Language header value matching the current UI language. */
export function acceptLanguage(): string {
  return current === "zh" ? "zh-CN,zh;q=0.9" : "en";
}
