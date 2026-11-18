Reqora **0.0.1** 的预构建安装包。请按平台选择：

- macOS：`.dmg`（universal，Apple Silicon 与 Intel 均可）
- Windows：`.exe`（NSIS 安装包）
- Linux：`.AppImage` / `.deb` / `.rpm`

下载与校验详见 [下载与校验](../docs/DOWNLOADS.md)（发布页）；`SHA256SUMS.txt` 提供全部产物的校验和，下载后建议先核对。完整变更见 [CHANGELOG.md](../CHANGELOG.md)（CHANGELOG），使用说明见 [README.md](../README.md)。

> **签名状态**：若维护者未配置 Apple 签名与公证 secrets，本页的 macOS DMG 是**未签名、未公证**的。首次打开可能需要在「系统设置 → 隐私与安全性」中允许，或执行 `xattr -d com.apple.quarantine /path/to/Reqora.dmg`。Windows 安装包同样未做代码签名，可能出现 SmartScreen 提示。请在确认校验和后再运行。
>
> 配置了 `REQORA_UPDATE_MANIFEST_URL` 的构建会按 Ed25519 签名清单检查更新；未配置则请在发布页手动下载新版本。本地工作区数据保存在应用数据目录，升级不会覆盖它；重要数据仍建议自行备份。

已知限制（详见 README 与 CHANGELOG）：鉴权不支持 Digest / NTLM / Hawk / OAuth 1.0；mTLS 的 PKCS#12 需先转 PEM；不支持 Socket.IO / Kafka 与独立流量代理 / 抓包；静态加密不防同一 OS 用户下的其他进程，Windows 暂无原生钥匙串集成，多用户机器请勿存放生产凭据。

遇到缺陷请按仓库的 issue 模板提交；**安全问题请走 SECURITY.md 的私有上报通道**，不要开公开 issue。
