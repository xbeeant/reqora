package com.xbeeant.reqora.server.common;

import jakarta.servlet.http.HttpServletRequest;
import java.util.Locale;
import org.springframework.context.MessageSource;
import org.springframework.context.i18n.LocaleContextHolder;
import org.springframework.web.servlet.i18n.AcceptHeaderLocaleResolver;

/**
 * Static access to localized messages.
 *
 * <p>Inside MVC request handling the locale comes from {@link LocaleContextHolder}
 * (populated from the client's {@code Accept-Language} header). In the security
 * filter chain — which runs before MVC — use {@link #forRequest(HttpServletRequest, String, Object...)}
 * to resolve the locale directly from the request.
 */
public final class Messages {

    private static volatile MessageSource source;
    private static volatile AcceptHeaderLocaleResolver resolver;

    private Messages() {}

    public static void init(MessageSource messageSource, AcceptHeaderLocaleResolver localeResolver) {
        source = messageSource;
        resolver = localeResolver;
    }

    /** Resolve a message key in the current request locale (defaults to Chinese). */
    public static String get(String key, Object... args) {
        MessageSource ms = source;
        if (ms == null) {
            return key;
        }
        return ms.getMessage(key, args, key, currentLocale());
    }

    /** Resolve the default message of an {@link ErrorCode} in the current request locale. */
    public static String get(ErrorCode error, Object... args) {
        MessageSource ms = source;
        if (ms == null) {
            return error.defaultMessage();
        }
        return ms.getMessage(error.messageKey(), args, error.defaultMessage(), currentLocale());
    }

    /** Resolve a message for a raw request (usable inside the security filter chain). */
    public static String forRequest(HttpServletRequest request, String key, Object... args) {
        MessageSource ms = source;
        if (ms == null) {
            return key;
        }
        Locale locale = resolver != null && request != null
                ? resolver.resolveLocale(request)
                : currentLocale();
        return ms.getMessage(key, args, key, locale);
    }

    private static Locale currentLocale() {
        Locale locale = LocaleContextHolder.getLocale();
        return locale == null ? com.xbeeant.reqora.server.config.I18nConfig.DEFAULT_LOCALE : locale;
    }
}
