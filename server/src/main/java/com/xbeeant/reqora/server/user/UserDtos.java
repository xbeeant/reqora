package com.xbeeant.reqora.server.user;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.LocalDateTime;
import java.util.List;

public final class UserDtos {

    private UserDtos() {}

    /** List rows deliberately omit roles/permissions, so listing stays free of N+1 queries. */
    public record UserSummary(
            Long id,
            String username,
            String email,
            String displayName,
            Integer status,
            LocalDateTime createdAt) {}

    /** Admin-provisioned account; created enabled, roles default to USER. */
    public record CreateUserRequest(
            @NotBlank @Size(min = 3, max = 64)
            @Pattern(regexp = "^[A-Za-z0-9_.-]+$", message = "只能包含字母、数字、点、下划线和连字符")
            String username,
            @NotBlank @Email String email,
            @NotBlank @Size(min = 8, max = 72, message = "密码长度需为 8-72") String password,
            String displayName,
            List<String> roles) {}

    public record SetStatusRequest(@NotNull Boolean enabled) {}

    public record SetRolesRequest(@NotEmpty List<String> roles) {}

    public record ResetPasswordRequest(@NotBlank @Size(min = 8, max = 72) String password) {}

    public record ChangePasswordRequest(
            @NotBlank String oldPassword,
            @NotBlank @Size(min = 8, max = 72) String newPassword) {}
}
