//! Shared wall-clock helpers.
//!
//! Every layer used to roll its own `now_ms()`, with inconsistent return
//! types (`i64` vs `u64`) and silent-zero fallbacks. This is the single source
//! of truth; callers that need a signed value convert explicitly.

use std::time::{SystemTime, UNIX_EPOCH};

/// Unix time in milliseconds since the epoch. Clock-before-epoch reads as 0.
pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_millis_is_monotonic_and_plausible() {
        let a = now_millis();
        let b = now_millis();
        assert!(b >= a);
        // Sanity floor: any real deployment in 2026 is well past 1e12 ms.
        assert!(a > 1_000_000_000_000);
    }
}
