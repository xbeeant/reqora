package com.xbeeant.reqora.server.docsite;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import java.time.LocalDateTime;
import java.util.Map;

public final class DocSiteDtos {

    private DocSiteDtos() {}

    /**
     * payload is the client-produced DocSitePayload. The server stores it verbatim
     * and never interprets or renders it.
     */
    public record PublishRequest(
            @NotNull Map<String, Object> payload,
            String title,
            @Min(1) @Max(24 * 365) Long expiresInHours) {}

    /** Listing view deliberately contains no token and no payload. */
    public record DocSiteView(
            Long id,
            Long projectId,
            String title,
            String status,
            LocalDateTime expiresAt,
            Long viewCount,
            LocalDateTime createdAt) {}

    /** The raw token and the ready-to-copy URL are returned only once. */
    public record PublishResponse(DocSiteView share, String token, String url) {}
}
