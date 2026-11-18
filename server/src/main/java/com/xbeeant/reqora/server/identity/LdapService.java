package com.xbeeant.reqora.server.identity;

import com.xbeeant.reqora.server.common.BizException;
import com.xbeeant.reqora.server.common.ErrorCode;
import com.xbeeant.reqora.server.config.IdentityProperties;
import java.util.ArrayList;
import java.util.Hashtable;
import java.util.List;
import javax.naming.Context;
import javax.naming.NamingEnumeration;
import javax.naming.directory.Attribute;
import javax.naming.directory.Attributes;
import javax.naming.directory.DirContext;
import javax.naming.directory.InitialDirContext;
import javax.naming.directory.SearchControls;
import javax.naming.directory.SearchResult;
import org.springframework.stereotype.Service;

/**
 * LDAP / Active Directory simple bind. Uses JDK JNDI only (no Spring LDAP
 * dependency). Kerberos/SPNEGO, StartTLS negotiation and nested group
 * resolution are explicitly out of scope; ldaps:// is recommended.
 */
@Service
public class LdapService {

    public IdentityClaims authenticate(IdentityProperties.Ldap config, String username, String password) {
        if (config.getUrl() == null || config.getUrl().isBlank()) {
            throw new BizException(ErrorCode.BAD_REQUEST, "LDAP URL 未配置");
        }
        String escaped = escapeFilter(username);
        Hashtable<String, String> base = environment(config);
        String userDn;
        Attributes attributes;

        if (config.getBindDn() != null && !config.getBindDn().isBlank()) {
            base.put(Context.SECURITY_PRINCIPAL, config.getBindDn());
            base.put(Context.SECURITY_CREDENTIALS, config.getBindPassword() == null
                    ? "" : config.getBindPassword());
            DirContext service = null;
            try {
                service = new InitialDirContext(base);
                String filter = config.getUserSearchFilter().replace("{0}", escaped);
                SearchControls controls = new SearchControls();
                controls.setSearchScope(SearchControls.SUBTREE_SCOPE);
                controls.setReturningAttributes(new String[] {
                        config.getMailAttribute(), config.getDisplayNameAttribute(),
                        config.getGroupAttribute()});
                controls.setTimeLimit((int) Math.min(config.getTimeout().toMillis(), Integer.MAX_VALUE));
                NamingEnumeration<SearchResult> found = service.search(config.getBaseDn(), filter, controls);
                if (!found.hasMore()) {
                    throw new BizException(ErrorCode.BAD_CREDENTIALS);
                }
                SearchResult result = found.next();
                userDn = result.getNameInNamespace();
                attributes = result.getAttributes();
            } catch (BizException ex) {
                throw ex;
            } catch (Exception ex) {
                throw new BizException(ErrorCode.UNAUTHENTICATED, "LDAP 目录查询失败");
            } finally {
                close(service);
            }
        } else {
            userDn = config.getUserDnPattern().replace("{0}", escaped)
                    + (config.getBaseDn() == null || config.getBaseDn().isBlank()
                            || config.getUserDnPattern().contains(",")
                            ? "" : "," + config.getBaseDn());
            attributes = null;
        }

        Hashtable<String, String> userEnv = environment(config);
        userEnv.put(Context.SECURITY_PRINCIPAL, userDn);
        userEnv.put(Context.SECURITY_CREDENTIALS, password);
        DirContext bind = null;
        try {
            bind = new InitialDirContext(userEnv);
            // A successful simple bind is the authentication proof.
        } catch (Exception ex) {
            throw new BizException(ErrorCode.BAD_CREDENTIALS);
        } finally {
            close(bind);
        }

        String email = firstValue(attributes, config.getMailAttribute());
        String displayName = firstValue(attributes, config.getDisplayNameAttribute());
        List<String> groups = allValues(attributes, config.getGroupAttribute());
        if (email == null || email.isBlank()) {
            email = username.contains("@") ? username : username + "@ldap.local";
        }
        if (displayName == null || displayName.isBlank()) {
            displayName = username;
        }
        return new IdentityClaims("ldap", "ldap", userDn, username, email, displayName, groups);
    }

    private static void close(DirContext context) {
        if (context == null) {
            return;
        }
        try {
            context.close();
        } catch (Exception ignored) {
            // Nothing useful to do if the directory refuses a close.
        }
    }

    private Hashtable<String, String> environment(IdentityProperties.Ldap config) {
        Hashtable<String, String> env = new Hashtable<>();
        env.put(Context.INITIAL_CONTEXT_FACTORY, "com.sun.jndi.ldap.LdapCtxFactory");
        env.put(Context.PROVIDER_URL, config.getUrl());
        env.put(Context.SECURITY_AUTHENTICATION, "simple");
        if (config.getUrl().toLowerCase().startsWith("ldaps://")) {
            env.put(Context.SECURITY_PROTOCOL, "ssl");
        }
        env.put("com.sun.jndi.ldap.connect.timeout", String.valueOf(config.getTimeout().toMillis()));
        env.put("com.sun.jndi.ldap.read.timeout", String.valueOf(config.getTimeout().toMillis()));
        return env;
    }

    private static String escapeFilter(String value) {
        StringBuilder out = new StringBuilder();
        for (char c : value.toCharArray()) {
            switch (c) {
                case '\\' -> out.append("\\5c");
                case '*' -> out.append("\\2a");
                case '(' -> out.append("\\28");
                case ')' -> out.append("\\29");
                case '\0' -> out.append("\\00");
                default -> out.append(c);
            }
        }
        return out.toString();
    }

    private static String firstValue(Attributes attributes, String name) {
        if (attributes == null || name == null) {
            return null;
        }
        Attribute attribute = attributes.get(name);
        if (attribute == null) {
            return null;
        }
        try {
            Object value = attribute.get();
            return value == null ? null : value.toString();
        } catch (Exception ex) {
            return null;
        }
    }

    private static List<String> allValues(Attributes attributes, String name) {
        List<String> out = new ArrayList<>();
        if (attributes == null || name == null) {
            return out;
        }
        Attribute attribute = attributes.get(name);
        if (attribute == null) {
            return out;
        }
        try {
            NamingEnumeration<?> values = attribute.getAll();
            while (values.hasMore()) {
                Object value = values.next();
                if (value != null) {
                    out.add(value.toString());
                }
            }
        } catch (Exception ignored) {
            // Group enumeration is informational, never a login blocker.
        }
        return out;
    }
}
