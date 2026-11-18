package com.xbeeant.reqora.server.common;

/** System-level permission codes (mirrors the seed data in V1__init.sql). */
public final class Permissions {

    public static final String USER_READ = "system:user:read";
    public static final String USER_WRITE = "system:user:write";
    public static final String ROLE_READ = "system:role:read";
    public static final String ROLE_WRITE = "system:role:write";
    public static final String ORG_READ = "system:org:read";
    public static final String ORG_WRITE = "system:org:write";
    public static final String AUDIT_READ = "system:audit:read";
    public static final String PROJECT_CREATE = "project:create";
    public static final String PROJECT_READ_ANY = "project:read_any";
    public static final String PROJECT_DELETE_ANY = "project:delete_any";

    private Permissions() {}
}
