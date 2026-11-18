package com.xbeeant.reqora.server.common;

import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.MDC;

/** Writes the standard error envelope for security-layer failures (before MVC is involved). */
public final class SecurityErrorWriter {

    private SecurityErrorWriter() {}

    public static void write(HttpServletResponse response, ErrorCode error, String message) throws IOException {
        response.setStatus(error.status().value());
        response.setCharacterEncoding("UTF-8");
        response.setContentType("application/json");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", error.code());
        body.put("message", message == null || message.isBlank() ? error.defaultMessage() : message);
        body.put("data", null);
        body.put("requestId", MDC.get(RequestIdFilter.MDC_KEY));
        body.put("timestamp", System.currentTimeMillis());
        response.getWriter().write(JsonSupport.stringify(body));
    }
}
