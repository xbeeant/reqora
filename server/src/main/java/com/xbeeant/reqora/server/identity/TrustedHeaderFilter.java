package com.xbeeant.reqora.server.identity;

import com.xbeeant.reqora.server.auth.PrincipalLoader;
import com.xbeeant.reqora.server.common.AuthUser;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.config.IdentityProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Reverse-proxy (forward-auth) SSO. Only requests arriving from an explicitly
 * trusted proxy CIDR are considered, and every header set must be covered by a
 * timestamped HMAC signature using the shared secret. Spoofed X-Forwarded-*
 * headers from the public internet are ignored.
 *
 * <p>Canonical signed payload (documented in docs/IDENTITY_AND_AUDIT.md):
 * {@code timestamp\nuser\nemail\ndisplayName\ngroups}.
 */
@Component
public class TrustedHeaderFilter extends OncePerRequestFilter {

    private final IdentityProperties properties;
    private final IdentityService identityService;
    private final PrincipalLoader principalLoader;

    public TrustedHeaderFilter(IdentityProperties properties, IdentityService identityService,
                               PrincipalLoader principalLoader) {
        this.properties = properties;
        this.identityService = identityService;
        this.principalLoader = principalLoader;
    }

    public static String canonical(long timestamp, String user, String email,
                                   String displayName, String groups) {
        return timestamp + "\n" + safe(user) + "\n" + safe(email) + "\n"
                + safe(displayName) + "\n" + safe(groups);
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }

    public static boolean trusted(IdentityProperties.Header config, String remoteAddr) {
        if (remoteAddr == null) {
            return false;
        }
        for (String cidr : config.getTrustedProxies()) {
            if (IdentityCrypto.cidrContains(cidr, remoteAddr)) {
                return true;
            }
        }
        return false;
    }

    public static boolean verify(IdentityProperties.Header config, String remoteAddr,
                                 long timestamp, String user, String email,
                                 String displayName, String groups, String signature) {
        if (!trusted(config, remoteAddr) || config.getHeaderSecret() == null
                || config.getHeaderSecret().isBlank() || signature == null || signature.isBlank()) {
            return false;
        }
        long skew = config.getMaxSkew().getSeconds();
        if (Math.abs(Instant.now().getEpochSecond() - timestamp) > skew) {
            return false;
        }
        String expected = IdentityCrypto.hmacSha256Hex(config.getHeaderSecret(),
                canonical(timestamp, user, email, displayName, groups));
        return IdentityCrypto.constantTimeEquals(expected, signature.trim());
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        IdentityProperties.Header config = properties.getHeader();
        if (!properties.isEnabled() || !config.isEnabled()
                || !trusted(config, request.getRemoteAddr())) {
            chain.doFilter(request, response);
            return;
        }
        String user = request.getHeader(config.getUserHeader());
        String email = request.getHeader(config.getEmailHeader());
        String name = request.getHeader(config.getNameHeader());
        String groups = request.getHeader(config.getGroupsHeader());
        String signature = request.getHeader(config.getSignatureHeader());
        long timestamp;
        try {
            timestamp = Long.parseLong(request.getHeader(config.getTimestampHeader()));
        } catch (Exception ex) {
            chain.doFilter(request, response);
            return;
        }
        if (user == null || user.isBlank() || !verify(config, request.getRemoteAddr(), timestamp,
                user, email, name, groups, signature)) {
            chain.doFilter(request, response);
            return;
        }
        try {
            List<String> groupList = groups == null || groups.isBlank()
                    ? List.of()
                    : Arrays.stream(groups.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList();
            IdentityClaims claims = new IdentityClaims("header", "header", user,
                    user, email == null || email.isBlank() ? user + "@proxy.local" : email,
                    name == null || name.isBlank() ? user : name, groupList);
            long userId = identityService.resolveUser(claims);
            AuthUser principal = principalLoader.load(userId);
            List<SimpleGrantedAuthority> authorities = principal.permissions().stream()
                    .map(SimpleGrantedAuthority::new).toList();
            SecurityContextHolder.getContext().setAuthentication(
                    new UsernamePasswordAuthenticationToken(principal, null, authorities));
            request.setAttribute("reqora.headerSso", claims);
        } catch (BizException ignored) {
            // A blocked/disabled account must not turn into a 500 at the filter.
            SecurityContextHolder.clearContext();
        }
        chain.doFilter(request, response);
    }
}
