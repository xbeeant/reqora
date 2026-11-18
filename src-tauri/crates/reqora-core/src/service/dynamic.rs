//! `{{$dynamic}}` request variables — built-in values evaluated at request
//! time, Mock.js-flavoured. Deterministic "now" tokens (`$timestamp`,
//! `$isoDate`, …) are evaluated from the wall clock directly; everything
//! else reuses the mock server's `eval_token` generator (xorshift PRNG),
//! so the `{{$email}}` in a request and `@email` in a mock body produce the
//! same family of data. Unknown `$tokens` resolve to `None` and are kept
//! verbatim in the output (never reported as missing).

use super::mock::{eval_token, format_date, Prng};
use std::time::{SystemTime, UNIX_EPOCH};

/// True when a placeholder key refers to the dynamic-variable namespace.
pub fn is_dynamic(key: &str) -> bool {
    key.starts_with('$')
}

/// Evaluate `{{$token}}` / `{{$token(args)}}`. `None` = not a dynamic
/// variable or unknown token.
pub fn dynamic_value(key: &str) -> Option<String> {
    let token = key.strip_prefix('$')?;
    let (name, args) = match token.split_once('(') {
        Some((name, rest)) => (name, Some(rest.strip_suffix(')')?)),
        None => (token, None),
    };
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') || name.is_empty() {
        return None;
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    match name {
        // Wall-clock tokens: not random, must reflect the request moment.
        "timestamp" => Some((now / 1000).to_string()),
        "timestampMs" => Some(now.to_string()),
        "isoDate" | "isoTimestamp" => Some(format!(
            "{}T{}Z",
            format_date((now / 86_400_000) as i64, '-'),
            clock_time(now)
        )),
        "date" => Some(format_date((now / 86_400_000) as i64, '-')),
        "time" => Some(clock_time(now)),
        // Random tokens: reuse the mock data generator (with aliases).
        _ => {
            let canonical = match name {
                "uuid" => "guid",
                "randomInt" => "integer",
                "randomFloat" => "float",
                other => other,
            };
            let mut prng = Prng::from_time();
            eval_token(canonical, args, &mut prng).map(|value| value.text())
        }
    }
}

/// `HH:MM:SS` for the given unix milliseconds (UTC).
fn clock_time(now_ms: u64) -> String {
    let seconds_of_day = (now_ms / 1000) % 86_400;
    format!(
        "{:02}:{:02}:{:02}",
        seconds_of_day / 3600,
        (seconds_of_day % 3600) / 60,
        seconds_of_day % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wall_clock_tokens_are_current() {
        let before = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let timestamp: u64 = dynamic_value("$timestamp").unwrap().parse().unwrap();
        let after = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert!((before..=after).contains(&timestamp));

        let iso = dynamic_value("$isoDate").unwrap();
        assert_eq!(iso.len(), 20, "YYYY-MM-DDTHH:MM:SSZ, got: {iso}");
        assert!(iso.ends_with('Z') && iso.as_bytes()[10] == b'T');

        let date = dynamic_value("$date").unwrap();
        assert_eq!(date.len(), 10);
        let time = dynamic_value("$time").unwrap();
        assert_eq!(time.len(), 8);
        assert_eq!(dynamic_value("$timestampMs").unwrap().len() >= 13, true);
    }

    #[test]
    fn random_tokens_reuse_mock_generator() {
        let email = dynamic_value("$email").unwrap();
        assert!(email.contains('@'), "got: {email}");
        let cname = dynamic_value("$cname").unwrap();
        assert!(!cname.is_empty() && cname.chars().next().unwrap() != '$');
        let int: i64 = dynamic_value("$randomInt(10,20)").unwrap().parse().unwrap();
        assert!((10..=20).contains(&int));
        let guid = dynamic_value("$guid").unwrap();
        assert_eq!(guid.len(), 36);
        let uuid = dynamic_value("$uuid").unwrap();
        assert_eq!(uuid.len(), 36);
        // Two calls produce independent random values (overwhelming odds).
        let a = dynamic_value("$integer(0,1000000)").unwrap();
        let b = dynamic_value("$integer(0,1000000)").unwrap();
        assert_ne!(a, b, "both draws landed on {a}");
    }

    #[test]
    fn unknown_or_malformed_tokens_are_not_dynamic() {
        assert_eq!(dynamic_value("$nope"), None);
        assert_eq!(dynamic_value("{{$}}"), None);
        assert_eq!(dynamic_value("$email(unclosed"), None);
        assert_eq!(dynamic_value("baseUrl"), None);
        assert!(is_dynamic("$email"));
        assert!(!is_dynamic("baseUrl"));
    }
}
