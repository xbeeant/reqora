package com.xbeeant.reqora.server.audit;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

/** One append-only audit row. New columns are added by V4__identity_and_audit.sql. */
@Data
@TableName("sys_audit_log")
public class AuditLogEntity {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long actorId;

    private String actorName;

    private String action;

    private String targetType;

    private String targetId;

    private String detail;

    private String requestId;

    private String ip;

    /** local / oidc / saml / ldap / header / scim / pat. */
    private String provider;

    /** user / provider / system. */
    private String actorType;

    private String prevHash;

    private String entryHash;

    /** 1 = legal hold, never purged by the retention task. */
    private Integer legalHold;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
