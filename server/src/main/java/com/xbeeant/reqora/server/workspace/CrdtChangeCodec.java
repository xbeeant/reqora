package com.xbeeant.reqora.server.workspace;

import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.ErrorCode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Function;

/**
 * Pure helpers for the v2 change log. Kept free of Spring/DB dependencies so
 * idempotency, cursor and payload-limit rules can be unit tested directly.
 */
public final class CrdtChangeCodec {

    /** Per-change ceiling; a single Automerge change is normally a few KB. */
    public static final int MAX_CHANGE_BYTES = 8 * 1024 * 1024;
    public static final int MAX_PAGE_SIZE = 1000;

    private CrdtChangeCodec() {
    }

    public static String encode(byte[] bytes) {
        return Base64.getEncoder().encodeToString(bytes);
    }

    /** Decode a base64 payload, rejecting empty / oversized / malformed input. */
    public static byte[] decode(String encoded, int maxBytes) {
        if (encoded == null || encoded.isBlank()) {
            throw new BizException(ErrorCode.BAD_REQUEST, "CRDT change payload is empty");
        }
        final byte[] bytes;
        try {
            bytes = Base64.getDecoder().decode(encoded);
        } catch (IllegalArgumentException error) {
            throw new BizException(ErrorCode.BAD_REQUEST, "CRDT change payload is not valid base64");
        }
        if (bytes.length == 0) {
            throw new BizException(ErrorCode.BAD_REQUEST, "CRDT change payload is empty");
        }
        if (bytes.length > maxBytes) {
            throw new BizException(ErrorCode.PAYLOAD_TOO_LARGE,
                    "CRDT change exceeds " + maxBytes + " bytes");
        }
        return bytes;
    }

    /** SHA-256 hex, used when a client omits the Automerge hash. */
    public static String sha256Hex(byte[] bytes) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder out = new StringBuilder(digest.length * 2);
            for (byte value : digest) {
                out.append(Character.forDigit((value >> 4) & 0xf, 16));
                out.append(Character.forDigit(value & 0xf, 16));
            }
            return out.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    public static boolean isValidHash(String hash) {
        if (hash == null || hash.length() != 64) {
            return false;
        }
        for (int i = 0; i < hash.length(); i += 1) {
            char c = hash.charAt(i);
            boolean hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
            if (!hex) {
                return false;
            }
        }
        return true;
    }

    /** First occurrence wins; order is preserved so seq follows submission order. */
    public static <T> List<T> dedupe(List<T> items, Function<T, String> hashOf) {
        List<T> unique = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (T item : items) {
            if (seen.add(hashOf.apply(item))) {
                unique.add(item);
            }
        }
        return unique;
    }

    /** Cursor never moves backwards, including when the page is empty. */
    public static long cursorAfter(long since, List<Long> seqs) {
        long cursor = Math.max(0L, since);
        for (Long seq : seqs) {
            if (seq != null && seq > cursor) {
                cursor = seq;
            }
        }
        return cursor;
    }

    public static int pageSize(int requested) {
        if (requested <= 0) {
            return 500;
        }
        return Math.min(requested, MAX_PAGE_SIZE);
    }

    public static String headsJson(List<String> heads) {
        if (heads == null || heads.isEmpty()) {
            return "[]";
        }
        StringBuilder out = new StringBuilder("[");
        for (int i = 0; i < heads.size(); i += 1) {
            if (i > 0) {
                out.append(',');
            }
            out.append('"').append(escapeJson(heads.get(i))).append('"');
        }
        return out.append(']').toString();
    }

    private static String escapeJson(String raw) {
        if (raw == null) {
            return "";
        }
        return new String(raw.getBytes(StandardCharsets.UTF_8), StandardCharsets.UTF_8)
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r");
    }
}
