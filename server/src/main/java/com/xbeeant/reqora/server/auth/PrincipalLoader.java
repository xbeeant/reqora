package com.xbeeant.reqora.server.auth;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xbeeant.reqora.server.common.AuthUser;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.role.RoleEntity;
import com.xbeeant.reqora.server.role.RoleMapper;
import com.xbeeant.reqora.server.role.PermissionMapper;
import com.xbeeant.reqora.server.user.UserEntity;
import com.xbeeant.reqora.server.user.UserMapper;
import com.xbeeant.reqora.server.user.UserView;
import java.util.HashSet;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;

/** Loads principals from the database on every request, so role/state changes take effect at once. */
@Service
public class PrincipalLoader {

    private final UserMapper userMapper;
    private final RoleMapper roleMapper;
    private final PermissionMapper permissionMapper;

    public PrincipalLoader(UserMapper userMapper, RoleMapper roleMapper, PermissionMapper permissionMapper) {
        this.userMapper = userMapper;
        this.roleMapper = roleMapper;
        this.permissionMapper = permissionMapper;
    }

    public UserEntity byId(long id) {
        return userMapper.selectById(id);
    }

    public UserEntity byUsername(String username) {
        return userMapper.selectOne(new LambdaQueryWrapper<UserEntity>()
                .eq(UserEntity::getUsername, username)
                .last("LIMIT 1"));
    }

    public UserEntity requireEnabled(long id) {
        UserEntity user = byId(id);
        if (user == null) {
            throw new BizException(ErrorCode.UNAUTHENTICATED);
        }
        if (user.getStatus() == null || user.getStatus() != 1) {
            throw new BizException(ErrorCode.ACCOUNT_DISABLED);
        }
        return user;
    }

    public AuthUser load(long id) {
        UserEntity user = requireEnabled(id);
        Set<String> roleCodes = roleCodes(id);
        Set<String> permissions = new HashSet<>(permissionMapper.selectCodesByUserId(id));
        return new AuthUser(
                user.getId(),
                user.getUsername(),
                user.getDisplayName(),
                roleCodes.contains("SUPER_ADMIN"),
                permissions);
    }

    public Set<String> roleCodes(long userId) {
        return roleMapper.selectByUserId(userId).stream()
                .map(RoleEntity::getCode)
                .collect(Collectors.toSet());
    }

    public UserView view(long userId) {
        UserEntity user = requireEnabled(userId);
        AuthUser principal = load(userId);
        return new UserView(
                user.getId(),
                user.getUsername(),
                user.getEmail(),
                user.getDisplayName(),
                user.getStatus(),
                principal.superAdmin(),
                roleCodes(userId),
                principal.permissions(),
                user.getCreatedAt());
    }

    /**
     * Admin-facing view that also works for disabled accounts. `view()` calls
     * `requireEnabled`, which would roll back a disable operation while the
     * service is still building its response.
     */
    public UserView viewAny(long userId) {
        UserEntity user = byId(userId);
        if (user == null) {
            throw BizException.notFound("用户");
        }
        Set<String> roles = roleCodes(userId);
        return new UserView(
                user.getId(),
                user.getUsername(),
                user.getEmail(),
                user.getDisplayName(),
                user.getStatus(),
                roles.contains("SUPER_ADMIN"),
                roles,
                new HashSet<>(permissionMapper.selectCodesByUserId(userId)),
                user.getCreatedAt());
    }
}
