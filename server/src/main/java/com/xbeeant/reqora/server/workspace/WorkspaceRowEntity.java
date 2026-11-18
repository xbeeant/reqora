package com.xbeeant.reqora.server.workspace;

import com.baomidou.mybatisplus.annotation.TableName;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import java.time.LocalDateTime;
import lombok.Data;
import lombok.ToString;

/**
 * One workspace entity row (统一行模型). Mirrors the desktop SQLite schema
 * (storage.rs): a row is one entity — folder / request / environment / case /
 * scenario / suite / artifact — with frequently-compared scalars as columns
 * and the remaining structure as a JSON payload in {@link #data}.
 *
 * {@code updatedAt} (client epoch millis) + {@code deleted} drive the row-level
 * merge (per-row last-writer-wins); {@code version} on the meta table is only
 * a change-notification counter.
 */
@Data
@TableName("ws_entity")
public class WorkspaceRowEntity {

    /** Client-generated globally-unique id (frontend uid). */
    @TableId(type = IdType.INPUT)
    private String id;

    private Long projectId;

    /** folder / request / environment / case / scenario / suite / artifact. */
    private String kind;

    /** NULL for folders; the owning folder id for requests. */
    private String parentId;

    /** Folder path inside the collection (a/b/c). */
    private String folderPath;

    private String name;

    /** kind=request: HTTP method. */
    private String method;

    /** kind=request: request URL, may contain {{variables}}. */
    @ToString.Exclude
    private String url;

    /** kind=request: http / ws / tcp. */
    private String protocol;

    /** kind=folder: collection-level auth JSON, redacted before upload. */
    @ToString.Exclude
    private String auth;

    private Integer position;

    /** kind=case: enabled flag. */
    private Boolean enabled;

    /** kind=case: 用例分组（正向/负向/边界值/安全性/其他）。 */
    private String caseGroup;

    /** kind=artifact: docPage / dataModel / scriptSnippet / codeTemplate. */
    private String subKind;

    /** Row-level merge key: client epoch millis. */
    private Long updatedAt;

    /**
     * Server-assigned monotonic version (= the meta.version of the sync that
     * applied this row). Cursor source for incremental download
     * ({@code GET /rows?since=}); never participates in merge decisions.
     */
    private Long rowVersion;

    /**
     * Soft-delete marker propagated by sync. The Java property is deliberately
     * named {@code tombstone} while the column stays {@code deleted}: the
     * global MyBatis-Plus logic-delete config ({@code logic-delete-field:
     * deleted}, aimed at sys_role) matches by property name and would silently
     * rewrite this entity's SQL — appending {@code WHERE deleted = 0} to every
     * SELECT (tombstones could never propagate) and turning the
     * deleteById+insert upsert into a duplicate-key failure.
     */
    @TableField("deleted")
    private Boolean tombstone;

    /** Row JSON payload (headers/body/doc/steps/...). */
    @ToString.Exclude
    private String data;

    private Long syncedBy;

    @TableField(fill = com.baomidou.mybatisplus.annotation.FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = com.baomidou.mybatisplus.annotation.FieldFill.INSERT_UPDATE)
    private LocalDateTime syncedAt;
}
