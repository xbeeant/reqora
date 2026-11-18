package com.xbeeant.reqora.server.config;

import java.util.List;
import java.util.Locale;
import org.springframework.context.MessageSource;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.support.ResourceBundleMessageSource;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.web.servlet.i18n.AcceptHeaderLocaleResolver;

/**
 * Internationalization configuration.
 *
 * <p>The response locale follows the client's {@code Accept-Language} header
 * (e.g. {@code zh-CN, zh} for Chinese, {@code en} for English), falling back
 * to Chinese when the header is absent or unsupported. Messages live in
 * {@code resources/i18n/<module>_zh.properties} (default) and
 * {@code <module>_en.properties}.
 */
@Configuration
public class I18nConfig {

    public static final Locale DEFAULT_LOCALE = Locale.SIMPLIFIED_CHINESE;
    public static final List<Locale> SUPPORTED_LOCALES = List.of(DEFAULT_LOCALE, Locale.ENGLISH);

    /** Module resource basenames registered for message lookup. */
    private static final String[] BASENAMES = {
        "i18n/common", "i18n/auth", "i18n/user", "i18n/organization", "i18n/member",
        "i18n/invitation", "i18n/project", "i18n/workspace", "i18n/role", "i18n/audit",
        "i18n/admin", "i18n/identity", "i18n/docsite", "i18n/config"
    };

    @Bean
    public AcceptHeaderLocaleResolver localeResolver() {
        AcceptHeaderLocaleResolver resolver = new AcceptHeaderLocaleResolver();
        resolver.setSupportedLocales(SUPPORTED_LOCALES);
        resolver.setDefaultLocale(DEFAULT_LOCALE);
        return resolver;
    }

    /** Wire the static {@link Messages} helper once both beans exist. */
    @Bean
    public InitializingBean messagesInitializer(MessageSource messageSource, AcceptHeaderLocaleResolver localeResolver) {
        return () -> com.xbeeant.reqora.server.common.Messages.init(messageSource, localeResolver);
    }

    @Bean
    public MessageSource messageSource() {
        ResourceBundleMessageSource source = new ResourceBundleMessageSource();
        source.setBasenames(BASENAMES);
        source.setDefaultEncoding("UTF-8");
        source.setFallbackToSystemLocale(false);
        source.setUseCodeAsDefaultMessage(true);
        return source;
    }
}
