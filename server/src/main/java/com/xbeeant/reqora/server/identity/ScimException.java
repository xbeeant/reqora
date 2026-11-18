package com.xbeeant.reqora.server.identity;

/** RFC 7644 error envelope payload; status is an HTTP code, scimType a SCIM error type. */
public class ScimException extends RuntimeException {

    private final int status;
    private final String scimType;

    public ScimException(int status, String scimType, String detail) {
        super(detail);
        this.status = status;
        this.scimType = scimType;
    }

    public int status() {
        return status;
    }

    public String scimType() {
        return scimType;
    }

    public static ScimException notFound(String what) {
        return new ScimException(404, "invalidValue", what + " 不存在");
    }

    public static ScimException conflict(String detail) {
        return new ScimException(409, "uniqueness", detail);
    }

    public static ScimException badRequest(String detail) {
        return new ScimException(400, "invalidValue", detail);
    }

    public static ScimException unauthorized() {
        return new ScimException(401, "invalidValue", "SCIM Bearer token 无效");
    }
}
