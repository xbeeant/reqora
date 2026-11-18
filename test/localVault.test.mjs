// WebView localStorage 凭据加密（src/lib/localVault.ts）的契约测试。
import test from "node:test";
import assert from "node:assert/strict";
import {
  isSealed,
  localVaultKey,
  openLocalSecret,
  sealLocalSecret,
} from "../src/lib/localVault.ts";

test("密文里不含明文，且能完整还原 token", async () => {
  const session = JSON.stringify({ access: "access-token-abc", refresh: "refresh-token-xyz" });
  const sealed = await sealLocalSecret(session);
  assert.ok(sealed, "Node 22 的 WebCrypto 应当可用");
  assert.match(sealed, /^reqora\.local\.enc\.v1\./);
  assert.ok(isSealed(sealed));
  assert.ok(!sealed.includes("access-token-abc"));
  assert.ok(!sealed.includes("refresh-token-xyz"));
  assert.equal(await openLocalSecret(sealed), session);
});

test("每次加密都用新随机数，同样的明文得到不同密文", async () => {
  const a = await sealLocalSecret("same-value");
  const b = await sealLocalSecret("same-value");
  assert.notEqual(a, b);
  assert.equal(await openLocalSecret(a), "same-value");
  assert.equal(await openLocalSecret(b), "same-value");
});

test("篡改 / 截断 / 非信封输入一律返回 null，不抛异常", async () => {
  const sealed = await sealLocalSecret("secret");
  const tampered = sealed.slice(0, -3) + (sealed.endsWith("AAA") ? "BBB" : "AAA");
  assert.equal(await openLocalSecret(tampered), null);
  assert.equal(await openLocalSecret(sealed.slice(0, 40)), null);
  assert.equal(await openLocalSecret("not-an-envelope"), null);
  assert.equal(await openLocalSecret(""), null);
});

test("密钥不可导出，原始字节不会出现在 JS 里", async () => {
  const key = await localVaultKey();
  assert.ok(key, "应当拿到一把 AES-GCM 密钥");
  assert.equal(key.extractable, false);
  assert.equal(key.algorithm.name, "AES-GCM");
});

test("空字符串也可以加密（占位 token 不会退化成明文）", async () => {
  const sealed = await sealLocalSecret("");
  assert.ok(sealed && isSealed(sealed));
  assert.equal(await openLocalSecret(sealed), "");
});
