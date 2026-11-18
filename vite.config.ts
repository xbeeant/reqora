import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

/**
 * Automerge 的 browser 入口 fullfat_bundler.js 依赖「把 .wasm 当作 ES 模块
 * 直接 import」。Vite 8 在 dev 预构建时用 wasm-helper 模拟这个导入，结果同一份
 * wasm-bindgen glue 被实例化两次：__wbindgen_init_externref_table 里 wasm 还是
 * undefined，抛 `TypeError: Cannot read properties of undefined (reading
 * '__wbindgen_externrefs')`，被包成 WebAssembly.Exception 后成为顶层 await 的
 * unhandled rejection —— 入口模块整个不执行，页面全白。
 *
 * dev（含 tauri dev）改走 fullfat_base64.js：同一份 wasm 以 base64 内嵌，
 * 同步 initSync，不经过 wasm-helper，也就没有双份 glue 的问题。
 * 构建产物仍用 bundler 入口（已验证可正常工作，且能保留独立的 .wasm 资源），
 * 避免把 4.8MB base64 打进生产包。
 */
const automergeDevEntry = path.resolve(
  process.cwd(),
  "node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_base64.js",
);

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  // 只读地解析 .env / .env.production：绝对不要用 envPrefix 把 REQORA_* 整体
  // 暴露给前端，否则签名私钥会被打进 bundle。这里只挑出协作服务器地址。
  const env = loadEnv(mode, process.cwd(), "");
  const collabBaseUrl = (env.REQORA_COLLAB_SERVER_URL ?? "").trim().replace(/\/+$/, "");

  return {
    plugins: [react()],

    // 仅 dev / tauri dev 生效；alias 用精确匹配，不影响 /slim 等子路径。
    resolve:
      command === "serve"
        ? {
            alias: [
              {
                find: /^@automerge\/automerge$/,
                replacement: automergeDevEntry,
              },
            ],
          }
        : undefined,

    // 构建期常量：REQORA_COLLAB_SERVER_URL 为空时保持空值，协作入口在 UI
    // 与 cloudConnection.isCloudServerConfigured() 处禁用，不再回退 example.com。
    define: {
      __REQORA_COLLAB_SERVER_URL__: JSON.stringify(collabBaseUrl),
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
