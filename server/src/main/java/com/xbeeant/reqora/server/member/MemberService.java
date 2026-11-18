package com.xbeeant.reqora.server.member;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xbeeant.reqora.server.audit.AuditService;
import com.xbeeant.reqora.server.auth.PrincipalLoader;
import com.xbeeant.reqora.server.common.AuthUser;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.CurrentUser;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.project.ProjectAccess;
import com.xbeeant.reqora.server.project.ProjectCapability;
import com.xbeeant.reqora.server.project.ProjectEntity;
import com.xbeeant.reqora.server.project.ProjectMapper;
import com.xbeeant.reqora.server.project.ProjectRole;
import com.xbeeant.reqora.server.user.UserEntity;
import com.xbeeant.reqora.server.user.UserMapper;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class MemberService {

    private final ProjectMemberMapper memberMapper;
    private final ProjectMapper projectMapper;
    private final UserMapper userMapper;
    private final ProjectAccess projectAccess;
    private final PrincipalLoader principalLoader;
    private final AuditService auditService;

    public MemberService(
            ProjectMemberMapper memberMapper,
            ProjectMapper projectMapper,
            UserMapper userMapper,
            ProjectAccess projectAccess,
            PrincipalLoader principalLoader,
            AuditService auditService) {
        this.memberMapper = memberMapper;
        this.projectMapper = projectMapper;
        this.userMapper = userMapper;
        this.projectAccess = projectAccess;
        this.principalLoader = principalLoader;
        this.auditService = auditService;
    }

    public List<MemberDtos.MemberView> list(long projectId) {
        projectAccess.require(projectId, ProjectCapability.MEMBER_READ);
        List<ProjectMemberEntity> members = memberMapper.selectList(
                new LambdaQueryWrapper<ProjectMemberEntity>()
                        .eq(ProjectMemberEntity::getProjectId, projectId)
                        .orderByAsc(ProjectMemberEntity::getId));
        if (members.isEmpty()) {
            return List.of();
        }
        // One batched user query instead of one query per member.
        List<Long> userIds = members.stream().map(ProjectMemberEntity::getUserId).distinct().toList();
        Map<Long, UserEntity> users = new HashMap<>();
        userMapper.selectBatchIds(userIds).forEach(user -> users.put(user.getId(), user));
        List<MemberDtos.MemberView> rows = new ArrayList<>();
        for (ProjectMemberEntity member : members) {
            UserEntity user = users.get(member.getUserId());
            rows.add(new MemberDtos.MemberView(
                    member.getId(),
                    member.getUserId(),
                    user == null ? "(已删除)" : user.getUsername(),
                    user == null ? "" : user.getEmail(),
                    user == null ? "" : user.getDisplayName(),
                    member.getMemberRole(),
                    member.getCreatedAt()));
        }
        return rows;
    }

    @Transactional
    public MemberDtos.MemberView add(long projectId, MemberDtos.AddMemberRequest request) {
        projectAccess.require(projectId, ProjectCapability.MEMBER_WRITE);
        ProjectRole target = checkedRole(request.role());
        if (target == ProjectRole.OWNER) {
            throw new BizException(ErrorCode.BAD_REQUEST, "请使用 owner 转让接口");
        }
        preventPrivilegeEscalation(projectId, target);
        UserEntity user = principalLoader.byUsername(request.username());
        if (user == null) {
            throw BizException.notFound("用户");
        }
        if (memberMapper.selectCount(new LambdaQueryWrapper<ProjectMemberEntity>()
                .eq(ProjectMemberEntity::getProjectId, projectId)
                .eq(ProjectMemberEntity::getUserId, user.getId())) > 0) {
            throw new BizException(ErrorCode.CONFLICT, "该用户已是项目成员");
        }
        ProjectMemberEntity member = new ProjectMemberEntity();
        member.setProjectId(projectId);
        member.setUserId(user.getId());
        member.setMemberRole(target.name());
        member.setCreatedBy(CurrentUser.requireId());
        memberMapper.insert(member);
        auditService.record("member.add", "project", projectId,
                "添加成员 " + user.getUsername() + " (" + target + ")");
        return new MemberDtos.MemberView(member.getId(), user.getId(), user.getUsername(),
                user.getEmail(), user.getDisplayName(), target.name(), member.getCreatedAt());
    }

    @Transactional
    public MemberDtos.MemberView changeRole(long projectId, long userId, MemberDtos.UpdateMemberRequest request) {
        projectAccess.require(projectId, ProjectCapability.MEMBER_WRITE);
        ProjectRole target = checkedRole(request.role());
        if (target == ProjectRole.OWNER) {
            throw new BizException(ErrorCode.BAD_REQUEST, "请使用 owner 转让接口");
        }
        AuthUser actor = CurrentUser.require();
        if (actor.id().equals(userId)) {
            throw new BizException(ErrorCode.CONFLICT, "不能修改自己的项目角色");
        }
        preventPrivilegeEscalation(projectId, target);
        ProjectMemberEntity member = requireMember(projectId, userId);
        if (ProjectRole.OWNER.name().equals(member.getMemberRole())) {
            throw new BizException(ErrorCode.CONFLICT, "不能降级 owner，请先转让");
        }
        member.setMemberRole(target.name());
        memberMapper.updateById(member);
        auditService.record("member.role", "project", projectId,
                "成员 " + userId + " 角色改为 " + target);
        UserEntity user = userMapper.selectById(userId);
        return new MemberDtos.MemberView(member.getId(), userId,
                user == null ? "" : user.getUsername(), user == null ? "" : user.getEmail(),
                user == null ? "" : user.getDisplayName(), target.name(), member.getCreatedAt());
    }

    @Transactional
    public void remove(long projectId, long userId) {
        projectAccess.require(projectId, ProjectCapability.MEMBER_WRITE);
        ProjectMemberEntity member = requireMember(projectId, userId);
        if (ProjectRole.OWNER.name().equals(member.getMemberRole())) {
            throw new BizException(ErrorCode.CONFLICT, "不能移除项目 owner");
        }
        memberMapper.deleteById(member.getId());
        auditService.record("member.remove", "project", projectId, "移除成员 " + userId);
    }

    @Transactional
    public void transferOwner(long projectId, MemberDtos.TransferOwnerRequest request) {
        projectAccess.require(projectId, ProjectCapability.OWNER_TRANSFER);
        AuthUser actor = CurrentUser.require();
        ProjectRole role = projectAccess.roleOf(projectId, actor);
        if (!actor.superAdmin() && role != ProjectRole.OWNER) {
            throw new BizException(ErrorCode.FORBIDDEN, "仅项目 owner 可转让");
        }
        Long newOwnerId = request.userId();
        if (newOwnerId == null || newOwnerId.equals(actor.id())) {
            throw new BizException(ErrorCode.BAD_REQUEST, "请选择其他成员");
        }
        ProjectMemberEntity target = requireMember(projectId, newOwnerId);
        ProjectMemberEntity previous = memberMapper.selectOne(
                new LambdaQueryWrapper<ProjectMemberEntity>()
                        .eq(ProjectMemberEntity::getProjectId, projectId)
                        .eq(ProjectMemberEntity::getUserId, actor.id())
                        .last("LIMIT 1"));
        ProjectEntity project = projectMapper.selectById(projectId);
        project.setOwnerId(newOwnerId);
        projectMapper.updateById(project);
        target.setMemberRole(ProjectRole.OWNER.name());
        memberMapper.updateById(target);
        if (previous != null) {
            previous.setMemberRole(ProjectRole.ADMIN.name());
            memberMapper.updateById(previous);
        }
        auditService.record("member.transfer", "project", projectId, "owner 转让给 " + newOwnerId);
    }

    private ProjectRole checkedRole(String raw) {
        try {
            return ProjectRole.parse(raw);
        } catch (IllegalArgumentException ex) {
            throw new BizException(ErrorCode.BAD_REQUEST, ex.getMessage());
        }
    }

    /** A member may never grant a role higher than their own (super admins excluded). */
    private void preventPrivilegeEscalation(long projectId, ProjectRole target) {
        AuthUser actor = CurrentUser.require();
        if (actor.superAdmin()) {
            return;
        }
        ProjectRole current = projectAccess.roleOf(projectId, actor);
        if (current == null || target.rank() > current.rank()) {
            throw new BizException(ErrorCode.FORBIDDEN, "不能授予高于自身的项目角色");
        }
    }

    private ProjectMemberEntity requireMember(long projectId, long userId) {
        ProjectMemberEntity member = memberMapper.selectOne(
                new LambdaQueryWrapper<ProjectMemberEntity>()
                        .eq(ProjectMemberEntity::getProjectId, projectId)
                        .eq(ProjectMemberEntity::getUserId, userId)
                        .last("LIMIT 1"));
        if (member == null) {
            throw BizException.notFound("项目成员");
        }
        return member;
    }
}
