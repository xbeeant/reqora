#!/usr/bin/env node
/**
 * IPC 注册护栏。
 *
 * 真实事故：`src/lib/api.ts` 调用的 `load_app_config` / `save_app_config` /
 * `set_workspace_limit` 从来没出现在 `generate_handler!` 里（app_config.rs
 * 甚至没被 `mod` 声明，因此整个模块没参与编译）。运行时只得到
 * "Command X not found"，而调用点用 `.catch(() => {})` 静默吞掉，表现为
 * 配置不落盘、设置页调高快照上限无效、自动保存一直报「无权限」。
 *
 * 这里不用启动 Tauri：静态比对前端命令名、Rust `#[tauri::command]` 定义、
 * 以及 `generate_handler!` 的注册清单，三者在 CI 里必须闭合。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(root, relative), "utf8");

/** `call<T>("name", ...)` 与直接 `invoke("name", ...)` 两种调用形态。 */
function frontendCommands(source) {
  const names = new Set();
  for (const match of source.matchAll(/\bcall<[^>]*>\(\s*"([a-z0-9_]+)"/g)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/\binvoke<[^>]*>\(\s*"([a-z0-9_]+)"/g)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/\binvoke\(\s*"([a-z0-9_]+)"/g)) {
    names.add(match[1]);
  }
  return names;
}

/** `generate_handler![ ... ]` 内所有 `module::command` / `command` 项。 */
function registeredCommands(source) {
  const start = source.indexOf("generate_handler![");
  assert.ok(start >= 0, "找不到 generate_handler! 注册清单");
  const end = source.indexOf("])", start);
  assert.ok(end > start, "generate_handler! 清单没有闭合");
  const block = source.slice(start, end);
  const names = new Set();
  for (const match of block.matchAll(/(?:[a-z0-9_]+::)?([a-z0-9_]+)\s*,/g)) {
    names.add(match[1]);
  }
  return names;
}

/** 递归收集 src-tauri/src 下所有 `#[tauri::command]` 标注的函数名。 */
function definedCommands() {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (entry.endsWith(".rs")) {
        const source = readFileSync(path, "utf8");
        for (const match of source.matchAll(
          /#\[tauri::command\][\s\S]{0,160}?\bfn\s+([a-z0-9_]+)/g,
        )) {
          names.add(match[1]);
        }
      }
    }
  };
  walk(join(root, "src-tauri", "src"));
  return names;
}

test("前端调用的每个 IPC 命令都在 generate_handler 中注册", () => {
  const used = frontendCommands(read("src/lib/api.ts"));
  const registered = registeredCommands(read("src-tauri/src/lib.rs"));
  const missing = [...used].filter((name) => !registered.has(name)).sort();
  assert.deepEqual(missing, [], `未注册的命令：${missing.join(", ")}`);
  assert.ok(used.size > 50, "命令抽取可能失效（数量异常偏少）");
});

test("每个定义的 tauri command 都被注册，不留死命令", () => {
  const defined = definedCommands();
  const registered = registeredCommands(read("src-tauri/src/lib.rs"));
  const unregistered = [...defined].filter((name) => !registered.has(name)).sort();
  assert.deepEqual(unregistered, [], `定义但未注册：${unregistered.join(", ")}`);
  assert.ok(defined.size > 50, "Rust 命令抽取可能失效（数量异常偏少）");
});

test("设置页的快照上限命令确实存在且可调", () => {
  const api = read("src/lib/api.ts");
  const storage = read("src-tauri/src/storage.rs");
  assert.match(api, /setWorkspaceLimit:\s*\(limit: number\)/);
  assert.match(storage, /pub fn set_max_bytes\(&self, limit: u64\)/);
  assert.match(storage, /max_bytes: AtomicUsize::new/);
});
