package com.xbeeant.reqora.server.audit;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xbeeant.reqora.server.common.Access;
import com.xbeeant.reqora.server.common.Permissions;
import com.xbeeant.reqora.server.config.AuditProperties;
import com.xbeeant.reqora.server.identity.IdentityCrypto;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

/**
 * Audit retention: archive-then-purge, legal hold, chain verification and
 * CSV/JSONL export. Deleting an audit row is the only destructive operation in
 * this codebase and it is guarded by three independent conditions: global legal
 * hold, per-row legal_hold, and a successful archive write.
 */
@Service
public class AuditRetentionService {

    private static final Logger log = LoggerFactory.getLogger(AuditRetentionService.class);
    private static final DateTimeFormatter FILE_TIME = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss");

    public record PurgeResult(boolean executed, String reason, int batches, long archivedRows,
                              long deletedRows, List<String> archives) {}

    public record ChainReport(long checked, long legacyRows, boolean intact, Long firstBreakId) {}

    private final AuditService auditService;
    private final AuditProperties properties;
    private final JdbcTemplate jdbc;

    public AuditRetentionService(AuditService auditService, AuditProperties properties,
                                 JdbcTemplate jdbc) {
        this.auditService = auditService;
        this.properties = properties;
        this.jdbc = jdbc;
    }

    public Map<String, Object> policy() {
        Access.requireSystem(Permissions.AUDIT_READ);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("retentionDays", properties.getRetentionDays());
        out.put("purgeEnabled", properties.getRetentionDays() > 0 && !properties.isLegalHold());
        out.put("archiveEnabled", properties.isArchiveEnabled());
        out.put("archiveDir", properties.getArchiveDir());
        out.put("purgeBatchSize", properties.getPurgeBatchSize());
        out.put("maxBatchesPerRun", properties.getMaxBatchesPerRun());
        out.put("legalHold", properties.isLegalHold());
        out.put("hashChain", properties.isHashChain());
        out.put("purgeCron", properties.getPurgeCron());
        out.put("exportMaxRows", properties.getExportMaxRows());
        out.put("chainBoundary", "清理后链首的 prev_hash 指向已归档行，核验从最旧留存行开始");
        Integer archives = jdbc.queryForObject(
                "SELECT COUNT(*) FROM sys_audit_archive", Integer.class);
        Long archivedRows = jdbc.queryForObject(
                "SELECT COALESCE(SUM(row_count), 0) FROM sys_audit_archive", Long.class);
        out.put("archiveCount", archives == null ? 0 : archives);
        out.put("archivedRows", archivedRows == null ? 0L : archivedRows);
        return out;
    }

    @Scheduled(cron = "${reqora.audit.purge-cron:0 15 3 * * *}")
    public void scheduledPurge() {
        try {
            PurgeResult result = runPurge();
            if (result.executed()) {
                log.info("audit retention: deleted {} rows in {} batches, {} archive files",
                        result.deletedRows(), result.batches(), result.archives().size());
            }
        } catch (Exception ex) {
            log.warn("audit retention task failed", ex);
        }
    }

