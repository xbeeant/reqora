plugins {
    java
    id("org.springframework.boot") version "4.1.2"
}

group = "com.xbeeant"
version = "0.0.1"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

repositories {
    mavenCentral()
}

val springBootVersion = "4.1.2"
val mybatisPlusVersion = "3.5.18"
val lombokVersion = "1.18.40"

dependencies {
    // Gradle-native BOM support (Spring Boot plugin does not import the BOM by itself).
    implementation(platform("org.springframework.boot:spring-boot-dependencies:$springBootVersion"))

    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")
    implementation("org.springframework.boot:spring-boot-starter-actuator")

    // Spring Boot 4 needs the dedicated boot4 starter (>= 3.5.15 for real compatibility).
    implementation("com.baomidou:mybatis-plus-spring-boot4-starter:$mybatisPlusVersion")
    // PaginationInnerInterceptor was extracted from the core in 3.5.9.
    implementation("com.baomidou:mybatis-plus-jsqlparser:$mybatisPlusVersion")

    // Spring Boot 4 split Flyway auto-configuration into its own module/starter.
    implementation("org.springframework.boot:spring-boot-starter-flyway")
    implementation("org.flywaydb:flyway-mysql")
    runtimeOnly("com.mysql:mysql-connector-j")

    // Internal JSON handling (JWT payload + workspace snapshot validation).
    // Spring MVC itself uses the Jackson version managed by Spring Boot 4.
    // P0: 2.19.2 carried five OSV HIGH advisories (GHSA-cxp5-3px4-pw24,
    // GHSA-j3rv-43j4-c7qm, GHSA-q4xh-88c3-wmh7, GHSA-rmj7-2vxq-3g9f,
    // GHSA-wv8q-qhhj-9h54). The 2.21 branch is fixed from 2.21.7 onward;
    // 2.21.8 artifacts are in the local Gradle file cache; the first metadata
    // resolution needs network once, then `gradlew test --offline` works.
    implementation("com.fasterxml.jackson.core:jackson-databind:2.21.8")

    compileOnly("org.projectlombok:lombok:$lombokVersion")
    annotationProcessor("org.projectlombok:lombok:$lombokVersion")
    testCompileOnly("org.projectlombok:lombok:$lombokVersion")
    testAnnotationProcessor("org.projectlombok:lombok:$lombokVersion")

    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.named<Test>("test") {
    useJUnitPlatform()
    testLogging {
        events("passed", "failed", "skipped")
    }
}

// 网页版文档站 SPA 与后端同源托管：把仓库根目录 `bun run build` 的产物 dist/
// 复制进 classpath:/static/，由内嵌 Tomcat 直接提供 /、/assets/**、/*.svg 等静态资源，
// 不再需要单独启动 Vite / Nginx。dist/ 已在 .gitignore 中，构建产物不入库。
// 跨源部署（SPA 单独托管）时保持原样：不打进 jar，客户端用「网页版站点地址」拼接。
val spaDist = layout.projectDirectory.dir("../dist")
tasks.named<ProcessResources>("processResources") {
    if (spaDist.asFile.isDirectory) {
        from(spaDist) {
            into("static")
        }
    } else {
        logger.warn("dist/ 缺失：本次构建不含网页版 SPA，请先在项目根目录执行 `bun run build`")
    }
}
