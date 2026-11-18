-- Reqora cloud backend: identity / RBAC / projects / workspace sync / audit.
-- All tables are utf8mb4; timestamps are application-managed (UTC conversion at the edge).

-- =============================================
-- Core tables (V1)
-- =============================================

CREATE TABLE sys_user (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  username      VARCHAR(64)  NOT NULL,
  email         VARCHAR(160) NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  display_name  VARCHAR(100) NOT NULL DEFAULT '',
  status        TINYINT      NOT NULL DEFAULT 1 COMMENT '1=enabled 0=disabled',
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_username (username),
  UNIQUE KEY uk_user_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='系统用户';

CREATE TABLE sys_role (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  code        VARCHAR(64)  NOT NULL,
  name        VARCHAR(64)  NOT NULL,
  description VARCHAR(255) NOT NULL DEFAULT '',
  builtin     TINYINT      NOT NULL DEFAULT 0 COMMENT '内置角色不可删除',
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_role_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='系统角色';

CREATE TABLE sys_permission (
  id         BIGINT       NOT NULL AUTO_INCREMENT,
  code       VARCHAR(96)  NOT NULL,
  name       VARCHAR(96)  NOT NULL,
  module     VARCHAR(32)  NOT NULL,
  description VARCHAR(255) NOT NULL DEFAULT '' COMMENT '权限点说明，管理端展示用',
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_permission_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='权限点';

CREATE TABLE sys_user_role (
  user_id    BIGINT      NOT NULL,
  role_id    BIGINT      NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, role_id),
  KEY idx_ur_role (role_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户角色关联';

CREATE TABLE sys_role_permission (
  role_id       BIGINT      NOT NULL,
  permission_id BIGINT      NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  KEY idx_rp_permission (permission_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='角色权限关联';

CREATE TABLE auth_refresh_token (
  id         BIGINT       NOT NULL AUTO_INCREMENT,
  user_id    BIGINT       NOT NULL,
  token_hash CHAR(64)     NOT NULL COMMENT 'SHA-256 of the opaque refresh token',
  expires_at DATETIME(3)  NOT NULL,
  revoked_at DATETIME(3)  NULL,
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_ip VARCHAR(64)  NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  UNIQUE KEY uk_refresh_hash (token_hash),
  KEY idx_refresh_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='服务端刷新令牌';

CREATE TABLE pm_project (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  name        VARCHAR(120) NOT NULL,
  slug        VARCHAR(120) NOT NULL COMMENT 'URL 友好的唯一标识',
  description VARCHAR(500) NOT NULL DEFAULT '',
  owner_id    BIGINT       NOT NULL,
  status      VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / ARCHIVED',
  version     BIGINT       NOT NULL DEFAULT 0,
  created_by  BIGINT       NOT NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  org_id      BIGINT       NULL COMMENT '所属组织；为空表示个人项目',
  PRIMARY KEY (id),
  UNIQUE KEY uk_project_slug (slug),
  KEY idx_project_owner (owner_id),
  KEY idx_project_org (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='项目';

CREATE TABLE pm_project_member (
  id          BIGINT      NOT NULL AUTO_INCREMENT,
  project_id  BIGINT      NOT NULL,
  user_id     BIGINT      NOT NULL,
  member_role VARCHAR(16) NOT NULL COMMENT 'OWNER / ADMIN / EDITOR / VIEWER',
  created_by  BIGINT      NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_member (project_id, user_id),
  KEY idx_member_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='项目成员';

-- ws_workspace / ws_workspace_revision 已在 V4 中被 DROP，由 ws_entity / ws_workspace_meta 替代

CREATE TABLE sys_audit_log (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  actor_id    BIGINT       NOT NULL DEFAULT 0,
  actor_name  VARCHAR(64)  NOT NULL DEFAULT '',
  action      VARCHAR(64)  NOT NULL,
  target_type VARCHAR(32)  NOT NULL DEFAULT '',
  target_id   VARCHAR(64)  NOT NULL DEFAULT '',
  detail      VARCHAR(1000) NOT NULL DEFAULT '' COMMENT '脱敏后的变更摘要',
  request_id  VARCHAR(64)  NOT NULL DEFAULT '',
  ip          VARCHAR(64)  NOT NULL DEFAULT '',
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_audit_actor (actor_id, created_at),
  KEY idx_audit_target (target_type, target_id),
  KEY idx_audit_action (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='审计日志';

-- =============================================
-- V2: Organizations (organizations)
-- =============================================

CREATE TABLE sys_organization (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  name        VARCHAR(120) NOT NULL,
  slug        VARCHAR(120) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  owner_id    BIGINT       NOT NULL,
  status      VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_org_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='组织/团队';

CREATE TABLE sys_org_member (
  org_id     BIGINT      NOT NULL,
  user_id    BIGINT      NOT NULL,
  role       VARCHAR(20) NOT NULL DEFAULT 'MEMBER',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (org_id, user_id),
  KEY idx_om_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='组织成员';

CREATE TABLE sys_invitation (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  org_id      BIGINT       NOT NULL,
  token_hash  CHAR(64)     NOT NULL COMMENT 'SHA-256 of the opaque invite token',
  role        VARCHAR(20)  NOT NULL DEFAULT 'MEMBER',
  label       VARCHAR(120) NOT NULL DEFAULT '',
  invited_by  BIGINT       NOT NULL,
  expires_at  DATETIME(3)  NOT NULL,
  max_uses    INT          NOT NULL DEFAULT 10,
  used_count  INT          NOT NULL DEFAULT 0,
  status      VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_invite_token (token_hash),
  KEY idx_invite_org (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='组织邀请链接';

-- =============================================
-- V3: Doc sites (doc_sites)
-- =============================================

CREATE TABLE doc_site_share (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  project_id  BIGINT       NOT NULL,
  token_hash  CHAR(64)     NOT NULL COMMENT 'SHA-256 of the opaque share token',
  title       VARCHAR(200) NOT NULL DEFAULT '',
  payload     LONGTEXT     NOT NULL COMMENT 'DocSitePayload JSON, rendered by the client SPA',
  created_by  BIGINT       NOT NULL,
  expires_at  DATETIME(3)  NULL COMMENT 'NULL = never expires',
  view_count  BIGINT       NOT NULL DEFAULT 0,
  status      VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / REVOKED / EXPIRED',
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_doc_share_token (token_hash),
  KEY idx_doc_share_project (project_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公开文档站分享';

-- =============================================
-- V4: Structured workspace (structured_workspace)
-- =============================================

-- 结构化工作区存储（统一行模型）：项目 → 文件夹(集合) → 接口等实体行。
-- 协作空间尚未正式使用，旧「整份快照压进一个 LONGTEXT」的表直接丢弃，
-- 不做存量迁移。行模型与桌面端本地 SQLite（storage.rs）同构：
--   * 每行 = 一个实体（folder / request / environment / case / scenario /
--     suite / artifact），标量列（method / url / protocol / name 等）独立
--     存储便于字段级比对，行内剩余结构作为 JSON payload；
--   * updated_at（客户端毫秒时间戳）+ deleted（软删标记）是行级合并
--     （per-row last-writer-wins）的唯一依据；
--   * 本机域（history / trash / dbConnections / mcpServers / theme /
--     settings 凭据字段）不进入这些表，见 SECURITY.md。

CREATE TABLE ws_entity (
  id           VARCHAR(64)  NOT NULL COMMENT '客户端生成的全局唯一 id',
  project_id   BIGINT       NOT NULL,
  kind         VARCHAR(16)  NOT NULL COMMENT 'folder/request/environment/case/scenario/suite/artifact',
  parent_id    VARCHAR(64)  NULL COMMENT 'folder 为 NULL；request 存所属 folder id',
  folder_path  VARCHAR(512) NOT NULL DEFAULT '' COMMENT '集合内文件夹路径（a/b/c）',
  name         VARCHAR(255) NOT NULL,
  method       VARCHAR(10)  NULL COMMENT 'kind=request：HTTP 方法',
  url          TEXT         NULL COMMENT 'kind=request：请求 URL（含 {{变量}}）',
  protocol     VARCHAR(10)  NULL COMMENT 'kind=request：http/ws/tcp',
  auth         TEXT         NULL COMMENT 'kind=folder：集合级鉴权 JSON（上传前已脱敏）',
  position     INT          NOT NULL DEFAULT 0,
  enabled      TINYINT      NOT NULL DEFAULT 1 COMMENT 'kind=case：是否启用',
  case_group   VARCHAR(16)  NULL COMMENT 'kind=case：用例分组（正向/负向/边界值/安全性/其他）',
  sub_kind     VARCHAR(32)  NULL COMMENT 'kind=artifact：docPage/dataModel/scriptSnippet/codeTemplate',
  updated_at   BIGINT       NOT NULL DEFAULT 0 COMMENT '行级合并依据（毫秒）',
  deleted      TINYINT      NOT NULL DEFAULT 0 COMMENT '软删标记，随同步传播删除',
  data         MEDIUMTEXT   NOT NULL COMMENT '行内 JSON payload（headers/body/doc/steps 等）',
  synced_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  synced_by    BIGINT       NOT NULL DEFAULT 0,
  created_at   DATETIME     NULL COMMENT 'V5 补列：行级创建时间',
  PRIMARY KEY (id),
  KEY idx_entity_project (project_id, kind, deleted, position),
  KEY idx_entity_parent (project_id, kind, parent_id),
  KEY idx_entity_method (project_id, method)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作区实体行';

CREATE TABLE ws_workspace_meta (
  project_id            BIGINT      NOT NULL,
  version               BIGINT      NOT NULL DEFAULT 1 COMMENT '同步序号（变更通知用），不参与冲突判定',
  seeded                TINYINT     NOT NULL DEFAULT 0,
  active_environment_id VARCHAR(64) NULL,
  settings              TEXT        NULL COMMENT '共享设置 JSON（不含本机凭据字段）',
  updated_by            BIGINT      NOT NULL DEFAULT 0,
  updated_at            DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at            DATETIME    NULL COMMENT '行级创建时间',
  PRIMARY KEY (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作区元信息与同步版本';

-- =============================================
-- Seed: permission points (V1 + V6 additions)
-- =============================================

INSERT INTO sys_permission (code, name, module, description) VALUES
  ('system:user:read',   '查看用户',       'system', '查看系统用户列表与用户详情'),
  ('system:user:write',  '管理用户',       'system', '创建 / 停用 / 删除用户，分配角色与重置密码'),
  ('system:role:read',   '查看角色',       'system', '查看角色列表、权限点与角色授权情况'),
  ('system:role:write',  '管理角色',       'system', '创建 / 修改 / 删除自定义角色，调整角色权限'),
  ('system:audit:read',  '查看审计日志',   'system', '查看系统审计日志'),
  ('project:create',     '创建项目',       'project', '创建新的协作项目'),
  ('project:read_any',   '查看任意项目',   'project', '查看全部项目，不受项目成员关系限制'),
  ('project:delete_any', '删除任意项目',   'project', '删除任意项目，不受项目成员关系限制'),
  ('system:org:read',    '查看组织',       'system', '查看全部组织、组织成员与组织项目数'),
  ('system:org:write',   '管理组织成员',   'system', '添加 / 调整角色 / 移除组织成员');

-- ---- seed: built-in roles ----
INSERT INTO sys_role (code, name, description, builtin) VALUES
  ('SUPER_ADMIN', '超级管理员', '拥有全部系统权限', 1),
  ('ADMIN',       '管理员',     '用户 / 角色 / 项目治理', 1),
  ('USER',        '普通用户',   '创建项目并参与协作', 1);

INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
  SELECT r.id, p.id FROM sys_role r CROSS JOIN sys_permission p WHERE r.code = 'SUPER_ADMIN';

INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
  SELECT r.id, p.id FROM sys_role r CROSS JOIN sys_permission p
  WHERE r.code = 'ADMIN' AND p.code IN
    ('system:user:read', 'system:user:write', 'system:role:read', 'system:audit:read',
     'project:create', 'project:read_any', 'project:delete_any',
     'system:org:read', 'system:org:write');

INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
  SELECT r.id, p.id FROM sys_role r CROSS JOIN sys_permission p
  WHERE r.code = 'USER' AND p.code = 'project:create';
