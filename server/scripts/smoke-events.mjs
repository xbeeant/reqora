/**
 * Real SSE smoke test: subscribe to workspace events, write a snapshot, and
 * assert that a version-change event is pushed on the same connection.
 *
 * Requires a running server + MySQL. Env: BASE_URL, SMOKE_ADMIN_PASSWORD
 * (falls back to REQORA_ADMIN_PASSWORD), REQORA_ADMIN_USERNAME.
 */
import assert from "node:assert/strict";

const base = (process.env.BASE_URL ?? "http://127.0.0.1:18080").replace(/\/$/, "");
const username =
  process.env.SMOKE_ADMIN_USERNAME ?? process.env.REQORA_ADMIN_USERNAME ?? "admin";
const password = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.REQORA_ADMIN_PASSWORD;
if (!password) throw new Error("需要 SMOKE_ADMIN_PASSWORD 或 REQORA_ADMIN_PASSWORD");

async function call(method, path, { token, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(payload.code, 0, `${method} ${path} 失败: ${JSON.stringify(payload)}`);
  return payload.data;
}

const tokens = await call("POST", "/api/v1/auth/login", {
  body: { username, password },
});
const token = tokens.accessToken;
const stamp = Date.now();
const project = await call("POST", "/api/v1/projects", {
  token,
  body: { name: `sse-smoke-${stamp}`, slug: `sse-${stamp}`, description: "" },
});
const projectId = project.id;
const head = await call("GET", `/api/v1/projects/${projectId}/workspace/head`, { token });

const controller = new AbortController();
let response;
try {
  response = await fetch(`${base}/api/v1/projects/${projectId}/workspace/events`, {
    headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(response.status, 200, `SSE 订阅返回 ${response.status}`);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";

  const readChunk = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待 SSE 事件超时")), 10_000);
      reader.read().then(
        (chunk) => {
          clearTimeout(timer);
          resolve(chunk);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });

  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const chunk = await readChunk();
      if (chunk.done) throw new Error("SSE 连接提前关闭");
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        const data = block.split(/\r?\n/).find((line) => line.startsWith("data:"));
        if (data) {
          try {
            events.push(JSON.parse(data.slice(5).trim()));
          } catch {
            // heartbeat
          }
        }
      }
      if (predicate(events)) return;
    }
    throw new Error("未收到预期的 SSE 事件");
  };

  await waitFor((list) => list.some((event) => event.type === "connected"));
  assert.equal(events[0].version, head.version);

  await call("POST", `/api/v1/projects/${projectId}/workspace/rows`, {
    token,
    body: {
      folders: [{ id: "sse-c1", name: "SSE 集合", position: 0, updatedAt: stamp }],
      requests: [], environments: [], cases: [], scenarios: [], suites: [], artifacts: [],
    },
  });
  await waitFor((list) =>
    list.some((event) => event.type === "workspace" && event.version === head.version + 1),
  );

  console.log(
    `SSE 冒烟通过：connected(v${head.version}) + workspace(v${head.version + 1}) 事件均已推送`,
  );
} finally {
  controller.abort();
  await call("DELETE", `/api/v1/projects/${projectId}`, { token }).catch(() => undefined);
}
