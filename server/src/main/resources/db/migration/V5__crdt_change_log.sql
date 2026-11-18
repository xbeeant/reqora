-- V5: 同步协议 v2 —— Automerge 变更日志 + 共享 genesis 快照
--
-- 设计要点（见 docs/SYNC_PROTOCOL_V2.md）：
--   1) 服务端是「哑日志」：不解析 Automerge change、不做 LWW、不裁决冲突。
--      只负责按 seq 排序投递、按 hash 幂等去重、保存 bootstrap 快照。
--      最终状态由各客户端按因果收敛，与投递顺序无关。
--   2) ws_crdt_change 是 append-only。hash 是 change 的内容寻址 id，
--      UNIQUE(project_id, hash) 让重复点击 / 重放 / 多端并发上传同一笔 change
--      只落一行，不必另造 op_id，也不需要 If-Match CAS。
--   3) ws_crdt_snapshot 保存共享 genesis。所有副本必须 A.load() 同一份 genesis；
--      各自 A.from() 会产生各自的 init change，merge 后 root map 分叉、数据变空。
--      doc 是客户端周期性上传的压缩快照，仅加速新副本 bootstrap，不裁剪历史。
--   4) 旧端点 /workspace/rows|objects|head 与 ws_entity 表原样保留，
--      旧客户端不受影响；v2 客户端探测不到 bootstrap 时自动回退 v1。
--   5) version 不参与裁决：响应里的 version 取当前 max(seq)，天然单调，
--      避免 v1 的 ws_workspace_meta delete+insert 并发撞主键（1009）。

CREATE TABLE ws_crdt_snapshot (
  project_id   BIGINT       NOT NULL COMMENT '协作空间 id（一个空间一份 genesis）',
  genesis      LONGBLOB     NOT NULL COMMENT '共享 genesis：A.save(A.from(空文档)) 的字节',
  doc          LONGBLOB     NULL     COMMENT '最近一次客户端上传的压缩文档快照',
  heads        TEXT         NULL     COMMENT '快照对应的 heads（JSON array，诊断用）',
  snapshot_seq BIGINT       NOT NULL DEFAULT 0 COMMENT '快照已包含到的最大 change seq',
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='CRDT 共享 genesis 与 bootstrap 快照';

CREATE TABLE ws_crdt_change (
  seq          BIGINT       NOT NULL AUTO_INCREMENT COMMENT '全局单调投递序号（增量拉取游标）',
  project_id   BIGINT       NOT NULL COMMENT '归属协作空间',
  hash         CHAR(64)     NOT NULL COMMENT 'Automerge change hash（内容寻址，幂等键）',
  actor_id     VARCHAR(64)  NULL     COMMENT '产生该 change 的 actor，仅审计用',
  deps         TEXT         NULL     COMMENT 'decodeChange(change).deps（JSON array，仅审计用）',
  payload      LONGBLOB     NOT NULL COMMENT 'Automerge change 原始字节',
  uploaded_by  BIGINT       NOT NULL DEFAULT 0,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (seq),
  UNIQUE KEY uk_crdt_change_hash (project_id, hash),
  KEY idx_crdt_project_seq (project_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='CRDT 追加式变更日志';
