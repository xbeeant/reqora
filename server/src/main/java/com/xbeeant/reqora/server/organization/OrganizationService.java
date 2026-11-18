package com.xbeeant.reqora.server.organization;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xbeeant.reqora.server.audit.AuditService;
import com.xbeeant.reqora.server.common.AuthUser;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.CurrentUser;
import com.xbeeant.reqora.server.common.ErrorCode;
import java.time.LocalDateTime;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class OrganizationService {

    private final OrganizationMapper organizationMapper;
    private final OrgMemberMapper memberMapper;
    private final AuditService auditService;

    public OrganizationService(
            OrganizationMapper organizationMapper,
            OrgMemberMapper memberMapper,
            AuditService auditService) {
        this.organizationMapper = organizationMapper;
        this.memberMapper = memberMapper;
        this.auditService = auditService;
    }

    @Transactional
    public OrgDtos.OrgView create(OrgDtos.CreateOrgRequest request) {
        AuthUser actor = CurrentUser.require();
        String slug = request.slug().trim().toLowerCase();
        if (organizationMapper.selectCount(new LambdaQueryWrapper<OrganizationEntity>()
                .eq(OrganizationEntity::getSlug, slug)) > 0) {
            throw new BizException(ErrorCode.CONFLICT, "组织标识 slug 已被使用");
        }

        OrganizationEntity org = new OrganizationEntity();
        org.setName(request.name().trim());
        org.setSlug(slug);
        org.setDescription(request.description() == null ? "" : request.description());
        org.setOwnerId(actor.id());
        org.setStatus("ACTIVE");
        organizationMapper.insert(org);

        OrgMemberEntity owner = new OrgMemberEntity();
        owner.setOrgId(org.getId());
        owner.setUserId(actor.id());
        owner.setRole(OrgRole.OWNER.name());
        owner.setCreatedAt(LocalDateTime.now());
        memberMapper.insert(owner);

        auditService.record("org.create", "organization", org.getId(), "创建组织 " + slug);
        return view(org, OrgRole.OWNER.name());
    }

    public List<OrgDtos.OrgView> mine() {
        AuthUser actor = CurrentUser.require();
        List<Long> ids = memberMapper.selectOrgIdsByUserId(actor.id());
        if (ids == null || ids.isEmpty()) return List.of();
        return organizationMapper.selectBatchIds(ids).stream()
                .map(org -> view(org, roleName(org.getId(), actor.id())))
                .toList();
    }

    public OrgDtos.OrgView get(long orgId) {
        AuthUser actor = CurrentUser.require();
        return view(requireOrg(orgId), requireRole(orgId, actor).name());
    }

    public List<OrgDtos.OrgMemberView> members(long orgId) {
        AuthUser actor = CurrentUser.require();
        requireOrg(orgId);
        requireRole(orgId, actor);
        return memberMapper.selectMemberRows(orgId).stream()
                .map(row -> new OrgDtos.OrgMemberView(
                        ((Number) row.get("user_id")).longValue(),
                        String.valueOf(row.get("username")),
                        String.valueOf(row.get("display_name") == null ? "" : row.get("display_name")),
                        String.valueOf(row.get("role")),
                        String.valueOf(row.get("joined_at"))))
                .toList();
    }

    @Transactional
    public void leave(long orgId) {
        AuthUser actor = CurrentUser.require();
        OrganizationEntity org = requireOrg(orgId);
        requireRole(orgId, actor);
        if (org.getOwnerId() != null && org.getOwnerId().equals(actor.id())) {
            throw new BizException(ErrorCode.CONFLICT, "组织所有者不能退出组织");
        }
        memberMapper.delete(new LambdaQueryWrapper<OrgMemberEntity>()
                .eq(OrgMemberEntity::getOrgId, orgId)
                .eq(OrgMemberEntity::getUserId, actor.id()));
        auditService.record("org.leave", "organization", orgId, "退出组织");
    }

    public OrganizationEntity requireOrg(long orgId) {
        OrganizationEntity org = organizationMapper.selectById(orgId);
        if (org == null) throw BizException.notFound("组织");
        return org;
    }

    public OrgRole requireRole(long orgId, AuthUser actor) {
        if (actor.superAdmin()) return OrgRole.OWNER;
        String role = memberMapper.selectRole(orgId, actor.id());
        if (role == null) throw new BizException(ErrorCode.FORBIDDEN, "你不是该组织成员");
        return OrgRole.parse(role);
    }

    public void requireManage(long orgId) {
        if (!requireRole(orgId, CurrentUser.require()).canManage()) {
            throw new BizException(ErrorCode.FORBIDDEN, "需要组织管理员权限");
        }
    }

    private String roleName(long orgId, long userId) {
        String role = memberMapper.selectRole(orgId, userId);
        return role == null ? OrgRole.MEMBER.name() : role;
    }

    private OrgDtos.OrgView view(OrganizationEntity org, String role) {
        return new OrgDtos.OrgView(
                org.getId(),
                org.getName(),
                org.getSlug(),
                org.getDescription(),
                org.getOwnerId(),
                role,
                org.getStatus(),
                org.getCreatedAt());
    }
}
