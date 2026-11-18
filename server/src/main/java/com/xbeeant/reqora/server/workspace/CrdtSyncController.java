package com.xbeeant.reqora.server.workspace;

import com.xbeeant.reqora.server.common.ApiResponse;
import jakarta.validation.Valid;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Sync protocol v2 endpoints. Kept under a separate sub-path so an older
 * deployment simply returns 404 on /crdt/bootstrap — the client's capability
 * probe then transparently falls back to the v1 /rows protocol.
 */
@Validated
@RestController
@RequestMapping("/api/v1/projects/{projectId}/workspace/crdt")
public class CrdtSyncController {

    private final CrdtSyncService crdtSyncService;

    public CrdtSyncController(CrdtSyncService crdtSyncService) {
        this.crdtSyncService = crdtSyncService;
    }

    @GetMapping("/bootstrap")
    public ApiResponse<CrdtSyncDtos.BootstrapResponse> bootstrap(@PathVariable long projectId) {
        return ApiResponse.ok(crdtSyncService.bootstrap(projectId));
    }

    @PostMapping("/bootstrap")
    public ApiResponse<CrdtSyncDtos.BootstrapResponse> createGenesis(
            @PathVariable long projectId,
            @Valid @RequestBody CrdtSyncDtos.BootstrapRequest request) {
        return ApiResponse.ok(crdtSyncService.createGenesis(projectId, request.genesis()));
    }

    @GetMapping("/changes")
    public ApiResponse<CrdtSyncDtos.ChangesResponse> changes(
            @PathVariable long projectId,
            @RequestParam(name = "since", required = false, defaultValue = "0") long since,
            @RequestParam(name = "limit", required = false, defaultValue = "500") int limit) {
        return ApiResponse.ok(crdtSyncService.changes(projectId, since, limit));
    }

    @PostMapping("/changes")
    public ApiResponse<CrdtSyncDtos.PostChangesResponse> postChanges(
            @PathVariable long projectId,
            @Valid @RequestBody CrdtSyncDtos.PostChangesRequest request) {
        return ApiResponse.ok(crdtSyncService.postChanges(projectId, request.changes()));
    }

    @PostMapping("/snapshot")
    public ApiResponse<CrdtSyncDtos.SnapshotResponse> postSnapshot(
            @PathVariable long projectId,
            @Valid @RequestBody CrdtSyncDtos.SnapshotRequest request) {
        return ApiResponse.ok(crdtSyncService.postSnapshot(
                projectId, request.doc(), request.heads(), request.seq()));
    }
}
