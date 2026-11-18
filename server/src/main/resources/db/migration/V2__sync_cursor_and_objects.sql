-- V2: 增量同步游标 + 内容寻址对象存储
--
-- 1) row_version：行级单调版本，由服务端在每次 sync 应用行时赋值 = 该次
--    同步的 ws_workspace_meta.version。客户端以「已见到的最大 row_version」
--    为游标做增量拉取（GET /rows?since=<cursor>），全量拉取只在首次绑定 /
--    基线丢失时发生。存量行初始化为所属项目当前的 meta.version（或 1），
--    保证迁移后 cursor 语义连续：未再变动的行不会重复出现在增量里。
--
-- 2) ws_object：大字段外置。行 data 超过客户端阈值时以 sha256 内容寻址
--    上传到对象表，行内只留引用（{ "__blob": hash, "size": n,
--    "encoding": "json" }），行本身恒小，单行体积不再受同步请求上限约束。

ALTER TABLE ws_entity
  ADD COLUMN row_version BIGINT NOT NULL DEFAULT 1
    COMMENT '行级单调版本（服务端分配，增量拉取游标）' AFTER updated_at;

UPDATE ws_entity e
  JOIN ws_workspace_meta m ON m.project_id = e.project_id
  SET e.row_version = GREATEST(m.version, 1);

CREATE INDEX idx_entity_row_version ON ws_entity (project_id, row_version);

CREATE TABLE ws_object (
  project_id  BIGINT      NOT NULL COMMENT '归属协作空间（对象随空间隔离与鉴权）',
  hash        CHAR(64)    NOT NULL COMMENT '内容 sha256（64 位 hex）',
  size        BIGINT      NOT NULL COMMENT '字节数',
  content     LONGBLOB    NOT NULL COMMENT '对象内容（JSON 序列化的行 data）',
  uploaded_by BIGINT      NOT NULL DEFAULT 0,
  created_at  DATETIME    NULL,
  PRIMARY KEY (project_id, hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作区内容寻址大对象';
