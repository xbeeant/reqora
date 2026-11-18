package com.xbeeant.reqora.server.project;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.xbeeant.reqora.server.audit.AuditService;
import com.xbeeant.reqora.server.common.Access;
import com.xbeeant.reqora.server.common.AuthUser;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.CurrentUser;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.common.PageResult;
import com.xbeeant.reqora.server.common.Permissions;
import com.xbeeant.reqora.server.member.ProjectMemberEntity;
import com.xbeeant.reqora.server.member.ProjectMemberMapper;
import com.xbeeant.reqora.server.organization.OrgMemberMapper;
import com.xbeeant.reqora.server.organization.OrganizationService;
import com.xbeeant.reqora.server.workspace.WorkspaceMetaEntity;
import com.xbeeant.reqora.server.workspace.WorkspaceMetaMapper;
import com.xbeeant.reqora.server.workspace.WorkspaceRowEntity;
import com.xbeeant.reqora.server.workspace.WorkspaceRowMapper;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ProjectService {

    private final ProjectMapper projectMapper;
    private final ProjectMemberMapper memberMapper;
    private final WorkspaceRowMapper workspaceRowMapper;
    private final WorkspaceMetaMapper workspaceMetaMapper;
    private final ProjectAccess projectAccess;
    private final AuditService auditService;
    private final OrganizationService organizationService;
    private final OrgMemberMapper orgMemberMapper;

    public ProjectService(
            ProjectMapper projectMapper,
            ProjectMemberMapper memberMapper,
            WorkspaceRowMapper workspaceRowMapper,
            WorkspaceMetaMapper workspaceMetaMapper,
            ProjectAccess projectAccess,
            AuditService auditService,
            OrganizationService organizationService,
            OrgMemberMapper orgMemberMapper) {
        this.projectMapper = projectMapper;
        this.memberMapper = memberMapper;
        this.workspaceRowMapper = workspaceRowMapper;
        this.workspaceMetaMapper = workspaceMetaMapper;
        this.projectAccess = projectAccess;
        this.auditService = auditService;
        this.organizationService = organizationService;
        this.orgMemberMapper = orgMemberMapper;
    }

    @Transactional
    public ProjectDtos.ProjectView create(ProjectDtos.CreateProjectRequest request) {
        AuthUser actor = Access.requireSystem(Permissions.PROJECT_CREATE);
        String slug = request.slug().trim().toLowerCase();
        if (projectMapper.selectCount(new LambdaQueryWrapper<ProjectEntity>()
                .eq(ProjectEntity::getSlug, slug)) > 0) {
            throw new BizException(ErrorCode.CONFLICT, "项目标识 slug 已被使用");
        }
        ProjectEntity project = new ProjectEntity();
        project.setName(request.name().trim());
        project.setSlug(slug);
        project.setDescription(request.description() == null ? "" : request.description());
        project.setOwnerId(actor.id());
        project.setStatus("ACTIVE");
        project.setVersion(0L);
        project.setCreatedBy(actor.id());
        if (request.orgId() != null) {
            organizationService.requireRole(request.orgId(), actor);
            project.setOrgId(request.orgId());
        }
        projectMapper.insert(project);

        ProjectMemberEntity owner = new ProjectMemberEntity();
        owner.setProjectId(project.getId());
        owner.setUserId(actor.id());
        owner.setMemberRole(ProjectRole.OWNER.name());
        owner.setCreatedBy(actor.id());
        memberMapper.insert(owner);

        auditService.record("project.create", "project", project.getId(), "创建项目 " + slug);
        return view(project, ProjectRole.OWNER.name());
    }

    public PageResult<ProjectDtos.ProjectView> list(long page, long size, String keyword) {
        AuthUser actor = CurrentUser.require();
        boolean all = actor.superAdmin() || actor.has(Permissions.PROJECT_READ_ANY);
        List<Long> visibleIds = all
                ? null
                : memberMapper.selectProjectIdsByUserId(actor.id());
        if (!all) {
            // Organization members can see every project owned by their orgs.
            List<Long> orgIds = orgMemberMapper.selectOrgIdsByUserId(actor.id());
            if (orgIds != null && !orgIds.isEmpty()) {
                List<Long> orgProjects = projectMapper.selectList(
                                new LambdaQueryWrapper<ProjectEntity>()
                                        .in(ProjectEntity::getOrgId, orgIds))
                        .stream()
                        .map(ProjectEntity::getId)
                        .toList();
                List<Long> merged = new ArrayList<>(visibleIds == null ? List.of() : visibleIds);
                for (Long id : orgProjects) {
                    if (!merged.contains(id)) merged.add(id);
                }
                visibleIds = merged;
            }
            if (visibleIds == null || visibleIds.isEmpty()) {
                return new PageResult<>(List.of(), 0, page, size);
            }
        }

        LambdaQueryWrapper<ProjectEntity> wrapper = new LambdaQueryWrapper<>();
        if (visibleIds != null) {
            wrapper.in(ProjectEntity::getId, visibleIds);
        }
        if (keyword != null && !keyword.isBlank()) {
            String like = "%" + keyword.trim() + "%";
            wrapper.and(q -> q.like(ProjectEntity::getName, like)
                    .or().like(ProjectEntity::getSlug, like));
        }
        wrapper.orderByDesc(ProjectEntity::getId);
        IPage<ProjectEntity> result = projectMapper.selectPage(Page.of(page, size), wrapper);

        Map<Long, String> roles = new HashMap<>();
        if (!result.getRecords().isEmpty()) {
            List<Long> ids = result.getRecords().stream().map(ProjectEntity::getId).toList();
            memberMapper.selectList(new LambdaQueryWrapper<ProjectMemberEntity>()
                            .in(ProjectMemberEntity::getProjectId, ids)
                            .eq(ProjectMemberEntity::getUserId, actor.id()))
                    .forEach(member -> roles.put(member.getProjectId(), member.getMemberRole()));
        }
        final Map<Long, String> roleMap = Collections.unmodifiableMap(roles);
        List<ProjectDtos.ProjectView> rows = result.getRecords().stream()
                .map(project -> view(project,
                        roleMap.getOrDefault(project.getId(), actor.superAdmin() ? "SYSTEM" : "VIEWER")))
                .toList();
        return new PageResult<>(rows, result.getTotal(), result.getCurrent(), result.getSize());
    }

    public ProjectDtos.ProjectView get(long projectId) {
        ProjectEntity project = projectAccess.require(projectId, ProjectCapability.PROJECT_READ);
        AuthUser actor = CurrentUser.require();
        ProjectRole role = projectAccess.roleOf(projectId, actor);
        return view(project, role == null ? "SYSTEM" : role.name());
    }

    @Transactional
    public ProjectDtos.ProjectView update(long projectId, ProjectDtos.UpdateProjectRequest request) {
        ProjectEntity project = projectAccess.require(projectId, ProjectCapability.PROJECT_UPDATE);
        project.setName(request.name().trim());
        project.setDescription(request.description() == null ? "" : request.description());
        project.setUpdatedAt(LocalDateTime.now());
        projectMapper.updateById(project);
        auditService.record("project.update", "project", projectId, "更新项目信息");
        return get(projectId);
    }

    @Transactional
    public ProjectDtos.ProjectView archive(long projectId, boolean archived) {
        ProjectEntity project = projectAccess.require(projectId, ProjectCapability.PROJECT_ARCHIVE);
        project.setStatus(archived ? "ARCHIVED" : "ACTIVE");
        project.setUpdatedAt(LocalDateTime.now());
        projectMapper.updateById(project);
        auditService.record("project.archive", "project", projectId,
                archived ? "归档项目" : "取消归档");
        return get(projectId);
    }

    @Transactional
    public void delete(long projectId) {
        ProjectEntity project = projectAccess.require(projectId, ProjectCapability.PROJECT_DELETE);
        workspaceRowMapper.delete(new LambdaQueryWrapper<WorkspaceRowEntity>()
                .eq(WorkspaceRowEntity::getProjectId, projectId));
        workspaceMetaMapper.delete(new LambdaQueryWrapper<WorkspaceMetaEntity>()
                .eq(WorkspaceMetaEntity::getProjectId, projectId));
        memberMapper.delete(new LambdaQueryWrapper<ProjectMemberEntity>()
                .eq(ProjectMemberEntity::getProjectId, projectId));
        projectMapper.deleteById(projectId);
        auditService.record("project.delete", "project", projectId, "删除项目 " + project.getSlug());
    }

    private ProjectDtos.ProjectView view(ProjectEntity project, String role) {
        return new ProjectDtos.ProjectView(
                project.getId(), project.getName(), project.getSlug(), project.getDescription(),
                project.getStatus(), project.getOwnerId(), role,
                project.getCreatedAt(), project.getUpdatedAt(), project.getOrgId());
    }
}
