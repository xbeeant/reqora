package com.xbeeant.reqora.server.workspace;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

class WorkspaceEventHubTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    void payloadContainsTypeProjectAndVersion() throws Exception {
        JsonNode node = MAPPER.readTree(WorkspaceEventHub.payload("workspace", 7, 12, "abc123"));
        assertEquals("workspace", node.get("type").asText());
        assertEquals(7, node.get("projectId").asLong());
        assertEquals(12, node.get("version").asLong());
        assertEquals("abc123", node.get("checksum").asText());
    }

    @Test
    void payloadToleratesMissingChecksum() throws Exception {
        JsonNode node = MAPPER.readTree(WorkspaceEventHub.payload("connected", 3, 0, null));
        assertEquals("connected", node.get("type").asText());
        assertEquals("", node.get("checksum").asText());
    }

    @Test
    void subscribePublishAndHeartbeatAreSafe() {
        WorkspaceEventHub hub = new WorkspaceEventHub();
        SseEmitter emitter = hub.subscribe(7, 3);
        assertNotNull(emitter);
        assertDoesNotThrow(() -> hub.publish(7, 4, "checksum"));
        assertDoesNotThrow(hub::heartbeat);
        emitter.complete();
    }

    @Test
    void publishingWithoutSubscribersIsANoop() {
        WorkspaceEventHub hub = new WorkspaceEventHub();
        assertDoesNotThrow(() -> hub.publish(999, 1, ""));
        assertDoesNotThrow(hub::heartbeat);
    }
}
