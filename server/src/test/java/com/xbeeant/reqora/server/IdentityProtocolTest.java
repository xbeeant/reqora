package com.xbeeant.reqora.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.xbeeant.reqora.server.audit.AuditLogEntity;
import com.xbeeant.reqora.server.audit.AuditRetentionService;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.config.IdentityProperties;
import com.xbeeant.reqora.server.identity.IdentityCrypto;
import com.xbeeant.reqora.server.identity.IdentityService;
import com.xbeeant.reqora.server.identity.OidcService;
import com.xbeeant.reqora.server.identity.SamlService;
import com.xbeeant.reqora.server.identity.TrustedHeaderFilter;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.time.Instant;
import java.time.LocalDateTime;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Pure-protocol tests for the dependency-free identity layer. No Spring
 * context, no MySQL: everything here is JCA / JDK XML / string handling.
 */
class IdentityProtocolTest {

    private static final Base64.Encoder B64 = Base64.getUrlEncoder().withoutPadding();

    private static String b64(byte[] raw) {
        return B64.encodeToString(raw);
    }

    private static byte[] unsigned(BigInteger value) {
        byte[] bytes = value.toByteArray();
        if (bytes.length > 1 && bytes[0] == 0) {
            byte[] out = new byte[bytes.length - 1];
            System.arraycopy(bytes, 1, out, 0, out.length);
            return out;
        }
        return bytes;
    }

    // ------------------------------------------------------------------- PKCE / hashes ----

