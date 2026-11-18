<p align="center">
  <img src="public/reqora.svg" alt="Reqora" width="92" />
</p>

<h1 align="center">Reqora（驿）</h1>

<p align="center">
  <strong>本地优先、可自托管的多协议 API 工作台。</strong><br />
  一个工作区，装下接口调试、用例回归、场景编排与多端协作 —— 数据始终留在你自己的机器上。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/version-0.0.1-green.svg" alt="Version" />
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node.js" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg" alt="Platforms" />
</p>

---

## 为什么是 Reqora

写接口的人常年在几类工具之间来回切：调试用一个、文档用一个、回归脚本用另一个，协作还得把数据上传到别人的云。Reqora 想把这些收拢到**同一个本地工作区**：

- **本地优先**：每个项目一份 SQLite 工作区，离线可用；凭据进本机保险库，不外发。
- **多协议**：HTTP、gRPC、WebSocket、SSE、TCP、MQTT、SOAP、Mock 共用一套请求 / 响应 / 断言模型。
- **从调试到回归**：把一次调通的请求沉淀成用例，再串成场景与套件，命令行和 CI 都能重跑。
- **可自托管协作**：需要多人协同时，用 CRDT + Git-native 同步；服务端可以自己部署，也可以完全不用。
- **给 AI 留了入口**：内置 MCP 服务，让 AI 读同一份数据、走同一条执行链。

「驿」是驿站 —— 请求从这里出发，响应回到这里。

## ✨ 核心特性

- **统一请求模型**：环境变量、集合鉴权、前置 / 后置脚本、断言、响应提取，一套语义贯穿所有协议。
- **用例与场景**：为请求挂测试用例（正向 / 负向），用条件、循环、等待、变量提取编排多步链路，再打包成套件批量回归。
- **可复现证据**：每次运行产出确定性、可 diff 的 `reqora.run.v1` 证据，可导出 JUnit XML 与 JSON 报告，接入 CI 门禁。
- **三端同一执行链**：桌面端、CLI、MCP 复用 `reqora-core` 请求引擎与 `src/lib/` 纯逻辑，不存在第二份行为语义。
- **AI 原生**：26 个 MCP 工具覆盖检索、编写、执行与诊断；读取默认可用，写入需显式 `--allow-write`。
- **同步与协作**：Automerge CRDT 变更日志 + Git 双向同步通道，配合可选的自托管 Spring Boot 协作后端。
- **隐私设计**：外发物统一脱敏；标记为「私密」的变量永不出本机；日志只记录元信息，不落 URL、请求体与 token。
- **保险库**：凭据字段级 AES-256-GCM 加密，主密钥优先托管给 OS 钥匙串（macOS Keychain / Linux Secret Service）。

## 🔌 支持的协议

| 协议 | 说明 |
| --- | --- |
| HTTP / HTTPS | 主力协议，含环境变量、鉴权、Cookie、重定向、分段计时与流式响应；GraphQL 请求走此通道 |
| gRPC | gRPC 调用面板 |
| WebSocket | 连接、收发消息时间线 |
| SSE | 流式事件读取 |
| TCP | 原始 TCP 收发 |
| MQTT | 发布 / 订阅、QoS、Broker 连接 |
| SOAP | SOAP 请求面板 |
| Mock | 本地 Mock 服务 |
| 数据库步骤 | 场景中的 DB 步骤（仅桌面端可执行） |

## 🚀 快速开始

### 安装预构建包

macOS 提供 `.dmg`（universal，Apple Silicon 与 Intel 通用），Windows 提供 `.exe`（NSIS），Linux 提供 `.AppImage` / `.deb` / `.rpm`。请到仓库的 **Releases** 页面按平台下载，发布说明见 [.github/RELEASE_BODY.md](.github/RELEASE_BODY.md)，校验方法与产物清单随发布一起提供（`SHA256SUMS.txt`）。

> **签名提示**：若维护者未配置 Apple 签名与公证 secrets，macOS DMG 是**未签名、未公证**的，首次打开可能需要在「系统设置 → 隐私与安全性」中允许，或执行 `xattr -d com.apple.quarantine /path/to/Reqora.dmg`；Windows 安装包可能出现 SmartScreen 提示。请先核对校验和再运行。

### 从源码构建

环境要求：

