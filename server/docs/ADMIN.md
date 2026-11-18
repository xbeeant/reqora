# Reqora 管理端使用说明

管理端是后端内置的一个**自托管、零构建、零外部依赖**的 Web 控制台，随 Spring Boot 一起部署，不依赖桌面客户端，也不需要 npm 构建。

## 启动与登录

1. 启动后端（默认 `http://127.0.0.1:18080`，端口由 `REQORA_SERVER_PORT` 控制）。
2. 浏览器打开 **`http://<服务地址>/admin/`**（注意末尾斜杠）。
3. 用具备管理权限的账号登录。首次启动时 `BootstrapRunner` 会按 `REQORA_ADMIN_USERNAME` / `REQORA_ADMIN_PASSWORD` 创建 `SUPER_ADMIN` 账号。
4. 页面只提供静态资源，本身不携带任何凭据；所有数据请求都带 `Authorization: Bearer`。登录页可填写任意服务地址，也支持 `?server=http://host:port` 指定后端，便于把控制台静态文件部署到与 API 不同的位置（跨源时把站点来源加入 `REQORA_CORS_ORIGINS`）。

桌面端入口：**设置 → 协作空间（后端服务）→ 管理端**，会显示 `<服务地址>/admin/` 并提供「打开管理端」按钮。

> 令牌默认保存在 `sessionStorage`，关闭标签页即失效；勾选「在此浏览器保留登录状态」才会写入 `localStorage`。访问令牌过期时自动用刷新令牌续期并重试一次；续期失败会退回登录页。

## 页面与能力

| 页面 | 能做什么 | 所需权限 |
| --- | --- | --- |
| 概览 | 用户 / 角色 / 权限点 / 项目 / 组织 / 审计的聚合统计，最近 8 条操作，当前会话的角色与权限 | 任意一项治理权限；普通用户默认进入「项目与成员」 |
| 用户管理 | 分页搜索、新建账号、查看详情、覆盖式分配角色、启停、重置密码、删除账号 | 读：`system:user:read`；写：`system:user:write` |
| 角色管理 | 新建 / 改名 / 删除自定义角色、按角色配置权限点、查看权限点目录与授予情况 | 读：`system:role:read`；写：`system:role:write` |
| 授权管理 | 角色 × 权限矩阵（点击即存）、按用户批量追加 / 移除 / 覆盖系统角色 | 矩阵：`system:role:read/write`；批量：`system:user:write` |
| 项目与成员 | 项目列表与新建 / 编辑 / 归档 / 删除、成员增删与角色调整、所有者转让、能力矩阵说明 | 项目级能力；`project:read_any` 可查看全部项目 |
| 组织与成员 | 组织列表与创建、组织成员增删与角色调整、邀请链接生成 / 撤销 | 列表：`system:org:read`（否则只看「我加入的组织」）；写：`system:org:write` |
| 审计日志 | 按操作人 / 动作 / 详情搜索、按操作类型筛选、查看详情、导出当前页 CSV | `system:audit:read` |
| 我的账号 | 账号资料与生效权限、修改密码、服务地址、退出登录 | 登录即可 |

导航按当前账号权限动态渲染；越权访问会显示明确的提示而不是空白页。所有写操作都会写入服务端审计日志。

## 三层权限模型

管理端同时呈现三种互相独立的授权层次，不要混淆：

1. **系统级 RBAC**：`sys_user_role` + `sys_role` + `sys_role_permission`。决定能否进入管理端、能否管理用户/角色/组织/审计。权限点由 `GET /api/v1/roles/permissions` 返回。
2. **项目级**：`pm_project_member`，`VIEWER < EDITOR < ADMIN < OWNER`。决定项目内能否编辑工作区、管理成员、归档/删除项目、转让所有者。
3. **组织级**：`sys_org_member`，`MEMBER < ADMIN < OWNER`。组织成员自动继承组织项目的可见性，`MEMBER → 只读`、`ADMIN/OWNER → 可编辑`；显式的项目成员角色优先。

`SUPER_ADMIN` 在运行时绕过所有系统权限判定（`AuthUser.has()` 直通），因此授权矩阵中该行固定全选且不可编辑。

### 权限点（共 10 项）

