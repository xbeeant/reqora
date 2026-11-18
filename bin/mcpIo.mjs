// stdio framing for `bin/mcp.mjs`. Kept in its own module so the queue can be
// unit tested without spawning a server process.
//
// Two invariants:
//   1. Frames are written in request order (tools may perform network I/O).
//   2. A failing handler still produces a JSON-RPC error frame — otherwise the
//      client waits forever for a response that will never arrive.

/**
 * @param {{handle: (message: object) => Promise<object|null>, write: (frame: object) => void, log?: (text: string) => void}} options
 */
export function createMessageQueue({ handle, write, log = () => {} }) {
  let queue = Promise.resolve();
  return {
    enqueue(line) {
      const trimmed = String(line ?? "").trim();
      if (!trimmed) return queue;
      queue = queue.then(async () => {
        let message;
        try {
          message = JSON.parse(trimmed);
        } catch {
          write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } });
          return;
        }
        const id = message?.id ?? null;
        try {
          const response = await handle(message);
          if (response) write(response);
        } catch (error) {
          const text = error?.message ?? String(error);
          log(`处理消息失败：${text}`);
          // Notifications have no id and must not receive a response frame.
          if (id !== null) {
            write({ jsonrpc: "2.0", id, error: { code: -32603, message: text } });
          }
        }
      });
      return queue;
    },
    get settled() {
      return queue;
    },
  };
}
