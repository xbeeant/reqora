package com.xbeeant.reqora.server.common;

import org.springframework.http.HttpStatus;

/**
 * Typed application error codes. HTTP status stays meaningful for API clients.
 *
 * <p>{@code messageKey} addresses the bundles under resources/i18n/common_*.properties;
 * {@code defaultMessage} is the Chinese fallback used before Spring's MessageSource is ready
 * (startup validation, plain unit tests).
 */
public enum ErrorCode {
    BAD_REQUEST(1001, HttpStatus.BAD_REQUEST, "error.bad_request", "请求参数不合法"),
    UNAUTHENTICATED(1002, HttpStatus.UNAUTHORIZED, "error.unauthenticated", "未登录或登录已失效"),
    FORBIDDEN(1003, HttpStatus.FORBIDDEN, "error.forbidden", "没有权限执行此操作"),
    NOT_FOUND(1004, HttpStatus.NOT_FOUND, "error.not_found", "资源不存在"),
    CONFLICT(1005, HttpStatus.CONFLICT, "error.conflict", "资源状态冲突"),
    RATE_LIMITED(1006, HttpStatus.TOO_MANY_REQUESTS, "error.rate_limited", "请求过于频繁，请稍后再试"),
    BAD_CREDENTIALS(1007, HttpStatus.UNAUTHORIZED, "error.bad_credentials", "用户名或密码错误"),
    TOKEN_INVALID(1008, HttpStatus.UNAUTHORIZED, "error.token_invalid", "令牌无效或已过期"),
    VERSION_CONFLICT(1009, HttpStatus.CONFLICT, "error.version_conflict", "云端数据已被他人更新，请先拉取再上传"),
    PAYLOAD_TOO_LARGE(1010, HttpStatus.PAYLOAD_TOO_LARGE, "error.payload_too_large", "数据体积超过限制"),
    ACCOUNT_DISABLED(1011, HttpStatus.FORBIDDEN, "error.account_disabled", "账号已被停用"),
    INTERNAL(5000, HttpStatus.INTERNAL_SERVER_ERROR, "error.internal", "服务内部错误，请稍后重试");

    private final int code;
    private final HttpStatus status;
    private final String messageKey;
    private final String defaultMessage;

    ErrorCode(int code, HttpStatus status, String messageKey, String defaultMessage) {
        this.code = code;
        this.status = status;
        this.messageKey = messageKey;
        this.defaultMessage = defaultMessage;
    }

    public int code() {
        return code;
    }

    public HttpStatus status() {
        return status;
    }

    public String messageKey() {
        return messageKey;
    }

    public String defaultMessage() {
        return defaultMessage;
    }
}
