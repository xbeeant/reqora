package com.xbeeant.reqora.server.config;

import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * External identity configuration. Everything is opt-in: with no configuration
 * the collaboration server keeps exactly its original local-account behaviour.
 *
 * <p>Bound from {@code reqora.identity.*}; environment variables use the repo's
 * {@code REQORA_IDENTITY_*} convention, e.g.
 * {@code REQORA_IDENTITY_ENABLED=true},
 * {@code REQORA_IDENTITY_OIDC_PROVIDERS_OKTA_ISSUER=https://...}.
 * No values are written into application.yml so that a stock deployment carries
 * no IdP secrets and no example credentials.
 *
 * <p>Deliberately dependency-free: the whole identity layer uses JDK 21 APIs
 * (HttpClient, XML DSig, JNDI, JCA) plus the already-present Spring Web stack.
 * Adding a SAML/OIDC/SCIM library would enlarge the SBOM and the supply-chain
 * surface for a feature that most self-hosted deployments never enable.
 */
@Data
@ConfigurationProperties(prefix = "reqora.identity")
public class IdentityProperties {

    /** Master switch for every non-local login method. */
    private boolean enabled = false;

    /** Base URL of this server, used to derive OIDC redirect / SAML ACS URLs. */
    private String publicBaseUrl = "";

    /** Create a local account on first successful external login. */
    private boolean jitProvisioning = true;

    /** Link an external subject to an existing local account with the same email. */
    private boolean linkByEmail = true;

    /** Role code assigned to JIT-provisioned accounts. */
    private String defaultRole = "USER";

    /** Optional allow-list of email domains (empty = any domain). */
    private List<String> allowedEmailDomains = new ArrayList<>();

    /** Lifetime of a one-shot SSO state / PKCE verifier / SAML request. */
    private Duration sessionTtl = Duration.ofMinutes(5);

    private Oidc oidc = new Oidc();
    private Saml saml = new Saml();
    private Ldap ldap = new Ldap();
    private Header header = new Header();
    private Pat pat = new Pat();
    private Scim scim = new Scim();

    @Data
    public static class Oidc {
        /** Key = provider id used in URLs, e.g. "okta". */
        private Map<String, OidcProvider> providers = new LinkedHashMap<>();
    }

    @Data
    public static class OidcProvider {
        private boolean enabled = true;
        private String label = "";
        private String issuer;
        private String clientId;
        private String clientSecret;
        /** Browser return URL; defaults to publicBaseUrl + /sso/callback.html. */
        private String redirectUri;
        private String scopes = "openid profile email";
        /** Discovery document; explicit URIs below override it when set. */
        private boolean discovery = true;
        private String authorizationUri;
        private String tokenUri;
        private String jwksUri;
        private String userinfoUri;
        private boolean pkce = true;
        private String usernameClaim = "preferred_username";
        private String emailClaim = "email";
        private String nameClaim = "name";
        private String groupsClaim = "groups";
        private Duration clockSkew = Duration.ofSeconds(60);
        private Duration timeout = Duration.ofSeconds(8);
    }

    @Data
    public static class Saml {
        private Map<String, SamlProvider> providers = new LinkedHashMap<>();
    }

    @Data
    public static class SamlProvider {
        private boolean enabled = true;
        private String label = "";
        /** This SP's entityID. */
        private String entityId;
        private String idpEntityId;
        private String ssoUrl;
        /** Assertion Consumer Service URL; defaults to publicBaseUrl + acs path. */
        private String acsUrl;
        /** Base64 (DER) or PEM X.509 signing certificate of the IdP. */
        private String certificate;
        private String nameIdFormat = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
        private String usernameAttribute =
                "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name";
        private String emailAttribute =
                "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";
        private String nameAttribute =
                "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/displayname";
        private Duration clockSkew = Duration.ofSeconds(120);
        private Duration maxAssertionAge = Duration.ofMinutes(10);
    }

    @Data
    public static class Ldap {
        private boolean enabled = false;
        /** ldaps:// is strongly recommended; ldap:// is only for a trusted LAN. */
        private String url;
        private String baseDn;
        /** "{0}" is replaced with the escaped login name. */
        private String userDnPattern = "uid={0},ou=people";
        private String userSearchFilter = "(uid={0})";
        private String bindDn;
        private String bindPassword;
        private String mailAttribute = "mail";
        private String displayNameAttribute = "cn";
        private String groupAttribute = "memberOf";
        private Duration timeout = Duration.ofSeconds(8);
    }

    @Data
    public static class Header {
        private boolean enabled = false;
        /** Requests from outside these CIDRs are never trusted, even with a valid HMAC. */
        private List<String> trustedProxies = new ArrayList<>(List.of("127.0.0.1/32", "::1/128"));
        /** Shared HMAC secret for the replay-proof header signature. */
        private String headerSecret;
        private String userHeader = "X-Forwarded-User";
        private String emailHeader = "X-Forwarded-Email";
        private String nameHeader = "X-Forwarded-Preferred-Username";
        private String groupsHeader = "X-Forwarded-Groups";
        private String timestampHeader = "X-Forwarded-Timestamp";
        private String signatureHeader = "X-Forwarded-Signature";
        private Duration maxSkew = Duration.ofMinutes(5);
    }

    @Data
    public static class Pat {
        private boolean enabled = false;
        private long maxTtlDays = 90;
        private int maxPerUser = 10;
    }

    @Data
    public static class Scim {
        private boolean enabled = false;
        /** SHA-256 hex digests of SCIM bearer tokens; raw tokens are never stored. */
        private List<String> tokenHashes = new ArrayList<>();
        /** DELETE is a soft deactivate by design; hard delete is opt-in and off. */
        private boolean allowHardDelete = false;
        private int maxPageSize = 100;
    }
}
