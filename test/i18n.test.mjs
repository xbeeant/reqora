import test from "node:test";
import assert from "node:assert/strict";
import { acceptLanguage, getLang, setLang, t } from "../src/i18n/index.ts";

// Guards the wiring: dictionaries are registered as a side effect of importing
// ../src/i18n/index.ts and must work under Node's native TS stripping too.
test("namespace dictionaries are registered at import time", () => {
  setLang("zh");
  assert.equal(t("core.lang.title"), "切换界面语言");
  assert.equal(t("core.search"), "搜索");
  assert.equal(t("core.requestCount", { count: 7 }), "7 接口");
});

test("switching language re-resolves text, interpolation and Accept-Language", () => {
  const original = getLang();
  try {
    setLang("en");
    assert.equal(t("core.lang.title"), "Switch UI language");
    assert.equal(t("core.requestCount", { count: 7 }), "7 APIs");
    assert.match(acceptLanguage(), /^en/);

    setLang("zh");
    assert.equal(t("core.lang.title"), "切换界面语言");
    assert.match(acceptLanguage(), /^zh/);
  } finally {
    setLang(original);
  }
});

test("missing keys degrade to the raw key instead of throwing", () => {
  assert.equal(t("no.such.key"), "no.such.key");
});
