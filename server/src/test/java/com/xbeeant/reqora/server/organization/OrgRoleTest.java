package com.xbeeant.reqora.server.organization;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class OrgRoleTest {

    @Test
    void ranksAreOrderedAndOnlyAdminsManage() {
        assertTrue(OrgRole.OWNER.rank() > OrgRole.ADMIN.rank());
        assertTrue(OrgRole.ADMIN.rank() > OrgRole.MEMBER.rank());
        assertTrue(OrgRole.OWNER.canManage());
        assertTrue(OrgRole.ADMIN.canManage());
        assertFalse(OrgRole.MEMBER.canManage());
    }

    @Test
    void parseIsCaseInsensitiveAndDefaultsSafely() {
        assertEquals(OrgRole.ADMIN, OrgRole.parse(" admin "));
        assertEquals(OrgRole.MEMBER, OrgRole.parse(null));
    }

    @Test
    void unknownRoleIsRejected() {
        assertThrows(IllegalArgumentException.class, () -> OrgRole.parse("ROOT"));
    }
}
