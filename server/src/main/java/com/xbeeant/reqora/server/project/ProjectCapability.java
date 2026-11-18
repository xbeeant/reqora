package com.xbeeant.reqora.server.project;

/** Fine-grained capabilities checked by the service layer for every project operation. */
public enum ProjectCapability {
    PROJECT_READ,
    PROJECT_UPDATE,
    PROJECT_DELETE,
    PROJECT_ARCHIVE,
    MEMBER_READ,
    MEMBER_WRITE,
    OWNER_TRANSFER,
    WORKSPACE_READ,
    WORKSPACE_WRITE
}
