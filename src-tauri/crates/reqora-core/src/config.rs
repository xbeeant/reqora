//! Centralised runtime configuration.
//!
//! Every tunable comes from the environment, is validated once at startup and
//! the process fails fast on an invalid value. No secret belongs in here.

use std::env;
use std::path::{Path, PathBuf};

/// Dotenv files consulted at startup, in increasing priority. Kept in sync
/// with `DEFAULT_ENV_FILES` in `scripts/release-env.mjs` so the release
/// scripts and the desktop process resolve the same values.
const DOTENV_FILES: [&str; 4] = [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
];
/// Only these keys are imported: an unrelated `.env` in the launch directory
/// must never be able to redefine `PATH`, `HOME` or proxy variables.
const DOTENV_PREFIX: &str = "REQORA_";

/// Dev-mode fallback update-manifest URL, used when `REQORA_UPDATE_MANIFEST_URL`
/// is not set. Kept for `tauri dev` from a fresh checkout.
#[cfg(debug_assertions)]
const UPDATE_MANIFEST_DEV_URL: &str = "https://example.com/update.json";

/// Update-manifest URL baked into release binaries at build time.
///
/// `scripts/release.mjs` loads `.env.production` into the process environment
/// before `tauri build`, so a release exe can carry the same endpoint dev gets
/// from `UPDATE_MANIFEST_DEV_URL`. Runtime env / dotenv files still win; this
/// is only the fallback for an installed app, which has no repo `.env.production`
/// next to it.
#[cfg_attr(debug_assertions, allow(dead_code))]
const UPDATE_MANIFEST_BUILD_URL: Option<&str> = option_env!("REQORA_UPDATE_MANIFEST_URL");
/// Same idea for the TLS opt-out: the self-hosted manifest server uses a
/// private CA, so release builds need the build-time `false` as their default.
/// Certificate verification is still on unless this is explicitly set.
const UPDATE_VERIFY_TLS_BUILD: Option<&str> = option_env!("REQORA_UPDATE_VERIFY_TLS");

/// Default ceiling for the serialised workspace snapshot.
///
/// The historical 5 MiB default was smaller than a single real project (a few
/// hundred test cases plus history easily reach 25 MiB), so every auto-save
/// failed with a misleading "check directory permissions" error. The ceiling
/// is still enforced — it just starts at a realistic size and is adjustable
/// at runtime via `set_workspace_limit`.
pub const DEFAULT_WORKSPACE_BYTES: u64 = 64 * 1024 * 1024;
/// Hard ceiling shared by the env var, the runtime setter and the settings UI.
pub const MAX_WORKSPACE_BYTES: u64 = 256 * 1024 * 1024;
/// Smallest value accepted by the runtime setter (matches the env validator).
pub const MIN_WORKSPACE_BYTES: u64 = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
}

impl LogLevel {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "debug" => Ok(Self::Debug),
            "info" => Ok(Self::Info),
            "warn" => Ok(Self::Warn),
            "error" => Ok(Self::Error),
            other => Err(format!(
                "REQORA_LOG_LEVEL 必须是 debug|info|warn|error，当前值: {other}"
            )),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }

    /// Whether `event_level` passes the configured minimum verbosity.
    pub fn enabled(self, event_level: LogLevel) -> bool {
        event_level >= self
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub request_timeout_secs: u64,
    pub max_response_bytes: usize,
    pub max_request_body_bytes: usize,
    pub max_workspace_bytes: usize,
    pub log_level: LogLevel,
    /// Update-manifest endpoint checked at startup and on demand. `None` means
    /// the check is disabled until the frontend passes an explicit endpoint.
    pub update_manifest_url: Option<String>,
    /// Raw 32-byte Ed25519 public key used to verify the update manifest.
    /// Defaults to the key in `crate::trust` and can be replaced for
    /// self-hosted releases via `REQORA_UPDATE_PUBLIC_KEY`.
    pub update_public_key: Vec<u8>,
    /// Whether the HTTPS request for the update manifest verifies the server
    /// certificate. Defaults to `true`; self-hosted deployments behind a
    /// private CA or a self-signed certificate can opt out via
    /// `REQORA_UPDATE_VERIFY_TLS=false`. This never affects the Ed25519
    /// signature check, which is always enforced.
    pub update_verify_tls: bool,
    /// Decoded bytes kept inline in `ResponsePayload.body`; the rest is spooled
    /// to the on-disk body store. Bounds the immediately-visible preview.
    pub inline_body_bytes: usize,
    /// Hard ceiling on decoded bytes written to the response-body spool.
    /// Reading stops once this is reached so the disk never grows unbounded.
    pub max_body_spool_bytes: usize,
}

