//! Shared cookie jar for cross-request cookie management.
//!
//! reqwest's built-in `cookie::Jar` deliberately has no introspection API —
//! you cannot list what was stored, which is exactly what a cookie *manager*
//! needs. So Reqora owns the store: `Set-Cookie` headers from every
//! response are captured here, and matching cookies are attached to subsequent
//! requests as a `Cookie` header. Matching follows RFC 6265 semantics for the
//! parts a debugging client cares about:
//!
//! • domain — a cookie without a `Domain` attribute is host-only (exact
//!   match); with one, it also matches subdomains.
//! • path   — request path must fall under the cookie path on a segment
//!   boundary; cookies with no `Path` attribute use the request's directory.
//! • secure — `Secure` cookies only travel over https.
//! • expiry — `Max-Age` is honored; `Expires` dates are treated as session
//!   cookies (kept until cleared) because parsing all RFC date forms is not
//!   worth the code here.
//!
//! The store lives behind the service layer and never touches the network.

use reqwest::Url;
use serde::{Deserialize, Serialize};

/// Hard cap so a hostile server cannot grow the jar forever.
const MAX_COOKIES: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredCookie {
    /// Domain the cookie belongs to, lower-cased, no leading dot.
    pub domain: String,
    /// True when the server did NOT send a `Domain` attribute — the cookie is
    /// pinned to the exact host and never matches subdomains.
    pub host_only: bool,
    pub path: String,
    pub name: String,
    pub value: String,
    pub secure: bool,
    /// Unix millis; `None` = session cookie (kept until cleared).
    pub expires_at_ms: Option<u64>,
}

#[derive(Debug, Default)]
pub struct CookieStore {
    cookies: Vec<StoredCookie>,
}

fn now_ms() -> u64 {
    crate::time::now_millis()
}

/// Split `name=value` from the attribute list of a Set-Cookie header.
fn split_pair(head: &str) -> Option<(String, String)> {
    let (name, value) = head.split_once('=')?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    Some((name.to_string(), value.trim().to_string()))
}

/// Lower-case attribute lookup: returns the value part of `key=value`.
fn attribute<'a>(parts: &'a [&'a str], key: &str) -> Option<String> {
    parts.iter().find_map(|part| {
        let (name, value) = part.split_once('=')?;
        if name.trim().eq_ignore_ascii_case(key) {
            Some(value.trim().to_string())
        } else {
            None
        }
    })
}

fn has_flag(parts: &[&str], key: &str) -> bool {
    parts
        .iter()
        .any(|part| part.trim().eq_ignore_ascii_case(key))
}

impl CookieStore {
    pub fn list(&self) -> Vec<StoredCookie> {
        self.cookies.clone()
    }

    pub fn clear_all(&mut self) {
        self.cookies.clear();
    }

    /// Capture `Set-Cookie` values from one response. `final_url` is the URL
    /// after redirects — cookies belong to the host that actually answered.
    pub fn capture(&mut self, final_url: &str, set_cookie_values: &[String]) {
        let Ok(url) = Url::parse(final_url) else {
            return;
        };
        let Some(host) = url.host_str().map(|h| h.to_ascii_lowercase()) else {
            return;
        };
        let request_path = url.path().to_string();

        for raw in set_cookie_values {
            let mut parts = raw.split(';');
            let Some((name, value)) = parts.next().and_then(split_pair) else {
                continue;
            };
            let parts: Vec<&str> = parts.collect();

            // Domain attribute widens the match to subdomains. A Domain equal
            // to the host still matches subdomains (RFC 6265 §5.2.3) — only a
            // missing attribute makes the cookie host-only.
            let (domain, host_only) = match attribute(&parts, "domain") {
                Some(value) => {
                    let domain = value.trim_start_matches('.').to_ascii_lowercase();
                    if domain.is_empty() {
                        (host.clone(), true)
                    } else if host == domain || host.ends_with(&format!(".{domain}")) {
                        (domain, false)
                    } else {
                        // A cookie for another site: ignore per RFC 6265 §5.3.
                        continue;
                    }
                }
                None => (host.clone(), true),
            };

            // Default path = directory of the request URL (RFC 6265 §5.1.4).
            let path = attribute(&parts, "path")
                .map(|value| {
                    if value.starts_with('/') {
                        value
                    } else {
                        "/".to_string()
                    }
                })
                .unwrap_or_else(|| default_path(&request_path));

            let secure = has_flag(&parts, "secure");
            let expires_at_ms = attribute(&parts, "max-age").and_then(|value| {
                let seconds: i64 = value.parse().ok()?;
                if seconds <= 0 {
                    // 0 or negative: discard immediately.
                    return None;
                }
                Some(now_ms() + (seconds as u64).saturating_mul(1000))
            });
            if attribute(&parts, "max-age").is_some() && expires_at_ms.is_none() {
                // Max-Age<=0 is the deletion protocol: drop any existing cookie
                // with the same identity, then ignore this one.
                self.cookies.retain(|existing| {
                    !(existing.domain == domain
                        && existing.path == path
                        && existing.name == name)
                });
                continue;
            }

            let cookie = StoredCookie {
                domain,
                host_only,
                path,
                name,
                value,
                secure,
                expires_at_ms,
            };

            // Same (domain, path, name) replaces; expired entries are dropped.
            self.cookies
                .retain(|existing| !(existing.domain == cookie.domain
                    && existing.path == cookie.path
                    && existing.name == cookie.name));
            self.cookies.retain(|existing| match existing.expires_at_ms {
                Some(at) => at > now_ms(),
                None => true,
            });
            if self.cookies.len() >= MAX_COOKIES {
                self.cookies.remove(0);
            }
            self.cookies.push(cookie);
        }
    }

