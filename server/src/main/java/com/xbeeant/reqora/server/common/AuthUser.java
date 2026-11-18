package com.xbeeant.reqora.server.common;

import java.util.Set;

/** Authenticated principal kept in the Spring Security context for the request. */
public record AuthUser(Long id, String username, String displayName, boolean superAdmin, Set<String> permissions) {

    public boolean has(String permission) {
        return superAdmin || permissions.contains(permission);
    }
}