    /** Manual trigger from the admin console; same guards as the scheduled run. */
    public PurgeResult runPurge() {
        if (properties.isLegalHold()) {
            auditService.record("audit.retention.skipped", "policy", "legal_hold",
                    "法务保全开启，跳过清理", "local");
            return new PurgeResult(false, "legal hold 开启，禁止任何清理", 0, 0, 0, List.of());
        }
        if (properties.getRetentionDays() <= 0) {
            return new PurgeResult(false, "retentionDays=0，仅归档不清理", 0, 0, 0, List.of());
        }
        LocalDateTime cutoff = LocalDateTime.now().minusDays(properties.getRetentionDays());
        int batches = 0;
        long archived = 0;
        long deleted = 0;
        List<String> files = new ArrayList<>();
        while (batches < properties.getMaxBatchesPerRun()) {
            List<AuditLogEntity> rows = auditService.mapper().selectList(
                    new LambdaQueryWrapper<AuditLogEntity>()
                            .lt(AuditLogEntity::getCreatedAt, cutoff)
                            .eq(AuditLogEntity::getLegalHold, 0)
                            .orderByAsc(AuditLogEntity::getId)
                            .last("LIMIT " + Math.max(1, properties.getPurgeBatchSize())));
            if (rows.isEmpty()) {
                break;
            }
            if (properties.isArchiveEnabled()) {
                String file = archive(rows);
                files.add(file);
                archived += rows.size();
            } else {
                // Explicitly record that a purge happened without an archive:
                // this is a compliance-relevant choice, never a silent default.
                jdbc.update("INSERT INTO sys_audit_archive "
                                + "(period_from, period_to, row_count, file_path, sha256) "
                                + "VALUES (?, ?, ?, ?, ?)",
                        rows.get(0).getCreatedAt(), rows.get(rows.size() - 1).getCreatedAt(),
                        rows.size(), "(archive disabled)", "0".repeat(64));
            }
            List<Long> ids = rows.stream().map(AuditLogEntity::getId).toList();
            int removed = auditService.mapper().deleteBatchIds(ids);
            if (removed != rows.size()) {
                throw new IllegalStateException("审计清理批次删除数量不一致，已停止后续批次");
            }
            deleted += removed;
            batches++;
        }
        auditService.record("audit.retention.purge", "policy",
                "cutoff=" + cutoff,
                "归档 " + archived + " 行、删除 " + deleted + " 行、共 " + batches + " 批", "local");
        return new PurgeResult(true, "ok", batches, archived, deleted, files);
    }

    /** Writes one JSON object per line and records the file hash before any DELETE. */
    private String archive(List<AuditLogEntity> rows) {
        try {
            Path directory = Path.of(properties.getArchiveDir()).toAbsolutePath().normalize();
            Files.createDirectories(directory);
            String stamp = LocalDateTime.now().format(FILE_TIME) + "-"
                    + IdentityCrypto.randomToken(4).replaceAll("[^A-Za-z0-9]", "");
            Path file = directory.resolve("reqora-audit-" + stamp + ".jsonl");
            StringBuilder content = new StringBuilder();
            for (AuditLogEntity row : rows) {
                Map<String, Object> json = new LinkedHashMap<>();
                json.put("id", row.getId());
                json.put("action", row.getAction());
                json.put("actorId", row.getActorId());
                json.put("actorName", row.getActorName());
                json.put("actorType", row.getActorType());
                json.put("provider", row.getProvider());
                json.put("targetType", row.getTargetType());
                json.put("targetId", row.getTargetId());
                json.put("detail", row.getDetail());
                json.put("requestId", row.getRequestId());
                json.put("ip", row.getIp());
                json.put("prevHash", row.getPrevHash());
                json.put("entryHash", row.getEntryHash());
                json.put("legalHold", row.getLegalHold());
                json.put("createdAt", row.getCreatedAt() == null ? null : row.getCreatedAt().toString());
                content.append(IdentityCrypto.JSON.writeValueAsString(json)).append('\n');
            }
            Files.writeString(file, content.toString(), StandardCharsets.UTF_8);
            String hash = IdentityCrypto.sha256Hex(Files.readAllBytes(file));
            jdbc.update("INSERT INTO sys_audit_archive "
                            + "(period_from, period_to, row_count, file_path, sha256) VALUES (?, ?, ?, ?, ?)",
                    rows.get(0).getCreatedAt(), rows.get(rows.size() - 1).getCreatedAt(),
                    rows.size(), file.toString(), hash);
            return file.toString();
        } catch (IOException ex) {
            throw new IllegalStateException("审计归档写盘失败，已阻止清理", ex);
        }
    }

    // --------------------------------------------------------------------------- export ----

    public List<AuditLogEntity> query(LocalDateTime from, LocalDateTime to, String action, long limit) {
        Access.requireSystem(Permissions.AUDIT_READ);
        LambdaQueryWrapper<AuditLogEntity> wrapper = new LambdaQueryWrapper<>();
        if (from != null) {
            wrapper.ge(AuditLogEntity::getCreatedAt, from);
        }
        if (to != null) {
            wrapper.le(AuditLogEntity::getCreatedAt, to);
        }
        if (action != null && !action.isBlank()) {
            wrapper.eq(AuditLogEntity::getAction, action.trim());
        }
        return auditService.mapper().selectList(wrapper
                .orderByAsc(AuditLogEntity::getId)
                .last("LIMIT " + Math.min(Math.max(limit, 1), properties.getExportMaxRows())));
    }

