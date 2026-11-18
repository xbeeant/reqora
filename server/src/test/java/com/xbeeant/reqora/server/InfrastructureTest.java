package com.xbeeant.reqora.server;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.xbeeant.reqora.server.auth.JwtAuthFilter;
import com.xbeeant.reqora.server.auth.JwtService;
import com.xbeeant.reqora.server.auth.LoginRateLimiter;
import com.xbeeant.reqora.server.auth.PrincipalLoader;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.common.JsonSupport;
import com.xbeeant.reqora.server.config.AppProperties;
import com.xbeeant.reqora.server.config.ConfigurationValidator;
import com.xbeeant.reqora.server.config.IdentityProperties;
import com.xbeeant.reqora.server.config.SecurityConfig;
import com.xbeeant.reqora.server.identity.IdentityService;
import com.xbeeant.reqora.server.identity.TrustedHeaderFilter;
import jakarta.servlet.Filter;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.security.web.SecurityFilterChain;

class InfrastructureTest {

    @Test
    void jsonSupportRoundTripsAndRejectsNonObjects() {
        String json = JsonSupport.stringify(Map.of("version", 1, "collections", List.of()));
        assertTrue(JsonSupport.isObject(json));
        assertEquals(1, JsonSupport.toMap(json).get("version"));
        assertFalse(JsonSupport.isObject("[1,2]"));
        assertFalse(JsonSupport.isObject("{broken"));
    }

    @Test
    void loginRateLimiterBlocksEleventhAttempt() {
        LoginRateLimiter limiter = new LoginRateLimiter();
        String key = "alice@127.0.0.1";
        for (int i = 0; i < 10; i++) {
            limiter.check(key);
        }
        BizException ex = assertThrows(BizException.class, () -> limiter.check(key));
        assertEquals(ErrorCode.RATE_LIMITED, ex.error());
        // A different principal has its own bucket.
        limiter.check("bob@127.0.0.1");
    }

    private static AppProperties properties(List<String> origins, Duration access, Duration refresh) {
        AppProperties properties = new AppProperties();
        properties.getSecurity().setJwtSecret("x".repeat(40));
        properties.getSecurity().setAccessTokenTtl(access);
        properties.getSecurity().setRefreshTokenTtl(refresh);
        properties.getCors().setAllowedOrigins(origins);
        return properties;
    }

    @Test
    void configurationValidatorRejectsWildcardCors() {
        AppProperties properties = properties(List.of("*"), Duration.ofMinutes(15), Duration.ofDays(7));
        assertThrows(IllegalStateException.class,
                () -> new ConfigurationValidator(properties).validate());
    }

    @Test
    void configurationValidatorRejectsBadTokenLifetimes() {
        AppProperties properties = properties(List.of("tauri://localhost"),
                Duration.ofMinutes(15), Duration.ofMinutes(10));
        assertThrows(IllegalStateException.class,
                () -> new ConfigurationValidator(properties).validate());
    }

    @Test
    void configurationValidatorAcceptsExplicitOrigins() {
        AppProperties properties = properties(
                List.of("tauri://localhost", "http://localhost:1420"),
                Duration.ofMinutes(15), Duration.ofDays(7));
        new ConfigurationValidator(properties).validate();
    }

    /**
     * Regression: Spring Security 7 rejects addFilterBefore(filter, X.class) when X
     * has no registered order yet. Custom filters must be anchored only after they
     * themselves have been added to the chain. Real filter instances are used (not
     * Mockito mocks) because the order registry is keyed by the actual class name.
     */
    @Test
    void securityFilterChainBuildsWithTrustedHeaderSsoBeforeJwt() {
        AppProperties appProperties = new AppProperties();
        appProperties.getCors().setAllowedOrigins(List.of("tauri://localhost"));
        PrincipalLoader principalLoader = Mockito.mock(PrincipalLoader.class);
        JwtAuthFilter jwtAuthFilter =
                new JwtAuthFilter(Mockito.mock(JwtService.class), principalLoader);
        TrustedHeaderFilter headerSsoFilter = new TrustedHeaderFilter(
                new IdentityProperties(), Mockito.mock(IdentityService.class), principalLoader);

        new WebApplicationContextRunner()
                .withUserConfiguration(SecurityConfig.class)
                .withBean(AppProperties.class, () -> appProperties)
                .withBean(JwtAuthFilter.class, () -> jwtAuthFilter)
                .withBean(TrustedHeaderFilter.class, () -> headerSsoFilter)
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    SecurityFilterChain chain = context.getBean(SecurityFilterChain.class);
                    List<Filter> filters = chain.getFilters();
                    assertThat(filters).contains(headerSsoFilter, jwtAuthFilter);
                    assertThat(filters.indexOf(headerSsoFilter))
                            .isLessThan(filters.indexOf(jwtAuthFilter));
                });
    }
}
