# Reqora Server REST API

Base URL：`http://127.0.0.1:${REQORA_SERVER_PORT:-8080}`（端口由 `REQORA_SERVER_PORT` 修改，被占用时建议改为 18080；本文示例用 8080）。除 `/health`、`/ready`、Actuator 健康检查、公开认证与身份集成端点（见文末「身份集成、SCIM 与审计留存端点」）、SCIM 2.0 端点（独立 Bearer token）与 `GET /api/v1/doc-sites/{token}` 外，所有请求都需要 `Authorization: Bearer <accessToken>`。

## 统一响应

```json
{ "code": 0, "message": "ok", "data": { }, "requestId": "…", "timestamp": 1762600000000 }
```

`code = 0` 表示成功；失败时 `data = null`，HTTP 状态码有意义，`message` 为可直接展示的中文文案。每个响应都带 `X-Request-Id`，结构化日志中使用同一 ID。

| code | HTTP | 含义 |
| --- | --- | --- |
| 1001 | 400 | 参数校验失败 / 非法角色 / 非法行集 |
| 1002 | 401 | 未登录 |
| 1003 | 403 | 无权限（系统权限或项目角色不足） |
| 1004 | 404 | 资源不存在 |
| 1005 | 409 | 用户名/邮箱/slug 重复、内置角色不可删等 |
| 1006 | 429 | 登录尝试过于频繁（10 次/分钟/IP+用户名） |
| 1007 | 401 | 用户名或密码错误 |
| 1008 | 401 | 访问/刷新令牌无效或已过期 |
| 1009 | 409 | 并发同步冲突（同一行/meta 同时提交），重试即可 |
| 1010 | 413 | 行数据超过上限（默认 5 MiB / 每次最多 10,000 行） |
| 1011 | 403 | 账号已停用 |
| 5000 | 500 | 服务内部错误（不返回堆栈） |

## 认证 `/api/v1/auth`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/register` | 注册并自动登录，默认赋予 `USER` 系统角色 |
| POST | `/login` | 用户名 + 密码登录 |
| POST | `/refresh` | 用刷新令牌换取新令牌对（旧令牌立即作废） |
| POST | `/logout` | 撤销一个或当前用户全部刷新令牌（需认证） |
| GET | `/me` | 当前用户资料、系统角色与权限点 |

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"<REQORA_ADMIN_PASSWORD>"}'
```

响应 `data`：`{ accessToken, refreshToken, tokenType: "Bearer", expiresIn, user }`。
访问令牌默认 15 分钟，刷新令牌 7 天；刷新令牌只以 SHA-256 摘要存库，服务端支持轮换与撤销。**令牌不得出现在 URL 中**；桌面端把令牌对保存在独立的 WebView localStorage 配置层（不在工作区快照内、不参与同步），网页版前端请保持在内存中。

注册请求字段：`username`（3-64，字母数字/`.`/`_`/`-`）、`email`、`password`（8-72）、可选 `displayName`。

## 用户 `/api/v1/users`（需 `system:user:read/write`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/?page=1&size=20&keyword=` | 分页列表（不含权限详情，避免 N+1） |
| POST | `/` | 管理员创建用户，需 `system:user:write` |
| GET | `/{id}` | 详情（含角色与权限点） |
| PUT | `/{id}/status` | `{"enabled": false}` 停用并撤销其全部刷新令牌 |
| PUT | `/{id}/roles` | `{"roles":["USER","ADMIN"]}` 覆盖式分配角色 |
| PUT | `/{id}/password` | `{"password":"..."}` 管理员重置 |
| POST | `/me/password` | `{"oldPassword":"...","newPassword":"..."}` 自行修改 |
| DELETE | `/{id}` | 删除用户；级联清理角色 / 成员 / 刷新令牌，拒绝删除自己、最后一个超管或仍拥有项目/组织的账号 |

