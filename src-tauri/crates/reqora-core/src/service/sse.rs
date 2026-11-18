//! Incremental Server-Sent Events framing and the streaming IPC envelope.
//!
//! The parser is deliberately a byte-level, chunk-agnostic state machine: a
//! network chunk can end in the middle of a line or even in the middle of a
//! UTF-8 sequence, so nothing is decoded until a complete line is available.
//! It implements the WHATWG `text/event-stream` field rules (data/event/id,
//! multi-line `data`, comments, one optional leading space after the colon).

use crate::models::{ResponseHeader, ResponsePayload};
use crate::service::timing::ResponseTimings;
use serde::Serialize;

/// A single event must not be allowed to grow unbounded (a malicious server
/// could otherwise send one endless line and exhaust the process).
pub const MAX_EVENT_DATA_BYTES: usize = 512 * 1024;
pub const MAX_FRAMES: u64 = 20_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SseFrame {
    pub seq: u64,
    /// Milliseconds since the request was sent — used for the timeline view.
    pub at_ms: u64,
    pub event: String,
    pub id: String,
    /// Multi-line `data:` fields joined with `\n`, as the SSE spec requires.
    pub data: String,
    /// Original field lines of this event, for the raw event inspector.
    pub raw: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SseMeta {
    pub status: u16,
    pub status_text: String,
    pub ok: bool,
    pub url: String,
    pub resolved_url: String,
    pub headers: Vec<ResponseHeader>,
    pub content_type: String,
    pub missing_variables: Vec<String>,
    /// Connection / TTFB checkpoints known when headers arrived (transfer = 0).
    pub timings: ResponseTimings,
    /// Request line + headers + body, reconstructed before sending.
    pub raw_request: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SseMessage {
    /// Headers arrived; the body has not been consumed yet.
    Meta { meta: SseMeta },
    Frame { frame: SseFrame },
    Done {
        frames: u64,
        bytes: u64,
        elapsed_ms: u64,
        truncated: bool,
        cancelled: bool,
        /// Final breakdown including the whole stream's transfer time.
        timings: ResponseTimings,
        /// Status line + headers + every byte received on the wire.
        raw_response: String,
    },
    /// Server did not answer with `text/event-stream`; fall back to a normal
    /// buffered response without making a second request.
    NonSse { response: ResponsePayload },
    Error { code: String, message: String },
}

#[derive(Debug, Default)]
struct Draft {
    data_lines: Vec<String>,
    data_bytes: usize,
    event: String,
    id: String,
    raw_lines: Vec<String>,
}

pub struct SseParser {
    buf: Vec<u8>,
    draft: Draft,
    seq: u64,
    first_line: bool,
    /// NDJSON mode: every complete non-empty line is one frame (`event` =
    /// "ndjson"), instead of the SSE field/blank-line protocol.
    ndjson: bool,
    /// Set when an oversized event had to be cut short.
    pub truncated: bool,
}

impl SseParser {
    pub fn new() -> Self {
        Self {
            buf: Vec::new(),
            draft: Draft::default(),
            seq: 0,
            first_line: true,
            ndjson: false,
            truncated: false,
        }
    }

    /// NDJSON (application/x-ndjson / .jsonl): each line is a self-contained
    /// JSON document. The byte-buffer handling is shared with SSE; only the
    /// line → frame rule differs.
    pub fn new_ndjson() -> Self {
        Self {
            ndjson: true,
            ..Self::new()
        }
    }

    /// Feed one network chunk, returning every event completed by it.
    pub fn push(&mut self, chunk: &[u8], at_ms: u64) -> Vec<SseFrame> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        loop {
            let Some(index) = self.buf.iter().position(|byte| *byte == b'\n') else {
                // No complete line yet. Bound an endless line so one event can
                // never grow beyond the configured limit.
                if self.buf.len() > MAX_EVENT_DATA_BYTES {
                    self.buf.clear();
                    self.truncated = true;
                }
                break;
            };
            let mut line: Vec<u8> = self.buf.drain(..=index).collect();
            line.pop(); // trailing \n
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if let Some(frame) = self.handle_line(line, at_ms) {
                out.push(frame);
            }
        }
        out
    }

    /// Flush the final event when the stream ends without a trailing blank line.
    pub fn finish(&mut self, at_ms: u64) -> Option<SseFrame> {
        if !self.buf.is_empty() {
            let mut line = std::mem::take(&mut self.buf);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if let Some(frame) = self.handle_line(line, at_ms) {
                return Some(frame);
            }
        }
        self.dispatch(at_ms)
    }

    fn handle_line(&mut self, bytes: Vec<u8>, at_ms: u64) -> Option<SseFrame> {
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        if self.first_line {
            self.first_line = false;
            if let Some(stripped) = text.strip_prefix('\u{feff}') {
                text = stripped.to_string();
            }
        }

        if self.ndjson {
            // Blank lines carry no JSON document; everything else is a frame.
            if text.trim().is_empty() {
                return None;
            }
            if text.len() > MAX_EVENT_DATA_BYTES {
                self.truncated = true;
            }
            self.seq += 1;
            return Some(SseFrame {
                seq: self.seq,
                at_ms,
                event: "ndjson".to_string(),
                id: String::new(),
                data: text.clone(),
                raw: text,
            });
        }

        // A blank line dispatches the event. Comments and field lines are kept
        // verbatim so the raw inspector can show exactly what arrived.
        if text.is_empty() {
            return self.dispatch(at_ms);
        }
        self.draft.raw_lines.push(text.clone());
        if text.starts_with(':') {
            return None;
        }

        let (name, mut value) = match text.find(':') {
            Some(index) => (text[..index].to_string(), text[index + 1..].to_string()),
            None => (text, String::new()),
        };
        if value.starts_with(' ') {
            value.remove(0);
        }

        match name.as_str() {
            "data" => {
                if self.draft.data_bytes + value.len() > MAX_EVENT_DATA_BYTES {
                    self.truncated = true;
                } else {
                    self.draft.data_bytes += value.len();
                    self.draft.data_lines.push(value);
                }
            }
            "event" => self.draft.event = value,
            // Per spec, ids containing NUL are ignored.
            "id" if !value.contains('\0') => self.draft.id = value,
            // `retry` and unknown fields are intentionally ignored.
            _ => {}
        }
        None
    }

    fn dispatch(&mut self, at_ms: u64) -> Option<SseFrame> {
        let draft = std::mem::take(&mut self.draft);
        if draft.data_lines.is_empty() && draft.event.is_empty() && draft.id.is_empty() {
            return None;
        }
        self.seq += 1;
        Some(SseFrame {
            seq: self.seq,
            at_ms,
            event: if draft.event.is_empty() {
                "message".to_string()
            } else {
                draft.event
            },
            id: draft.id,
            data: draft.data_lines.join("\n"),
            raw: draft.raw_lines.join("\n"),
        })
    }
}

impl Default for SseParser {
    fn default() -> Self {
        Self::new()
    }
}

/// Does this content type mean newline-delimited JSON?
pub fn is_ndjson_content_type(content_type: &str) -> bool {
    let value = content_type.to_ascii_lowercase();
    value.contains("ndjson") || value.contains("jsonl") || value.contains("jsonlines")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_data_events() {
        let mut parser = SseParser::new();
        let frames = parser.push(b"data: hello\n\ndata: world\n\n", 5);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].data, "hello");
        assert_eq!(frames[0].event, "message");
        assert_eq!(frames[0].seq, 1);
        assert_eq!(frames[1].data, "world");
        assert_eq!(frames[1].seq, 2);
        assert_eq!(frames[0].at_ms, 5);
    }

    #[test]
    fn joins_multiline_data_and_keeps_raw() {
        let mut parser = SseParser::new();
        let frames = parser.push(b"event: patch\nid: 42\ndata: line1\ndata: line2\n\n", 0);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data, "line1\nline2");
        assert_eq!(frames[0].event, "patch");
        assert_eq!(frames[0].id, "42");
        assert!(frames[0].raw.contains("data: line1"));
    }

    #[test]
    fn handles_crlf_comments_bom_and_split_chunks() {
        let mut parser = SseParser::new();
        let mut out = Vec::new();
        out.extend(parser.push(b"\xef\xbb\xbf: keep-alive\r\nda", 1));
        out.extend(parser.push(b"ta: \xe4\xbd\xa0", 2));
        out.extend(parser.push(b"\xe5\xa5\xbd\r\n\r\n", 3));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].data, "你好");
        assert!(out[0].raw.contains("keep-alive"));
    }

    #[test]
    fn flushes_final_event_without_blank_line() {
        let mut parser = SseParser::new();
        assert!(parser.push(b"data: tail", 7).is_empty());
        let frame = parser.finish(9).expect("tail event should be dispatched");
        assert_eq!(frame.data, "tail");
        assert_eq!(frame.at_ms, 9);
        assert!(parser.finish(10).is_none());
    }

    #[test]
    fn empty_events_and_done_markers() {
        let mut parser = SseParser::new();
        let frames = parser.push(b"\n\n:comment\n\ndata: [DONE]\n\n", 0);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data, "[DONE]");
    }

    #[test]
    fn ndjson_frames_every_line_and_skips_blank() {
        let mut parser = SseParser::new_ndjson();
        let frames = parser.push(b"{\"a\":1}\r\n{\"a\":2}\n\n  \n{\"a\":3}", 12);
        // `{"a":3}` has no trailing newline yet: it stays buffered.
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].data, "{\"a\":1}");
        assert_eq!(frames[0].event, "ndjson");
        assert_eq!(frames[0].at_ms, 12);
        assert_eq!(frames[1].data, "{\"a\":2}");
        assert!(!parser.truncated);
        // The trailing partial line flushes on finish.
        let tail = parser.finish(20).expect("tail");
        assert_eq!(tail.data, "{\"a\":3}");
        assert_eq!(tail.seq, 3);
        assert!(parser.finish(21).is_none());
    }

    #[test]
    fn ndjson_survives_split_chunks_and_utf8_boundaries() {
        let mut parser = SseParser::new_ndjson();
        let mut out = Vec::new();
        out.extend(parser.push(b"\xef\xbb\xbf{\"text\":\"\xe4\xbd", 1));
        out.extend(parser.push(b"\xa0\xe5\xa5\xbd\"}\n{\"x\":2}\n", 2));
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].data, "{\"text\":\"你好\"}");
        assert_eq!(out[1].data, "{\"x\":2}");
        assert!(parser.finish(3).is_none());
    }

    #[test]
    fn ndjson_content_type_detection() {
        assert!(is_ndjson_content_type("application/x-ndjson"));
        assert!(is_ndjson_content_type("application/ndjson; charset=utf-8"));
        assert!(is_ndjson_content_type("application/jsonl"));
        assert!(is_ndjson_content_type("application/x-jsonlines"));
        assert!(!is_ndjson_content_type("text/event-stream"));
        assert!(!is_ndjson_content_type("application/json"));
    }

    #[test]
    fn caps_oversized_line() {
        let mut parser = SseParser::new();
        let huge = vec![b'x'; MAX_EVENT_DATA_BYTES + 10];
        assert!(parser.push(&huge, 0).is_empty());
        assert!(parser.truncated);
    }

    /// The frontend reads camelCase keys from every Channel message. Guard the
    /// exact wire shape so a serde attribute change cannot silently break it.
    #[test]
    fn messages_use_camel_case_wire_keys() {
        let done = serde_json::to_value(SseMessage::Done {
            frames: 3,
            bytes: 128,
            elapsed_ms: 42,
            truncated: false,
            cancelled: true,
            timings: ResponseTimings::default(),
            raw_response: "HTTP/1.1 200 OK\r\n\r\ndata: hi".into(),
        })
        .expect("done serialises");
        assert_eq!(done["kind"], "done");
        assert_eq!(done["elapsedMs"], 42);
        assert_eq!(done["cancelled"], true);
        assert_eq!(done["timings"]["totalMs"], 0);
        assert_eq!(done["rawResponse"], "HTTP/1.1 200 OK\r\n\r\ndata: hi");
        assert!(done.get("elapsed_ms").is_none());

        let error = serde_json::to_value(SseMessage::Error {
            code: "NETWORK_ERROR".into(),
            message: "断线".into(),
        })
        .expect("error serialises");
        assert_eq!(error["kind"], "error");

        let meta = serde_json::to_value(SseMessage::Meta {
            meta: SseMeta {
                status: 200,
                status_text: "OK".into(),
                ok: true,
                url: "http://127.0.0.1:8788/plain".into(),
                resolved_url: "http://127.0.0.1:8788/plain".into(),
                headers: vec![],
                content_type: "text/event-stream; charset=utf-8".into(),
                missing_variables: vec![],
                timings: ResponseTimings::default(),
                raw_request: "GET /plain HTTP/1.1\r\n\r\n".into(),
            },
        })
        .expect("meta serialises");
        assert_eq!(meta["kind"], "meta");
        assert_eq!(meta["meta"]["statusText"], "OK");
        assert_eq!(meta["meta"]["contentType"], "text/event-stream; charset=utf-8");
        assert_eq!(meta["meta"]["rawRequest"], "GET /plain HTTP/1.1\r\n\r\n");
        assert_eq!(meta["meta"]["timings"]["dnsMs"], 0);
    }
}
