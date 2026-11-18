// 发布期环境加载 / 签名私钥解析 / 信任根同步的契约测试。
// 所有密钥都在临时目录里现生成，测试文件内不含任何真实密钥材料。
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { publicKeyHex, seedToPrivateKey } from "../scripts/sign-update-manifest.mjs";
import {
  CLIENT_TRUST_ROOT_FILE,
  loadReleaseEnv,
  normalizeUrlBase,
  parseDotEnv,
  publicKeyFromSeedHex,
  releaseUrlBase,
  resolveSigningKey,
  seedFromRaw,
  syncUpdateTrustRoot,
} from "../scripts/release-env.mjs";
import { rmTemp } from "../scripts/rm-temp.mjs";

function withTmpDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "reqora-release-env-"));
  try {
    return fn(dir);
  } finally {
    rmTemp(dir);
  }
}

function withEnv(patch, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function keypair() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const seedHex = der.subarray(der.length - 32).toString("hex");
  return {
    derHex: der.toString("hex"),
    seedHex,
    publicHex: publicKeyHex(seedToPrivateKey(der.subarray(der.length - 32))),
  };
}

test("parseDotEnv：注释 / export / 引号 / 行尾注释 / 空值", () => {
  const parsed = parseDotEnv(
    [
      "# comment",
      "export REQORA_A=one",
      'REQORA_B="two # not a comment"',
      "REQORA_C='three'",
      "REQORA_D=four # trailing comment",
      "REQORA_EMPTY=",
      "NOT_A_PAIR",
    ].join("\n"),
  );
  assert.deepEqual(parsed, {
    REQORA_A: "one",
    REQORA_B: "two # not a comment",
    REQORA_C: "three",
    REQORA_D: "four",
    REQORA_EMPTY: "",
  });
});

test("parseDotEnv：与 Rust 共享契约向量逐例一致", () => {
  const fixturePath = path.resolve(
    import.meta.dirname,
    "..",
    "test",
    "fixtures",
    "dotenv-contract.json",
  );
  const doc = JSON.parse(readFileSync(fixturePath, "utf8"));
  for (const contractCase of doc.cases) {
    const parsed = parseDotEnv(contractCase.input);
    // Rust 的 parse_dot_env 只保留 REQORA_* 键；JS 解析器是通用的，
    // 这里施加同样的过滤后再按有序键值对比较。
    const actual = Object.entries(parsed)
      .filter(([key]) => /^REQORA_[A-Za-z0-9_]*$/.test(key))
      .map(([key, value]) => [key, value]);
    assert.deepEqual(
      actual,
      contractCase.expected,
      `用例失败：${contractCase.name}`,
    );
  }
});

test("loadReleaseEnv：.env.production 覆盖 .env，进程环境优先级最高", () => {
  withTmpDir((dir) => {
    writeFileSync(
      path.join(dir, ".env"),
      "REQORA_RELEASE_URL_BASE=https://from-dotenv\nREQORA_COLLAB_SERVER_URL=https://collab-a\n",
    );
    writeFileSync(
      path.join(dir, ".env.production"),
      "REQORA_RELEASE_URL_BASE=https://from-production/\n",
    );
    withEnv(
      { REQORA_RELEASE_URL_BASE: undefined, REQORA_COLLAB_SERVER_URL: undefined },
      () => {
        const info = loadReleaseEnv(dir);
        assert.deepEqual(info.loaded, [".env", ".env.production"]);
        assert.equal(releaseUrlBase(), "https://from-production");
        assert.equal(process.env.REQORA_COLLAB_SERVER_URL, "https://collab-a");
      },
    );
    withEnv({ REQORA_RELEASE_URL_BASE: "https://from-process" }, () => {
      loadReleaseEnv(dir);
      assert.equal(releaseUrlBase(), "https://from-process");
    });
  });
});

test("normalizeUrlBase：去空白与尾部斜杠，空值返回 null", () => {
  assert.equal(normalizeUrlBase("  https://downloads.example.com/reqora///  "), "https://downloads.example.com/reqora");
  assert.equal(normalizeUrlBase(""), null);
  assert.equal(normalizeUrlBase(undefined), null);
});

test("seedFromRaw：64hex / PKCS#8 DER hex / base64，非法值报错", () => {
  const { seedHex, derHex } = keypair();
  assert.equal(seedFromRaw(seedHex, "hex"), seedHex);
  assert.equal(seedFromRaw(derHex, "der"), seedHex);
  assert.equal(seedFromRaw(Buffer.from(seedHex, "hex").toString("base64"), "b64"), seedHex);
  assert.throws(() => seedFromRaw("not-a-key", "bad"), /Ed25519 私钥/);
});

test("publicKeyFromSeedHex 与签名器推导结果一致", () => {
  const { seedHex, publicHex } = keypair();
  assert.equal(publicKeyFromSeedHex(seedHex), publicHex);
});

