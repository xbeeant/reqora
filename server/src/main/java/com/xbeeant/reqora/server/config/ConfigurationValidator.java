package com.xbeeant.reqora.server.config;

import jakarta.annotation.PostConstruct;
import java.net.URI;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/** Extra semantic checks that Bean Validation cannot express. Fails the startup, never degrades. */
@Component
public class ConfigurationValidator {

    private static final Logger log = LoggerFactory.getLogger(ConfigurationValidator.class);

    private final AppProperties properties;

    public ConfigurationValidator(AppProperties properties) {
        this.properties = properties;
    }

    @PostConstruct
    public void validate() {
        for (String origin : properties.getCors().getAllowedOrigins()) {
            if ("*".equals(origin.trim())) {
                throw new IllegalStateException("生产环境禁止 CORS 通配符，请配置显式来源白名单");
            }
            URI uri = URI.create(origin.trim());
            if (uri.getScheme() == null || uri.getHost() == null && !"tauri".equals(uri.getScheme())) {
                throw new IllegalStateException("非法 CORS 来源：" + origin);
            }
        }
        if (properties.getSecurity().getAccessTokenTtl().isZero()
                || properties.getSecurity().getAccessTokenTtl().isNegative()
                || properties.getSecurity().getRefreshTokenTtl().compareTo(
                        properties.getSecurity().getAccessTokenTtl()) <= 0) {
            throw new IllegalStateException("刷新令牌有效期必须大于访问令牌有效期");
        }
        if (properties.getSecurity().getJwtSecret().contains("replace-with")) {
            log.warn("检测到占位 JWT 密钥，仅供本地开发使用，生产环境必须替换为随机密钥");
        }
        log.info(
                "configuration accepted: corsOrigins={}, workspaceMaxBytes={}",
                properties.getCors().getAllowedOrigins().size(),
                properties.getWorkspace().getMaxBytes());
    }
}
