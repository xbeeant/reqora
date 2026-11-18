package com.xbeeant.reqora.server.identity;

import java.sql.PreparedStatement;
import java.sql.Statement;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Component;

/**
 * All SQL for the identity layer. JdbcTemplate keeps the new tables out of the
 * MyBatis-Plus entity/mapper tree and makes the "only hashes are persisted"
 * invariant easy to audit in one file.
 */
@Component
public class IdentityStore {

    private final JdbcTemplate jdbc;

    public IdentityStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record ExternalBinding(
            long id, long userId, String providerId, String providerType,
            String subject, String email, String displayName) {}

    public record SsoSession(
            long id, String providerId, String providerType, String redirectUri,
            String codeVerifier, String nonce, String requestId) {}

    public record PatRow(
            long id, String name, String scopes, LocalDateTime expiresAt,
            LocalDateTime lastUsedAt, LocalDateTime revokedAt, LocalDateTime createdAt) {}

    // ------------------------------------------------------------- external identities ----

    public ExternalBinding findExternal(String providerId, String subject) {
        List<ExternalBinding> rows = jdbc.query(
                "SELECT id, user_id, provider_id, provider_type, subject, email, display_name "
                        + "FROM sys_external_identity WHERE provider_id = ? AND subject = ? LIMIT 1",
                (rs, n) -> new ExternalBinding(
                        rs.getLong("id"), rs.getLong("user_id"), rs.getString("provider_id"),
                        rs.getString("provider_type"), rs.getString("subject"),
                        rs.getString("email"), rs.getString("display_name")),
                providerId, subject);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public void bindExternal(String providerId, String type, String subject, long userId,
                             String email, String displayName) {
        jdbc.update("INSERT IGNORE INTO sys_external_identity "
                        + "(provider_id, provider_type, subject, user_id, email, display_name) "
                        + "VALUES (?, ?, ?, ?, ?, ?)",
                providerId, type, subject, userId, email, displayName);
    }

    public void touchExternal(long id) {
        jdbc.update("UPDATE sys_external_identity SET last_login_at = CURRENT_TIMESTAMP(3) WHERE id = ?", id);
    }

    public void updateExternalProfile(long id, String email, String displayName) {
        jdbc.update("UPDATE sys_external_identity SET email = ?, display_name = ? WHERE id = ?",
                email, displayName, id);
    }

    public void deleteExternal(long id) {
        jdbc.update("DELETE FROM sys_external_identity WHERE id = ?", id);
    }

    // ------------------------------------------------------------------------- users ----

    public Long findUserIdByEmail(String email) {
        if (email == null || email.isBlank()) {
            return null;
        }
        List<Long> rows = jdbc.query(
                "SELECT id FROM sys_user WHERE email = ? LIMIT 1", (rs, n) -> rs.getLong(1), email);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public Long findUserIdByUsername(String username) {
        List<Long> rows = jdbc.query(
                "SELECT id FROM sys_user WHERE username = ? LIMIT 1",
                (rs, n) -> rs.getLong(1), username);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public boolean usernameExists(String username) {
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM sys_user WHERE username = ?", Integer.class, username);
        return count != null && count > 0;
    }

    public long createUser(String username, String email, String displayName, String passwordHash) {
        KeyHolder holder = new GeneratedKeyHolder();
        jdbc.update(connection -> {
            PreparedStatement ps = connection.prepareStatement(
                    "INSERT INTO sys_user (username, email, password_hash, display_name, status) "
                            + "VALUES (?, ?, ?, ?, 1)",
                    Statement.RETURN_GENERATED_KEYS);
            ps.setString(1, username);
            ps.setString(2, email);
            ps.setString(3, passwordHash);
            ps.setString(4, displayName == null ? "" : displayName);
            return ps;
        }, holder);
        if (holder.getKey() == null) {
            throw new IllegalStateException("创建用户未返回主键");
        }
        return holder.getKey().longValue();
    }

    public Map<String, Object> user(long id) {
        List<Map<String, Object>> rows = jdbc.query(
                "SELECT id, username, email, display_name, status, created_at FROM sys_user WHERE id = ?",
                (rs, n) -> {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("id", rs.getLong("id"));
                    row.put("username", rs.getString("username"));
                    row.put("email", rs.getString("email"));
                    row.put("displayName", rs.getString("display_name"));
                    row.put("status", rs.getInt("status"));
                    row.put("createdAt", rs.getTimestamp("created_at").toLocalDateTime());
                    return row;
                }, id);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public Integer userStatus(long id) {
        List<Integer> rows = jdbc.query(
                "SELECT status FROM sys_user WHERE id = ?", (rs, n) -> rs.getInt(1), id);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public void setUserStatus(long id, int status) {
        jdbc.update("UPDATE sys_user SET status = ? WHERE id = ?", status, id);
    }

    public void updateUserProfile(long id, String email, String displayName) {
        jdbc.update("UPDATE sys_user SET email = ?, display_name = ? WHERE id = ?",
                email, displayName, id);
    }

    public Long roleId(String code) {
        List<Long> rows = jdbc.query(
                "SELECT id FROM sys_role WHERE code = ? LIMIT 1", (rs, n) -> rs.getLong(1), code);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public void grantRole(long userId, long roleId) {
        jdbc.update("INSERT IGNORE INTO sys_user_role (user_id, role_id) VALUES (?, ?)",
                userId, roleId);
    }

    public void hardDeleteUser(long userId) {
        jdbc.update("DELETE FROM sys_external_identity WHERE user_id = ?", userId);
        jdbc.update("DELETE FROM sys_personal_access_token WHERE user_id = ?", userId);
        jdbc.update("DELETE FROM sys_user_role WHERE user_id = ?", userId);
        jdbc.update("DELETE FROM auth_refresh_token WHERE user_id = ?", userId);
        jdbc.update("DELETE FROM sys_user WHERE id = ?", userId);
    }

    public void deleteExternalForUser(long userId) {
        jdbc.update("DELETE FROM sys_external_identity WHERE user_id = ?", userId);
    }

    public void revokeAllRefreshTokens(long userId) {
        jdbc.update("UPDATE auth_refresh_token SET revoked_at = CURRENT_TIMESTAMP(3) "
                + "WHERE user_id = ? AND revoked_at IS NULL", userId);
    }

    /** Whitelisted column lookup for SCIM filters; never interpolates user input into SQL. */
    public String userColumn(String key) {
        return switch (key) {
            case "userName", "username" -> "username";
            case "emails.value", "email" -> "email";
            case "displayName" -> "display_name";
            case "id" -> "id";
            default -> null;
        };
    }

    public List<Map<String, Object>> searchUsers(String column, String value, int limit, int offset) {
        String where = column == null ? "" : " WHERE " + column + " = ?";
        Object[] args = column == null
                ? new Object[] {limit, offset}
                : new Object[] {value, limit, offset};
        return jdbc.query(
                "SELECT id, username, email, display_name, status, created_at FROM sys_user"
                        + where + " ORDER BY id LIMIT ? OFFSET ?",
                (rs, n) -> {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("id", rs.getLong("id"));
                    row.put("username", rs.getString("username"));
                    row.put("email", rs.getString("email"));
                    row.put("displayName", rs.getString("display_name"));
                    row.put("status", rs.getInt("status"));
                    row.put("createdAt", rs.getTimestamp("created_at").toLocalDateTime());
                    return row;
                }, args);
    }

    public int countUsers(String column, String value) {
        String where = column == null ? "" : " WHERE " + column + " = ?";
        Object[] args = column == null ? new Object[0] : new Object[] {value};
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM sys_user" + where, Integer.class, args);
        return count == null ? 0 : count;
    }

    // ------------------------------------------------------------------ SSO sessions ----

    public void saveSession(String stateHash, String providerId, String type, String redirectUri,
                            String verifier, String nonce, String requestId, LocalDateTime expiresAt) {
        jdbc.update("INSERT INTO sys_sso_session (state_hash, provider_id, provider_type, "
                        + "redirect_uri, code_verifier, nonce, request_id, expires_at) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                stateHash, providerId, type, redirectUri, verifier, nonce, requestId, expiresAt);
    }

    /** Atomically burns a one-shot state. Returns null on replay / expiry / unknown state. */
    public SsoSession consumeSession(String stateHash) {
        int burned = jdbc.update("UPDATE sys_sso_session SET used_at = CURRENT_TIMESTAMP(3) "
                        + "WHERE state_hash = ? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)",
                stateHash);
        if (burned != 1) {
            return null;
        }
        List<SsoSession> rows = jdbc.query(
                "SELECT id, provider_id, provider_type, redirect_uri, code_verifier, nonce, request_id "
                        + "FROM sys_sso_session WHERE state_hash = ?",
                (rs, n) -> new SsoSession(
                        rs.getLong("id"), rs.getString("provider_id"), rs.getString("provider_type"),
                        rs.getString("redirect_uri"), rs.getString("code_verifier"),
                        rs.getString("nonce"), rs.getString("request_id")),
                stateHash);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public record SessionLookup(String stateHash, String providerId, String providerType) {}

    /** Read-only lookup for SAML InResponseTo; the state is burned only after signature checks. */
    public SessionLookup findSessionByRequestId(String requestId) {
        List<SessionLookup> rows = jdbc.query(
                "SELECT state_hash, provider_id, provider_type FROM sys_sso_session "
                        + "WHERE request_id = ? AND used_at IS NULL "
                        + "AND expires_at > CURRENT_TIMESTAMP(3) LIMIT 1",
                (rs, n) -> new SessionLookup(rs.getString("state_hash"),
                        rs.getString("provider_id"), rs.getString("provider_type")),
                requestId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public void purgeExpiredSessions() {
        jdbc.update("DELETE FROM sys_sso_session "
                + "WHERE expires_at < CURRENT_TIMESTAMP(3) - INTERVAL 1 DAY");
    }

    // --------------------------------------------------------------------------- PAT ----

    public long createPat(long userId, String name, String tokenHash, String scopes,
                          LocalDateTime expiresAt) {
        KeyHolder holder = new GeneratedKeyHolder();
        jdbc.update(connection -> {
            PreparedStatement ps = connection.prepareStatement(
                    "INSERT INTO sys_personal_access_token "
                            + "(user_id, name, token_hash, scopes, expires_at) VALUES (?, ?, ?, ?, ?)",
                    Statement.RETURN_GENERATED_KEYS);
            ps.setLong(1, userId);
            ps.setString(2, name);
            ps.setString(3, tokenHash);
            ps.setString(4, scopes);
            ps.setObject(5, expiresAt);
            return ps;
        }, holder);
        return holder.getKey() == null ? 0L : holder.getKey().longValue();
    }

    public List<PatRow> listPats(long userId) {
        return jdbc.query("SELECT id, name, scopes, expires_at, last_used_at, revoked_at, created_at "
                        + "FROM sys_personal_access_token WHERE user_id = ? ORDER BY id DESC",
                (rs, n) -> new PatRow(
                        rs.getLong("id"), rs.getString("name"), rs.getString("scopes"),
                        rs.getTimestamp("expires_at").toLocalDateTime(),
                        timestamp(rs.getTimestamp("last_used_at")),
                        timestamp(rs.getTimestamp("revoked_at")),
                        rs.getTimestamp("created_at").toLocalDateTime()),
                userId);
    }

    private LocalDateTime timestamp(java.sql.Timestamp value) {
        return value == null ? null : value.toLocalDateTime();
    }

    public int activePatCount(long userId) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM sys_personal_access_token "
                        + "WHERE user_id = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)",
                Integer.class, userId);
        return count == null ? 0 : count;
    }

    public boolean revokePat(long userId, long id) {
        return jdbc.update("UPDATE sys_personal_access_token SET revoked_at = CURRENT_TIMESTAMP(3) "
                + "WHERE id = ? AND user_id = ? AND revoked_at IS NULL", id, userId) == 1;
    }

    /** Returns the owning user id and marks usage; null when expired / revoked / unknown. */
    public Long consumePat(String tokenHash) {
        int used = jdbc.update("UPDATE sys_personal_access_token "
                        + "SET last_used_at = CURRENT_TIMESTAMP(3) WHERE token_hash = ? "
                        + "AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)",
                tokenHash);
        if (used != 1) {
            return null;
        }
        List<Long> rows = jdbc.query(
                "SELECT user_id FROM sys_personal_access_token WHERE token_hash = ?",
                (rs, n) -> rs.getLong(1), tokenHash);
        return rows.isEmpty() ? null : rows.get(0);
    }

    // ------------------------------------------------------------------ SCIM groups ----

    public Map<String, Object> group(long id) {
        List<Map<String, Object>> rows = jdbc.query(
                "SELECT id, external_id, display_name, members FROM sys_scim_group WHERE id = ?",
                (rs, n) -> groupRow(rs.getLong("id"), rs.getString("external_id"),
                        rs.getString("display_name"), rs.getString("members")), id);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public Map<String, Object> groupByExternalId(String externalId) {
        List<Map<String, Object>> rows = jdbc.query(
                "SELECT id, external_id, display_name, members FROM sys_scim_group WHERE external_id = ?",
                (rs, n) -> groupRow(rs.getLong("id"), rs.getString("external_id"),
                        rs.getString("display_name"), rs.getString("members")), externalId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public List<Map<String, Object>> groups(int limit, int offset) {
        return jdbc.query("SELECT id, external_id, display_name, members FROM sys_scim_group "
                        + "ORDER BY id LIMIT ? OFFSET ?",
                (rs, n) -> groupRow(rs.getLong("id"), rs.getString("external_id"),
                        rs.getString("display_name"), rs.getString("members")), limit, offset);
    }

    public int groupCount() {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM sys_scim_group", Integer.class);
        return count == null ? 0 : count;
    }

    private Map<String, Object> groupRow(long id, String externalId, String displayName, String members) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", id);
        row.put("externalId", externalId);
        row.put("displayName", displayName);
        List<Long> parsed = new ArrayList<>();
        try {
            for (com.fasterxml.jackson.databind.JsonNode node : IdentityCrypto.JSON.readTree(members)) {
                parsed.add(node.asLong());
            }
        } catch (Exception ignored) {
            // A malformed member list degrades to an empty group rather than a 500.
        }
        row.put("members", parsed);
        return row;
    }

    public long createGroup(String externalId, String displayName, List<Long> members) {
        KeyHolder holder = new GeneratedKeyHolder();
        jdbc.update(connection -> {
            PreparedStatement ps = connection.prepareStatement(
                    "INSERT INTO sys_scim_group (external_id, display_name, members) VALUES (?, ?, ?)",
                    Statement.RETURN_GENERATED_KEYS);
            ps.setString(1, externalId);
            ps.setString(2, displayName);
            ps.setString(3, IdentityCrypto.JSON.valueToTree(members).toString());
            return ps;
        }, holder);
        return holder.getKey() == null ? 0L : holder.getKey().longValue();
    }

    public void updateGroup(long id, String displayName, List<Long> members) {
        jdbc.update("UPDATE sys_scim_group SET display_name = ?, members = ? WHERE id = ?",
                displayName, IdentityCrypto.JSON.valueToTree(members).toString(), id);
    }

    public void deleteGroup(long id) {
        jdbc.update("DELETE FROM sys_scim_group WHERE id = ?", id);
    }
}