| 组件 | 版本 | 用途 |
| --- | --- | --- |
| Bun | 1.3+ | 前端 / 桌面端依赖与脚本（锁文件为 `bun.lock`） |
| Node.js | 22+ | 运行测试与 CLI |
| Rust | 1.91+（edition 2024） | Tauri 桌面端与请求引擎 |
| JDK | 21 | 可选后端 `server/` |
| Gradle | 9.8.2 wrapper | 可选后端构建（不使用 Maven） |
| MySQL | 8.4 | 可选后端冒烟测试 |

```bash
bun install
bun run tauri:dev        # Vite 1420 + Tauri 窗口，热更新

bun run typecheck        # tsc --noEmit
bun run test             # node --test，前端纯逻辑
bun run build            # tsc && vite build

cd src-tauri && cargo test --lib   # Rust 单测（cwd 必须在 src-tauri/ 内）
```

> `bun run dev` 只启动 Vite；Tauri 的 `beforeDevCommand` 正是它，不要改成 `tauri dev`，否则会递归。Rust 测试需在 `src-tauri/` 目录内执行，以加载该目录 `.cargo/config.toml` 里 HTTP/3 所需的 rustflags。更多约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 🧭 三端一体

**桌面端（Tauri 2）** —— 完整 GUI：请求编辑、集合与环境、用例 / 场景 / 套件、文档站、同步、保险库与设置中心。数据落在应用数据目录，每项目一个 `workspace.db`。

**命令行（CLI）** —— 把回归搬进终端与 CI：

```bash
reqora list                                  # 列出接口、场景、用例、套件、环境
reqora run-scenario "下单链路" --env 测试      # 运行场景（条件/循环/等待/提取全支持）
reqora run-case "创建成功" --junit report.xml # 运行用例并输出 JUnit XML
reqora run-suite "回归套件" --json report.json
reqora export --all --out ./reqora-export    # 导出全部格式 + 测试资产 + 运行证据
reqora --help
```

工作区优先级为 `--workspace` → `$REQORA_WORKSPACE` → 桌面端当前项目；脚本与桌面端共用同一份 helper 源码，在 `node:vm` 中执行；导出包默认确定性输出，在没有安装 Reqora 的机器上也能阅读。

**MCP 服务** —— 让 AI 直接操作本机工作台：

```bash
reqora mcp --config         # 打印 Claude Desktop / Claude Code / Cursor / VS Code 配置片段
reqora mcp --allow-write    # 启动服务；加 --allow-write 才开放写入工具
```

26 个工具覆盖项目概览、检索接口与文档、读写用例 / 场景、运行请求 / 用例 / 场景 / 套件、读取证据与失败归因。鉴权值、敏感响应头与环境变量默认打码；读取工具默认可用，改写项目数据需要 `--allow-write`，建议在桌面端未打开该项目时使用。详见 [skills/reqora-mcp/SKILL.md](skills/reqora-mcp/SKILL.md)。

## 🏗️ 架构

- **前端**：React 19 + TypeScript + Vite + Tailwind CSS + Zustand，组件统一经 `src/lib/api.ts` → `store/workspace.ts`，不直接 `invoke`。
- **桌面端**：Tauri 2 + Rust edition 2024。`src-tauri/src/commands/` 只做 IPC 解析与错误 shaping，`src-tauri/src/service/` 承载桌面专有业务。
- **请求引擎**：`src-tauri/crates/reqora-core` 是纯 Rust 引擎（变量、鉴权、代理、TLS、重定向、Cookie、计时、解码），桌面直接链接，进程外经 `reqora-send` sidecar（NDJSON）调用 —— 它是唯一的发送真相源。
- **同步**：`src/lib/workspaceRows.ts` 统一行模型（快照拆行 / 重组 / 合并），对接 Automerge CRDT 与 Git-native 通道；可选后端为 Spring Boot 4 + MyBatis-Plus + Flyway + MySQL。
- **配置**：进程级参数来自 `REQORA_*` 环境变量，启动时集中校验，非法值直接退出；样例见 [.env.example](.env.example)。

架构与工程约定详见 [skills/reqora-standards/SKILL.md](skills/reqora-standards/SKILL.md)。

## 🔐 隐私与安全

