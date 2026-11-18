package com.xbeeant.reqora.server.identity;

import com.fasterxml.jackson.databind.JsonNode;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.config.IdentityProperties;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Service;

/**
 * OIDC 1.0 Authorization Code + PKCE relying party, implemented with JDK
 * HttpClient/JCA only. Discovery, JWKS, ID-token claims and (optional) userinfo
 * are all verified here; the caller never sees an unverified identity.
 */
@Service
public class OidcService {

    public record Discovery(String issuer, String authorizationUri, String tokenUri,
                            String jwksUri, String userinfoUri) {}

    public record TokenBundle(String idToken, String accessToken, String tokenType) {}

    private final HttpClient http = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();
    private final Map<String, Discovery> discoveryCache = new ConcurrentHashMap<>();
    private final Map<String, CachedJwks> jwksCache = new ConcurrentHashMap<>();

    private record CachedJwks(List<JsonNode> keys, long fetchedAt) {}

    public Discovery discovery(String providerId, IdentityProperties.OidcProvider config) {
        return discoveryCache.computeIfAbsent(providerId, ignored -> loadDiscovery(config));
    }

    private Discovery loadDiscovery(IdentityProperties.OidcProvider config) {
        String issuer = trimSlash(config.getIssuer());
        String authorizationUri = config.getAuthorizationUri();
        String tokenUri = config.getTokenUri();
        String jwksUri = config.getJwksUri();
        String userinfoUri = config.getUserinfoUri();
        String discoveredIssuer = issuer;
        if (config.isDiscovery()) {
            JsonNode doc = getJson(issuer + "/.well-known/openid-configuration", config, null);
            discoveredIssuer = trimSlash(doc.path("issuer").asText(issuer));
            if (!discoveredIssuer.equals(issuer)) {
                throw new BizException(ErrorCode.BAD_REQUEST, "OIDC discovery 的 issuer 与配置不一致");
            }
            if (authorizationUri == null || authorizationUri.isBlank()) {
                authorizationUri = doc.path("authorization_endpoint").asText("");
            }
            if (tokenUri == null || tokenUri.isBlank()) {
                tokenUri = doc.path("token_endpoint").asText("");
            }
            if (jwksUri == null || jwksUri.isBlank()) {
                jwksUri = doc.path("jwks_uri").asText("");
            }
            if (userinfoUri == null || userinfoUri.isBlank()) {
                userinfoUri = doc.path("userinfo_endpoint").asText("");
            }
        }
        requireHttps(authorizationUri, "authorization_uri");
        requireHttps(tokenUri, "token_uri");
        requireHttps(jwksUri, "jwks_uri");
        if (userinfoUri != null && !userinfoUri.isBlank()) {
            requireHttps(userinfoUri, "userinfo_uri");
        }
        return new Discovery(discoveredIssuer, authorizationUri, tokenUri, jwksUri, userinfoUri);
    }

    public String authorizationUrl(String providerId, IdentityProperties.OidcProvider config,
                                   String state, String nonce, String codeChallenge,
                                   String redirectUri) {
        Discovery d = discovery(providerId, config);
        Map<String, String> params = new LinkedHashMap<>();
        params.put("client_id", config.getClientId());
        params.put("response_type", "code");
        params.put("scope", config.getScopes());
        params.put("redirect_uri", redirectUri);
        params.put("state", state);
        params.put("nonce", nonce);
        if (config.isPkce()) {
            params.put("code_challenge", codeChallenge);
            params.put("code_challenge_method", "S256");
        }
        return d.authorizationUri() + (d.authorizationUri().contains("?") ? "&" : "?") + form(params);
    }

    public TokenBundle exchange(String providerId, IdentityProperties.OidcProvider config,
                                String code, String verifier, String redirectUri) {
        Discovery d = discovery(providerId, config);
        Map<String, String> params = new LinkedHashMap<>();
        params.put("grant_type", "authorization_code");
        params.put("code", code);
        params.put("redirect_uri", redirectUri);
        params.put("client_id", config.getClientId());
        if (config.getClientSecret() != null && !config.getClientSecret().isBlank()) {
            params.put("client_secret", config.getClientSecret());
        }
        if (config.isPkce() && verifier != null) {
            params.put("code_verifier", verifier);
        }
        HttpRequest request = HttpRequest.newBuilder(URI.create(d.tokenUri()))
                .timeout(config.getTimeout())
                .header("Content-Type", "application/x-www-form-urlencoded")
                .header("Accept", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(form(params)))
                .build();
        JsonNode body = send(request, config, "token");
        String idToken = body.path("id_token").asText("");
        if (idToken.isBlank()) {
            throw new BizException(ErrorCode.BAD_REQUEST, "OIDC token 端点未返回 id_token");
        }
        return new TokenBundle(idToken, body.path("access_token").asText(""),
                body.path("token_type").asText("Bearer"));
    }

    public List<JsonNode> jwks(String providerId, IdentityProperties.OidcProvider config) {
        CachedJwks cached = jwksCache.get(providerId);
        long now = System.currentTimeMillis();
        if (cached != null && now - cached.fetchedAt() < 300_000L) {
            return cached.keys();
        }
        Discovery d = discovery(providerId, config);
        JsonNode doc = getJson(d.jwksUri(), config, null);
        List<JsonNode> keys = new ArrayList<>();
        for (JsonNode key : doc.path("keys")) {
            keys.add(key);
        }
        if (keys.isEmpty()) {
            throw new BizException(ErrorCode.BAD_REQUEST, "OIDC JWKS 为空");
        }
        jwksCache.put(providerId, new CachedJwks(List.copyOf(keys), now));
        return keys;
    }

