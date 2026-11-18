package com.xbeeant.reqora.server.invitation;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import java.time.LocalDateTime;

public final class InviteDtos {

    private InviteDtos() {}

    public record CreateInviteRequest(
            String role,
            @Min(1) @Max(100) Integer maxUses,
            @Min(1) @Max(24 * 30) Long expiresInHours,
            String label) {}

    public record InviteView(
            Long id,
            Long orgId,
            String role,
            String label,
            LocalDateTime expiresAt,
            Integer maxUses,
            Integer usedCount,
            String status,
            LocalDateTime createdAt) {}

    /** The raw token is only present in the creation response. */
    public record CreateInviteResponse(InviteView invite, String token) {}

    public record AcceptResponse(Long orgId, String orgName, String role) {}
}
