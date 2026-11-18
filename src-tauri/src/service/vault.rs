//! At-rest encryption for credential-shaped values in the workspace snapshot.
//!
//! Outbound redaction (`src/lib/redact.ts`, `src/lib/privateValues.ts`) only
//! protects data **leaving** the app. Everything the user typed — bearer
//! tokens, basic-auth passwords, API keys, "private" environment variables,
//! DB connection passwords, MCP env secrets, and the same values copied into
//! history / trash / request revisions — used to sit in `workspace.db` as
//! plaintext JSON. This module seals those values at the storage boundary so
//! a database dump, a backup copy or a synced row can no longer reveal them.
//!
//! Design:
//! - Field-level AES-256-GCM, not whole-blob encryption: scalar columns
//!   (name / method / url / position) stay queryable and the sync row model is
//!   unchanged. The WebView always sees plaintext; only the Rust storage layer
//!   (and the Node reader in `bin/vault.mjs`) deals with envelopes.
//! - Envelope: `reqora.enc.v1.<keyId8>.<base64(nonce[12] || ciphertext || tag[16])>`
//!   with a fixed AAD. A fresh random nonce is used for every value. The format
//!   is frozen: T0.3 keychain migration must never change it, or old databases
//!   become undecryptable.
//! - Master key resolution (T0.3): `REQORA_VAULT_KEY` (CI/headless, highest
//!   priority, never written to the keychain) → OS keychain → legacy
//!   `~/.reqora/vault.key` read + migrate → generate 32 fresh bytes. The key is
//!   machine-local and never part of the snapshot, so it never syncs.
//!   Keychain access uses `std::process::Command` with platform CLIs only —
//!   zero new crates. On Windows / no keychain it silently falls back to the
//!   0600 file so offline use is never blocked.
//! - `open()` only touches strings carrying the envelope prefix. Old plaintext
//!   databases keep working and are upgraded on the next save (seal on write).
//! - Decryption failures are hard errors: silently showing ciphertext (or
//!   dropping the value) would corrupt user data.
//!
//! Threat model: with the keychain path, the key is no longer a plaintext file
//! readable by any process running as the same OS user. It still does not
//! protect against a process able to call the same keychain APIs. See README.

use reqora_core::error::AppError;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey, NONCE_LEN};
use ring::digest::{SHA256, digest};
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{Map, Value};
use std::io::Read;
#[cfg(target_os = "linux")]
use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const ENVELOPE_PREFIX: &str = "reqora.enc.v1.";
const AAD: &[u8] = b"reqora/at-rest/v1";
const TAG_LEN: usize = 16;
const KEY_LEN: usize = 32;

// ---------------------------------------------------------------------------
// OS keychain 常量：必须与 bin/vault.mjs 的同名常量逐字一致，否则 CLI 解不开
// 桌面端写入的数据（test/vaultKeychain.test.mjs 会逐字比对两端）。
//   KEYCHAIN_SERVICE        = "reqora"           （secret-tool 的 service）
//   KEYCHAIN_ACCOUNT        = "vault-key"        （secret-tool 的 account）
//   KEYCHAIN_LABEL          = "reqora vault key" （secret-tool 的 --label）
//   MACOS_SECURITY_SERVICE  = "reqora.vault.key"（security -s，固定值）
//   MACOS_SECURITY_ACCOUNT  = "reqora"           （security -a，= SERVICE）
//   Windows / 其它：无可靠零依赖通道，直接回退文件。
// ---------------------------------------------------------------------------
#[allow(dead_code)] // Linux 分支使用；两端常量契约始终保留
pub const KEYCHAIN_SERVICE: &str = "reqora";
#[allow(dead_code)]
pub const KEYCHAIN_ACCOUNT: &str = "vault-key";
#[allow(dead_code)]
pub const KEYCHAIN_LABEL: &str = "reqora vault key";
#[allow(dead_code)] // macOS 分支使用；两端常量契约始终保留
pub const MACOS_SECURITY_SERVICE: &str = "reqora.vault.key";
#[allow(dead_code)]
pub const MACOS_SECURITY_ACCOUNT: &str = "reqora";

