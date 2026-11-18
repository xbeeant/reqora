## 这个 PR 做了什么

<!-- 一句话说明动机，再简述改动范围。关联 issue：Closes # -->

## 改动类型

- [ ] 缺陷修复
- [ ] 新能力
- [ ] 重构 / 性能优化
- [ ] 文档 / 工程化
- [ ] 测试补充

## 验证结果

- [ ] `bun typecheck`
- [ ] `bun test`
- [ ] `bun build`
- [ ] `cargo test --manifest-path <abs>/src-tauri/Cargo.toml`
- [ ] 涉及后端：`./gradlew build` 与 `scripts/smoke.mjs`
- [ ] 涉及 CLI：`node bin/reqora.mjs --help` 及至少一条 run 冒烟

<!-- 请粘贴关键输出（通过数、退出码），不要只写「已测试」。 -->

## 自查

- [ ] 没有改动 `server/src/main/resources/db/migration/V*.sql`（含注释）
- [ ] 没有提交 `.env`、token、私钥或真实客户数据
- [ ] 新增行为有对应测试
- [ ] 用户可见文案使用 Reqora，内部技术标识保持 `reqora`
- [ ] 涉及 `src/lib/` 公共模块时，CLI 与桌面端语义已同步
- [ ] 需要的话已更新 `CHANGELOG.md` 与 README

贡献约定见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
