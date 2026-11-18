package com.xbeeant.reqora.server.member;

import jakarta.validation.constraints.NotBlank;
import java.time.LocalDateTime;

public final class MemberDtos {

    private MemberDtos() {}

    public record MemberView(
            Long id,
            Long userId,
            String username,
            String email,
            String displayName,
            String role,
            LocalDateTime createdAt) {}

    public record AddMemberRequest(@NotBlank String username, @NotBlank String role) {}

    public record UpdateMemberRequest(@NotBlank String role) {}

    public record TransferOwnerRequest(Long userId) {}
}
