package com.xbeeant.reqora.server.identity;

import com.xbeeant.reqora.server.audit.AuditService;
import com.xbeeant.reqora.server.auth.AuthDtos;
import com.xbeeant.reqora.server.auth.AuthService;
import com.xbeeant.reqora.server.auth.PrincipalLoader;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.config.IdentityProperties;
import com.xbeeant.reqora.server.user.UserEntity;
import java.time.LocalDateTime;
import java.util.List;
import org.springframework.stereotype.Service;

/** Personal access tokens for CLI / CI; only the SHA-256 digest is persisted. */
@Service
public class PatService {

    public record Created(long id, String token, String name, LocalDateTime expiresAt) {}
    public record View(long id, String name, String scopes, LocalDateTime expiresAt,
                       LocalDateTime lastUsedAt, LocalDateTime revokedAt, LocalDateTime createdAt) {}

    private final IdentityProperties properties;
    private final IdentityStore store;
    private final AuthService authService;
    private final PrincipalLoader principalLoader;
    private final AuditService auditService;

    public PatService(IdentityProperties properties, IdentityStore store, AuthService authService,
                      PrincipalLoader principalLoader, AuditService auditService) {
        this.properties = properties;
        this.store = store;
        this.authService = authService;
        this.principalLoader = principalLoader;
        this.auditService = auditService;
    }

    private void ensureEnabled() {
        if (!properties.isEnabled() || !properties.getPat().isEnabled()) {
            throw new BizException(ErrorCode.NOT_FOUND, "个人访问令牌未启用");
        }
    }

    public Created create(long userId, String name, long ttlDays) {
        ensureEnabled();
        long ttl = ttlDays <= 0 ? properties.getPat().getMaxTtlDays()
                : Math.min(ttlDays, properties.getPat().getMaxTtlDays());
        if (store.activePatCount(userId) >= properties.getPat().getMaxPerUser()) {
            throw new BizException(ErrorCode.CONFLICT, "活跃令牌数量已达上限");
        }
        String token = "rq_pat_" + IdentityCrypto.randomToken(32);
        LocalDateTime expiresAt = LocalDateTime.now().plusDays(ttl);
        long id = store.createPat(userId, name, IdentityCrypto.sha256Hex(token), "", expiresAt);
        auditService.record("auth.pat.create", "token", id,
                "签发 PAT name=" + name + " ttlDays=" + ttl, "pat");
        return new Created(id, token, name, expiresAt);
    }

    public List<View> list(long userId) {
        ensureEnabled();
        return store.listPats(userId).stream()
                .map(row -> new View(row.id(), row.name(), row.scopes(), row.expiresAt(),
                        row.lastUsedAt(), row.revokedAt(), row.createdAt()))
                .toList();
    }

    public void revoke(long userId, long id) {
        ensureEnabled();
        if (!store.revokePat(userId, id)) {
            throw new BizException(ErrorCode.NOT_FOUND, "令牌不存在或已撤销");
        }
        auditService.record("auth.pat.revoke", "token", id, "撤销 PAT", "pat");
    }

    public AuthDtos.TokenResponse exchange(String token) {
        ensureEnabled();
        Long userId = store.consumePat(IdentityCrypto.sha256Hex(token));
        if (userId == null) {
            throw new BizException(ErrorCode.TOKEN_INVALID, "PAT 无效、已撤销或已过期");
        }
        UserEntity user = principalLoader.requireEnabled(userId);
        auditService.record("auth.pat.exchange", "user", userId, "PAT 换取访问令牌", "pat");
        return authService.issueFor(user);
    }
}
