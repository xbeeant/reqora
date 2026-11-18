// 静态加密（SQLite 侧）策略与 Rust service/vault.rs 的契约测试。
// 用固定的环境变量密钥，测试不会触碰机器上真正的 ~/.reqora/vault.key。
import test from "node:test";
import assert from "node:assert/strict";

const TEST_KEY = "2a".repeat(32); // = [42; 32]，与 Rust Vault::for_tests 一致
process.env.REQORA_VAULT_KEY = TEST_KEY;

const vault = await import("../bin/vault.mjs?test=at-rest");

const NODE_VECTOR =
  "reqora.enc.v1.544e62ce.AQIDBAUGBwgJCgsMlxF2Jfu7B6tuYl7NijKNiJPCP52aYX3CxUZVCDuI";

function snapshot() {
  return {
    version: 1,
    collections: [
      {
        id: "c1",
        name: "用户服务",
        auth: { type: "apiKey", key: "X-Key", value: "plain-api-key" },
        items: [
          {
            id: "r1",
            url: "https://example.com/api",
            headers: [
              { id: "h1", key: "Content-Type", value: "application/json", enabled: true },
              { id: "h2", key: "Authorization", value: "Bearer abc.def", enabled: true },
            ],
            auth: { type: "bearer", token: "bearer-secret" },
          },
        ],
      },
    ],
    environments: [
      {
        id: "e1",
        variables: [
          { id: "v1", key: "baseUrl", value: "https://example.com", enabled: true },
          { id: "v2", key: "password", value: "s3cr3t", enabled: true, secret: true },
          { id: "v3", key: "alias", value: "local-only", enabled: true, secret: true },
        ],
      },
    ],
    settings: { timeoutSecs: 30, aiApiKey: "sk-test" },
    history: [],
  };
}

test("敏感字段在落盘态全部变成信封，普通字段保持明文", () => {
  const sealed = vault.sealAtRest(snapshot());
  const text = JSON.stringify(sealed);
  for (const secret of [
    "plain-api-key",
    "Bearer abc.def",
    "bearer-secret",
    "s3cr3t",
    "local-only",
    "sk-test",
  ]) {
    assert.ok(!text.includes(secret), `密文中不得出现明文 ${secret}`);
  }
  assert.ok(text.includes(vault.ENVELOPE_PREFIX ?? "reqora.enc.v1."));
  assert.ok(text.includes("https://example.com/api"), "URL 等非敏感字段仍可查询");
  assert.ok(text.includes("application/json"));
  assert.deepEqual(vault.openAtRest(sealed), snapshot(), "往返必须逐字段一致");
});

test("加密幂等，旧明文数据可直接读取（无需迁移脚本）", () => {
  const legacy = { auth: { type: "bearer", token: "still-plain" }, name: "ok" };
  assert.deepEqual(vault.openAtRest(legacy), legacy);
  const once = vault.sealAtRest(legacy);
  const twice = vault.sealAtRest(once);
  assert.deepEqual(once, twice, "信封不应被二次加密");
  assert.deepEqual(vault.openAtRest(twice), legacy);
});

test("与 Rust 侧共享的 AES-GCM 向量可以互相解密", () => {
  assert.equal(vault.decryptText(NODE_VECTOR), "cross-language");
  assert.equal(vault.vaultKeyId(), "544e62ce");
});

test("篡改或错误密钥一律失败关闭，不返回密文", () => {
  const sealed = vault.sealAtRest({ password: "hunter2" });
  const broken = sealed.password.slice(0, -1) + (sealed.password.endsWith("A") ? "B" : "A");
  assert.throws(() => vault.decryptText(broken), /解密失败|base64|格式/);

  // keyId 不匹配必须在解密前就被拒绝，避免拿错密钥去解出乱码。
  const wrong = sealed.password.replace(vault.vaultKeyId(), "deadbeef");
  assert.throws(() => vault.decryptText(wrong), /主密钥不匹配/);
});

test("敏感键识别与 Rust 策略一致", () => {
  for (const key of ["Authorization", "X-API-Key", "client_secret", "accessToken", "DB_PASSWORD"]) {
    assert.ok(vault.isSensitiveKey(key), key);
  }
  for (const key of ["Content-Type", "baseUrl", "id"]) {
    assert.ok(!vault.isSensitiveKey(key), key);
  }
});

test("明文 token 出现在 auth / headers / 私密变量时全部被封", () => {
  const sealed = vault.sealAtRest(snapshot());
  assert.ok(vault.isEnvelope(sealed.collections[0].auth.value));
  assert.ok(vault.isEnvelope(sealed.collections[0].items[0].auth.token));
  assert.ok(vault.isEnvelope(sealed.collections[0].items[0].headers[1].value));
  assert.ok(vault.isEnvelope(sealed.environments[0].variables[1].value));
  assert.ok(vault.isEnvelope(sealed.environments[0].variables[2].value));
  assert.equal(sealed.collections[0].items[0].headers[0].value, "application/json");
});
