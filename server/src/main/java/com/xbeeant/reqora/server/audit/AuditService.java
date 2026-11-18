package com.xbeeant.reqora.server.audit;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.xbeeant.reqora.server.common.Access;
import com.xbeeant.reqora.server.common.AuthUser;
import com.xbeeant.reqora.server.common.PageResult;
import com.xbeeant.reqora.server.common.Permissions;
import com.xbeeant.reqora.server.common.RequestIdFilter;
import com.xbeeant.reqora.server.config.AuditProperties;
import java.time.LocalDateTime;
import java.time.temporal.ChronoUnit;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;

/**
 * Append-only audit trail. Never stores passwords, tokens or full workspace
 * payloads. When hash chaining is enabled each row carries prev_hash / entry_hash
 * so an export can be verified offline; the chain is best effort on a single
 * node (a rolled-back business transaction leaves a visible gap).
 */
@Service
public class AuditService {

    private static final Logger log = LoggerFactory.getLogger(AuditService.class);
    private static final String ZERO_HASH = "0".repeat(64);
    private final Object chainLock = new Object();

    private final AuditLogMapper auditLogMapper;
    private final JdbcTemplate jdbc;
    private final AuditProperties properties;
    private volatile String lastHash;

    public AuditService(AuditLogMapper auditLogMapper, JdbcTemplate jdbc, AuditProperties properties) {
        this.auditLogMapper = auditLogMapper;
        this.jdbc = jdbc;
        this.properties = properties;
    }

    public void record(String action, String targetType, Object targetId, String detail) {
        record(action, targetType, targetId, detail, "local");
    }

    /** Provider-tagged variant used by SSO / SCIM / PAT / retention events. */
    public void record(String action, String targetType, Object targetId, String detail,
                       String provider) {
        try {
            AuditLogEntity entry = new AuditLogEntity();
            Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
            if (authentication != null && authentication.getPrincipal() instanceof AuthUser user) {
                entry.setActorId(user.id());
                entry.setActorName(user.username());
            } else {
                entry.setActorId(0L);
                entry.setActorName("anonymous");
            }
            entry.setAction(action);
            entry.setTargetType(targetType == null ? "" : targetType);
            entry.setTargetId(targetId == null ? "" : String.valueOf(targetId));
            entry.setDetail(detail == null ? "" : truncate(detail, 1000));
            entry.setRequestId(Optional.ofNullable(MDC.get(RequestIdFilter.MDC_KEY)).orElse(""));
            entry.setIp(Optional.ofNullable(MDC.get(RequestIdFilter.IP_KEY)).orElse(""));
            entry.setProvider(provider == null || provider.isBlank() ? "local" : provider);
            entry.setActorType(action.startsWith("audit.retention") ? "system" : "user");
            entry.setLegalHold(0);
            // MySQL DATETIME(3) truncates nanos; normalise before hashing so an
            // exported row recomputes to exactly the same canonical string.
            LocalDateTime now = LocalDateTime.now().truncatedTo(ChronoUnit.MILLIS);
            entry.setCreatedAt(now);
            if (properties.isHashChain()) {
                chain(entry, now);
            }
            auditLogMapper.insert(entry);
        } catch (Exception ex) {
            // Audit must never break the business transaction, but must be visible.
            log.warn("audit write failed: action={}", action, ex);
        }
    }

    /** Computes and persists the chain watermark; degrades to null hashes on failure. */
    private void chain(AuditLogEntity entry, LocalDateTime now) {
        synchronized (chainLock) {
            try {
                String previous = lastHash;
                if (previous == null) {
                    previous = jdbc.queryForObject(
                            "SELECT last_hash FROM sys_audit_chain WHERE id = 1", String.class);
                }
                if (previous == null) {
                    previous = ZERO_HASH;
                }
                String canonical = String.join("|",
                        previous,
                        nullToEmpty(entry.getAction()),
                        String.valueOf(entry.getActorId()),
                        nullToEmpty(entry.getActorName()),
                        nullToEmpty(entry.getTargetType()),
                        nullToEmpty(entry.getTargetId()),
                        nullToEmpty(entry.getDetail()),
                        nullToEmpty(entry.getRequestId()),
                        nullToEmpty(entry.getIp()),
                        now.toString(),
                        nullToEmpty(entry.getProvider()));
                String hash = com.xbeeant.reqora.server.identity.IdentityCrypto.sha256Hex(canonical);
                entry.setPrevHash(previous);
                entry.setEntryHash(hash);
                jdbc.update("UPDATE sys_audit_chain SET last_hash = ?, "
                        + "updated_at = CURRENT_TIMESTAMP(3) WHERE id = 1", hash);
                lastHash = hash;
            } catch (Exception ex) {
                log.warn("audit hash chain unavailable, writing unchained row", ex);
                entry.setPrevHash(null);
                entry.setEntryHash(null);
            }
        }
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }

    public PageResult<AuditLogEntity> list(long page, long size) {
        return list(page, size, null, null);
    }

    /** Filterable audit trail for the admin console. */
    public PageResult<AuditLogEntity> list(long page, long size, String keyword, String action) {
        Access.requireSystem(Permissions.AUDIT_READ);
        var wrapper = new com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper<AuditLogEntity>();
        if (action != null && !action.isBlank()) {
            wrapper.eq(AuditLogEntity::getAction, action.trim());
        }
        if (keyword != null && !keyword.isBlank()) {
            String like = "%" + keyword.trim() + "%";
            wrapper.and(q -> q.like(AuditLogEntity::getActorName, like)
                    .or().like(AuditLogEntity::getAction, like)
                    .or().like(AuditLogEntity::getTargetId, like)
                    .or().like(AuditLogEntity::getDetail, like));
        }
        wrapper.orderByDesc(AuditLogEntity::getId);
        IPage<AuditLogEntity> result = auditLogMapper.selectPage(Page.of(page, size), wrapper);
        return new PageResult<>(result.getRecords(), result.getTotal(), result.getCurrent(), result.getSize());
    }

    public java.util.List<String> actions() {
        Access.requireSystem(Permissions.AUDIT_READ);
        return auditLogMapper.selectDistinctActions();
    }

    public AuditLogMapper mapper() {
        return auditLogMapper;
    }

    public AuditProperties properties() {
        return properties;
    }

    private String truncate(String value, int max) {
        return value.length() <= max ? value : value.substring(0, max);
    }
}
