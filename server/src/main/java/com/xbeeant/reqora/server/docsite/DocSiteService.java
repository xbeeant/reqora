package com.xbeeant.reqora.server.docsite;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xbeeant.reqora.server.audit.AuditService;
import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.CurrentUser;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.common.JsonSupport;
import com.xbeeant.reqora.server.project.ProjectAccess;
import com.xbeeant.reqora.server.project.ProjectCapability;
import jakarta.servlet.http.HttpServletRequest;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.LocalDateTime;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

/**
 * Stores and serves client-rendered documentation payloads.
 *
 * <p>The Java side deliberately contains no HTML/Markdown rendering: the public
 * page is the very same React SPA as the desktop preview, driven by
 * {@code DocSitePayload} JSON. Publishing therefore only persists data plus an
 * opaque token digest, and the public GET returns that data unchanged.
 */
@Service
public class DocSiteService {

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int MAX_TOKEN_LENGTH = 200;
    private static final int MAX_TITLE_LENGTH = 200;
    /** True when the same-origin SPA bundle was packaged into the classpath. */
    private static final boolean SPA_BUNDLED =
            new ClassPathResource("static/index.html").exists();

    private final DocSiteMapper docSiteMapper;
    private final ProjectAccess projectAccess;
    private final AuditService auditService;
    private final String publicBaseUrl;
    private final int maxBytes;

    public DocSiteService(
            DocSiteMapper docSiteMapper,
            ProjectAccess projectAccess,
            AuditService auditService,
            @Value("${app.doc-site.public-base-url:}") String publicBaseUrl,
            @Value("${app.doc-site.max-bytes:2097152}") int maxBytes) {
        this.docSiteMapper = docSiteMapper;
        this.projectAccess = projectAccess;
        this.auditService = auditService;
        this.publicBaseUrl = publicBaseUrl;
        this.maxBytes = maxBytes;
    }

    /** Publish a new snapshot and return the raw token exactly once. */
    @Transactional
    public DocSiteDtos.PublishResponse publish(long projectId, DocSiteDtos.PublishRequest request) {
        projectAccess.require(projectId, ProjectCapability.WORKSPACE_WRITE);
        String json = validatePayload(request.payload());
        String token = newToken();

        DocSiteEntity row = new DocSiteEntity();
        row.setProjectId(projectId);
        row.setTokenHash(hash(token));
        row.setTitle(title(request.title(), request.payload()));
        row.setPayload(json);
        row.setCreatedBy(CurrentUser.requireId());
        row.setExpiresAt(expiry(request.expiresInHours()));
        row.setViewCount(0L);
        row.setStatus("ACTIVE");
        docSiteMapper.insert(row);

        auditService.record("docsite.publish", "project", projectId, "发布文档站分享");
        return new DocSiteDtos.PublishResponse(view(row), token, url(token));
    }

    public List<DocSiteDtos.DocSiteView> list(long projectId) {
        projectAccess.require(projectId, ProjectCapability.WORKSPACE_READ);
        return docSiteMapper.selectList(new LambdaQueryWrapper<DocSiteEntity>()
                        .eq(DocSiteEntity::getProjectId, projectId)
                        .orderByDesc(DocSiteEntity::getId))
                .stream()
                .map(this::view)
                .toList();
    }

    /** Re-publish content in place: the share URL keeps working, no new token. */
    @Transactional
    public DocSiteDtos.DocSiteView update(
            long projectId, long shareId, DocSiteDtos.PublishRequest request) {
        projectAccess.require(projectId, ProjectCapability.WORKSPACE_WRITE);
        DocSiteEntity row = requireActive(projectId, shareId);
        row.setPayload(validatePayload(request.payload()));
        if (request.title() != null && !request.title().isBlank()) {
            row.setTitle(title(request.title(), request.payload()));
        }
        if (request.expiresInHours() != null) {
            row.setExpiresAt(expiry(request.expiresInHours()));
        }
        docSiteMapper.updateById(row);
        auditService.record("docsite.update", "project", projectId, "更新文档站内容 " + shareId);
        return view(row);
    }

    /**
     * Issue a fresh token for an existing share. The old URL stops working
     * immediately, which doubles as a "copy link" action and a leak-response.
     */
    @Transactional
    public DocSiteDtos.PublishResponse rotateToken(long projectId, long shareId) {
        projectAccess.require(projectId, ProjectCapability.WORKSPACE_WRITE);
        DocSiteEntity row = requireActive(projectId, shareId);
        String token = newToken();
        row.setTokenHash(hash(token));
        docSiteMapper.updateById(row);
        auditService.record("docsite.rotate", "project", projectId, "轮换文档站令牌 " + shareId);
        return new DocSiteDtos.PublishResponse(view(row), token, url(token));
    }

    @Transactional
    public void revoke(long projectId, long shareId) {
        projectAccess.require(projectId, ProjectCapability.WORKSPACE_WRITE);
        DocSiteEntity row = docSiteMapper.selectById(shareId);
        if (row == null || !row.getProjectId().equals(projectId)) {
            throw BizException.notFound("文档分享");
        }
        row.setStatus("REVOKED");
        docSiteMapper.updateById(row);
        auditService.record("docsite.revoke", "project", projectId, "撤销文档站分享 " + shareId);
    }

