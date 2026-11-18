// Node-side counterpart of src-tauri/src/service/vault.rs.
//
// The desktop app seals credential-shaped strings before they reach SQLite.
// Out-of-app processes (CLI / MCP server) read that same database directly
// through bin/workspaceStore.mjs, so they must be able to open and re-seal
// values with the *same* format and the *same* machine-local key.
//
// Envelope: reqora.enc.v1.<keyId8>.<base64(nonce[12] || ciphertext || tag[16])>
// AES-256-GCM, AAD = "reqora/at-rest/v1", keyId8 = first 4 bytes of SHA-256(key).
// 信封格式绝不随 keychain 迁移改变，否则旧库全解不开。
//
// 主密钥解析顺序（与 vault.rs 完全一致）：
//   REQORA_VAULT_KEY（CI/headless，最高优先且不写 keychain）
//   → OS keychain → 旧 ~/.reqora/vault.key 读取并迁移
//   → 都没有则生成新密钥，优先写 keychain，失败再写 0600 文件。
//
// Keep SENSITIVE_NAME_PARTS / the traversal rules in sync with vault.rs —
// test/atRest.test.mjs checks a shared vector on both sides.

import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

const ENVELOPE_PREFIX = "reqora.enc.v1.";
const AAD = Buffer.from("reqora/at-rest/v1", "utf8");
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

// ---------------------------------------------------------------------------
// OS keychain 常量：必须与 src-tauri/src/service/vault.rs 的同名常量逐字一致，
// 否则 CLI 解不开桌面端写入的数据。
//   KEYCHAIN_SERVICE        = "reqora"           （secret-tool 的 service）
//   KEYCHAIN_ACCOUNT        = "vault-key"        （secret-tool 的 account）
//   KEYCHAIN_LABEL          = "reqora vault key" （secret-tool 的 --label）
//   MACOS_SECURITY_SERVICE  = "reqora.vault.key"（security -s，固定值）
//   MACOS_SECURITY_ACCOUNT  = "reqora"           （security -a，= SERVICE）
//   Windows / 其它平台：没有可靠的零依赖通道，直接回退文件（见 keychainCommands）。
// ---------------------------------------------------------------------------
export const KEYCHAIN_SERVICE = "reqora";
export const KEYCHAIN_ACCOUNT = "vault-key";
export const KEYCHAIN_LABEL = "reqora vault key";
export const MACOS_SECURITY_SERVICE = "reqora.vault.key";
export const MACOS_SECURITY_ACCOUNT = "reqora";

/** 外部命令超时；任何失败一律静默回退，绝不阻断离线使用。 */
const KEYCHAIN_TIMEOUT_MS = 3000;
/** 子进程只拿最小环境，不继承 REQORA_VAULT_KEY 等敏感/无关变量。 */
const KEYCHAIN_ENV = {
  PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
  HOME: process.env.HOME ?? "",
  LANG: "C",
};

/**
 * 平台命令表（导出便于测试断言双端常量一致）。
 * `stdin: true` 表示密钥从 stdin 写入，`false` 表示以 hex 出现在命令行参数里。
 */