/// 平台命令超时；任何失败一律静默回退，绝不抛错、绝不阻断离线使用。
/// 单元测试注入 mock runner，不经过这些生产命令函数，故允许 dead_code。
#[allow(dead_code)]
const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(3);

// ---------------------------------------------------------------------------
// 可注入的 keychain runner：生产用 std::process::Command 调平台命令（零新
// 依赖），测试用 mock（见下方 #[cfg(test)]），绝不在单元测试里触碰真实 OS
// 钥匙串。
// ---------------------------------------------------------------------------

pub trait KeychainRunner {
    /// 命中返回 32 字节；未命中 / 命令不可用 / 超时一律返回 None。
    fn read(&self) -> Option<Vec<u8>>;
    /// 写入成功返回 true；失败返回 false（静默回退）。密钥以 hex 传递。
    fn write(&self, key: &[u8]) -> bool;
}

/// 最小环境启动平台命令：不继承 REQORA_VAULT_KEY 等敏感/无关变量。
#[allow(dead_code)]
fn keychain_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.env_clear();
    cmd.env("PATH", "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin");
    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", home);
    }
    cmd.env("LANG", "C");
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    cmd
}

/// 带超时地等待并捕获 stdout；超时先 kill 再返回 None。keychain 输出只有 64
/// 个 hex 字符，不会撑满管道，所以可以在进程退出后一次性读取。
#[allow(dead_code)]
fn run_with_timeout(mut child: Child) -> Option<(ExitStatus, Vec<u8>)> {
    let deadline = Instant::now() + KEYCHAIN_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = Vec::new();
                if let Some(mut stdout) = child.stdout.take() {
                    stdout.read_to_end(&mut out).ok()?;
                }
                let _ = child.wait();
                return Some((status, out));
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    }
}

#[allow(dead_code)]
fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn decode_key_hex(raw: &str) -> Option<Vec<u8>> {
    let trimmed = raw.trim();
    if trimmed.len() != KEY_LEN * 2 {
        return None;
    }
    decode_hex(trimmed).filter(|bytes| bytes.len() == KEY_LEN)
}

#[allow(dead_code)] // 生产路径使用；#[cfg(test)] 下由 NoopKeychain 顶替
struct SystemKeychain;

impl KeychainRunner for SystemKeychain {
    fn read(&self) -> Option<Vec<u8>> {
        #[cfg(target_os = "macos")]
        {
            let child = keychain_command("security")
                .args([
                    "find-generic-password",
                    "-s",
                    MACOS_SECURITY_SERVICE,
                    "-a",
                    MACOS_SECURITY_ACCOUNT,
                    "-w",
                ])
                .spawn()
                .ok()?;
            let (status, out) = run_with_timeout(child)?;
            if !status.success() {
                return None;
            }
            let hex = String::from_utf8(out).ok()?;
            decode_key_hex(&hex)
        }
        #[cfg(target_os = "linux")]
        {
            let child = keychain_command("secret-tool")
                .args(["lookup", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT])
                .spawn()
                .ok()?;
            let (status, out) = run_with_timeout(child)?;
            if !status.success() {
                return None;
            }
            let hex = String::from_utf8(out).ok()?;
            decode_key_hex(&hex)
        }
        // Windows / 其它：无可靠零依赖通道，静默回退文件。
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            None
        }
    }

    fn write(&self, key: &[u8]) -> bool {
        let hex = hex_encode(key); // hex 而非原始字节；绝不写入日志
        #[cfg(target_os = "macos")]
        {
            let child = keychain_command("security")
                .args([
                    "add-generic-password",
                    "-s",
                    MACOS_SECURITY_SERVICE,
                    "-a",
                    MACOS_SECURITY_ACCOUNT,
                    "-w",
                ])
                .arg(&hex) // 密钥以 hex 出现在命令行参数里
                .arg("-U")
                .spawn();
            match child {
                Ok(child) => run_with_timeout(child)
                    .map(|(status, _)| status.success())
                    .unwrap_or(false),
                Err(_) => false,
            }
        }
        #[cfg(target_os = "linux")]
        {
            // secret-tool store 从 stdin 读值，密钥不进命令行参数。
            let mut cmd = keychain_command("secret-tool");
            cmd.arg("store")
                .arg(format!("--label={KEYCHAIN_LABEL}"))
                .arg("service")
                .arg(KEYCHAIN_SERVICE)
                .arg("account")
                .arg(KEYCHAIN_ACCOUNT)
                .stdin(Stdio::piped());
            let mut child = match cmd.spawn() {
                Ok(child) => child,
                Err(_) => return false,
            };
            if let Some(mut stdin) = child.stdin.take() {
                if stdin.write_all(hex.as_bytes()).is_err() {
                    return false;
                }
            } // drop stdin → EOF
            run_with_timeout(child)
                .map(|(status, _)| status.success())
                .unwrap_or(false)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = hex; // Windows：直接回退 0600 文件
            false
        }
    }
}

