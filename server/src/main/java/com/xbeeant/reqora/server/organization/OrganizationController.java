package com.xbeeant.reqora.server.organization;

import com.xbeeant.reqora.server.common.ApiResponse;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Validated
@RestController
@RequestMapping("/api/v1/orgs")
public class OrganizationController {

    private final OrganizationService organizationService;

    public OrganizationController(OrganizationService organizationService) {
        this.organizationService = organizationService;
    }

    @PostMapping
    public ApiResponse<OrgDtos.OrgView> create(@Valid @RequestBody OrgDtos.CreateOrgRequest request) {
        return ApiResponse.ok(organizationService.create(request));
    }

    @GetMapping
    public ApiResponse<List<OrgDtos.OrgView>> mine() {
        return ApiResponse.ok(organizationService.mine());
    }

    @GetMapping("/{orgId}")
    public ApiResponse<OrgDtos.OrgView> get(@PathVariable long orgId) {
        return ApiResponse.ok(organizationService.get(orgId));
    }

    @GetMapping("/{orgId}/members")
    public ApiResponse<List<OrgDtos.OrgMemberView>> members(@PathVariable long orgId) {
        return ApiResponse.ok(organizationService.members(orgId));
    }

    @PostMapping("/{orgId}/leave")
    public ApiResponse<Void> leave(@PathVariable long orgId) {
        organizationService.leave(orgId);
        return ApiResponse.ok(null);
    }
}