创建请求字段与 `/auth/register` 一致：`username`（3-64，字母数字/`.`/`_`/`-`）、`email`、`password`（8-72）、可选 `displayName`、`roles`（角色码数组，省略时默认 `["USER"]`）。账号创建后即为启用状态；非超级管理员只能创建 `USER` 角色用户，防止借创建接口提权。

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/users \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <ACCESS_TOKEN>' \
  -d '{"username":"alice","email":"alice@example.com","password":"change-me-123","displayName":"Alice","roles":["USER"]}'
```

禁止停用自己、禁止移除自己的 `SUPER_ADMIN` 角色；改密/重置会撤销该用户全部刷新令牌。

## 角色与权限 `/api/v1/roles`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | `system:role:read` | 角色列表（含权限码） |
| GET | `/permissions` | `system:role:read` | 全部权限点 |
| POST | `/` | `system:role:write` | 创建角色 `{"code":"QA_LEAD","name":"测试负责人"}` |
| PUT | `/{id}` | `system:role:write` | 改名称/描述（内置角色不可改） |
| DELETE | `/{id}` | `system:role:write` | 删除（内置角色不可删，级联清理关联） |
| PUT | `/{id}/permissions` | `system:role:write` | `{"permissions":["system:user:read"]}` 覆盖式授权 |

## 项目 `/api/v1/projects`

| 方法 | 路径 | 所需能力 | 说明 |
| --- | --- | --- | --- |
| GET | `/?page=1&size=20&keyword=` | — | 我参与的项目（管理员/超管可见全部） |
| POST | `/` | `project:create` | `{"name":"…","slug":"my-project","description":""}` |
| GET | `/{id}` | `PROJECT_READ` | 项目详情（含 `memberRole`） |
| PUT | `/{id}` | `PROJECT_UPDATE` | 改名称/描述 |
| PUT | `/{id}/archive?archived=true` | `PROJECT_ARCHIVE` | 归档 / 取消归档 |
| DELETE | `/{id}` | `PROJECT_DELETE` | 级联删除成员、协作行集与相关数据 |

创建者自动成为 `OWNER`。`slug` 全局唯一，格式 `^[a-z0-9][a-z0-9-]{1,119}$`。

## 成员 `/api/v1/projects/{projectId}/members`

| 方法 | 路径 | 所需能力 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | `MEMBER_READ` | 成员列表（一次批量查询用户信息） |
| POST | `/` | `MEMBER_WRITE` | `{"username":"alice","role":"VIEWER"}` |
| PUT | `/{userId}/role` | `MEMBER_WRITE` | `{"role":"EDITOR"}` |
| DELETE | `/{userId}` | `MEMBER_WRITE` | 移除成员 |
| POST | `/transfer-owner` | `OWNER_TRANSFER` | `{"userId":42}` 仅 OWNER 可操作 |

角色：`VIEWER` < `EDITOR` < `ADMIN` < `OWNER`。不能授予高于自身的角色、不能改自己的角色、不能降级/移除 OWNER；OWNER 唯一，转让时原 OWNER 自动降为 `ADMIN`。

## 工作区行级同步 `/api/v1/projects/{projectId}/workspace`

协作数据按「项目 → 文件夹(集合) → 接口」统一行模型结构化存储（`ws_entity` 表）。每一行
= 一个实体（folder / request / environment / case / scenario / suite / artifact），
标量列（method / url / name / position 等）独立存储，行内剩余结构（headers / body /
steps …）是 JSON `data` payload；每行携带 `updatedAt`（毫秒）与 `deleted`（软删墓碑）。

**合并语义：行级 last-writer-wins**——同一 id 的行，`updatedAt` 更大者胜出；
时间戳相等时墓碑优先于活行；双方均为活行的平局由服务端接收序裁决——内容不同则后来到达者胜（最新意图），内容相同视为幂等重传跳过（`rowVersion` 稳定，不会重复出现在增量里）；
没有 409 整快照冲突；`version` 只是通知序号（SSE / 轮询），不参与冲突判定。
请求历史、回收站、数据库连接、MCP 配置与本机凭据永不入库（客户端上传前已剥离并脱敏）。

| 方法 | 路径 | 所需能力 | 说明 |
| --- | --- | --- | --- |
| GET | `/rows` | `WORKSPACE_READ` | 全量行集（含墓碑与 `meta`），响应带 `full: true`，客户端负责过滤软删行 |
| GET | `/rows?since=<rowVersion>` | `WORKSPACE_READ` | 增量拉取：只回 `row_version > since` 的行（含墓碑，`full: false`）。行表有服务端分配的单调 `row_version`（= 应用该行的那次 sync 的 meta.version），客户端以「已见到的最大 row_version」为游标；cursor 落后于墓碑回收水位（`compacted_version`）时退化为全量（`full: true`），客户端必须整体替换本地视图；旧服务端忽略该参数返回全量，客户端 overlay 后语义不变 |
| POST | `/rows` | `WORKSPACE_WRITE` | 上传本地获胜的行；服务端逐行合并后返回合并后的全量行集 |
| POST | `/rows?ackOnly=true` | `WORKSPACE_WRITE` | 分片上传模式：同样的逐行合并语义，但只回确认（`projectId`/`version`/`accepted` 行列表 + `applied` 标志），不回全量行集 |
| POST | `/objects?hash=<sha256>` | `WORKSPACE_WRITE` | 上传内容寻址大对象（octet-stream 原始字节）；按 `(projectId, sha256)` 幂等，hash 与内容不一致返回 400，超过 `maxObjectBytes`（默认 50 MiB）返回 1010 |
| GET | `/objects/{hash}` | `WORKSPACE_READ` | 下载大对象（原始字节；缺失返回 1004） |
| GET | `/head` | `WORKSPACE_READ` | 仅版本号与更新时间，供轮询 |
| GET | `/events` | `PROJECT_READ` | SSE 实时版本变更流（`text/event-stream`，5 分钟连接上限） |

行集形状（TS 侧定义见 `src/lib/workspaceRows.ts`，与服务端 DTO 字段名一一对应）：

```jsonc
{
  "projectId": 1,
  "version": 4,
  "folders":   [ { "id": "c1", "updatedAt": 100, "deleted": false, "name": "示例集合", "auth": null, "position": 0 } ],
  "requests":  [ { "id": "r1", "updatedAt": 111, "folderId": "c1", "folderPath": "auth", "name": "登录",
                   "method": "POST", "url": "{{base}}/login", "protocol": "http", "position": 0,
                   "data": { "headers": [] } } ],
  "environments": [], "cases": [], "scenarios": [], "suites": [], "artifacts": [],
  "meta": { "seeded": false, "activeEnvironmentId": null, "settings": {} }
}
```

同步请求体即同一形状（只送本地获胜的行，可为空对象域）；`meta` 可省略——
只有显式提交设置时才覆盖协作空间的 meta，普通同步不影响他人设置。限制：
单次最多 10,000 行；全部行 `data` 合计 ≤ `REQORA_WORKSPACE_MAX_BYTES`（默认 5 MiB）；
行 id ≤ 64 字符且不得与其它协作空间的行冲突。

```bash
# 上传本地更新的行，响应为服务端合并后的全量行集
curl -s -X POST http://127.0.0.1:8080/api/v1/projects/1/workspace/rows \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"folders":[{"id":"c1","name":"示例集合","auth":null,"position":0,"updatedAt":100}],
       "requests":[],"environments":[],"cases":[],"scenarios":[],"suites":[],"artifacts":[]}'

