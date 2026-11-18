package com.xbeeant.reqora.server.workspace;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xbeeant.reqora.server.audit.AuditService;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.CurrentUser;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.common.JsonSupport;
import com.xbeeant.reqora.server.config.AppProperties;
import com.xbeeant.reqora.server.project.ProjectAccess;
import com.xbeeant.reqora.server.project.ProjectCapability;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Row-level workspace sync (统一行模型).
 *
 * <p>Collaboration state is stored as structured rows:
 * 项目 → 文件夹(集合) → 接口 as first-class rows (see db/migration/V1__init.sql),
 * with environments / cases / scenarios / suites / shared artifacts as rows of
 * their own kind. The desktop SQLite store (storage.rs) mirrors this schema.</p>
 *
 * <p>Merge semantics: each row carries the client's {@code updatedAt} (epoch
 * millis) plus a {@code deleted} tombstone; the server keeps whichever row is
 * newer, per row. There is deliberately no 409 whole-snapshot conflict anymore
 * — {@code version} only drives SSE / polling notifications. Local-only data
 * (history, trash, db connections, MCP servers, credentials) never reaches
 * these tables; the client strips it before upload (lib/cloudSync.ts).</p>
 */
@Service
public class WorkspaceService {

    private static final Logger log = LoggerFactory.getLogger(WorkspaceService.class);

    private static final String KIND_FOLDER = "folder";
    private static final String KIND_REQUEST = "request";
    private static final String KIND_ENVIRONMENT = "environment";
    private static final String KIND_CASE = "case";
    private static final String KIND_SCENARIO = "scenario";
    private static final String KIND_SUITE = "suite";
    private static final String KIND_ARTIFACT = "artifact";

    private static final int MAX_ROWS_PER_SYNC = 10_000;
    private static final int MAX_ID_LENGTH = 64;
    private static final int MAX_NAME_LENGTH = 255;
    private static final int MAX_FOLDER_PATH_LENGTH = 512;
    private static final int MAX_METHOD_LENGTH = 10;
    private static final int MAX_PROTOCOL_LENGTH = 10;
    private static final int MAX_CASE_GROUP_LENGTH = 16;
    private static final int MAX_SUB_KIND_LENGTH = 32;

    private final WorkspaceRowMapper rowMapper;
    private final WorkspaceMetaMapper metaMapper;
    private final WorkspaceObjectMapper objectMapper;
    private final ProjectAccess projectAccess;
    private final AppProperties properties;
    private final AuditService auditService;

    public WorkspaceService(
            WorkspaceRowMapper rowMapper,
            WorkspaceMetaMapper metaMapper,
            WorkspaceObjectMapper objectMapper,
            ProjectAccess projectAccess,
            AppProperties properties,
            AuditService auditService) {
        this.rowMapper = rowMapper;
        this.metaMapper = metaMapper;
        this.objectMapper = objectMapper;
        this.projectAccess = projectAccess;
        this.properties = properties;
        this.auditService = auditService;
    }

    /** Download: the full merged row set for a project (including tombstones). */
    public WorkspaceRowDtos.RowsResponse rows(long projectId) {
        projectAccess.require(projectId, ProjectCapability.WORKSPACE_READ);
        return readRows(projectId, null, true);
    }

    /**
     * Incremental download ({@code GET /rows?since=<cursor>}): only rows whose
     * server-assigned {@code rowVersion} exceeds the client's cursor. A later
     * write always re-stamps rowVersion, so anything the client already has is
     * unchanged server-side by definition. Old clients never pass {@code since}
     * and get the full set; servers older than V2 ignore the parameter and
     * also return the full set — both stay correct.
     *
     * <p>墓碑 compaction 后，被清除的墓碑无法再出现在增量里：cursor 落后于
     * 回收水位（compacted_version）的客户端无法保证「cursor 之后的变更都
     * 已送达」，退化为全量拉取（full=true），由客户端整体替换本地视图，
     * 补齐错过的删除。</p>
     */
    public WorkspaceRowDtos.RowsResponse rowsSince(long projectId, long since) {
        projectAccess.require(projectId, ProjectCapability.WORKSPACE_READ);
        WorkspaceMetaEntity meta = metaByProject(projectId);
        long watermark = meta == null || meta.getCompactedVersion() == null
                ? 0L : meta.getCompactedVersion();
        if (since < watermark) {
            return readRows(projectId, null, true);
        }
        return readRows(projectId, since, false);
    }

