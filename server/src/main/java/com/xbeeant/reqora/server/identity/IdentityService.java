package com.xbeeant.reqora.server.identity;

import com.fasterxml.jackson.databind.JsonNode;
import com.xbeeant.reqora.server.audit.AuditService;
import com.xbeeant.reqora.server.auth.AuthDtos;
import com.xbeeant.reqora.server.auth.AuthService;
import com.xbeeant.reqora.server.auth.PrincipalLoader;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.config.IdentityProperties;
import com.xbeeant.reqora.server.user.UserEntity;
import jakarta.annotation.PostConstruct;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

/** Orchestrates every external login method and the single account-resolution policy. */
@Service
public class IdentityService {

    private static final Logger log = LoggerFactory.getLogger(IdentityService.class);

    public record ProviderView(String id, String type, String label, String startPath) {}

    public record StartResult(String authorizationUrl, String state, String expiresAt,
                              String requestId) {}

    private final IdentityProperties properties;
    private final IdentityStore store;
    private final OidcService oidcService;
    private final SamlService samlService;
    private final LdapService ldapService;
    private final AuthService authService;
    private final PrincipalLoader principalLoader;
    private final PasswordEncoder passwordEncoder;
    private final AuditService auditService;

    public IdentityService(IdentityProperties properties, IdentityStore store,
                           OidcService oidcService, SamlService samlService, LdapService ldapService,
                           AuthService authService, PrincipalLoader principalLoader,
                           PasswordEncoder passwordEncoder, AuditService auditService) {
        this.properties = properties;
        this.store = store;
        this.oidcService = oidcService;
        this.samlService = samlService;
        this.ldapService = ldapService;
        this.authService = authService;
        this.principalLoader = principalLoader;
        this.passwordEncoder = passwordEncoder;
        this.auditService = auditService;
    }

    /** Fail fast on half-configured identity providers; never silently degrade. */
    @PostConstruct
    public void validate() {
        if (!properties.isEnabled()) {
            log.info("external identity integration is disabled (REQORA_IDENTITY_ENABLED=false)");
            return;
        }
        if (properties.getPublicBaseUrl() == null || properties.getPublicBaseUrl().isBlank()) {
            throw new IllegalStateException("启用外部身份集成必须配置 REQORA_IDENTITY_PUBLIC_BASE_URL");
        }
        for (Map.Entry<String, IdentityProperties.OidcProvider> entry
                : properties.getOidc().getProviders().entrySet()) {
            IdentityProperties.OidcProvider provider = entry.getValue();
            if (!provider.isEnabled()) {
                continue;
            }
            require(entry.getKey(), "issuer", provider.getIssuer());
            require(entry.getKey(), "clientId", provider.getClientId());
            OidcService.requireHttps(provider.getIssuer(), "OIDC issuer");
            for (String override : List.of(provider.getAuthorizationUri(), provider.getTokenUri(),
                    provider.getJwksUri(), provider.getUserinfoUri())) {
                if (override != null && !override.isBlank()) {
                    OidcService.requireHttps(override, "OIDC endpoint");
                }
            }
        }
        for (Map.Entry<String, IdentityProperties.SamlProvider> entry
                : properties.getSaml().getProviders().entrySet()) {
            IdentityProperties.SamlProvider provider = entry.getValue();
            if (!provider.isEnabled()) {
                continue;
            }
            require(entry.getKey(), "entityId", provider.getEntityId());
            require(entry.getKey(), "idpEntityId", provider.getIdpEntityId());
            require(entry.getKey(), "ssoUrl", provider.getSsoUrl());
            require(entry.getKey(), "certificate", provider.getCertificate());
            OidcService.requireHttps(provider.getSsoUrl(), "SAML SSO URL");
            IdentityCrypto.certificate(provider.getCertificate());
        }
        IdentityProperties.Header header = properties.getHeader();
        if (header.isEnabled()) {
            if (header.getHeaderSecret() == null || header.getHeaderSecret().length() < 16) {
                throw new IllegalStateException("可信头 SSO 的 HMAC 密钥至少 16 个字符");
            }
            if (header.getTrustedProxies().isEmpty()
                    || header.getTrustedProxies().stream().anyMatch(c -> c.contains("0.0.0.0/0"))) {
                throw new IllegalStateException("可信头 SSO 必须配置具体代理 CIDR，禁止 0.0.0.0/0");
            }
        }
        if (properties.getLdap().isEnabled()) {
            require("ldap", "url", properties.getLdap().getUrl());
            if (properties.getLdap().getUrl().startsWith("ldap://")) {
                log.warn("LDAP 使用明文 ldap://，生产环境请改用 ldaps://");
            }
        }
        if (properties.getScim().isEnabled() && properties.getScim().getTokenHashes().isEmpty()) {
            throw new IllegalStateException("启用 SCIM 必须配置 tokenHashes（令牌的 SHA-256 摘要）");
        }
        log.info("external identity integration enabled: oidc={}, saml={}, ldap={}, header={}, scim={}, pat={}",
                properties.getOidc().getProviders().size(), properties.getSaml().getProviders().size(),
                properties.getLdap().isEnabled(), header.isEnabled(),
                properties.getScim().isEnabled(), properties.getPat().isEnabled());
    }

