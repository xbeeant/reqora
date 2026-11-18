package com.xbeeant.reqora.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.xbeeant.reqora.server.auth.JwtService;
import com.xbeeant.reqora.server.config.AppProperties;
import java.time.Duration;
import org.junit.jupiter.api.Test;

class JwtServiceTest {

    private static JwtService service(Duration ttl) {
        AppProperties properties = new AppProperties();
        properties.getSecurity().setJwtSecret("test-only-secret-that-is-long-enough-1234567890");
        properties.getSecurity().setAccessTokenTtl(ttl);
        properties.getSecurity().setRefreshTokenTtl(Duration.ofDays(7));
        return new JwtService(properties);
    }

    @Test
    void issuesAndVerifiesAccessToken() {
        JwtService jwt = service(Duration.ofMinutes(15));
        String token = jwt.issue(42L, "alice");
        JwtService.AccessClaims claims = jwt.verify(token);
        assertEquals(42L, claims.userId());
        assertEquals("alice", claims.username());
        assertEquals(3, token.split("\\.", -1).length);
    }

    @Test
    void rejectsTamperedSignatureAndExpiredToken() {
        JwtService jwt = service(Duration.ofMinutes(15));
        String token = jwt.issue(7L, "bob");
        String tampered = token.substring(0, token.length() - 2) + "aa";
        assertThrows(JwtService.InvalidTokenException.class, () -> jwt.verify(tampered));
        assertThrows(JwtService.InvalidTokenException.class, () -> jwt.verify("not-a-jwt"));

        JwtService expired = service(Duration.ofSeconds(-1));
        assertThrows(JwtService.InvalidTokenException.class,
                () -> expired.verify(expired.issue(7L, "bob")));
    }

    @Test
    void differentSecretsCannotValidateEachOtherTokens() {
        AppProperties first = new AppProperties();
        first.getSecurity().setJwtSecret("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        AppProperties second = new AppProperties();
        second.getSecurity().setJwtSecret("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        String token = new JwtService(first).issue(1L, "x");
        assertThrows(JwtService.InvalidTokenException.class,
                () -> new JwtService(second).verify(token));
    }
}