    public WorkspaceRowDtos.WorkspaceHead head(long projectId) {
        projectAccess.require(projectId, ProjectCapability.WORKSPACE_READ);
        WorkspaceMetaEntity meta = metaByProject(projectId);
        return new WorkspaceRowDtos.WorkspaceHead(
                projectId,
                meta == null ? 0L : meta.getVersion(),
                meta == null ? null : String.valueOf(meta.getUpdatedAt()));
    }

    /**
     * Upload + merge: clients send their locally-winner rows; the server
     * merges per row (last-writer-wins by updatedAt) and returns the full
     * merged row set so every replica converges.
     */
    @Transactional
    public WorkspaceRowDtos.RowsResponse sync(long projectId, WorkspaceRowDtos.SyncRequest request) {
        applyRows(projectId, request);
        return readRows(projectId, null, true);
    }

    /**
     * Chunked mode ({@code POST /rows?ackOnly=true}): same merge semantics as
     * {@link #sync}, but the response is a per-chunk confirmation instead of
     * the full row set — a chunked upload must not pay one full download per
     * chunk. The client pulls GET /rows once after the last chunk.
     */
    @Transactional
    public WorkspaceRowDtos.AckResponse syncAck(long projectId, WorkspaceRowDtos.SyncRequest request) {
        AppliedRows applied = applyRows(projectId, request);
        return new WorkspaceRowDtos.AckResponse(projectId, applied.version(), applied.accepted());
    }

    /** Internal sync result shared by the full and ackOnly response shapes. */
    private record AppliedRows(
            long version,
            List<WorkspaceRowDtos.AcceptedRow> accepted,
            int rowCount,
            long totalBytes) {
    }

    /** Merge core: validate, per-row last-writer-wins upsert, version bump, audit. */
    private AppliedRows applyRows(long projectId, WorkspaceRowDtos.SyncRequest request) {
        projectAccess.require(projectId, ProjectCapability.WORKSPACE_WRITE);
        if (request == null) {
            throw new BizException(ErrorCode.BAD_REQUEST, "同步请求不能为空");
        }
        long actorId = CurrentUser.requireId();

        List<WorkspaceRowEntity> incoming = new ArrayList<>();
        int rowCount = 0;
        long totalBytes = 0;
        rowCount += collect(request.folders(), row -> toFolder(projectId, row), incoming);
        rowCount += collect(request.requests(), row -> toRequest(projectId, row), incoming);
        rowCount += collect(request.environments(), row -> toEnvironment(projectId, row), incoming);
        rowCount += collect(request.cases(), row -> toCase(projectId, row), incoming);
        rowCount += collect(request.scenarios(), row -> toScenario(projectId, row), incoming);
        rowCount += collect(request.suites(), row -> toSuite(projectId, row), incoming);
        rowCount += collect(request.artifacts(), row -> toArtifact(projectId, row), incoming);
        if (rowCount > MAX_ROWS_PER_SYNC) {
            throw new BizException(ErrorCode.PAYLOAD_TOO_LARGE,
                    "一次同步最多 " + MAX_ROWS_PER_SYNC + " 行，收到 " + rowCount + " 行");
        }
        for (WorkspaceRowEntity row : incoming) {
            totalBytes += row.getData() == null ? 0 : row.getData().getBytes(StandardCharsets.UTF_8).length;
        }
        if (totalBytes > properties.getWorkspace().getMaxBytes()) {
            throw new BizException(ErrorCode.PAYLOAD_TOO_LARGE,
                    "行数据 " + totalBytes + " 字节，超过上限 " + properties.getWorkspace().getMaxBytes());
        }

        WorkspaceMetaEntity meta = lockOrCreateMeta(projectId, actorId);
        // rowVersion = the meta.version of the sync that applied the row; it
        // feeds the incremental-download cursor. Rows the merge skips (stored
        // is newer) keep their original stamp and stay invisible to deltas.
        long newVersion = meta.getVersion() + 1;
        for (WorkspaceRowEntity row : incoming) {
            row.setRowVersion(newVersion);
        }
        // Accepted = every row this request carried, with the merge outcome.
        // applied=false means the server kept its own stored row (stored
        // updatedAt is newer or equal-timestamp); the row is still settled
        // server-side, and its server version reaches the client through the
        // next delta pull (rowVersion > cursor ⇒ row appears again).
        List<WorkspaceRowDtos.AcceptedRow> accepted = new ArrayList<>(incoming.size());
        for (WorkspaceRowEntity row : incoming) {
            boolean applied = upsert(projectId, row, actorId);
            accepted.add(new WorkspaceRowDtos.AcceptedRow(
                    row.getId(), row.getUpdatedAt() == null ? 0L : row.getUpdatedAt(), applied));
        }

        meta.setVersion(newVersion);
        meta.setUpdatedBy(actorId);
        meta.setUpdatedAt(LocalDateTime.now());
        // 同步卫生（best-effort，失败不阻断同步）：墓碑 compaction 以服务端
        // 接收时间（synced_at）为保留期依据——客户端时钟不可信，且刚上传的
        // 离线删除必须保留到所有活跃端拉过为止。compaction 改变增量语义
        // （被清除的墓碑无法传播），水位记到 meta，落后太多的客户端由
        // rowsSince 退化为全量补齐。
        int compacted = 0;
        try {
            compacted = compactTombstones(projectId);
        } catch (RuntimeException ex) {
            log.warn("workspace tombstone compaction failed for project {}: {}",
                    projectId, ex.getMessage());
        }
        if (compacted > 0) {
            meta.setCompactedVersion(newVersion);
        }
        if (request.meta() != null) {
            meta.setSeeded(Boolean.TRUE.equals(request.meta().seeded()));
            meta.setActiveEnvironmentId(request.meta().activeEnvironmentId());
            meta.setSettings(request.meta().settings() == null
                    ? null : JsonSupport.stringify(request.meta().settings()));
        }
        // Full-row replace (delete + insert) so cleared columns actually clear;
        // MyBatis-Plus updateById skips null fields.
        metaMapper.deleteById(projectId);
        try {
            metaMapper.insert(meta);
        } catch (DuplicateKeyException ex) {
            throw new BizException(ErrorCode.VERSION_CONFLICT, "并发同步冲突，请重试");
        }

        auditService.record("workspace.sync", "project", projectId,
                "v" + meta.getVersion() + " · " + incoming.size() + " rows · " + totalBytes + " bytes"
                        + (compacted > 0 ? " · compacted " + compacted + " tombstones" : ""));
        // blob 孤儿对象回收放在 meta 落库之后：引用扫描看的是已合并的行集。
        try {
            gcUnreferencedObjects(projectId);
        } catch (RuntimeException ex) {
            log.warn("workspace object GC failed for project {}: {}", projectId, ex.getMessage());
        }
        return new AppliedRows(meta.getVersion(), accepted, rowCount, totalBytes);
    }

