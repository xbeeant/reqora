package com.xbeeant.reqora.server.auth;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.xbeeant.reqora.server.config.AppProperties;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.stereotype.Service;

/** HS256 access tokens. Short-lived by design; refresh tokens are opaque and server-side. */
@Service
public class JwtService {

    private static final Base64.Encoder ENCODER = Base64.getUrlEncoder().withoutPadding();
    private static final Base64.Decoder DECODER = Base64.getUrlDecoder();
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final byte[] secret;
    private final Duration accessTtl;

    public JwtService(AppProperties properties) {
        this.secret = properties.getSecurity().getJwtSecret().getBytes(StandardCharsets.UTF_8);
        this.accessTtl = properties.getSecurity().getAccessTokenTtl();
    }

    public long accessTtlSeconds() {
        return accessTtl.getSeconds();
    }

    public String issue(long userId, String username) {
        try {
            long now = Instant.now().getEpochSecond();
            Map<String, Object> header = new LinkedHashMap<>();
            header.put("alg", "HS256");
            header.put("typ", "JWT");
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("sub", String.valueOf(userId));
            payload.put("usr", username);
            payload.put("typ", "access");
            payload.put("iat", now);
            payload.put("exp", now + accessTtl.getSeconds());
            payload.put("jti", UUID.randomUUID().toString());

            String signingInput = ENCODER.encodeToString(MAPPER.writeValueAsBytes(header))
                    + "."
                    + ENCODER.encodeToString(MAPPER.writeValueAsBytes(payload));
            return signingInput + "." + ENCODER.encodeToString(hmac(signingInput));
        } catch (Exception ex) {
            throw new IllegalStateException("JWT 签发失败", ex);
        }
    }

    public AccessClaims verify(String token) {
        try {
            String[] parts = token.split("\\.", -1);
            if (parts.length != 3) {
                throw new IllegalArgumentException("segments");
            }
            String signingInput = parts[0] + "." + parts[1];
            String expected = ENCODER.encodeToString(hmac(signingInput));
            if (!MessageDigest.isEqual(
                    expected.getBytes(StandardCharsets.US_ASCII),
                    parts[2].getBytes(StandardCharsets.US_ASCII))) {
                throw new IllegalArgumentException("signature");
            }
            JsonNode header = MAPPER.readTree(DECODER.decode(parts[0]));
            if (!"HS256".equals(header.path("alg").asText())) {
                throw new IllegalArgumentException("alg");
            }
            JsonNode payload = MAPPER.readTree(DECODER.decode(parts[1]));
            if (!"access".equals(payload.path("typ").asText())
                    || payload.path("exp").asLong() <= Instant.now().getEpochSecond()) {
                throw new IllegalArgumentException("claims");
            }
            return new AccessClaims(
                    Long.parseLong(payload.path("sub").asText()), payload.path("usr").asText());
        } catch (Exception ex) {
            throw new InvalidTokenException();
        }
    }

    private byte[] hmac(String input) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret, "HmacSHA256"));
        return mac.doFinal(input.getBytes(StandardCharsets.US_ASCII));
    }

    public record AccessClaims(long userId, String username) {}

    public static class InvalidTokenException extends RuntimeException {
        public InvalidTokenException() {
            super("invalid access token");
        }
    }
}
