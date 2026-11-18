// 自研更新清单签名信封的契约测试。Rust 侧对应 service/update.rs 的单测，
// 两边共用「签名覆盖 payload 原始字节」这一不变式。
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_PUBLIC_KEY_HEX,
  decodePublicKey,
  publicKeyHex,
  seedToPrivateKey,
  signManifest,
  verifyEnvelope,
} from "../scripts/sign-update-manifest.mjs";
import { CLIENT_TRUST_ROOT_FILE } from "../scripts/release-env.mjs";

function keypair() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const seed = der.subarray(der.length - 32);
  const key = seedToPrivateKey(seed);
  return { privateKey: key, pubHex: publicKeyHex(key) };
}

function manifest(overrides = {}) {
  return {
    version: "0.2.0",
    expiresAt: "2099-12-31",
    notes: "修复安全问题",
    url: "https://example.com/a.dmg",
    ...overrides,
  };
}

test("签名覆盖 payload 原始字节，验签还原出同一份清单", () => {
  const { privateKey, pubHex } = keypair();
  const source = manifest();
  const envelope = signManifest(source, privateKey);
  assert.equal(envelope.payload, JSON.stringify(source));
  assert.match(envelope.signature, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(envelope.keyId, pubHex.slice(0, 16));
  assert.deepEqual(verifyEnvelope(envelope, decodePublicKey(pubHex)), source);
});

test("改动 payload 任意一个字节都会验签失败", () => {
  const { privateKey, pubHex } = keypair();
  const envelope = signManifest(manifest(), privateKey);
  const tampered = {
    ...envelope,
    payload: envelope.payload.replace('"0.2.0"', '"9.9.9"'),
  };
  assert.throws(
    () => verifyEnvelope(tampered, decodePublicKey(pubHex)),
    /验签失败/,
  );
  // 仅追加一个空格（JSON 语义完全等价）也必须失败。
  assert.throws(
    () => verifyEnvelope({ ...envelope, payload: `${envelope.payload} ` }, decodePublicKey(pubHex)),
    /验签失败/,
  );
});

test("换一把公钥不会通过", () => {
  const a = keypair();
  const b = keypair();
  const envelope = signManifest(manifest(), a.privateKey);
  assert.throws(() => verifyEnvelope(envelope, decodePublicKey(b.pubHex)), /验签失败/);
});

test("缺少 version / expiresAt 或清单过期一律拒绝", () => {
  const { privateKey, pubHex } = keypair();
  const pub = decodePublicKey(pubHex);
  assert.throws(() => signManifest({ expiresAt: "2099-12-31" }, privateKey), /version/);
  assert.throws(() => signManifest({ version: "0.2.0" }, privateKey), /expiresAt/);
  assert.throws(() => signManifest(manifest({ expiresAt: "2026-13-99" }), privateKey), /expiresAt/);
  assert.throws(
    () => verifyEnvelope(signManifest(manifest({ expiresAt: "2000-01-01" }), privateKey), pub),
    /已过期/,
  );
});

test("明文清单不能冒充签名信封", () => {
  const { pubHex } = keypair();
  assert.throws(
    () => verifyEnvelope({ version: "9.9.9" }, decodePublicKey(pubHex)),
    /不是合法的签名信封/,
  );
});

test("脚本默认公钥与应用内编译的 Rust 公钥保持一致", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", CLIENT_TRUST_ROOT_FILE),
    "utf8",
  );
  const match = source.match(/DEFAULT_UPDATE_PUBLIC_KEY_HEX\s*:[^=]*=\s*"([0-9a-f]{64})"/);
  assert.ok(match, "Rust 侧必须声明内置公钥");
  assert.equal(match[1], DEFAULT_PUBLIC_KEY_HEX);
  assert.equal(Buffer.from(DEFAULT_PUBLIC_KEY_HEX, "hex").length, 32);
});
