package com.xbeeant.reqora.server.auth;

import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.ErrorCode;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.stereotype.Component;

/**
 * In-process fixed-window limiter for login attempts. Production deployments should back this with
 * Redis (see docs/API.md hardening checklist); the interface stays the same.
 */
@Component
public class LoginRateLimiter {

    private static final long WINDOW_MS = 60_000L;
    private static final int MAX_ATTEMPTS = 10;

    private final ConcurrentHashMap<String, Window> windows = new ConcurrentHashMap<>();

    public void check(String key) {
        if (windows.size() > 10_000) {
            windows.clear();
        }
        long now = System.currentTimeMillis();
        Window window = windows.compute(key, (ignored, previous) -> {
            if (previous == null || now - previous.startedAt() >= WINDOW_MS) {
                return new Window(now, new AtomicLong(1));
            }
            previous.count().incrementAndGet();
            return previous;
        });
        if (window.count().get() > MAX_ATTEMPTS) {
            throw new BizException(ErrorCode.RATE_LIMITED);
        }
    }

    private record Window(long startedAt, AtomicLong count) {}
}