# 分片上传：变更行总量可能超过单次请求上限时，客户端按字节切块逐次 POST，
# 每块带 ?ackOnly=true 只拿确认（不回全量，避免每块都付一次全量下载的代价），
# 全部块送达后再 GET /rows 拉一次全量行集重建本地。
# 确认响应形状：{"projectId":1,"version":5,"accepted":[{"id":"c1","updatedAt":100}]}
curl -s -X POST "http://127.0.0.1:8080/api/v1/projects/1/workspace/rows?ackOnly=true" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"folders":[{"id":"c1","name":"示例集合","auth":null,"position":0,"updatedAt":100}],
       "requests":[],"environments":[],"cases":[],"scenarios":[],"suites":[],"artifacts":[]}'
```

凭据边界：上传前客户端会把 auth token / password / API key 类环境变量值置空
（桌面端 `stripForUpload` + 行级脱敏）；拉取方在自己机器上回填本地凭据。
历史与回滚改由本地负责（桌面端 SQLite 的 request_revision 表 + 备份目录）。

### `/events` 事件流

需要 `Authorization: Bearer <accessToken>` 与 `Accept: text/event-stream`；**不能用浏览器 `EventSource`**（无法设置认证头），桌面端用 `fetch` + `ReadableStream` 解析。

```
event: connected
data: {"type":"connected","projectId":1,"version":5,"checksum":""}

