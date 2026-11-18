package com.xbeeant.reqora.server.config;

import com.xbeeant.reqora.server.auth.JwtAuthFilter;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.identity.TrustedHeaderFilter;
import com.xbeeant.reqora.server.common.SecurityErrorWriter;
import java.util.List;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.security.web.header.writers.StaticHeadersWriter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain securityFilterChain(
            HttpSecurity http,
            JwtAuthFilter jwtAuthFilter,
            TrustedHeaderFilter headerSsoFilter,
            @Qualifier("corsConfigurationSource") CorsConfigurationSource corsSource)
            throws Exception {
        http
                .csrf(AbstractHttpConfigurer::disable)
                .cors(cors -> cors.configurationSource(corsSource))
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .exceptionHandling(ex -> ex
                        .authenticationEntryPoint((request, response, authException) ->
                                SecurityErrorWriter.write(response, ErrorCode.UNAUTHENTICATED, null))
                        .accessDeniedHandler((request, response, accessDeniedException) ->
                                SecurityErrorWriter.write(response, ErrorCode.FORBIDDEN, null)))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
                        .requestMatchers(
                                "/health", "/ready",
                                "/actuator/health", "/actuator/health/**", "/actuator/info",
                                "/api/v1/auth/register", "/api/v1/auth/login", "/api/v1/auth/refresh",
                                // External login entry points. Each of them authenticates
                                // itself (one-shot state, signed assertion, LDAP bind,
                                // trusted-proxy HMAC or SCIM/PAT token) before issuing
                                // a normal local JWT; see docs/IDENTITY_AND_AUDIT.md.
                                "/api/v1/auth/providers", "/api/v1/auth/sso/**",
                                "/api/v1/auth/pat/exchange", "/scim/v2/**",
                                "/api/v1/doc-sites/*",
                                // Same-origin SPA bundle (see build.gradle.kts processResources).
                                // Only the static shell is public; API calls it makes still need
                                // a Bearer token unless explicitly listed above.
                                "/", "/index.html", "/assets/**", "/error",
                                "/favicon.ico", "/reqora.svg",
                                // Self-hosted admin console (static assets only). The shell
                                // carries no credentials; every API call it makes still needs a
                                // Bearer token, which the console keeps in sessionStorage.
                                "/admin", "/admin/", "/admin/**")
                        .permitAll()
                        .anyRequest().authenticated())
                // Trusted-header SSO must populate the context before the JWT
                // filter runs; an invalid header simply falls through to Bearer.
                //
                // Spring Security only assigns an order to a custom filter once it
                // has been added to the chain, and addFilterBefore(.., X.class)
                // requires X to already have a registered order. Register the JWT
                // filter against a built-in filter FIRST, then use it as the anchor
                // for the SSO filter (which therefore runs one step earlier).
                .addFilterBefore(jwtAuthFilter, UsernamePasswordAuthenticationFilter.class)
                .addFilterBefore(headerSsoFilter, JwtAuthFilter.class)
                .headers(headers -> headers
                        .addHeaderWriter(new StaticHeadersWriter("X-Frame-Options", "DENY"))
                        .addHeaderWriter(new StaticHeadersWriter("X-Content-Type-Options", "nosniff"))
                        .addHeaderWriter(new StaticHeadersWriter("Referrer-Policy", "no-referrer"))
                        .addHeaderWriter(new StaticHeadersWriter(
                                "Permissions-Policy", "geolocation=(), microphone=(), camera=()"))
                        .addHeaderWriter(new StaticHeadersWriter(
                                "Cache-Control", "no-store")));
        return http.build();
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    /** Explicit allow-list only; wildcard origins are rejected at startup. */
    @Bean
    public CorsConfigurationSource corsConfigurationSource(AppProperties properties) {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowedOrigins(properties.getCors().getAllowedOrigins().stream()
                .map(String::trim).toList());
        // SCIM 2.0 PATCH 需要放行；ETag/If-Match 仍未使用。
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        config.setAllowedHeaders(List.of("Authorization", "Content-Type", "X-Request-Id",
                "X-Forwarded-User", "X-Forwarded-Email", "X-Forwarded-Preferred-Username",
                "X-Forwarded-Groups", "X-Forwarded-Timestamp", "X-Forwarded-Signature"));
        config.setExposedHeaders(List.of("X-Request-Id"));
        config.setAllowCredentials(true);
        config.setMaxAge(3600L);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", config);
        return source;
    }
}
