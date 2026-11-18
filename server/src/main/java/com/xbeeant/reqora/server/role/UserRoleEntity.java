package com.xbeeant.reqora.server.role;

import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@TableName("sys_user_role")
public class UserRoleEntity {

    private Long userId;

    private Long roleId;

    private LocalDateTime createdAt;
}
