package com.xbeeant.reqora.server.user;

import java.time.LocalDateTime;
import java.util.Set;

/** Public user representation. Never contains password hashes or tokens. */
public record UserView(
        Long id,
        String username,
        String email,
        String displayName,
        Integer status,
        boolean superAdmin,
        Set<String> roles,
        Set<String> permissions,
        LocalDateTime createdAt) {}
