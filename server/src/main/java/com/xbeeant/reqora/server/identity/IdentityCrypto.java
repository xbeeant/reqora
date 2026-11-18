package com.xbeeant.reqora.server.identity;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.ByteArrayInputStream;
import java.math.BigInteger;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.security.spec.RSAPublicKeySpec;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Small, dependency-free crypto helpers shared by OIDC / SAML / header SSO / SCIM / PAT. */
public final class IdentityCrypto {

    public static final ObjectMapper JSON = new ObjectMapper();
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Base64.Encoder B64 = Base64.getUrlEncoder().withoutPadding();
    private static final Base64.Decoder B64D = Base64.getUrlDecoder();

    private IdentityCrypto() {}

    public static String randomToken(int bytes) {
        byte[] raw = new byte[bytes];
        RANDOM.nextBytes(raw);
        return B64.encodeToString(raw);
    }

    public static String sha256Hex(String value) {
        return sha256Hex(value.getBytes(StandardCharsets.UTF_8));
    }

    public static String sha256Hex(byte[] value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
        } catch (Exception ex) {
            throw new IllegalStateException("SHA-256 unavailable", ex);
        }
    }

    public static String b64Url(byte[] raw) {
        return B64.encodeToString(raw);
    }

    public static byte[] b64UrlDecode(String value) {
        return B64D.decode(value);
    }

    /** RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))). */
    public static String pkceChallenge(String verifier) {
        return b64Url(sha256(verifier.getBytes(StandardCharsets.US_ASCII)));
    }

    public static byte[] sha256(byte[] value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value);
        } catch (Exception ex) {
            throw new IllegalStateException("SHA-256 unavailable", ex);
        }
    }

    public static String hmacSha256Hex(String secret, String message) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(
                    mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception ex) {
            throw new IllegalStateException("HMAC-SHA256 unavailable", ex);
        }
    }

    public static boolean constantTimeEquals(String left, String right) {
        if (left == null || right == null) {
            return false;
        }
        return MessageDigest.isEqual(
                left.getBytes(StandardCharsets.UTF_8), right.getBytes(StandardCharsets.UTF_8));
    }

    /** Unverified JWS payload, used only to read kid/nonce before signature validation. */
    public static JsonNode jwsPayload(String compact) {
        String[] parts = compact.split("\\.", -1);
        if (parts.length != 3) {
            throw new IllegalArgumentException("JWS 必须由三段组成");
        }
        try {
            return JSON.readTree(B64D.decode(parts[1]));
        } catch (Exception ex) {
            throw new IllegalArgumentException("JWS payload 无法解析", ex);
        }
    }

    public static JsonNode jwsHeader(String compact) {
        String[] parts = compact.split("\\.", -1);
        if (parts.length != 3) {
            throw new IllegalArgumentException("JWS 必须由三段组成");
        }
        try {
            return JSON.readTree(B64D.decode(parts[0]));
        } catch (Exception ex) {
            throw new IllegalArgumentException("JWS header 无法解析", ex);
        }
    }

    /**
     * Verify a compact JWS. Supported algorithms: RS256 / PS256-free RSA,
     * ES256 (P-256) and HS256 (only for providers that sign ID tokens with the
     * client secret). Rejects alg=none and any algorithm/key mismatch.
     */
    public static boolean verifyJws(String compact, List<JsonNode> jwks, String clientSecret) {
        String[] parts = compact.split("\\.", -1);
        if (parts.length != 3) {
            return false;
        }
        String alg = jwsHeader(compact).path("alg").asText("");
        if ("none".equalsIgnoreCase(alg)) {
            return false;
        }
        byte[] signingInput = (parts[0] + "." + parts[1]).getBytes(StandardCharsets.US_ASCII);
        byte[] signature;
        try {
            signature = B64D.decode(parts[2]);
        } catch (IllegalArgumentException ex) {
            return false;
        }
        if ("HS256".equals(alg)) {
            if (clientSecret == null || clientSecret.isBlank()) {
                return false;
            }
            try {
                String expected = b64Url(hmac(clientSecret, signingInput));
                return constantTimeEquals(expected, parts[2]);
            } catch (Exception ex) {
                return false;
            }
        }
        String kid = jwsHeader(compact).path("kid").asText("");
        for (JsonNode jwk : jwks) {
            if (!kid.isBlank() && !kid.equals(jwk.path("kid").asText(""))) {
                continue;
            }
            try {
                if (verifyWithKey(alg, jwk, signingInput, signature)) {
                    return true;
                }
            } catch (Exception ignored) {
                // Try the next key; JWKS rotation routinely contains stale keys.
            }
        }
        return false;
    }

    private static boolean verifyWithKey(String alg, JsonNode jwk, byte[] signingInput, byte[] signature)
            throws Exception {
        String kty = jwk.path("kty").asText("");
        String javaAlg;
        PublicKey key;
        byte[] sig = signature;
        if ("RSA".equals(kty) && "RS256".equals(alg)) {
            javaAlg = "SHA256withRSA";
            BigInteger modulus = new BigInteger(1, B64D.decode(jwk.path("n").asText()));
            BigInteger exponent = new BigInteger(1, B64D.decode(jwk.path("e").asText()));
            key = KeyFactory.getInstance("RSA")
                    .generatePublic(new RSAPublicKeySpec(modulus, exponent));
        } else if ("EC".equals(kty) && "ES256".equals(alg)) {
            javaAlg = "SHA256withECDSA";
            AlgorithmParameters params = AlgorithmParameters.getInstance("EC");
            params.init(new ECGenParameterSpec("secp256r1"));
            ECParameterSpec spec = params.getParameterSpec(ECParameterSpec.class);
            BigInteger x = new BigInteger(1, B64D.decode(jwk.path("x").asText()));
            BigInteger y = new BigInteger(1, B64D.decode(jwk.path("y").asText()));
            key = KeyFactory.getInstance("EC")
                    .generatePublic(new ECPublicKeySpec(new ECPoint(x, y), spec));
            sig = derFromConcatenatedRs(signature);
        } else {
            return false;
        }
        Signature verifier = Signature.getInstance(javaAlg);
        verifier.initVerify(key);
        verifier.update(signingInput);
        return verifier.verify(sig);
    }

    /** JWS ES256 uses raw R||S; Java's provider expects an ASN.1 DER SEQUENCE. */
    public static byte[] derFromConcatenatedRs(byte[] raw) {
        if (raw.length != 64) {
            throw new IllegalArgumentException("ES256 签名必须是 64 字节");
        }
        byte[] r = trimLeadingZero(java.util.Arrays.copyOfRange(raw, 0, 32));
        byte[] s = trimLeadingZero(java.util.Arrays.copyOfRange(raw, 32, 64));
        byte[] body = new byte[2 + r.length + 2 + s.length];
        int i = 0;
        body[i++] = 0x02;
        body[i++] = (byte) r.length;
        System.arraycopy(r, 0, body, i, r.length);
        i += r.length;
        body[i++] = 0x02;
        body[i++] = (byte) s.length;
        System.arraycopy(s, 0, body, i, s.length);
        byte[] out = new byte[2 + body.length];
        out[0] = 0x30;
        out[1] = (byte) body.length;
        System.arraycopy(body, 0, out, 2, body.length);
        return out;
    }

    private static byte[] trimLeadingZero(byte[] value) {
        int i = 0;
        while (i < value.length - 1 && value[i] == 0 && (value[i + 1] & 0x80) == 0) {
            i++;
        }
        byte[] out = java.util.Arrays.copyOfRange(value, i, value.length);
        if ((out[0] & 0x80) != 0) {
            byte[] padded = new byte[out.length + 1];
            System.arraycopy(out, 0, padded, 1, out.length);
            return padded;
        }
        return out;
    }

    private static byte[] hmac(String secret, byte[] input) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return mac.doFinal(input);
    }

    /** Accepts bare base64 DER or a PEM block with/without headers. */
    public static X509Certificate certificate(String value) {
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("SAML IdP 签名证书未配置");
        }
        String normalized = value
                .replace("-----BEGIN CERTIFICATE-----", "")
                .replace("-----END CERTIFICATE-----", "")
                .replaceAll("\\s", "");
        try {
            byte[] der = Base64.getDecoder().decode(normalized);
            return (X509Certificate) CertificateFactory.getInstance("X.509")
                    .generateCertificate(new ByteArrayInputStream(der));
        } catch (Exception ex) {
            throw new IllegalStateException("SAML IdP 签名证书无法解析", ex);
        }
    }

    /** IPv4 / IPv6 CIDR membership, used by trusted-header SSO. */
    public static boolean cidrContains(String cidr, String ip) {
        try {
            int slash = cidr.indexOf('/');
            if (slash < 0) {
                return cidr.trim().equals(ip);
            }
            byte[] network = InetAddress.getByName(cidr.substring(0, slash).trim()).getAddress();
            byte[] candidate = InetAddress.getByName(ip).getAddress();
            if (network.length != candidate.length) {
                return false;
            }
            int prefix = Integer.parseInt(cidr.substring(slash + 1).trim());
            prefix = Math.max(0, Math.min(prefix, network.length * 8));
            int wholeBytes = prefix / 8;
            for (int i = 0; i < wholeBytes; i++) {
                if (network[i] != candidate[i]) {
                    return false;
                }
            }
            int remaining = prefix % 8;
            if (remaining == 0) {
                return true;
            }
            int mask = 0xFF << (8 - remaining) & 0xFF;
            return (network[wholeBytes] & mask) == (candidate[wholeBytes] & mask);
        } catch (Exception ex) {
            return false;
        }
    }
}
