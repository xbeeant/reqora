#!/usr/bin/env node
/**
 * 单独同步验签信任根（不打包、不构建）：
 *
 *   node scripts/sync-update-trust.mjs
 *   node scripts/sync-update-trust.mjs --public-key <64hex>
 *
 * 默认从 REQORA_UPDATE_SIGNING_KEY / ~/.reqora/update-signing.key 推导公钥；
 * 也可用 --public-key 直接指定（用于只更新客户端内置公钥、私钥另机保管的场景）。
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  loadReleaseEnv,
  publicKeyFromSeedHex,
  resolveSigningKey,
  syncUpdateTrustRoot,
} from "./release-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes("--help")) {
  console.log(`用法：node scripts/sync-update-trust.mjs [--public-key <64hex>]
  --public-key  直接指定验签公钥，跳过私钥推导
  --help        显示本帮助`);
  process.exit(0);
}

loadReleaseEnv(root);
const explicit = flag("--public-key");
let publicHex;
if (explicit) {
  if (!/^[0-9a-fA-F]{64}$/.test(explicit)) {
    console.error("[sync-key] --public-key 必须是 64 位 hex（32 字节 raw Ed25519 公钥）");
    process.exit(1);
  }
  publicHex = explicit.toLowerCase();
} else {
  const signing = resolveSigningKey({ autoGenerate: false });
  if (!signing) {
    console.error("[sync-key] 找不到签名私钥，无法推导公钥；请配置 REQORA_UPDATE_SIGNING_KEY 或使用 --public-key");
    process.exit(1);
  }
  publicHex = publicKeyFromSeedHex(signing.seedHex);
}

const { changed, skipped, critical } = syncUpdateTrustRoot({ root, publicHex });
console.log(`[sync-key] 验签公钥：${publicHex}`);
console.log(`[sync-key] 已更新：${changed.join("、") || "（无，信任根已一致）"}`);
if (skipped.length) console.log(`[sync-key] 已跳过：${skipped.join("、")}`);
if (critical.length) {
  console.error(`[sync-key] ✗ 客户端 / CLI 内置信任根同步失败：${critical.join("、")}`);
  process.exit(1);
}
