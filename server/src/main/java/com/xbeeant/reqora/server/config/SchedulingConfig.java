package com.xbeeant.reqora.server.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/** Enables the SSE heartbeat in WorkspaceEventHub. */
@Configuration
@EnableScheduling
public class SchedulingConfig {}
