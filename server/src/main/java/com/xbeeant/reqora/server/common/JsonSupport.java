package com.xbeeant.reqora.server.common;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/** Internal JSON codec (JWT payload + workspace snapshot), independent of the MVC JSON stack. */
public final class JsonSupport {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private JsonSupport() {}

    public static String stringify(Object value) {
        try {
            return MAPPER.writeValueAsString(value);
        } catch (JsonProcessingException ex) {
            throw new IllegalArgumentException("JSON 序列化失败", ex);
        }
    }

    public static boolean isObject(String json) {
        try {
            return MAPPER.readTree(json.getBytes(StandardCharsets.UTF_8)).isObject();
        } catch (Exception ex) {
            return false;
        }
    }

    public static Map<String, Object> toMap(String json) {
        try {
            return MAPPER.readValue(json.getBytes(StandardCharsets.UTF_8),
                    new TypeReference<Map<String, Object>>() {});
        } catch (Exception ex) {
            throw new IllegalArgumentException("JSON 解析失败", ex);
        }
    }
}