test("resolveSigningKey：env > 密钥文件 > 自动生成，私钥注入子进程环境", () => {
  const { seedHex, publicHex } = keypair();
  withEnv({ REQORA_UPDATE_SIGNING_KEY: undefined }, () => {
    withTmpDir((dir) => {
      const keyFile = path.join(dir, "nested", "update-signing.key");
      assert.equal(resolveSigningKey({ keyFile, autoGenerate: false }), null);

      const generated = resolveSigningKey({ keyFile, autoGenerate: true });
      assert.equal(generated.generated, true);
      assert.match(generated.seedHex, /^[0-9a-f]{64}$/);
      assert.match(generated.publicHex, /^[0-9a-f]{64}$/);
      assert.equal(seedFromRaw(readFileSync(keyFile, "utf8"), "generated"), generated.seedHex);
      assert.equal(process.env.REQORA_UPDATE_SIGNING_KEY, generated.seedHex);

      withEnv({ REQORA_UPDATE_SIGNING_KEY: seedHex }, () => {
        const fromEnv = resolveSigningKey({ keyFile });
        assert.equal(fromEnv.source, "REQORA_UPDATE_SIGNING_KEY");
        assert.equal(fromEnv.seedHex, seedHex);
        assert.equal(fromEnv.publicHex, publicHex);
      });

      const fromFile = resolveSigningKey({ key: keyFile });
      assert.equal(fromFile.source, "--key");
    });
  });
});

test("客户端信任根同步目标指向真实存在的 Rust 文件", () => {
  const file = path.resolve(import.meta.dirname, "..", CLIENT_TRUST_ROOT_FILE);
  assert.ok(existsSync(file), `${CLIENT_TRUST_ROOT_FILE} 必须存在，否则发布会静默跳过客户端公钥`);
  assert.match(readFileSync(file, "utf8"), /DEFAULT_UPDATE_PUBLIC_KEY_HEX\s*:\s*&str\s*=/);
});

test("syncUpdateTrustRoot：同步 Node / Rust 常量与 .env.production，且幂等", () => {
  const { seedHex, publicHex } = keypair();
  assert.equal(publicKeyFromSeedHex(seedHex), publicHex);
  withEnv({ REQORA_UPDATE_PUBLIC_KEY: undefined }, () => {
    withTmpDir((dir) => {
      const nodeFile = path.join(dir, "scripts", "sign-update-manifest.mjs");
      const rustFile = path.join(dir, CLIENT_TRUST_ROOT_FILE);
      const envFile = path.join(dir, ".env.production");
      mkdirSync(path.dirname(nodeFile), { recursive: true });
      mkdirSync(path.dirname(rustFile), { recursive: true });
      writeFileSync(nodeFile, 'export const DEFAULT_PUBLIC_KEY_HEX =\n  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";\n');
      writeFileSync(rustFile, 'pub const DEFAULT_UPDATE_PUBLIC_KEY_HEX: &str =\n    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";\n');
      writeFileSync(envFile, "REQORA_UPDATE_PUBLIC_KEY=cccc\nREQORA_UPDATE_SIGNING_KEY=0000\n");

      const first = syncUpdateTrustRoot({ root: dir, publicHex });
      assert.deepEqual(first.critical, [], "三个信任根都存在时不得报致命失配");
      assert.equal(first.changed.length, 3);
      assert.ok(readFileSync(nodeFile, "utf8").includes(publicHex));
      assert.ok(readFileSync(rustFile, "utf8").includes(publicHex));
      assert.match(readFileSync(envFile, "utf8"), new RegExp(`^REQORA_UPDATE_PUBLIC_KEY=${publicHex}$`, "m"));
      assert.equal(process.env.REQORA_UPDATE_PUBLIC_KEY, publicHex);

      assert.deepEqual(syncUpdateTrustRoot({ root: dir, publicHex }).changed, []);
    });
  });
});

test("缺少可选的 .env.production 不阻断发版，但内置信任根缺失必须报出", () => {
  const { publicHex } = keypair();
  const dummyHex = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  withEnv({ REQORA_UPDATE_PUBLIC_KEY: undefined }, () => {
    withTmpDir((dir) => {
      const nodeFile = path.join(dir, "scripts", "sign-update-manifest.mjs");
      const rustFile = path.join(dir, CLIENT_TRUST_ROOT_FILE);
      mkdirSync(path.dirname(nodeFile), { recursive: true });
      mkdirSync(path.dirname(rustFile), { recursive: true });
      writeFileSync(nodeFile, `export const DEFAULT_PUBLIC_KEY_HEX = "${dummyHex}";\n`);
      writeFileSync(rustFile, `pub const DEFAULT_UPDATE_PUBLIC_KEY_HEX: &str = "${dummyHex}";\n`);

      const withoutEnv = syncUpdateTrustRoot({ root: dir, publicHex });
      assert.deepEqual(withoutEnv.critical, [], ".env.production 是 gitignore 的可选文件");
      assert.ok(withoutEnv.skipped.includes(".env.production"));
      assert.equal(withoutEnv.changed.length, 2);

      // 客户端内置公钥常量一旦不见了，发布必须能感知，而不是「同步成功」。
      rmSync(rustFile);
      const missingRoot = syncUpdateTrustRoot({ root: dir, publicHex });
      assert.ok(missingRoot.critical.some((item) => item.includes(CLIENT_TRUST_ROOT_FILE)));
    });
  });
});
