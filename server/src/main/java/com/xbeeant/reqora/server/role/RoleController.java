package com.xbeeant.reqora.server.role;

import com.xbeeant.reqora.server.common.ApiResponse;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/roles")
public class RoleController {

    private final RoleService roleService;

    public RoleController(RoleService roleService) {
        this.roleService = roleService;
    }

    @GetMapping
    public ApiResponse<java.util.List<RoleDtos.RoleView>> roles() {
        return ApiResponse.ok(roleService.roles());
    }

    @GetMapping("/permissions")
    public ApiResponse<java.util.List<RoleDtos.PermissionView>> permissions() {
        return ApiResponse.ok(roleService.permissions());
    }

    @PostMapping
    public ApiResponse<RoleDtos.RoleView> create(@Valid @RequestBody RoleDtos.CreateRoleRequest request) {
        return ApiResponse.ok(roleService.create(request));
    }

    @PutMapping("/{id}")
    public ApiResponse<RoleDtos.RoleView> update(
            @PathVariable long id, @Valid @RequestBody RoleDtos.UpdateRoleRequest request) {
        return ApiResponse.ok(roleService.update(id, request));
    }

    @DeleteMapping("/{id}")
    public ApiResponse<Void> delete(@PathVariable long id) {
        roleService.delete(id);
        return ApiResponse.ok(null);
    }

    @PutMapping("/{id}/permissions")
    public ApiResponse<java.util.List<String>> setPermissions(
            @PathVariable long id, @Valid @RequestBody RoleDtos.SetPermissionsRequest request) {
        return ApiResponse.ok(roleService.setPermissions(id, request.permissions()));
    }
}