    private static void require(String provider, String field, String value) {
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("身份提供者 " + provider + " 缺少配置：" + field);
        }
    }

    public List<ProviderView> providers() {
        List<ProviderView> out = new ArrayList<>();
        out.add(new ProviderView("local", "local", "本地账号口令", "/api/v1/auth/login"));
        if (!properties.isEnabled()) {
            return out;
        }
        for (Map.Entry<String, IdentityProperties.OidcProvider> entry
                : properties.getOidc().getProviders().entrySet()) {
            if (entry.getValue().isEnabled()) {
                out.add(new ProviderView(entry.getKey(), "oidc",
                        label(entry.getValue().getLabel(), entry.getKey()),
                        "/api/v1/auth/sso/oidc/start"));
            }
        }
        for (Map.Entry<String, IdentityProperties.SamlProvider> entry
                : properties.getSaml().getProviders().entrySet()) {
            if (entry.getValue().isEnabled()) {
                out.add(new ProviderView(entry.getKey(), "saml",
                        label(entry.getValue().getLabel(), entry.getKey()),
                        "/api/v1/auth/sso/saml/" + entry.getKey() + "/start"));
            }
        }
        if (properties.getLdap().isEnabled()) {
            out.add(new ProviderView("ldap", "ldap", "LDAP / AD", "/api/v1/auth/sso/ldap"));
        }
        if (properties.getHeader().isEnabled()) {
            out.add(new ProviderView("header", "header", "反向代理可信头", "/api/v1/auth/sso/header"));
        }
        if (properties.getPat().isEnabled()) {
            out.add(new ProviderView("pat", "pat", "个人访问令牌（CLI / CI）",
                    "/api/v1/auth/pat/exchange"));
        }
        return out;
    }

    private static String label(String configured, String id) {
        return configured == null || configured.isBlank() ? id : configured;
    }

    // ---------------------------------------------------------------------------- OIDC ----

    public StartResult startOidc(String providerId, String redirectUri) {
        IdentityProperties.OidcProvider config = oidcProvider(providerId);
        String state = IdentityCrypto.randomToken(32);
        String nonce = IdentityCrypto.randomToken(24);
        String verifier = IdentityCrypto.randomToken(32);
        String effectiveRedirect = redirect(redirectUri, config.getRedirectUri(),
                "/sso/callback.html");
        LocalDateTime expiresAt = LocalDateTime.now().plus(properties.getSessionTtl());
        store.saveSession(IdentityCrypto.sha256Hex(state), providerId, "oidc", effectiveRedirect,
                verifier, nonce, null, expiresAt);
        store.purgeExpiredSessions();
        String url = oidcService.authorizationUrl(providerId, config, state, nonce,
                IdentityCrypto.pkceChallenge(verifier), effectiveRedirect);
        return new StartResult(url, state, expiresAt.toString(), null);
    }

    public AuthDtos.TokenResponse callbackOidc(String providerId, String code, String state,
                                               String redirectUri) {
        IdentityProperties.OidcProvider config = oidcProvider(providerId);
        IdentityStore.SsoSession session = store.consumeSession(IdentityCrypto.sha256Hex(state));
        if (session == null || !"oidc".equals(session.providerType())
                || !providerId.equals(session.providerId())) {
            throw new BizException(ErrorCode.UNAUTHENTICATED, "SSO state 无效、已使用或已过期");
        }
        String effectiveRedirect = session.redirectUri();
        if (redirectUri != null && !redirectUri.isBlank() && !redirectUri.equals(effectiveRedirect)) {
            throw new BizException(ErrorCode.BAD_REQUEST, "redirectUri 必须与 start 时一致");
        }
        OidcService.TokenBundle bundle = oidcService.exchange(
                providerId, config, code, session.codeVerifier(), effectiveRedirect);
        JsonNode claims = oidcService.verifyIdToken(providerId, config,
                bundle.idToken(), session.nonce());
        JsonNode userinfo = oidcService.userinfo(providerId, config, bundle.accessToken());
        String subject = text(claims, "sub");
        String username = text(claims, config.getUsernameClaim());
        String email = text(claims, config.getEmailClaim());
        String displayName = text(claims, config.getNameClaim());
        if (userinfo != null) {
            if (username == null) {
                username = text(userinfo, config.getUsernameClaim());
            }
            if (email == null) {
                email = text(userinfo, config.getEmailClaim());
            }
            if (displayName == null) {
                displayName = text(userinfo, config.getNameClaim());
            }
        }
        if (username == null || username.isBlank()) {
            username = email != null && email.contains("@")
                    ? email.substring(0, email.indexOf('@')) : subject;
        }
        List<String> groups = new ArrayList<>();
        for (JsonNode group : claims.path(config.getGroupsClaim())) {
            groups.add(group.asText(""));
        }
        IdentityClaims identity = new IdentityClaims(providerId, "oidc", subject, username,
                email, displayName == null || displayName.isBlank() ? username : displayName, groups);
        long userId = resolveUser(identity);
        auditService.record("auth.sso.oidc", "user", userId,
                "OIDC 登录成功 provider=" + providerId + " subject=" + mask(subject), providerId);
        return issue(userId);
    }

    // ---------------------------------------------------------------------------- SAML ----

    public StartResult startSaml(String providerId) {
        IdentityProperties.SamlProvider config = samlProvider(providerId);
        String acs = acsUrl(providerId, config);
        SamlService.StartResult result = samlService.start(providerId, config, acs);
        String state = IdentityCrypto.randomToken(32);
        store.saveSession(IdentityCrypto.sha256Hex(state), providerId, "saml", acs,
                null, null, result.requestId(), LocalDateTime.now().plus(properties.getSessionTtl()));
        return new StartResult(result.redirectUrl(), state,
                LocalDateTime.now().plus(properties.getSessionTtl()).toString(), result.requestId());
    }

    public AuthDtos.TokenResponse acsSaml(String providerId, String samlResponse) {
        IdentityProperties.SamlProvider config = samlProvider(providerId);
        String inResponseTo = SamlService.inResponseTo(samlResponse);
        IdentityStore.SessionLookup lookup = inResponseTo == null
                ? null : store.findSessionByRequestId(inResponseTo);
        if (lookup == null || !providerId.equals(lookup.providerId())) {
            throw new BizException(ErrorCode.UNAUTHENTICATED, "SAML AuthnRequest 未知或已过期");
        }
        String acs = acsUrl(providerId, config);
        IdentityClaims claims = samlService.verify(providerId, config, samlResponse,
                inResponseTo, acs);
        if (store.consumeSession(lookup.stateHash()) == null) {
            throw new BizException(ErrorCode.UNAUTHENTICATED, "SAML 断言已被重放");
        }
        long userId = resolveUser(claims);
        auditService.record("auth.sso.saml", "user", userId,
                "SAML 登录成功 provider=" + providerId + " nameId=" + mask(claims.subject()), providerId);
        return issue(userId);
    }

    // ---------------------------------------------------------------------------- LDAP ----

    public AuthDtos.TokenResponse loginLdap(String username, String password) {
        if (!properties.isEnabled() || !properties.getLdap().isEnabled()) {
            throw new BizException(ErrorCode.NOT_FOUND, "LDAP 登录未启用");
        }
        IdentityClaims claims = ldapService.authenticate(properties.getLdap(), username, password);
        long userId = resolveUser(claims);
        auditService.record("auth.sso.ldap", "user", userId,
                "LDAP 绑定成功 username=" + mask(username), "ldap");
        return issue(userId);
    }

    // -------------------------------------------------------------------------- header ----

    /** TrustedHeaderFilter already resolved the account; exchange it for local tokens. */
    public AuthDtos.TokenResponse issueForHeader() {
        if (!properties.isEnabled() || !properties.getHeader().isEnabled()) {
            throw new BizException(ErrorCode.NOT_FOUND, "可信头 SSO 未启用");
        }
        long userId = com.xbeeant.reqora.server.common.CurrentUser.requireId();
        auditService.record("auth.sso.header", "user", userId, "可信代理头换取本地令牌", "header");
        return issue(userId);
    }

    // --------------------------------------------------------------- account resolution ----

    /**
     * One policy for every method: stable external subject first, then optional
     * email linking, then optional JIT provisioning, otherwise reject. Never
     * silently merges two different external subjects.
     */
    public long resolveUser(IdentityClaims claims) {
        String email = normalizeEmail(claims.email(), claims.username(), claims.providerId());
        checkDomain(email);
        IdentityStore.ExternalBinding binding = store.findExternal(
                claims.providerId(), claims.subject());
        long userId;
        if (binding != null) {
            userId = binding.userId();
            store.touchExternal(binding.id());
            store.updateExternalProfile(binding.id(), email, claims.displayName());
        } else if (properties.isLinkByEmail() && email != null) {
            Long linked = store.findUserIdByEmail(email);
            if (linked != null) {
                userId = linked;
                store.bindExternal(claims.providerId(), claims.providerType(),
                        claims.subject(), userId, email, claims.displayName());
                auditService.record("auth.identity.link", "user", userId,
                        "按邮箱链接外部身份 provider=" + claims.providerId(), claims.providerId());
            } else {
                userId = provision(claims, email);
            }
        } else if (properties.isJitProvisioning()) {
            if (email != null && store.findUserIdByEmail(email) != null) {
                throw new BizException(ErrorCode.CONFLICT,
                        "邮箱已存在但邮箱链接已关闭，请由管理员绑定或开启 REQORA_IDENTITY_LINK_BY_EMAIL");
            }
            userId = provision(claims, email);
        } else {
            throw new BizException(ErrorCode.UNAUTHENTICATED,
                    "外部身份未绑定且 JIT 开户已关闭，请联系管理员");
        }
        Integer status = store.userStatus(userId);
        if (status == null || status != 1) {
            auditService.record("auth.login.denied", "user", userId,
                    "账号已停用，拒绝登录 provider=" + claims.providerId(), claims.providerId());
            throw new BizException(ErrorCode.ACCOUNT_DISABLED);
        }
        return userId;
    }

    private long provision(IdentityClaims claims, String email) {
        String username = uniqueUsername(claims.username());
        String finalEmail = email == null ? username + "@" + claims.providerId() + ".local" : email;
        String passwordHash = passwordEncoder.encode(
                UUID.randomUUID() + "-" + IdentityCrypto.randomToken(24));
        long userId = store.createUser(username, finalEmail, claims.displayName(), passwordHash);
        Long roleId = store.roleId(properties.getDefaultRole());
        if (roleId != null) {
            store.grantRole(userId, roleId);
        }
        store.bindExternal(claims.providerId(), claims.providerType(),
                claims.subject(), userId, finalEmail, claims.displayName());
        auditService.record("auth.identity.provision", "user", userId,
                "JIT 开户 provider=" + claims.providerId() + " username=" + username
                        + " role=" + properties.getDefaultRole(), claims.providerId());
        return userId;
    }

    private String uniqueUsername(String raw) {
        String base = (raw == null ? "user" : raw)
                .replaceAll("[^A-Za-z0-9_.-]", "_");
        if (base.length() > 58) {
            base = base.substring(0, 58);
        }
        if (base.isBlank()) {
            base = "user";
        }
        String candidate = base;
        for (int i = 2; i < 200 && store.usernameExists(candidate); i++) {
            candidate = base + "-" + i;
        }
        if (store.usernameExists(candidate)) {
            throw new BizException(ErrorCode.CONFLICT, "无法为外部身份生成唯一用户名");
        }
        return candidate;
    }

    private String normalizeEmail(String email, String username, String providerId) {
        if (email != null && !email.isBlank()) {
            return email.trim().toLowerCase();
        }
        String local = (username == null ? "user" : username).replaceAll("[^A-Za-z0-9_.-]", "_");
        return local + "@" + providerId + ".local";
    }

    private void checkDomain(String email) {
        List<String> allowed = properties.getAllowedEmailDomains();
        if (allowed == null || allowed.isEmpty() || email == null) {
            return;
        }
        String domain = email.contains("@") ? email.substring(email.indexOf('@') + 1) : "";
        for (String entry : allowed) {
            if (entry != null && !entry.isBlank() && entry.trim().equalsIgnoreCase(domain)) {
                return;
            }
        }
        throw new BizException(ErrorCode.FORBIDDEN, "邮箱域名不在允许列表中");
    }

    private AuthDtos.TokenResponse issue(long userId) {
        UserEntity user = principalLoader.requireEnabled(userId);
        return authService.issueFor(user);
    }

    // ------------------------------------------------------------------------- helpers ----

    private IdentityProperties.OidcProvider oidcProvider(String providerId) {
        if (!properties.isEnabled()) {
            throw new BizException(ErrorCode.NOT_FOUND, "外部身份集成未启用");
        }
        IdentityProperties.OidcProvider config = properties.getOidc().getProviders().get(providerId);
        if (config == null || !config.isEnabled()) {
            throw new BizException(ErrorCode.NOT_FOUND, "OIDC 提供者不存在或未启用：" + providerId);
        }
        return config;
    }

    private IdentityProperties.SamlProvider samlProvider(String providerId) {
        if (!properties.isEnabled()) {
            throw new BizException(ErrorCode.NOT_FOUND, "外部身份集成未启用");
        }
        IdentityProperties.SamlProvider config = properties.getSaml().getProviders().get(providerId);
        if (config == null || !config.isEnabled()) {
            throw new BizException(ErrorCode.NOT_FOUND, "SAML 提供者不存在或未启用：" + providerId);
        }
        return config;
    }

    private String acsUrl(String providerId, IdentityProperties.SamlProvider config) {
        if (config.getAcsUrl() != null && !config.getAcsUrl().isBlank()) {
            return config.getAcsUrl();
        }
        return base() + "/api/v1/auth/sso/saml/" + providerId + "/acs";
    }

    private String redirect(String requested, String configured, String fallbackPath) {
        if (requested != null && !requested.isBlank()) {
            return requested;
        }
        if (configured != null && !configured.isBlank()) {
            return configured;
        }
        return base() + fallbackPath;
    }

    private String base() {
        String base = properties.getPublicBaseUrl();
        if (base == null || base.isBlank()) {
            throw new BizException(ErrorCode.BAD_REQUEST, "未配置 publicBaseUrl");
        }
        return base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
    }

    private static String text(JsonNode node, String field) {
        if (node == null || field == null) {
            return null;
        }
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? null : value.asText(null);
    }

    private static String mask(String value) {
        if (value == null || value.length() <= 4) {
            return "****";
        }
        return value.substring(0, 2) + "***" + value.substring(value.length() - 2);
    }

    /** Minimal, stable provider descriptor used by the desktop client. */
    public Map<String, Object> capabilityMap() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("enabled", properties.isEnabled());
        out.put("methods", providers());
        out.put("scim", properties.getScim().isEnabled());
        out.put("pat", properties.getPat().isEnabled());
        out.put("jitProvisioning", properties.isJitProvisioning());
        out.put("linkByEmail", properties.isLinkByEmail());
        return out;
    }
}