impl Config {
    pub fn defaults() -> Self {
        Self {
            request_timeout_secs: 30,
            max_response_bytes: 10 * 1024 * 1024,
            max_request_body_bytes: 5 * 1024 * 1024,
            max_workspace_bytes: DEFAULT_WORKSPACE_BYTES as usize,
            log_level: LogLevel::Info,
            update_manifest_url: None,
            update_public_key: crate::trust::default_public_key(),
            update_verify_tls: true,
            inline_body_bytes: 256 * 1024,
            max_body_spool_bytes: 256 * 1024 * 1024,
        }
    }

    pub fn from_env() -> Result<Self, String> {
        // Launchers do not load .env.production for us: without this, a
        // deployer changing the global config file sees no effect at all.
        load_dotenv_files();
        let defaults = Self::defaults();
        let log_level = match env::var("REQORA_LOG_LEVEL") {
            Ok(raw) => LogLevel::parse(&raw)?,
            Err(env::VarError::NotPresent) => defaults.log_level,
            Err(err) => return Err(format!("REQORA_LOG_LEVEL 读取失败: {err}")),
        };
        let default_verify_tls = build_time_bool(
            "REQORA_UPDATE_VERIFY_TLS (build-time)",
            UPDATE_VERIFY_TLS_BUILD,
            defaults.update_verify_tls,
        )?;

        Ok(Self {
            request_timeout_secs: bounded(
                "REQORA_TIMEOUT_SECS",
                defaults.request_timeout_secs,
                1,
                300,
            )?,
            max_response_bytes: bounded(
                "REQORA_MAX_RESPONSE_BYTES",
                defaults.max_response_bytes as u64,
                1024,
                100 * 1024 * 1024,
            )? as usize,
            max_request_body_bytes: bounded(
                "REQORA_MAX_REQUEST_BODY_BYTES",
                defaults.max_request_body_bytes as u64,
                1024,
                50 * 1024 * 1024,
            )? as usize,
            max_workspace_bytes: bounded(
                "REQORA_MAX_WORKSPACE_BYTES",
                defaults.max_workspace_bytes as u64,
                MIN_WORKSPACE_BYTES,
                MAX_WORKSPACE_BYTES,
            )? as usize,
            inline_body_bytes: bounded(
                "REQORA_INLINE_BODY_BYTES",
                defaults.inline_body_bytes as u64,
                1024,
                8 * 1024 * 1024,
            )? as usize,
            max_body_spool_bytes: bounded(
                "REQORA_MAX_BODY_SPOOL_BYTES",
                defaults.max_body_spool_bytes as u64,
                1024 * 1024,
                1024 * 1024 * 1024,
            )? as usize,
            log_level,
            update_manifest_url: update_manifest_url(),
            update_public_key: update_public_key()?,
            update_verify_tls: env_bool("REQORA_UPDATE_VERIFY_TLS", default_verify_tls)?,
        })
    }
}

/// Import `REQORA_*` settings from dotenv files into the process environment.
///
/// The desktop process is launched directly (shortcut, explorer, `tauri dev`)
/// and nobody loads `.env.production` for it, so editing the global config
/// file previously had no effect on update/endpoint settings. Called once at
/// the top of `Config::from_env`, before any value is read. An already-set
/// process variable always wins; within a directory, later files win.
///
/// # Safety
/// `env::set_var` is unsafe since edition 2024 (it races with concurrent env
/// readers). This runs before the Tauri runtime spawns any worker thread.
pub fn load_dotenv_files() {
    for dir in dotenv_search_dirs() {
        for name in DOTENV_FILES {
            let Ok(text) = std::fs::read_to_string(dir.join(name)) else {
                continue;
            };
            for (key, value) in parse_dot_env(&text) {
                if env::var_os(&key).is_none() {
                    // SAFETY: single-threaded startup, see function docs.
                    unsafe { env::set_var(&key, &value) };
                }
            }
        }
    }
}