    /// Build the `Cookie` header value for a request URL, if any cookie
    /// matches. Returns `None` when nothing applies.
    pub fn cookie_header(&self, request_url: &str) -> Option<String> {
        let url = Url::parse(request_url).ok()?;
        let host = url.host_str()?.to_ascii_lowercase();
        let path = url.path().to_string();
        let is_secure = url.scheme() == "https";
        let now = now_ms();

        let pairs: Vec<String> = self
            .cookies
            .iter()
            .filter(|cookie| cookie.expires_at_ms.map(|at| at > now).unwrap_or(true))
            .filter(|cookie| {
                if cookie.secure && !is_secure {
                    return false;
                }
                if cookie.host_only {
                    cookie.domain == host
                } else {
                    host == cookie.domain || host.ends_with(&format!(".{}", cookie.domain))
                }
            })
            .filter(|cookie| path_match(&cookie.path, &path))
            .map(|cookie| format!("{}={}", cookie.name, cookie.value))
            .collect();

        if pairs.is_empty() {
            None
        } else {
            Some(pairs.join("; "))
        }
    }
}

/// RFC 6265 §5.1.4 default-path: drop the last segment of the request path.
fn default_path(request_path: &str) -> String {
    if !request_path.starts_with('/') {
        return "/".to_string();
    }
    match request_path.rfind('/') {
        Some(0) => "/".to_string(),
        Some(index) => request_path[..index].to_string(),
        None => "/".to_string(),
    }
}

