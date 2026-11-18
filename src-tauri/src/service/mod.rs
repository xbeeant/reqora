// 发送链与 wire 类型的定义本体在 reqora-core（无 Tauri 依赖），shell 内以
// `reqora_core::service::...` 直接引用；本文件只声明壳自己独有的模块
// （ai / bench / db / grpc / ws 等）。shell 与 CLI sidecar 链接同一个
// reqora-core rlib，传输行为只有一份实现。

pub mod ai;
pub mod bench;
pub mod db;
pub mod files;
pub mod git_sync;
pub mod grpc;
pub mod history;
pub mod mcp;
pub mod mqtt;
pub mod net;
pub mod tcp;
pub mod tls;
pub mod vault;
pub mod ws;
