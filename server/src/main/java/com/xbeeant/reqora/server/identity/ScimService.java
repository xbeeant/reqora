package com.xbeeant.reqora.server.identity;

import com.fasterxml.jackson.databind.JsonNode;
import com.xbeeant.reqora.server.audit.AuditService;
import com.xbeeant.reqora.server.config.IdentityProperties;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

/**
 * SCIM 2.0 Users / Groups provisioning. Deliberately minimal: no bulk, no ETag,
 * no group-to-role auto mapping (see the support boundary in README). DELETE
 * soft-disables the local account unless allowHardDelete is explicitly enabled.
 */
@Service
public class ScimService {

    private static final String SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
    private static final String SCHEMA_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
    private static final String SCHEMA_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
    private static final String SCHEMA_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
    private static final Pattern FILTER = Pattern.compile(
            "^\\s*([A-Za-z][A-Za-z0-9.\\-]*)\\s+eq\\s+\"([^\"]*)\"\\s*$", Pattern.CASE_INSENSITIVE);

    private final IdentityProperties properties;
    private final IdentityStore store;
    private final PasswordEncoder passwordEncoder;
    private final AuditService auditService;

    public ScimService(IdentityProperties properties, IdentityStore store,
                       PasswordEncoder passwordEncoder, AuditService auditService) {
        this.properties = properties;
        this.store = store;
        this.passwordEncoder = passwordEncoder;
        this.auditService = auditService;
    }

    /** SCIM uses its own bearer token (hash-only config), not the local JWT. */
    public void guard(String authorization) {
        if (!properties.isEnabled() || !properties.getScim().isEnabled()) {
            throw ScimException.notFound("SCIM 服务");
        }
        if (authorization == null || !authorization.startsWith("Bearer ")) {
            throw ScimException.unauthorized();
        }
        String digest = IdentityCrypto.sha256Hex(authorization.substring(7).trim());
        for (String configured : properties.getScim().getTokenHashes()) {
            if (IdentityCrypto.constantTimeEquals(digest, configured.trim().toLowerCase())) {
                return;
            }
        }
        throw ScimException.unauthorized();
    }

