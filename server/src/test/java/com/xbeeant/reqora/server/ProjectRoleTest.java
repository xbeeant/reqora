package com.xbeeant.reqora.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.xbeeant.reqora.server.project.ProjectCapability;
import com.xbeeant.reqora.server.project.ProjectRole;
import org.junit.jupiter.api.Test;

class ProjectRoleTest {

    @Test
    void viewerCanOnlyRead() {
        ProjectRole role = ProjectRole.VIEWER;
        assertTrue(role.allows(ProjectCapability.WORKSPACE_READ));
        assertFalse(role.allows(ProjectCapability.WORKSPACE_WRITE));
        assertFalse(role.allows(ProjectCapability.MEMBER_WRITE));
        assertFalse(role.allows(ProjectCapability.PROJECT_DELETE));
    }

    @Test
    void editorCanWriteWorkspaceButNotManageMembers() {
        ProjectRole role = ProjectRole.EDITOR;
        assertTrue(role.allows(ProjectCapability.WORKSPACE_WRITE));
        assertFalse(role.allows(ProjectCapability.MEMBER_WRITE));
        assertFalse(role.allows(ProjectCapability.PROJECT_ARCHIVE));
    }

    @Test
    void adminCannotDeleteProjectOrTransferOwner() {
        ProjectRole role = ProjectRole.ADMIN;
        assertTrue(role.allows(ProjectCapability.MEMBER_WRITE));
        assertTrue(role.allows(ProjectCapability.PROJECT_UPDATE));
        assertFalse(role.allows(ProjectCapability.PROJECT_DELETE));
        assertFalse(role.allows(ProjectCapability.OWNER_TRANSFER));
    }

    @Test
    void ownerHasEveryCapabilityAndRanksAreOrdered() {
        for (ProjectCapability capability : ProjectCapability.values()) {
            assertTrue(ProjectRole.OWNER.allows(capability));
        }
        assertTrue(ProjectRole.VIEWER.rank() < ProjectRole.EDITOR.rank());
        assertTrue(ProjectRole.EDITOR.rank() < ProjectRole.ADMIN.rank());
        assertTrue(ProjectRole.ADMIN.rank() < ProjectRole.OWNER.rank());
    }

    @Test
    void parsesCaseInsensitivelyAndRejectsUnknownRoles() {
        assertEquals(ProjectRole.EDITOR, ProjectRole.parse(" editor "));
        assertThrows(IllegalArgumentException.class, () -> ProjectRole.parse("ROOT"));
        assertThrows(IllegalArgumentException.class, () -> ProjectRole.parse(null));
    }
}
