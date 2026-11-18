package com.xbeeant.reqora.server.auth;

import com.xbeeant.reqora.server.user.UserView;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/** Request/response records for the auth surface. Validation happens at the HTTP boundary. */
public final class AuthDtos {

    private AuthDtos() {}

    public record LoginRequest(@NotBlank String username, @NotBlank String password) {}

    public record RegisterRequest(
            @NotBlank @Size(min = 3, max = 64)
            @Pattern(regexp = "^[A-Za-z0-9_.-]+$", message = "只能包含字母、数字、点、下划线和连字符")
            String username,
            @NotBlank @Email String email,
            @NotBlank @Size(min = 8, max = 72, message = "密码长度需为 8-72") String password,
            String displayName) {}

    public record RefreshRequest(@NotBlank String refreshToken) {}

    public record LogoutRequest(String refreshToken) {}

    public record TokenResponse(
            String accessToken,
            String refreshToken,
            String tokenType,
            long expiresIn,
            UserView user) {}
}