    // --------------------------------------------- content-addressed objects ----

    /**
     * Store an oversized row payload by sha256. Content-addressed: identical
     * bytes are written once per project and repeated uploads are idempotent.
     * The wire row keeps only {@code { "__blob": hash, "size", "encoding" }},
     * so a single row can exceed any request-size budget.
     */
    public WorkspaceRowDtos.ObjectPutResponse putObject(
            long projectId, byte[] content, String expectedHash, long actorId) {
        projectAccess.require(projectId, ProjectCapability.WORKSPACE_WRITE);
        if (content == null || content.length == 0) {
            throw new BizException(ErrorCode.BAD_REQUEST, "对象内容不能为空");
        }
        if (content.length > properties.getWorkspace().getMaxObjectBytes()) {
            throw new BizException(ErrorCode.PAYLOAD_TOO_LARGE,
                    "对象 " + content.length + " 字节，超过上限 "
                            + properties.getWorkspace().getMaxObjectBytes());
        }
        String hash = sha256Hex(content);
        if (expectedHash != null && !expectedHash.isBlank() && !expectedHash.equalsIgnoreCase(hash)) {
            throw new BizException(ErrorCode.BAD_REQUEST,
                    "hash 与对象内容不一致（客户端声称 " + expectedHash + "，实际 " + hash + "）");
        }
        WorkspaceObjectEntity entity = new WorkspaceObjectEntity();
        entity.setProjectId(projectId);
        entity.setHash(hash);
        entity.setSize((long) content.length);
        entity.setContent(content);
        entity.setUploadedBy(actorId);
        // GC 依赖 createdAt 判断宽限期；列无 DB 默认值，必须显式赋值。
        entity.setCreatedAt(LocalDateTime.now());
        try {
            objectMapper.insert(entity);
        } catch (DuplicateKeyException ex) {
            // (project_id, hash) 冲突 = 同内容已存在：幂等空操作。
        }
        return new WorkspaceRowDtos.ObjectPutResponse(hash, content.length);
    }

    /** Fetch a stored object; a missing hash is a hard error — the row cannot be hydrated. */
    public byte[] getObject(long projectId, String hash) {
        projectAccess.require(projectId, ProjectCapability.WORKSPACE_READ);
        if (hash == null || !hash.matches("[0-9a-fA-F]{64}")) {
            throw new BizException(ErrorCode.BAD_REQUEST, "对象 hash 不合法");
        }
        WorkspaceObjectEntity entity = objectMapper.selectOne(
                new LambdaQueryWrapper<WorkspaceObjectEntity>()
                        .eq(WorkspaceObjectEntity::getProjectId, projectId)
                        .eq(WorkspaceObjectEntity::getHash, hash.toLowerCase()));
        if (entity == null) {
            throw new BizException(ErrorCode.NOT_FOUND,
                    "云端对象不存在（可能已被清理），请重新同步该行");
        }
        return entity.getContent();
    }