event: workspace
data: {"type":"workspace","projectId":1,"version":6,"checksum":""}

event: ping
data: {}
```

`connected` 在订阅建立时立即推送，携带当前版本；此后每次 `POST /rows` 成功后向同项目订阅者推 `workspace`；`ping` 每 20 秒一次用于保活。断线后客户端应降级为 `GET /head` 轮询并周期性重连。广播为单机进程内实现，多实例部署需换 Redis Pub/Sub。

## 组织与邀请 `/api/v1/orgs`、`/api/v1/invitations`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/orgs` | 创建组织（`name`/`slug`/`description`），创建者自动成为 `OWNER` |
| GET | `/api/v1/orgs` | 我加入的组织列表 |
| GET | `/api/v1/orgs/{orgId}` | 组织详情 |
| GET | `/api/v1/orgs/{orgId}/members` | 成员列表（用户名、组织角色、加入时间） |
| POST | `/api/v1/orgs/{orgId}/leave` | 退出组织（OWNER 不可退出） |
| POST | `/api/v1/orgs/{orgId}/invitations` | 生成邀请（需组织 `ADMIN`/`OWNER`），返回**仅此一次**的原始令牌 |
| GET | `/api/v1/orgs/{orgId}/invitations` | 邀请列表（不返回令牌） |
| DELETE | `/api/v1/orgs/{orgId}/invitations/{inviteId}` | 撤销邀请 |
| POST | `/api/v1/invitations/{token}/accept` | 已登录用户凭令牌加入组织 |

组织角色 `MEMBER < ADMIN < OWNER`，不能创建高于自身角色的邀请。令牌只以 SHA-256 摘要入库，支持 `maxUses`（默认 10）、`expiresInHours`（默认 168）与 `label`；撤销、过期或次数用尽后立即失效（1008 / 401）。

创建项目时可传 `orgId` 把项目归属组织。组织成员自动获得该项目权限：`MEMBER → VIEWER`（只读），`ADMIN/OWNER → EDITOR`（可写工作区）；显式项目成员角色优先。组织项目同样出现在成员的项目列表中。

## 文档站分享 `/api/v1/doc-sites`

网页版文档站与桌面端是**同一个 React 应用**：发布时只上传 `DocSitePayload` JSON，
服务端不渲染任何 HTML；公开端点匿名返回该 JSON，由前端 `DocSiteViewer` 渲染。