| 权限码 | 说明 |
| --- | --- |
| `system:user:read` / `system:user:write` | 查看 / 管理用户 |
| `system:role:read` / `system:role:write` | 查看 / 管理角色与授权 |
| `system:org:read` / `system:org:write` | 查看全部组织 / 管理组织成员（已授予 `SUPER_ADMIN` 与 `ADMIN`） |
| `system:audit:read` | 查看审计日志 |
| `project:create` | 创建项目 |
| `project:read_any` / `project:delete_any` | 查看 / 删除任意项目 |

内置 `ADMIN` 默认**没有** `system:role:write`，即默认只有超级管理员能改角色与授权；如需委派，由超级管理员在「授权管理」页把该权限点授予 `ADMIN` 或自定义角色。

## 防提权规则

管理端暴露了授权能力，因此服务端同步收紧了以下规则：

- 非超级管理员只能分配 / 移除 `USER` 角色，且不能调整已持有非 `USER` 角色的管理员账号；否则任何 `system:user:write` 持有者都能把自己提升为 `SUPER_ADMIN`。
- 不能移除自己的 `SUPER_ADMIN` 角色；不能移除或删除**最后一个**超级管理员。
- 非超级管理员不能授予自己未持有的权限点。
- 项目成员不能授予高于自身的项目角色。
- 组织 `OWNER` 唯一且由创建时确定，不可指派、改角色或移除；只能分配 `MEMBER` / `ADMIN`。
- 删除用户时若其仍拥有项目或组织会被拒绝，需先转让或删除，避免产生孤儿数据；删除会级联清理角色、成员关系与刷新令牌。

## 管理端 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/admin/overview` | 聚合统计 + 最近审计（需任意治理权限） |
| GET | `/api/v1/admin/orgs` | 全部组织及成员数 / 项目数（需 `system:org:read`） |
| GET | `/api/v1/admin/orgs/{orgId}/members` | 组织成员（含邮箱，需 `system:org:read`） |
| POST | `/api/v1/admin/orgs/{orgId}/members` | `{username, role}` 添加成员（需 `system:org:write`） |
| PUT | `/api/v1/admin/orgs/{orgId}/members/{userId}/role` | `{role}` 调整成员角色 |
| DELETE | `/api/v1/admin/orgs/{orgId}/members/{userId}` | 移除成员 |
| POST | `/api/v1/admin/grants/batch` | `{userIds, roleCodes, mode: add/remove/replace}` 批量授权，返回 `{updated, skipped}` |
| DELETE | `/api/v1/users/{id}` | 删除用户（含级联清理与安全校验） |
| GET | `/api/v1/audit/logs?keyword=&action=` | 审计日志支持关键字与操作类型筛选 |
| GET | `/api/v1/audit/actions` | 已出现过的操作类型，用于筛选下拉 |
| GET | `/api/v1/roles/permissions` | 权限点定义（含 `description` 字段） |

权限点说明与组织权限点、审计动作索引由 Flyway 迁移写入；**迁移文件内容不可修改**，否则 Flyway checksum 校验会失败。

## 静态资源

```
server/src/main/resources/static/admin/
├── index.html          页面外壳
├── styles.css          设计令牌 / 亮暗主题 / 组件样式
└── js/
    ├── api.js          REST 客户端、令牌与刷新、领域 API
    ├── ui.js           表格 / 弹窗 / 表单 / Toast / 分页
    ├── app.js          登录、外壳、hash 路由、权限感知导航
    └── views/*.js      8 个页面模块
```

`/admin` 与 `/admin/**` 在 `SecurityConfig` 中为 `permitAll`，但**仅静态资源公开**——每一个 API 请求仍需 Bearer 令牌。修改静态文件后重启服务即可生效，无需重新构建前端。

## 验证

```bash
# 后端单元与编译
./gradlew -p server build
# 管理端只读冒烟（需后端 + MySQL 已启动；不在脚本里写明文口令）
set -a; source server/.env; set +a
node server/scripts/smoke-admin.mjs
```

`smoke-admin.mjs` 是纯只读检查：登录、概览、权限点说明、组织权限点、角色、组织列表、审计动作与分页接口，共 12+ 项断言，不会写入任何数据。前端侧另有 `bun run typecheck` / `bun run test` / `bun run build`，管理端 JS 模块可用 `node --check server/src/main/resources/static/admin/js/*.js` 做语法自检。