    public String export(String format, List<AuditLogEntity> rows) {
        boolean csv = "csv".equalsIgnoreCase(format);
        StringBuilder out = new StringBuilder();
        if (csv) {
            out.append("id,createdAt,actorId,actorName,actorType,provider,action,targetType,"
                    + "targetId,detail,requestId,ip,prevHash,entryHash,legalHold\n");
        }
        for (AuditLogEntity row : rows) {
            if (csv) {
                out.append(csvCell(row.getId())).append(',')
                        .append(csvCell(row.getCreatedAt())).append(',')
                        .append(csvCell(row.getActorId())).append(',')
                        .append(csvCell(row.getActorName())).append(',')
                        .append(csvCell(row.getActorType())).append(',')
                        .append(csvCell(row.getProvider())).append(',')
                        .append(csvCell(row.getAction())).append(',')
                        .append(csvCell(row.getTargetType())).append(',')
                        .append(csvCell(row.getTargetId())).append(',')
                        .append(csvCell(row.getDetail())).append(',')
                        .append(csvCell(row.getRequestId())).append(',')
                        .append(csvCell(row.getIp())).append(',')
                        .append(csvCell(row.getPrevHash())).append(',')
                        .append(csvCell(row.getEntryHash())).append(',')
                        .append(csvCell(row.getLegalHold())).append('\n');
            } else {
                Map<String, Object> json = new LinkedHashMap<>();
                json.put("id", row.getId());
                json.put("createdAt", row.getCreatedAt() == null ? null : row.getCreatedAt().toString());
                json.put("actorId", row.getActorId());
                json.put("actorName", row.getActorName());
                json.put("actorType", row.getActorType());
                json.put("provider", row.getProvider());
                json.put("action", row.getAction());
                json.put("targetType", row.getTargetType());
                json.put("targetId", row.getTargetId());
                json.put("detail", row.getDetail());
                json.put("requestId", row.getRequestId());
                json.put("ip", row.getIp());
                json.put("prevHash", row.getPrevHash());
                json.put("entryHash", row.getEntryHash());
                json.put("legalHold", row.getLegalHold());
                try {
                    out.append(IdentityCrypto.JSON.writeValueAsString(json)).append('\n');
                } catch (Exception ex) {
                    throw new IllegalStateException("审计导出行序列化失败", ex);
                }
            }
        }
        return out.toString();
    }

    private String csvCell(Object value) {
        String text = value == null ? "" : String.valueOf(value);
        return "\"" + text.replace("\"", "\"\"") + "\"";
    }

    /**
     * Recomputes the SHA-256 chain for the retained rows. Legacy rows (created
     * before V4) have null hashes and are reported, not treated as tampering.
     */
    public ChainReport verifyChain() {
        Access.requireSystem(Permissions.AUDIT_READ);
        List<AuditLogEntity> rows = auditService.mapper().selectList(
                new LambdaQueryWrapper<AuditLogEntity>()
                        .orderByAsc(AuditLogEntity::getId)
                        .last("LIMIT " + properties.getExportMaxRows()));
        long checked = 0;
        long legacy = 0;
        Long firstBreak = null;
        String previous = null;
        for (AuditLogEntity row : rows) {
            if (row.getEntryHash() == null || row.getPrevHash() == null) {
                legacy++;
                continue;
            }
            if (previous != null && !previous.equals(row.getPrevHash()) && firstBreak == null) {
                firstBreak = row.getId();
            }
            String canonical = canonical(row);
            String expected = IdentityCrypto.sha256Hex(canonical);
            if (!expected.equals(row.getEntryHash()) && firstBreak == null) {
                firstBreak = row.getId();
            }
            previous = row.getEntryHash();
            checked++;
        }
        return new ChainReport(checked, legacy, firstBreak == null, firstBreak);
    }

    private static String canonical(AuditLogEntity row) {
        return String.join("|",
                nullToEmpty(row.getPrevHash()), nullToEmpty(row.getAction()),
                String.valueOf(row.getActorId()), nullToEmpty(row.getActorName()),
                nullToEmpty(row.getTargetType()), nullToEmpty(row.getTargetId()),
                nullToEmpty(row.getDetail()), nullToEmpty(row.getRequestId()),
                nullToEmpty(row.getIp()),
                row.getCreatedAt() == null ? "" : row.getCreatedAt().toString(),
                nullToEmpty(row.getProvider()));
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }
}
