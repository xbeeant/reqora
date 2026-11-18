package com.xbeeant.reqora.server.workspace;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * Wire DTOs for sync protocol v2 (Automerge CRDT + append-only change log).
 * Field names match src/lib/crdtSync.ts exactly. All binary payloads travel as
 * base64 strings so the endpoints stay inside the normal JSON envelope.
 */
public final class CrdtSyncDtos {

    private CrdtSyncDtos() {
    }

    /** A client-uploaded compressed snapshot plus the seq it already contains. */
    public record SnapshotRef(String doc, long seq) {
    }

    /**
     * {@code genesis == null} means this space has no genesis yet: the first
     * client must POST /bootstrap to establish one. Old servers simply 404 on
     * this endpoint, which the client treats as "fall back to v1".
     */
    public record BootstrapResponse(
            String genesis,
            SnapshotRef snapshot,
            List<String> heads,
            long cursor,
            long version) {
    }

    public record BootstrapRequest(@NotBlank String genesis) {
    }

    /** hash = Automerge decodeChange(change).hash; payload = base64 change bytes. */
    public record ChangeItem(String hash, @NotBlank String payload) {
    }

    public record ChangeRecord(long seq, String hash, String payload) {
    }

    public record ChangesResponse(List<ChangeRecord> changes, long cursor, long version) {
    }

    public record PostChangesRequest(
            @Size(max = 500, message = "single request carries at most 500 changes")
            List<ChangeItem> changes) {
    }

    public record PostChangesResponse(
            List<String> accepted,
            List<String> duplicates,
            long cursor,
            long version) {
    }

    /** seq = the server cursor this doc actually contains; new replicas pull from there. */
    public record SnapshotRequest(@NotBlank String doc, List<String> heads, Long seq) {
    }

    public record SnapshotResponse(long seq, long version) {
    }
}
