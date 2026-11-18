# Reqora 云端后端服务

与桌面端 Reqora 配套的后端：把本地工作区按「项目 → 文件夹(集合) → 接口」统一行模型同步到 MySQL（实体行 + 行内 JSON payload，逐行 last-writer-wins 合并），并提供项目管理、成员管理、角色管理、组织协作与审计。

## 技术栈与版本

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| JDK | 21 | Spring Boot 4 |
| 构建 | Gradle 9.8.2（wrapper） | Kotlin DSL，**不使用 Maven** |
| Spring Boot | 4.1.2 | Web / Security / Validation / JDBC / Actuator |
| MyBatis-Plus | 3.5.18 | `mybatis-plus-spring-boot4-starter` + `mybatis-plus-jsqlparser`（分页插件） |
| 数据库 | MySQL 8.4+ | HikariCP 连接池、Flyway 迁移 |
| 认证 | HS256 JWT + 服务端刷新令牌 | 无状态访问令牌、轮换/撤销刷新令牌、BCrypt 口令 |

## 快速开始（本地）

```bash
cd server
cp .env.example .env
# 生成随机 JWT 密钥并填写 REQORA_JWT_SECRET、数据库口令、初始管理员口令
openssl rand -base64 48

# 1) 启动 MySQL（默认 mysql:8.4；可用 REQORA_MYSQL_IMAGE 指定已有镜像）
docker compose --env-file .env up -d --wait mysql

# 2) 加载环境变量并启动服务（Gradle wrapper 自动下载发行版）
set -a; source .env; set +a
./gradlew bootRun

# 3) 另一个终端：健康检查 + 全链路冒烟
curl -s --noproxy '*' "http://127.0.0.1:${REQORA_SERVER_PORT:-8080}/ready"
SMOKE_ADMIN_PASSWORD="$REQORA_ADMIN_PASSWORD" \
  BASE_URL="http://127.0.0.1:${REQORA_SERVER_PORT:-8080}" node scripts/smoke.mjs
SMOKE_ADMIN_PASSWORD="$REQORA_ADMIN_PASSWORD" \
  BASE_URL="http://127.0.0.1:${REQORA_SERVER_PORT:-8080}" node scripts/smoke-events.mjs

# 4) 构建 / 单元测试
./gradlew build
./gradlew test
```

> `.env` 已加入 `.gitignore`，**真实密钥只存在于环境变量**；`.env.example` 仅含占位值。应用启动时会校验密钥长度、CORS 白名单、管理员口令与令牌有效期，任一不合法即快速失败。
>
> 若 8080 被占用（例如本机有 nginx/代理监听该端口），在 `.env` 里改 `REQORA_SERVER_PORT=18080` 后重启，并让冒烟脚本的 `BASE_URL` 指向同一端口；`curl` 走系统代理时加 `--noproxy '*'`。Spring Boot 4 的 Flyway 自动配置已拆分到独立 starter，本项目已显式引入 `spring-boot-starter-flyway`。

## 用户与账号

协同工作不需要单独的桌面端管理页。按使用顺序有三种新增用户的方式：

**1）首个超级管理员**：首次启动由 `BootstrapRunner` 读取 `.env` 中的管理员用户名 / 邮箱 / 口令创建一次，并赋予内置 `SUPER_ADMIN` 角色（已存在同名用户则跳过）。这是唯一能管理所有用户与角色的入口，口令只在环境变量里，不落在源码或日志中。

**2）内置用户管理页（推荐）**：服务启动后浏览器打开 `http://<后端地址>:<端口>/admin/index.html`。页面由后端同源托管，因此**不受 CORS 白名单影响**，访问令牌只保存在页面内存中（刷新页面需重新登录），不写 localStorage。功能包括：

- 登录 / 自助注册（后端 `/api/v1/auth/register` 默认开放，注册后为 `USER` 角色）
- 用户列表与关键字搜索、新增用户（用户名 / 邮箱 / 显示名 / 初始密码 / 角色）
- 启用停用、调整角色、重置密码；非超级管理员只能创建 `USER` 角色用户

`/admin/**` 静态页面本身在 `SecurityConfig` 中放行，但页面发出的每个 API 请求都必须带 Bearer 令牌并受 RBAC 校验；页面自身不含任何凭据。生产环境建议仅在内网开放并配合 HTTPS，若不需要开放注册，可从 `SecurityConfig` 的 `permitAll` 列表移除 `/api/v1/auth/register`。

**3）直接调用 REST**（脚本化 / 无浏览器）：

```bash
# 自助注册（无需鉴权，默认 USER 角色）
curl -s -X POST http://127.0.0.1:8080/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"username":"alice","email":"alice@example.com","password":"change-me-123"}'

# 管理员创建（先登录超级管理员取 accessToken）
TOKEN=$(curl -s -X POST http://127.0.0.1:8080/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"<REQORA_ADMIN_PASSWORD>"}' | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).data.accessToken')
curl -s -X POST http://127.0.0.1:8080/api/v1/users \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"username":"bob","email":"bob@example.com","password":"change-me-123","roles":["USER"]}'

# 需要管理员权限时由超级管理员覆盖式分配角色
curl -s -X PUT http://127.0.0.1:8080/api/v1/users/2/roles \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"roles":["USER","ADMIN"]}'
```