/// Directories searched for dotenv files, lowest priority first:
/// machine-local defaults, launch directory, then the executable's directory
/// (so a config shipped next to the binary wins over stray cwd files).
fn dotenv_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(home) = env::var("USERPROFILE").or_else(|_| env::var("HOME")) {
        dirs.push(PathBuf::from(home).join(".reqora"));
    }
    if let Ok(cwd) = env::current_dir() {
        for dir in ancestor_dirs(&cwd) {
            push_unique(&mut dirs, dir);
        }
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            for dir in ancestor_dirs(parent) {
                push_unique(&mut dirs, dir);
            }
        }
    }
    dirs
}

/// Nearest ancestor last, so the most specific directory is loaded last.
fn ancestor_dirs(start: &Path) -> Vec<PathBuf> {
    start
        .ancestors()
        .take(6)
        .map(Path::to_path_buf)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn push_unique(dirs: &mut Vec<PathBuf>, dir: PathBuf) {
    if !dirs.contains(&dir) {
        dirs.push(dir);
    }
}

/// Minimal dotenv parser mirroring `parseDotEnv` in scripts/release-env.mjs:
/// `export KEY=value`, single/double quotes and trailing `#` comments.
/// Malformed lines and non-`REQORA_` keys are skipped.
fn parse_dot_env(text: &str) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key_part, value_part)) = line.split_once('=') else {
            continue;
        };
        let key = key_part.trim();
        let key = match key.strip_prefix("export") {
            Some(rest) if rest.starts_with(char::is_whitespace) => rest.trim(),
            _ => key,
        };
        if !key.starts_with(DOTENV_PREFIX)
            || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            continue;
        }
        let raw_value = value_part.trim();
        let bytes = raw_value.as_bytes();
        let value = if bytes.len() >= 2
            && (bytes[0] == b'"' || bytes[0] == b'\'')
            && bytes.last() == Some(&bytes[0])
        {
            let inner = &raw_value[1..raw_value.len() - 1];
            if bytes[0] == b'"' {
                inner.replace("\\n", "\n").replace("\\r", "\r")
            } else {
                inner.to_string()
            }
        } else {
            strip_inline_comment(raw_value).to_string()
        };
        if !value.contains('\0') {
            pairs.push((key.to_string(), value));
        }
    }
    pairs
}

fn strip_inline_comment(raw: &str) -> &str {
    raw.find(" #")
        .map(|index| raw[..index].trim_end())
        .unwrap_or(raw)
}

/// Reads an optional http(s) URL; empty or absent values mean "unset".
fn optional_url(name: &str) -> Result<Option<String>, String> {
    match env::var(name) {
        Ok(raw) => {
            let trimmed = raw.trim().to_string();
            if trimmed.is_empty() {
                return Ok(None);
            }
            let url = reqwest::Url::parse(&trimmed)
                .map_err(|_| format!("{name} 必须是完整的 http(s) URL，当前值: {trimmed}"))?;
            if !matches!(url.scheme(), "http" | "https") {
                return Err(format!("{name} 必须是 http(s) URL，当前值: {trimmed}"));
            }
            Ok(Some(trimmed))
        }
        Err(env::VarError::NotPresent) => Ok(None),
        Err(err) => Err(format!("{name} 读取失败: {err}")),
    }
}