/// True when `request_path` falls under `cookie_path` on a segment boundary.
fn path_match(cookie_path: &str, request_path: &str) -> bool {
    if cookie_path.is_empty() {
        return true;
    }
    if request_path == cookie_path {
        return true;
    }
    if request_path.starts_with(cookie_path) {
        // `/foo` must not match `/foobar`, only `/foobar/...`
        return cookie_path.ends_with('/') || request_path[cookie_path.len()..].starts_with('/');
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capture(
        store: &mut CookieStore,
        url: &str,
        set_cookies: &[&str],
    ) {
        let values: Vec<String> = set_cookies.iter().map(|s| s.to_string()).collect();
        store.capture(url, &values);
    }

    #[test]
    fn captures_and_sends_back_basic_cookie() {
        let mut store = CookieStore::default();
        capture(&mut store, "http://a.test/login", &["sid=abc123; Path=/"]);
        assert_eq!(
            store.cookie_header("http://a.test/dashboard").as_deref(),
            Some("sid=abc123")
        );
    }

    #[test]
    fn host_only_cookie_does_not_match_subdomains() {
        let mut store = CookieStore::default();
        capture(&mut store, "http://a.test/x", &["sid=1"]);
        assert!(store.cookie_header("http://a.test/y").is_some());
        assert!(store.cookie_header("http://www.a.test/y").is_none());
    }

    #[test]
    fn domain_attribute_matches_subdomains() {
        let mut store = CookieStore::default();
        capture(&mut store, "http://a.test/x", &["sid=1; Domain=a.test"]);
        assert_eq!(
            store.cookie_header("http://api.a.test/y").as_deref(),
            Some("sid=1")
        );
    }

    #[test]
    fn foreign_domain_attribute_is_ignored() {
        let mut store = CookieStore::default();
        capture(&mut store, "http://a.test/x", &["sid=1; Domain=evil.test"]);
        assert_eq!(store.list().len(), 0);
        assert!(store.cookie_header("http://evil.test/y").is_none());
    }

    #[test]
    fn default_path_is_the_request_directory() {
        let mut store = CookieStore::default();
        capture(&mut store, "http://a.test/api/v1/login", &["sid=1"]);
        // Same directory subtree matches…
        assert!(store.cookie_header("http://a.test/api/v1/me").is_some());
        // …the parent does not.
        assert!(store.cookie_header("http://a.test/api/other").is_none());
    }

    #[test]
    fn path_match_respects_segment_boundaries() {
        assert!(path_match("/foo", "/foobar") == false);
        assert!(path_match("/foo", "/foo/bar"));
        assert!(path_match("/", "/anything"));
        assert!(path_match("/foo/", "/foo/bar"));
    }

    #[test]
    fn max_age_expiry_drops_the_cookie() {
        let mut store = CookieStore::default();
        capture(&mut store, "http://a.test/x", &["gone=1; Max-Age=1"]);
        assert!(store.cookie_header("http://a.test/x").is_some());
        // Force-expire by rewriting the timestamp into the past.
        store.cookies[0].expires_at_ms = Some(now_ms().saturating_sub(1));
        assert!(store.cookie_header("http://a.test/x").is_none());
        capture(&mut store, "http://a.test/x", &["new=2"]);
        assert_eq!(store.list().len(), 1, "expired entry must be collected");
    }

    #[test]
    fn max_age_zero_discards_immediately() {
        let mut store = CookieStore::default();
        capture(&mut store, "http://a.test/x", &["kept=1"]);
        capture(&mut store, "http://a.test/x", &["kept=; Max-Age=0"]);
        assert_eq!(store.list().len(), 0);
    }

    #[test]
    fn secure_cookie_never_travels_over_http() {
        let mut store = CookieStore::default();
        capture(&mut store, "https://a.test/x", &["tok=1; Secure"]);
        assert!(store.cookie_header("https://a.test/y").is_some());
        assert!(store.cookie_header("http://a.test/y").is_none());
    }

    #[test]
    fn same_name_replaces_older_value() {
        let mut store = CookieStore::default();
        capture(&mut store, "http://a.test/x", &["sid=old; Path=/"]);
        capture(&mut store, "http://a.test/y", &["sid=new; Path=/"]);
        assert_eq!(store.list().len(), 1);
        assert_eq!(
            store.cookie_header("http://a.test/z").as_deref(),
            Some("sid=new")
        );
    }

    #[test]
    fn multiple_cookies_join_with_semicolons() {
        let mut store = CookieStore::default();
        capture(
            &mut store,
            "http://a.test/x",
            &["a=1; Path=/", "b=2; Path=/"],
        );
        let header = store.cookie_header("http://a.test/y").unwrap();
        assert!(header.contains("a=1") && header.contains("b=2"));
        assert!(header.matches(';').count() == 1);
    }

    #[test]
    fn clear_all_empties_the_store() {
        let mut store = CookieStore::default();
        capture(&mut store, "http://a.test/x", &["a=1"]);
        store.clear_all();
        assert!(store.list().is_empty());
        assert!(store.cookie_header("http://a.test/y").is_none());
    }

    #[test]
    fn malformed_set_cookie_is_skipped() {
        let mut store = CookieStore::default();
        capture(&mut store, "http://a.test/x", &["", "novalue", "=novar", "ok=1"]);
        assert_eq!(store.list().len(), 1);
        assert_eq!(store.list()[0].name, "ok");
    }

    #[test]
    fn jar_is_capped_at_max_cookies() {
        let mut store = CookieStore::default();
        let mut set = Vec::new();
        for i in 0..(MAX_COOKIES + 50) {
            set.push(format!("c{i}=v{i}; Path=/"));
        }
        let refs: Vec<String> = set.clone();
        store.capture("http://a.test/x", &refs);
        assert_eq!(store.list().len(), MAX_COOKIES);
    }
}
