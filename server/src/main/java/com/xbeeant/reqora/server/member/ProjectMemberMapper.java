package com.xbeeant.reqora.server.member;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import java.util.List;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

public interface ProjectMemberMapper extends BaseMapper<ProjectMemberEntity> {

    @Select("SELECT project_id FROM pm_project_member WHERE user_id = #{userId}")
    List<Long> selectProjectIdsByUserId(@Param("userId") long userId);
}
