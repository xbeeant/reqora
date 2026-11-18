package com.xbeeant.reqora.server.identity;

import com.xbeeant.reqora.server.auth.AuthDtos;
import com.xbeeant.reqora.server.common.ApiResponse;
import com.xbeeant.reqora.server.common.CurrentUser;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import java.util.List;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** All external login entry points. Every token issued here is a normal local JWT. */
@Validated
@RestController
public class SsoController {

    public record OidcStartRequest(@NotBlank String providerId, String redirectUri) {}
    public record OidcCallbackRequest(
            @NotBlank String providerId, @NotBlank String code,
            @NotBlank String state, String redirectUri) {}
    public record LdapLoginRequest(@NotBlank String username, @NotBlank String password) {}
    public record PatCreateRequest(@NotBlank String name, @Min(1) @Max(365) Long ttlDays) {}
    public record PatExchangeRequest(@NotBlank String token) {}

    private final IdentityService identityService;
    private final PatService patService;

    public SsoController(IdentityService identityService, PatService patService) {
        this.identityService = identityService;
        this.patService = patService;
    }

    /** Public capability discovery used by the desktop client before showing a login UI. */
    @GetMapping("/api/v1/auth/providers")
    public ApiResponse<Map<String, Object>> providers() {
        return ApiResponse.ok(identityService.capabilityMap());
    }

    @PostMapping("/api/v1/auth/sso/oidc/start")
    public ApiResponse<IdentityService.StartResult> oidcStart(
            @Valid @RequestBody OidcStartRequest request) {
        return ApiResponse.ok(identityService.startOidc(request.providerId(), request.redirectUri()));
    }

    @PostMapping("/api/v1/auth/sso/oidc/callback")
    public ApiResponse<AuthDtos.TokenResponse> oidcCallback(
            @Valid @RequestBody OidcCallbackRequest request) {
        return ApiResponse.ok(identityService.callbackOidc(request.providerId(), request.code(),
                request.state(), request.redirectUri()));
    }

    @GetMapping("/api/v1/auth/sso/saml/{providerId}/start")
    public ApiResponse<IdentityService.StartResult> samlStart(@PathVariable String providerId) {
        return ApiResponse.ok(identityService.startSaml(providerId));
    }

    @PostMapping(value = "/api/v1/auth/sso/saml/{providerId}/acs",
            consumes = MediaType.APPLICATION_FORM_URLENCODED_VALUE)
    public ApiResponse<AuthDtos.TokenResponse> samlAcs(
            @PathVariable String providerId,
            @RequestParam("SAMLResponse") String samlResponse,
            @RequestParam(value = "RelayState", required = false) String relayState) {
        return ApiResponse.ok(identityService.acsSaml(providerId, samlResponse));
    }

    @PostMapping("/api/v1/auth/sso/ldap")
    public ApiResponse<AuthDtos.TokenResponse> ldapLogin(
            @Valid @RequestBody LdapLoginRequest request) {
        return ApiResponse.ok(identityService.loginLdap(request.username(), request.password()));
    }

    @GetMapping("/api/v1/auth/sso/header")
    public ApiResponse<AuthDtos.TokenResponse> headerLogin() {
        return ApiResponse.ok(identityService.issueForHeader());
    }

    // ------------------------------------------------------------------------------ PAT ----

    @PostMapping("/api/v1/auth/pat")
    public ApiResponse<PatService.Created> createPat(@Valid @RequestBody PatCreateRequest request) {
        long userId = CurrentUser.requireId();
        return ApiResponse.ok(patService.create(userId, request.name(),
                request.ttlDays() == null ? 0 : request.ttlDays()));
    }

    @GetMapping("/api/v1/auth/pat")
    public ApiResponse<List<PatService.View>> listPats() {
        return ApiResponse.ok(patService.list(CurrentUser.requireId()));
    }

    @DeleteMapping("/api/v1/auth/pat/{id}")
    public ApiResponse<Void> revokePat(@PathVariable long id) {
        patService.revoke(CurrentUser.requireId(), id);
        return ApiResponse.ok(null);
    }

    @PostMapping("/api/v1/auth/pat/exchange")
    public ApiResponse<AuthDtos.TokenResponse> exchangePat(
            @Valid @RequestBody PatExchangeRequest request) {
        return ApiResponse.ok(patService.exchange(request.token()));
    }
}