- 导出、上传、文档站 payload 与 MCP 返回值统一走 `src/lib/redact.ts` 脱敏；导出的 Markdown / OpenAPI 只写鉴权方案与占位符，不写真实 token。
- 标记为「私密」的变量值绝不离开本机；大响应体分块落盘，仅小体积预览跨过 IPC。
- 保险库对凭据形态字段做 AES-256-GCM；主密钥优先用 OS 钥匙串，回退 `~/.reqora/vault.key`（0600）。**更换或删除主密钥前请先导出工作区。**
- WebView 输入在 Rust 边界校验，CSP 收紧（脚本运行在 `worker-src blob:` 的 Blob Worker 中，不放开 `unsafe-eval`）。
- 日志只记录 method / origin / 状态码 / 耗时 / 字节数 / 错误码。安全漏洞请走私有上报通道，不要开公开 issue。

## 📁 项目结构

```text
reqora/
├── src/                  # React 前端
│   ├── components/       # UI 组件（请求编辑、协议面板、场景、同步等）
│   ├── lib/              # 纯逻辑：发送契约、脚本、脱敏、同步、代码生成
│   ├── store/            # 工作区状态
│   └── i18n/             # 中英词典
├── src-tauri/            # Tauri 桌面端
│   ├── src/commands/     # IPC 控制器
│   ├── src/service/      # 桌面业务层（ws / tcp / grpc / mcp / ai / vault / db …）
│   └── crates/
│       ├── reqora-core/  # 纯 Rust 请求引擎
│       └── reqora-send/  # NDJSON sidecar
├── server/               # 可选 Spring Boot 后端（自托管协作）
├── bin/                  # CLI 与工具入口（reqora.mjs / evidence.mjs …）
├── scripts/              # 构建、发布、测试、签名脚本
├── skills/               # MCP 使用手册与架构标准
├── test/                 # 前端单元测试（node --test）
├── examples/             # 示例（如 SSE server）
└── .github/              # CI / 发布 / 供应链工作流与 issue 模板
```

## 🧪 测试

三套运行器，CI 另有证据门禁：

```bash
bun run test              # 前端纯逻辑：node --test test/*.test.mjs
cd src-tauri && cargo test --lib
cd server && ./gradlew build                  # JUnit（可选后端）
node bin/evidence.mjs --gate                  # reqora.run.v1 证据门禁
bun run supply-chain                          # 依赖供应链检查
```

## ⚠️ 已知限制

- 鉴权暂不支持 Digest / NTLM / Hawk / OAuth 1.0；mTLS 的 PKCS#12 需先转 PEM。
- 不支持 Socket.IO、Kafka，也不提供独立的流量代理 / 抓包能力。
- 数据库步骤无法在进程外执行，需在桌面端运行。
- 静态加密不防同一 OS 用户下的其他进程；Windows 暂无原生钥匙串集成，多用户机器请勿存放生产凭据。
- 0.0.1 为首个可交付版本，发布产物可能未签名，详见发布说明。

## 📚 文档

- [变更日志](CHANGELOG.md) · [发布说明](.github/RELEASE_BODY.md)
- [贡献指南](CONTRIBUTING.md) · [行为准则](CODE_OF_CONDUCT.md) · [NOTICE](NOTICE)
- [MCP 使用手册](skills/reqora-mcp/SKILL.md) · [架构与工程标准](skills/reqora-standards/SKILL.md)
- 可选后端：[README](server/README.md) · [API 文档](server/docs/API.md) · [管理后台](server/docs/ADMIN.md)

## 🤝 贡献

欢迎参与。功能建议请先开 issue 讨论方案，安全漏洞走私有上报；提交前请跑通类型检查、测试与构建，并遵守 [CONTRIBUTING.md](CONTRIBUTING.md) 中的分层、脱敏与测试约定。本项目以 MIT 发布，参与贡献即表示同意按该许可授权你的代码。

## 📄 许可

本项目基于 [MIT License](LICENSE) 发布，详见 [NOTICE](NOTICE)。

---

### 命名约定

本项目采用「双轨制」命名：**用户可见文案用 `Reqora`（中文「驿」）**，内部技术标识一律保留小写 `reqora` —— 包括 Java 包名、bundle identifier（`com.xbeeant.reqora`）、`REQORA_*` 环境变量、数据库表前缀、Flyway 迁移文件、`package.json` 的 `name` 以及 CLI 脚本路径。
