// Persistent, user-readable log for the MCP service.
//
// The protocol owns stdout, and most AI clients hide stderr. That made a
// failed write ("写数据失败 / 无权限") undebuggable: there was no file to
// open. Every startup, write failure and JSON-RPC handler failure is appended
// here as one JSON object per line, in the SAME directory as the desktop
// app's errors.log (src-tauri/src/error_log.rs), so one folder answers both
// sides of a failed write.
//
// Logging is strictly best effort: a broken/unwritable log must never turn a
// successful tool call into a failure.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_FILE_NAME = "reqora-mcp.log";
const MAX_BYTES = 2 * 1024 * 1024;

/** Same folder on every platform, mirroring the Tauri app's error_log.rs. */
export function mcpLogDir() {
  return join(homedir(), ".reqora", "logs");
}

export function mcpLogPath() {
  return join(mcpLogDir(), LOG_FILE_NAME);
}

function rotateIfNeeded(path) {
  try {
    if (!existsSync(path) || statSync(path).size < MAX_BYTES) return;
    const backup = `${path}.1`;
    // Windows refuses rename() onto an existing file; remove the old backup.
    rmSync(backup, { force: true });
    renameSync(path, backup);
  } catch {
    // Rotation is a nicety; appending must still be attempted.
  }
}

/** Single-line JSON so a crafted error message cannot forge extra entries. */
function format({ level, event, message, details }) {
  return JSON.stringify({
    at: Date.now(),
    source: "mcp",
    level,
    event,
    message: String(message ?? "").slice(0, 8000),
    ...(details && typeof details === "object" ? details : {}),
  });
}

/**
 * @param {{stderr?: (line: string) => void, echo?: boolean, dir?: string}} options
 *   `dir` overrides the log directory — used by tests and by callers that
 *   want a project-local log without touching the user's home directory.
 */
export function createMcpLogger(options = {}) {
  const logDir = options.dir ?? mcpLogDir();
  const path = join(logDir, LOG_FILE_NAME);
  const stderr = options.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const echo = options.echo !== false;
  let lastError = null;

  const write = (level, event, message, details) => {
    const line = format({ level, event, message, details });
    if (echo) stderr(`[reqora-mcp] ${String(message ?? event)}`);
    try {
      mkdirSync(logDir, { recursive: true });
      rotateIfNeeded(path);
      appendFileSync(path, `${line}\n`, "utf8");
      lastError = null;
    } catch (error) {
      // Keep the reason so a failed write can still tell the user why there
      // is no log file (e.g. a read-only home directory).
      lastError = String(error?.message ?? error);
      if (echo) stderr(`[reqora-mcp] 错误日志写入失败：${lastError}`);
    }
  };

  return {
    path,
    get lastError() {
      return lastError;
    },
    info: (event, message, details) => write("info", event, message, details),
    warn: (event, message, details) => write("warn", event, message, details),
    error: (event, message, details) => write("error", event, message, details),
    /** Newest lines, oldest first within the returned array. */
    tail(limit = 100) {
      try {
        if (!existsSync(path)) return [];
        return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).slice(-limit);
      } catch {
        return [];
      }
    },
  };
}
