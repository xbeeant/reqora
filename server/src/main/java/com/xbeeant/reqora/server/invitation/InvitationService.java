package com.xbeeant.reqora.server.invitation;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xbeeant.reqora.server.audit.AuditService;
import com.xbeeant.reqora.server.common.AuthUser;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.CurrentUser;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.organization.OrgMemberEntity;
import com.xbeeant.reqora.server.organization.OrgMemberMapper;
import com.xbeeant.reqora.server.organization.OrgRole;
import com.xbeeant.reqora.server.organization.OrganizationEntity;
import com.xbeeant.reqora.server.organization.OrganizationService;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.LocalDateTime;
import java.util.Base64;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class InvitationService {

    private static final SecureRandom RANDOM = new SecureRandom();

    private final InvitationMapper invitationMapper;
    private final OrgMemberMapper memberMapper;
    private final OrganizationService organizationService;
    private final AuditService auditService;

    public InvitationService(
            InvitationMapper invitationMapper,
            OrgMemberMapper memberMapper,
            OrganizationService organizationService,
            AuditService auditService) {
        this.invitationMapper = invitationMapper;
        this.memberMapper = memberMapper;
        this.organizationService = organizationService;
        this.auditService = auditService;
    }

    @Transactional
    public InviteDtos.CreateInviteResponse create(long orgId, InviteDtos.CreateInviteRequest request) {
        AuthUser actor = CurrentUser.require();
        organizationService.requireManage(orgId);
        OrgRole ownRole = organizationService.requireRole(orgId, actor);
        OrgRole targetRole = parseRole(request.role());
        if (!actor.superAdmin() && targetRole.rank() > ownRole.rank()) {
            throw new BizException(ErrorCode.FORBIDDEN, "不能创建高于自身组织角色的邀请");
        }

        int maxUses = request.maxUses() == null ? 10 : request.maxUses();
        long hours = request.expiresInHours() == null ? 168 : request.expiresInHours();
        String token = newToken();

        InvitationEntity invite = new InvitationEntity();
        invite.setOrgId(orgId);
        invite.setTokenHash(hash(token));
        invite.setRole(targetRole.name());
        invite.setLabel(request.label() == null ? "" : request.label().trim());
        invite.setInvitedBy(actor.id());
        invite.setExpiresAt(LocalDateTime.now().plusHours(hours));
        invite.setMaxUses(maxUses);
        invite.setUsedCount(0);
        invite.setStatus("ACTIVE");
        invitationMapper.insert(invite);

        auditService.record("org.invite.create", "organization", orgId, "创建邀请链接");
        return new InviteDtos.CreateInviteResponse(view(invite), token);
    }

    public List<InviteDtos.InviteView> list(long orgId) {
        organizationService.requireManage(orgId);
        return invitationMapper.selectList(new LambdaQueryWrapper<InvitationEntity>()
                        .eq(InvitationEntity::getOrgId, orgId)
                        .orderByDesc(InvitationEntity::getId))
                .stream()
                .map(this::view)
                .toList();
    }

    @Transactional
    public void revoke(long orgId, long inviteId) {
        organizationService.requireManage(orgId);
        InvitationEntity invite = invitationMapper.selectById(inviteId);
        if (invite == null || !invite.getOrgId().equals(orgId)) {
            throw BizException.notFound("邀请");
        }
        invite.setStatus("REVOKED");
        invitationMapper.updateById(invite);
        auditService.record("org.invite.revoke", "organization", orgId, "撤销邀请 " + inviteId);
    }

    @Transactional
    public InviteDtos.AcceptResponse accept(String rawToken) {
        AuthUser actor = CurrentUser.require();
        InvitationEntity invite = invitationMapper.selectOne(new LambdaQueryWrapper<InvitationEntity>()
                .eq(InvitationEntity::getTokenHash, hash(rawToken))
                .last("LIMIT 1"));
        if (invite == null || !"ACTIVE".equals(invite.getStatus())) {
            throw new BizException(ErrorCode.TOKEN_INVALID, "邀请链接无效或已被撤销");
        }
        if (invite.getExpiresAt() == null || invite.getExpiresAt().isBefore(LocalDateTime.now())) {
            invite.setStatus("EXPIRED");
            invitationMapper.updateById(invite);
            throw new BizException(ErrorCode.TOKEN_INVALID, "邀请链接已过期");
        }
        int used = invite.getUsedCount() == null ? 0 : invite.getUsedCount();
        if (used >= invite.getMaxUses()) {
            throw new BizException(ErrorCode.CONFLICT, "邀请链接使用次数已用完");
        }
        if (memberMapper.selectRole(invite.getOrgId(), actor.id()) != null) {
            throw new BizException(ErrorCode.CONFLICT, "你已经是该组织成员");
        }

        OrgMemberEntity member = new OrgMemberEntity();
        member.setOrgId(invite.getOrgId());
        member.setUserId(actor.id());
        member.setRole(invite.getRole());
        member.setCreatedAt(LocalDateTime.now());
        memberMapper.insert(member);

        invite.setUsedCount(used + 1);
        if (used + 1 >= invite.getMaxUses()) invite.setStatus("EXPIRED");
        invitationMapper.updateById(invite);

        OrganizationEntity org = organizationService.requireOrg(invite.getOrgId());
        auditService.record("org.invite.accept", "organization", org.getId(), "通过邀请加入组织");
        return new InviteDtos.AcceptResponse(org.getId(), org.getName(), invite.getRole());
    }

    /** SHA-256 hex digest — the raw token is never stored. */
    static String hash(String raw) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(raw.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder(digest.length * 2);
            for (byte value : digest) out.append(String.format("%02x", value));
            return out.toString();
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 不可用", error);
        }
    }

    private static String newToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static OrgRole parseRole(String value) {
        if (value == null || value.isBlank()) return OrgRole.MEMBER;
        try {
            return OrgRole.parse(value);
        } catch (IllegalArgumentException error) {
            throw new BizException(ErrorCode.BAD_REQUEST, "未知的组织角色: " + value);
        }
    }

    private InviteDtos.InviteView view(InvitationEntity invite) {
        return new InviteDtos.InviteView(
                invite.getId(),
                invite.getOrgId(),
                invite.getRole(),
                invite.getLabel(),
                invite.getExpiresAt(),
                invite.getMaxUses(),
                invite.getUsedCount(),
                invite.getStatus(),
                invite.getCreatedAt());
    }
}
