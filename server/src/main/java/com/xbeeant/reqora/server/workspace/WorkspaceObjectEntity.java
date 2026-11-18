package com.xbeeant.reqora.server.workspace;

import com.baomidou.mybatisplus.annotation.TableName;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import java.time.LocalDateTime;
import lombok.Data;

/**
 * One content-addressed workspace object: the serialized {@code data} payload
 * of an oversized row, stored by sha256 so identical content is written once.
 * Rows carry {@code { "__blob": hash, "size": n, "encoding": "json" }} on the
 * wire; clients hydrate the payload after download. Objects are scoped per
 * project (authorization + isolation) and idempotent to upload.
 */
@Data
@TableName("ws_object")
public class WorkspaceObjectEntity {

    /** Composite key with {@link #hash}: objects never leak across projects. */
    private Long projectId;

    /** sha256 of the content (64-char lowercase hex). */
    @TableId(value = "hash", type = IdType.INPUT)
    private String hash;

    private Long size;

    private byte[] content;

    private Long uploadedBy;

    private LocalDateTime createdAt;
}