| 方法 | 路径 | 所需能力 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/v1/projects/{projectId}/doc-sites` | `WORKSPACE_WRITE` | 发布新分享，返回**仅此一次**的原始 `token` 与可复制 `url` |
| GET | `/api/v1/projects/{projectId}/doc-sites` | `WORKSPACE_READ` | 分享列表（不含 token 与 payload） |
| PUT | `/api/v1/projects/{projectId}/doc-sites/{shareId}` | `WORKSPACE_WRITE` | 更新内容与标题，**链接不变** |
| POST | `/api/v1/projects/{projectId}/doc-sites/{shareId}/token` | `WORKSPACE_WRITE` | 轮换令牌，旧链接立即失效（也用于「复制链接」） |
| DELETE | `/api/v1/projects/{projectId}/doc-sites/{shareId}` | `WORKSPACE_WRITE` | 撤销分享 |
| **GET** | `/api/v1/doc-sites/{token}` | **公开，无需认证** | 返回 `DocSitePayload` JSON，并累加浏览量 |

请求体：`{ "payload": { ...DocSitePayload }, "title": "可选", "expiresInHours": 720 }`；
`expiresInHours` 不传表示永不过期。`payload` 必须含 `collections` 数组，上限由
`REQORA_DOC_SITE_MAX_BYTES` 控制（默认 2 MiB），超限返回 `1010 / 413`。

令牌只以 SHA-256 摘要入库（`doc_site_share.token_hash`），明文只在发布/轮换响应里出现一次。
链接失效（撤销、过期、轮换）统一返回 `1004 / 404`。设置 `REQORA_DOC_SITE_URL` 可让服务端
直接返回可复制链接；前后端不同源时把 `api` 参数写进该地址，例如
`https://docs.example.com/?api=https%3A%2F%2Fapi.example.com`，网页版据此请求后端。

**安全边界**：公开 payload 由桌面端 `buildDocSitePayload()` 生成，只含文档字段；
token/口令/API Key 类环境变量、鉴权头与敏感 query 值、脚本、断言、历史、回收站均不上传。
把前端 `dist/` 部署到任意静态托管后访问 `/?doc=<token>` 即可查看；与后端同源部署时
链接里不需要 `api` 参数。跨源部署时请把站点来源加入 `REQORA_CORS_ORIGINS`。

## 管理端 `/api/v1/admin`（服务端内置 `/admin/` 控制台使用）

配套文档见 [ADMIN.md](./ADMIN.md)。控制台静态页面本身公开，以下接口全部需要 Bearer 令牌。

| 方法 | 路径 | 所需权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/overview` | 任意一项治理权限 | 用户 / 角色 / 权限点 / 项目 / 组织 / 审计聚合统计 + 最近 8 条日志 |
| GET | `/orgs` | `system:org:read` | 全部组织，含成员数、项目数、所有者 |
| GET | `/orgs/{orgId}/members` | `system:org:read` | 组织成员（含邮箱） |
| POST | `/orgs/{orgId}/members` | `system:org:write` | `{username, role}` 添加成员，role 只能是 MEMBER / ADMIN |
| PUT | `/orgs/{orgId}/members/{userId}/role` | `system:org:write` | `{role}` 调整成员角色；组织 OWNER 不可改 |
| DELETE | `/orgs/{orgId}/members/{userId}` | `system:org:write` | 移除成员；组织 OWNER 不可移除 |
| POST | `/grants/batch` | `system:user:write` | `{userIds, roleCodes, mode}` 批量授权，mode = `add` / `remove` / `replace`，返回 `{updated, skipped}` |

批量授权逐账号执行防提权校验：非超管只能处理 `USER` 角色、不能调整管理员账号、不能移除自己的 `SUPER_ADMIN`，并保证系统中至少保留一个超级管理员。整个批次先校验后写入，拒绝时不会留下部分变更。

## 审计 `/api/v1/audit`

| 方法 | 路径 | 所需权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/logs?page=1&size=20&keyword=&action=` | `system:audit:read` | 分页日志；`keyword` 匹配操作人 / 动作 / 详情 / 目标 ID，`action` 精确匹配操作类型 |
| GET | `/actions` | `system:audit:read` | 已出现过的操作类型列表，用于筛选下拉 |

记录登录、用户/角色变更、项目/成员变更与工作区行同步，包含操作者、目标、脱敏摘要、requestId 与 IP；**不记录口令、令牌或行内容**。

## 运维端点

`GET /health`（存活）、`GET /ready`（数据库就绪，异常时 503）、`GET /actuator/health`（Actuator）。CORS 仅允许 `REQORA_CORS_ORIGINS` 中显式列出的来源（默认含 `tauri://localhost`、`http://tauri.localhost`、Vite 本地端口），预检返回 `Access-Control-Allow-Origin` 与 `X-Request-Id` 暴露头。

## 前端集成约定

