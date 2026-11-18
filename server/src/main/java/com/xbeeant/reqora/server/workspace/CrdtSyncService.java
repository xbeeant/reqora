package com.xbeeant.reqora.server.workspace;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.CurrentUser;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.project.ProjectAccess;
import com.xbeeant.reqora.server.project.ProjectCapability;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

/**
 * Sync protocol v2 server: an append-only, content-addressed change log.
 *
 * <p>This service deliberately does NOT understand Automerge. It never merges,
 * never compares timestamps, never rejects a change as "conflicting" and never
 * compacts history. It only:</p>
 * <ul>
 *   <li>assigns a monotonic {@code seq} (delivery order / incremental cursor),</li>
 *   <li>de-duplicates by {@code (project_id, hash)} (idempotency),</li>
 *   <li>stores one shared genesis + an optional bootstrap snapshot.</li>
 * </ul>
 *
 * <p>Consequently a repeated "sync" click cannot create a conflict, a deletion
 * is just another change that reaches every replica, and concurrent edits are
 * resolved client-side by causal convergence. The old LWW service
 * ({@link WorkspaceService}) stays untouched for older clients.</p>
 */
@Service
public class CrdtSyncService {

    /**
     * Spring Boot 4 auto-configures a Jackson 3 {@code tools.jackson.databind.json.JsonMapper},
     * not a Jackson 2 {@code com.fasterxml.jackson.databind.ObjectMapper}. This app only uses
     * Jackson 2 internally (see WorkspaceEventHub / JsonSupport), so there is no injectable
     * ObjectMapper bean — keep this service self-contained like the rest of the codebase.
     */
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final CrdtSnapshotMapper snapshotMapper;
    private final CrdtChangeMapper changeMapper;
    private final ProjectAccess projectAccess;

    public CrdtSyncService(
            CrdtSnapshotMapper snapshotMapper,
            CrdtChangeMapper changeMapper,
            ProjectAccess projectAccess) {
        this.snapshotMapper = snapshotMapper;
        this.changeMapper = changeMapper;
        this.projectAccess = projectAccess;
    }

    /** Capability probe + shared-genesis bootstrap. genesis=null => first client creates it. */
    public CrdtSyncDtos.BootstrapResponse bootstrap(long projectId) {
        projectAccess.require(projectId, ProjectCapability.WORKSPACE_READ);
        CrdtSnapshotEntity snapshot = snapshotMapper.selectById(projectId);
        return view(projectId, snapshot, maxSeq(projectId));
    }

    /**
     * Idempotent genesis creation: only the first INSERT wins. A racing client
     * catches the unique-key violation and simply reads the winner's genesis,
     * so no replica ever ends up with its own private root change.
     */
    public CrdtSyncDtos.BootstrapResponse createGenesis(long projectId, String genesisBase64) {
        projectAccess.require(projectId, ProjectCapability.WORKSPACE_WRITE);
        byte[] genesis = CrdtChangeCodec.decode(
                genesisBase64, CrdtChangeCodec.MAX_CHANGE_BYTES);
        CrdtSnapshotEntity existing = snapshotMapper.selectById(projectId);
        if (existing == null) {
            CrdtSnapshotEntity fresh = new CrdtSnapshotEntity();
            fresh.setProjectId(projectId);
            fresh.setGenesis(genesis);
            fresh.setHeads("[]");
            fresh.setSnapshotSeq(0L);
            try {
                snapshotMapper.insert(fresh);
            } catch (DuplicateKeyException race) {
                // Another replica won the race; use its genesis below.
            }
            existing = snapshotMapper.selectById(projectId);
        }
        if (existing == null || existing.getGenesis() == null) {
            throw new BizException(ErrorCode.INTERNAL, "CRDT genesis could not be established");
        }
        return view(projectId, existing, maxSeq(projectId));
    }

    /** Incremental download, equivalent to CouchDB _changes?since=. */
    public CrdtSyncDtos.ChangesResponse changes(long projectId, long since, int requestedLimit) {
        projectAccess.require(projectId, ProjectCapability.WORKSPACE_READ);
        long cursor = Math.max(0L, since);
        int limit = CrdtChangeCodec.pageSize(requestedLimit);
        List<CrdtChangeEntity> rows = changeMapper.selectList(
                new LambdaQueryWrapper<CrdtChangeEntity>()
                        .eq(CrdtChangeEntity::getProjectId, projectId)
                        .gt(CrdtChangeEntity::getSeq, cursor)
                        .orderByAsc(CrdtChangeEntity::getSeq)
                        .last("LIMIT " + limit));
        List<CrdtSyncDtos.ChangeRecord> records = new ArrayList<>();
        List<Long> seqs = new ArrayList<>();
        for (CrdtChangeEntity row : rows) {
            records.add(new CrdtSyncDtos.ChangeRecord(
                    row.getSeq(),
                    row.getHash(),
                    CrdtChangeCodec.encode(row.getPayload())));
            seqs.add(row.getSeq());
        }
        long nextCursor = CrdtChangeCodec.cursorAfter(cursor, seqs);
        // A paged response must not advance past the last delivered change.
        return new CrdtSyncDtos.ChangesResponse(records, nextCursor, nextCursor);
    }