    private static String sha256Hex(byte[] content) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(content);
            StringBuilder hex = new StringBuilder(hash.length * 2);
            for (byte b : hash) {
                hex.append(Character.forDigit((b >> 4) & 0xF, 16))
                        .append(Character.forDigit(b & 0xF, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 不可用", ex);
        }
    }

    // ------------------------------------------------------------- helpers ----

    private interface RowMapper<T> {
        WorkspaceRowEntity map(T row);
    }

    private <T> int collect(List<T> rows, RowMapper<T> mapper, List<WorkspaceRowEntity> out) {
        if (rows == null) {
            return 0;
        }
        for (T row : rows) {
            out.add(mapper.map(row));
        }
        return rows.size();
    }

    private WorkspaceMetaEntity lockOrCreateMeta(long projectId, long actorId) {
        WorkspaceMetaEntity meta = metaMapper.lockForProject(projectId);
        if (meta != null) {
            return meta;
        }
        WorkspaceMetaEntity fresh = new WorkspaceMetaEntity();
        fresh.setProjectId(projectId);
        fresh.setVersion(0L);
        fresh.setSeeded(false);
        fresh.setUpdatedBy(actorId);
        fresh.setCreatedAt(LocalDateTime.now());
        fresh.setUpdatedAt(LocalDateTime.now());
        try {
            metaMapper.insert(fresh);
        } catch (DuplicateKeyException ex) {
            // A concurrent first sync created it; re-read under lock.
            fresh = metaMapper.lockForProject(projectId);
            if (fresh == null) {
                throw new BizException(ErrorCode.VERSION_CONFLICT, "并发同步冲突，请重试");
            }
        }
        return fresh;
    }

    /**
     * Per-row last-writer-wins. Returns whether the incoming row was actually
     * applied (inserted or replaced the stored row); false = stored row was
     * newer, equal without a deletion marker, or already deleted.
     */
    private boolean upsert(long projectId, WorkspaceRowEntity incoming, long actorId) {
        validateRow(incoming);
        WorkspaceRowEntity existing = rowMapper.selectById(incoming.getId());
        if (existing != null && !existing.getProjectId().equals(projectId)) {
            throw new BizException(ErrorCode.BAD_REQUEST,
                    "行 id 冲突：该 id 已属于其它协作空间（" + incoming.getId() + "）");
        }
        if (existing != null) {
            boolean storedDeleted = Boolean.TRUE.equals(existing.getTombstone());
            boolean incomingDeleted = Boolean.TRUE.equals(incoming.getTombstone());
            Long storedAt = existing.getUpdatedAt();
            Long incomingAt = incoming.getUpdatedAt();
            // 平局（相等时间戳）且双方都是活行时才需要内容比较：内容相同 =
            // 幂等重传（跳过，保持 rowVersion 稳定，不重复出现在增量里）。
            boolean tieSameContent = storedAt != null && incomingAt != null
                    && storedAt.longValue() == incomingAt.longValue()
                    && !storedDeleted && !incomingDeleted
                    && sameRowContent(existing, incoming);
            if (!shouldReplaceRow(storedAt, storedDeleted,
                    incomingAt == null ? 0L : incomingAt, incomingDeleted, tieSameContent)) {
                return false; // stored row wins under the merge rules
            }
        }
        incoming.setProjectId(projectId);
        incoming.setSyncedBy(actorId);
        incoming.setSyncedAt(LocalDateTime.now());
        if (existing == null) {
            incoming.setCreatedAt(LocalDateTime.now());
            rowMapper.insert(incoming);
        } else {
            incoming.setCreatedAt(existing.getCreatedAt());
            rowMapper.deleteById(incoming.getId());
            rowMapper.insert(incoming);
        }
        return true;
    }

    /** Pure merge decision, static for unit testing: incoming row wins unless stored is newer. */
    static boolean serverRowWins(Long storedUpdatedAt, long incomingUpdatedAt) {
        return storedUpdatedAt == null || incomingUpdatedAt > storedUpdatedAt;
    }

    /**
     * Pure row-replacement decision. The desktop client (src/lib/
     * workspaceRows.ts::mergeRows) yields to the server on equal timestamps,
     * so the server is free to apply receipt-order adjudication here without
     * breaking convergence:
     * <ul>
     *   <li>newer timestamp wins;</li>
     *   <li>equal timestamps: a deletion marker beats a live row, never the
     *       reverse; tombstone vs tombstone keeps the stored one;</li>
     *   <li>live vs live tie: server-receipt-order — the row arriving later is
     *       the latest intent and wins when content actually differs; identical
     *       content is an idempotent re-upload (no-op keeps rowVersion stable,
     *       so the row does not reappear in delta pulls).</li>
     * </ul>
     * A missing stored timestamp always loses. Client clocks remain the
     * primary comparator (needed for idempotent re-uploads and offline edits
     * beating their own baseline), but the tie is now resolved server-side
     * instead of silently keeping a version that merely arrived first.
     */
    static boolean shouldReplaceRow(
            Long storedUpdatedAt,
            boolean storedDeleted,
            long incomingUpdatedAt,
            boolean incomingDeleted,
            boolean tieSameContent) {
        if (storedUpdatedAt == null) {
            return true;
        }
        if (incomingUpdatedAt > storedUpdatedAt) {
            return true;
        }
        if (incomingUpdatedAt < storedUpdatedAt) {
            return false;
        }
        // Equal timestamp: deletion is an explicit action, so a tombstone
        // overrides a live row but never the other way around.
        if (incomingDeleted != storedDeleted) {
            return incomingDeleted;
        }
        if (storedDeleted) {
            return false; // tombstone vs tombstone: keep the stored one
        }
        // Live vs live tie: later arrival wins unless content is identical.
        return !tieSameContent;
    }

    /**
     * Business-column equality between the stored and incoming versions of a
     * row (everything a client can edit; bookkeeping columns like
     * createdAt/syncedAt are excluded by definition).
     */
    static boolean sameRowContent(WorkspaceRowEntity a, WorkspaceRowEntity b) {
        return Objects.equals(a.getKind(), b.getKind())
                && Objects.equals(a.getParentId(), b.getParentId())
                && Objects.equals(a.getFolderPath(), b.getFolderPath())
                && Objects.equals(a.getName(), b.getName())
                && Objects.equals(a.getMethod(), b.getMethod())
                && Objects.equals(a.getUrl(), b.getUrl())
                && Objects.equals(a.getProtocol(), b.getProtocol())
                && Objects.equals(a.getAuth(), b.getAuth())
                && Objects.equals(a.getPosition(), b.getPosition())
                && Objects.equals(a.getEnabled(), b.getEnabled())
                && Objects.equals(a.getCaseGroup(), b.getCaseGroup())
                && Objects.equals(a.getSubKind(), b.getSubKind())
                && Objects.equals(a.getData(), b.getData());
    }

    private void validateRow(WorkspaceRowEntity row) {
        if (row.getId() == null || row.getId().isBlank() || row.getId().length() > MAX_ID_LENGTH) {
            throw new BizException(ErrorCode.BAD_REQUEST, "行 id 缺失或超长");
        }
        // Reject over-long scalar columns here (400) instead of letting MySQL
        // truncate or throw a 500 deep inside the batch insert.
        validateScalarLengths(row);
        // Tombstones are deletion markers, not content: they intentionally carry
        // an empty name so a rename and a delete cannot race into a stale row.
        boolean deleted = Boolean.TRUE.equals(row.getTombstone());
        if (!deleted && (row.getName() == null || row.getName().isBlank())) {
            throw new BizException(ErrorCode.BAD_REQUEST, "行 name 缺失（id=" + row.getId() + "）");
        }
        if (row.getName() != null && row.getName().length() > MAX_NAME_LENGTH) {
            throw new BizException(ErrorCode.BAD_REQUEST, "行 name 超长（id=" + row.getId() + "）");
        }
        if (row.getUpdatedAt() == null || row.getUpdatedAt() < 0) {
            throw new BizException(ErrorCode.BAD_REQUEST, "行 updatedAt 缺失（id=" + row.getId() + "）");
        }
        if (row.getData() == null || row.getData().getBytes(StandardCharsets.UTF_8).length
                > properties.getWorkspace().getMaxBytes()) {
            throw new BizException(ErrorCode.PAYLOAD_TOO_LARGE, "行 data 缺失或超限（id=" + row.getId() + "）");
        }
    }

    /** Pure scalar-column bounds check, static for unit testing. */
    static void validateScalarLengths(WorkspaceRowEntity row) {
        String id = row.getId();
        checkLength(id, MAX_ID_LENGTH, "id", id);
        checkLength(row.getParentId(), MAX_ID_LENGTH, "parentId", id);
        checkLength(row.getFolderPath(), MAX_FOLDER_PATH_LENGTH, "folderPath", id);
        checkLength(row.getMethod(), MAX_METHOD_LENGTH, "method", id);
        checkLength(row.getProtocol(), MAX_PROTOCOL_LENGTH, "protocol", id);
        checkLength(row.getCaseGroup(), MAX_CASE_GROUP_LENGTH, "caseGroup", id);
        checkLength(row.getSubKind(), MAX_SUB_KIND_LENGTH, "subKind", id);
    }

    private static void checkLength(String value, int max, String field, String id) {
        if (value != null && value.length() > max) {
            throw new BizException(ErrorCode.BAD_REQUEST,
                    "行 " + field + " 超长（id=" + id + "，上限 " + max + "）");
        }
    }

    // ------------------------------------------------------ sync hygiene ----

    /**
     * 墓碑 compaction：物理清除保留期之外的软删行。保留期按服务端接收时间
     * （synced_at）计算——客户端时钟不可信；刚上传的离线删除的 synced_at
     * 是现在，不会被立即回收，保证所有活跃端有时间拉到这次删除。返回清除
     * 的行数（&gt;0 时调用方会推进 compaction 水位）。保留期 &lt;=0 时关闭。
     */
    private int compactTombstones(long projectId) {
        long retentionDays = properties.getWorkspace().getTombstoneRetentionDays();
        if (retentionDays <= 0) {
            return 0;
        }
        LocalDateTime cutoff = LocalDateTime.now().minusDays(retentionDays);
        return rowMapper.delete(new LambdaQueryWrapper<WorkspaceRowEntity>()
                .eq(WorkspaceRowEntity::getProjectId, projectId)
                .eq(WorkspaceRowEntity::getTombstone, true)
                .isNotNull(WorkspaceRowEntity::getSyncedAt)
                .lt(WorkspaceRowEntity::getSyncedAt, cutoff));
    }

    /** 行 data 中内容寻址引用的 hash 形状：{@code "__blob":"<64位hex>"}。 */
    private static final Pattern BLOB_HASH = Pattern.compile("\"__blob\"\\s*:\\s*\"([0-9a-fA-F]{64})\"");

    /** 从行 data JSON 中提取全部 blob 引用 hash（小写化）。纯函数，便于测试。 */
    static Set<String> extractBlobHashes(String data) {
        if (data == null || data.isBlank()) {
            return Set.of();
        }
        Set<String> hashes = new HashSet<>();
        Matcher matcher = BLOB_HASH.matcher(data);
        while (matcher.find()) {
            hashes.add(matcher.group(1).toLowerCase(Locale.ROOT));
        }
        return hashes;
    }

    /**
     * blob 孤儿对象回收：删除「无任何行引用 且 超过宽限期」的对象。宽限期
     * 保护「对象已 PUT、引用它的行还没送达」的中间态（上传与行同步不在
     * 一个事务里）；createdAt 为 NULL 的历史对象视为不够老，保守跳过。
     * 宽限期 &lt;=0 时关闭。
     */
    private void gcUnreferencedObjects(long projectId) {
        long graceHours = properties.getWorkspace().getObjectGraceHours();
        if (graceHours <= 0) {
            return;
        }
        List<WorkspaceRowEntity> holders = rowMapper.selectList(
                new LambdaQueryWrapper<WorkspaceRowEntity>()
                        .eq(WorkspaceRowEntity::getProjectId, projectId)
                        .like(WorkspaceRowEntity::getData, "__blob")
                        .select(WorkspaceRowEntity::getData));
        Set<String> referenced = new HashSet<>();
        for (WorkspaceRowEntity holder : holders) {
            referenced.addAll(extractBlobHashes(holder.getData()));
        }
        LocalDateTime graceCutoff = LocalDateTime.now().minusHours(graceHours);
        List<WorkspaceObjectEntity> stale = objectMapper.selectList(
                new LambdaQueryWrapper<WorkspaceObjectEntity>()
                        .eq(WorkspaceObjectEntity::getProjectId, projectId)
                        .lt(WorkspaceObjectEntity::getCreatedAt, graceCutoff));
        int removed = 0;
        for (WorkspaceObjectEntity object : stale) {
            if (referenced.contains(object.getHash())) {
                continue;
            }
            objectMapper.delete(new LambdaQueryWrapper<WorkspaceObjectEntity>()
                    .eq(WorkspaceObjectEntity::getProjectId, projectId)
                    .eq(WorkspaceObjectEntity::getHash, object.getHash()));
            removed += 1;
        }
        if (removed > 0) {
            log.info("workspace object GC: project {} 回收 {} 个无引用对象（引用 {} 个）",
                    projectId, removed, referenced.size());
        }
    }

    private WorkspaceRowDtos.RowsResponse readRows(long projectId, Long sinceVersion, boolean full) {
        LambdaQueryWrapper<WorkspaceRowEntity> wrapper = new LambdaQueryWrapper<WorkspaceRowEntity>()
                .eq(WorkspaceRowEntity::getProjectId, projectId);
        if (sinceVersion != null) {
            wrapper.gt(WorkspaceRowEntity::getRowVersion, sinceVersion);
        }
        List<WorkspaceRowEntity> all = rowMapper.selectList(wrapper);
        WorkspaceMetaEntity meta = metaByProject(projectId);

        List<WorkspaceRowDtos.FolderRow> folders = new ArrayList<>();
        List<WorkspaceRowDtos.RequestRow> requests = new ArrayList<>();
        List<WorkspaceRowDtos.EnvironmentRow> environments = new ArrayList<>();
        List<WorkspaceRowDtos.CaseRow> cases = new ArrayList<>();
        List<WorkspaceRowDtos.ScenarioRow> scenarios = new ArrayList<>();
        List<WorkspaceRowDtos.SuiteRow> suites = new ArrayList<>();
        List<WorkspaceRowDtos.ArtifactRow> artifacts = new ArrayList<>();

        for (WorkspaceRowEntity row : all) {
            Map<String, Object> data = row.getData() == null ? Map.of() : JsonSupport.toMap(row.getData());
            Map<String, Object> auth = row.getAuth() == null ? null : JsonSupport.toMap(row.getAuth());
            boolean deleted = Boolean.TRUE.equals(row.getTombstone());
            long updatedAt = row.getUpdatedAt() == null ? 0L : row.getUpdatedAt();
            switch (row.getKind() == null ? "" : row.getKind()) {
                case KIND_FOLDER -> folders.add(new WorkspaceRowDtos.FolderRow(
                        row.getId(), updatedAt, deleted, row.getName(), auth,
                        row.getPosition() == null ? 0 : row.getPosition(), data));
                case KIND_REQUEST -> requests.add(new WorkspaceRowDtos.RequestRow(
                        row.getId(), updatedAt, deleted, row.getParentId(), row.getFolderPath(),
                        row.getName(), row.getMethod(), row.getUrl(), row.getProtocol(),
                        row.getPosition() == null ? 0 : row.getPosition(), data));
                case KIND_ENVIRONMENT -> environments.add(new WorkspaceRowDtos.EnvironmentRow(
                        row.getId(), updatedAt, deleted, row.getName(),
                        row.getPosition() == null ? 0 : row.getPosition(), data));
                case KIND_CASE -> cases.add(new WorkspaceRowDtos.CaseRow(
                        row.getId(), updatedAt, deleted, row.getParentId(), row.getCaseGroup(),
                        row.getName(), !Boolean.FALSE.equals(row.getEnabled()), data));
                case KIND_SCENARIO -> scenarios.add(new WorkspaceRowDtos.ScenarioRow(
                        row.getId(), updatedAt, deleted, row.getName(),
                        row.getPosition() == null ? 0 : row.getPosition(), data));
                case KIND_SUITE -> suites.add(new WorkspaceRowDtos.SuiteRow(
                        row.getId(), updatedAt, deleted, row.getName(),
                        row.getPosition() == null ? 0 : row.getPosition(), data));
                case KIND_ARTIFACT -> artifacts.add(new WorkspaceRowDtos.ArtifactRow(
                        row.getId(), updatedAt, deleted, row.getSubKind(), row.getName(),
                        row.getPosition() == null ? 0 : row.getPosition(), data));
                default -> {
                    // Unknown kinds from a newer client are ignored, not fatal.
                }
            }
        }

        WorkspaceRowDtos.MetaRow metaRow = meta == null
                ? new WorkspaceRowDtos.MetaRow(false, null, null)
                : new WorkspaceRowDtos.MetaRow(
                        Boolean.TRUE.equals(meta.getSeeded()),
                        meta.getActiveEnvironmentId(),
                        meta.getSettings() == null ? null : JsonSupport.toMap(meta.getSettings()));

        long version = meta == null ? 0L : meta.getVersion();
        return new WorkspaceRowDtos.RowsResponse(projectId, version, full, folders, requests,
                environments, cases, scenarios, suites, artifacts, metaRow);
    }

    private WorkspaceMetaEntity metaByProject(long projectId) {
        return metaMapper.selectOne(new LambdaQueryWrapper<WorkspaceMetaEntity>()
                .eq(WorkspaceMetaEntity::getProjectId, projectId).last("LIMIT 1"));
    }

    // ------------------------------------------------- domain → row mapping ----

    private WorkspaceRowEntity base(String id, long updatedAt, boolean tombstone) {
        WorkspaceRowEntity entity = new WorkspaceRowEntity();
        entity.setId(id);
        entity.setUpdatedAt(updatedAt);
        entity.setTombstone(tombstone);
        entity.setFolderPath("");
        entity.setPosition(0);
        entity.setEnabled(true);
        entity.setData("{}");
        return entity;
    }

    private WorkspaceRowEntity toFolder(long projectId, WorkspaceRowDtos.FolderRow row) {
        WorkspaceRowEntity entity = base(row.id(), row.updatedAt(), Boolean.TRUE.equals(row.deleted()));
        entity.setKind(KIND_FOLDER);
        entity.setName(orBlank(row.name()));
        entity.setAuth(row.auth() == null ? null : JsonSupport.stringify(row.auth()));
        entity.setPosition(row.position());
        entity.setData(JsonSupport.stringify(row.data() == null ? Map.of() : row.data()));
        return entity;
    }

    private WorkspaceRowEntity toRequest(long projectId, WorkspaceRowDtos.RequestRow row) {
        WorkspaceRowEntity entity = base(row.id(), row.updatedAt(), Boolean.TRUE.equals(row.deleted()));
        entity.setKind(KIND_REQUEST);
        entity.setParentId(row.folderId());
        entity.setFolderPath(orBlank(row.folderPath()));
        entity.setName(orBlank(row.name()));
        entity.setMethod(orBlank(row.method()));
        entity.setUrl(row.url() == null ? "" : row.url());
        entity.setProtocol(orBlank(row.protocol()));
        entity.setPosition(row.position());
        entity.setData(JsonSupport.stringify(row.data() == null ? Map.of() : row.data()));
        return entity;
    }

    private WorkspaceRowEntity toEnvironment(long projectId, WorkspaceRowDtos.EnvironmentRow row) {
        WorkspaceRowEntity entity = base(row.id(), row.updatedAt(), Boolean.TRUE.equals(row.deleted()));
        entity.setKind(KIND_ENVIRONMENT);
        entity.setName(orBlank(row.name()));
        entity.setPosition(row.position());
        entity.setData(JsonSupport.stringify(row.data() == null ? Map.of() : row.data()));
        return entity;
    }

    private WorkspaceRowEntity toCase(long projectId, WorkspaceRowDtos.CaseRow row) {
        WorkspaceRowEntity entity = base(row.id(), row.updatedAt(), Boolean.TRUE.equals(row.deleted()));
        entity.setKind(KIND_CASE);
        entity.setParentId(row.requestId());
        entity.setCaseGroup(orBlank(row.caseGroup()));
        entity.setName(orBlank(row.name()));
        entity.setEnabled(row.enabled());
        entity.setData(JsonSupport.stringify(row.data() == null ? Map.of() : row.data()));
        return entity;
    }

    private WorkspaceRowEntity toScenario(long projectId, WorkspaceRowDtos.ScenarioRow row) {
        WorkspaceRowEntity entity = base(row.id(), row.updatedAt(), Boolean.TRUE.equals(row.deleted()));
        entity.setKind(KIND_SCENARIO);
        entity.setName(orBlank(row.name()));
        entity.setPosition(row.position());
        entity.setData(JsonSupport.stringify(row.data() == null ? Map.of() : row.data()));
        return entity;
    }

    private WorkspaceRowEntity toSuite(long projectId, WorkspaceRowDtos.SuiteRow row) {
        WorkspaceRowEntity entity = base(row.id(), row.updatedAt(), Boolean.TRUE.equals(row.deleted()));
        entity.setKind(KIND_SUITE);
        entity.setName(orBlank(row.name()));
        entity.setPosition(row.position());
        entity.setData(JsonSupport.stringify(row.data() == null ? Map.of() : row.data()));
        return entity;
    }

    private WorkspaceRowEntity toArtifact(long projectId, WorkspaceRowDtos.ArtifactRow row) {
        WorkspaceRowEntity entity = base(row.id(), row.updatedAt(), Boolean.TRUE.equals(row.deleted()));
        entity.setKind(KIND_ARTIFACT);
        entity.setSubKind(orBlank(row.kind()));
        entity.setName(orBlank(row.name()));
        entity.setPosition(row.position());
        entity.setData(JsonSupport.stringify(row.data() == null ? Map.of() : row.data()));
        return entity;
    }

    private String orBlank(String value) {
        return value == null ? "" : value;
    }
}
