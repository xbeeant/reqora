package com.xbeeant.reqora.server.project;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.LocalDateTime;

public final class ProjectDtos {

    private ProjectDtos() {}

    public record ProjectView(
            Long id,
            String name,
            String slug,
            String description,
            String status,
            Long ownerId,
            String memberRole,
            LocalDateTime createdAt,
            LocalDateTime updatedAt,
            Long orgId) {}

    public record CreateProjectRequest(
            @NotBlank @Size(max = 120) String name,
            @NotBlank @Size(max = 120)
            @Pattern(regexp = "^[a-z0-9][a-z0-9-]{1,119}$",
                    message = "slug 只能包含小写字母、数字和连字符，且以字母或数字开头")
            String slug,
            String description,
            /** Optional owning organization; the caller must be an org member. */
            Long orgId) {}

    public record UpdateProjectRequest(
            @NotBlank @Size(max = 120) String name,
            String description) {}
}
