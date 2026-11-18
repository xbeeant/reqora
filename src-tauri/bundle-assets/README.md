# 内置资源（生成目录）

本目录由 `node scripts/stage-bundle-assets.mjs` 生成，随 Tauri 安装包分发，
App 首次启动时由 `src-tauri/src/bundled_assets.rs` 写入 `~/.reqora/`：

- `mcp/mcp.mjs` — 单文件 MCP 服务
- `skills/<name>/SKILL.md` — AI skills
- `bin/reqora-send[.exe]` — 请求引擎 sidecar（可选）
- `manifest.json` — 版本与文件校验清单

生成物不提交（见 .gitignore）；保留本文件只是为了让 `bundle.resources` 指向的
目录始终存在——未 stage 就直接 `tauri build` 时不会报错，Rust 端发现没有
manifest.json 会跳过安装。