    /** Public, unauthenticated read. Never calls CurrentUser or ProjectAccess. */
    public Map<String, Object> publicPayload(String rawToken) {
        if (rawToken == null || rawToken.isBlank() || rawToken.length() > MAX_TOKEN_LENGTH) {
            throw new BizException(ErrorCode.NOT_FOUND, "文档链接无效");
        }
        DocSiteEntity row = docSiteMapper.selectOne(new LambdaQueryWrapper<DocSiteEntity>()
                .eq(DocSiteEntity::getTokenHash, hash(rawToken))
                .last("LIMIT 1"));
        if (row == null || !"ACTIVE".equals(row.getStatus())) {
            throw new BizException(ErrorCode.NOT_FOUND, "文档链接不存在或已被撤销");
        }
        if (row.getExpiresAt() != null && row.getExpiresAt().isBefore(LocalDateTime.now())) {
            throw new BizException(ErrorCode.NOT_FOUND, "文档链接已过期");
        }
        Map<String, Object> payload;
        try {
            payload = JsonSupport.toMap(row.getPayload());
        } catch (IllegalArgumentException error) {
            throw new BizException(ErrorCode.INTERNAL, "文档数据损坏，请联系发布者重新发布");
        }
        // A counter-only write; the LONGTEXT payload is never rewritten on a read.
        docSiteMapper.incrementViewCount(row.getId());
        return payload;
    }

    private DocSiteEntity requireActive(long projectId, long shareId) {
        DocSiteEntity row = docSiteMapper.selectById(shareId);
        if (row == null || !row.getProjectId().equals(projectId)) {
            throw BizException.notFound("文档分享");
        }
        if (!"ACTIVE".equals(row.getStatus())) {
            throw new BizException(ErrorCode.CONFLICT, "该文档分享已撤销，请重新发布");
        }
        return row;
    }

    private String validatePayload(Map<String, Object> payload) {
        if (payload == null || !(payload.get("collections") instanceof List<?>)) {
            throw new BizException(ErrorCode.BAD_REQUEST, "文档数据缺少 collections 字段");
        }
        String json = JsonSupport.stringify(payload);
        if (json.getBytes(StandardCharsets.UTF_8).length > maxBytes) {
            throw new BizException(ErrorCode.PAYLOAD_TOO_LARGE,
                    "文档数据超过 " + (maxBytes / 1024 / 1024) + " MiB 上限，请精简后重试");
        }
        return json;
    }

    private static String title(String requested, Map<String, Object> payload) {
        String raw = requested == null || requested.isBlank()
                ? (payload.get("title") instanceof String value ? value : "")
                : requested;
        String trimmed = raw.trim();
        if (trimmed.isEmpty()) return "API 文档";
        return trimmed.substring(0, Math.min(trimmed.length(), MAX_TITLE_LENGTH));
    }

    private static LocalDateTime expiry(Long hours) {
        return hours == null ? null : LocalDateTime.now().plusHours(hours);
    }

    /**
     * Build a ready-to-copy URL. Set REQORA_DOC_SITE_URL to the deployed SPA
     * address; for a split origin, include the api parameter there, e.g.
     * {@code https://docs.example.com/?api=https%3A%2F%2Fapi.example.com}.
     */
    private String url(String token) {
        String base = publicBaseUrl == null ? "" : publicBaseUrl.trim().replaceAll("/+$", "");
        // Same-origin deployment: this server also serves the SPA, so when
        // REQORA_DOC_SITE_URL is unset we can derive a working link from the
        // current request instead of returning an empty string. Cross-origin
        // deployments ship no bundled SPA and keep the old behaviour (the client
        // fills in its own site address, or the admin sets the variable).
        if (base.isEmpty() && SPA_BUNDLED) {
            String origin = currentOrigin();
            if (!origin.isEmpty()) {
                // 显式带上指向自身的 api 参数：客户端 urlFor 见到已有 api 就不会
                // 用它本地配置的后端地址（常为 localhost）覆盖，局域网/公网打开
                // 链接时 SPA 才会请求到真正托管它的这台后端。
                base = origin + "?api=" + URLEncoder.encode(origin, StandardCharsets.UTF_8);
            }
        }
        if (base.isEmpty()) return "";
        return base + (base.contains("?") ? "&" : "?") + "doc=" + token;
    }

    /** Origin of the current request, honouring reverse-proxy headers. */
    private static String currentOrigin() {
        if (!(RequestContextHolder.getRequestAttributes()
                instanceof ServletRequestAttributes attributes)) {
            return "";
        }
        HttpServletRequest request = attributes.getRequest();
        String scheme = firstNonBlank(
                request.getHeader("X-Forwarded-Proto"), request.getScheme());
        String host = firstNonBlank(
                request.getHeader("X-Forwarded-Host"), request.getHeader("Host"));
        if (host.isEmpty()) {
            host = request.getServerName() + ":" + request.getServerPort();
        }
        return scheme.isEmpty() || host.isEmpty() ? "" : scheme + "://" + host;
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) return value.trim();
        }
        return "";
    }

    private DocSiteDtos.DocSiteView view(DocSiteEntity row) {
        return new DocSiteDtos.DocSiteView(
                row.getId(),
                row.getProjectId(),
                row.getTitle(),
                row.getStatus(),
                row.getExpiresAt(),
                row.getViewCount(),
                row.getCreatedAt());
    }

    /** SHA-256 hex digest — the raw token is never stored. */
    static String hash(String raw) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(raw.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder(digest.length * 2);
            for (byte value : digest) out.append(String.format("%02x", value));
            return out.toString();
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 不可用", error);
        }
    }

    private static String newToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
}
