package com.xbeeant.reqora.server.user;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.xbeeant.reqora.server.auth.PrincipalLoader;
import com.xbeeant.reqora.server.auth.RefreshTokenMapper;
import com.xbeeant.reqora.server.auth.RefreshTokenService;
import com.xbeeant.reqora.server.audit.AuditService;
import com.xbeeant.reqora.server.common.Access;
import com.xbeeant.reqora.server.common.AuthUser;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.common.PageResult;
import com.xbeeant.reqora.server.common.Permissions;
import com.xbeeant.reqora.server.member.ProjectMemberEntity;
import com.xbeeant.reqora.server.member.ProjectMemberMapper;
import com.xbeeant.reqora.server.organization.OrgMemberEntity;
import com.xbeeant.reqora.server.organization.OrgMemberMapper;
import com.xbeeant.reqora.server.organization.OrganizationEntity;
import com.xbeeant.reqora.server.organization.OrganizationMapper;
import com.xbeeant.reqora.server.project.ProjectEntity;
import com.xbeeant.reqora.server.project.ProjectMapper;
import com.xbeeant.reqora.server.role.RoleEntity;
import com.xbeeant.reqora.server.role.RoleMapper;
import com.xbeeant.reqora.server.role.UserRoleEntity;
import com.xbeeant.reqora.server.role.UserRoleMapper;
import java.time.LocalDateTime;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class UserService {

    private final UserMapper userMapper;
    private final RoleMapper roleMapper;
    private final UserRoleMapper userRoleMapper;
    private final ProjectMemberMapper projectMemberMapper;
    private final OrgMemberMapper orgMemberMapper;
    private final ProjectMapper projectMapper;
    private final OrganizationMapper organizationMapper;
    private final RefreshTokenMapper refreshTokenMapper;
    private final PasswordEncoder passwordEncoder;
    private final RefreshTokenService refreshTokenService;
    private final PrincipalLoader principalLoader;
    private final AuditService auditService;

    public UserService(
            UserMapper userMapper,
            RoleMapper roleMapper,
            UserRoleMapper userRoleMapper,
            ProjectMemberMapper projectMemberMapper,
            OrgMemberMapper orgMemberMapper,
            ProjectMapper projectMapper,
            OrganizationMapper organizationMapper,
            RefreshTokenMapper refreshTokenMapper,
            PasswordEncoder passwordEncoder,
            RefreshTokenService refreshTokenService,
            PrincipalLoader principalLoader,
            AuditService auditService) {
        this.userMapper = userMapper;
        this.roleMapper = roleMapper;
        this.userRoleMapper = userRoleMapper;
        this.projectMemberMapper = projectMemberMapper;
        this.orgMemberMapper = orgMemberMapper;
        this.projectMapper = projectMapper;
        this.organizationMapper = organizationMapper;
        this.refreshTokenMapper = refreshTokenMapper;
        this.passwordEncoder = passwordEncoder;
        this.refreshTokenService = refreshTokenService;
        this.principalLoader = principalLoader;
        this.auditService = auditService;
    }

    public PageResult<UserDtos.UserSummary> list(long page, long size, String keyword) {
        Access.requireSystem(Permissions.USER_READ);
        LambdaQueryWrapper<UserEntity> wrapper = new LambdaQueryWrapper<>();
        if (keyword != null && !keyword.isBlank()) {
            String like = "%" + keyword.trim() + "%";
            wrapper.and(q -> q.like(UserEntity::getUsername, like)
                    .or().like(UserEntity::getEmail, like)
                    .or().like(UserEntity::getDisplayName, like));
        }
        wrapper.orderByDesc(UserEntity::getId);
        IPage<UserEntity> result = userMapper.selectPage(Page.of(page, size), wrapper);
        List<UserDtos.UserSummary> rows = result.getRecords().stream()
                .map(user -> new UserDtos.UserSummary(
                        user.getId(), user.getUsername(), user.getEmail(), user.getDisplayName(),
                        user.getStatus(), user.getCreatedAt()))
                .toList();
        return new PageResult<>(rows, result.getTotal(), result.getCurrent(), result.getSize());
    }

    public UserView detail(long userId) {
        Access.requireSystem(Permissions.USER_READ);
        return principalLoader.viewAny(userId);
    }

    /**
     * Admin-provisioned account. Unlike open registration this is gated by
     * `system:user:write`, and a non-super admin may only create plain USERs —
     * otherwise any ADMIN could mint a SUPER_ADMIN and escalate itself.
     */
    @Transactional
    public UserView create(UserDtos.CreateUserRequest request) {
        AuthUser actor = Access.requireSystem(Permissions.USER_WRITE);
        String username = request.username().trim();
        String email = request.email().trim();
        if (principalLoader.byUsername(username) != null) {
            throw new BizException(ErrorCode.CONFLICT, "用户名已被使用");
        }
        if (userMapper.selectCount(new LambdaQueryWrapper<UserEntity>()
                .eq(UserEntity::getEmail, email)) > 0) {
            throw new BizException(ErrorCode.CONFLICT, "邮箱已被使用");
        }
        Set<String> requested = request.roles() == null
                ? Set.of("USER")
                : request.roles().stream()
                        .filter(code -> code != null && !code.isBlank())
                        .map(String::trim)
                        .collect(Collectors.toSet());
        if (requested.isEmpty()) {
            requested = Set.of("USER");
        }
        if (!actor.superAdmin() && requested.stream().anyMatch(code -> !"USER".equals(code))) {
            throw new BizException(ErrorCode.FORBIDDEN, "只有超级管理员可以分配 USER 以外的角色");
        }
        List<RoleEntity> roles = roleMapper.selectList(new LambdaQueryWrapper<RoleEntity>()
                .in(RoleEntity::getCode, requested));
        if (roles.size() != requested.size()) {
            throw new BizException(ErrorCode.BAD_REQUEST, "包含不存在的角色");
        }

        UserEntity user = new UserEntity();
        user.setUsername(username);
        user.setEmail(email);
        user.setDisplayName(request.displayName() == null || request.displayName().isBlank()
                ? username : request.displayName().trim());
        user.setPasswordHash(passwordEncoder.encode(request.password()));
        user.setStatus(1);
        userMapper.insert(user);
        for (RoleEntity role : roles) {
            UserRoleEntity link = new UserRoleEntity();
            link.setUserId(user.getId());
            link.setRoleId(role.getId());
            link.setCreatedAt(LocalDateTime.now());
            userRoleMapper.insert(link);
        }
        auditService.record("user.create", "user", user.getId(), "管理员创建用户 " + username);
        return principalLoader.view(user.getId());
    }

    @Transactional
    public UserView setStatus(long userId, boolean enabled) {
        AuthUser actor = Access.requireSystem(Permissions.USER_WRITE);
        if (actor.id().equals(userId) && !enabled) {
            throw new BizException(ErrorCode.CONFLICT, "不能停用自己的账号");
        }
        UserEntity user = requireUser(userId);
        user.setStatus(enabled ? 1 : 0);
        userMapper.updateById(user);
        if (!enabled) {
            refreshTokenService.revokeAll(userId);
        }
        auditService.record("user.status", "user", userId, enabled ? "启用账号" : "停用账号");
        return principalLoader.viewAny(userId);
    }

    @Transactional
    public UserView setRoles(long userId, List<String> roleCodes) {
        AuthUser actor = Access.requireSystem(Permissions.USER_WRITE);
        UserEntity user = requireUser(userId);
        Set<String> requested = new HashSet<>(roleCodes);
        Set<String> before = principalLoader.roleCodes(userId);
        String denial = com.xbeeant.reqora.server.admin.AdminRules.validateGrant(
                before, requested, "replace", actor.superAdmin(), actor.id().equals(userId));
        if (denial != null) {
            throw new BizException(ErrorCode.FORBIDDEN, denial);
        }
        if (before.contains("SUPER_ADMIN") && !requested.contains("SUPER_ADMIN")
                && countSuperAdmins() <= 1) {
            throw new BizException(ErrorCode.CONFLICT, "不能移除最后一个超级管理员");
        }
        List<RoleEntity> roles = roleMapper.selectList(new LambdaQueryWrapper<RoleEntity>()
                .in(RoleEntity::getCode, requested));
        if (roles.size() != requested.size()) {
            throw new BizException(ErrorCode.BAD_REQUEST, "包含不存在的角色");
        }
        userRoleMapper.delete(new LambdaQueryWrapper<UserRoleEntity>()
                .eq(UserRoleEntity::getUserId, userId));
        for (RoleEntity role : roles) {
            UserRoleEntity link = new UserRoleEntity();
            link.setUserId(userId);
            link.setRoleId(role.getId());
            link.setCreatedAt(LocalDateTime.now());
            userRoleMapper.insert(link);
        }
        auditService.record("user.roles", "user", userId,
                "设置角色：" + roles.stream().map(RoleEntity::getCode).collect(Collectors.joining(",")));
        return principalLoader.viewAny(userId);
    }

    @Transactional
    public void resetPassword(long userId, String newPassword) {
        Access.requireSystem(Permissions.USER_WRITE);
        UserEntity user = requireUser(userId);
        user.setPasswordHash(passwordEncoder.encode(newPassword));
        userMapper.updateById(user);
        refreshTokenService.revokeAll(userId);
        auditService.record("user.password.reset", "user", userId, "管理员重置口令");
    }

    @Transactional
    public void changePassword(long userId, String oldPassword, String newPassword) {
        UserEntity user = requireUser(userId);
        if (!passwordEncoder.matches(oldPassword, user.getPasswordHash())) {
            throw new BizException(ErrorCode.BAD_CREDENTIALS, "原密码不正确");
        }
        user.setPasswordHash(passwordEncoder.encode(newPassword));
        userMapper.updateById(user);
        refreshTokenService.revokeAll(userId);
        auditService.record("user.password.change", "user", userId, "用户修改口令");
    }

    /**
     * Hard-delete an account and every membership row it owns. Refuses to
     * orphan projects/organizations (the operator must transfer or delete
     * them first) and refuses to remove the last super administrator.
     */
    @Transactional
    public void delete(long userId) {
        AuthUser actor = Access.requireSystem(Permissions.USER_WRITE);
        if (actor.id().equals(userId)) {
            throw new BizException(ErrorCode.CONFLICT, "不能删除自己的账号");
        }
        UserEntity user = requireUser(userId);
        Set<String> roles = principalLoader.roleCodes(userId);
        if (roles.contains("SUPER_ADMIN") && countSuperAdmins() <= 1) {
            throw new BizException(ErrorCode.CONFLICT, "不能删除最后一个超级管理员");
        }
        long ownedProjects = projectMapper.selectCount(new LambdaQueryWrapper<ProjectEntity>()
                .eq(ProjectEntity::getOwnerId, userId));
        long ownedOrgs = organizationMapper.selectCount(new LambdaQueryWrapper<OrganizationEntity>()
                .eq(OrganizationEntity::getOwnerId, userId));
        if (ownedProjects > 0 || ownedOrgs > 0) {
            throw new BizException(ErrorCode.CONFLICT,
                    "该用户仍拥有 " + ownedProjects + " 个项目 / " + ownedOrgs + " 个组织，请先转让或删除");
        }

        refreshTokenService.revokeAll(userId);
        refreshTokenMapper.delete(new LambdaQueryWrapper<com.xbeeant.reqora.server.auth.RefreshTokenEntity>()
                .eq(com.xbeeant.reqora.server.auth.RefreshTokenEntity::getUserId, userId));
        userRoleMapper.delete(new LambdaQueryWrapper<UserRoleEntity>()
                .eq(UserRoleEntity::getUserId, userId));
        projectMemberMapper.delete(new LambdaQueryWrapper<ProjectMemberEntity>()
                .eq(ProjectMemberEntity::getUserId, userId));
        orgMemberMapper.delete(new LambdaQueryWrapper<OrgMemberEntity>()
                .eq(OrgMemberEntity::getUserId, userId));
        userMapper.deleteById(userId);
        auditService.record("user.delete", "user", userId, "删除用户 " + user.getUsername());
    }

    public int countSuperAdmins() {
        RoleEntity superRole = roleMapper.selectOne(new LambdaQueryWrapper<RoleEntity>()
                .eq(RoleEntity::getCode, "SUPER_ADMIN").last("LIMIT 1"));
        if (superRole == null) {
            return 0;
        }
        return (int) userRoleMapper.selectList(new LambdaQueryWrapper<UserRoleEntity>()
                        .eq(UserRoleEntity::getRoleId, superRole.getId())).stream()
                .map(UserRoleEntity::getUserId)
                .distinct()
                .count();
    }

    private UserEntity requireUser(long userId) {
        UserEntity user = userMapper.selectById(userId);
        if (user == null) {
            throw BizException.notFound("用户");
        }
        return user;
    }
}
