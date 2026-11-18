package com.xbeeant.reqora.server.organization;

import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

/** Composite key (org_id, user_id); only insert/delete/selectList are used. */
@Data
@TableName("sys_org_member")
public class OrgMemberEntity {

    private Long orgId;

    private Long userId;

    /** MEMBER / ADMIN / OWNER. */
    private String role;

    private LocalDateTime createdAt;
}
