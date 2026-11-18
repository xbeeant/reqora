# 参与贡献

感谢你愿意改进 Reqora（「驿」）。本项目以 [MIT](LICENSE) 许可发布；提交贡献即表示你同意按该许可授权你的代码。

## 开始之前

- 先搜索已有 issue，避免重复；功能建议请先开 issue 讨论方案，再动手写大改动。
- **安全漏洞不要开公开 issue**，请按 [SECURITY.md](SECURITY.md) 走私有上报。
- 本项目采用「双轨制」命名：用户可见文案用 **Reqora**，内部技术标识一律保留 `reqora`（Java 包名、bundle identifier、`REQORA_*` 环境变量、DB 表前缀、Flyway 迁移文件、`package.json.name`、CLI 脚本路径），见 README 末尾说明。

## 环境要求

| 组件 | 版本 | 用途 |
| --- | --- | --- |
| Bun | 1.3+ | 前端 / 桌面端依赖与脚本（锁文件为 `bun.lock`） |
| Node.js | 22+ | 运行测试与 CLI（`bun run test` 实际仍是 `node --test`） |
| Rust | 1.91+（edition 2024） | Tauri 侧 |
| JDK | 21 | 可选后端 `server/` |
| Gradle | 9.8.2 wrapper | 后端构建，**不使用 Maven** |
| MySQL | 8.4 | 可选后端冒烟测试 |

macOS 还需 Xcode Command Line Tools；Linux 构建桌面端需 `libwebkit2gtk-4.1-dev`、`libappindicator3-dev`、`librsvg2-dev`、`patchelf`。

## 本地开发

```bash
bun install
bun run tauri:dev        # Vite 1420 + Tauri 窗口，热更新

bun run typecheck        # tsc --noEmit
bun run test             # node --test test/*.test.mjs
bun run build            # tsc && vite build

cargo test --lib   # 在 src-tauri/ 目录内执行（需加载其 .cargo/config.toml 的 rustflags）

cd server && ./gradlew build     # 后端单元测试
node bin/reqora.mjs --help  # CLI 冒烟
```

注意：

- `bun run dev` 只启动 Vite；`tauri.conf.json` 的 `beforeDevCommand` 正是它，不要改成 `tauri dev`，否则会无限递归。
- Rust 测试需在 `src-tauri/` 目录内执行：cargo 按 cwd 向上查找 `.cargo/config.toml`，从仓库根传 `--manifest-path` 会漏掉 HTTP/3 所需的 rustflags。
- 依赖下载若需代理，Gradle wrapper 走 JVM 参数 `GRADLE_OPTS="-Dhttps.proxyHost=... -Dhttps.proxyPort=..."`，不读 shell 的 `HTTPS_PROXY`。
- 后端冒烟需要真实 MySQL 与 `server/.env`。用 `set -a; source server/.env; set +a` 注入环境变量，**不要在脚本里写明文口令**；本地 curl 加 `--noproxy '*'`（后端默认 18080）。

## 代码约定