    public Map<String, Object> serviceProviderConfig() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("schemas", List.of("urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"));
        out.put("documentationUri", "https://github.com/xbeeant/reqora/blob/main/docs/IDENTITY_AND_AUDIT.md");
        out.put("patch", Map.of("supported", true));
        out.put("bulk", Map.of("supported", false, "maxOperations", 0, "maxPayloadSize", 0));
        out.put("filter", Map.of("supported", true, "maxResults", properties.getScim().getMaxPageSize()));
        out.put("changePassword", Map.of("supported", false));
        out.put("sort", Map.of("supported", false));
        out.put("etag", Map.of("supported", false));
        out.put("authenticationSchemes", List.of(Map.of(
                "type", "oauthbearertoken", "name", "SCIM Bearer", "primary", true,
                "description", "仅保存令牌的 SHA-256 摘要")));
        return out;
    }

    public Map<String, Object> schemas() {
        return listResponse(List.of(
                Map.of("id", SCHEMA_USER, "name", "User"),
                Map.of("id", SCHEMA_GROUP, "name", "Group")));
    }

    public Map<String, Object> resourceTypes() {
        return listResponse(List.of(
                Map.of("id", "User", "schema", SCHEMA_USER, "endpoint", "/Users"),
                Map.of("id", "Group", "schema", SCHEMA_GROUP, "endpoint", "/Groups")));
    }

    // ---------------------------------------------------------------------------- Users ----

    public Map<String, Object> listUsers(String filter, int startIndex, int count) {
        int pageSize = Math.min(Math.max(count, 1), properties.getScim().getMaxPageSize());
        int offset = Math.max(startIndex - 1, 0);
        String column = null;
        String value = null;
        if (filter != null && !filter.isBlank()) {
            Matcher matcher = FILTER.matcher(filter);
            if (!matcher.matches()) {
                throw ScimException.badRequest("仅支持 attribute eq \"value\" 形式的 filter");
            }
            column = store.userColumn(matcher.group(1));
            if (column == null) {
                throw ScimException.badRequest("不支持的 filter 属性：" + matcher.group(1));
            }
            value = matcher.group(2);
        }
        List<Map<String, Object>> users = store.searchUsers(column, value, pageSize, offset);
        List<Map<String, Object>> resources = users.stream().map(this::userResource).toList();
        return paged(resources, store.countUsers(column, value), startIndex);
    }

    public Map<String, Object> createUser(JsonNode body) {
        String userName = text(body, "userName");
        if (userName == null || userName.isBlank()) {
            throw ScimException.badRequest("userName 必填");
        }
        if (store.usernameExists(userName)) {
            throw ScimException.conflict("userName 已存在：" + userName);
        }
        String email = firstEmail(body);
        if (email != null && store.findUserIdByEmail(email) != null) {
            throw ScimException.conflict("邮箱已被占用：" + email);
        }
        String displayName = displayName(body, userName);
        String externalId = text(body, "externalId");
        boolean active = !body.has("active") || body.path("active").asBoolean(true);
        long userId = store.createUser(userName,
                email == null ? userName + "@scim.local" : email,
                displayName,
                passwordEncoder.encode(UUID.randomUUID() + "-" + IdentityCrypto.randomToken(24)));
        Long roleId = store.roleId(properties.getDefaultRole());
        if (roleId != null) {
            store.grantRole(userId, roleId);
        }
        store.bindExternal("scim", "scim",
                externalId == null || externalId.isBlank() ? "user:" + userId : externalId,
                userId, email, displayName);
        if (!active) {
            store.setUserStatus(userId, 0);
        }
        auditService.record("scim.user.create", "user", userId,
                "SCIM 创建用户 userName=" + userName + " active=" + active, "scim");
        return userResource(store.user(userId));
    }

    public Map<String, Object> getUser(long id) {
        Map<String, Object> user = store.user(id);
        if (user == null) {
            throw ScimException.notFound("User");
        }
        return userResource(user);
    }

    public Map<String, Object> replaceUser(long id, JsonNode body) {
        Map<String, Object> current = requireUser(id);
        String userName = text(body, "userName");
        String email = firstEmail(body);
        String displayName = displayName(body, (String) current.get("username"));
        if (userName == null || userName.isBlank()) {
            throw ScimException.badRequest("userName 必填");
        }
        Long owner = store.findUserIdByUsername(userName);
        if (owner != null && owner != id) {
            throw ScimException.conflict("userName 已存在");
        }
        if (email != null) {
            Long emailOwner = store.findUserIdByEmail(email);
            if (emailOwner != null && emailOwner != id) {
                throw ScimException.conflict("邮箱已被占用");
            }
        }
        // Local usernames are immutable once created (other tables reference them).
        store.updateUserProfile(id, email == null ? (String) current.get("email") : email, displayName);
        boolean active = !body.has("active") || body.path("active").asBoolean(true);
        store.setUserStatus(id, active ? 1 : 0);
        auditService.record("scim.user.replace", "user", id, "SCIM 替换用户 active=" + active, "scim");
        return userResource(store.user(id));
    }

    public Map<String, Object> patchUser(long id, JsonNode body) {
        requireUser(id);
        if (!body.path("schemas").toString().contains(SCHEMA_PATCH)
                && !body.has("Operations")) {
            throw ScimException.badRequest("PATCH 需要 Operations 数组");
        }
        for (JsonNode operation : body.path("Operations")) {
            String op = operation.path("op").asText("replace").toLowerCase();
            String path = operation.path("path").asText("");
            JsonNode value = operation.path("value");
            if ("replace".equals(op) || "add".equals(op)) {
                applyUserPatch(id, path, op, value);
            } else if ("remove".equals(op)) {
                if ("active".equalsIgnoreCase(path)) {
                    store.setUserStatus(id, 0);
                }
            } else {
                throw ScimException.badRequest("不支持的 PATCH op：" + op);
            }
        }
        auditService.record("scim.user.patch", "user", id, "SCIM 增量更新用户", "scim");
        return userResource(store.user(id));
    }

    private void applyUserPatch(long id, String path, String op, JsonNode value) {
        if (path.isBlank() && value.isObject()) {
            // RFC 7644 allows a path-less replace with a partial object.
            value.fields().forEachRemaining(entry ->
                    applyUserPatch(id, entry.getKey(), op, entry.getValue()));
            return;
        }
        String normalized = path.replaceAll("^/", "").toLowerCase();
        if ("active".equals(normalized)) {
            boolean active = value.isBoolean() ? value.asBoolean() : "true".equalsIgnoreCase(value.asText());
            store.setUserStatus(id, active ? 1 : 0);
            if (!active) {
                store.revokeAllRefreshTokens(id);
            }
        } else if ("emails[value]".equals(normalized) || "emails.value".equals(normalized)
                || "emails".equals(normalized)) {
            String email = value.isArray() ? firstEmailFromNode(value)
                    : (value.isObject() ? value.path("value").asText(null) : value.asText(null));
            if (email != null) {
                Long owner = store.findUserIdByEmail(email);
                if (owner != null && owner != id) {
                    throw ScimException.conflict("邮箱已被占用");
                }
                Map<String, Object> current = store.user(id);
                store.updateUserProfile(id, email, (String) current.get("displayName"));
            }
        } else if ("displayname".equals(normalized) || "name.formatted".equals(normalized)) {
            Map<String, Object> current = store.user(id);
            store.updateUserProfile(id, (String) current.get("email"), value.asText(""));
        } else {
            throw ScimException.badRequest("不支持的 PATCH path：" + path);
        }
    }

    public void deleteUser(long id) {
        Map<String, Object> current = requireUser(id);
        if (properties.getScim().isAllowHardDelete()) {
            store.hardDeleteUser(id);
            auditService.record("scim.user.delete", "user", id,
                    "SCIM 物理删除用户 userName=" + current.get("username"), "scim");
        } else {
            store.setUserStatus(id, 0);
            store.revokeAllRefreshTokens(id);
            auditService.record("scim.user.deactivate", "user", id,
                    "SCIM 软停用用户 userName=" + current.get("username"), "scim");
        }
    }

    // --------------------------------------------------------------------------- Groups ----

    public Map<String, Object> listGroups(int startIndex, int count) {
        int pageSize = Math.min(Math.max(count, 1), properties.getScim().getMaxPageSize());
        List<Map<String, Object>> groups = store.groups(pageSize, Math.max(startIndex - 1, 0))
                .stream().map(this::groupResource).toList();
        return paged(groups, store.groupCount(), startIndex);
    }

    public Map<String, Object> createGroup(JsonNode body) {
        String displayName = text(body, "displayName");
        if (displayName == null || displayName.isBlank()) {
            throw ScimException.badRequest("displayName 必填");
        }
        String externalId = text(body, "externalId");
        String key = externalId == null || externalId.isBlank() ? displayName : externalId;
        if (store.groupByExternalId(key) != null) {
            throw ScimException.conflict("Group 已存在：" + key);
        }
        long id = store.createGroup(key, displayName, memberIds(body.path("members")));
        auditService.record("scim.group.create", "group", id,
                "SCIM 创建组 displayName=" + displayName, "scim");
        return groupResource(store.group(id));
    }

    public Map<String, Object> getGroup(long id) {
        Map<String, Object> group = store.group(id);
        if (group == null) {
            throw ScimException.notFound("Group");
        }
        return groupResource(group);
    }

    public Map<String, Object> patchGroup(long id, JsonNode body) {
        Map<String, Object> group = requireGroup(id);
        String displayName = (String) group.get("displayName");
        @SuppressWarnings("unchecked")
        List<Long> members = new ArrayList<>((List<Long>) group.get("members"));
        for (JsonNode operation : body.path("Operations")) {
            String op = operation.path("op").asText("add").toLowerCase();
            String path = operation.path("path").asText("").toLowerCase();
            JsonNode value = operation.path("value");
            if ("displayname".equals(path.replaceAll("^/", ""))) {
                displayName = value.asText(displayName);
            } else if (path.contains("members")) {
                List<Long> incoming = memberIds(value);
                if ("remove".equals(op)) {
                    members.removeAll(incoming);
                } else if ("replace".equals(op)) {
                    members = incoming;
                } else {
                    for (Long member : incoming) {
                        if (!members.contains(member)) {
                            members.add(member);
                        }
                    }
                }
            } else {
                throw ScimException.badRequest("不支持的 Group PATCH path：" + path);
            }
        }
        store.updateGroup(id, displayName, members);
        auditService.record("scim.group.patch", "group", id,
                "SCIM 增量更新组（不自动授予本地角色）", "scim");
        return groupResource(store.group(id));
    }

    public void deleteGroup(long id) {
        requireGroup(id);
        store.deleteGroup(id);
        auditService.record("scim.group.delete", "group", id, "SCIM 删除组", "scim");
    }

    // ------------------------------------------------------------------------- rendering ----

    private Map<String, Object> userResource(Map<String, Object> user) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("schemas", List.of(SCHEMA_USER));
        out.put("id", String.valueOf(user.get("id")));
        out.put("userName", user.get("username"));
        out.put("externalId", "scim:" + user.get("id"));
        out.put("name", Map.of("formatted", user.get("displayName")));
        out.put("emails", List.of(Map.of(
                "value", user.get("email"), "type", "work", "primary", true)));
        out.put("active", Integer.valueOf(1).equals(user.get("status")));
        out.put("groups", List.of());
        out.put("meta", Map.of(
                "resourceType", "User",
                "created", String.valueOf(user.get("createdAt")),
                "location", "/scim/v2/Users/" + user.get("id")));
        return out;
    }

    private Map<String, Object> groupResource(Map<String, Object> group) {
        @SuppressWarnings("unchecked")
        List<Long> members = (List<Long>) group.get("members");
        List<Map<String, Object>> rendered = members.stream()
                .map(id -> Map.<String, Object>of("value", String.valueOf(id),
                        "display", String.valueOf(id)))
                .toList();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("schemas", List.of(SCHEMA_GROUP));
        out.put("id", String.valueOf(group.get("id")));
        out.put("displayName", group.get("displayName"));
        out.put("externalId", group.get("externalId"));
        out.put("members", rendered);
        out.put("meta", Map.of("resourceType", "Group", "location",
                "/scim/v2/Groups/" + group.get("id")));
        return out;
    }

    private static Map<String, Object> listResponse(List<?> resources) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("schemas", List.of(SCHEMA_LIST));
        out.put("totalResults", resources.size());
        out.put("startIndex", 1);
        out.put("itemsPerPage", resources.size());
        out.put("Resources", resources);
        return out;
    }

    private static Map<String, Object> paged(List<Map<String, Object>> resources,
                                             int total, int startIndex) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("schemas", List.of(SCHEMA_LIST));
        out.put("totalResults", total);
        out.put("startIndex", Math.max(startIndex, 1));
        out.put("itemsPerPage", resources.size());
        out.put("Resources", resources);
        return out;
    }

    private Map<String, Object> requireUser(long id) {
        Map<String, Object> user = store.user(id);
        if (user == null) {
            throw ScimException.notFound("User");
        }
        return user;
    }

    private Map<String, Object> requireGroup(long id) {
        Map<String, Object> group = store.group(id);
        if (group == null) {
            throw ScimException.notFound("Group");
        }
        return group;
    }

    private static List<Long> memberIds(JsonNode value) {
        List<Long> out = new ArrayList<>();
        if (value == null || value.isNull()) {
            return out;
        }
        if (value.isArray()) {
            for (JsonNode member : value) {
                String id = member.isObject() ? member.path("value").asText("") : member.asText("");
                try {
                    out.add(Long.parseLong(id));
                } catch (NumberFormatException ignored) {
                    // Unknown members are skipped; provisioning never guesses ids.
                }
            }
        }
        return out;
    }

    private static String text(JsonNode body, String field) {
        JsonNode node = body == null ? null : body.get(field);
        return node == null || node.isNull() ? null : node.asText(null);
    }

    private static String firstEmail(JsonNode body) {
        return firstEmailFromNode(body == null ? null : body.path("emails"));
    }

    private static String firstEmailFromNode(JsonNode emails) {
        if (emails == null || emails.isNull() || emails.isMissingNode()) {
            return null;
        }
        if (emails.isArray()) {
            for (JsonNode email : emails) {
                String value = email.isObject() ? email.path("value").asText(null) : email.asText(null);
                if (value != null && !value.isBlank()) {
                    return value;
                }
            }
            return null;
        }
        if (emails.isObject()) {
            return emails.path("value").asText(null);
        }
        return emails.asText(null);
    }

    private static String displayName(JsonNode body, String fallback) {
        String name = text(body, "displayName");
        if (name != null && !name.isBlank()) {
            return name;
        }
        JsonNode formatted = body == null ? null : body.path("name").path("formatted");
        String value = formatted == null || formatted.isMissingNode() ? null : formatted.asText(null);
        return value == null || value.isBlank() ? fallback : value;
    }
}
