package com.xbeeant.reqora.server.common;

/** Shared system-level authorization gate used by services (never by controllers). */
public final class Access {

    private Access() {}

    public static AuthUser requireSystem(String permission) {
        AuthUser actor = CurrentUser.require();
        if (!actor.has(permission)) {
            throw new BizException(ErrorCode.FORBIDDEN, "缺少权限：" + permission);
        }
        return actor;
    }

    /**
     * Gate for aggregate/admin surfaces that should be visible to any operator
     * holding at least one governance permission, without handing the whole
     * console to a plain USER. Super admins always pass.
     */
    public static AuthUser requireAny(String... permissions) {
        AuthUser actor = CurrentUser.require();
        for (String permission : permissions) {
            if (actor.has(permission)) {
                return actor;
            }
        }
        throw new BizException(ErrorCode.FORBIDDEN, "需要管理端权限");
    }
}
