package com.xbeeant.reqora.server.workspace;

import jakarta.validation.constraints.NotNull;
import java.time.LocalDateTime;
import java.util.Map;

public final class WorkspaceDtos {

    private WorkspaceDtos() {}

    public record WorkspaceDto(
            long projectId,
            long version,
            Map<String, Object> data,
            String checksum,
            Long updatedBy,
            LocalDateTime updatedAt,
            String etag) {}

    /** Lightweight polling endpoint: never returns the (potentially large) snapshot. */
    public record WorkspaceHead(
            long projectId, long version, String checksum, LocalDateTime updatedAt) {}

    public record PutWorkspaceRequest(
            @NotNull Map<String, Object> data,
            @NotNull Long expectedVersion,
            String note) {}

    public record RevisionMeta(
            Long id,
            long version,
            String note,
            String checksum,
            Long createdBy,
            LocalDateTime createdAt) {}

    public record RevisionDetail(
            long projectId,
            long version,
            String note,
            Map<String, Object> data,
            LocalDateTime createdAt) {}
}