export function keychainCommands(platformName = platform()) {
  if (platformName === "darwin") {
    return {
      read: {
        program: "security",
        args: ["find-generic-password", "-s", MACOS_SECURITY_SERVICE, "-a", MACOS_SECURITY_ACCOUNT, "-w"],
      },
      write: {
        program: "security",
        // -w 后面追加 <hex>（不是原始字节），-U 表示存在则更新。
        args: ["add-generic-password", "-s", MACOS_SECURITY_SERVICE, "-a", MACOS_SECURITY_ACCOUNT, "-w"],
        stdin: false,
      },
    };
  }
  if (platformName === "linux") {
    return {
      read: {
        program: "secret-tool",
        args: ["lookup", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT],
      },
      write: {
        program: "secret-tool",
        // secret-tool store 从 stdin 读值，密钥不进命令行参数。
        args: ["store", `--label=${KEYCHAIN_LABEL}`, "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT],
        stdin: true,
      },
    };
  }
  // Windows：无可靠零依赖 keychain 通道 → 直接回退文件。
  return null;
}

/** 默认 exec：带超时、净化环境、丢弃 stderr。可注入替换以便测试。 */
export function defaultKeychainExec(program, args, options = {}) {
  return execFileSync(program, args, {
    encoding: "utf8",
    input: options.input,
    timeout: KEYCHAIN_TIMEOUT_MS,
    stdio: ["pipe", "pipe", "ignore"],
    env: KEYCHAIN_ENV,
  });
}

/** 读 keychain，返回 32 字节 Buffer；未命中/失败返回 null（静默回退）。 */
export function keychainRead(exec = defaultKeychainExec, platformName = platform()) {
  const cmds = keychainCommands(platformName);
  if (!cmds) return null;
  try {
    const out = exec(cmds.read.program, cmds.read.args);
    const hex = String(out ?? "").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
    return Buffer.from(hex, "hex");
  } catch {
    return null;
  }
}

/** 写 keychain，密钥一律以 hex 传递；失败返回 false（静默回退）。不写日志。 */
export function keychainWrite(keyBytes, exec = defaultKeychainExec, platformName = platform()) {
  const cmds = keychainCommands(platformName);
  if (!cmds) return false;
  const hex = Buffer.from(keyBytes).toString("hex");
  try {
    if (cmds.write.stdin) {
      exec(cmds.write.program, cmds.write.args, { input: hex });
    } else {
      exec(cmds.write.program, [...cmds.write.args, hex, "-U"]);
    }
    return true;
  } catch {
    return false;
  }
}

const defaultFs = {
  existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, unlinkSync,
};

const SENSITIVE_NAME_PARTS = [
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
  // Keep in sync with src-tauri/src/service/vault.rs.
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

export function isSensitiveKey(key) {
  const normalized = String(key).replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return SENSITIVE_NAME_PARTS.some((part) => normalized.includes(part));
}

export function isEnvelope(value) {
  return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}

/** Same lookup order as the desktop app: env → keychain → ~/.reqora/vault.key. */
export function vaultKeyPath() {
  const explicit = process.env.REQORA_VAULT_KEY_FILE?.trim();
  if (explicit) return explicit;
  const home = homedir();
  const primary = join(home, ".reqora", "vault.key");
  if (existsSync(primary)) return primary;
  const legacy = {
    darwin: join(home, "Library", "Application Support", "com.xbeeant.reqora"),
    win32: join(home, "AppData", "Roaming", "com.xbeeant.reqora"),
    linux: join(home, ".local", "share", "com.xbeeant.reqora"),
  }[platform()];
  if (legacy && existsSync(join(legacy, "vault.key"))) return join(legacy, "vault.key");
  return primary;
}

let cachedKey = null;
let cachedKeyId = null;

/**
 * 纯逻辑：按 env → keychain → 旧文件迁移 → 生成新密钥 的顺序解析主密钥。
 *
 * 所有外部依赖都可注入（exec / fs / env / rng / keyPath / platformName），
 * 因此 test/vaultKeychain.test.mjs 能在完全不触碰真实 OS 钥匙串与真实用户
 * 目录的前提下覆盖所有分支。返回的始终是 32 字节 Buffer。
 *
 * `REQORA_VAULT_DISABLE_KEYCHAIN=1` 是显式逃生开关（CI/headless/回归测试），
 * 打开后完全跳过 keychain，只走文件，避免测试改写用户钥匙串。
 */
export function resolveVaultKey(options = {}) {
  const {
    env = process.env,
    exec = defaultKeychainExec,
    platformName = platform(),
    keyPath = vaultKeyPath(),
    fs = defaultFs,
    randomBytes: rng = () => randomBytes(KEY_LEN),
  } = options;
  const useKeychain = env.REQORA_VAULT_DISABLE_KEYCHAIN !== "1";

  // (1) ENV 最高优先（CI / headless），且绝不写 keychain。
  const fromEnv = String(env.REQORA_VAULT_KEY ?? "").trim();
  if (fromEnv) {
    if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) {
      throw new Error("REQORA_VAULT_KEY 必须是 64 位 hex（32 字节）");
    }
    return Buffer.from(fromEnv, "hex");
  }

  // (2) OS keychain 命中。
  if (useKeychain) {
    const fromChain = keychainRead(exec, platformName);
    if (fromChain) return fromChain;
  }

  // (3) 旧文件读取并迁移：写进 keychain → 读回校验字节一致 → 成功后删除旧文件；
  //     任何一步失败都完全沿用旧文件，绝不删、绝不丢数据。
  if (fs.existsSync(keyPath)) {
    const buf = Buffer.from(fs.readFileSync(keyPath));
    if (buf.length !== KEY_LEN) {
      throw new Error(
        `静态加密主密钥必须是 ${KEY_LEN} 字节，实际 ${buf.length} 字节（${keyPath}）。` +
          " 请恢复原来的 vault.key，或同时设置桌面端与 CLI 的 REQORA_VAULT_KEY。",
      );
    }
    if (useKeychain && keychainWrite(buf, exec, platformName)) {
      const readBack = keychainRead(exec, platformName);
      if (readBack && readBack.equals(buf)) {
        try {
          fs.unlinkSync(keyPath);
        } catch {
          // 删除失败：保留旧文件，下次启动仍可解密。
        }
      }
    }
    return buf;
  }

  // (4) 都没有：生成 32 字节新密钥，优先写 keychain；失败再写 0600 文件。
  const fresh = Buffer.from(rng());
  if (fresh.length !== KEY_LEN) throw new Error("无法生成 32 字节主密钥");
  if (!useKeychain || !keychainWrite(fresh, exec, platformName)) {
    fs.mkdirSync(dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, fresh, { mode: 0o600 });
    try {
      fs.chmodSync(keyPath, 0o600);
    } catch {
      // Windows may not support chmod; the home directory ACL still applies.
    }
  }
  return fresh;
}

/** Returns the 32-byte master key, creating it on first use. */
export function vaultKey() {
  if (cachedKey) return cachedKey;
  const bytes = resolveVaultKey({});
  cachedKey = bytes;
  cachedKeyId = createHash("sha256").update(bytes).digest().subarray(0, 4).toString("hex");
  return cachedKey;
}

export function vaultKeyId() {
  vaultKey();
  return cachedKeyId;
}

/** Test-only deterministic vector builder (no randomness). */
export function encryptTextWith(key, nonce, text) {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(text, "utf8")), cipher.final()]);
  const blob = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
  const keyId = createHash("sha256").update(key).digest().subarray(0, 4).toString("hex");
  return `${ENVELOPE_PREFIX}${keyId}.${blob.toString("base64")}`;
}

