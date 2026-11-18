# Reqora 依赖审计报告

- 生成时间：2026-11-18T15:00:01.679Z
- 运行模式：默认（联网）
- 项目版本：0.0.1
- SBOM 文件：`sbom/reqora-0.0.1.cdx.json`（CycloneDX 1.6）
- 结构自检：通过（validateSbom 无错误）

> 本报告由 `scripts/supply-chain.mjs` 自动生成。所有审计工具的退出码、耗时、成功/失败原因均逐条留痕；网络失败与工具不可用一律不记为「0 漏洞」。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 操作系统 | darwin 27.2.0 (arm64) |
| Node.js | v22.20.0 |
| npm | 10.9.3 |
| bun | 1.3.6 |
| cargo | cargo 1.91.1 (ea2d97820 2025-10-10) |
| Java | ~/.jenv/shims/java: line 21: /opt/homebrew/Cellar/jenv/0.5.7/libexec/libexec/jenv: No such file or directory |
| Gradle Wrapper | 9.8.2 |
| cargo-audit | 未安装 |

## 2. 组件清单（依赖来源）

| 生态 | 来源 | 组件数 | 说明 |
| --- | --- | ---: | --- |
| npm | npm ls --all --json | 104 | 已排除 51 个未安装/无版本的可选或平台特定依赖占位节点 |
| cargo | src-tauri/Cargo.lock | 624 | 共 627 个 [[package]]，其中 3 个本地工作区包已排除，纳入 624 个第三方 crate |
| maven | server/build.gradle.kts（仅声明侧） | 5 | Gradle 离线解析树不可用（exitCode=null, spawnSync ./gradlew EACCES）；Maven 侧仅使用声明侧坐标，非完整传递依赖 |
| **合计** | — | **733** | CycloneDX `components[]` 去重后数量 |

- npm 声明侧：`package.json` 共 17 个直接依赖（dependencies + devDependencies）。
- Maven 声明侧：`server/build.gradle.kts` 共 18 个坐标，Spring Boot 插件版本 4.1.2；声明侧共 18 个坐标；其中 10 个版本由 BOM 管理。
- **Maven 侧为「仅声明侧，非完整传递依赖」**：Gradle 离线解析树不可用，未采集 BOM 管理的传递依赖版本。
- Rust 本地工作区包（不作为第三方组件）：reqora@0.0.1、reqora-core@0.0.1、reqora-send@0.0.1。
- 项目本体 → 直接依赖的依赖关系：52 条 ref；`dependencies[]` 共 734 条。

## 3. 审计工具执行结果（全部留痕）

| 工具 | 版本 | 状态 | 退出码 / HTTP 状态 | 耗时(ms) | advisory 数 | CRITICAL | HIGH | MODERATE | LOW | UNKNOWN | 命令 |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| npm audit | 10.9.3 | ok | 1 | 3673 | 12 | 0 | 12 | 0 | 0 | 0 | `npm install --package-lock-only --ignore-scripts --no-audit --registry=https://registry.npmjs.org ; npm audit --json --registry=https://registry.npmjs.org（均在临时目录 reqora-supply-chain-WNKEQY）` |
| bun audit | 1.3.6 | unavailable | 1 | 126 | 0 | 0 | 0 | 0 | 0 | 0 | `bun audit --json --omit=dev` |
| OSV | api.osv.dev/v1 (querybatch + vulns) | ok | HTTP 200 | 16054 | 11 | 0 | 2 | 2 | 0 | 7 | `POST https://api.osv.dev/v1/querybatch ; GET https://api.osv.dev/v1/vulns/*` |
| cargo audit | 未安装 | skipped | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | `cargo audit --json（未执行：未安装）` |

状态含义：`ok` = 成功执行并取得可靠结果；`failed` = 执行但结果无效；`unavailable` = 工具/服务不可用；`skipped` = 按约束或 --offline 未执行。**后三者一律不提供「0 漏洞」结论。**

各工具说明：

