package com.xbeeant.reqora.server.organization;

/** Organization-level roles, independent from the system RBAC roles. */
public enum OrgRole {
    MEMBER(1),
    ADMIN(2),
    OWNER(3);

    private final int rank;

    OrgRole(int rank) {
        this.rank = rank;
    }

    public int rank() {
        return rank;
    }

    public boolean canManage() {
        return rank >= ADMIN.rank;
    }

    public static OrgRole parse(String value) {
        if (value == null) return MEMBER;
        try {
            return valueOf(value.trim().toUpperCase());
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("未知的组织角色: " + value);
        }
    }
}