/// Reads the update-manifest URL from `REQORA_UPDATE_MANIFEST_URL`.
///
/// Runtime env / dotenv files win. When unset, dev builds use the checkout
/// fallback and release builds use the URL baked in by `release.mjs`; an
/// installed app has no repo `.env.production` to discover. Plaintext http is
/// only tolerated for loopback hosts (local dev servers).
fn update_manifest_url() -> Option<String> {
    match optional_url("REQORA_UPDATE_MANIFEST_URL") {
        Ok(Some(url)) => allowed_manifest_url(url),
        Ok(None) => {
            #[cfg(debug_assertions)]
            let fallback = Some(UPDATE_MANIFEST_DEV_URL);
            #[cfg(not(debug_assertions))]
            let fallback = UPDATE_MANIFEST_BUILD_URL;
            fallback.and_then(|url| allowed_manifest_url(url.to_string()))
        }
        Err(_) => None,
    }
}

/// Apply the same HTTPS/loopback policy to runtime and build-time URLs.
fn allowed_manifest_url(url: String) -> Option<String> {
    let allowed = reqwest::Url::parse(&url)
        .map(|parsed| crate::trust::manifest_url_allowed(&parsed))
        .unwrap_or(false);
    if !allowed {
        eprintln!("[config] REQORA_UPDATE_MANIFEST_URL 必须使用 HTTPS，已禁用更新检查");
        return None;
    }
    Some(url)
}

/// Parse a boolean captured at build time. Absent/empty means "no override";
/// an invalid value is a build configuration error and must fail loudly.
fn build_time_bool(name: &str, raw: Option<&str>, default: bool) -> Result<bool, String> {
    match raw {
        Some(value) if !value.trim().is_empty() => parse_bool(name, value),
        _ => Ok(default),
    }
}

/// The verifying key is a trust root: an invalid override must fail fast
/// instead of silently disabling signature verification.
fn update_public_key() -> Result<Vec<u8>, String> {
    match env::var("REQORA_UPDATE_PUBLIC_KEY") {
        Ok(raw) if !raw.trim().is_empty() => {
            crate::trust::decode_public_key(raw.trim())
        }
        _ => Ok(crate::trust::default_public_key()),
    }
}

/// Parse a boolean flag. Invalid values fail fast at startup: silently
/// defaulting here could turn TLS verification off (or on) without the
/// deployer noticing. Accepts the usual 1/0, true/false, yes/no and on/off
/// spellings, case-insensitively.
fn parse_bool(name: &str, raw: &str) -> Result<bool, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        other => Err(format!(
            "{name} 必须是 true|false（也接受 1|0、yes|no、on|off），当前值: {other}"
        )),
    }
}

fn env_bool(name: &str, default: bool) -> Result<bool, String> {
    match env::var(name) {
        Ok(raw) => parse_bool(name, &raw),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(err) => Err(format!("{name} 读取失败: {err}")),
    }
}

