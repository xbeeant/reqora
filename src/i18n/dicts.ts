/**
 * Dictionary storage, deliberately kept dependency-free: the auto-registry
 * (`./locales`) runs as a side effect while `./index` is still being evaluated,
 * so importing `registerDict` back from `./index` would hit a TDZ error.
 */
export type Lang = "zh" | "en";

export const dicts: Record<Lang, Record<string, string>> = { zh: {}, en: {} };

/** Register a namespace dictionary fragment. */
export function registerDict(lang: Lang, part: Record<string, string>): void {
  Object.assign(dicts[lang], part);
}