export function encryptText(text) {
  return encryptTextWith(vaultKey(), randomBytes(NONCE_LEN), text);
}

export function decryptText(envelope) {
  if (!isEnvelope(envelope)) throw new Error("不是合法的静态加密信封");
  const rest = envelope.slice(ENVELOPE_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot < 0) throw new Error("加密信封格式不合法");
  const keyId = rest.slice(0, dot);
  if (keyId !== vaultKeyId()) {
    throw new Error("静态加密主密钥不匹配：请恢复 ~/.reqora/vault.key 或设置 REQORA_VAULT_KEY");
  }
  const blob = Buffer.from(rest.slice(dot + 1), "base64");
  if (blob.length < NONCE_LEN + TAG_LEN) throw new Error("加密信封长度不合法");
  const nonce = blob.subarray(0, NONCE_LEN);
  const ciphertext = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", vaultKey(), nonce);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("凭据解密失败：数据被篡改或主密钥不匹配");
  }
}

function shouldSeal(key, rowSensitive, authScope) {
  if (isSensitiveKey(key)) return true;
  if (rowSensitive && (key === "value" || key === "expected")) return true;
  // Keep in sync with vault.rs::should_seal.
  return authScope && [
    "value", "key", "code", "codeVerifier", "accessToken", "refreshToken",
    "clientSecret", "secretAccessKey", "sessionToken", "keyPem", "certPem",
    "caPem", "p12Base64", "password",
  ].includes(key);
}

function sealNode(value, parentKey, inAuth) {
  if (Array.isArray(value)) {
    return value.map((item) => sealNode(item, parentKey, inAuth));
  }
  if (value && typeof value === "object") {
    const authScope = inAuth || parentKey.toLowerCase() === "auth";
    const rowSensitive =
      value.secret === true ||
      (typeof value.key === "string" && isSensitiveKey(value.key));
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (
        typeof child === "string" &&
        child.length > 0 &&
        !isEnvelope(child) &&
        shouldSeal(key, rowSensitive, authScope)
      ) {
        out[key] = encryptText(child);
      } else if (child && typeof child === "object") {
        out[key] = sealNode(child, key, authScope);
      } else {
        out[key] = child;
      }
    }
    return out;
  }
  return value;
}

function openNode(value) {
  if (typeof value === "string") return isEnvelope(value) ? decryptText(value) : value;
  if (Array.isArray(value)) return value.map(openNode);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = openNode(child);
    return out;
  }
  return value;
}

/** Seal every credential-shaped string in a snapshot / row payload. */
export function sealAtRest(value) {
  return sealNode(value, "", false);
}

/** Restore every envelope; legacy plaintext values pass through untouched. */
export function openAtRest(value) {
  return openNode(value);
}