/// 单元测试默认 runner：不触碰真实 OS 钥匙串。
#[cfg(test)]
struct NoopKeychain;
#[cfg(test)]
impl KeychainRunner for NoopKeychain {
    fn read(&self) -> Option<Vec<u8>> {
        None
    }
    fn write(&self, _key: &[u8]) -> bool {
        false
    }
}

#[cfg(test)]
fn default_runner() -> &'static dyn KeychainRunner {
    static NOOP: NoopKeychain = NoopKeychain;
    &NOOP
}

#[cfg(not(test))]
fn default_runner() -> &'static dyn KeychainRunner {
    static SYSTEM: SystemKeychain = SystemKeychain;
    &SYSTEM
}

/// Key names that carry a credential by convention. Matching is deliberately
/// generous: encrypting a harmless extra string costs nothing, missing a real
/// secret does. Non-string values (e.g. `KeyValue.secret: true`) are untouched.
/// Keep this list in sync with `bin/vault.mjs`.
const SENSITIVE_NAME_PARTS: &[&str] = &[
    "authorization",
    "cookie",
    "apikey",
    "token",
    "secret",
    "password",
    "passwd",
    "pwd",
    "credential",
    "privatekey",
    "clientsecret",
    "accesskey",
    "sessionid",
    "passphrase",
    "bearer",
    // OAuth 2.0 / AWS SigV4 / mTLS / MQTT / SOAP additions.
    "codeverifier",
    "p12base64",
    "keypem",
    "certpem",
    "capem",
    "accesstoken",
    "refreshtoken",
    "sessiontoken",
    "secretaccesskey",
];

pub fn is_sensitive_key(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .collect();
    SENSITIVE_NAME_PARTS
        .iter()
        .any(|part| normalized.contains(part))
}

pub fn is_envelope(value: &str) -> bool {
    value.starts_with(ENVELOPE_PREFIX)
}

/// Holds the machine-local master key. Cheap to clone; `WorkspaceStore` owns
/// one instance for the lifetime of the process.
#[derive(Clone)]
pub struct Vault {
    key: [u8; KEY_LEN],
    key_id: String,
}

impl Vault {
    /// Load the key following the T0.3 priority order, generating and
    /// persisting a new one on first use. Uses the real OS keychain runner.
    pub fn open_or_create(key_path: &Path) -> Result<Self, AppError> {
        Self::open_or_create_with(key_path, default_runner())
    }

    /// 可注入版本：单元测试传入 mock `KeychainRunner` 覆盖 keychain 命中 /
    /// 不可用 / 迁移成功 / 读回不一致等分支，完全不触碰真实 OS 钥匙串。
    pub fn open_or_create_with(
        key_path: &Path,
        runner: &dyn KeychainRunner,
    ) -> Result<Self, AppError> {
        let key = resolve_key(key_path, runner)?;
        Self::from_bytes(&key)
    }

