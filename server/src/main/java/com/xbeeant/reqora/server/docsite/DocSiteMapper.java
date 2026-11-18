package com.xbeeant.reqora.server.docsite;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Update;

public interface DocSiteMapper extends BaseMapper<DocSiteEntity> {

    /** Anonymous reads increment a counter only; never rewrite the (large) payload column. */
    @Update("UPDATE doc_site_share SET view_count = view_count + 1 WHERE id = #{id}")
    int incrementViewCount(@Param("id") long id);
}
