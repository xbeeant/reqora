# SBOM 摘要

- 生成时间：2026-11-18T15:00:01.680Z
- 文件：`sbom/reqora-0.0.1.cdx.json`
- 项目：reqora@0.0.1
- 格式：CycloneDX 1.6
- serialNumber：`urn:uuid:57e299ac-2678-4698-b274-e7265788ef13`
- metadata.timestamp：2026-11-18T14:59:41.811Z
- 运行模式：默认（联网）

## 组件统计

| 生态（group） | 组件数 | 含 license | 含 hash |
| --- | ---: | ---: | ---: |
| npm | 104 | 104 | 0 |
| cargo | 624 | 0 | 624 |
| maven | 5 | 0 | 0 |
| **合计** | **733** | **104** | **624** |

三个生态通过每个组件的 `group` 字段（npm / cargo / maven）与 `properties[reqora:ecosystem]` 区分；scope 统一为 required。

## 依赖关系与校验

- `metadata.component`（项目本体，type=application）→ 直接依赖 ref：52 条。
- `dependencies[]` 条目数：734（每个组件一条，含 npm 安装树父子关系）。
- `validateSbom()` 自检：通过 — 必填字段齐全、bom-ref 唯一、所有 dependencies 引用的 ref 均存在

## 依赖来源

- npm：npm ls --all --json（已排除 51 个未安装/无版本的可选或平台特定依赖占位节点）
- cargo：src-tauri/Cargo.lock
- maven：server/build.gradle.kts（仅声明侧，非完整传递依赖）

## 审计工具

- npm audit：ok，advisory=12（CRITICAL 0 / HIGH 12 / MODERATE 0 / LOW 0 / UNKNOWN 0）
- bun audit：unavailable，advisory=0（CRITICAL 0 / HIGH 0 / MODERATE 0 / LOW 0 / UNKNOWN 0）
- OSV：ok，advisory=11（CRITICAL 0 / HIGH 2 / MODERATE 2 / LOW 0 / UNKNOWN 7）
- cargo audit：skipped，advisory=0（CRITICAL 0 / HIGH 0 / MODERATE 0 / LOW 0 / UNKNOWN 0）

## 复跑命令

```bash
node scripts/supply-chain.mjs
node scripts/supply-chain.mjs --offline
node scripts/supply-chain.mjs --ci
node scripts/supply-chain.mjs --out sbom/foo
node --test test/supplyChain.test.mjs
```

说明与边界见 `docs/SUPPLY_CHAIN.md`，逐工具留痕见 `sbom/dependency-audit.md`。

