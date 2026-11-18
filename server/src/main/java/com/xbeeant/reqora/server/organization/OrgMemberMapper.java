package com.xbeeant.reqora.server.organization;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import java.util.List;
import java.util.Map;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

public interface OrgMemberMapper extends BaseMapper<OrgMemberEntity> {

    @Select("SELECT org_id FROM sys_org_member WHERE user_id = #{userId}")
    List<Long> selectOrgIdsByUserId(@Param("userId") long userId);

    @Select("SELECT role FROM sys_org_member WHERE org_id = #{orgId} AND user_id = #{userId} LIMIT 1")
    String selectRole(@Param("orgId") long orgId, @Param("userId") long userId);

    @Select("SELECT m.user_id AS user_id, u.username AS username, "
            + "u.display_name AS display_name, m.role AS role, m.created_at AS joined_at "
            + "FROM sys_org_member m JOIN sys_user u ON u.id = m.user_id "
            + "WHERE m.org_id = #{orgId} ORDER BY m.created_at")
    List<Map<String, Object>> selectMemberRows(@Param("orgId") long orgId);
}
