package com.xbeeant.reqora.server.docsite;

import com.xbeeant.reqora.server.common.ApiResponse;
import jakarta.validation.Valid;
import java.util.List;
import java.util.Map;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Management endpoints live under /projects/{id}/... and require authentication;
 * the single token-based GET is public (see SecurityConfig). No HTML is produced
 * here — the payload is rendered by the client SPA.
 */
@Validated
@RestController
@RequestMapping("/api/v1")
public class DocSiteController {

    private final DocSiteService docSiteService;

    public DocSiteController(DocSiteService docSiteService) {
        this.docSiteService = docSiteService;
    }

    @PostMapping("/projects/{projectId}/doc-sites")
    public ApiResponse<DocSiteDtos.PublishResponse> publish(
            @PathVariable long projectId,
            @Valid @RequestBody DocSiteDtos.PublishRequest request) {
        return ApiResponse.ok(docSiteService.publish(projectId, request));
    }

    @GetMapping("/projects/{projectId}/doc-sites")
    public ApiResponse<List<DocSiteDtos.DocSiteView>> list(@PathVariable long projectId) {
        return ApiResponse.ok(docSiteService.list(projectId));
    }

    @PutMapping("/projects/{projectId}/doc-sites/{shareId}")
    public ApiResponse<DocSiteDtos.DocSiteView> update(
            @PathVariable long projectId,
            @PathVariable long shareId,
            @Valid @RequestBody DocSiteDtos.PublishRequest request) {
        return ApiResponse.ok(docSiteService.update(projectId, shareId, request));
    }

    @PostMapping("/projects/{projectId}/doc-sites/{shareId}/token")
    public ApiResponse<DocSiteDtos.PublishResponse> rotateToken(
            @PathVariable long projectId, @PathVariable long shareId) {
        return ApiResponse.ok(docSiteService.rotateToken(projectId, shareId));
    }

    @DeleteMapping("/projects/{projectId}/doc-sites/{shareId}")
    public ApiResponse<Void> revoke(@PathVariable long projectId, @PathVariable long shareId) {
        docSiteService.revoke(projectId, shareId);
        return ApiResponse.ok(null);
    }

    /** Public read: no Authorization header, no project id, no session. */
    @GetMapping("/doc-sites/{token}")
    public ApiResponse<Map<String, Object>> publicPayload(@PathVariable String token) {
        return ApiResponse.ok(docSiteService.publicPayload(token));
    }
}
