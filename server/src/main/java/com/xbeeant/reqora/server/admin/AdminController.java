package com.xbeeant.reqora.server.admin;

import com.xbeeant.reqora.server.common.ApiResponse;
import com.xbeeant.reqora.server.common.PageResult;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Console-only endpoints. Authorization lives in AdminService, not in annotations. */
@RestController
@RequestMapping("/api/v1/admin")
public class AdminController {

    private final AdminService adminService;

    public AdminController(AdminService adminService) {
        this.adminService = adminService;
    }

    @GetMapping("/overview")
    public ApiResponse<AdminDtos.Overview> overview() {
        return ApiResponse.ok(adminService.overview());
    }

    @GetMapping("/orgs")
    public ApiResponse<List<AdminDtos.OrgRow>> orgs() {
        return ApiResponse.ok(adminService.orgs());
    }

    @GetMapping("/orgs/{orgId}/members")
    public ApiResponse<List<AdminDtos.OrgMemberRow>> orgMembers(@PathVariable long orgId) {
        return ApiResponse.ok(adminService.orgMembers(orgId));
    }

    @PostMapping("/orgs/{orgId}/members")
    public ApiResponse<AdminDtos.OrgMemberRow> addOrgMember(
            @PathVariable long orgId,
            @Valid @RequestBody AdminDtos.AddOrgMemberRequest request) {
        return ApiResponse.ok(adminService.addOrgMember(orgId, request));
    }

    @PutMapping("/orgs/{orgId}/members/{userId}/role")
    public ApiResponse<Void> changeOrgMemberRole(
            @PathVariable long orgId,
            @PathVariable long userId,
            @Valid @RequestBody AdminDtos.UpdateOrgMemberRequest request) {
        adminService.changeOrgMemberRole(orgId, userId, request);
        return ApiResponse.ok(null);
    }

    @DeleteMapping("/orgs/{orgId}/members/{userId}")
    public ApiResponse<Void> removeOrgMember(@PathVariable long orgId, @PathVariable long userId) {
        adminService.removeOrgMember(orgId, userId);
        return ApiResponse.ok(null);
    }

    @PostMapping("/grants/batch")
    public ApiResponse<AdminDtos.BatchGrantResult> batchGrant(
            @Valid @RequestBody AdminDtos.BatchGrantRequest request) {
        return ApiResponse.ok(adminService.batchGrant(request));
    }

    /** List all published doc-site shares, optionally filtered by project / status / keyword. */
    @GetMapping("/doc-sites")
    public ApiResponse<PageResult<AdminDtos.DocSiteAdminView>> docSites(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) Long projectId,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String keyword) {
        return ApiResponse.ok(adminService.docSites(page, size, projectId, status, keyword));
    }
}