- Base URL 从设置读取，令牌只存内存；401 时用刷新令牌重试一次请求，失败再提示重新登录。
- 4xx 不重试；5xx/网络错误最多重试 3 次并提示离线；所有错误展示服务端 `message`（已是中文可读文案）。
- 同步流程（游标增量 + 分块上传 + 大字段旁路）：
  1. `GET /rows?since=<cursor>` 拉增量（首次 cursor=0 即全量引导），把 delta overlay 到基线上得到服务端当前视图；
  2. 客户端三方合并后，把大字段（行 data 超过 512 KiB）以 sha256 外置：`POST /objects` 传字节，行内只留 `{ "__blob": hash, "size": n, "encoding": "json" }` 引用；
  3. 变更行按字节预算（4 MiB）切块：单块走整包 POST；多块逐次 `POST /rows?ackOnly=true`（1009 版本冲突退避重试）；
  4. 收尾再拉一次同游标增量（覆盖自己上传应用的行与他人并发写入），水合 blob 引用后重建本地快照与新基线（cursor = 响应 version）。
  全量拉取只发生在首次绑定 / 基线丢失 / 游标重置 / 响应 `full: true`（cursor 落后于墓碑回收水位，此时必须整体替换本地视图）；对象按内容寻址幂等去重。

### 同步卫生（服务端自动执行，best-effort）

- **墓碑 compaction**：软删行按服务端接收时间保留 `tombstone-retention-days`（环境变量 `REQORA_WORKSPACE_TOMBSTONE_RETENTION_DAYS`，默认 90 天，0 关闭）后物理清除。保留期按接收时间而非客户端时间计算——离线端刚上传的删除不会被立即回收。回收发生时推进 meta 上的 `compacted_version` 水位；cursor 落后于水位的客户端收到一次 `full: true` 全量补齐，不会静默错过删除。
- **blob 孤儿对象回收**：每次 sync 末尾扫描本项目行 data 中引用的 `__blob` hash，删除无任何引用且超过 `object-grace-hours`（环境变量 `REQORA_WORKSPACE_OBJECT_GRACE_HOURS`，默认 168 小时 = 7 天，0 关闭）的对象。宽限期保护「对象已上传、引用行尚未送达」的中间态。

## 生产加固清单

见 [server/README.md](../README.md) 的「生产加固清单」一节（HTTPS/HSTS、密钥托管、CORS 收敛、限流改 Redis、Actuator 内网隔离等）。

## 身份集成、SCIM 与审计留存端点

> 仅作用于可选的协作后端；桌面端离线使用不涉及以下任何端点。所有外部登录方式默认关闭（`REQORA_IDENTITY_ENABLED=false`），启用与配置项见 [IDENTITY_AND_AUDIT.md](../../docs/IDENTITY_AND_AUDIT.md)。

