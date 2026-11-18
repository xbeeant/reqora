package com.xbeeant.reqora.server.audit;

import com.xbeeant.reqora.server.common.ApiResponse;
import com.xbeeant.reqora.server.common.PageResult;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.Map;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@Validated
@RestController
@RequestMapping("/api/v1/audit")
public class AuditController {

    private final AuditService auditService;
    private final AuditRetentionService retentionService;

    public AuditController(AuditService auditService, AuditRetentionService retentionService) {
        this.auditService = auditService;
        this.retentionService = retentionService;
    }

    @GetMapping("/logs")
    public ApiResponse<PageResult<AuditLogEntity>> logs(
            @RequestParam(defaultValue = "1") @Min(1) long page,
            @RequestParam(defaultValue = "20") @Min(1) @Max(100) long size,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) String action) {
        return ApiResponse.ok(auditService.list(page, size, keyword, action));
    }

    @GetMapping("/actions")
    public ApiResponse<java.util.List<String>> actions() {
        return ApiResponse.ok(auditService.actions());
    }

    @GetMapping("/retention")
    public ApiResponse<Map<String, Object>> retention() {
        return ApiResponse.ok(retentionService.policy());
    }

    @GetMapping("/chain/verify")
    public ApiResponse<AuditRetentionService.ChainReport> verifyChain() {
        return ApiResponse.ok(retentionService.verifyChain());
    }

    /** Compliance export. Both formats include the hash-chain fields. */
    @GetMapping("/export")
    public ResponseEntity<byte[]> export(
            @RequestParam(defaultValue = "jsonl") String format,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME)
            LocalDateTime from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME)
            LocalDateTime to,
            @RequestParam(required = false) String action,
            @RequestParam(defaultValue = "50000") @Min(1) long limit) {
        boolean csv = "csv".equalsIgnoreCase(format);
        var rows = retentionService.query(from, to, action, limit);
        String body = retentionService.export(csv ? "csv" : "jsonl", rows);
        MediaType type = csv ? MediaType.parseMediaType("text/csv;charset=UTF-8")
                : MediaType.parseMediaType("application/x-ndjson;charset=UTF-8");
        String suffix = csv ? "csv" : "jsonl";
        return ResponseEntity.ok()
                .contentType(type)
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        ContentDisposition.attachment()
                                .filename("reqora-audit-" + System.currentTimeMillis() + "." + suffix)
                                .build().toString())
                .body(body.getBytes(StandardCharsets.UTF_8));
    }

    @PostMapping("/retention/run")
    public ApiResponse<AuditRetentionService.PurgeResult> runPurge() {
        return ApiResponse.ok(retentionService.runPurge());
    }
}
