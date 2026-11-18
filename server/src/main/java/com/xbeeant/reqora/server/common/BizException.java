package com.xbeeant.reqora.server.common;

/** Business rule violation; always mapped to a normalized client-facing error. */
public class BizException extends RuntimeException {

    private final ErrorCode error;

    public BizException(ErrorCode error) {
        super(Messages.get(error));
        this.error = error;
    }

    public BizException(ErrorCode error, String message) {
        super(message);
        this.error = error;
    }

    public static BizException notFound(String what) {
        return new BizException(ErrorCode.NOT_FOUND, what + "不存在");
    }

    public ErrorCode error() {
        return error;
    }
}
