package com.xbeeant.reqora.server.workspace;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;
import lombok.ToString;

/**
 * Per-project workspace metadata: sync version counter (notification only),
 * active environment and the shareable settings subset. Local-only fields
 * (history, trash, db connections, MCP servers, credentials in settings)
 * never reach this table — see lib/cloudSync.ts.
 */
@Data
@TableName("ws_workspace_meta")
public class WorkspaceMetaEntity {

    @TableId(type = IdType.INPUT)
    private Long projectId;

    /** Sync counter for SSE / polling; not used for conflict detection. */
    private Long version;

    /**
     * Tombstone-compaction watermark: tombstones applied at versions &le; this
     * value may have been physically removed, so a delta pull whose cursor is
     * below it is incomplete by definition — the server answers with the full
     * row set ({@code full=true}) instead of a delta.
     */
    private Long compactedVersion;

    private Boolean seeded;

    private String activeEnvironmentId;

    /** Shareable settings JSON (no local credential fields). */
    @ToString.Exclude
    private String settings;

    private Long updatedBy;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
