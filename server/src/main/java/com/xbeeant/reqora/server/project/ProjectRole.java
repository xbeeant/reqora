package com.xbeeant.reqora.server.project;

import java.util.EnumSet;
import java.util.Set;

/** Project-scoped RBAC roles, ordered by rank (higher wins for capability checks). */
public enum ProjectRole {
    VIEWER(1, EnumSet.of(ProjectCapability.PROJECT_READ, ProjectCapability.MEMBER_READ,
            ProjectCapability.WORKSPACE_READ)),
    EDITOR(2, EnumSet.of(ProjectCapability.PROJECT_READ, ProjectCapability.MEMBER_READ,
            ProjectCapability.WORKSPACE_READ, ProjectCapability.WORKSPACE_WRITE)),
    ADMIN(3, EnumSet.of(ProjectCapability.PROJECT_READ, ProjectCapability.PROJECT_UPDATE,
            ProjectCapability.MEMBER_READ, ProjectCapability.MEMBER_WRITE,
            ProjectCapability.WORKSPACE_READ, ProjectCapability.WORKSPACE_WRITE)),
    OWNER(4, EnumSet.allOf(ProjectCapability.class));

    private final int rank;
    private final Set<ProjectCapability> capabilities;

    ProjectRole(int rank, Set<ProjectCapability> capabilities) {
        this.rank = rank;
        this.capabilities = capabilities;
    }

    public int rank() {
        return rank;
    }

    public boolean allows(ProjectCapability capability) {
        return capabilities.contains(capability);
    }

    public static ProjectRole parse(String value) {
        if (value == null) {
            throw new IllegalArgumentException("项目角色不能为空");
        }
        try {
            return valueOf(value.trim().toUpperCase());
        } catch (IllegalArgumentException ex) {
            throw new IllegalArgumentException("未知项目角色：" + value);
        }
    }
}
