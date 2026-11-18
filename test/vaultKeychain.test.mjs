// T0.3 验收：主密钥接 OS keychain，保留 CI 兜底与旧库兼容。
//
// 本文件**只**测 bin/vault.mjs 导出的纯逻辑与注入点：
// exec / fs / env / rng / keyPath / platformName 全部注入，
// 完全不调用真实 `security` / `secret-tool`，也不改写用户钥匙串或用户目录。
import test from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_LABEL,
  KEYCHAIN_SERVICE,
  MACOS_SECURITY_ACCOUNT,
  MACOS_SECURITY_SERVICE,
  encryptTextWith,
  keychainCommands,
  openAtRest,
  resolveVaultKey,
  vaultKey,
} from "../bin/vault.mjs";

// 让 openAtRest / vaultKey() 走 env 通道（不触发任何真实 keychain 命令）。
// 其它用例都显式注入 env: {}，互不干扰。
const LEGACY_KEY = Buffer.alloc(32, 11);
process.env.REQORA_VAULT_KEY = LEGACY_KEY.toString("hex");

const KEY_LEN = 32;
const KNOWN = Buffer.alloc(KEY_LEN, 3);   // keychain 里预置的密钥
const FILEKEY = Buffer.alloc(KEY_LEN, 7); // 旧 vault.key 里的密钥
const FRESH = Buffer.alloc(KEY_LEN, 5);   // 新生成的密钥

// ------------------------------------------------------------------ 假依赖 ----

/** 内存文件系统，绝不落在真实磁盘上。 */
function makeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p);
    },
    writeFileSync: (p, data) => { files.set(p, Buffer.from(data)); },
    unlinkSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      files.delete(p);
    },
    mkdirSync: () => {},
    chmodSync: () => {},
  };
}

/**
 * 假 keychain + 假 exec。记录所有调用以便断言「env 优先不写 keychain」等。
 * 完全不 spawn 任何子进程。
 */
function makeKeychain(initial = null, { failWrite = false } = {}) {
  let store = initial ? Buffer.from(initial) : null;
  const calls = [];
  const exec = (program, args, options = {}) => {
    calls.push({ program, args, input: options.input });
    if (program === "security" && args[0] === "find-generic-password") {
      if (!store) throw new Error("SecKeychainSearchCopyNext: not found");
      return store.toString("hex") + "\n";
    }
    if (program === "security" && args[0] === "add-generic-password") {
      if (failWrite) throw new Error("keychain locked");
      // -w <hex> -U：hex 在倒数第二位
      store = Buffer.from(args[args.length - 2], "hex");
      return "";
    }
    if (program === "secret-tool" && args[0] === "lookup") {
      if (!store) throw new Error("secret-tool: no match");
      return store.toString("hex") + "\n";
    }
    if (program === "secret-tool" && args[0] === "store") {
      if (failWrite) throw new Error("no secret-service");
      store = Buffer.from(options.input, "hex");
      return "";
    }
    throw new Error(`unexpected command: ${program} ${args.join(" ")}`);
  };
  return { exec, calls, getStore: () => store };
}

function neverRandom() {
  throw new Error("本分支不应生成随机密钥");
}

