---
name: reqora-standards
description: Reqora（驿）架构、分层、隐私/脱敏与测试约定。在本仓库做任何实现或审查之前先加载此技能。
---

# Reqora 架构与工程标准

你正在 **Reqora（驿）** 仓库中工作——一个本地优先、可自托管协作的多协议 API 工作台（Tauri 2 + React 19/TypeScript + Rust edition 2024 + 可选 Spring Boot 4 后端）。

## 三层边界（硬性）

- `src-tauri/src/commands.rs` —— 仅做 IPC 控制器：解析输入、日志、错误 shaping。**不含业务规则**。
- `src-tauri/src/service/*` —— 桌面专有业务层（ws / tcp / grpc / mcp / ai / bench / db / vault）。**不得依赖 Tauri IPC 类型**。
- `src-tauri/crates/reqora-core` —— 纯 Rust 请求引擎（models / config / error + service/{http,cookies,timing,template,response_body,…}）。不依赖 Tauri；桌面端与 sidecar 共用同一份实现。
- 前端 `src/components/*` **绝不直接 `invoke`** —— 统一走 `src/lib/api.ts` → `store/workspace.ts`。
- 所有来自 WebView 的输入在 Rust 边界校验（方法白名单、scheme、header、body 与快照大小上限）。

## 发送链（唯一真相源）

- `reqora-core` 是**唯一**发送路径（变量解析、鉴权、代理、TLS、重定向、Cookie Jar、分段计时、响应解码）。桌面直接链接它；进程外通过 `reqora-send` sidecar（NDJSON）调用。CLI / MCP 复用 `src/lib/` —— 不存在第二份语义。
- `src/lib/wireSpec.ts` 是唯一的 `RequestSpec` 构造出口（桌面 / CLI / MCP 共用）。

## 脱敏与隐私（关键）

- 外发物（导出、上传、文档站 payload、MCP 返回结果）**必须**走 `src/lib/redact.ts` + `src/lib/privateValues.ts`。
- `stripForUpload()` **必须保持深拷贝**；`KeyValue.secret` 三态保留；回到「自动」时必须删除字段而不是写 `undefined`。
- 标记为「私密」的变量值**绝不离开本机**。大响应体以 64 KiB 分块落盘，仅 ≤256 KiB 内联预览跨过 IPC。
- 保险库：SQLite 中凭据形态字段做字段级 AES-256-GCM；主密钥优先 OS 钥匙串（macOS Keychain / Linux Secret Service），回退 `~/.reqora/vault.key`（0600）。`REQORA_VAULT_KEY` 可覆盖。**更换/删除主密钥前必须先导出工作区**。

## 后端（可选 `server/`）

- Spring Boot 4 + MyBatis-Plus + Flyway + MySQL；Gradle Kotlin DSL（**不用 Maven**）。
- **绝对不要修改 `server/src/main/resources/db/migration/V*.sql` 中的任何字符**（含注释）——Flyway 校验 checksum。
- 同步走统一行模型：`src/lib/workspaceRows.ts`（`snapshotToRows` / `rowsToSnapshot` / `mergeRows`）；行 payload 字段名必须与后端 `WorkspaceRowDtos` 和桌面 `storage.rs` 三方一致。

## 测试（三套运行器）

- 前端纯逻辑：`node --test test/*.test.mjs`（可直接 import `.ts`）。`bun run test`。
- Rust：`cd src-tauri && cargo test --lib`（cwd 必须在 `src-tauri/` 内以加载 `.cargo/config.toml` 的 rustflags）。
- 后端：JUnit + `node scripts/smoke.mjs`（需真实 MySQL + `.env`）。
- CI 门禁：`bin/evidence.mjs` → `reqora.run.v1` 证据（确定性、可 diff、可 --gate）。`reqora.test.v1` 是测试资产包。

## 命名与环境变量

- 用户可见文案：**Reqora**（中文「驿」）。内部标识符一律小写 `reqora`（Java 包名、bundle id、`REQORA_*` 环境变量、DB 表前缀、CLI 脚本路径）。
- 进程级配置来自 `REQORA_*` 环境变量，启动时集中校验，非法值直接退出。详见 `.env.example`。

## 黄金规则

- 规格/契约优先；不要实现未文档化的行为。
- 不要复制 helper 源码 —— 在 `bin/cliScriptRuntime.mjs` 里通过 `node:vm` import `src/lib/scripts.ts` 导出的 `WORKER_HELPERS_SOURCE`。
- 日志只记录 method / origin / 状态码 / 耗时 / 字节数 / 错误码 —— **绝不**记录完整 URL、请求头、请求体、token 或密码。
- 新增会进入工作区快照的字段 → 同步更新 `redact.ts`；新增鉴权变体 → `transfer.ts` 的 `mdAuthLine()` + `authToSecurity()` + `test/transfer.test.mjs` 脱敏断言。
