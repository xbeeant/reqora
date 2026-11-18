package com.xbeeant.reqora.server.workspace;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface WorkspaceMetaMapper extends BaseMapper<WorkspaceMetaEntity> {

    /** Row lock on the project's meta row; caller must run inside a transaction. */
    @Select("SELECT * FROM ws_workspace_meta WHERE project_id = #{projectId} FOR UPDATE")
    WorkspaceMetaEntity lockForProject(@Param("projectId") long projectId);
}