fn bounded(name: &str, default: u64, min: u64, max: u64) -> Result<u64, String> {
    match env::var(name) {
        Ok(raw) => {
            let value = raw
                .trim()
                .parse::<u64>()
                .map_err(|_| format!("{name} 必须是正整数，当前值: {raw}"))?;
            if !(min..=max).contains(&value) {
                return Err(format!("{name} 必须在 {min}..={max} 之间，当前值: {value}"));
            }
            Ok(value)
        }
        Err(env::VarError::NotPresent) => Ok(default),
        Err(err) => Err(format!("{name} 读取失败: {err}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_level_filters_by_verbosity() {
        assert!(!LogLevel::Info.enabled(LogLevel::Debug));
        assert!(LogLevel::Info.enabled(LogLevel::Info));
        assert!(LogLevel::Info.enabled(LogLevel::Error));
        assert_eq!(LogLevel::parse(" WARN ").unwrap(), LogLevel::Warn);
        assert!(LogLevel::parse("verbose").is_err());
    }

    #[test]
    fn defaults_are_sane() {
        let config = Config::defaults();
        assert!(config.request_timeout_secs > 0);
        assert_eq!(config.max_response_bytes, 10 * 1024 * 1024);
        assert_eq!(config.inline_body_bytes, 256 * 1024);
        assert_eq!(config.max_body_spool_bytes, 256 * 1024 * 1024);
        assert!((1024..=8 * 1024 * 1024).contains(&config.inline_body_bytes));
        assert!((1024 * 1024..=1024 * 1024 * 1024).contains(&config.max_body_spool_bytes));
        assert_eq!(config.log_level, LogLevel::Info);
        // Secure by default: an operator must opt out explicitly.
        assert!(config.update_verify_tls);
    }

    /// Conformance against the shared JSON vector consumed by both the Rust
    /// and the JS (`scripts/release-env.mjs`) parsers. Guards against one side
    /// drifting: adding a case here means both implementations must agree.
    #[test]
    fn dotenv_parser_matches_shared_contract_vector() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/fixtures/dotenv-contract.json");
        let raw = std::fs::read_to_string(&fixture)
            .unwrap_or_else(|e| panic!("无法读取共享 dotenv 契约向量 {}: {e}", fixture.display()));
        let doc: serde_json::Value =
            serde_json::from_str(&raw).expect("共享 dotenv 契约向量必须是合法 JSON");
        for case in doc["cases"].as_array().expect("cases 必须是数组") {
            let name = case["name"].as_str().unwrap_or("?");
            let input = case["input"].as_str().unwrap_or("");
            let expected: Vec<(String, String)> = case["expected"]
                .as_array()
                .expect("expected 必须是数组")
                .iter()
                .map(|pair| {
                    (
                        pair[0].as_str().unwrap_or("").to_string(),
                        pair[1].as_str().unwrap_or("").to_string(),
                    )
                })
                .collect();
            assert_eq!(parse_dot_env(input), expected, "用例失败: {name}");
        }
    }

    #[test]
    fn dotenv_parser_matches_release_script_semantics() {
        let text = r#"
# a comment
REQORA_UPDATE_VERIFY_TLS=false
export REQORA_LOG_LEVEL = " info "
REQORA_RELEASE_URL_BASE=https://example.com/reqora # trailing note
REQORA_MULTILINE="line1\nline2"
REQORA_QUOTED='literal \n'
PATH=/must/not/import
broken line without equals
"#;
        assert_eq!(
            parse_dot_env(text),
            vec![
                ("REQORA_UPDATE_VERIFY_TLS".to_string(), "false".to_string()),
                ("REQORA_LOG_LEVEL".to_string(), " info ".to_string()),
                (
                    "REQORA_RELEASE_URL_BASE".to_string(),
                    "https://example.com/reqora".to_string()
                ),
                ("REQORA_MULTILINE".to_string(), "line1\nline2".to_string()),
                ("REQORA_QUOTED".to_string(), "literal \\n".to_string()),
            ]
        );
    }

    #[test]
    fn bool_flags_parse_strictly() {
        for raw in ["true", " TRUE ", "1", "yes", "ON"] {
            assert_eq!(
                parse_bool("REQORA_UPDATE_VERIFY_TLS", raw),
                Ok(true),
                "{raw}"
            );
        }
        for raw in ["false", " FALSE ", "0", "no", "Off"] {
            assert_eq!(
                parse_bool("REQORA_UPDATE_VERIFY_TLS", raw),
                Ok(false),
                "{raw}"
            );
        }
        for raw in ["", "maybe", "2", "enable"] {
            assert!(
                parse_bool("REQORA_UPDATE_VERIFY_TLS", raw).is_err(),
                "{raw}"
            );
        }
    }

    #[test]
    fn build_time_bool_overrides_default_only_when_present() {
        assert_eq!(build_time_bool("T", Some("false"), true), Ok(false));
        assert_eq!(build_time_bool("T", Some(" TRUE "), false), Ok(true));
        assert_eq!(build_time_bool("T", None, true), Ok(true));
        assert_eq!(build_time_bool("T", Some("  "), true), Ok(true));
        assert!(build_time_bool("T", Some("maybe"), true).is_err());
    }

    #[test]
    fn manifest_url_policy_applies_to_baked_in_fallback() {
        let https = "https://example.com/update.json";
        assert_eq!(
            allowed_manifest_url(https.to_string()).as_deref(),
            Some(https)
        );
        assert_eq!(
            allowed_manifest_url("http://example.com/update.json".into()),
            None
        );
        assert_eq!(
            allowed_manifest_url("http://127.0.0.1:8080/update.json".into()).as_deref(),
            Some("http://127.0.0.1:8080/update.json")
        );
    }
}
