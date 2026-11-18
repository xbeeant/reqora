#!/usr/bin/env node
/**
 * 发布期共享配置：dotenv 加载、Ed25519 签名私钥解析、验签信任根同步。
 *
 * 之所以需要这个模块：Rust 进程只读进程环境变量，Vite 只读 `VITE_*` 前缀，
 * 而 Node 发布脚本默认完全不读 .env —— 结果是 `.env.production` 里明明配了
 * `REQORA_UPDATE_SIGNING_KEY`，`bun run release` 仍报「未找到 Ed25519 私钥」。
 *
 * 优先级（高 → 低）：进程已有环境变量 > --key > .env.production.local >
 * .env.production > .env.local > .env > ~/.reqora/update-signing.key。
 * 私钥只在本模块内流转，任何日志都不打印私钥或其路径以外的内容。
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import { publicKeyHex, seedToPrivateKey } from "./sign-update-manifest.mjs";

/** 顺序有意义：靠后的文件覆盖靠前的文件；进程环境始终最优先。 */
export const DEFAULT_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
];

export const DEFAULT_KEY_FILE = path.join(homedir(), ".reqora", "update-signing.key");

/**
 * 客户端内置验签公钥所在文件。信任根规则已从 service/update.rs 下沉到
 * 无依赖的 `crate::trust`（update.rs 仅 re-export）；此处必须指向定义常量
 * 的 trust.rs。若指向旧路径，正则会匹配到 re-export 行而非真正的常量，
 * 发布流程「同步成功」却没改到编译进客户端的值，导致更新包被拒收。
 * 该常量同时被发布脚本与契约测试引用，避免再次漂移。
 */
export const CLIENT_TRUST_ROOT_FILE = path.join(
  "src-tauri",
  "crates",
  "reqora-core",
  "src",
  "trust.rs",
);

/** 极简 dotenv 解析：KEY=value、export KEY=value、引号、行尾注释。 */
export function parseDotEnv(text) {
  const result = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replaceAll("\\n", "\n").replaceAll("\\r", "\r");
    } else {
      const comment = value.search(/\s+#/);
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    result[match[1]] = value;
  }
  return result;
}

/** 把 dotenv 文件合并进 process.env；已存在的进程变量不被覆盖。 */
export function loadReleaseEnv(root = process.cwd(), files = DEFAULT_ENV_FILES) {
  const merged = {};
  const loaded = [];
  for (const name of files) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    let parsed;
    try {
      parsed = parseDotEnv(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`读取 ${name} 失败：${error.message}`);
    }
    Object.assign(merged, parsed);
    loaded.push(name);
  }
  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return { loaded, keys: Object.keys(merged) };
}

/** 去掉末尾斜杠；空值返回 null。 */
export function normalizeUrlBase(raw) {
  const trimmed = String(raw ?? "").trim().replace(/\/+$/, "");
  return trimmed || null;
}

/** 发布地址：REQORA_RELEASE_URL_BASE（--url-base 由调用方优先处理）。 */
export function releaseUrlBase() {
  return normalizeUrlBase(process.env.REQORA_RELEASE_URL_BASE);
}

/** 从 32 字节 Ed25519 seed 推导 raw 公钥（64 位 hex）。 */
export function publicKeyFromSeedHex(seedHex) {
  return publicKeyHex(seedToPrivateKey(Buffer.from(seedHex, "hex")));
}

/**
 * 把 64 位 hex seed / PKCS#8 DER hex / base64 seed 统一成 64 位 hex。
 * 单独导出以便测试；错误信息里绝不回显原始内容。
 */