    fn from_bytes(bytes: &[u8]) -> Result<Self, AppError> {
        if bytes.len() != KEY_LEN {
            return Err(AppError::Storage(format!(
                "静态加密主密钥必须是 {KEY_LEN} 字节，实际 {} 字节（密钥文件可能被替换，请勿删除 ~/.reqora/vault.key）",
                bytes.len()
            )));
        }
        let mut key = [0u8; KEY_LEN];
        key.copy_from_slice(bytes);
        let fingerprint = digest(&SHA256, &key);
        let key_id = fingerprint.as_ref()[..4]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Ok(Self { key, key_id })
    }

    /// Deterministic key for unit tests (never used in production).
    #[cfg(test)]
    pub fn for_tests() -> Self {
        Self::from_bytes(&[42u8; KEY_LEN]).unwrap()
    }

    /// A second deterministic test key, used to prove that a database written
    /// with one master key cannot be silently read with another.
    #[cfg(test)]
    pub fn for_tests_with_key(seed: u8) -> Self {
        Self::from_bytes(&[seed; KEY_LEN]).unwrap()
    }

    /// First 4 bytes of SHA-256(master key), hex encoded. Stored next to
    /// encrypted records so a key swap produces a precise diagnostic instead
    /// of a wall of "decryption failed" errors.
    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    /// Seal one opaque document with the frozen `reqora.enc.v1` envelope.
    /// Field-level `seal()` deliberately leaves non-credential scalars in
    /// plaintext so the sync row model stays queryable; the execution-history
    /// database has no such constraint, so its payload columns use this
    /// whole-record variant and never contain readable response bodies.
    pub fn seal_text(&self, plaintext: &str) -> Result<String, AppError> {
        self.encrypt(plaintext)
    }

    /// Reverse `seal_text`. Idempotent: plaintext (pre-encryption rows) passes
    /// through untouched, matching `open()`'s backwards-compatible behaviour.
    pub fn open_text(&self, value: &str) -> Result<String, AppError> {
        if is_envelope(value) {
            self.decrypt(value)
        } else {
            Ok(value.to_string())
        }
    }

    fn cipher(&self) -> LessSafeKey {
        let unbound = UnboundKey::new(&AES_256_GCM, &self.key)
            .expect("32-byte key is always valid for AES-256-GCM");
        LessSafeKey::new(unbound)
    }