- **npm audit**（ok，2026-11-18T14:59:41.812Z）：执行成功（audit 退出码 1 表示发现 advisory） 细节：metadata.vulnerabilities={"info":0,"low":0,"moderate":0,"high":12,"critical":0,"total":12}
- **bun audit**（unavailable，2026-11-18T14:59:45.487Z）：工具不可用：exitCode=1；镜像 bulk advisory 端点不支持（404）；未获得任何 advisory，不记为 0 漏洞 细节：error: audit request failed (status 404)
- **OSV**（ok，2026-11-18T15:00:01.668Z）：全部 8 批查询成功，命中 10 个 advisory id，已取详情 10 个 细节：querybatch 8 批（每批 ≤100）：成功 8，失败 0（HTTP API 无进程退出码，列中记录 HTTP 状态）；命中组件 10 个、去重 id 10 个
- **cargo audit**（skipped，2026-11-18T15:00:01.669Z）：cargo-audit 未安装；按约束不联网安装，跳过。Rust 侧漏洞改由 OSV（RustSec）覆盖 细节：error: no such command: `audit`

### 3.1 工具不可用（如实记录，不计入通过也不计入漏洞）

- **bun audit**：`unavailable` — 工具不可用：exitCode=1；镜像 bulk advisory 端点不支持（404）；未获得任何 advisory，不记为 0 漏洞
- **cargo audit**：`skipped` — cargo-audit 未安装；按约束不联网安装，跳过。Rust 侧漏洞改由 OSV（RustSec）覆盖

已知情况：仓库 `.npmrc` 指向 npmmirror，`bun audit` 在本机请求该镜像的 bulk advisory 端点返回 404（CI 等环境也可能是 bun 未安装），两种情况都记为「工具不可用」；脚本不会篡改仓库配置绕过，npm 生态的审计由 npm audit（显式 `--registry` 指向官方源）+ OSV 覆盖。

## 4. 高危 / 严重漏洞清单

共发现 **14** 条 high/critical 级发现（来源可靠）：

| 来源 | ID | 组件 | 严重性 | 摘要 | 严重性依据 |
| --- | --- | --- | --- | --- | --- |
| npm audit | vite | `@vitejs/plugin-react` | HIGH | 直接依赖 | npm audit severity=high |
| npm audit | picomatch | `anymatch` | HIGH | 传递依赖 | npm audit severity=high |
| npm audit | anymatch; readdirp | `chokidar` | HIGH | 传递依赖 | npm audit severity=high |
| npm audit | micromatch | `fast-glob` | HIGH | 传递依赖 | npm audit severity=high |
| npm audit | picomatch | `fdir` | HIGH | 传递依赖 | npm audit severity=high |
| npm audit | picomatch | `micromatch` | HIGH | 传递依赖 | npm audit severity=high |
| npm audit | picomatch vulnerable to ReDoS through single-branch repeated extglobs | `picomatch` | HIGH | 传递依赖 | npm audit severity=high |
| npm audit | picomatch | `readdirp` | HIGH | 传递依赖 | npm audit severity=high |
| npm audit | tinyglobby | `sucrase` | HIGH | 传递依赖 | npm audit severity=high |
| npm audit | chokidar; fast-glob; micromatch | `tailwindcss` | HIGH | 直接依赖 | npm audit severity=high |
| npm audit | fdir; picomatch | `tinyglobby` | HIGH | 传递依赖 | npm audit severity=high |
| npm audit | picomatch; tinyglobby | `vite` | HIGH | 直接依赖 | npm audit severity=high |
| OSV | GHSA-fc5q-39xc-vjpf | `pkg:npm/picomatch@2.3.2` | HIGH | picomatch vulnerable to ReDoS through single-branch repeated extglobs | database_specific.severity=HIGH |
| OSV | GHSA-fc5q-39xc-vjpf | `pkg:npm/picomatch@4.0.7` | HIGH | picomatch vulnerable to ReDoS through single-branch repeated extglobs | database_specific.severity=HIGH |

另有 9 条中低危 / 严重性未知的发现。全部发现按严重性分桶：

