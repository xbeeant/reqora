package com.xbeeant.reqora.server.role;

import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

@Data
@TableName("sys_role_permission")
public class RolePermissionEntity {

    private Long roleId;

    private Long permissionId;
}
