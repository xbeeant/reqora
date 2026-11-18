package com.xbeeant.reqora.server.workspace;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;
import lombok.ToString;

/** One shared genesis + latest bootstrap snapshot per collaboration space. */
@Data
@TableName("ws_crdt_snapshot")
public class CrdtSnapshotEntity {

    @TableId(type = IdType.INPUT)
    private Long projectId;

    /** A.save(A.from(empty doc)) bytes; every replica must load this exact value. */
    @ToString.Exclude
    private byte[] genesis;

    /** Latest client-uploaded A.save(doc) bytes; accelerates new-replica bootstrap. */
    @ToString.Exclude
    private byte[] doc;

    /** JSON array of heads at snapshot time (diagnostics only). */
    private String heads;

    /** Largest change seq already contained in {@link #doc}. */
    private Long snapshotSeq;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