| 严重性 | 条数 |
| --- | ---: |
| CRITICAL | 0 |
| HIGH | 14 |
| MODERATE | 2 |
| LOW | 0 |
| UNKNOWN | 7 |

### 4.1 全部发现明细（含严重性未知，便于人工复核）

> OSV 的 RustSec 条目多数不提供定性严重性或 CVSS 向量，这类发现统一标为 UNKNOWN 并在此逐条列出；UNKNOWN 不等于无风险，也不触发 --ci 失败。同一漏洞可能同时存在 GHSA 与 RUSTSEC 两个 id，此处按 OSV 返回的 id 原样保留，未做跨 id 去重。

| # | 来源 | ID | 组件 | 严重性 | 摘要 | 处置建议 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | npm audit | vite | `@vitejs/plugin-react` | HIGH | 直接依赖 | 建议升级至 5.2.0 |
| 2 | npm audit | picomatch | `anymatch` | HIGH | 传递依赖 | 建议升级至 4.3.5 |
| 3 | npm audit | anymatch; readdirp | `chokidar` | HIGH | 传递依赖 | 建议升级至 4.3.5 |
| 4 | npm audit | micromatch | `fast-glob` | HIGH | 传递依赖 | 可自动修复（npm audit fix） |
| 5 | npm audit | picomatch | `fdir` | HIGH | 传递依赖 | 可自动修复（npm audit fix） |
| 6 | npm audit | picomatch | `micromatch` | HIGH | 传递依赖 | 建议升级至 4.3.5 |
| 7 | npm audit | picomatch vulnerable to ReDoS through single-branch repeated extglobs | `picomatch` | HIGH | 传递依赖 | 建议升级至 6.2.7 |
| 8 | npm audit | picomatch | `readdirp` | HIGH | 传递依赖 | 可自动修复（npm audit fix） |
| 9 | npm audit | tinyglobby | `sucrase` | HIGH | 传递依赖 | 可自动修复（npm audit fix） |
| 10 | npm audit | chokidar; fast-glob; micromatch | `tailwindcss` | HIGH | 直接依赖 | 建议升级至 4.3.5 |
| 11 | npm audit | fdir; picomatch | `tinyglobby` | HIGH | 传递依赖 | 可自动修复（npm audit fix） |
| 12 | npm audit | picomatch; tinyglobby | `vite` | HIGH | 直接依赖 | 建议升级至 6.2.7 |
| 13 | OSV | GHSA-fc5q-39xc-vjpf | `pkg:npm/picomatch@2.3.2` | HIGH | picomatch vulnerable to ReDoS through single-branch repeated extglobs | 升级到该 advisory 的 patched 版本；无修复版本时评估缓解措施或替换组件 |
| 14 | OSV | GHSA-fc5q-39xc-vjpf | `pkg:npm/picomatch@4.0.7` | HIGH | picomatch vulnerable to ReDoS through single-branch repeated extglobs | 升级到该 advisory 的 patched 版本；无修复版本时评估缓解措施或替换组件 |
| 15 | OSV | RUSTSEC-2026-0543 | `pkg:cargo/chrono@0.4.45` | UNKNOWN | chrono is unmaintained | 升级到该 advisory 的 patched 版本；无修复版本时评估缓解措施或替换组件 |
| 16 | OSV | GHSA-wrw7-89jp-8q8g | `pkg:cargo/glib@0.18.5` | MODERATE | Unsoundness in `Iterator` and `DoubleEndedIterator` impls for `glib::VariantStrIter` | 升级到该 advisory 的 patched 版本；无修复版本时评估缓解措施或替换组件 |
| 17 | OSV | RUSTSEC-2024-0429 | `pkg:cargo/glib@0.18.5` | UNKNOWN | Unsoundness in `Iterator` and `DoubleEndedIterator` impls for `glib::VariantStrIter` | 升级到该 advisory 的 patched 版本；无修复版本时评估缓解措施或替换组件 |
| 18 | OSV | RUSTSEC-2026-0459 | `pkg:cargo/libsqlite3-sys@0.30.1` | UNKNOWN | `libsqlite3-sys` via C SQLite CVE-2026-119375 | 升级到该 advisory 的 patched 版本；无修复版本时评估缓解措施或替换组件 |
| 19 | OSV | RUSTSEC-2024-0370 | `pkg:cargo/proc-macro-error@1.0.4` | UNKNOWN | proc-macro-error is unmaintained | 升级到该 advisory 的 patched 版本；无修复版本时评估缓解措施或替换组件 |
| 20 | OSV | RUSTSEC-2023-0071 | `pkg:cargo/rsa@0.9.10` | MODERATE | Marvin Attack: potential key recovery through timing sidechannels | 升级到该 advisory 的 patched 版本；无修复版本时评估缓解措施或替换组件 |
| 21 | OSV | RUSTSEC-2026-0371 | `pkg:cargo/zbus_names@4.3.5` | UNKNOWN | `zbus_names` is unmaintained | 升级到该 advisory 的 patched 版本；无修复版本时评估缓解措施或替换组件 |
| 22 | OSV | RUSTSEC-2026-0370 | `pkg:cargo/zvariant@5.15.1` | UNKNOWN | `zvariant` is unmaintained | 升级到该 advisory 的 patched 版本；无修复版本时评估缓解措施或替换组件 |
| 23 | OSV | RUSTSEC-2026-0372 | `pkg:cargo/zvariant_derive@5.15.1` | UNKNOWN | `zvariant_derive` is unmaintained | 升级到该 advisory 的 patched 版本；无修复版本时评估缓解措施或替换组件 |

