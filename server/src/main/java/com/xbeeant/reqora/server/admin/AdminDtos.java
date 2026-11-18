package com.xbeeant.reqora.server.admin;

import com.xbeeant.reqora.server.audit.AuditLogEntity;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import java.time.LocalDateTime;
import java.util.List;

/** Request/response shapes of the self-hosted admin console. */
public final class AdminDtos {

    private AdminDtos() {}

    public record Overview(
            long users,
            long enabledUsers,
            long disabledUsers,
            long roles,
            long permissions,
            long projects,
            long activeProjects,
            long archivedProjects,
            long organizations,
            long auditTotal,
            long auditToday,
            List<AuditLogEntity> recentLogs,
            LocalDateTime serverTime) {}

    public record OrgRow(
            Long id,
            String name,
            String slug,
            String description,
            Long ownerId,
            String ownerName,
            String status,
            long memberCount,
            long projectCount,
            LocalDateTime createdAt) {}

    public record OrgMemberRow(
            Long userId,
            String username,
            String email,
            String displayName,
            String role,
            String joinedAt) {}

    public record AddOrgMemberRequest(@NotBlank String username, @NotBlank String role) {}

    public record UpdateOrgMemberRequest(@NotBlank String role) {}

    public record BatchGrantRequest(
            @NotEmpty List<Long> userIds,
            @NotEmpty List<String> roleCodes,
            @NotBlank String mode) {}

    public record BatchGrantResult(int updated, List<String> skipped) {}

    /** 管理端文档站分享视图（含项目名称，关联 pm_project）。 */
    public record DocSiteAdminView(
            Long id,
            Long projectId,
            String projectName,
            String projectSlug,
            String title,
            String status,
            Long viewCount,
            LocalDateTime expiresAt,
            LocalDateTime createdAt) {}
}