    @Test
    void pkceChallengeMatchesRfc7636Vector() {
        // RFC 7636 Appendix B reference vector.
        String verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                IdentityCrypto.pkceChallenge(verifier));
        assertEquals(43, IdentityCrypto.pkceChallenge(verifier).length());
    }

    @Test
    void hashesAndConstantTimeCompare() {
        assertEquals(64, IdentityCrypto.sha256Hex("reqora").length());
        String mac = IdentityCrypto.hmacSha256Hex("secret", "message");
        assertEquals(mac, IdentityCrypto.hmacSha256Hex("secret", "message"));
        assertFalse(mac.equals(IdentityCrypto.hmacSha256Hex("secret", "message!")));
        assertTrue(IdentityCrypto.constantTimeEquals(mac, mac));
        assertFalse(IdentityCrypto.constantTimeEquals(mac, null));
    }

    @Test
    void trustedProxyCidrMatching() {
        assertTrue(IdentityCrypto.cidrContains("127.0.0.1/32", "127.0.0.1"));
        assertTrue(IdentityCrypto.cidrContains("10.20.0.0/16", "10.20.9.7"));
        assertFalse(IdentityCrypto.cidrContains("10.20.0.0/16", "10.21.0.1"));
        assertTrue(IdentityCrypto.cidrContains("::1/128", "::1"));
        assertFalse(IdentityCrypto.cidrContains("127.0.0.0/8", "::1"));
        assertFalse(IdentityCrypto.cidrContains("not-a-cidr", "127.0.0.1"));
    }

    // ------------------------------------------------------------------------ JWS / JWKS ----

    @Test
    void rsaJwksVerificationAcceptsOnlyUntamperedRs256() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        KeyPair pair = generator.generateKeyPair();
        RSAPublicKey pub = (RSAPublicKey) pair.getPublic();
        JsonNode jwk = IdentityCrypto.JSON.readTree("{" + "\"kty\":\"RSA\",\"kid\":\"k1\","
                + "\"n\":\"" + b64(unsigned(pub.getModulus())) + "\","
                + "\"e\":\"" + b64(unsigned(pub.getPublicExponent())) + "\"}");

        String header = b64("{\"alg\":\"RS256\",\"typ\":\"JWT\",\"kid\":\"k1\"}"
                .getBytes(StandardCharsets.UTF_8));
        String payload = b64("{\"sub\":\"user-1\"}".getBytes(StandardCharsets.UTF_8));
        String input = header + "." + payload;
        Signature signer = Signature.getInstance("SHA256withRSA");
        signer.initSign(pair.getPrivate());
        signer.update(input.getBytes(StandardCharsets.US_ASCII));
        String jws = input + "." + b64(signer.sign());

        assertTrue(IdentityCrypto.verifyJws(jws, List.of(jwk), null));
        String signature = jws.substring(jws.lastIndexOf('.') + 1);
        String tampered = header + "."
                + b64("{\"sub\":\"user-2\"}".getBytes(StandardCharsets.UTF_8))
                + "." + signature;
        assertFalse(IdentityCrypto.verifyJws(tampered, List.of(jwk), null),
                "篡改 payload 后同一签名必须验不过");
        assertFalse(IdentityCrypto.verifyJws(jws, List.of(), null));
        String none = b64("{\"alg\":\"none\"}".getBytes(StandardCharsets.UTF_8)) + "." + payload + ".";
        assertFalse(IdentityCrypto.verifyJws(none, List.of(jwk), null));
    }

    @Test
    void es256JwsVerifiesWithP256Jwk() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair pair = generator.generateKeyPair();
        ECPublicKey pub = (ECPublicKey) pair.getPublic();
        JsonNode jwk = IdentityCrypto.JSON.readTree("{" + "\"kty\":\"EC\",\"kid\":\"ec1\","
                + "\"x\":\"" + b64(unsigned(pub.getW().getAffineX())) + "\","
                + "\"y\":\"" + b64(unsigned(pub.getW().getAffineY())) + "\"}");
        String header = b64("{\"alg\":\"ES256\",\"kid\":\"ec1\"}".getBytes(StandardCharsets.UTF_8));
        String payload = b64("{\"iss\":\"https://idp.example.com\"}".getBytes(StandardCharsets.UTF_8));
        String input = header + "." + payload;
        Signature signer = Signature.getInstance("SHA256withECDSA");
        signer.initSign(pair.getPrivate());
        signer.update(input.getBytes(StandardCharsets.US_ASCII));
        byte[] der = signer.sign();
        byte[] raw = derToConcatenatedRs(der);
        String jws = input + "." + b64(raw);
        assertTrue(IdentityCrypto.verifyJws(jws, List.of(jwk), null));
        assertEquals(0x30, IdentityCrypto.derFromConcatenatedRs(raw)[0] & 0xff);
    }

    /** Minimal DER SEQUENCE(INTEGER r, INTEGER s) -> 64-byte raw R||S. */
    private static byte[] derToConcatenatedRs(byte[] der) {
        int i = 0;
        assertEquals(0x30, der[i++] & 0xff);
        i++; // length (single byte for P-256)
        byte[] out = new byte[64];
        for (int part = 0; part < 2; part++) {
            assertEquals(0x02, der[i++] & 0xff);
            int len = der[i++] & 0xff;
            byte[] value = new byte[len];
            System.arraycopy(der, i, value, 0, len);
            i += len;
            if (value.length > 32 && value[0] == 0) {
                System.arraycopy(value, 1, out, part * 32, 32);
            } else {
                System.arraycopy(value, 0, out, part * 32 + (32 - value.length), value.length);
            }
        }
        return out;
    }

    // ------------------------------------------------------------------- trusted header ----

    @Test
    void trustedHeaderHmacIsBoundToEverySignedField() {
        IdentityProperties.Header config = new IdentityProperties.Header();
        config.setEnabled(true);
        config.setHeaderSecret("unit-test-secret-0123456789");
        long now = Instant.now().getEpochSecond();
        String signature = IdentityCrypto.hmacSha256Hex(config.getHeaderSecret(),
                TrustedHeaderFilter.canonical(now, "alice", "alice@example.com", "Alice", "devs"));
        assertTrue(TrustedHeaderFilter.verify(config, "127.0.0.1", now,
                "alice", "alice@example.com", "Alice", "devs", signature));
        assertFalse(TrustedHeaderFilter.verify(config, "127.0.0.1", now,
                "admin", "alice@example.com", "Alice", "devs", signature));
        assertFalse(TrustedHeaderFilter.verify(config, "203.0.113.9", now,
                "alice", "alice@example.com", "Alice", "devs", signature));
        assertFalse(TrustedHeaderFilter.verify(config, "127.0.0.1", now - 3600,
                "alice", "alice@example.com", "Alice", "devs", signature));
        assertEquals("1\nalice\n\n\n", TrustedHeaderFilter.canonical(1, "alice", null, null, null));
    }

    // ------------------------------------------------------------------------- OIDC / SAML ----

    @Test
    void oidcFormEncodingAndHttpsEnforcement() {
        String form = OidcService.form(Map.of("code", "a b&c", "redirect_uri", "https://x/y"));
        assertTrue(form.contains("code=a+b%26c"));
        assertTrue(form.contains("redirect_uri=https%3A%2F%2Fx%2Fy"));
        OidcService.requireHttps("https://idp.example.com/token", "token_uri");
        assertThrows(BizException.class,
                () -> OidcService.requireHttps("http://idp.example.com/token", "token_uri"));
        assertThrows(BizException.class,
                () -> OidcService.requireHttps("https:///token", "token_uri"));
    }

    @Test
    void samlAuthnRequestAndInResponseToLookup() {
        IdentityProperties.SamlProvider config = new IdentityProperties.SamlProvider();
        config.setEntityId("https://collab.example.com/saml/metadata");
        config.setSsoUrl("https://idp.example.com/sso");
        SamlService.StartResult start = new SamlService().start("entra", config,
                "https://collab.example.com/api/v1/auth/sso/saml/entra/acs");
        assertTrue(start.redirectUrl().contains("SAMLRequest="));
        assertTrue(start.redirectUrl().contains("RelayState=entra"));
        assertNotNull(start.requestId());
        assertTrue(start.requestId().startsWith("_"));

        String xml = "<samlp:Response xmlns:samlp=\"urn:oasis:names:tc:SAML:2.0:protocol\" "
                + "ID=\"_resp1\" InResponseTo=\"" + start.requestId() + "\"/>";
        String encoded = Base64.getEncoder().encodeToString(xml.getBytes(StandardCharsets.UTF_8));
        assertEquals(start.requestId(), SamlService.inResponseTo(encoded));
    }

    // ------------------------------------------------------------------------ audit export ----

    @Test
    void auditExportEscapesCsvAndProducesJsonl() {
        AuditRetentionService service = new AuditRetentionService(null, null, null);
        AuditLogEntity row = new AuditLogEntity();
        row.setId(7L);
        row.setAction("scim.user.create");
        row.setActorId(1L);
        row.setActorName("alice, \"admin\"");
        row.setProvider("scim");
        row.setTargetType("user");
        row.setTargetId("7");
        row.setDetail("line1\nline2");
        row.setCreatedAt(LocalDateTime.of(2026, 11, 14, 8, 30));
        row.setLegalHold(0);
        List<AuditLogEntity> rows = List.of(row);

        String csv = service.export("csv", rows);
        assertTrue(csv.contains("\"alice, \"\"admin\"\"\""));
        assertTrue(csv.contains("prevHash,entryHash,legalHold"));
        String jsonl = service.export("jsonl", rows);
        assertTrue(jsonl.contains("\"action\":\"scim.user.create\""));
        assertTrue(jsonl.endsWith("\n"));
    }

    @Test
    void identityIntegrationIsOffByDefault() {
        IdentityProperties properties = new IdentityProperties();
        IdentityService service = new IdentityService(
                properties, null, null, null, null, null, null, null, null);
        service.validate(); // must not throw with the stock configuration
        Map<String, Object> capabilities = service.capabilityMap();
        assertEquals(Boolean.FALSE, capabilities.get("enabled"));
        @SuppressWarnings("unchecked")
        List<IdentityService.ProviderView> methods =
                (List<IdentityService.ProviderView>) capabilities.get("methods");
        assertEquals(1, methods.size());
        assertEquals("local", methods.get(0).type());
    }
}
