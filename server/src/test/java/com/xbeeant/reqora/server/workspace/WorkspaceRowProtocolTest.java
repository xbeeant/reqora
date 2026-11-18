package com.xbeeant.reqora.server.workspace;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.ErrorCode;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Row-protocol semantics without a database: merge decision + JSON field-name
 * compatibility with the TypeScript payload (src/lib/workspaceRows.ts).
 */
class WorkspaceRowProtocolTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void serverRowWinsOnlyWhenStrictlyNewer() {
        // Equal timestamps keep the stored row (idempotent re-sync).
        assertFalse(WorkspaceService.serverRowWins(1000L, 1000L));
        assertFalse(WorkspaceService.serverRowWins(2000L, 1000L));
        assertTrue(WorkspaceService.serverRowWins(1000L, 2000L));
        // Missing stored timestamp (null) always loses to any incoming row.
        assertTrue(WorkspaceService.serverRowWins(null, 1L));
        assertTrue(WorkspaceService.serverRowWins(null, 0L));
    }

    @Test
    void overlongScalarColumnsFailAsBadRequest() {
        WorkspaceRowEntity row = new WorkspaceRowEntity();
        row.setId("r1");
        row.setFolderPath("a".repeat(513));
        BizException error = assertThrows(
                BizException.class, () -> WorkspaceService.validateScalarLengths(row));
        assertEquals(ErrorCode.BAD_REQUEST, error.error());

        WorkspaceRowEntity ok = new WorkspaceRowEntity();
        ok.setId("r1");
        ok.setFolderPath("a".repeat(512));
        ok.setCaseGroup("正向");
        WorkspaceService.validateScalarLengths(ok);
    }

    @Test
    void tieBreaksTowardsDeletion() {
        // Newer always wins, regardless of the deletion flag.
        assertTrue(WorkspaceService.shouldReplaceRow(1000L, true, 2000L, false, true));
        assertTrue(WorkspaceService.shouldReplaceRow(1000L, false, 2000L, true, true));
        assertFalse(WorkspaceService.shouldReplaceRow(2000L, false, 1000L, true, true));
        // Equal timestamps: tombstone beats a live row.
        assertTrue(WorkspaceService.shouldReplaceRow(1000L, false, 1000L, true, true));
        // ...but a live row never resurrects a tombstone on a tie.
        assertFalse(WorkspaceService.shouldReplaceRow(1000L, true, 1000L, false, true));
        // Tombstone vs tombstone tie: keep the stored one.
        assertFalse(WorkspaceService.shouldReplaceRow(1000L, true, 1000L, true, true));
        // Missing stored timestamp always yields to the incoming row.
        assertTrue(WorkspaceService.shouldReplaceRow(null, false, 0L, true, true));
    }

    @Test
    void liveVsLiveTieIsAdjudicatedByReceiptOrder() {
        // 平局 + 内容相同 = 幂等重传：跳过（rowVersion 稳定，不重复出现在增量）。
        assertFalse(WorkspaceService.shouldReplaceRow(1000L, false, 1000L, false, true));
        // 平局 + 内容不同 = 接收序裁决：后来者胜（最新到达即最新意图），
        // 不再静默保留先到的版本。
        assertTrue(WorkspaceService.shouldReplaceRow(1000L, false, 1000L, false, false));
    }

    @Test
    void sameRowContentIgnoresBookkeepingColumns() {
        WorkspaceRowEntity a = new WorkspaceRowEntity();
        a.setId("r1");
        a.setKind("request");
        a.setName("登录");
        a.setMethod("POST");
        a.setUrl("{{base}}/login");
        a.setPosition(0);
        a.setData("{\"headers\":[]}");
        a.setCreatedAt(LocalDateTime.now());
        a.setSyncedAt(LocalDateTime.now());
        a.setRowVersion(7L);
        a.setUpdatedAt(1000L);

        // 记账列（createdAt/syncedAt/rowVersion/updatedAt）不影响内容相等。
        WorkspaceRowEntity b = new WorkspaceRowEntity();
        b.setId("r1");
        b.setKind("request");
        b.setName("登录");
        b.setMethod("POST");
        b.setUrl("{{base}}/login");
        b.setPosition(0);
        b.setData("{\"headers\":[]}");
        b.setCreatedAt(LocalDateTime.now().plusHours(1));
        b.setSyncedAt(LocalDateTime.now().plusHours(1));
        b.setRowVersion(99L);
        b.setUpdatedAt(1000L);
        assertTrue(WorkspaceService.sameRowContent(a, b));

        // 业务列任一变化即内容不同。
        b.setName("登录（改）");
        assertFalse(WorkspaceService.sameRowContent(a, b));
        b.setName("登录");
        b.setData("{\"headers\":[{\"key\":\"X\"}]}");
        assertFalse(WorkspaceService.sameRowContent(a, b));
    }

    @Test
    void extractBlobHashesFindsReferences() {
        String data = "{\"__blob\":\"ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789\","
                + "\"size\":10,\"nested\":{\"note\":\"\\\"__blob\\\":\\\"not-a-hash\\\"\"},"
                + "\"other\":{\"__blob\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"}}";
        Set<String> hashes = WorkspaceService.extractBlobHashes(data);
        assertEquals(2, hashes.size());
        assertTrue(hashes.contains("abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"));
        assertTrue(hashes.contains("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"));
        assertTrue(WorkspaceService.extractBlobHashes(null).isEmpty());
        assertTrue(WorkspaceService.extractBlobHashes("{}").isEmpty());
        // 非法长度 / 非 hex 不匹配。
        assertTrue(WorkspaceService.extractBlobHashes("{\"__blob\":\"xyz\"}").isEmpty());
    }

    @Test
    void syncRequestFieldNamesMatchTypeScriptPayload() throws Exception {
        String json = """
                {
                  "folders": [{"id":"c1","updatedAt":10,"deleted":false,"name":"集合","auth":{"type":"bearer","token":""},"position":0}],
                  "requests": [{"id":"r1","updatedAt":11,"deleted":false,"folderId":"c1","folderPath":"a/b","name":"登录",
                     "method":"POST","url":"{{baseUrl}}/login","protocol":"http","position":0,
                     "data":{"headers":[{"key":"Authorization","value":""}]}}],
                  "environments": [],
                  "cases": [{"id":"k1","updatedAt":12,"deleted":false,"requestId":"r1","caseGroup":"正向","name":"用例","enabled":true,"data":{}}],
                  "scenarios": [],
                  "suites": [],
                  "artifacts": [{"id":"d1","updatedAt":13,"deleted":false,"kind":"docPage","name":"快速开始","position":0,"data":{}}],
                  "meta": {"seeded":true,"activeEnvironmentId":"e1","settings":{"timeoutSecs":30}}
                }
                """;
        WorkspaceRowDtos.SyncRequest request =
                mapper.readValue(json, WorkspaceRowDtos.SyncRequest.class);
        assertEquals(1, request.folders().size());
        assertEquals("c1", request.folders().get(0).id());
        assertEquals("bearer", request.folders().get(0).auth().get("type"));
        assertEquals("c1", request.requests().get(0).folderId());
        assertEquals("a/b", request.requests().get(0).folderPath());
        assertEquals("正向", request.cases().get(0).caseGroup());
        assertEquals("r1", request.cases().get(0).requestId());
        assertEquals("docPage", request.artifacts().get(0).kind());
        assertEquals(30, request.meta().settings().get("timeoutSecs"));

        // Round trip keeps the wire names the desktop client expects.
        String back = mapper.writeValueAsString(request);
        assertTrue(back.contains("\"folderId\""));
        assertTrue(back.contains("\"caseGroup\""));
        assertTrue(back.contains("\"updatedAt\""));

        WorkspaceRowDtos.RowsResponse response = new WorkspaceRowDtos.RowsResponse(
                1L, 3L, true, request.folders(), request.requests(), request.environments(),
                request.cases(), request.scenarios(), request.suites(), request.artifacts(),
                new WorkspaceRowDtos.MetaRow(true, "e1", Map.of()));
        String responseJson = mapper.writeValueAsString(response);
        WorkspaceRowDtos.RowsResponse parsed =
                mapper.readValue(responseJson, WorkspaceRowDtos.RowsResponse.class);
        assertEquals(3L, parsed.version());
        assertTrue(parsed.full(), "plain GET /rows 必须标记 full=true");
        assertEquals(1, parsed.requests().size());
        assertFalse(parsed.requests().get(0).deleted());
    }

    @Test
    void tombstonesSurviveRoundTrip() throws Exception {
        String json = """
                {"id":"r9","updatedAt":99,"deleted":true,"folderId":"c1","folderPath":"","name":"已删除",
                 "method":"GET","url":"http://x","protocol":"http","position":0,"data":{}}
                """;
        WorkspaceRowDtos.RequestRow row = mapper.readValue(json, WorkspaceRowDtos.RequestRow.class);
        assertTrue(row.deleted(), "软删标记必须保留，才能把删除传播到其它端");
    }

    @Test
    void missingOptionalFieldsDefaultSafely() throws Exception {
        String json = """
                {"id":"c2","updatedAt":5,"name":"集合"}
                """;
        WorkspaceRowDtos.FolderRow row = mapper.readValue(json, WorkspaceRowDtos.FolderRow.class);
        assertNull(row.deleted());
        assertEquals(0, row.position());
        assertEquals(List.of(), List.of());
    }
}
