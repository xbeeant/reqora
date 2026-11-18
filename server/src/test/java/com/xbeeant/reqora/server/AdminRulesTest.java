package com.xbeeant.reqora.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.xbeeant.reqora.server.admin.AdminRules;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** Escalation guards behind the console's batch authorization screen. */
class AdminRulesTest {

    @Test
    void grantModesProduceTheExpectedRoleSet() {
        Set<String> before = Set.of("USER", "ADMIN");
        assertEquals(Set.of("SUPER_ADMIN"),
                AdminRules.applyGrant(before, Set.of("SUPER_ADMIN"), "replace"));
        assertEquals(Set.of("USER", "ADMIN", "AUDITOR"),
                AdminRules.applyGrant(before, Set.of("AUDITOR"), "add"));
        assertEquals(Set.of("USER"),
                AdminRules.applyGrant(before, Set.of("ADMIN"), "remove"));
        assertThrows(IllegalArgumentException.class,
                () -> AdminRules.applyGrant(before, Set.of("USER"), "grant"));
    }

    @Test
    void rejectsInvalidModesAndEmptyResults() {
        assertFalse(AdminRules.isGrantMode("grant"));
        assertFalse(AdminRules.isGrantMode(null));
        assertTrue(AdminRules.isGrantMode(" REPLACE "));
        assertNotNull(AdminRules.validateGrant(Set.of("USER"), Set.of("USER"), "grant", true, false));
        assertNotNull(AdminRules.validateGrant(Set.of("USER"), Set.of(), "replace", true, false));
        assertNotNull(AdminRules.validateGrant(Set.of("USER"), Set.of("USER"), "remove", true, false));
    }

    @Test
    void aNonSuperAdminCanOnlyDealInThePlainUserRole() {
        assertNull(AdminRules.validateGrant(Set.of("USER"), Set.of("USER"), "add", false, false));
        assertNotNull(AdminRules.validateGrant(
                Set.of("USER"), Set.of("SUPER_ADMIN"), "add", false, false));
        assertNotNull(AdminRules.validateGrant(
                Set.of("ADMIN"), Set.of("USER"), "replace", false, false));
        // The same operation is fine for a super admin.
        assertNull(AdminRules.validateGrant(
                Set.of("ADMIN"), Set.of("USER"), "replace", true, false));
    }

    @Test
    void nobodyCanStripSuperAdminFromThemselves() {
        String denial = AdminRules.validateGrant(
                Set.of("SUPER_ADMIN"), Set.of("USER"), "replace", true, true);
        assertEquals("不能移除自己的超级管理员角色", denial);
        assertNull(AdminRules.validateGrant(
                Set.of("SUPER_ADMIN"), Set.of("USER"), "replace", true, false));
    }

    @Test
    void lastSuperAdminIsProtected() {
        assertTrue(AdminRules.removesLastSuperAdmin(1, true, false));
        assertFalse(AdminRules.removesLastSuperAdmin(2, true, false));
        assertFalse(AdminRules.removesLastSuperAdmin(1, false, false));
        assertFalse(AdminRules.removesLastSuperAdmin(1, true, true));
    }

    @Test
    void organizationOwnerCannotBeAssigned() {
        assertTrue(AdminRules.isAssignableOrgRole(" member "));
        assertTrue(AdminRules.isAssignableOrgRole("ADMIN"));
        assertFalse(AdminRules.isAssignableOrgRole("OWNER"));
        assertFalse(AdminRules.isAssignableOrgRole("ROOT"));
        assertFalse(AdminRules.isAssignableOrgRole(null));
    }
}
