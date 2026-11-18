package com.xbeeant.reqora.server;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.boot.security.autoconfigure.UserDetailsServiceAutoConfiguration;

@SpringBootApplication(exclude = UserDetailsServiceAutoConfiguration.class)
@ConfigurationPropertiesScan
@MapperScan("com.xbeeant.reqora.server")
public class ServerApplication {

    public static void main(String[] args) {
        // Some IDE / agent harnesses inject SERVER__PORT, which relaxed binding would read as
        // server.port. A system property outranks environment variables and keeps our own
        // REQORA_SERVER_PORT authoritative.
        String port = System.getenv("REQORA_SERVER_PORT");
        if (port != null && !port.isBlank()) {
            System.setProperty("server.port", port.trim());
        }
        SpringApplication.run(ServerApplication.class, args);
    }
}
