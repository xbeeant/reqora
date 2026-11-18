package com.xbeeant.reqora.server.admin;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.xbeeant.reqora.server.audit.AuditLogEntity;
import com.xbeeant.reqora.server.audit.AuditLogMapper;
import com.xbeeant.reqora.server.audit.AuditService;
import com.xbeeant.reqora.server.auth.PrincipalLoader;
import com.xbeeant.reqora.server.common.Access;
import com.xbeeant.reqora.server.common.AuthUser;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.common.PageResult;
import com.xbeeant.reqora.server.common.Permissions;
import com.xbeeant.reqora.server.docsite.DocSiteEntity;
import com.xbeeant.reqora.server.docsite.DocSiteMapper;
import com.xbeeant.reqora.server.organization.OrgMemberEntity;
import com.xbeeant.reqora.server.organization.OrgMemberMapper;
import com.xbeeant.reqora.server.organization.OrganizationEntity;
import com.xbeeant.reqora.server.organization.OrganizationMapper;
import com.xbeeant.reqora.server.project.ProjectEntity;
import com.xbeeant.reqora.server.project.ProjectMapper;
import com.xbeeant.reqora.server.role.PermissionMapper;
import com.xbeeant.reqora.server.role.RoleEntity;
import com.xbeeant.reqora.server.role.RoleMapper;
import com.xbeeant.reqora.server.role.UserRoleEntity;
import com.xbeeant.reqora.server.role.UserRoleMapper;
import com.xbeeant.reqora.server.user.UserEntity;
import com.xbeeant.reqora.server.user.UserMapper;
import com.xbeeant.reqora.server.user.UserService;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Read models and governance operations that only make sense for a console:
 * aggregate counts, cross-organization views and batch grants. Every method
 * gates itself with {@link Access}; controllers stay annotation-free to match
 * the rest of the codebase.
 */
@Service
public class AdminService {

    private final UserMapper userMapper;
    private final RoleMapper roleMapper;
    private final UserRoleMapper userRoleMapper;
    private final PermissionMapper permissionMapper;
    private final ProjectMapper projectMapper;
    private final OrganizationMapper organizationMapper;
    private final OrgMemberMapper orgMemberMapper;
    private final AuditLogMapper auditLogMapper;
    private final DocSiteMapper docSiteMapper;
    private final AuditService auditService;
    private final PrincipalLoader principalLoader;
    private final UserService userService;

    public AdminService(
            UserMapper userMapper,
            RoleMapper roleMapper,
            UserRoleMapper userRoleMapper,
            PermissionMapper permissionMapper,
            ProjectMapper projectMapper,
            OrganizationMapper organizationMapper,
            OrgMemberMapper orgMemberMapper,
            AuditLogMapper auditLogMapper,
            DocSiteMapper docSiteMapper,
            AuditService auditService,
            PrincipalLoader principalLoader,
            UserService userService) {
        this.userMapper = userMapper;
        this.roleMapper = roleMapper;
        this.userRoleMapper = userRoleMapper;
        this.permissionMapper = permissionMapper;
        this.projectMapper = projectMapper;
        this.organizationMapper = organizationMapper;
        this.orgMemberMapper = orgMemberMapper;
        this.auditLogMapper = auditLogMapper;
        this.docSiteMapper = docSiteMapper;
        this.auditService = auditService;
        this.principalLoader = principalLoader;
        this.userService = userService;
    }

    public AdminDtos.Overview overview() {
        AuthUser actor = Access.requireAny(
                Permissions.USER_READ, Permissions.ROLE_READ,
                Permissions.ORG_READ, Permissions.AUDIT_READ);
        LocalDateTime startOfToday = LocalDate.now().atStartOfDay();
        List<AuditLogEntity> recent = actor.has(Permissions.AUDIT_READ)
                ? auditLogMapper.selectList(new LambdaQueryWrapper<AuditLogEntity>()
                        .orderByDesc(AuditLogEntity::getId).last("LIMIT 8"))
                : List.of();
        return new AdminDtos.Overview(
                count(userMapper.selectCount(null)),
                count(userMapper.selectCount(new LambdaQueryWrapper<UserEntity>()
                        .eq(UserEntity::getStatus, 1))),
                count(userMapper.selectCount(new LambdaQueryWrapper<UserEntity>()
                        .eq(UserEntity::getStatus, 0))),
                count(roleMapper.selectCount(null)),
                count(permissionMapper.selectCount(null)),
                count(projectMapper.selectCount(null)),
                count(projectMapper.selectCount(new LambdaQueryWrapper<ProjectEntity>()
                        .eq(ProjectEntity::getStatus, "ACTIVE"))),
                count(projectMapper.selectCount(new LambdaQueryWrapper<ProjectEntity>()
                        .eq(ProjectEntity::getStatus, "ARCHIVED"))),
                count(organizationMapper.selectCount(null)),
                count(auditLogMapper.selectCount(null)),
                count(auditLogMapper.selectCount(new LambdaQueryWrapper<AuditLogEntity>()
                        .ge(AuditLogEntity::getCreatedAt, startOfToday))),
                recent,
                LocalDateTime.now());
    }