`POST /api/v1/users` 需要 `system:user:write`；用户名 / 邮箱唯一，密码 8-72 位，省略 `roles` 时默认 `USER`。创建、启停、改角色、重置口令都会写入审计日志。桌面端「设置 → 云端协作」目前只提供登录与同步，不管理账号。

## 架构

按功能分包、三层职责分离；控制器只解析请求与包装响应，服务层不依赖任何 servlet 类型。

```
src/main/java/com/xbeeant/reqora/server/
├── common/     统一响应/错误码/全局异常/请求 ID/JSON 工具/当前用户
├── config/     集中配置与启动校验、Security/CORS/安全头、MyBatis-Plus 插件
├── auth/       JWT、认证过滤器、刷新令牌、登录限流、注册登录、首次管理员引导
├── user/       用户创建、查询、启停、角色分配、改密/重置
├── role/       角色与权限点 CRUD、角色授权
├── organization/ 组织/团队 CRUD、成员与组织角色（OWNER/ADMIN/MEMBER）
├── invitation/ 邀请链接生成/接受/撤销（令牌仅存 SHA-256 摘要）
├── project/    项目 CRUD/归档、双层鉴权（系统 RBAC + 项目角色 + 组织派生角色）
├── member/     成员增删、角色变更、owner 转让、防提权
├── workspace/  行级同步：行上传/拉取、last-writer-wins 合并、SSE 版本通知
├── audit/      审计日志（不含口令、令牌与行内容）
├── docsite/    文档站分享：token + JSON payload 存取（不含 HTML 渲染）
└── health/     /health（存活）与 /ready（数据库就绪）
```

基础设施：`X-Request-Id` 贯穿请求与结构化 JSON 日志（logstash 格式）；CORS 显式白名单；安全响应头；登录限流；边界处 Jakarta Validation；多步写入事务；分页查询避免 N+1；Flyway 版本化迁移 `V1__init.sql`；`server.shutdown=graceful`。

## 数据模型（主要表）

| 表 | 用途 |
| --- | --- |
| `sys_user` / `sys_role` / `sys_permission` / `sys_user_role` / `sys_role_permission` | 用户、系统角色、权限点及关联 |
| `auth_refresh_token` | 仅保存刷新令牌 SHA-256 摘要，支持轮换与撤销 |
| `pm_project` / `pm_project_member` | 项目与成员（每项目每用户唯一，成员角色 OWNER/ADMIN/EDITOR/VIEWER）；V2 起 `pm_project.org_id` 可关联组织 |
| `sys_organization` / `sys_org_member` / `sys_invitation` | 组织、组织成员、邀请链接（只存令牌摘要，支持次数上限/过期/撤销） |
| `ws_entity` / `ws_workspace_meta` | V4：统一行模型——实体行（folder/request/environment/case/scenario/suite/artifact，标量列 + JSON data + updatedAt/软删墓碑）与项目 meta（version/seeded/activeEnvironmentId/settings） |
| `sys_audit_log` | 关键操作审计（脱敏摘要、requestId、IP） |
| `doc_site_share` | V3：公开文档站分享（只存 token 摘要 + 文档 JSON payload + 状态/过期/浏览量） |

首次启动由 `BootstrapRunner` 创建 `.env` 中指定的超级管理员（仅创建一次），并赋予内置 `SUPER_ADMIN` 角色。

## 权限模型

**系统权限点**（由角色分配）：`system:user:read/write`、`system:role:read/write`、`system:audit:read`、`project:create`、`project:read_any`、`project:delete_any`。内置角色：`SUPER_ADMIN`（全部）、`ADMIN`（用户/角色/项目治理）、`USER`（创建项目）。

**项目角色能力矩阵**（与系统权限叠加）：

| 能力 | VIEWER | EDITOR | ADMIN | OWNER |
| --- | :---: | :---: | :---: | :---: |
| 查看项目/成员/行集 | ✓ | ✓ | ✓ | ✓ |
| 同步行（上传） | — | ✓ | ✓ | ✓ |
| 更新项目信息 | — | — | ✓ | ✓ |
| 增删成员 / 改成员角色 | — | — | ✓ | ✓ |
| 归档 / 删除项目 | — | — | — | ✓ |
| 转让 owner | — | — | — | ✓ |

超级管理员放行全部；成员不能授予高于自身的角色；owner 不可被降级或移除（须先转让）。

## 工作区同步协议（行级）

