package com.xbeeant.reqora.server.admin;

import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Pure, dependency-free authorization rules shared by the batch-grant API,
 * user role assignment and organization member management. Kept static so the
 * escalation guards can be unit tested without starting Spring.
 */
public final class AdminRules {

    public static final String SUPER_ADMIN = "SUPER_ADMIN";
    public static final String PLAIN_USER = "USER";
    public static final Set<String> GRANT_MODES = Set.of("replace", "add", "remove");
    public static final Set<String> ASSIGNABLE_ORG_ROLES = Set.of("MEMBER", "ADMIN");

    private AdminRules() {}

    public static boolean isGrantMode(String mode) {
        return mode != null && GRANT_MODES.contains(normalize(mode));
    }

    /** Computes the resulting role set without touching the database. */
    public static Set<String> applyGrant(Set<String> current, Set<String> requested, String mode) {
        String normalized = normalize(mode);
        if (!GRANT_MODES.contains(normalized)) {
            throw new IllegalArgumentException("不支持的授权方式：" + mode);
        }
        Set<String> result = new LinkedHashSet<>();
        if ("replace".equals(normalized) || "add".equals(normalized)) {
            if (!"replace".equals(normalized)) {
                result.addAll(current == null ? Set.of() : current);
            }
            result.addAll(requested == null ? Set.of() : requested);
        } else {
            result.addAll(current == null ? Set.of() : current);
            if (requested != null) {
                result.removeAll(requested);
            }
        }
        return result;
    }

    /**
     * Returns null when the grant is allowed, otherwise a user-facing reason.
     * Rules: never end with an empty role set; a non-super admin may only ever
     * deal in the plain USER role; nobody may strip SUPER_ADMIN from themselves.
     */
    public static String validateGrant(
            Set<String> current,
            Set<String> requested,
            String mode,
            boolean actorSuperAdmin,
            boolean self) {
        if (!isGrantMode(mode)) {
            return "不支持的授权方式：" + mode;
        }
        Set<String> before = current == null ? Set.of() : current;
        Set<String> desired = requested == null ? Set.of() : requested;
        Set<String> after = applyGrant(before, desired, mode);
        if (after.isEmpty()) {
            return "每个账号至少保留一个角色";
        }
        if (!actorSuperAdmin) {
            if (desired.stream().anyMatch(code -> !PLAIN_USER.equals(code))) {
                return "只有超级管理员可以分配 USER 以外的角色";
            }
            if (before.stream().anyMatch(code -> !PLAIN_USER.equals(code))) {
                return "只有超级管理员可以调整管理员账号的角色";
            }
        }
        if (self && before.contains(SUPER_ADMIN) && !after.contains(SUPER_ADMIN)) {
            return "不能移除自己的超级管理员角色";
        }
        return null;
    }

    /** Organization owner is unique and set at creation time. */
    public static boolean isAssignableOrgRole(String role) {
        return role != null && ASSIGNABLE_ORG_ROLES.contains(role.trim().toUpperCase(Locale.ROOT));
    }

    public static boolean removesLastSuperAdmin(
            int totalSuperAdmins, boolean targetIsSuperAdmin, boolean targetKeepsSuperAdmin) {
        return targetIsSuperAdmin && !targetKeepsSuperAdmin && totalSuperAdmins <= 1;
    }

    private static String normalize(String mode) {
        return mode == null ? "" : mode.trim().toLowerCase(Locale.ROOT);
    }
}
