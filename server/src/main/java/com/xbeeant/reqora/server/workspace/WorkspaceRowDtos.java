package com.xbeeant.reqora.server.workspace;

import java.util.List;
import java.util.Map;

/**
 * Wire DTOs for the row-level sync protocol (统一行模型). Field names match
 * the TypeScript rows in src/lib/workspaceRows.ts exactly; the desktop SQLite
 * schema (storage.rs) is structurally identical.
 *
 * <p>Rows carry {@code updatedAt} (client epoch millis) and {@code deleted};
 * the server merges per row with last-writer-wins and returns the merged rows.
 * {@code version} is a change-notification counter, not a conflict token —
 * conflicts are resolved per row, so there is no 409 path.</p>
 */
public final class WorkspaceRowDtos {

    private WorkspaceRowDtos() {
    }

    /** Collection (文件夹/集合) row. {@code data} carries the explicit empty-folder list. */
    public record FolderRow(
            String id,
            long updatedAt,
            Boolean deleted,
            String name,
            Map<String, Object> auth,
            int position,
            Map<String, Object> data) {
    }

    /** Request (接口) row: method/url are dedicated columns for field-level diffing. */
    public record RequestRow(
            String id,
            long updatedAt,
            Boolean deleted,
            String folderId,
            String folderPath,
            String name,
            String method,
            String url,
            String protocol,
            int position,
            Map<String, Object> data) {
    }

    public record EnvironmentRow(
            String id,
            long updatedAt,
            Boolean deleted,
            String name,
            int position,
            Map<String, Object> data) {
    }

    public record CaseRow(
            String id,
            long updatedAt,
            Boolean deleted,
            String requestId,
            String caseGroup,
            String name,
            Boolean enabled,
            Map<String, Object> data) {
    }

    public record ScenarioRow(
            String id,
            long updatedAt,
            Boolean deleted,
            String name,
            int position,
            Map<String, Object> data) {
    }

    public record SuiteRow(
            String id,
            long updatedAt,
            Boolean deleted,
            String name,
            int position,
            Map<String, Object> data) {
    }

    /** Shared artifact: docPage / dataModel / scriptSnippet / codeTemplate. */
    public record ArtifactRow(
            String id,
            long updatedAt,
            Boolean deleted,
            String kind,
            String name,
            int position,
            Map<String, Object> data) {
    }

    public record MetaRow(
            Boolean seeded,
            String activeEnvironmentId,
            Map<String, Object> settings) {
    }

    /** Upload: clients may send only the locally-winner rows per domain. */
    public record SyncRequest(
            List<FolderRow> folders,
            List<RequestRow> requests,
            List<EnvironmentRow> environments,
            List<CaseRow> cases,
            List<ScenarioRow> scenarios,
            List<SuiteRow> suites,
            List<ArtifactRow> artifacts,
            MetaRow meta) {
    }

    /** Download / sync result: the merged, per-project row set (incl. tombstones). */
    /**
     * Download / sync result: the merged, per-project row set (incl.
     * tombstones). {@code full} is true when the payload is the complete row
     * set — plain GET /rows, or a {@code since} cursor older than the
     * tombstone-compaction watermark (rows deleted-and-compacted leave no
     * tombstone behind, so an old cursor cannot guarantee a complete delta).
     * Full responses must REPLACE the client's view, not overlay a baseline.
     */
    public record RowsResponse(
            long projectId,
            long version,
            boolean full,
            List<FolderRow> folders,
            List<RequestRow> requests,
            List<EnvironmentRow> environments,
            List<CaseRow> cases,
            List<ScenarioRow> scenarios,
            List<SuiteRow> suites,
            List<ArtifactRow> artifacts,
            MetaRow meta) {
    }

    /**
     * One row the server has merged in ackOnly mode. {@code applied} is false
     * when the server kept its own stored row (stored {@code updatedAt} is
     * newer or equal-timestamp) — the row still reached a settled state, but
     * the client should expect the server's version in the next delta pull
     * and treat the local change as a conflict candidate.
     */
    public record AcceptedRow(String id, long updatedAt, boolean applied) {
    }

    /**
     * Chunked-sync confirmation ({@code POST /rows?ackOnly=true}): reports the
     * new version and the rows the request carried, WITHOUT the full merged
     * row set — a chunked upload would otherwise pay a full download per
     * chunk. Clients pull GET /rows once after the last chunk.
     */
    public record AckResponse(long projectId, long version, List<AcceptedRow> accepted) {
    }

    /** Content-addressed object upload result (idempotent by hash). */
    public record ObjectPutResponse(String hash, long size) {
    }

    public record WorkspaceHead(long projectId, long version, String updatedAt) {
    }
}
