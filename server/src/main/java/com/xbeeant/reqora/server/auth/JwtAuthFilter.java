package com.xbeeant.reqora.server.auth;

import com.xbeeant.reqora.server.common.AuthUser;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.common.SecurityErrorWriter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import org.springframework.http.HttpHeaders;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/** Bearer-token authentication. Requests without a token fall through to the entry point. */
@Component
public class JwtAuthFilter extends OncePerRequestFilter {

    private final JwtService jwtService;
    private final PrincipalLoader principalLoader;

    public JwtAuthFilter(JwtService jwtService, PrincipalLoader principalLoader) {
        this.jwtService = jwtService;
        this.principalLoader = principalLoader;
    }

    @Override
    protected void doFilterInternal(
            HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String header = request.getHeader(HttpHeaders.AUTHORIZATION);
        if (header == null || !header.startsWith("Bearer ")) {
            chain.doFilter(request, response);
            return;
        }
        try {
            JwtService.AccessClaims claims = jwtService.verify(header.substring(7).trim());
            AuthUser user = principalLoader.load(claims.userId());
            List<SimpleGrantedAuthority> authorities = user.permissions().stream()
                    .map(SimpleGrantedAuthority::new)
                    .toList();
            SecurityContextHolder.getContext().setAuthentication(
                    new UsernamePasswordAuthenticationToken(user, null, authorities));
            chain.doFilter(request, response);
        } catch (JwtService.InvalidTokenException ex) {
            SecurityContextHolder.clearContext();
            SecurityErrorWriter.write(response, ErrorCode.TOKEN_INVALID, null);
        } catch (BizException ex) {
            SecurityContextHolder.clearContext();
            SecurityErrorWriter.write(response, ex.error(), ex.getMessage());
        }
    }
}
