package com.xbeeant.reqora.server.common;

import java.util.List;

/** Page envelope; mirrors MyBatis-Plus IPage without leaking persistence types to clients. */
public record PageResult<T>(List<T> records, long total, long page, long size) {
}
