package com.xbeeant.reqora.server.common;

import org.slf4j.MDC;

/** Uniform response envelope for every REST endpoint. */
public record ApiResponse<T>(int code, String message, T data, String requestId, long timestamp) {

    public static <T> ApiResponse<T> ok(T data) {
        return new ApiResponse<>(0, "ok", data, MDC.get(RequestIdFilter.MDC_KEY), System.currentTimeMillis());
    }

    public static <T> ApiResponse<T> fail(ErrorCode error, String message) {
        return new ApiResponse<>(
                error.code(),
                message == null || message.isBlank() ? error.defaultMessage() : message,
                null,
                MDC.get(RequestIdFilter.MDC_KEY),
                System.currentTimeMillis());
    }
}
