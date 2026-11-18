package com.xbeeant.reqora.server.docsite;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;
import lombok.ToString;

/** A published documentation snapshot plus its opaque share token digest. */
@Data
@TableName("doc_site_share")
public class DocSiteEntity {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long projectId;

    /** SHA-256 hex digest of the opaque token; the raw token is returned once. */
    private String tokenHash;

    private String title;

    /** DocSitePayload JSON. Excluded from toString so logs never contain the payload. */
    @ToString.Exclude
    private String payload;

    private Long createdBy;

    /** Null means the link never expires. */
    private LocalDateTime expiresAt;

    private Long viewCount;

    /** ACTIVE / REVOKED / EXPIRED. */
    private String status;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
