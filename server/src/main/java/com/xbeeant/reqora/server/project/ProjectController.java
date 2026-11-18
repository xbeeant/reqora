package com.xbeeant.reqora.server.project;

import com.xbeeant.reqora.server.common.ApiResponse;
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
@RequestMapping("/api/v1/projects")
public class ProjectController {

    private final ProjectService projectService;

    public ProjectController(ProjectService projectService) {
        this.projectService = projectService;
    }

    @GetMapping
    public ApiResponse<PageResult<ProjectDtos.ProjectView>> list(
            @RequestParam(defaultValue = "1") @Min(1) long page,
            @RequestParam(defaultValue = "20") @Min(1) @Max(100) long size,
            @RequestParam(required = false) String keyword) {
        return ApiResponse.ok(projectService.list(page, size, keyword));
    }

    @PostMapping
    public ApiResponse<ProjectDtos.ProjectView> create(
            @Valid @RequestBody ProjectDtos.CreateProjectRequest request) {
        return ApiResponse.ok(projectService.create(request));
    }

    @GetMapping("/{projectId}")
    public ApiResponse<ProjectDtos.ProjectView> get(@PathVariable long projectId) {
        return ApiResponse.ok(projectService.get(projectId));
    }

    @PutMapping("/{projectId}")
    public ApiResponse<ProjectDtos.ProjectView> update(
            @PathVariable long projectId,
            @Valid @RequestBody ProjectDtos.UpdateProjectRequest request) {
        return ApiResponse.ok(projectService.update(projectId, request));
    }

    @PutMapping("/{projectId}/archive")
    public ApiResponse<ProjectDtos.ProjectView> archive(
            @PathVariable long projectId, @RequestParam(defaultValue = "true") boolean archived) {
        return ApiResponse.ok(projectService.archive(projectId, archived));
    }

    @DeleteMapping("/{projectId}")
    public ApiResponse<Void> delete(@PathVariable long projectId) {
        projectService.delete(projectId);
        return ApiResponse.ok(null);
    }
}
