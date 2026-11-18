package com.xbeeant.reqora.server.project;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xbeeant.reqora.server.common.AuthUser;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.CurrentUser;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.common.Permissions;
import com.xbeeant.reqora.server.member.ProjectMemberEntity;
import com.xbeeant.reqora.server.member.ProjectMemberMapper;
import com.xbeeant.reqora.server.organization.OrgMemberMapper;
import com.xbeeant.reqora.server.organization.OrgRole;
import java.util.EnumSet;
import java.util.Set;
import org.springframework.stereotype.Service;

/** Single gate for project operations: system RBAC + project-member role are combined here. */
@Service
public class ProjectAccess {

    private static final Set<ProjectCapability> READ_ONLY = EnumSet.of(
            ProjectCapability.PROJECT_READ,
            ProjectCapability.MEMBER_READ,
            ProjectCapability.WORKSPACE_READ);

    private final ProjectMapper projectMapper;
    private final ProjectMemberMapper memberMapper;
    private final OrgMemberMapper orgMemberMapper;

    public ProjectAccess(
            ProjectMapper projectMapper,
            ProjectMemberMapper memberMapper,
            OrgMemberMapper orgMemberMapper) {
        this.projectMapper = projectMapper;
        this.memberMapper = memberMapper;
        this.orgMemberMapper = orgMemberMapper;
    }

    public ProjectEntity require(long projectId, ProjectCapability capability) {
        AuthUser actor = CurrentUser.require();
        ProjectEntity project = projectMapper.selectById(projectId);
        if (project == null) {
            throw BizException.notFound("项目");
        }
        if (actor.superAdmin()) {
            return project;
        }
        if (capability == ProjectCapability.PROJECT_DELETE && actor.has(Permissions.PROJECT_DELETE_ANY)) {
            return project;
        }
        if (READ_ONLY.contains(capability) && actor.has(Permissions.PROJECT_READ_ANY)) {
            return project;
        }
        ProjectMemberEntity member = memberMapper.selectOne(
                new LambdaQueryWrapper<ProjectMemberEntity>()
                        .eq(ProjectMemberEntity::getProjectId, projectId)
                        .eq(ProjectMemberEntity::getUserId, actor.id())
                        .last("LIMIT 1"));
        if (member == null) {
            ProjectRole derived = orgDerivedRole(project, actor);
            if (derived == null) {
                throw new BizException(ErrorCode.FORBIDDEN, "你不是该项目成员");
            }
            if (!derived.allows(capability)) {
                throw new BizException(ErrorCode.FORBIDDEN,
                        "组织成员的项目角色 " + derived.name() + " 无权执行该操作");
            }
            return project;
        }
        ProjectRole role = ProjectRole.parse(member.getMemberRole());
        if (!role.allows(capability)) {
            throw new BizException(ErrorCode.FORBIDDEN,
                    "当前项目角色 " + role.name() + " 无权执行该操作");
        }
        return project;
    }

    /** Returns the caller's project role; null for system-level administrators without membership. */
    public ProjectRole roleOf(long projectId, AuthUser actor) {
        ProjectMemberEntity member = memberMapper.selectOne(
                new LambdaQueryWrapper<ProjectMemberEntity>()
                        .eq(ProjectMemberEntity::getProjectId, projectId)
                        .eq(ProjectMemberEntity::getUserId, actor.id())
                        .last("LIMIT 1"));
        return member == null
                ? orgDerivedRole(projectMapper.selectById(projectId), actor)
                : ProjectRole.parse(member.getMemberRole());
    }

    /** Org ADMIN/OWNER can edit org projects; plain members get read-only. */
    private ProjectRole orgDerivedRole(ProjectEntity project, AuthUser actor) {
        if (project == null || project.getOrgId() == null) return null;
        String role = orgMemberMapper.selectRole(project.getOrgId(), actor.id());
        if (role == null) return null;
        return OrgRole.parse(role).canManage() ? ProjectRole.EDITOR : ProjectRole.VIEWER;
    }
}
