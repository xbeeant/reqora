package com.xbeeant.reqora.server.invitation;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@TableName("sys_invitation")
public class InvitationEntity {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long orgId;

    /** SHA-256 of the opaque token; the raw token is returned exactly once. */
    private String tokenHash;

    private String role;

    private String label;

    private Long invitedBy;

    private LocalDateTime expiresAt;

    private Integer maxUses;

    private Integer usedCount;

    /** ACTIVE / REVOKED / EXPIRED. */
    private String status;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
