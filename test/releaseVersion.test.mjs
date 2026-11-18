/**
 * release 版本号解析 / 递增 / 写回（node:test）。
 *
 * 写回测试在临时目录里镜像真实的版本文件后再操作，绝不改动仓库本体。
 * 复跑：node --test test/releaseVersion.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  VERSION_FILES,
  applyVersion,
  bumpPatch,
  parseVersion,
  readCurrentVersion,
  resolveReleaseVersion,
} from "../scripts/release-version.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- 解析与递增 ------------------------------------------------------------

test("parseVersion 规范化版本号并去掉前导零", () => {
  assert.equal(parseVersion("0.0.1"), "0.0.1");
  assert.equal(parseVersion("1.2.3"), "1.2.3");
  assert.equal(parseVersion("01.002.0003"), "1.2.3");
  assert.equal(parseVersion(" 2.0.0 "), "2.0.0");
});

test("parseVersion 拒绝非法版本", () => {
  for (const bad of ["", "v1.2.3", "1.2", "1.2.3.4", "1.2.x", "1.2.-3", "1.2.3-beta", "abc", 123, null]) {
    assert.throws(() => parseVersion(bad), /非法|必须是字符串/, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test("bumpPatch 只递增 patch 位", () => {
  assert.equal(bumpPatch("0.0.1"), "0.0.2");
  assert.equal(bumpPatch("1.2.9"), "1.2.10");
  assert.equal(bumpPatch("2.0.0"), "2.0.1");
});

test("resolveReleaseVersion：默认自增，显式指定原样采用", () => {
  assert.deepEqual(resolveReleaseVersion("0.0.1", undefined), { version: "0.0.2", source: "bump" });
  assert.deepEqual(resolveReleaseVersion("0.0.1", ""), { version: "0.0.2", source: "bump" });
  assert.deepEqual(resolveReleaseVersion("0.0.1", "   "), { version: "0.0.2", source: "bump" });
  assert.deepEqual(resolveReleaseVersion("0.0.1", "3.4.5"), { version: "3.4.5", source: "explicit" });
  assert.deepEqual(resolveReleaseVersion("1.2.3", "1.2.3"), { version: "1.2.3", source: "explicit" });
});

test("resolveReleaseVersion 拒绝非法当前版本 / 非法指定版本", () => {
  assert.throws(() => resolveReleaseVersion("bad", undefined), /当前版本号/);
  assert.throws(() => resolveReleaseVersion("0.0.1", "v2.0.0"), /指定的版本号/);
});

test("readCurrentVersion 读取真实仓库的当前版本", () => {
  assert.match(readCurrentVersion(ROOT), /^\d+\.\d+\.\d+$/);
});

// ---- 写回（临时目录镜像）---------------------------------------------------

function mirrorVersionFiles(tmp) {
  for (const rel of VERSION_FILES) {
    const dest = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dest);
  }
}

function readAt(tmp, rel) {
  return fs.readFileSync(path.join(tmp, rel), "utf8");
}

test("applyVersion 把新版本写回全部权威来源", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reqora-relver-"));
  try {
    mirrorVersionFiles(tmp);
    const before = readCurrentVersion(tmp);
    const target = bumpPatch(before);

    const result = applyVersion(tmp, target, before);
    assert.equal(result.from, before);
    assert.equal(result.to, target);
    assert.deepEqual(result.files, VERSION_FILES);

    assert.equal(readCurrentVersion(tmp), target, "package.json 版本应已更新");
    assert.match(readAt(tmp, "src-tauri/tauri.conf.json"), new RegExp(`"version": "${target}"`));
    assert.match(readAt(tmp, "src-tauri/Cargo.toml"), new RegExp(`^version = "${target}"`, "m"));
    assert.match(
      readAt(tmp, "src-tauri/crates/reqora-core/Cargo.toml"),
      new RegExp(`^version = "${target}"`, "m"),
    );
    assert.match(
      readAt(tmp, "src-tauri/crates/reqora-send/Cargo.toml"),
      new RegExp(`^version = "${target}"`, "m"),
    );
    assert.match(readAt(tmp, "server/build.gradle.kts"), new RegExp(`^version = "${target}"`, "m"));
    assert.match(readAt(tmp, "bin/mcpServer.mjs"), new RegExp(`version: "${target}"`));

    // Cargo.lock 只改 workspace 三个包，第三方依赖版本不动。
    const lock = readAt(tmp, "src-tauri/Cargo.lock");
    for (const name of ["reqora", "reqora-core", "reqora-send"]) {
      assert.match(lock, new RegExp(`name = "${name}"\\nversion = "${target}"`));
    }
    assert.doesNotMatch(lock, new RegExp(`name = "reqora-core"\\nversion = "${before}"`));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("applyVersion 对相同版本不写任何文件", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reqora-relver-noop-"));
  try {
    mirrorVersionFiles(tmp);
    const current = readCurrentVersion(tmp);
    const result = applyVersion(tmp, current, current);
    assert.deepEqual(result.files, []);
    assert.equal(readCurrentVersion(tmp), current);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("applyVersion 遇到版本漂移（旧值不匹配）时中止，不改任何文件", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reqora-relver-drift-"));
  try {
    mirrorVersionFiles(tmp);
    const current = readCurrentVersion(tmp);
    // 人为把 tauri.conf.json 改成别的版本，制造「部分改动」的仓库。
    const tauriPath = path.join(tmp, "src-tauri/tauri.conf.json");
    fs.writeFileSync(tauriPath, readAt(tmp, "src-tauri/tauri.conf.json").replace(`"version": "${current}"`, `"version": "9.9.9"`));
    const snapshots = new Map(VERSION_FILES.map((rel) => [rel, readAt(tmp, rel)]));

    assert.throws(() => applyVersion(tmp, bumpPatch(current), current), /版本|漂移|部分修改/);
    for (const [rel, content] of snapshots) {
      assert.equal(readAt(tmp, rel), content, `${rel} 不应被改动`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("applyVersion 拒绝非法目标版本", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reqora-relver-bad-"));
  try {
    mirrorVersionFiles(tmp);
    const current = readCurrentVersion(tmp);
    assert.throws(() => applyVersion(tmp, "v2.0.0", current), /目标版本号/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