    fn encrypt(&self, plaintext: &str) -> Result<String, AppError> {
        let mut nonce = [0u8; NONCE_LEN];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| AppError::Storage("无法生成加密随机数".into()))?;
        let mut buffer = plaintext.as_bytes().to_vec();
        self.cipher()
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(AAD),
                &mut buffer,
            )
            .map_err(|_| AppError::Storage("凭据加密失败".into()))?;
        let mut blob = nonce.to_vec();
        blob.extend_from_slice(&buffer);
        Ok(format!(
            "{ENVELOPE_PREFIX}{}.{}",
            self.key_id,
            BASE64.encode(&blob)
        ))
    }

    fn decrypt(&self, envelope: &str) -> Result<String, AppError> {
        let rest = envelope
            .strip_prefix(ENVELOPE_PREFIX)
            .ok_or_else(|| AppError::Storage("不是合法的加密信封".into()))?;
        let (kid, encoded) = rest
            .split_once('.')
            .ok_or_else(|| AppError::Storage("加密信封格式不合法".into()))?;
        if kid != self.key_id {
            return Err(AppError::Storage(
                "静态加密主密钥不匹配：请恢复 ~/.reqora/vault.key 或设置 REQORA_VAULT_KEY".into(),
            ));
        }
        let blob = BASE64
            .decode(encoded)
            .map_err(|_| AppError::Storage("加密信封不是合法 base64".into()))?;
        if blob.len() < NONCE_LEN + TAG_LEN {
            return Err(AppError::Storage("加密信封长度不合法".into()));
        }
        let (nonce_bytes, ciphertext) = blob.split_at(NONCE_LEN);
        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(nonce_bytes);
        let mut owned = ciphertext.to_vec();
        let plain = self
            .cipher()
            .open_in_place(Nonce::assume_unique_for_key(nonce), Aad::from(AAD), &mut owned)
            .map_err(|_| {
                AppError::Storage("凭据解密失败：数据被篡改或主密钥不匹配".into())
            })?;
        String::from_utf8(plain.to_vec())
            .map_err(|_| AppError::Storage("凭据解密结果不是合法 UTF-8".into()))
    }

    /// Recursively replace credential-shaped strings with envelopes.
    pub fn seal(&self, value: &Value) -> Result<Value, AppError> {
        self.seal_node(value, "", false)
    }

    fn seal_node(&self, value: &Value, parent_key: &str, in_auth: bool) -> Result<Value, AppError> {
        match value {
            Value::Object(map) => {
                let auth_scope = in_auth || parent_key.eq_ignore_ascii_case("auth");
                let row_sensitive = map.get("secret") == Some(&Value::Bool(true))
                    || matches!(map.get("key"), Some(Value::String(name)) if is_sensitive_key(name));
                let mut out = Map::with_capacity(map.len());
                for (key, child) in map {
                    let next = match child {
                        Value::String(text)
                            if !text.is_empty() && !is_envelope(text) && should_seal(key, row_sensitive, auth_scope) =>
                        {
                            Value::String(self.encrypt(text)?)
                        }
                        Value::Object(_) | Value::Array(_) => {
                            self.seal_node(child, key, auth_scope)?
                        }
                        _ => child.clone(),
                    };
                    out.insert(key.clone(), next);
                }
                Ok(Value::Object(out))
            }
            Value::Array(items) => Ok(Value::Array(
                items
                    .iter()
                    .map(|item| self.seal_node(item, parent_key, in_auth))
                    .collect::<Result<Vec<_>, _>>()?,
            )),
            _ => Ok(value.clone()),
        }
    }

    /// Recursively restore every envelope to plaintext. Idempotent and
    /// backwards compatible: legacy plaintext values pass through untouched.
    pub fn open(&self, value: &Value) -> Result<Value, AppError> {
        match value {
            Value::String(text) if is_envelope(text) => Ok(Value::String(self.decrypt(text)?)),
            Value::Object(map) => {
                let mut out = Map::with_capacity(map.len());
                for (key, child) in map {
                    out.insert(key.clone(), self.open(child)?);
                }
                Ok(Value::Object(out))
            }
            Value::Array(items) => Ok(Value::Array(
                items
                    .iter()
                    .map(|item| self.open(item))
                    .collect::<Result<Vec<_>, _>>()?,
            )),
            _ => Ok(value.clone()),
        }
    }
}

fn should_seal(key: &str, row_sensitive: bool, auth_scope: bool) -> bool {
    if is_sensitive_key(key) {
        return true;
    }
    if row_sensitive && (key == "value" || key == "expected") {
        return true;
    }
    // `auth: { type: "apiKey", key: "X-Key", value: "..." }` — the leaf key
    // itself is not credential-shaped, so cover the whole auth object. The
    // extended variants carry tokens, PKCE verifiers, signing keys and PEM
    // material under field names that are not obviously credential-shaped.
    auth_scope
        && matches!(
            key,
            "value"
                | "key"
                | "code"
                | "codeVerifier"
                | "accessToken"
                | "refreshToken"
                | "clientSecret"
                | "secretAccessKey"
                | "sessionToken"
                | "keyPem"
                | "certPem"
                | "caPem"
                | "p12Base64"
                | "password"
        )
}