- 分层：`commands.rs` 只解析 IPC / 错误 shaping，业务规则在 `service/`，持久化在 `storage.rs`（SQLite 行存储，与后端 `ws_entity` 行模型同构）。前端组件不直接 `invoke`，统一走 `lib/api.ts` → `store/workspace.ts`。
- 所有来自 WebView 的输入在 Rust 边界校验（方法白名单、scheme、header、body 与快照大小上限）。
- 脚本必须继续跑在 `worker-src blob:` 的 Blob Worker 里，**不得**为 `script-src` 放开 `unsafe-eval`，也不要给 WebView 外部网络权限。
- CLI 与桌面端复用 `src/lib/` 下的生产模块（模板替换、断言、变量提取、快照归一化），并且 CLI 的 `bin/cliScriptRuntime.mjs` 直接 import `src/lib/scripts.ts` 导出的 `WORKER_HELPERS_SOURCE` 在 `node:vm` 里执行脚本——**不要复制一份 helper 源码**。改动 helper 语义时桌面端与 CLI 会同时变化，请同步更新 `test/cliScripts.test.mjs`。
- `AuthSpec` 的 `inherit` 是**前端专用**标记：Rust 的 `AuthSpec` 是 internally-tagged serde 枚举，未知变体会让四个发送命令在反序列化阶段失败。新增鉴权类型时，确保 `store/workspace.ts` 的 `withGlobalHeaders()`、CLI 的 `buildFetch()` 与 `lib/api.ts` 的 `toWireAuth()` 这条链路完整。用例与场景引用用例步骤保存的是带新 id 的请求副本（`cases.ts:newCaseFromRequest`），解析必须支持 `ApiCase.requestId` / `resolveStepOwnerRequestId(step, cases)` 回退，并在省略时从 `snapshot.cases` 自动推断；导出（`transfer.ts`）也要先解析再输出。跑 `test/authInheritance.test.mjs` 的架构护栏用例。
- 新增任何会进入工作区快照的字段时，同步检查 `src/lib/redact.ts` 的递归脱敏规则；`stripForUpload()` **必须保持深拷贝**，浅拷贝会把置空的凭据写回用户磁盘。`KeyValue.secret` 三态的编辑入口是 `KeyValueTable` 的 `showSecret`，新增 KeyValue 表格时按需开启；`normalizeRequest()` 重建 KeyValue 数组、`setPathValue()` 编辑路径参数、`applyEnvMerge()` 合并环境时都要保留该标记（合并时随来源值迁移），回到「自动」时必须删除字段而不是写入 `undefined`（否则 `stableStringify` 会产生虚假同步差异）。
- 云端同步走统一行模型：快照拆行 / 重组 / 合并只用 `src/lib/workspaceRows.ts` 的 `snapshotToRows` / `rowsToSnapshot` / `mergeRows`，行 payload 字段名必须与后端 `WorkspaceRowDtos` 与桌面端 `storage.rs` 三方一致（改动任何一侧时跑 `test/workspaceRows.test.mjs` 与后端 `WorkspaceRowProtocolTest`）。不要在 store 里引入整快照拉取 / 写回路径（架构护栏 `test/cloudImport.test.mjs` 会拦截 `cloudGetWorkspace` / `restoreLocalData` 等标识符）。
- 导出文件是外发物：Markdown / OpenAPI 导出不得写入真实 token / 密码 / API Key 值。新增鉴权变体时同步更新 `transfer.ts` 的 `mdAuthLine()`（只写方案 + 占位符）与 `authToSecurity()`，并跑 `test/transfer.test.mjs` 的脱敏断言。
- 日志只记录 method / origin / 状态码 / 耗时 / 字节数 / 错误码；不要记录完整 URL、请求头、请求体、token 或密码。
- 单元测试：前端纯逻辑放 `test/*.test.mjs`（Node 原生 test runner，可直接加载 `.ts`），Rust 放 `#[cfg(test)]`，后端放 JUnit。新增行为请同时补测试。

## 不要做的事

- **绝对不要修改 `server/src/main/resources/db/migration/V*.sql` 中的任何字符（包括注释）**——Flyway 会校验 checksum，改动会导致任何已按旧版本初始化的数据库无法通过校验。
- 不要提交 `.env`、`server/.env`、私钥、证书、token 或真实客户数据。仓库已忽略 `.env*`（仅放行 `.env.example`）与常见签名材料后缀。
- 不要为后端引入 `pom.xml` 或 Maven 命令。
- 不要把云端整份载荷直接写回本地工作区：同步只走行级合并（`workspaceRows.ts`），上传前由 `stripForUpload` 负责剔除本机专属域与凭据。

## 提交与 PR

提交信息用 `type: 简述`，type 取 `feat` / `fix` / `docs` / `refactor` / `test` / `chore`。PR 请说明动机、改动范围与验证结果，并确认：

- [ ] `bun run typecheck`、`bun run test`、`bun run build` 通过
- [ ] `cargo test --lib`（在 `src-tauri/` 内）通过
- [ ] 涉及后端时 `./gradlew build` 与 `scripts/smoke.mjs` 通过
- [ ] 新增行为有对应测试
- [ ] 没有改动 Flyway 迁移文件，没有提交任何凭据
- [ ] 用户可见文案用 Reqora，内部标识保持 `reqora`

## 维护者发布前检查

- [ ] 三处版本号同步：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`，`CHANGELOG.md` 已更新，tag 与版本号一致
- [ ] 签名与公证 secrets 已配置；未配置时 release 工作流会产出**未签名**安装包，需在发布说明里明确提示
- [ ] `.env.production` 已填 `REQORA_COLLAB_SERVER_URL`、`REQORA_RELEASE_URL_BASE`（HTTPS）与 `REQORA_UPDATE_MANIFEST_URL`，`bun run release` 输出的下载地址与清单地址正确
- [ ] 签名私钥（`REQORA_UPDATE_SIGNING_KEY` 或 `~/.reqora/update-signing.key`）已就位；`bun run release` 同步内置验签公钥后，又执行过一次**完整** `tauri build`（不要只复用旧产物）