    /** All organizations with derived member/project counts; three queries total. */
    public List<AdminDtos.OrgRow> orgs() {
        Access.requireSystem(Permissions.ORG_READ);
        List<OrganizationEntity> orgs = organizationMapper.selectList(
                new LambdaQueryWrapper<OrganizationEntity>().orderByDesc(OrganizationEntity::getId));
        if (orgs.isEmpty()) {
            return List.of();
        }
        Map<Long, Long> memberCounts = new HashMap<>();
        for (OrgMemberEntity row : orgMemberMapper.selectList(null)) {
            memberCounts.merge(row.getOrgId(), 1L, Long::sum);
        }
        Map<Long, Long> projectCounts = new HashMap<>();
        for (ProjectEntity row : projectMapper.selectList(null)) {
            if (row.getOrgId() != null) {
                projectCounts.merge(row.getOrgId(), 1L, Long::sum);
            }
        }
        Map<Long, String> names = new HashMap<>();
        List<Long> ownerIds = orgs.stream().map(OrganizationEntity::getOwnerId)
                .filter(java.util.Objects::nonNull).distinct().toList();
        if (!ownerIds.isEmpty()) {
            userMapper.selectBatchIds(ownerIds).forEach(user -> names.put(user.getId(), user.getUsername()));
        }
        final Map<Long, String> ownerNames = names;
        return orgs.stream().map(org -> new AdminDtos.OrgRow(
                org.getId(), org.getName(), org.getSlug(), org.getDescription(),
                org.getOwnerId(), ownerNames.getOrDefault(org.getOwnerId(), ""),
                org.getStatus(), memberCounts.getOrDefault(org.getId(), 0L),
                projectCounts.getOrDefault(org.getId(), 0L), org.getCreatedAt())).toList();
    }

    public List<AdminDtos.OrgMemberRow> orgMembers(long orgId) {
        Access.requireSystem(Permissions.ORG_READ);
        requireOrg(orgId);
        List<Map<String, Object>> rows = orgMemberMapper.selectMemberRows(orgId);
        if (rows.isEmpty()) {
            return List.of();
        }
        List<Long> ids = rows.stream()
                .map(row -> ((Number) row.get("user_id")).longValue()).distinct().toList();
        Map<Long, UserEntity> users = new HashMap<>();
        userMapper.selectBatchIds(ids).forEach(user -> users.put(user.getId(), user));
        return rows.stream().map(row -> {
            long userId = ((Number) row.get("user_id")).longValue();
            UserEntity user = users.get(userId);
            return new AdminDtos.OrgMemberRow(
                    userId,
                    String.valueOf(row.get("username")),
                    user == null ? "" : user.getEmail(),
                    String.valueOf(row.get("display_name") == null ? "" : row.get("display_name")),
                    String.valueOf(row.get("role")),
                    String.valueOf(row.get("joined_at")));
        }).toList();
    }

    @Transactional
    public AdminDtos.OrgMemberRow addOrgMember(long orgId, AdminDtos.AddOrgMemberRequest request) {
        Access.requireSystem(Permissions.ORG_WRITE);
        requireOrg(orgId);
        String role = assignableOrgRole(request.role());
        UserEntity user = principalLoader.byUsername(request.username().trim());
        if (user == null) {
            throw BizException.notFound("用户");
        }
        if (orgMemberMapper.selectCount(new LambdaQueryWrapper<OrgMemberEntity>()
                .eq(OrgMemberEntity::getOrgId, orgId)
                .eq(OrgMemberEntity::getUserId, user.getId())) > 0) {
            throw new BizException(ErrorCode.CONFLICT, "该用户已是组织成员");
        }
        OrgMemberEntity membership = new OrgMemberEntity();
        membership.setOrgId(orgId);
        membership.setUserId(user.getId());
        membership.setRole(role);
        membership.setCreatedAt(LocalDateTime.now());
        orgMemberMapper.insert(membership);
        auditService.record("org.member.add", "organization", orgId,
                "添加成员 " + user.getUsername() + " (" + role + ")");
        return new AdminDtos.OrgMemberRow(user.getId(), user.getUsername(), user.getEmail(),
                user.getDisplayName(), role, membership.getCreatedAt().toString());
    }

