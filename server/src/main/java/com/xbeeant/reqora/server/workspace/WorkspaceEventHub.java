package com.xbeeant.reqora.server.workspace;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.http.MediaType;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * Per-project SSE fan-out for workspace version changes.
 *
 * Clients cannot use the browser EventSource API because the access token is
 * kept in memory and must be sent as an Authorization header; the desktop
 * client therefore consumes this stream with fetch() + ReadableStream.
 */
@Component
public class WorkspaceEventHub {

    private static final long EMITTER_TIMEOUT_MS = 300_000L;
    /** Self-contained: this app exposes no global ObjectMapper bean. */
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final Map<Long, Set<SseEmitter>> subscribers = new ConcurrentHashMap<>();

    public SseEmitter subscribe(long projectId, long currentVersion) {
        SseEmitter emitter = new SseEmitter(EMITTER_TIMEOUT_MS);
        Set<SseEmitter> group =
                subscribers.computeIfAbsent(projectId, key -> ConcurrentHashMap.newKeySet());
        group.add(emitter);
        Runnable remove = () -> {
            group.remove(emitter);
            if (group.isEmpty()) subscribers.remove(projectId, group);
        };
        emitter.onCompletion(remove);
        emitter.onTimeout(() -> {
            remove.run();
            emitter.complete();
        });
        emitter.onError(error -> remove.run());

        try {
            emitter.send(SseEmitter.event()
                    .name("connected")
                    .data(payload("connected", projectId, currentVersion, null),
                            MediaType.APPLICATION_JSON));
        } catch (IOException error) {
            remove.run();
            emitter.completeWithError(error);
        }
        return emitter;
    }

    /** Called by the controller after the write transaction has committed. */
    public void publish(long projectId, long version, String checksum) {
        Set<SseEmitter> group = subscribers.get(projectId);
        if (group == null || group.isEmpty()) return;
        String payload = payload("workspace", projectId, version, checksum);
        for (SseEmitter emitter : group) {
            try {
                emitter.send(SseEmitter.event()
                        .name("workspace")
                        .data(payload, MediaType.APPLICATION_JSON));
            } catch (Exception error) {
                group.remove(emitter);
                try {
                    emitter.complete();
                } catch (Exception ignored) {
                    // already closed
                }
            }
        }
        if (group.isEmpty()) subscribers.remove(projectId, group);
    }

    /** Keep proxies from closing an idle stream. */
    @Scheduled(fixedDelay = 20_000)
    public void heartbeat() {
        for (Set<SseEmitter> group : subscribers.values()) {
            for (SseEmitter emitter : group) {
                try {
                    emitter.send(SseEmitter.event().name("ping").data("{}"));
                } catch (Exception error) {
                    group.remove(emitter);
                }
            }
        }
    }

    /** Package-visible so the wire format is unit-testable without a servlet container. */
    static String payload(String type, long projectId, long version, String checksum) {
        try {
            return MAPPER.writeValueAsString(Map.of(
                    "type", type,
                    "projectId", projectId,
                    "version", version,
                    "checksum", checksum == null ? "" : checksum));
        } catch (JsonProcessingException error) {
            return "{\"type\":\"" + type + "\",\"projectId\":" + projectId
                    + ",\"version\":" + version + "}";
        }
    }
}