### 登录与身份 `/api/v1/auth`

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/v1/auth/providers` | 公开 | 列出当前启用的登录方式（未启用的不列出） |
| POST | `/api/v1/auth/sso/oidc/start` | 公开 | 发起 OIDC 授权码 + PKCE(S256)，返回 `{ authorizationUrl, state, expiresAt }`；state 一次性、短 TTL |
| POST | `/api/v1/auth/sso/oidc/callback` | 公开 | body `{ providerId, code, state, redirectUri }` → TokenResponse；校验 state / JWKS 验签（RS256 / ES256）/ `iss`·`aud`·`exp`·`iat`·`nonce` 后按账号映射规则签发本地 JWT |
| GET | `/api/v1/auth/sso/saml/{providerId}/start` | 公开 | 生成 AuthnRequest 与一次性 InResponseTo，重定向到 IdP |
| POST | `/api/v1/auth/sso/saml/{providerId}/acs` | 公开 | form `SAMLResponse` + `RelayState` → 校签（Response 或 Assertion）/ Conditions / Audience / InResponseTo / Recipient 后签发 TokenResponse |
| POST | `/api/v1/auth/sso/ldap` | 公开 | body `{ username, password }` → JNDI 简单绑定后签发 TokenResponse |
| GET | `/api/v1/auth/sso/header` | 可信头 filter | 由可信代理头 filter（CIDR 白名单 + HMAC-SHA256 + 时间戳防重放）认证后换发本地 JWT |
| POST | `/api/v1/auth/pat` | 登录态 | 签发 PAT（可设有效期），返回仅此一次的明文，服务端只存 SHA-256 摘要 |
| GET | `/api/v1/auth/pat` | 登录态 | 列出当前用户 PAT（不含明文） |
| DELETE | `/api/v1/auth/pat/{id}` | 登录态 | 撤销指定 PAT |
| POST | `/api/v1/auth/pat/exchange` | 公开 | 用 PAT 换取短期本地 JWT（CLI / CI），需限流 |

`TokenResponse` 形状与 `/auth/login` 一致（`{ accessToken, refreshToken, tokenType: "Bearer", expiresIn, user }`）。所有 SSO 成功 / 失败均写审计；审计不记录授权码、断言、口令与任何令牌。不支持 SAML IdP-initiated（无 InResponseTo 的请求一律拒绝）。

### SCIM 2.0 `/scim/v2`

**SCIM 使用独立的 Bearer token，而非用户 JWT**：`Authorization: Bearer <REQORA_IDENTITY_SCIM_BEARER_TOKEN>`，服务端只保存该 token 的 SHA-256 摘要做比对，与 `/api/v1/*` 的 JWT 鉴权相互独立。

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET / POST | `/scim/v2/Users` | SCIM Bearer token | 列出 / 创建用户，按 `externalId` 幂等 |
| GET / PUT / PATCH / DELETE | `/scim/v2/Users/{id}` | SCIM Bearer token | 读取 / 全量或增量更新 / 停用；`active=false` 为**软停用**（撤销 refresh token、拒绝登录），DELETE 也不物理删除 |
| GET / POST | `/scim/v2/Groups` | SCIM Bearer token | 列出 / 创建组 |
| GET / PUT / PATCH / DELETE | `/scim/v2/Groups/{id}` | SCIM Bearer token | 读取 / 更新 / 删除组与成员关系；**组 → 角色不自动映射** |
| GET | `/scim/v2/ServiceProviderConfig` | SCIM Bearer token | 服务能力声明（不支持 bulk / ETag） |
| GET | `/scim/v2/ResourceTypes` | SCIM Bearer token | 资源类型 |
| GET | `/scim/v2/Schemas` | SCIM Bearer token | Schema 声明 |

每次增删改都写审计（不含 token 与请求体）。不支持 bulk 批量操作、ETag / 版本乐观锁与硬删除用户。

### 审计留存 `/api/v1/audit`

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/v1/audit/retention` | 登录态 | 当前留存策略（retentionDays / legalHold / hashChain / archiveDir / lastPurgeAt / nextPurgeAt 等，不含敏感值） |
| GET | `/api/v1/audit/export` | `system:audit:read` | 按时间窗与动作导出审计；query `format=jsonl` 或 `csv`、`from`、`to`、`action` |
| POST | `/api/v1/audit/retention/run` | 管理员 | 手动执行归档 + 清理；`REQORA_AUDIT_LEGAL_HOLD=true` 时直接返回不清理 |

既有 `GET /api/v1/audit/logs` 与 `/actions` 见上文「审计」一节。清理前先导出 JSONL 归档并记 sha256，再分批删除避免长事务；hash chain 为**单节点尽力而为**的检测线索，不是 WORM 不可变存储或法律级审计链。

**支持边界**：SAML IdP-initiated / SLO / 加密断言 / metadata 自动刷新；OIDC implicit / hybrid / device flow、外部 IdP token 刷新、多 IdP 账号自动合并；SCIM bulk / ETag / 组 → 角色自动映射；Kerberos / SPNEGO；合规认证、第三方安全审计、SLA、WORM、法律级审计链 —— 均**不支持**。完整清单与配置见 [IDENTITY_AND_AUDIT.md](../../docs/IDENTITY_AND_AUDIT.md)。
