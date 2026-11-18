package com.xbeeant.reqora.server.auth;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.config.AppProperties;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.LocalDateTime;
import java.util.Base64;
import java.util.HexFormat;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Opaque rotating refresh tokens; only their SHA-256 digest is persisted. */
@Service
public class RefreshTokenService {

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Base64.Encoder ENCODER = Base64.getUrlEncoder().withoutPadding();

    private final RefreshTokenMapper mapper;
    private final AppProperties properties;

    public RefreshTokenService(RefreshTokenMapper mapper, AppProperties properties) {
        this.mapper = mapper;
        this.properties = properties;
    }

    @Transactional
    public String issue(long userId, String ip) {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        String raw = ENCODER.encodeToString(bytes);
        RefreshTokenEntity entity = new RefreshTokenEntity();
        entity.setUserId(userId);
        entity.setTokenHash(sha256(raw));
        entity.setExpiresAt(LocalDateTime.now().plus(properties.getSecurity().getRefreshTokenTtl()));
        entity.setCreatedAt(LocalDateTime.now());
        entity.setCreatedIp(ip == null ? "" : ip);
        mapper.insert(entity);
        return raw;
    }

    /** Atomically consumes a refresh token (rotation). Returns the owning user id. */
    @Transactional
    public long consume(String raw) {
        RefreshTokenEntity entity = mapper.selectOne(
                new LambdaQueryWrapper<RefreshTokenEntity>()
                        .eq(RefreshTokenEntity::getTokenHash, sha256(raw))
                        .last("LIMIT 1"));
        if (entity == null
                || entity.getRevokedAt() != null
                || entity.getExpiresAt().isBefore(LocalDateTime.now())) {
            throw new BizException(ErrorCode.TOKEN_INVALID);
        }
        int revoked = mapper.update(null,
                new LambdaUpdateWrapper<RefreshTokenEntity>()
                        .eq(RefreshTokenEntity::getId, entity.getId())
                        .isNull(RefreshTokenEntity::getRevokedAt)
                        .set(RefreshTokenEntity::getRevokedAt, LocalDateTime.now()));
        if (revoked != 1) {
            throw new BizException(ErrorCode.TOKEN_INVALID);
        }
        return entity.getUserId();
    }

    @Transactional
    public void revoke(String raw) {
        mapper.update(null,
                new LambdaUpdateWrapper<RefreshTokenEntity>()
                        .eq(RefreshTokenEntity::getTokenHash, sha256(raw))
                        .isNull(RefreshTokenEntity::getRevokedAt)
                        .set(RefreshTokenEntity::getRevokedAt, LocalDateTime.now()));
    }

    @Transactional
    public void revokeAll(long userId) {
        mapper.update(null,
                new LambdaUpdateWrapper<RefreshTokenEntity>()
                        .eq(RefreshTokenEntity::getUserId, userId)
                        .isNull(RefreshTokenEntity::getRevokedAt)
                        .set(RefreshTokenEntity::getRevokedAt, LocalDateTime.now()));
    }

    private String sha256(String raw) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(raw.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception ex) {
            throw new IllegalStateException("SHA-256 unavailable", ex);
        }
    }
}
