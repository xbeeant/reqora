// Client for the `reqora-send` sidecar (built from src-tauri/crates/reqora-core).
//
// Why a sidecar: the desktop shell links the Rust request engine directly, but
// the Node CLI / MCP server cannot link an rlib. A single long-lived process
// speaking NDJSON over stdio is the smallest bridge that still gives both
// shells the SAME HttpService: same variable resolver, auth, cookie jar, proxy,
// TLS verification, redirect policy, timings and raw wire reconstruction.
//
// The engine is optional at runtime. A plain `npm install` (or the single-file
// MCP bundle) has no binary, so callers fall back to Node fetch and keep
// working; `REQORA_SEND_BIN` / `REQORA_ENGINE` make the choice explicit.
//
// stdout of this module is never used for logging: the MCP server owns stdout
// for its own JSON-RPC stream.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const EXE = process.platform === "win32" ? "reqora-send.exe" : "reqora-send";
const IDLE_MS = 2000;

/** "auto" | "rust" | "node" (env: REQORA_ENGINE). */
export function enginePreference() {
  const raw = String(process.env.REQORA_ENGINE ?? "auto").trim().toLowerCase();
  return raw === "rust" || raw === "node" ? raw : "auto";
}

/**
 * Look next to this file (bin/ or a dist-mcp/ single-file bundle), then in the
 * local cargo target dirs. Release is preferred over debug when both exist.
 */
export function discoverEngineBin() {
  const explicit = process.env.REQORA_SEND_BIN;
  if (explicit) return resolve(explicit);
  const roots = [here, join(here, "..")];
  const candidates = [];
  for (const root of roots) {
    candidates.push(join(root, EXE));
    candidates.push(join(root, "bin", EXE));
    candidates.push(join(root, "dist-engine", EXE));
    candidates.push(join(root, "dist-engine", `${process.platform}-${process.arch}`, EXE));
    candidates.push(join(root, "src-tauri", "target", "release", EXE));
    candidates.push(join(root, "src-tauri", "target", "debug", EXE));
  }
  candidates.push(resolve(process.cwd(), EXE));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export class EngineClient {
  constructor(bin = discoverEngineBin()) {
    this.bin = bin;
    this.child = null;
    this.reader = null;
    this.pending = new Map();
    this.nextId = 1;
    this.hello = null;
    this.disabled = false;
    this.stderrTail = "";
    this.idleTimer = null;
    this._exitGuard = () => this.close();
    process.once("exit", this._exitGuard);
  }

  get available() {
    return Boolean(this.bin) && !this.disabled;
  }

  /** Handshake once: never trust an arbitrary executable on the search path. */
  async _handshake() {
    if (this.hello) return this.hello;
    this.hello = (async () => {
      const reply = await this._request({ id: "hello", method: "hello" }, 10_000);
      if (!reply.ok || reply.engine !== "reqora-core" || reply.protocol !== 1) {
        throw new Error(`引擎握手失败：${JSON.stringify(reply)}`);
      }
      return reply;
    })().catch((error) => {
      this.disabled = true;
      this.hello = null;
      throw error;
    });
    return this.hello;
  }

  _start() {
    if (this.child) return;
    const child = spawn(this.bin, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on("line", (line) => this._onLine(line));
    child.stderr?.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-8192);
    });
    const fail = (error) => {
      this._failAll(error);
      this.child = null;
      this.reader = null;
      this.hello = null;
      this.disabled = true;
    };
    child.on("error", fail);
    child.on("exit", (code, signal) => {
      fail(new Error(`引擎进程退出（code=${code} signal=${signal ?? "-"}）${this.stderrTail}`));
    });
  }

  _onLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // never let stray output corrupt the request correlation
    }
    const key = String(message?.id ?? "");
    const entry = this.pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(key);
    entry.resolve(message);
  }

  _failAll(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  _touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // Unref'd: the sidecar must not keep a finished CLI process alive. If no
    // further request arrives, close the pipes so Node can exit normally.
    this.idleTimer = setTimeout(() => this.close(), IDLE_MS);
    this.idleTimer.unref?.();
  }

  _request(envelope, timeoutMs) {
    if (!this.bin) return Promise.reject(new Error("未找到 reqora-send 二进制"));
    this._start();
    this._touch();
    const key = String(envelope.id);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`引擎响应超时（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(key, { resolve: resolvePromise, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify(envelope)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(error);
      }
    });
  }

  /**
   * @param {object} spec the shared `toWireSpec()` RequestSpec
   * @returns {Promise<object>} reqora-core ResponsePayload (camelCase)
   */
  async send(spec, { timeoutMs = 60_000, requestId, maxBodyBytes } = {}) {
    await this._handshake();
    const envelope = { id: `r${this.nextId++}`, method: "send", spec };
    if (requestId) envelope.requestId = requestId;
    if (maxBodyBytes) envelope.maxBodyBytes = maxBodyBytes;
    const reply = await this._request(envelope, Math.max(timeoutMs, 1000) + 5000);
    if (!reply.ok) {
      const error = new Error(reply.error?.message ?? "引擎发送失败");
      error.code = reply.error?.code ?? "ENGINE_ERROR";
      error.payload = reply.error;
      throw error;
    }
    return reply.response;
  }

  close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.reader?.close();
    this.reader = null;
    if (this.child) {
      const child = this.child;
      this.child = null;
      try {
        child.stdin?.end();
        child.kill();
      } catch {
        // already gone
      }
    }
    this._failAll(new Error("引擎已关闭"));
    this.hello = null;
  }
}

let shared = null;

/** One sidecar per Node process: the cookie jar has to survive across sends. */
export function getEngine({ force = false } = {}) {
  if (shared && !shared.available && !force) return null;
  if (!shared || force) {
    const preference = enginePreference();
    const bin = preference === "node" ? null : discoverEngineBin();
    shared = new EngineClient(bin);
  }
  return shared.available ? shared : null;
}

/** Manual cleanup for embedding hosts; `process.once("exit")` covers the rest. */
export function closeEngine() {
  shared?.close();
  shared = null;
}
