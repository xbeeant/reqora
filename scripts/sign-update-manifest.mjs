#!/usr/bin/env node
// Sign (and verify) the self-hosted update manifest consumed by
// src-tauri/src/service/update.rs.
//
// The envelope is:
//   { "payload": "<exact manifest JSON text>", "signature": "<base64 Ed25519>", "keyId": "..." }
// and the signature covers the UTF-8 bytes of `payload` verbatim. No JSON
// canonicalisation is involved, so the Rust verifier and this tool always
// agree on what was signed.
//
// Usage:
//   node scripts/sign-update-manifest.mjs --keygen
//   node scripts/sign-update-manifest.mjs --sign manifest.json --out update.json
//   node scripts/sign-update-manifest.mjs --verify update.json
//   node scripts/sign-update-manifest.mjs --public-key
//
// Private key resolution (never commit the key):
//   1. REQORA_UPDATE_SIGNING_KEY  (64 hex chars, the raw Ed25519 seed)
//   2. ~/.reqora/update-signing.key
// Public key for verification:
//   1. --pubkey <hex|base64> / REQORA_UPDATE_PUBLIC_KEY
//   2. the key compiled into src-tauri/crates/reqora-core/src/trust.rs (DEFAULT_UPDATE_PUBLIC_KEY_HEX)
//
// The inner manifest MUST contain `version` and `expiresAt` (YYYY-MM-DD).
// `expiresAt` is what bounds replay of an old, correctly signed manifest.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_KEY_FILE = join(homedir(), ".reqora", "update-signing.key");
// Compiled into src-tauri/crates/reqora-core/src/trust.rs (DEFAULT_UPDATE_PUBLIC_KEY_HEX).
// Keep in sync with that file — updateManifest.test.mjs 会校验两者一致。
export const DEFAULT_PUBLIC_KEY_HEX =
  "590cc2136bff7ae4a67d29be0179d8a5dbeecf0d27c383b091cbc328b75cd1f4";
// PKCS#8 wrapper for a raw 32-byte Ed25519 seed.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function args() {
  const out = {};
  for (let i = 2; i < process.argv.length; i += 1) {
    const token = process.argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = process.argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

export function seedToPrivateKey(seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) {
    throw new Error("Ed25519 私钥必须是 32 字节 seed（64 位 hex）");
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

export function publicKeyHex(privateKey) {
  const der = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32).toString("hex");
}

function readSeed(explicit) {
  const fromEnv = process.env.REQORA_UPDATE_SIGNING_KEY?.trim();
  const raw = explicit || fromEnv || (existsSync(DEFAULT_KEY_FILE) ? readFileSync(DEFAULT_KEY_FILE, "utf8").trim() : null);
  if (!raw) {
    throw new Error(
      `找不到签名私钥。先运行 --keygen，或设置 REQORA_UPDATE_SIGNING_KEY / --key <路径|hex>。\n` +
        `默认位置：${DEFAULT_KEY_FILE}`,
    );
  }
  const text = /^[0-9a-fA-F]{64}$/.test(raw) ? raw : existsSync(raw) ? readFileSync(raw, "utf8").trim() : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(text)) {
    throw new Error("签名私钥必须是 64 位 hex（32 字节 Ed25519 seed）");
  }
  return Buffer.from(text, "hex");
}

export function decodePublicKey(raw) {
  const text = raw.trim();
  const bytes = /^[0-9a-fA-F]{64}$/.test(text)
    ? Buffer.from(text, "hex")
    : Buffer.from(text, "base64");
  if (bytes.length !== 32) throw new Error("验签公钥必须是 32 字节 raw Ed25519 公钥");
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes]),
    format: "der",
    type: "spki",
  });
}

function verifyKey(options) {
  return decodePublicKey(
    options.pubkey || process.env.REQORA_UPDATE_PUBLIC_KEY || DEFAULT_PUBLIC_KEY_HEX,
  );
}

function isoDateIn(days) {
  const date = new Date(Date.now() + days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

function validIsoDate(raw) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const [year, month, day] = raw.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function signManifest(manifest, privateKey) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest 必须是 JSON 对象");
  }
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("manifest 缺少 version");
  }
  if (typeof manifest.expiresAt !== "string" || !validIsoDate(manifest.expiresAt)) {
    throw new Error("manifest 缺少合法的 expiresAt（YYYY-MM-DD），用于限制签名清单可被重放的时长");
  }
  const payload = JSON.stringify(manifest);
  const signature = edSign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
  return {
    payload,
    signature,
    keyId: publicKeyHex(privateKey).slice(0, 16),
  };
}

