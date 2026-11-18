package com.xbeeant.reqora.server.invitation;

import com.xbeeant.reqora.server.common.ApiResponse;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Validated
@RestController
@RequestMapping("/api/v1")
public class InvitationController {

    private final InvitationService invitationService;

    public InvitationController(InvitationService invitationService) {
        this.invitationService = invitationService;
    }

    @PostMapping("/orgs/{orgId}/invitations")
    public ApiResponse<InviteDtos.CreateInviteResponse> create(
            @PathVariable long orgId,
            @Valid @RequestBody InviteDtos.CreateInviteRequest request) {
        return ApiResponse.ok(invitationService.create(orgId, request));
    }

    @GetMapping("/orgs/{orgId}/invitations")
    public ApiResponse<List<InviteDtos.InviteView>> list(@PathVariable long orgId) {
        return ApiResponse.ok(invitationService.list(orgId));
    }

    @DeleteMapping("/orgs/{orgId}/invitations/{inviteId}")
    public ApiResponse<Void> revoke(@PathVariable long orgId, @PathVariable long inviteId) {
        invitationService.revoke(orgId, inviteId);
        return ApiResponse.ok(null);
    }

    @PostMapping("/invitations/{token}/accept")
    public ApiResponse<InviteDtos.AcceptResponse> accept(@PathVariable String token) {
        return ApiResponse.ok(invitationService.accept(token));
    }
}
