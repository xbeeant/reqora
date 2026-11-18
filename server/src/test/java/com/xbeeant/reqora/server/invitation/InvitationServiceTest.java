package com.xbeeant.reqora.server.invitation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class InvitationServiceTest {

    @Test
    void hashIsStableLowercaseSha256Hex() {
        String hash = InvitationService.hash("invite-token-1");
        assertEquals(64, hash.length());
        assertTrue(hash.matches("[0-9a-f]{64}"));
        assertEquals(hash, InvitationService.hash("invite-token-1"));
        assertNotEquals(hash, InvitationService.hash("invite-token-2"));
    }

    @Test
    void knownSha256VectorMatches() {
        assertEquals(
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                InvitationService.hash("abc"));
    }
}