## 5. 处置建议

1. 优先处理上表中的 high/critical 条目：升级到 advisory 标注的 patched 版本，或用 `npm audit fix` / 升级 Cargo 依赖 / 升级 Maven BOM 版本。
2. 若组件暂无修复版本，评估缓解措施（关闭受影响功能、加输入校验、替换组件），并在 SECURITY.md 中记录例外。
3. 修复后复跑本脚本并对比 `sbom/` 产物，确认 advisory 数下降。
4. 上表中 7 条严重性为 UNKNOWN 的发现（OSV/RustSec 未提供定性严重性或 CVSS 向量）需安排人工复核，确认受影响版本与当前用法下是否可被触发；UNKNOWN 既不计入 high/critical，也不视为无风险。

## 6. 哪些没查到 / 为什么

- **bun audit**：本机为镜像 404（其他环境可能是 bun 未安装），记为工具不可用；其本应覆盖的 npm 生态已由 npm audit + OSV 覆盖。
- **cargo audit**：未安装且按约束不联网安装，状态 skipped；Rust 侧由 OSV（含 RustSec 条目）覆盖。
- **RustSec 条目的严重性**：OSV 中 7 条 RustSec advisory 未提供定性严重性与 CVSS 向量，脚本如实标为 UNKNOWN 并在 4.1 节逐条列出，未凭空判定级别；这部分风险需人工复核。
- **Maven 传递依赖**：Gradle 离线解析树不可用，SBOM 中 Maven 组件为「仅声明侧，非完整传递依赖」，未解析到的传递依赖不会被 OSV 查询。
- **动态/运行时依赖**：仅覆盖 lockfile 与安装树中可见的静态组件；不含运行时动态下载、Tauri 打包时链入的操作系统库、以及容器基础镜像内的系统包。详见 `docs/SUPPLY_CHAIN.md` 的支持边界。
- **无漏洞 ≠ 已认证**：OSV 结果随时间变化，且本流程不含第三方签名认证 / 无 SLA。

## 7. 复跑命令

```bash
node scripts/supply-chain.mjs                 # 联网：完整审计 + SBOM
node scripts/supply-chain.mjs --offline       # 无网络：仅采集 + SBOM，报告标注审计未执行
node scripts/supply-chain.mjs --ci            # CI：发现可靠 high/critical 或审计不完整时非零退出
node scripts/supply-chain.mjs --out sbom/foo  # 自定义输出目录
node --test test/supplyChain.test.mjs         # 离线校验已生成产物
```

