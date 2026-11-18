package com.xbeeant.reqora.server.workspace;

import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.project.ProjectAccess;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.dao.DuplicateKeyException;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.when;

/**
 * v2 change-log semantics without a database: idempotency by content hash,
 * monotonic cursor, bootstrap race handling, payload limits and ordering.
 */
class CrdtChangeLogTest {

    private final CrdtSnapshotMapper snapshotMapper = Mockito.mock(CrdtSnapshotMapper.class);
    private final CrdtChangeMapper changeMapper = Mockito.mock(CrdtChangeMapper.class);
    private final ProjectAccess projectAccess = Mockito.mock(ProjectAccess.class);
    private final CrdtSyncService service = new CrdtSyncService(
            snapshotMapper, changeMapper, projectAccess);

    private static CrdtSyncDtos.ChangeItem item(String content) {
        return new CrdtSyncDtos.ChangeItem(
                null, CrdtChangeCodec.encode(content.getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    void payloadDecodeRejectsMalformedEmptyAndOversizedInput() {
        BizException malformed = assertThrows(BizException.class,
                () -> CrdtChangeCodec.decode("not-base64!!!", 1024));
        assertEquals(ErrorCode.BAD_REQUEST, malformed.error());
        assertThrows(BizException.class, () -> CrdtChangeCodec.decode("", 1024));
        BizException tooLarge = assertThrows(BizException.class,
                () -> CrdtChangeCodec.decode(CrdtChangeCodec.encode(new byte[8]), 4));
        assertEquals(ErrorCode.PAYLOAD_TOO_LARGE, tooLarge.error());
        assertArrayEquals("ok".getBytes(StandardCharsets.UTF_8),
                CrdtChangeCodec.decode(CrdtChangeCodec.encode("ok".getBytes(StandardCharsets.UTF_8)), 1024));
    }

    @Test
    void contentHashIsStableAndDistinguishesChanges() {
        String a = CrdtChangeCodec.sha256Hex("change-a".getBytes(StandardCharsets.UTF_8));
        String b = CrdtChangeCodec.sha256Hex("change-b".getBytes(StandardCharsets.UTF_8));
        assertEquals(64, a.length());
        assertTrue(CrdtChangeCodec.isValidHash(a));
        assertEquals(a, CrdtChangeCodec.sha256Hex("change-a".getBytes(StandardCharsets.UTF_8)));
        assertNotEquals(a, b);
        assertFalse(CrdtChangeCodec.isValidHash("xyz"));
        assertFalse(CrdtChangeCodec.isValidHash(null));
    }

    @Test
    void dedupeKeepsFirstOccurrenceAndInsertionOrder() {
        List<String> hashes = List.of("h1", "h2", "h1", "h3", "h2");
        assertEquals(List.of("h1", "h2", "h3"),
                CrdtChangeCodec.dedupe(hashes, value -> value));
    }

    @Test
    void cursorNeverMovesBackwardsAndHandlesEmptyPages() {
        assertEquals(0L, CrdtChangeCodec.cursorAfter(0L, List.of()));
        assertEquals(7L, CrdtChangeCodec.cursorAfter(7L, List.of()));
        assertEquals(9L, CrdtChangeCodec.cursorAfter(7L, List.of(8L, 9L)));
        assertEquals(7L, CrdtChangeCodec.cursorAfter(7L, List.of(3L, 5L)));
        assertEquals(500, CrdtChangeCodec.pageSize(0));
        assertEquals(1000, CrdtChangeCodec.pageSize(9999));
    }

    @Test
    void duplicateChangeIsReportedButNeverInsertedTwice() {
        when(changeMapper.insert(Mockito.<CrdtChangeEntity>any())).thenThrow(new DuplicateKeyException("duplicate hash"));
        CrdtSyncDtos.PostChangesResponse replay = service.appendChanges(
                7L, List.of(item("same-change")), 1L);
        assertTrue(replay.accepted().isEmpty());
        assertEquals(1, replay.duplicates().size());
    }

    @Test
    void repeatedHashInsideOneRequestCountsAsDuplicate() {
        when(changeMapper.insert(Mockito.<CrdtChangeEntity>any())).thenReturn(1);
        CrdtSyncDtos.PostChangesResponse result = service.appendChanges(
                7L, List.of(item("same-change"), item("same-change")), 1L);
        assertEquals(1, result.accepted().size());
        assertEquals(1, result.duplicates().size());
        Mockito.verify(changeMapper, Mockito.times(1))
                .insert(Mockito.<CrdtChangeEntity>any());
    }

    @Test
    void concurrentGenesisCreationKeepsTheWinner() {
        CrdtSnapshotEntity winner = new CrdtSnapshotEntity();
        winner.setProjectId(7L);
        winner.setGenesis("winner-genesis".getBytes(StandardCharsets.UTF_8));
        winner.setHeads("[]");
        winner.setSnapshotSeq(0L);
        when(snapshotMapper.selectById(7L)).thenReturn(null, winner);
        when(snapshotMapper.insert(Mockito.<CrdtSnapshotEntity>any())).thenThrow(new DuplicateKeyException("race"));
        CrdtSyncDtos.BootstrapResponse response = service.createGenesis(
                7L, CrdtChangeCodec.encode("my-genesis".getBytes(StandardCharsets.UTF_8)));
        assertArrayEquals(winner.getGenesis(),
                java.util.Base64.getDecoder().decode(response.genesis()));
        assertNull(response.snapshot());
    }

    @Test
    void bootstrapWithoutGenesisAsksClientToCreateOne() {
        when(snapshotMapper.selectById(7L)).thenReturn(null);
        CrdtSyncDtos.BootstrapResponse response = service.bootstrap(7L);
        assertNull(response.genesis());
        assertNull(response.snapshot());
        assertEquals(0L, response.cursor());
    }

    @Test
    void bootstrapParsesStoredHeadsWithoutAnInjectedObjectMapper() {
        CrdtSnapshotEntity snapshot = new CrdtSnapshotEntity();
        snapshot.setProjectId(7L);
        snapshot.setGenesis("genesis".getBytes(StandardCharsets.UTF_8));
        snapshot.setHeads(CrdtChangeCodec.headsJson(List.of("head-a", "head-b")));
        when(snapshotMapper.selectById(7L)).thenReturn(snapshot);
        assertEquals(List.of("head-a", "head-b"), service.bootstrap(7L).heads());

        snapshot.setHeads("{broken");
        assertTrue(service.bootstrap(7L).heads().isEmpty());
    }
}