    /** Signature + iss/aud/exp/iat/nonce. Azp is enforced for multi-audience responses. */
    public JsonNode verifyIdToken(String providerId, IdentityProperties.OidcProvider config,
                                  String idToken, String expectedNonce) {
        Discovery d = discovery(providerId, config);
        if (!IdentityCrypto.verifyJws(idToken, jwks(providerId, config), config.getClientSecret())) {
            throw new BizException(ErrorCode.UNAUTHENTICATED, "OIDC id_token 验签失败");
        }
        JsonNode header = IdentityCrypto.jwsHeader(idToken);
        String alg = header.path("alg").asText("");
        if (!"RS256".equals(alg) && !"ES256".equals(alg) && !"HS256".equals(alg)) {
            throw new BizException(ErrorCode.UNAUTHENTICATED, "不支持的 OIDC 签名算法：" + alg);
        }
        JsonNode claims = IdentityCrypto.jwsPayload(idToken);
        long now = Instant.now().getEpochSecond();
        long skew = config.getClockSkew().getSeconds();
        if (!d.issuer().equals(claims.path("iss").asText(""))) {
            throw new BizException(ErrorCode.UNAUTHENTICATED, "OIDC issuer 不匹配");
        }
        String clientId = config.getClientId();
        boolean audienceMatch = false;
        for (JsonNode aud : claims.path("aud")) {
            if (clientId.equals(aud.asText(""))) {
                audienceMatch = true;
            }
        }
        if (!audienceMatch && !clientId.equals(claims.path("aud").asText(""))) {
            throw new BizException(ErrorCode.UNAUTHENTICATED, "OIDC aud 不匹配");
        }
        if (claims.has("azp") && !clientId.equals(claims.path("azp").asText(""))) {
            throw new BizException(ErrorCode.UNAUTHENTICATED, "OIDC azp 不匹配");
        }
        if (claims.path("exp").asLong(0) <= now - skew) {
            throw new BizException(ErrorCode.UNAUTHENTICATED, "OIDC id_token 已过期");
        }
        if (claims.path("iat").asLong(0) > now + skew) {
            throw new BizException(ErrorCode.UNAUTHENTICATED, "OIDC id_token 签发时间异常");
        }
        if (expectedNonce != null && !expectedNonce.equals(claims.path("nonce").asText(""))) {
            throw new BizException(ErrorCode.UNAUTHENTICATED, "OIDC nonce 不匹配");
        }
        if (claims.path("sub").asText("").isBlank()) {
            throw new BizException(ErrorCode.UNAUTHENTICATED, "OIDC id_token 缺少 sub");
        }
        return claims;
    }

    /** Optional enrichment; a failing userinfo endpoint must not fail a verified login. */
    public JsonNode userinfo(String providerId, IdentityProperties.OidcProvider config,
                             String accessToken) {
        try {
            Discovery d = discovery(providerId, config);
            if (d.userinfoUri() == null || d.userinfoUri().isBlank()
                    || accessToken == null || accessToken.isBlank()) {
                return null;
            }
            return getJson(d.userinfoUri(), config, accessToken);
        } catch (Exception ex) {
            return null;
        }
    }

    private JsonNode getJson(String uri, IdentityProperties.OidcProvider config, String bearer) {
        requireHttps(uri, "OIDC endpoint");
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(uri))
                .timeout(config.getTimeout())
                .header("Accept", "application/json");
        if (bearer != null) {
            builder.header("Authorization", "Bearer " + bearer);
        }
        return send(builder.GET().build(), config, uri);
    }

    private JsonNode send(HttpRequest request, IdentityProperties.OidcProvider config, String label) {
        try {
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new BizException(ErrorCode.UNAUTHENTICATED,
                        "OIDC 端点返回 HTTP " + response.statusCode() + "（" + label + "）");
            }
            return IdentityCrypto.JSON.readTree(response.body());
        } catch (BizException ex) {
            throw ex;
        } catch (Exception ex) {
            throw new BizException(ErrorCode.UNAUTHENTICATED, "OIDC 端点不可达：" + label);
        }
    }

    public static void requireHttps(String uri, String label) {
        if (uri == null || uri.isBlank()) {
            throw new BizException(ErrorCode.BAD_REQUEST, "缺少 " + label);
        }
        URI parsed;
        try {
            parsed = URI.create(uri);
        } catch (IllegalArgumentException ex) {
            throw new BizException(ErrorCode.BAD_REQUEST, label + " 不是合法 URL");
        }
        if (!"https".equalsIgnoreCase(parsed.getScheme()) || parsed.getHost() == null) {
            throw new BizException(ErrorCode.BAD_REQUEST, label + " 必须是 HTTPS 绝对地址");
        }
    }

    private static String trimSlash(String issuer) {
        if (issuer == null) {
            return "";
        }
        return issuer.endsWith("/") ? issuer.substring(0, issuer.length() - 1) : issuer;
    }

    public static String form(Map<String, String> params) {
        StringBuilder out = new StringBuilder();
        for (Map.Entry<String, String> entry : params.entrySet()) {
            if (out.length() > 0) {
                out.append('&');
            }
            out.append(URLEncoder.encode(entry.getKey(), StandardCharsets.UTF_8))
                    .append('=')
                    .append(URLEncoder.encode(entry.getValue(), StandardCharsets.UTF_8));
        }
        return out.toString();
    }
}
