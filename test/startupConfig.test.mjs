// 启动白屏回归：桌面壳 CSP 必须允许 Automerge WASM，dev 必须绕开
// fullfat_bundler 的原生 WASM ESM 导入（Vite 8 dev 会加载出两份 wasm-bindgen
// glue，__wbindgen_init_externref_table 里 wasm 为 undefined，顶层 await
// 直接拒绝，入口模块不执行 → 白屏）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriConf = JSON.parse(
  readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
);
const viteConf = readFileSync(join(root, "vite.config.ts"), "utf8");

function scriptSrc(csp) {
  const directive = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("script-src "));
  assert.ok(directive, "CSP 必须显式声明 script-src");
  return directive;
}

test("桌面 CSP 允许 WASM 编译，但不放开完整 unsafe-eval", () => {
  for (const key of ["csp", "devCsp"]) {
    const src = scriptSrc(tauriConf.app.security[key]);
    assert.match(src, /'wasm-unsafe-eval'/, `${key} 缺少 wasm-unsafe-eval，WASM 初始化会抛 CompileError 并白屏`);
    assert.doesNotMatch(src, /(^|\s)'unsafe-eval'(\s|$)/, `${key} 不应放开完整的 unsafe-eval`);
  }
});

test("dev 把 @automerge/automerge 指向内嵌 base64 入口，生产构建不受影响", () => {
  assert.match(viteConf, /command === "serve"/, "alias 必须只在 dev 生效");
  assert.match(
    viteConf,
    /find: \/\^@automerge\\\/automerge\$\//,
    "alias 必须精确匹配包名，不能误伤 /slim 等子路径",
  );
  assert.match(
    viteConf,
    /entrypoints\/fullfat_base64\.js/,
    "dev 必须走 fullfat_base64.js（同步 initSync，不经过 vite wasm-helper）",
  );
});
