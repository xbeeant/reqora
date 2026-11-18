package com.xbeeant.reqora.server.organization;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.LocalDateTime;

public final class OrgDtos {

    private OrgDtos() {}

    public record OrgView(
            Long id,
            String name,
            String slug,
            String description,
            Long ownerId,
            String memberRole,
            String status,
            LocalDateTime createdAt) {}

    public record CreateOrgRequest(
            @NotBlank @Size(max = 120) String name,
            @NotBlank @Size(max = 120)
            @Pattern(regexp = "^[a-z0-9][a-z0-9-]{1,119}$",
                    message = "slug 只能包含小写字母、数字和连字符，且以字母或数字开头")
            String slug,
            String description) {}

    public record OrgMemberView(
            Long userId,
            String username,
            String displayName,
            String role,
            String joinedAt) {}
}
