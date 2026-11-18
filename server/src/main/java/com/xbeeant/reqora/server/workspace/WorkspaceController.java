package com.xbeeant.reqora.server.workspace;

import com.xbeeant.reqora.server.common.ApiResponse;
import com.xbeeant.reqora.server.project.ProjectAccess;
import com.xbeeant.reqora.server.project.ProjectCapability;
import jakarta.validation.Valid;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * Row-level workspace sync endpoints (统一行模型). The row store is the
 * authoritative representation (see db/migration/V1__init.sql).
 */
@Validated
@RestController
@RequestMapping("/api/v1/projects/{projectId}/workspace")
public class WorkspaceController {

    private final WorkspaceService workspaceService;
    private final WorkspaceEventHub eventHub;
    private final ProjectAccess projectAccess;

    public WorkspaceController(
            WorkspaceService workspaceService,
            WorkspaceEventHub eventHub,
            ProjectAccess projectAccess) {
        this.workspaceService = workspaceService;
        this.eventHub = eventHub;
        this.projectAccess = projectAccess;
    }

    /** SSE stream of workspace version changes; falls back to /head polling. */
    @GetMapping(value = "/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@PathVariable long projectId) {
        projectAccess.require(projectId, ProjectCapability.PROJECT_READ);
        return eventHub.subscribe(projectId, workspaceService.head(projectId).version());
    }

    /**
     * Download the merged row set (including tombstones). Passing
     * {@code ?since=<rowVersion cursor>} returns only rows stamped after the
     * cursor (incremental sync); omitting it returns the full set.
     */
    @GetMapping("/rows")
    public ApiResponse<WorkspaceRowDtos.RowsResponse> rows(
            @PathVariable long projectId,
            @RequestParam(name = "since", required = false) Long since) {
        if (since == null) {
            return ApiResponse.ok(workspaceService.rows(projectId));
        }
        return ApiResponse.ok(workspaceService.rowsSince(projectId, since));
    }

    /**
     * Upload locally-winner rows; the server merges per row (last-writer-wins).
     * Default returns the full merged row set so every replica converges.
     * Chunked uploads pass {@code ?ackOnly=true} to get a per-chunk
     * confirmation instead (a chunked upload must not pay one full download
     * per chunk) and pull GET /rows once after the last chunk.
     */
    @PostMapping("/rows")
    public ApiResponse<?> sync(
            @PathVariable long projectId,
            @RequestParam(name = "ackOnly", required = false, defaultValue = "false") boolean ackOnly,
            @Valid @RequestBody WorkspaceRowDtos.SyncRequest request) {
        if (ackOnly) {
            WorkspaceRowDtos.AckResponse ack = workspaceService.syncAck(projectId, request);
            eventHub.publish(projectId, ack.version(), "");
            return ApiResponse.ok(ack);
        }
        WorkspaceRowDtos.RowsResponse result = workspaceService.sync(projectId, request);
        eventHub.publish(projectId, result.version(), "");
        return ApiResponse.ok(result);
    }

    @GetMapping("/head")
    public ApiResponse<WorkspaceRowDtos.WorkspaceHead> head(@PathVariable long projectId) {
        return ApiResponse.ok(workspaceService.head(projectId));
    }

    /**
     * Upload a content-addressed object (serialized row payload of an
     * oversized row). Raw octet-stream body; idempotent by sha256. The
     * optional {@code hash} query parameter lets the client assert the digest
     * it computed locally — a mismatch is rejected as a 400.
     */
    @PostMapping(value = "/objects", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ApiResponse<WorkspaceRowDtos.ObjectPutResponse> putObject(
            @PathVariable long projectId,
            @RequestParam(name = "hash", required = false) String hash,
            @RequestBody byte[] content) {
        long actorId = com.xbeeant.reqora.server.common.CurrentUser.requireId();
        return ApiResponse.ok(workspaceService.putObject(projectId, content, hash, actorId));
    }

    /**
     * Download a content-addressed object by hash. Raw bytes on success;
     * errors follow the normal JSON error envelope.
     */
    @GetMapping(value = "/objects/{hash}", produces = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<byte[]> getObject(@PathVariable long projectId, @PathVariable String hash) {
        byte[] content = workspaceService.getObject(projectId, hash);
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .contentLength(content.length)
                .body(content);
    }
}