export function seedFromRaw(raw, source) {
  const value = String(raw ?? "").trim().replace(/^["']|["']$/g, "");
  if (/^[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();

  const isHex = /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0;
  if (isHex) {
    const bytes = Buffer.from(value, "hex");
    if (bytes.length >= 48) return bytes.subarray(bytes.length - 32).toString("hex");
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length === 32) return bytes.toString("hex");
    if (bytes.length >= 48) return bytes.subarray(bytes.length - 32).toString("hex");
  }
  throw new Error(`${source} 不是合法的 Ed25519 私钥（需要 32 字节 seed / 64 位 hex）`);
}

function readSeedFile(file, source) {
  try {
    return seedFromRaw(readFileSync(file, "utf8"), source);
  } catch (error) {
    throw new Error(`${source} 读取失败：${error.message}`);
  }
}

function looksLikePath(value) {
  return /[\\/]/.test(value) || value.endsWith(".key") || value.endsWith(".pem");
}

function generateKeyFile(keyFile) {
  const seedHex = randomBytes(32).toString("hex");
  mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  writeFileSync(keyFile, `${seedHex}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(keyFile, 0o600);
  } catch {
    // Windows 不支持 POSIX mode，忽略即可。
  }
  return seedHex;
}

/**
 * 解析签名私钥，并把 seed 注入 process.env 供所有子脚本继承。
 * 返回 { seedHex, publicHex, source, generated }；不回显 seed。
 */
export function resolveSigningKey({
  key,
  keyFile = DEFAULT_KEY_FILE,
  autoGenerate = true,
} = {}) {
  let seedHex = null;
  let source = "";
  let generated = false;

  // 1. 显式 --key：64 位 hex 或私钥文件路径。
  if (key) {
    const file = path.resolve(key);
    if (existsSync(file)) {
      seedHex = readSeedFile(file, "--key 指定的文件");
      source = "--key";
    } else {
      seedHex = seedFromRaw(key, "--key");
      source = "--key";
    }
  }

  // 2. 进程环境 / dotenv 注入的 REQORA_UPDATE_SIGNING_KEY。
  if (!seedHex && process.env.REQORA_UPDATE_SIGNING_KEY?.trim()) {
    const raw = process.env.REQORA_UPDATE_SIGNING_KEY.trim();
    if (looksLikePath(raw) && existsSync(path.resolve(raw))) {
      seedHex = readSeedFile(path.resolve(raw), "REQORA_UPDATE_SIGNING_KEY 指向的文件");
    } else {
      seedHex = seedFromRaw(raw, "REQORA_UPDATE_SIGNING_KEY");
    }
    source = "REQORA_UPDATE_SIGNING_KEY";
  }

  // 3. 发版机上的默认密钥文件。
  if (!seedHex && existsSync(keyFile)) {
    seedHex = readSeedFile(keyFile, "~/.reqora/update-signing.key");
    source = "~/.reqora/update-signing.key";
  }

  // 4. 首次发版：自动生成，避免再出现「跳过签名」的半残产物。
  if (!seedHex) {
    if (!autoGenerate) return null;
    seedHex = generateKeyFile(keyFile);
    source = "自动生成（~/.reqora/update-signing.key）";
    generated = true;
  }

  process.env.REQORA_UPDATE_SIGNING_KEY = seedHex;
  return { seedHex, publicHex: publicKeyFromSeedHex(seedHex), source, generated };
}

/**
 * 把签名私钥对应的公钥同步到三个验签信任根：
 *   1. scripts/sign-update-manifest.mjs 的 DEFAULT_PUBLIC_KEY_HEX（CLI 自检）
 *   2. reqora-core/src/trust.rs 的 DEFAULT_UPDATE_PUBLIC_KEY_HEX（客户端）
 *   3. .env.production 的 REQORA_UPDATE_PUBLIC_KEY（运行时可覆盖项）
 * 同时设置 process.env.REQORA_UPDATE_PUBLIC_KEY，保证本次发布子进程验签一致。
 * 只在内容变化时写盘；文件不存在或常量未匹配时记入 skipped，由调用方决定是否中止。
 */
export function syncUpdateTrustRoot({
  root = process.cwd(),
  publicHex,
  envFile = ".env.production",
} = {}) {
  if (!/^[0-9a-fA-F]{64}$/.test(publicHex ?? "")) {
    throw new Error("同步验签公钥失败：公钥必须是 64 位 hex");
  }
  const hex = publicHex.toLowerCase();
  process.env.REQORA_UPDATE_PUBLIC_KEY = hex;

  const replacements = [
    {
      label: "scripts/sign-update-manifest.mjs",
      file: path.join(root, "scripts", "sign-update-manifest.mjs"),
      pattern: /(export\s+const\s+DEFAULT_PUBLIC_KEY_HEX\s*=\s*")[^"\n]*(")/,
    },
    {
      label: CLIENT_TRUST_ROOT_FILE,
      file: path.join(root, CLIENT_TRUST_ROOT_FILE),
      pattern: /(pub\s+const\s+DEFAULT_UPDATE_PUBLIC_KEY_HEX\s*:\s*&str\s*=\s*")[^"\n]*(")/,
    },
  ];

  const changed = [];
  const skipped = [];
  // critical = 真正编译进客户端 / 供 CLI 自检的信任根失配；这类跳过会让签名
  // 与验签用不同的钥匙，必须中止发布。skipped 则包含可选文件（如 gitignore
  // 的 .env.production），缺失只需提示，不应阻断发版。
  const critical = [];
  for (const { label, file, pattern } of replacements) {
    if (!existsSync(file)) {
      skipped.push(label);
      critical.push(`${label}（文件不存在）`);
      continue;
    }
    const before = readFileSync(file, "utf8");
    if (!pattern.test(before)) {
      skipped.push(`${label}（未找到公钥常量）`);
      critical.push(`${label}（未找到公钥常量）`);
      continue;
    }
    const after = before.replace(pattern, `$1${hex}$2`);
    if (after !== before) {
      writeFileSync(file, after, "utf8");
      changed.push(label);
    }
  }

  const envPath = path.join(root, envFile);
  if (existsSync(envPath)) {
    const before = readFileSync(envPath, "utf8");
    const linePattern = /^(\s*REQORA_UPDATE_PUBLIC_KEY\s*=\s*).*$/m;
    const after = linePattern.test(before)
      ? before.replace(linePattern, `$1${hex}`)
      : `${before.replace(/\s*$/, "")}\nREQORA_UPDATE_PUBLIC_KEY=${hex}\n`;
    if (after !== before) {
      writeFileSync(envPath, after, "utf8");
      changed.push(envFile);
    }
  } else {
    skipped.push(envFile);
  }

  return { changed, skipped, critical };
}
