package com.xbeeant.reqora.server.audit;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import java.util.List;
import org.apache.ibatis.annotations.Select;

public interface AuditLogMapper extends BaseMapper<AuditLogEntity> {

    @Select("SELECT DISTINCT action FROM sys_audit_log ORDER BY action")
    List<String> selectDistinctActions();
}