    @Transactional
    public void changeOrgMemberRole(long orgId, long userId, AdminDtos.UpdateOrgMemberRequest request) {
        Access.requireSystem(Permissions.ORG_WRITE);
        OrganizationEntity org = requireOrg(orgId);
        if (org.getOwnerId() != null && org.getOwnerId().equals(userId)) {
            throw new BizException(ErrorCode.CONFLICT, "不能修改组织所有者的角色");
        }
        String role = assignableOrgRole(request.role());
        String current = orgMemberMapper.selectRole(orgId, userId);
        if (current == null) {
            throw BizException.notFound("组织成员");
        }
        if ("OWNER".equalsIgnoreCase(current)) {
            throw new BizException(ErrorCode.CONFLICT, "不能修改组织所有者的角色");
        }
        OrgMemberEntity patch = new OrgMemberEntity();
        patch.setRole(role);
        orgMemberMapper.update(patch, new LambdaUpdateWrapper<OrgMemberEntity>()
                .eq(OrgMemberEntity::getOrgId, orgId)
                .eq(OrgMemberEntity::getUserId, userId));
        auditService.record("org.member.role", "organization", orgId,
                "成员 " + userId + " 角色改为 " + role);
    }

    @Transactional
    public void removeOrgMember(long orgId, long userId) {
        Access.requireSystem(Permissions.ORG_WRITE);
        OrganizationEntity org = requireOrg(orgId);
        if (org.getOwnerId() != null && org.getOwnerId().equals(userId)) {
            throw new BizException(ErrorCode.CONFLICT, "不能移除组织所有者");
        }
        if (orgMemberMapper.selectRole(orgId, userId) == null) {
            throw BizException.notFound("组织成员");
        }
        orgMemberMapper.delete(new LambdaQueryWrapper<OrgMemberEntity>()
                .eq(OrgMemberEntity::getOrgId, orgId)
                .eq(OrgMemberEntity::getUserId, userId));
        auditService.record("org.member.remove", "organization", orgId, "移除成员 " + userId);
    }

    /**
     * Apply one role-set operation to many users atomically. Plans are computed
     * and verified first, so a rejected batch never leaves partial writes.
     */
    @Transactional
    public AdminDtos.BatchGrantResult batchGrant(AdminDtos.BatchGrantRequest request) {
        AuthUser actor = Access.requireSystem(Permissions.USER_WRITE);
        String mode = request.mode() == null ? "" : request.mode().trim().toLowerCase(Locale.ROOT);
        if (!AdminRules.isGrantMode(mode)) {
            throw new BizException(ErrorCode.BAD_REQUEST, "不支持的授权方式：" + request.mode());
        }
        Set<String> desired = request.roleCodes().stream()
                .filter(code -> code != null && !code.isBlank())
                .map(String::trim)
                .collect(Collectors.toCollection(LinkedHashSet::new));
        if (desired.isEmpty()) {
            throw new BizException(ErrorCode.BAD_REQUEST, "请至少选择一个角色");
        }
        Map<String, Long> roleIds = new HashMap<>();
        for (RoleEntity role : roleMapper.selectList(null)) {
            roleIds.put(role.getCode(), role.getId());
        }
        if (!roleIds.keySet().containsAll(desired)) {
            throw new BizException(ErrorCode.BAD_REQUEST, "包含不存在的角色");
        }

        List<Long> ids = request.userIds().stream().distinct().toList();
        Map<Long, UserEntity> users = new HashMap<>();
        if (!ids.isEmpty()) {
            userMapper.selectBatchIds(ids).forEach(user -> users.put(user.getId(), user));
        }
        Map<Long, Set<String>> currentRoles = currentRoleCodes(ids);

        List<String> skipped = new ArrayList<>();
        List<GrantPlan> plans = new ArrayList<>();
        for (Long id : ids) {
            UserEntity user = users.get(id);
            if (user == null) {
                skipped.add("用户 #" + id + " 不存在");
                continue;
            }
            Set<String> before = currentRoles.getOrDefault(id, Set.of());
            String denial = AdminRules.validateGrant(
                    before, desired, mode, actor.superAdmin(), actor.id().equals(id));
            if (denial != null) {
                skipped.add(user.getUsername() + "：" + denial);
                continue;
            }
            plans.add(new GrantPlan(id, user.getUsername(), before,
                    AdminRules.applyGrant(before, desired, mode)));
        }

        int remainingSuperAdmins = userService.countSuperAdmins();
        for (GrantPlan plan : plans) {
            if (plan.before.contains(AdminRules.SUPER_ADMIN)
                    && !plan.after.contains(AdminRules.SUPER_ADMIN)) {
                remainingSuperAdmins--;
            }
        }
        if (remainingSuperAdmins < 1) {
            throw new BizException(ErrorCode.CONFLICT, "不能移除最后一个超级管理员");
        }

        for (GrantPlan plan : plans) {
            if (plan.before.equals(plan.after)) {
                continue;
            }
            userRoleMapper.delete(new LambdaQueryWrapper<UserRoleEntity>()
                    .eq(UserRoleEntity::getUserId, plan.userId));
            for (String code : plan.after) {
                UserRoleEntity link = new UserRoleEntity();
                link.setUserId(plan.userId);
                link.setRoleId(roleIds.get(code));
                link.setCreatedAt(LocalDateTime.now());
                userRoleMapper.insert(link);
            }
        }
        auditService.record("user.roles.batch", "user", 0,
                "批量授权 mode=" + mode + " 角色=" + String.join(",", desired)
                        + " 影响 " + plans.size() + " 人");
        return new AdminDtos.BatchGrantResult(plans.size(), skipped);
    }