/// 按 T0.3 优先级解析 32 字节主密钥。所有 keychain 失败都静默回退，绝不因为
/// 离线/无钥匙串而阻断应用启动。信封格式在此处完全不涉及。
fn resolve_key(key_path: &Path, runner: &dyn KeychainRunner) -> Result<[u8; KEY_LEN], AppError> {
    // (1) ENV 最高优先（CI / headless），且绝不写 keychain。
    if let Some(raw) = std::env::var("REQORA_VAULT_KEY")
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
    {
        let bytes = decode_key_hex(&raw).ok_or_else(|| {
            AppError::Storage("REQORA_VAULT_KEY 必须是 64 位 hex（32 字节）".into())
        })?;
        let mut key = [0u8; KEY_LEN];
        key.copy_from_slice(&bytes);
        return Ok(key);
    }

    // (2) OS keychain 命中。
    if let Some(bytes) = runner.read() {
        if bytes.len() == KEY_LEN {
            let mut key = [0u8; KEY_LEN];
            key.copy_from_slice(&bytes);
            return Ok(key);
        }
        // 长度异常当作未命中，继续回退，不抛错。
    }

    // (3) 旧文件读取 + 迁移：写进 keychain → 读回校验字节一致 → 成功后删除
    //     旧文件；任何一步失败都完全沿用旧文件，绝不删、绝不丢数据。
    if let Ok(raw) = std::fs::read(key_path) {
        if raw.len() != KEY_LEN {
            return Err(AppError::Storage(format!(
                "静态加密主密钥必须是 {KEY_LEN} 字节，实际 {} 字节（密钥文件可能被替换，请勿删除 ~/.reqora/vault.key）",
                raw.len()
            )));
        }
        if runner.write(&raw) {
            if let Some(back) = runner.read() {
                if back == raw {
                    let _ = std::fs::remove_file(key_path);
                }
            }
        }
        let mut key = [0u8; KEY_LEN];
        key.copy_from_slice(&raw);
        return Ok(key);
    }

    // (4) 都没有：生成 32 字节新密钥，优先写 keychain；失败再写 0600 文件。
    let mut key = [0u8; KEY_LEN];
    SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| AppError::Storage("无法生成静态加密主密钥".into()))?;
    if !runner.write(&key) {
        if let Some(parent) = key_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| AppError::Storage(format!("创建密钥目录失败: {error}")))?;
        }
        std::fs::write(key_path, key)
            .map_err(|error| AppError::Storage(format!("写入静态加密主密钥失败: {error}")))?;
        restrict_permissions(key_path);
    }
    Ok(key)
}

