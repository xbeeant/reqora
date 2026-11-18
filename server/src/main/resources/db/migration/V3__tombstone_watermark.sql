-- V3: 墓碑 compaction 水位
--
-- 墓碑（软删行）只服务于「删除传播」：超过保留期后服务端会物理清除
-- （compaction）。被清除的墓碑无法再出现在增量拉取里，因此离线超过
-- 保留期的客户端（cursor 落后于水位）会静默错过删除。
--
-- compacted_version 记录「墓碑已回收到该版本」：GET /rows?since= 的
-- cursor 小于它时，增量保证不再成立，服务端退化为全量拉取并在响应上
-- 标记 full=true，客户端整体替换本地视图而不是叠加基线，保证收敛。

ALTER TABLE ws_workspace_meta
  ADD COLUMN compacted_version BIGINT NOT NULL DEFAULT 0
    COMMENT '墓碑已回收到该版本：cursor 小于它的增量拉取退化为全量' AFTER version;
