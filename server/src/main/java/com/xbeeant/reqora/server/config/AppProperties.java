package com.xbeeant.reqora.server.config;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Duration;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/** All runtime configuration lives here; validation happens at startup (fail fast). */
@Validated
@ConfigurationProperties(prefix = "app")
public class AppProperties {

    @Valid
    @NotNull
    private Security security = new Security();

    @Valid
    @NotNull
    private Cors cors = new Cors();

    @Valid
    @NotNull
    private Bootstrap bootstrap = new Bootstrap();

    @Valid
    @NotNull
    private Workspace workspace = new Workspace();

    public Security getSecurity() {
        return security;
    }

    public void setSecurity(Security security) {
        this.security = security;
    }

    public Cors getCors() {
        return cors;
    }

    public void setCors(Cors cors) {
        this.cors = cors;
    }

    public Bootstrap getBootstrap() {
        return bootstrap;
    }

    public void setBootstrap(Bootstrap bootstrap) {
        this.bootstrap = bootstrap;
    }

    public Workspace getWorkspace() {
        return workspace;
    }

    public void setWorkspace(Workspace workspace) {
        this.workspace = workspace;
    }

    public static class Security {
        @NotBlank
        @Size(min = 32, message = "JWT 密钥至少 32 个字符")
        private String jwtSecret;

        @NotNull
        private Duration accessTokenTtl = Duration.ofMinutes(15);

        @NotNull
        private Duration refreshTokenTtl = Duration.ofDays(7);

        public String getJwtSecret() {
            return jwtSecret;
        }

        public void setJwtSecret(String jwtSecret) {
            this.jwtSecret = jwtSecret;
        }

        public Duration getAccessTokenTtl() {
            return accessTokenTtl;
        }

        public void setAccessTokenTtl(Duration accessTokenTtl) {
            this.accessTokenTtl = accessTokenTtl;
        }

        public Duration getRefreshTokenTtl() {
            return refreshTokenTtl;
        }

        public void setRefreshTokenTtl(Duration refreshTokenTtl) {
            this.refreshTokenTtl = refreshTokenTtl;
        }
    }

    public static class Cors {
        @NotEmpty
        private List<String> allowedOrigins;

        public List<String> getAllowedOrigins() {
            return allowedOrigins;
        }

        public void setAllowedOrigins(List<String> allowedOrigins) {
            this.allowedOrigins = allowedOrigins;
        }
    }

    public static class Bootstrap {
        @NotBlank
        private String adminUsername;

        @NotBlank
        @Email
        private String adminEmail;

        @NotBlank
        @Size(min = 8, message = "初始管理员口令至少 8 位")
        private String adminPassword;

        public String getAdminUsername() {
            return adminUsername;
        }

        public void setAdminUsername(String adminUsername) {
            this.adminUsername = adminUsername;
        }

        public String getAdminEmail() {
            return adminEmail;
        }

        public void setAdminEmail(String adminEmail) {
            this.adminEmail = adminEmail;
        }

        public String getAdminPassword() {
            return adminPassword;
        }

        public void setAdminPassword(String adminPassword) {
            this.adminPassword = adminPassword;
        }
    }

    public static class Workspace {
        @Min(1024)
        @Max(52428800)
        private long maxBytes = 5_242_880L;

        /** 单个内容寻址对象的大小上限（大字段外置用）。 */
        @Min(65536)
        @Max(1073741824)
        private long maxObjectBytes = 52_428_800L;

        /**
         * 墓碑 compaction 保留天数：软删行超过该时长后物理清除，防止墓碑
         * 永久累积拖胖全量响应。回收到 watermark 版本，cursor 落后于水位
         * 的客户端（离线超过保留期）会收到一次全量拉取补齐。&lt;=0 关闭。
         */
        @Min(0)
        @Max(3650)
        private long tombstoneRetentionDays = 90;

        /**
         * blob 孤儿对象宽限期（小时）：无任何行引用且超过该时长的对象可
         * 回收。宽限期保护「对象已上传、引用行尚未送达」的中间态。&lt;=0 关闭。
         */
        @Min(0)
        @Max(87600)
        private long objectGraceHours = 168;

        public long getMaxBytes() {
            return maxBytes;
        }

        public void setMaxBytes(long maxBytes) {
            this.maxBytes = maxBytes;
        }

        public long getMaxObjectBytes() {
            return maxObjectBytes;
        }

        public void setMaxObjectBytes(long maxObjectBytes) {
            this.maxObjectBytes = maxObjectBytes;
        }

        public long getTombstoneRetentionDays() {
            return tombstoneRetentionDays;
        }

        public void setTombstoneRetentionDays(long tombstoneRetentionDays) {
            this.tombstoneRetentionDays = tombstoneRetentionDays;
        }

        public long getObjectGraceHours() {
            return objectGraceHours;
        }

        public void setObjectGraceHours(long objectGraceHours) {
            this.objectGraceHours = objectGraceHours;
        }
    }
}
