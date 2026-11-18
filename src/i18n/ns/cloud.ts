/** Cloud (collab backend) user-facing strings: lib/api.ts, lib/cloud.ts, lib/cloudSync.ts. */
export const zh = {
  // lib/api.ts — friendly() 与 IPC 边界错误
  "cloud.api.dnsFailed": "域名解析失败，请检查 URL 与网络连接",
  "cloud.api.connectionRefused": "目标服务器拒绝连接，请确认服务已启动",
  "cloud.api.timeout": "请求超时，可提高超时时间后重试",
  "cloud.api.tlsFailed": "TLS 证书校验失败，可在设置中关闭证书校验（仅限本地调试）",
  "cloud.api.callFailed": "调用失败：{raw}",
  "cloud.api.unknownError": "未知错误",
  "cloud.api.cancelled": "请求已取消",
  "cloud.api.requestFailed": "请求失败",

  // lib/cloud.ts — 离线 / 错误码映射 / 请求体预检
  "cloud.offline": "无法连接云端服务，请检查服务器地址与网络后重试",
  "cloud.error.sessionExpired": "登录已失效，请重新登录",
  "cloud.error.forbidden": "没有权限执行此操作",
  "cloud.error.conflict": "云端数据已被他人更新，请在冲突对话框中选择保留方式",
  "cloud.error.serviceUnavailable": "云端服务暂时不可用，请稍后重试",
  "cloud.error.requestFailed": "云端请求失败",
  "cloud.error.invalidJsonBody": "请求体不是合法 JSON（{detail}）；出错位置附近：{snippet}",
  "cloud.error.bodyNotJsonObject": "请求体必须是 JSON 对象，实际为：{body}",
  "cloud.error.noBaseUrl": "请先在设置中填写云端服务器地址",
  "cloud.error.httpFailed": "请求失败（HTTP {status}）",
  "cloud.error.http400DetailV2":
    "{message}（后端已记录具体原因到服务端日志；调试台 [cloud/400] 有请求详情）",
  "cloud.error.http400DetailLegacy":
    "{message}（后端仍是旧版：异常原因被吞掉且无日志，请重新构建部署 server 后重试；调试台 [cloud/400] 有请求详情）",

  // lib/cloudSync.ts — 大字段对象水合失败
  "cloud.sync.unknownEncoding": "行 {id} 引用了未知编码的云端对象（encoding={encoding}），请升级客户端后再同步",
  "cloud.sync.blobNotJson": "云端对象 {hash} 不是合法 JSON（行 {id}），请重新同步",
};

export const en = {
  "cloud.api.dnsFailed": "DNS resolution failed. Check the URL and your network connection.",
  "cloud.api.connectionRefused": "The target server refused the connection. Make sure the service is running.",
  "cloud.api.timeout": "The request timed out. Try again with a longer timeout.",
  "cloud.api.tlsFailed": "TLS certificate verification failed. You can disable certificate verification in settings (local debugging only).",
  "cloud.api.callFailed": "Call failed: {raw}",
  "cloud.api.unknownError": "Unknown error",
  "cloud.api.cancelled": "Request cancelled",
  "cloud.api.requestFailed": "Request failed",

  "cloud.offline": "Cannot reach the cloud service. Check the server address and network, then try again.",
  "cloud.error.sessionExpired": "Your session has expired. Please sign in again.",
  "cloud.error.forbidden": "You do not have permission to perform this action.",
  "cloud.error.conflict": "The cloud data has been updated by someone else. Choose what to keep in the conflict dialog.",
  "cloud.error.serviceUnavailable": "The cloud service is temporarily unavailable. Please try again later.",
  "cloud.error.requestFailed": "The cloud request failed.",
  "cloud.error.invalidJsonBody": "Request body is not valid JSON ({detail}); context near the error: {snippet}",
  "cloud.error.bodyNotJsonObject": "Request body must be a JSON object, got: {body}",
  "cloud.error.noBaseUrl": "Set the cloud server address in Settings first.",
  "cloud.error.httpFailed": "Request failed (HTTP {status})",
  "cloud.error.http400DetailV2":
    "{message} (the backend logged the exact cause in its server logs; check [cloud/400] in the debug console)",
  "cloud.error.http400DetailLegacy":
    "{message} (the backend is outdated: the exception cause was swallowed without any log. Rebuild and redeploy the server, then retry; check [cloud/400] in the debug console)",

  "cloud.sync.unknownEncoding": "Row {id} references a cloud object with an unknown encoding ({encoding}). Upgrade the client before syncing again.",
  "cloud.sync.blobNotJson": "Cloud object {hash} is not valid JSON (row {id}). Please sync again.",
};