fn decode_hex(raw: &str) -> Option<Vec<u8>> {
    let bytes = raw.as_bytes();
    if bytes.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {
    // Windows: inherit the user profile ACL. The key file lives under the
    // user's home directory, which is already user-scoped.
}

#[cfg(test)]
#[path = "vault/tests.rs"]
mod tests;

// ---------------------------------------------------------------------------
// T0.3：用注入的 mock runner 覆盖 keychain 各分支。绝不调用真实 `security` /
// `secret-tool`，也不改写用户钥匙串。
// ---------------------------------------------------------------------------
#[cfg(test)]
mod keychain_tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_key_path() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir()
            .join(format!("reqora-keychain-{}-{n}", crate::logging::now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("vault.key")
    }

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// 闭包式 mock：`read` / `write` 完全由测试控制。
    fn mock(
        read_fn: impl Fn() -> Option<Vec<u8>> + 'static,
        write_fn: impl Fn(&[u8]) -> bool + 'static,
    ) -> impl KeychainRunner {
        struct ClosureKeychain {
            read_fn: Box<dyn Fn() -> Option<Vec<u8>>>,
            write_fn: Box<dyn Fn(&[u8]) -> bool>,
        }
        impl KeychainRunner for ClosureKeychain {
            fn read(&self) -> Option<Vec<u8>> {
                (self.read_fn)()
            }
            fn write(&self, key: &[u8]) -> bool {
                (self.write_fn)(key)
            }
        }
        ClosureKeychain {
            read_fn: Box::new(read_fn),
            write_fn: Box::new(write_fn),
        }
    }

    /// 状态化 keychain：初始为空，write 存入，read 读回（可模拟真实读写）。
    fn stateful_keychain() -> (Rc<RefCell<Option<Vec<u8>>>>, impl KeychainRunner) {
        let store: Rc<RefCell<Option<Vec<u8>>>> = Rc::new(RefCell::new(None));
        let s1 = store.clone();
        let s2 = store.clone();
        (
            store.clone(),
            mock(
                move || s1.borrow().clone(),
                move |key| {
                    *s2.borrow_mut() = Some(key.to_vec());
                    true
                },
            ),
        )
    }

    fn key_id(bytes: &[u8]) -> String {
        Vault::from_bytes(bytes).unwrap().key_id
    }

    #[test]
    fn keychain_hit_wins_over_legacy_file() {
        let path = temp_key_path();
        let file_key = vec![7u8; KEY_LEN];
        let chain_key = vec![42u8; KEY_LEN];
        std::fs::write(&path, &file_key).unwrap();
        let stored = chain_key.clone();
        let runner = mock(move || Some(stored.clone()), |_| true);
        let vault = Vault::open_or_create_with(&path, &runner).unwrap();
        assert_eq!(vault.key_id, key_id(&chain_key), "keychain 命中优先");
        assert!(path.exists(), "keychain 命中分支不改动旧文件");
        cleanup(&path);
    }

    #[test]
    fn keychain_unavailable_silently_falls_back_to_file() {
        let path = temp_key_path();
        let file_key = vec![7u8; KEY_LEN];
        std::fs::write(&path, &file_key).unwrap();
        let runner = mock(|| None, |_| false);
        let vault = Vault::open_or_create_with(&path, &runner).unwrap();
        assert_eq!(vault.key_id, key_id(&file_key));
        assert!(path.exists(), "写入 keychain 失败必须完整保留旧文件");
        cleanup(&path);
    }

    #[test]
    fn migration_deletes_file_only_after_byte_identical_readback() {
        let path = temp_key_path();
        let file_key = vec![9u8; KEY_LEN];
        std::fs::write(&path, &file_key).unwrap();
        let (store, runner) = stateful_keychain();
        let vault = Vault::open_or_create_with(&path, &runner).unwrap();
        assert_eq!(vault.key_id, key_id(&file_key));
        assert_eq!(*store.borrow(), Some(file_key.clone()), "keychain 存的是同一把密钥");
        assert!(!path.exists(), "读回一致后必须删除旧文件");

        // 删掉文件后再次解析，只能从 keychain 取回同一把密钥；旧信封仍可解密。
        let s1 = store.clone();
        let s2 = store.clone();
        let runner2 = mock(
            move || s1.borrow().clone(),
            move |k| {
                *s2.borrow_mut() = Some(k.to_vec());
                true
            },
        );
        let again = Vault::open_or_create_with(&path, &runner2).unwrap();
        assert_eq!(again.key_id, key_id(&file_key), "删文件后仍能从 keychain 恢复");
        let sealed = Vault::from_bytes(&file_key)
            .unwrap()
            .seal(&json!({ "token": "legacy-value" }))
            .unwrap();
        assert_eq!(
            again.open(&sealed).unwrap(),
            json!({ "token": "legacy-value" }),
            "信封格式不变，旧库仍可解密"
        );
        cleanup(&path);
    }

    #[test]
    fn readback_mismatch_keeps_legacy_file() {
        let path = temp_key_path();
        let file_key = vec![9u8; KEY_LEN];
        std::fs::write(&path, &file_key).unwrap();
        let reads = Rc::new(RefCell::new(0usize));
        let counter = reads.clone();
        let runner = mock(
            move || {
                let mut n = counter.borrow_mut();
                *n += 1;
                if *n == 1 {
                    None // 首次未命中
                } else {
                    Some(vec![99u8; KEY_LEN]) // 迁移后读回不一致
                }
            },
            |_| true,
        );
        let vault = Vault::open_or_create_with(&path, &runner).unwrap();
        assert_eq!(vault.key_id, key_id(&file_key));
        assert!(path.exists(), "读回字节不一致时绝不删除旧文件");
        cleanup(&path);
    }

    #[test]
    fn fresh_key_prefers_keychain_and_skips_file() {
        let path = temp_key_path();
        let (store, runner) = stateful_keychain();
        let vault = Vault::open_or_create_with(&path, &runner).unwrap();
        assert_eq!(store.borrow().as_ref().map(|b| key_id(b)), Some(vault.key_id.clone()));
        assert!(!path.exists(), "keychain 可写时不再落 0600 文件");
        cleanup(&path);
    }
}
