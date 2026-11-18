package com.xbeeant.reqora.server.common;

import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

/** Service-layer access to the current principal; never depends on servlet types. */
public final class CurrentUser {

    private CurrentUser() {}

    public static AuthUser require() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !(authentication.getPrincipal() instanceof AuthUser user)) {
            throw new BizException(ErrorCode.UNAUTHENTICATED);
        }
        return user;
    }

    public static Long requireId() {
        return require().id();
    }
}
