package com.xbeeant.reqora.server.workspace;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;
import lombok.ToString;

/**
 * One append-only Automerge change. {@code seq} is the incremental-download
 * cursor; {@code (projectId, hash)} is the idempotency key. The server never
 * parses {@code payload} — causal ordering lives inside the change itself.
 */
@Data
@TableName("ws_crdt_change")
public class CrdtChangeEntity {

    @TableId(value = "seq", type = IdType.AUTO)
    private Long seq;

    private Long projectId;

    /** Automerge change hash (64 lowercase hex), content-addressed. */
    private String hash;

    private String actorId;

    /** JSON array of decodeChange(change).deps, diagnostics only. */
    private String deps;

    @ToString.Exclude
    private byte[] payload;

    private Long uploadedBy;

    private LocalDateTime createdAt;
}