/** 用指定密钥解开一个信封，证明「旧信封仍可解密」且不依赖模块缓存。 */
function openEnvelope(key, envelope) {
  const rest = envelope.slice("reqora.enc.v1.".length);
  const dot = rest.indexOf(".");
  const blob = Buffer.from(rest.slice(dot + 1), "base64");
  const nonce = blob.subarray(0, 12);
  const ciphertext = blob.subarray(12, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from("reqora/at-rest/v1", "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// ------------------------------------------------------------------ 用例 ----

test("T0.3 env 优先且不写 keychain（CI / headless）", () => {
  const kc = makeKeychain(KNOWN);
  const fs = makeFs({ "/tmp/reqora/vault.key": FILEKEY });
  const envHex = Buffer.alloc(KEY_LEN, 21).toString("hex");
  const key = resolveVaultKey({
    env: { REQORA_VAULT_KEY: envHex },
    exec: kc.exec,
    platformName: "darwin",
    keyPath: "/tmp/reqora/vault.key",
    fs,
    randomBytes: neverRandom,
  });
  assert.equal(key.toString("hex"), envHex);
  assert.equal(kc.calls.length, 0, "env 模式下绝不能调用任何 keychain 命令");
  assert.ok(fs.files.has("/tmp/reqora/vault.key"), "env 模式不改动旧文件");
});

test("T0.3 keychain 命中：直接复用命中值，不生成新密钥", () => {
  const kc = makeKeychain(KNOWN);
  const fs = makeFs({ "/tmp/reqora/vault.key": FILEKEY });
  const key = resolveVaultKey({
    env: {}, exec: kc.exec, platformName: "darwin",
    keyPath: "/tmp/reqora/vault.key", fs, randomBytes: neverRandom,
  });
  assert.deepEqual(key, KNOWN);
  assert.equal(kc.calls[0].args[0], "find-generic-password");
});

test("T0.3 keychain 不可用（命令失败 / Windows）时静默回退旧文件", () => {
  // macOS：读不到、写也失败 → 沿用旧文件，绝不删除。
  const kc = makeKeychain(null, { failWrite: true });
  const fs = makeFs({ "/tmp/reqora/vault.key": FILEKEY });
  const key = resolveVaultKey({
    env: {}, exec: kc.exec, platformName: "darwin",
    keyPath: "/tmp/reqora/vault.key", fs, randomBytes: neverRandom,
  });
  assert.deepEqual(key, FILEKEY);
  assert.ok(fs.files.has("/tmp/reqora/vault.key"), "迁移失败必须完整保留旧文件");

  // Windows：无零依赖通道，keychainCommands 返回 null，直接回退文件。
  assert.equal(keychainCommands("win32"), null);
  const fs2 = makeFs({ "/tmp/reqora/vault.key": FILEKEY });
  const key2 = resolveVaultKey({
    env: {}, exec: () => { throw new Error("不应被调用"); },
    platformName: "win32", keyPath: "/tmp/reqora/vault.key", fs: fs2,
    randomBytes: neverRandom,
  });
  assert.deepEqual(key2, FILEKEY);
});

test("T0.3 迁移读回字节不一致时完全沿用旧文件，绝不丢数据", () => {
  let reads = 0;
  const exec = (program, args) => {
    if (args[0] === "find-generic-password") {
      reads += 1;
      if (reads === 1) throw new Error("keychain 未命中");
      return Buffer.alloc(KEY_LEN, 99).toString("hex") + "\n"; // 与旧文件不同
    }
    if (args[0] === "add-generic-password") return "";
    throw new Error(`unexpected command: ${program} ${args.join(" ")}`);
  };
  const fs = makeFs({ "/tmp/reqora/vault.key": FILEKEY });
  const key = resolveVaultKey({
    env: {}, exec, platformName: "darwin",
    keyPath: "/tmp/reqora/vault.key", fs, randomBytes: neverRandom,
  });
  assert.deepEqual(key, FILEKEY);
  assert.ok(fs.files.has("/tmp/reqora/vault.key"), "读回不一致时不能删除旧文件");
});

test("T0.3 迁移成功后删除旧文件，keychain 里的密钥仍能解密旧信封", () => {
  const kc = makeKeychain(null);
  const fs = makeFs({ "/tmp/reqora/vault.key": FILEKEY });
  const key = resolveVaultKey({
    env: {}, exec: kc.exec, platformName: "darwin",
    keyPath: "/tmp/reqora/vault.key", fs, randomBytes: neverRandom,
  });
  assert.deepEqual(key, FILEKEY);
  assert.ok(!fs.files.has("/tmp/reqora/vault.key"), "读回一致后必须删除旧文件");
  assert.deepEqual(kc.getStore(), FILEKEY, "keychain 必须存的是同一把密钥");

  // 删掉文件后再次解析：只能从 keychain 拿回同一把密钥。
  const again = resolveVaultKey({
    env: {}, exec: kc.exec, platformName: "darwin",
    keyPath: "/tmp/reqora/vault.key", fs, randomBytes: neverRandom,
  });
  assert.deepEqual(again, FILEKEY);

  // 用这把密钥解开迁移前写入的信封 —— 信封格式绝不能变。
  const envelope = encryptTextWith(FILEKEY, Buffer.alloc(12, 4), "legacy-sealed-value");
  assert.match(envelope, /^reqora\.enc\.v1\.[0-9a-f]{8}\./);
  assert.equal(openEnvelope(again, envelope), "legacy-sealed-value");
});

test("T0.3 首次生成：keychain 可写时只写 keychain，不可写时落 0600 文件", () => {
  const kc = makeKeychain(null);
  const fs = makeFs({});
  const key = resolveVaultKey({
    env: {}, exec: kc.exec, platformName: "linux",
    keyPath: "/tmp/reqora/fresh/vault.key", fs,
    randomBytes: () => Buffer.from(FRESH),
  });
  assert.deepEqual(key, FRESH);
  assert.deepEqual(kc.getStore(), FRESH);
  assert.ok(!fs.files.has("/tmp/reqora/fresh/vault.key"), "keychain 成功时不再写文件");
  assert.ok(kc.calls.some((c) => c.args[0] === "store" && c.input === FRESH.toString("hex")),
    "secret-tool store 必须从 stdin 收到 hex");

  const kc2 = makeKeychain(null, { failWrite: true });
  const fs2 = makeFs({});
  const key2 = resolveVaultKey({
    env: {}, exec: kc2.exec, platformName: "linux",
    keyPath: "/tmp/reqora/fresh2/vault.key", fs: fs2,
    randomBytes: () => Buffer.from(FRESH),
  });
  assert.deepEqual(key2, FRESH);
  assert.ok(fs2.files.has("/tmp/reqora/fresh2/vault.key"), "keychain 失败必须回退文件");
});

test("T0.3 旧明文 / 旧信封库仍可读（信封格式未变）", () => {
  // 旧明文：open() 只处理带信封前缀的字符串，其余原样透传。
  assert.deepEqual(openAtRest({ token: "still-plain", name: "ok" }),
    { token: "still-plain", name: "ok" });
  // 旧信封：仍能被同一把主密钥解开。
  const envelope = encryptTextWith(LEGACY_KEY, Buffer.alloc(12, 6), "sealed-value");
  assert.deepEqual(openAtRest({ token: envelope }), { token: "sealed-value" });
  assert.deepEqual(vaultKey(), LEGACY_KEY, "env 模式返回的就是这把主密钥");
});

test("T0.3 双端常量与平台命令一致", () => {
  assert.equal(KEYCHAIN_SERVICE, "reqora");
  assert.equal(KEYCHAIN_ACCOUNT, "vault-key");
  assert.equal(KEYCHAIN_LABEL, "reqora vault key");
  assert.equal(MACOS_SECURITY_SERVICE, "reqora.vault.key");
  assert.equal(MACOS_SECURITY_ACCOUNT, KEYCHAIN_SERVICE);

  const mac = keychainCommands("darwin");
  assert.deepEqual(mac.read.args, [
    "find-generic-password", "-s", "reqora.vault.key", "-a", "reqora", "-w",
  ]);
  assert.deepEqual(mac.write.args.slice(0, 6), [
    "add-generic-password", "-s", "reqora.vault.key", "-a", "reqora", "-w",
  ]);

  const lin = keychainCommands("linux");
  assert.deepEqual(lin.read.args, ["lookup", "service", "reqora", "account", "vault-key"]);
  assert.ok(lin.write.args.includes("--label=reqora vault key"));
  assert.equal(lin.write.stdin, true, "Linux 密钥从 stdin 写入，不进命令行参数");

  // 与 Rust 侧同名常量逐字一致（否则 CLI 解不开桌面端写入的数据）。
  const rust = readFileSync(new URL("../src-tauri/src/service/vault.rs", import.meta.url), "utf8");
  for (const [name, value] of [
    ["KEYCHAIN_SERVICE", KEYCHAIN_SERVICE],
    ["KEYCHAIN_ACCOUNT", KEYCHAIN_ACCOUNT],
    ["KEYCHAIN_LABEL", KEYCHAIN_LABEL],
    ["MACOS_SECURITY_SERVICE", MACOS_SECURITY_SERVICE],
    ["MACOS_SECURITY_ACCOUNT", MACOS_SECURITY_ACCOUNT],
  ]) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(rust, new RegExp(`${name}\\s*:\\s*&str\\s*=\\s*"${escaped}"`),
      `${name} 必须与 Rust 侧逐字一致`);
  }
});
