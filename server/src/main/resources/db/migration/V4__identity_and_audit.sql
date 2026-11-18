-- V4: 外部身份集成（OIDC / SAML / LDAP / 可信头 / SCIM / PAT）与审计留存
--
-- 设计要点：
--   1) 所有外部令牌、SSO state、PAT 只落 SHA-256 摘要或一次性会话记录，
--      数据库泄露不会直接给出可用凭据。
--   2) 外部账号与本地账号通过 (provider_id, subject) 强绑定；邮箱链接与
--      JIT 开户都是可关闭的策略，不自动合并两个不同的外部主体。
--   3) 审计日志追加哈希链字段，配合 sys_audit_archive 做「先归档、后清理」；
--      legal_hold 为 1 的行任何清理任务都不得删除。
--   4) 本文件是新增迁移，V1~V3 的任何字符都不改（Flyway checksum）。

CREATE TABLE sys_external_identity (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  provider_id   VARCHAR(64)  NOT NULL COMMENT '配置里的提供者 id（如 okta / entra）',
  provider_type VARCHAR(16)  NOT NULL COMMENT 'oidc / saml / ldap / header / scim',
  subject       VARCHAR(255) NOT NULL COMMENT 'IdP 的稳定主体标识（sub / NameID / DN）',
  user_id       BIGINT       NOT NULL,
  email         VARCHAR(160) NULL,
  display_name  VARCHAR(100) NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_login_at DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ext_identity (provider_id, subject),
  KEY idx_ext_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='外部身份到本地账号的绑定';

CREATE TABLE sys_sso_session (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  state_hash    CHAR(64)     NOT NULL COMMENT 'state / SAML AuthnRequest ID 的 SHA-256',
  provider_id   VARCHAR(64)  NOT NULL,
  provider_type VARCHAR(16)  NOT NULL,
  redirect_uri  VARCHAR(512) NULL,
  code_verifier VARCHAR(255) NULL COMMENT 'OIDC PKCE verifier（仅服务端持有）',
  nonce         VARCHAR(128) NULL,
  request_id    VARCHAR(128) NULL COMMENT 'SAML InResponseTo',
  expires_at    DATETIME(3)  NOT NULL,
  used_at       DATETIME(3)  NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_sso_state (state_hash),
  KEY idx_sso_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='一次性 SSO 会话（防重放）';

CREATE TABLE sys_personal_access_token (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  user_id       BIGINT       NOT NULL,
  name          VARCHAR(128) NOT NULL,
  token_hash    CHAR(64)     NOT NULL COMMENT 'SHA-256 of the opaque PAT',
  scopes        VARCHAR(255) NOT NULL DEFAULT '',
  expires_at    DATETIME(3)  NOT NULL,
  last_used_at  DATETIME(3)  NULL,
  revoked_at    DATETIME(3)  NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_pat_hash (token_hash),
  KEY idx_pat_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='CLI / CI 个人访问令牌';

-- SCIM Groups 只做名录存储：不自动把 IdP 组映射到本地角色（见支持边界）。
CREATE TABLE sys_scim_group (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  external_id   VARCHAR(255) NOT NULL,
  display_name  VARCHAR(255) NOT NULL,
  members       LONGTEXT     NOT NULL COMMENT 'JSON array of local user ids',
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_scim_group_external (external_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='SCIM 组名录（不自动授予本地角色）';

CREATE TABLE sys_audit_archive (
  id           BIGINT       NOT NULL AUTO_INCREMENT,
  period_from  DATETIME(3)  NOT NULL,
  period_to    DATETIME(3)  NOT NULL,
  row_count    BIGINT       NOT NULL,
  file_path    VARCHAR(512) NOT NULL,
  sha256       CHAR(64)     NOT NULL COMMENT '归档文件整体 sha256，用于完整性核对',
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_archive_period (period_from, period_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='审计归档台账（先归档后清理）';

CREATE TABLE sys_audit_chain (
  id          TINYINT     NOT NULL,
  last_hash   CHAR(64)    NOT NULL,
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='审计哈希链水位（单节点）';

INSERT INTO sys_audit_chain (id, last_hash) VALUES (1, REPEAT('0', 64));

ALTER TABLE sys_audit_log
  ADD COLUMN provider    VARCHAR(32) NOT NULL DEFAULT 'local' COMMENT '登录/供给来源：local / oidc / saml / ldap / header / scim / pat' AFTER target_id,
  ADD COLUMN actor_type  VARCHAR(16) NOT NULL DEFAULT 'user'   COMMENT 'user / provider / system' AFTER provider,
  ADD COLUMN prev_hash   CHAR(64)    NULL COMMENT '上一条审计的 entry_hash（哈希链）' AFTER actor_type,
  ADD COLUMN entry_hash  CHAR(64)    NULL COMMENT '本条规范化字段的 SHA-256' AFTER prev_hash,
  ADD COLUMN legal_hold  TINYINT     NOT NULL DEFAULT 0 COMMENT '1 = 法务保全，任何清理任务不得删除' AFTER entry_hash,
  ADD INDEX idx_audit_created (created_at),
  ADD INDEX idx_audit_hold (legal_hold, created_at);
