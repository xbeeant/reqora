package com.xbeeant.reqora.server.role;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xbeeant.reqora.server.audit.AuditService;
import com.xbeeant.reqora.server.common.Access;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.common.Permissions;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class RoleService {

    private final RoleMapper roleMapper;
    private final PermissionMapper permissionMapper;
    private final RolePermissionMapper rolePermissionMapper;
    private final UserRoleMapper userRoleMapper;
    private final AuditService auditService;

    public RoleService(
            RoleMapper roleMapper,
            PermissionMapper permissionMapper,
            RolePermissionMapper rolePermissionMapper,
            UserRoleMapper userRoleMapper,
            AuditService auditService) {
        this.roleMapper = roleMapper;
        this.permissionMapper = permissionMapper;
        this.rolePermissionMapper = rolePermissionMapper;
        this.userRoleMapper = userRoleMapper;
        this.auditService = auditService;
    }

    /** Three queries total regardless of role count (no N+1). */
    public List<RoleDtos.RoleView> roles() {
        Access.requireSystem(Permissions.ROLE_READ);
        Map<Long, String> permissionCodes = new HashMap<>();
        for (PermissionEntity permission : permissionMapper.selectList(null)) {
            permissionCodes.put(permission.getId(), permission.getCode());
        }
        Map<Long, List<String>> byRole = new HashMap<>();
        for (RolePermissionEntity link : rolePermissionMapper.selectList(null)) {
            String code = permissionCodes.get(link.getPermissionId());
            if (code != null) {
                byRole.computeIfAbsent(link.getRoleId(), ignored -> new ArrayList<>()).add(code);
            }
        }
        return roleMapper.selectList(null).stream()
                .map(role -> new RoleDtos.RoleView(
                        role.getId(), role.getCode(), role.getName(), role.getDescription(),
                        role.getBuiltin() != null && role.getBuiltin() == 1,
                        byRole.getOrDefault(role.getId(), List.of()).stream().sorted().toList(),
                        role.getCreatedAt()))
                .toList();
    }

    public List<RoleDtos.PermissionView> permissions() {
        Access.requireSystem(Permissions.ROLE_READ);
        return permissionMapper.selectList(null).stream()
                .map(permission -> new RoleDtos.PermissionView(
                        permission.getCode(), permission.getName(), permission.getModule(),
                        permission.getDescription() == null ? "" : permission.getDescription()))
                .sorted(java.util.Comparator.comparing(RoleDtos.PermissionView::module)
                        .thenComparing(RoleDtos.PermissionView::code))
                .toList();
    }

    @Transactional
    public RoleDtos.RoleView create(RoleDtos.CreateRoleRequest request) {
        Access.requireSystem(Permissions.ROLE_WRITE);
        String code = request.code().trim().toUpperCase();
        if (roleMapper.selectCount(new LambdaQueryWrapper<RoleEntity>()
                .eq(RoleEntity::getCode, code)) > 0) {
            throw new BizException(ErrorCode.CONFLICT, "角色编码已存在");
        }
        RoleEntity role = new RoleEntity();
        role.setCode(code);
        role.setName(request.name().trim());
        role.setDescription(request.description() == null ? "" : request.description());
        role.setBuiltin(0);
        roleMapper.insert(role);
        auditService.record("role.create", "role", role.getId(), "创建角色 " + code);
        return viewOf(role, List.of());
    }

    @Transactional
    public RoleDtos.RoleView update(long roleId, RoleDtos.UpdateRoleRequest request) {
        Access.requireSystem(Permissions.ROLE_WRITE);
        RoleEntity role = requireRole(roleId);
        if (role.getBuiltin() != null && role.getBuiltin() == 1) {
            throw new BizException(ErrorCode.CONFLICT, "内置角色不可修改");
        }
        role.setName(request.name().trim());
        role.setDescription(request.description() == null ? "" : request.description());
        roleMapper.updateById(role);
        auditService.record("role.update", "role", roleId, "更新角色 " + role.getCode());
        return viewOf(role, permissionCodesOf(roleId));
    }

    @Transactional
    public void delete(long roleId) {
        Access.requireSystem(Permissions.ROLE_WRITE);
        RoleEntity role = requireRole(roleId);
        if (role.getBuiltin() != null && role.getBuiltin() == 1) {
            throw new BizException(ErrorCode.CONFLICT, "内置角色不可删除");
        }
        rolePermissionMapper.delete(new LambdaQueryWrapper<RolePermissionEntity>()
                .eq(RolePermissionEntity::getRoleId, roleId));
        userRoleMapper.delete(new LambdaQueryWrapper<UserRoleEntity>()
                .eq(UserRoleEntity::getRoleId, roleId));
        roleMapper.deleteById(roleId);
        auditService.record("role.delete", "role", roleId, "删除角色 " + role.getCode());
    }

    @Transactional
    public List<String> setPermissions(long roleId, List<String> codes) {
        var actor = Access.requireSystem(Permissions.ROLE_WRITE);
        RoleEntity role = requireRole(roleId);
        Set<String> requested = new HashSet<>(codes);
        // A delegated role manager must not grant permissions it does not hold.
        if (!actor.superAdmin()) {
            for (String code : requested) {
                if (!actor.has(code)) {
                    throw new BizException(ErrorCode.FORBIDDEN, "不能授予自己未持有的权限：" + code);
                }
            }
        }
        List<PermissionEntity> permissions = requested.isEmpty()
                ? List.of()
                : permissionMapper.selectList(new LambdaQueryWrapper<PermissionEntity>()
                        .in(PermissionEntity::getCode, requested));
        if (permissions.size() != requested.size()) {
            throw new BizException(ErrorCode.BAD_REQUEST, "包含不存在的权限点");
        }
        rolePermissionMapper.delete(new LambdaQueryWrapper<RolePermissionEntity>()
                .eq(RolePermissionEntity::getRoleId, roleId));
        for (PermissionEntity permission : permissions) {
            RolePermissionEntity link = new RolePermissionEntity();
            link.setRoleId(roleId);
            link.setPermissionId(permission.getId());
            rolePermissionMapper.insert(link);
        }
        auditService.record("role.permissions", "role", roleId,
                "更新权限：" + String.join(",", requested));
        return permissions.stream().map(PermissionEntity::getCode).sorted().toList();
    }

    private RoleEntity requireRole(long roleId) {
        RoleEntity role = roleMapper.selectById(roleId);
        if (role == null) {
            throw BizException.notFound("角色");
        }
        return role;
    }

    private List<String> permissionCodesOf(long roleId) {
        List<RolePermissionEntity> links = rolePermissionMapper.selectList(
                new LambdaQueryWrapper<RolePermissionEntity>()
                        .eq(RolePermissionEntity::getRoleId, roleId));
        if (links.isEmpty()) {
            return List.of();
        }
        Set<Long> ids = links.stream().map(RolePermissionEntity::getPermissionId).collect(
                java.util.stream.Collectors.toSet());
        return permissionMapper.selectBatchIds(ids).stream()
                .map(PermissionEntity::getCode).sorted().toList();
    }

    private RoleDtos.RoleView viewOf(RoleEntity role, List<String> codes) {
        return new RoleDtos.RoleView(
                role.getId(), role.getCode(), role.getName(), role.getDescription(),
                role.getBuiltin() != null && role.getBuiltin() == 1,
                codes, role.getCreatedAt());
    }
}
