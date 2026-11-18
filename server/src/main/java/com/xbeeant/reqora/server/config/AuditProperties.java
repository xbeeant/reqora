package com.xbeeant.reqora.server.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Audit retention policy. Defaults match the posture described in
 * docs/IDENTITY_AND_AUDIT.md: 180 days of live logs, JSONL archive before any
 * purge, legal hold wins over everything, hash chain best effort on one node.
 */
@Data
@ConfigurationProperties(prefix = "reqora.audit")
public class AuditProperties {

    /** Live retention in days; 0 disables purging entirely (archive-only mode). */
    private long retentionDays = 180;

    /** Write a JSONL archive + sha256 ledger row before deleting a batch. */
    private boolean archiveEnabled = true;

    private String archiveDir = "./data/audit-archive";

    private int purgeBatchSize = 1000;

    private int maxBatchesPerRun = 100;

    /** When true no row may be purged, regardless of age. */
    private boolean legalHold = false;

    /** Append prev_hash/entry_hash to every new audit row. */
    private boolean hashChain = true;

    private String purgeCron = "0 15 3 * * *";

    private long exportMaxRows = 50_000L;
}
