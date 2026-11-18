package com.xbeeant.reqora.server.auth;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xbeeant.reqora.server.audit.AuditService;
import com.xbeeant.reqora.server.common.AuthUser;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.common.RequestIdFilter;
import com.xbeeant.reqora.server.role.RoleEntity;
import com.xbeeant.reqora.server.role.RoleMapper;
import com.xbeeant.reqora.server.role.UserRoleEntity;
import com.xbeeant.reqora.server.role.UserRoleMapper;
import com.xbeeant.reqora.server.user.UserEntity;
import com.xbeeant.reqora.server.user.UserMapper;
import com.xbeeant.reqora.server.user.UserView;
import java.time.LocalDateTime;
import org.slf4j.MDC;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuthService {

    private final UserMapper userMapper;
    private final RoleMapper roleMapper;
    private final UserRoleMapper userRoleMapper;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;
    private final RefreshTokenService refreshTokenService;
    private final PrincipalLoader principalLoader;
    private final LoginRateLimiter rateLimiter;
    private final AuditService auditService;

    public AuthService(
            UserMapper userMapper,
            RoleMapper roleMapper,
            UserRoleMapper userRoleMapper,
            PasswordEncoder passwordEncoder,
            JwtService jwtService,
            RefreshTokenService refreshTokenService,
            PrincipalLoader principalLoader,
            LoginRateLimiter rateLimiter,
            AuditService auditService) {
        this.userMapper = userMapper;
        this.roleMapper = roleMapper;
        this.userRoleMapper = userRoleMapper;
        this.passwordEncoder = passwordEncoder;
        this.jwtService = jwtService;
        this.refreshTokenService = refreshTokenService;
        this.principalLoader = principalLoader;
        this.rateLimiter = rateLimiter;
        this.auditService = auditService;
    }

    @Transactional
    public AuthDtos.TokenResponse register(AuthDtos.RegisterRequest request) {
        if (principalLoader.byUsername(request.username()) != null) {
            throw new BizException(ErrorCode.CONFLICT, "用户名已被使用");
        }
        if (userMapper.selectCount(new LambdaQueryWrapper<UserEntity>()
                .eq(UserEntity::getEmail, request.email())) > 0) {
            throw new BizException(ErrorCode.CONFLICT, "邮箱已被使用");
        }
        UserEntity user = new UserEntity();
        user.setUsername(request.username());
        user.setEmail(request.email());
        user.setDisplayName(request.displayName() == null || request.displayName().isBlank()
                ? request.username() : request.displayName().trim());
        user.setPasswordHash(passwordEncoder.encode(request.password()));
        user.setStatus(1);
        userMapper.insert(user);

        RoleEntity defaultRole = roleMapper.selectOne(new LambdaQueryWrapper<RoleEntity>()
                .eq(RoleEntity::getCode, "USER").last("LIMIT 1"));
        if (defaultRole == null) {
            throw new IllegalStateException("内置 USER 角色缺失，请检查 Flyway 迁移");
        }
        UserRoleEntity link = new UserRoleEntity();
        link.setUserId(user.getId());
        link.setRoleId(defaultRole.getId());
        link.setCreatedAt(LocalDateTime.now());
        userRoleMapper.insert(link);

        auditService.record("auth.register", "user", user.getId(), "注册用户 " + user.getUsername());
        return issueFor(user);
    }

    @Transactional
    public AuthDtos.TokenResponse login(AuthDtos.LoginRequest request) {
        rateLimiter.check(request.username() + "@" + clientIp());
        UserEntity user = principalLoader.byUsername(request.username());
        if (user == null || !passwordEncoder.matches(request.password(), user.getPasswordHash())) {
            throw new BizException(ErrorCode.BAD_CREDENTIALS);
        }
        if (user.getStatus() == null || user.getStatus() != 1) {
            throw new BizException(ErrorCode.ACCOUNT_DISABLED);
        }
        auditService.record("auth.login", "user", user.getId(), "登录成功");
        return issueFor(user);
    }

    @Transactional
    public AuthDtos.TokenResponse refresh(AuthDtos.RefreshRequest request) {
        long userId = refreshTokenService.consume(request.refreshToken());
        UserEntity user = principalLoader.requireEnabled(userId);
        return issueFor(user);
    }

    @Transactional
    public void logout(AuthDtos.LogoutRequest request) {
        AuthUser actor = com.xbeeant.reqora.server.common.CurrentUser.require();
        if (request != null && request.refreshToken() != null && !request.refreshToken().isBlank()) {
            refreshTokenService.revoke(request.refreshToken());
        } else {
            refreshTokenService.revokeAll(actor.id());
        }
        auditService.record("auth.logout", "user", actor.id(), "登出");
    }

    public UserView me() {
        return principalLoader.view(com.xbeeant.reqora.server.common.CurrentUser.requireId());
    }

    /** Also used by the external identity layer (SSO / SCIM / PAT) after account resolution. */
    public AuthDtos.TokenResponse issueFor(UserEntity user) {
        AuthUser principal = principalLoader.load(user.getId());
        String accessToken = jwtService.issue(user.getId(), user.getUsername());
        String refreshToken = refreshTokenService.issue(user.getId(), clientIp());
        UserView view = principalLoader.view(user.getId());
        return new AuthDtos.TokenResponse(
                accessToken, refreshToken, "Bearer", jwtService.accessTtlSeconds(), view);
    }

    private String clientIp() {
        String ip = MDC.get(RequestIdFilter.IP_KEY);
        return ip == null ? "" : ip;
    }
}