    private Map<Long, Set<String>> currentRoleCodes(List<Long> userIds) {
        Map<Long, Set<String>> result = new HashMap<>();
        if (userIds.isEmpty()) {
            return result;
        }
        Map<Long, String> codes = new HashMap<>();
        roleMapper.selectList(null).forEach(role -> codes.put(role.getId(), role.getCode()));
        for (UserRoleEntity link : userRoleMapper.selectList(
                new LambdaQueryWrapper<UserRoleEntity>().in(UserRoleEntity::getUserId, userIds))) {
            String code = codes.get(link.getRoleId());
            if (code != null) {
                result.computeIfAbsent(link.getUserId(), ignored -> new LinkedHashSet<>()).add(code);
            }
        }
        return result;
    }

    private OrganizationEntity requireOrg(long orgId) {
        OrganizationEntity org = organizationMapper.selectById(orgId);
        if (org == null) {
            throw BizException.notFound("组织");
        }
        return org;
    }

    /** List all published doc-site shares, optionally filtered by project / status / keyword. */
    public PageResult<AdminDtos.DocSiteAdminView> docSites(int page, int size,
                                                           Long projectId, String status, String keyword) {
        Access.requireAny(
                Permissions.USER_READ, Permissions.ROLE_READ,
                Permissions.ORG_READ, Permissions.AUDIT_READ);
        // Default to ACTIVE status (exclude REVOKED/EXPIRED)
        String filterStatus = status != null && !status.isBlank() ? status : "ACTIVE";
        if (!List.of("ACTIVE", "REVOKED", "EXPIRED").contains(filterStatus)) {
            throw new BizException(ErrorCode.BAD_REQUEST, "无效的状态筛选值");
        }

        LambdaQueryWrapper<DocSiteEntity> q = new LambdaQueryWrapper<>();
        q.eq(DocSiteEntity::getStatus, filterStatus)
                .orderByDesc(DocSiteEntity::getId);
        if (projectId != null) {
            q.eq(DocSiteEntity::getProjectId, projectId);
        }
        if (keyword != null && !keyword.isBlank()) {
            q.like(DocSiteEntity::getTitle, keyword.trim());
        }
        // BaseMapper selectPage needs total count first for pagination.
        long total = docSiteMapper.selectCount(q);
        q.last("LIMIT " + size + " OFFSET " + Math.max(0, (page - 1) * size));
        List<DocSiteEntity> rows = docSiteMapper.selectList(q);
        if (rows.isEmpty()) {
            return new PageResult<>(List.of(), total, page, size);
        }

        // Batch-load project info.
        List<Long> projectIds = rows.stream().map(DocSiteEntity::getProjectId).distinct().toList();
        Map<Long, ProjectEntity> projects = new HashMap<>();
        projectMapper.selectBatchIds(projectIds).forEach(p -> projects.put(p.getId(), p));

        List<AdminDtos.DocSiteAdminView> result = rows.stream().map(entity -> {
            ProjectEntity project = projects.get(entity.getProjectId());
            return new AdminDtos.DocSiteAdminView(
                    entity.getId(),
                    entity.getProjectId(),
                    project != null ? project.getName() : "(已删除)",
                    project != null ? project.getSlug() : "",
                    entity.getTitle(),
                    entity.getStatus(),
                    entity.getViewCount() == null ? 0L : entity.getViewCount(),
                    entity.getExpiresAt(),
                    entity.getCreatedAt());
        }).toList();
        return new PageResult<>(result, total, page, size);
    }

    /** OWNER is unique and fixed at creation; only MEMBER/ADMIN can be assigned. */
    private String assignableOrgRole(String raw) {
        if (!AdminRules.isAssignableOrgRole(raw)) {
            throw new BizException(ErrorCode.BAD_REQUEST,
                    "组织角色只能是 MEMBER 或 ADMIN（所有者不可指派）");
        }
        return raw.trim().toUpperCase(Locale.ROOT);
    }

    private static long count(Long value) {
        return value == null ? 0L : value;
    }

    private record GrantPlan(long userId, String username, Set<String> before, Set<String> after) {}
}
