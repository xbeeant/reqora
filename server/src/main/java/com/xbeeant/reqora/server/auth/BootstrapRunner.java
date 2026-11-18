package com.xbeeant.reqora.server.auth;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xbeeant.reqora.server.config.AppProperties;
import com.xbeeant.reqora.server.role.RoleEntity;
import com.xbeeant.reqora.server.role.RoleMapper;
import com.xbeeant.reqora.server.role.UserRoleEntity;
import com.xbeeant.reqora.server.role.UserRoleMapper;
import com.xbeeant.reqora.server.user.UserEntity;
import com.xbeeant.reqora.server.user.UserMapper;
import java.time.LocalDateTime;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/** Creates the initial super admin once. Password comes from the environment, never from source. */
@Component
public class BootstrapRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(BootstrapRunner.class);

    private final UserMapper userMapper;
    private final RoleMapper roleMapper;
    private final UserRoleMapper userRoleMapper;
    private final PasswordEncoder passwordEncoder;
    private final AppProperties properties;

    public BootstrapRunner(
            UserMapper userMapper,
            RoleMapper roleMapper,
            UserRoleMapper userRoleMapper,
            PasswordEncoder passwordEncoder,
            AppProperties properties) {
        this.userMapper = userMapper;
        this.roleMapper = roleMapper;
        this.userRoleMapper = userRoleMapper;
        this.passwordEncoder = passwordEncoder;
        this.properties = properties;
    }

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        String username = properties.getBootstrap().getAdminUsername();
        if (userMapper.selectCount(new LambdaQueryWrapper<UserEntity>()
                .eq(UserEntity::getUsername, username)) > 0) {
            return;
        }
        RoleEntity role = roleMapper.selectOne(new LambdaQueryWrapper<RoleEntity>()
                .eq(RoleEntity::getCode, "SUPER_ADMIN").last("LIMIT 1"));
        if (role == null) {
            throw new IllegalStateException("内置 SUPER_ADMIN 角色缺失，请检查 Flyway 迁移");
        }
        UserEntity user = new UserEntity();
        user.setUsername(username);
        user.setEmail(properties.getBootstrap().getAdminEmail());
        user.setDisplayName("超级管理员");
        user.setPasswordHash(passwordEncoder.encode(properties.getBootstrap().getAdminPassword()));
        user.setStatus(1);
        userMapper.insert(user);

        UserRoleEntity link = new UserRoleEntity();
        link.setUserId(user.getId());
        link.setRoleId(role.getId());
        link.setCreatedAt(LocalDateTime.now());
        userRoleMapper.insert(link);
        log.info("bootstrap super admin created: username={}", username);
    }
}
