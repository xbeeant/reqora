package com.xbeeant.reqora.server.auth;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import java.time.LocalDateTime;
import lombok.Data;
import lombok.ToString;

@Data
@TableName("auth_refresh_token")
public class RefreshTokenEntity {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    /** Only the SHA-256 digest of the opaque token is stored. */
    @ToString.Exclude
    private String tokenHash;

    private LocalDateTime expiresAt;

    private LocalDateTime revokedAt;

    private LocalDateTime createdAt;

    private String createdIp;
}