    /**
     * Append changes. A duplicate hash (replay, double click, concurrent upload
     * of the same change) is reported in {@code duplicates} and never creates a
     * second row — so replaying a whole batch is always safe.
     */
    public CrdtSyncDtos.PostChangesResponse postChanges(
            long projectId, List<CrdtSyncDtos.ChangeItem> items) {
        projectAccess.require(projectId, ProjectCapability.WORKSPACE_WRITE);
        return appendChanges(projectId, items, CurrentUser.requireId());
    }

    /**
     * The pure append logic, separated from authentication so idempotency can
     * be unit tested without a security context.
     */
    CrdtSyncDtos.PostChangesResponse appendChanges(
            long projectId, List<CrdtSyncDtos.ChangeItem> items, long actor) {
        if (items == null || items.isEmpty()) {
            long current = maxSeq(projectId);
            return new CrdtSyncDtos.PostChangesResponse(List.of(), List.of(), current, current);
        }
        if (items.size() > 500) {
            throw new BizException(ErrorCode.BAD_REQUEST, "too many changes in one request");
        }
        List<String> accepted = new ArrayList<>();
        List<String> duplicates = new ArrayList<>();
        Set<String> inRequest = new HashSet<>();

        for (CrdtSyncDtos.ChangeItem item : items) {
            byte[] payload = CrdtChangeCodec.decode(
                    item.payload(), CrdtChangeCodec.MAX_CHANGE_BYTES);
            String hash = CrdtChangeCodec.isValidHash(item.hash())
                    ? item.hash().toLowerCase(Locale.ROOT)
                    : CrdtChangeCodec.sha256Hex(payload);
            if (!inRequest.add(hash)) {
                duplicates.add(hash);
                continue;
            }
            CrdtChangeEntity entity = new CrdtChangeEntity();
            entity.setProjectId(projectId);
            entity.setHash(hash);
            entity.setPayload(payload);
            entity.setUploadedBy(actor);
            try {
                changeMapper.insert(entity);
                accepted.add(hash);
            } catch (DuplicateKeyException alreadyStored) {
                duplicates.add(hash);
            }
        }
        long cursor = maxSeq(projectId);
        return new CrdtSyncDtos.PostChangesResponse(accepted, duplicates, cursor, cursor);
    }

    /**
     * Store a compressed document snapshot for fast new-replica bootstrap.
     * The snapshot never truncates the log; clients still pull changes after
     * {@code snapshotSeq}.
     */
    public CrdtSyncDtos.SnapshotResponse postSnapshot(
            long projectId, String docBase64, List<String> heads, Long containedSeq) {
        projectAccess.require(projectId, ProjectCapability.WORKSPACE_WRITE);
        if (snapshotMapper.selectById(projectId) == null) {
            throw BizException.notFound("CRDT genesis");
        }
        byte[] doc = CrdtChangeCodec.decode(docBase64, 64 * 1024 * 1024);
        long max = maxSeq(projectId);
        // Never claim the snapshot contains changes beyond what the client pulled.
        // A smaller seq is fine: the new replica simply pulls the remainder.
        long seq = containedSeq == null ? max : Math.min(Math.max(0L, containedSeq), max);
        snapshotMapper.update(null, new LambdaUpdateWrapper<CrdtSnapshotEntity>()
                .eq(CrdtSnapshotEntity::getProjectId, projectId)
                .set(CrdtSnapshotEntity::getDoc, doc)
                .set(CrdtSnapshotEntity::getHeads, CrdtChangeCodec.headsJson(heads))
                .set(CrdtSnapshotEntity::getSnapshotSeq, seq));
        return new CrdtSyncDtos.SnapshotResponse(seq, seq);
    }

    private CrdtSyncDtos.BootstrapResponse view(
            long projectId, CrdtSnapshotEntity snapshot, long cursor) {
        if (snapshot == null) {
            return new CrdtSyncDtos.BootstrapResponse(null, null, List.of(), cursor, cursor);
        }
        if (snapshot.getGenesis() == null) {
            throw new BizException(ErrorCode.INTERNAL, "CRDT genesis is missing for this space");
        }
        CrdtSyncDtos.SnapshotRef ref = snapshot.getDoc() == null
                ? null
                : new CrdtSyncDtos.SnapshotRef(
                        CrdtChangeCodec.encode(snapshot.getDoc()),
                        snapshot.getSnapshotSeq() == null ? 0L : snapshot.getSnapshotSeq());
        return new CrdtSyncDtos.BootstrapResponse(
                CrdtChangeCodec.encode(snapshot.getGenesis()),
                ref,
                parseHeads(snapshot.getHeads()),
                cursor,
                cursor);
    }

    private List<String> parseHeads(String raw) {
        if (raw == null || raw.isBlank()) {
            return List.of();
        }
        try {
            return MAPPER.readValue(raw, new TypeReference<List<String>>() {
            });
        } catch (Exception malformed) {
            return List.of();
        }
    }

    private long maxSeq(long projectId) {
        CrdtChangeEntity last = changeMapper.selectOne(
                new LambdaQueryWrapper<CrdtChangeEntity>()
                        .eq(CrdtChangeEntity::getProjectId, projectId)
                        .orderByDesc(CrdtChangeEntity::getSeq)
                        .last("LIMIT 1"));
        return last == null || last.getSeq() == null ? 0L : last.getSeq();
    }
}
