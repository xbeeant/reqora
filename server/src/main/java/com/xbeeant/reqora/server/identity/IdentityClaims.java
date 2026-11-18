package com.xbeeant.reqora.server.identity;

import java.util.List;

/** Normalized identity produced by any login method before account resolution. */
public record IdentityClaims(
        String providerId,
        String providerType,
        String subject,
        String username,
        String email,
        String displayName,
        List<String> groups) {

    public IdentityClaims {
        groups = groups == null ? List.of() : List.copyOf(groups);
    }
}
