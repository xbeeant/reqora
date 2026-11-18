package com.xbeeant.reqora.server.user;

import com.xbeeant.reqora.server.common.ApiResponse;
import com.xbeeant.reqora.server.common.CurrentUser;
import com.xbeeant.reqora.server.common.PageResult;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@Validated
@RestController
@RequestMapping("/api/v1/users")
public class UserController {

    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    @GetMapping
    public ApiResponse<PageResult<UserDtos.UserSummary>> list(
            @RequestParam(defaultValue = "1") @Min(1) long page,
            @RequestParam(defaultValue = "20") @Min(1) @Max(100) long size,
            @RequestParam(required = false) String keyword) {
        return ApiResponse.ok(userService.list(page, size, keyword));
    }

    @PostMapping
    public ApiResponse<UserView> create(@Valid @RequestBody UserDtos.CreateUserRequest request) {
        return ApiResponse.ok(userService.create(request));
    }

    @GetMapping("/{id}")
    public ApiResponse<UserView> detail(@PathVariable long id) {
        return ApiResponse.ok(userService.detail(id));
    }

    @PutMapping("/{id}/status")
    public ApiResponse<UserView> setStatus(
            @PathVariable long id, @Valid @RequestBody UserDtos.SetStatusRequest request) {
        return ApiResponse.ok(userService.setStatus(id, request.enabled()));
    }

    @PutMapping("/{id}/roles")
    public ApiResponse<UserView> setRoles(
            @PathVariable long id, @Valid @RequestBody UserDtos.SetRolesRequest request) {
        return ApiResponse.ok(userService.setRoles(id, request.roles()));
    }

    @PutMapping("/{id}/password")
    public ApiResponse<Void> resetPassword(
            @PathVariable long id, @Valid @RequestBody UserDtos.ResetPasswordRequest request) {
        userService.resetPassword(id, request.password());
        return ApiResponse.ok(null);
    }

    @PostMapping("/me/password")
    public ApiResponse<Void> changePassword(@Valid @RequestBody UserDtos.ChangePasswordRequest request) {
        userService.changePassword(CurrentUser.requireId(), request.oldPassword(), request.newPassword());
        return ApiResponse.ok(null);
    }

    @DeleteMapping("/{id}")
    public ApiResponse<Void> delete(@PathVariable long id) {
        userService.delete(id);
        return ApiResponse.ok(null);
    }
}