1. `GET /api/v1/projects/{id}/workspace/events` 订阅版本变更（SSE，需 `Authorization: Bearer`）：连上立即推 `connected`（当前版本号），每次 `POST /rows` 后推 `workspace`（新版本号），20 秒一次 `ping` 心跳。桌面端用 `fetch` + `ReadableStream` 消费（EventSource 无法带令牌头）；断线降级为 `head` 轮询，并周期性重连。
2. `GET .../workspace/head` 轻量版本号（轮询降级用）。
3. `GET .../workspace/rows` 拉取全量行集（含软删墓碑与 meta）。
4. `POST .../workspace/rows` 上传本地获胜的行；服务端逐行按 `updatedAt` last-writer-wins 合并，返回合并后的全量行集，各副本由此收敛。单次最多 10,000 行、总 data ≤ `REQORA_WORKSPACE_MAX_BYTES`（默认 5 MiB）。历史与回滚由桌面端本地负责（SQLite 修订表 + 备份目录）。

桌面端在「设置 → 协作空间」中只需填写服务器地址并登录一次：协作空间按本地项目自动识别或创建，登录后即可按行双向同步。

## 文档站分享

`V3__doc_sites.sql` 新增 `doc_site_share`。发布链路只传数据：桌面端 `buildDocSitePayload(snapshot)`
生成只含文档字段的 JSON，管理端点（需登录 + 项目权限）写入；`GET /api/v1/doc-sites/{token}`
是唯一公开的读取端点，直接返回该 JSON。Java 侧**没有**任何 HTML / Markdown 渲染逻辑——
网页版 `/?doc=<token>` 就是同一个 Vite SPA，用同一个 `DocSiteViewer` 组件渲染，
因此桌面端「文档站预览」与网页版不会漂移。

- 令牌只存 SHA-256 摘要，明文仅在发布 / 轮换响应返回一次；轮换会让旧链接立即失效。
- 「更新内容」保持链接不变；撤销、过期统一返回 `1004 / 404`。
- **同源托管（默认推荐）**：先在仓库根目录 `bun run build`，再 `./gradlew bootRun` / `bootJar`；
  Gradle 会把 `dist/` 复制进 `classpath:/static/`，内嵌 Tomcat 同时提供 `/`、`/assets/**` 与
  `/admin/`。一个端口即可打开 `/?doc=<token>`，无需另起 Vite / Nginx；`api` 参数由服务端
  自动指向自身，无需手动填写。
- `REQORA_DOC_SITE_URL` 配置网页版站点地址（可选），用于生成可复制链接；同源部署时留空，
  服务端按请求 origin 自动拼链接，但要发给外部用户请显式设为公网可达地址；
  `REQORA_DOC_SITE_MAX_BYTES` 控制 payload 上限（默认 2 MiB）。
- 公开 payload 已过滤凭据类环境变量、鉴权头与敏感 query 值，不含脚本 / 断言 / 历史 / 回收站。

## 验证

| 检查 | 覆盖内容 |
| --- | --- |
| `./gradlew build` / `./gradlew test` | 单元测试：JWT 签名/过期、项目角色矩阵、配置校验、限流、JSON 工具、SSE 事件格式与广播、组织角色、邀请令牌摘要、行级同步协议 |
| Flyway 迁移 | 在真实 MySQL 上建表并写入内置角色/权限点 |
| `node scripts/smoke.mjs` | 行级同步协议（首次上传、VIEWER 拒绝、陈旧行不覆盖、软删墓碑、EDITOR 升级后可写）、登录/刷新轮换、RBAC 拒绝、项目/成员、组织/邀请、审计、级联删除与文档站分享 |
| `node scripts/smoke-events.mjs` | 真实 SSE：订阅收到 `connected`，按行上传在同一连接收到 `workspace` 版本递增事件 |
| CORS 预检 | `tauri://localhost` 返回 200 + `Access-Control-Allow-Origin` 与安全头 |

CORS 预检命令：`curl -i -X OPTIONS -H 'Origin: tauri://localhost' -H 'Access-Control-Request-Method: POST' "http://127.0.0.1:${REQORA_SERVER_PORT:-8080}/api/v1/projects/1/workspace/rows"`。

## 生产加固清单

HTTPS 终止与 HSTS；JWT 密钥与数据库口令改用密钥管理服务；CORS 收敛为真实前端源；登录限流从进程内计数换成 Redis（当前 `LoginRateLimiter` 为单机固定窗口）；Actuator 端点限制内网访问；数据库连接池与慢查询监控；定期备份与 Flyway 迁移演练；刷新令牌过期清理任务；审计日志归档；容器化部署时以非 root 运行。

## 已知限制

- 工作区按「行」同步（last-writer-wins by updatedAt），行内的 headers/body/steps 不拆子行；历史与回滚由桌面端本地 SQLite 负责，服务端不存版本历史（这是刻意的简单可靠取舍）。
- SSE 广播是**单机进程内**的（`ConcurrentHashMap` + `SseEmitter`），多实例部署需要换成 Redis Pub/Sub 或消息中间件；连接 5 分钟过期由客户端重连，断线期间由 `head` 轮询兜底。
- 项目/成员为物理删除（审计日志保留记录）；删除项目会级联清理成员与协作行集。
- 刷新令牌服务端仅存摘要；桌面端把令牌对保存在独立的 WebView localStorage 配置层（不在工作区快照内、不参与同步），重启后无需重新登录。
- 组织目前支持创建/加入/退出与邀请管理，尚无解散组织、转让组织 OWNER 与组织级角色变更端点。