export function verifyEnvelope(envelope, publicKey) {
  if (!envelope || typeof envelope.payload !== "string" || typeof envelope.signature !== "string") {
    throw new Error("不是合法的签名信封：需要 payload 与 signature");
  }
  const signature = Buffer.from(envelope.signature, "base64");
  if (signature.length !== 64) throw new Error("签名长度不是 64 字节");
  const ok = edVerify(null, Buffer.from(envelope.payload, "utf8"), publicKey, signature);
  if (!ok) throw new Error("验签失败：payload 被篡改或公钥不匹配");
  const manifest = JSON.parse(envelope.payload);
  if (manifest.expiresAt && manifest.expiresAt < new Date().toISOString().slice(0, 10)) {
    throw new Error(`清单已过期（expiresAt=${manifest.expiresAt}）`);
  }
  return manifest;
}

function main() {
  const options = args();
  if (options.help || options.h) {
    console.log(`Reqora 更新清单签名工具

  --keygen                生成新的 Ed25519 密钥对，私钥写入 ${DEFAULT_KEY_FILE} (0600)
  --public-key            打印当前私钥对应的公钥 hex（配置到 REQORA_UPDATE_PUBLIC_KEY）
  --sign <manifest.json>  签名清单，需配合 --out <update.json>
  --out <file>            签名信封输出路径
  --verify <update.json>  验签并打印内部 manifest
  --key <path|64hex>      指定签名私钥（默认 env REQORA_UPDATE_SIGNING_KEY / ~/.reqora/update-signing.key）
  --pubkey <hex|base64>   指定验签公钥（默认 env / 应用内置公钥）
  --expires <YYYY-MM-DD>  签名时覆盖 manifest 的 expiresAt
  --days <n>              签名时按 n 天后生成 expiresAt（默认 365）

示例：
  node scripts/sign-update-manifest.mjs --keygen
  node scripts/sign-update-manifest.mjs --sign manifest.json --out update.json
  node scripts/sign-update-manifest.mjs --verify update.json`);
    return;
  }

  if (options.keygen) {
    const { privateKey } = generateKeyPairSync("ed25519");
    const der = privateKey.export({ format: "der", type: "pkcs8" });
    const seed = der.subarray(der.length - 32);
    mkdirSync(dirname(DEFAULT_KEY_FILE), { recursive: true });
    writeFileSync(DEFAULT_KEY_FILE, seed.toString("hex"), { mode: 0o600 });
    chmodSync(DEFAULT_KEY_FILE, 0o600);
    const pub = publicKeyHex(privateKey);
    console.log(`私钥已写入：${DEFAULT_KEY_FILE}（权限 0600，绝不要提交到仓库）`);
    console.log(`公钥 hex：${pub}`);
    console.log(`请把公钥写入 src-tauri/crates/reqora-core/src/trust.rs 的 DEFAULT_UPDATE_PUBLIC_KEY_HEX，`);
    console.log(`或设置 REQORA_UPDATE_PUBLIC_KEY=${pub}`);
    return;
  }

  if (options["public-key"]) {
    console.log(publicKeyHex(seedToPrivateKey(readSeed(options.key))));
    return;
  }

  if (options.verify) {
    const file = resolve(String(options.verify));
    const envelope = JSON.parse(readFileSync(file, "utf8"));
    const manifest = verifyEnvelope(envelope, verifyKey(options));
    console.log("验签通过：", JSON.stringify(manifest, null, 2));
    return;
  }

  if (options.sign) {
    if (!options.out) throw new Error("--sign 需要配合 --out <update.json>");
    const source = resolve(String(options.sign));
    const manifest = JSON.parse(readFileSync(source, "utf8"));
    if (options.expires) manifest.expiresAt = String(options.expires);
    if (!manifest.expiresAt) manifest.expiresAt = isoDateIn(Number(options.days ?? 365));
    const envelope = signManifest(manifest, seedToPrivateKey(readSeed(options.key)));
    const out = resolve(String(options.out));
    writeFileSync(out, `${JSON.stringify(envelope, null, 2)}\n`);
    // Self-check: the exact bytes we wrote must verify with the configured
    // public key, so a mismatched keypair can never be published silently.
    verifyEnvelope(JSON.parse(readFileSync(out, "utf8")), verifyKey(options));
    console.log(`已签名并自检通过：${out}`);
    console.log(`  version=${manifest.version} expiresAt=${manifest.expiresAt}`);
    console.log(`  发布该文件到 REQORA_UPDATE_MANIFEST_URL 指向的 HTTPS 地址。`);
    return;
  }

  console.error("未指定操作；用 --help 查看用法。");
  process.exitCode = 1;
}

// Only run the CLI when executed directly; tests import the exported helpers.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`[sign-update-manifest] ${error.message}`);
    process.exitCode = 1;
  }
}
