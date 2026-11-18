#!/usr/bin/env node
/**
 * Zero-dependency local SSE fixture for Reqora.
 *
 *   node examples/sse-server.mjs            # http://127.0.0.1:8788
 *   PORT=9000 node examples/sse-server.mjs
 *
 * Endpoints:
 *   POST /v1/chat/completions   OpenAI-compatible deltas + DeepSeek reasoning
 *   GET  /plain                 plain text fragments (data: 春 / data: 天 …)
 *   GET  /gemini                Gemini candidates[].content.parts[].text
 *   GET  /claude                Claude content_block_delta events
 *   GET  /custom                non-standard JSON (try JSONPath $.chunk.text)
 *   GET  /multi                 multi-line data + comments + event/id
 *   POST /echo                  ordinary JSON, no SSE (NonSse fallback)
 *
 * Nothing here talks to the internet; it exists purely to make the streaming
 * merge behaviour reproducible without an API key.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8788);
const HOST = process.env.HOST ?? "127.0.0.1";

function sse(res, { event, id, data, delay = 90 }) {
  return new Promise((resolve) => {
    setTimeout(() => {
      if (res.writableEnded) return resolve();
      if (event) res.write(`event: ${event}\n`);
      if (id) res.write(`id: ${id}\n`);
      const lines = String(data).split("\n");
      for (const line of lines) res.write(`data: ${line}\n`);
      res.write("\n");
      resolve();
    }, delay);
  });
}

function openSse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

const OPENAI_REASONING = ["让我想想", "：", "用户想要一句", "关于春天的话。"];
const OPENAI_ANSWER = ["春风", "拂过", "柳梢，", "把整条", "街都", "染成", "了新绿。"];

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? HOST}`);
  const path = url.pathname;

  if (path === "/echo" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let parsed = {};
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      /* keep empty */
    }
    json(res, 200, { ok: true, received: parsed, note: "not an event stream" });
    return;
  }

  if (path === "/v1/chat/completions" && req.method === "POST") {
    openSse(res);
    const base = (delta) =>
      JSON.stringify({
        id: "chatcmpl-local",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "demo",
        choices: [{ index: 0, delta, finish_reason: null }],
      });
    let seq = 0;
    for (const piece of OPENAI_REASONING) {
      await sse(res, { id: String(++seq), data: base({ reasoning_content: piece }), delay: 70 });
    }
    for (const piece of OPENAI_ANSWER) {
      await sse(res, { id: String(++seq), data: base({ content: piece }), delay: 110 });
    }
    await sse(res, {
      id: String(++seq),
      data: base({}) + "",
      delay: 40,
    });
    res.write(`data: [DONE]\n\n`);
    res.end();
    return;
  }

  if (path === "/plain") {
    openSse(res);
    for (const piece of ["春", "天", "来", "了", "。"]) {
      await sse(res, { data: piece, delay: 140 });
    }
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  if (path === "/gemini") {
    openSse(res);
    for (const piece of ["Gemini ", "streams ", "text ", "fragments."]) {
      await sse(res, {
        data: JSON.stringify({ candidates: [{ content: { parts: [{ text: piece }] } }] }),
        delay: 120,
      });
    }
    res.end();
    return;
  }

  if (path === "/claude") {
    openSse(res);
    await sse(res, { event: "message_start", data: JSON.stringify({ type: "message_start" }), delay: 60 });
    for (const piece of ["Claude ", "delta ", "text."]) {
      await sse(res, {
        event: "content_block_delta",
        data: JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: piece } }),
        delay: 120,
      });
    }
    await sse(res, { event: "message_stop", data: JSON.stringify({ type: "message_stop" }), delay: 60 });
    res.end();
    return;
  }

  if (path === "/custom") {
    openSse(res);
    for (const piece of ["自定义", "字段", "拼接"]) {
      await sse(res, { data: JSON.stringify({ chunk: { text: piece } }), delay: 120 });
    }
    res.end();
    return;
  }

  if (path === "/multi") {
    openSse(res);
    await sse(res, { event: "patch", id: "7", data: "line one\nline two", delay: 60 });
    res.write(": heartbeat\n\n");
    await sse(res, { event: "patch", id: "8", data: "third", delay: 200 });
    // Intentionally no trailing blank line: exercises parser.finish().
    res.write("data: tail");
    res.end();
    return;
  }

  if (path === "/") {
    json(res, 200, {
      service: "reqora-sse-fixture",
      endpoints: ["/v1/chat/completions", "/plain", "/gemini", "/claude", "/custom", "/multi", "/echo"],
    });
    return;
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`[reqora-sse] listening on http://${HOST}:${PORT}`);
});
