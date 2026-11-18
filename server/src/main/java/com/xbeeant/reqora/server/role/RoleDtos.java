package com.xbeeant.reqora.server.role;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.LocalDateTime;
import java.util.List;

public final class RoleDtos {

    private RoleDtos() {}

    public record RoleView(
            Long id,
            String code,
            String name,
            String description,
            boolean builtin,
            List<String> permissions,
            LocalDateTime createdAt) {}

    public record PermissionView(String code, String name, String module, String description) {}

    public record CreateRoleRequest(
            @NotBlank @Size(max = 64)
            @Pattern(regexp = "^[A-Z][A-Z0-9_]{1,63}$", message = "角色编码需为大写字母/数字/下划线")
            String code,
            @NotBlank @Size(max = 64) String name,
            String description) {}

    public record UpdateRoleRequest(@NotBlank @Size(max = 64) String name, String description) {}

    public record SetPermissionsRequest(@NotNull List<String> permissions) {}
}
