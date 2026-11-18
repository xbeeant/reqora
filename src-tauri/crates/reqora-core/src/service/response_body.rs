//! Streaming response-body pipeline.
//!
//! One implementation is shared by `send_request` and the non-SSE branch of
//! `stream_request`: undo the `Content-Encoding` chain on the fly, tee every
//! decoded chunk into the on-disk `BodyStore`, keep only a bounded inline
//! preview, and shape the same `ResponsePayload` the buffered path used to.
//! The full decoded body never has to live in memory.

use crate::config::Config;
use crate::error::AppError;
use crate::models::ResponsePayload;
use crate::service::body_store::{BodyStore, CHUNK_BYTES, LINE_OFFSETS_PER_ROW};
use crate::service::http::ResponseMeta;
use crate::service::timing::wire_response;
use async_compression::futures::bufread::{
    BrotliDecoder, DeflateDecoder, GzipDecoder, ZlibDecoder, ZstdDecoder,
};
use base64::Engine;
use futures_util::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, BufReader};
use futures_util::TryStreamExt;
use reqwest::header::CONTENT_ENCODING;
use std::io;

/// Encodings we know how to invert with `async-compression`.
fn is_known(encoding: &str) -> bool {
    matches!(encoding, "gzip" | "x-gzip" | "deflate" | "br" | "zstd")
}

/// Rebuild the inverse of a `Content-Encoding` chain around a raw byte reader.
/// Encodings are declared in application order, so the outermost (last) one
/// must be peeled off first. Kept separate from `collect` so the four codecs
/// can be exercised with real compressed bytes, without a network fixture.
async fn decode_chain(
    mut reader: Box<dyn AsyncBufRead + Unpin + Send>,
    encodings: &[String],
) -> Result<Box<dyn AsyncBufRead + Unpin + Send>, AppError> {
    for encoding in encodings.iter().rev() {
        reader = match encoding.as_str() {
            "gzip" | "x-gzip" => Box::new(BufReader::new(GzipDecoder::new(reader))),
            "br" => Box::new(BufReader::new(BrotliDecoder::new(reader))),
            "zstd" => Box::new(BufReader::new(ZstdDecoder::new(reader))),
            "deflate" => {
                // `deflate` is ambiguous: real servers send either a zlib
                // wrapper (CMF 0x78 ..) or a raw deflate stream. Peek the
                // first two bytes without consuming them, then choose.
                let is_zlib = {
                    let peek = reader
                        .fill_buf()
                        .await
                        .map_err(|error| AppError::Network(format!("读取压缩流失败: {error}")))?;
                    peek.len() >= 2
                        && peek[0] == 0x78
                        && (((peek[0] as u16) << 8) | peek[1] as u16) % 31 == 0
                };
                if is_zlib {
                    Box::new(BufReader::new(ZlibDecoder::new(reader)))
                } else {
                    Box::new(BufReader::new(DeflateDecoder::new(reader)))
                }
            }
            // Unknown tokens are filtered out by `collect`; passing the reader
            // through here keeps this function total.
            _ => reader,
        };
    }
    Ok(reader)
}

/// Stream `response` into `store` under `body_id` and build the response DTO.
///
/// `size` is the full decoded byte count, while `body` only carries the first
/// `inline_body_bytes` decoded bytes. Reading stops at `max_body_spool_bytes`
/// so neither memory nor disk can grow without bound.
pub async fn collect(
    meta: &ResponseMeta,
    response: reqwest::Response,
    config: &Config,
    request_id: &str,
    body_id: &str,
    store: &BodyStore,
) -> Result<ResponsePayload, AppError> {
    // Closing reqwest's auto-decompression keeps the Content-Encoding header
    // intact, so we rebuild the applied chain ourselves. Header values are
    // captured before `bytes_stream()` consumes the response.
    let raw_encoding = response
        .headers()
        .get_all(CONTENT_ENCODING)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .collect::<Vec<_>>()
        .join(",");
    let encodings: Vec<String> = raw_encoding
        .split(',')
        .map(|token| token.trim().to_ascii_lowercase())
        .filter(|token| !token.is_empty() && token != "identity")
        .collect();
    // The declared chain is always recorded in the store's metadata; the
    // ResponsePayload field only records chains we actually decoded.
    let declared: Option<String> = if encodings.is_empty() {
        None
    } else {
        Some(encodings.join(", "))
    };
    let decodable = encodings.iter().all(|encoding| is_known(encoding));
    let applied_chain = if decodable { declared.clone() } else { None };

    let stream = response
        .bytes_stream()
        .map_err(io::Error::other)
        .into_async_read();
    let mut reader: Box<dyn AsyncBufRead + Unpin + Send> = Box::new(BufReader::new(stream));
    if decodable {
        reader = decode_chain(reader, &encodings).await?;
    }

    store.begin(body_id)?;

    let inline_cap = config.inline_body_bytes;
    let spool_cap = config.max_body_spool_bytes as u64;
    let mut preview: Vec<u8> = Vec::new();
    let mut size: u64 = 0;
    let mut newline_count: u64 = 0;
    let mut newline_offsets: Vec<u64> = Vec::new();
    let mut line_seq: u64 = 0;
    // Decoded bytes are buffered into fixed CHUNK_BYTES rows so `seq *
    // CHUNK_BYTES` is the absolute byte offset of each stored chunk.
    let mut pending: Vec<u8> = Vec::with_capacity(CHUNK_BYTES);
    let mut chunk_seq: u64 = 0;
    let mut read_buf = [0u8; CHUNK_BYTES];

    loop {
        if size >= spool_cap {
            break;
        }
        let n = reader
            .read(&mut read_buf)
            .await
            .map_err(|error| AppError::Network(format!("读取响应体失败: {error}")))?;
        if n == 0 {
            break;
        }
        // Never persist more than the spool ceiling on the final chunk.
        let allowed = ((spool_cap - size) as usize).min(n);
        let chunk = &read_buf[..allowed];

        // (b) Record every newline's absolute byte offset, flushing in batches.
        for (index, byte) in chunk.iter().enumerate() {
            if *byte == b'\n' {
                newline_offsets.push(size + index as u64);
                newline_count += 1;
                if newline_offsets.len() >= LINE_OFFSETS_PER_ROW {
                    store.append_line_offsets(body_id, line_seq, &newline_offsets)?;
                    line_seq += 1;
                    newline_offsets.clear();
                }
            }
        }

        // (c) Keep only the first `inline_body_bytes` decoded bytes in memory.
        let already = size as usize;
        if already < inline_cap {
            let take = (inline_cap - already).min(allowed);
            preview.extend_from_slice(&chunk[..take]);
        }

        // (a) Tee into fixed-size spool chunks.
        pending.extend_from_slice(chunk);
        while pending.len() >= CHUNK_BYTES {
            store.append_chunk(body_id, chunk_seq, &pending[..CHUNK_BYTES])?;
            chunk_seq += 1;
            pending.drain(..CHUNK_BYTES);
        }

        // (d) Accumulate the full decoded size.
        size += allowed as u64;
    }

    if !pending.is_empty() {
        store.append_chunk(body_id, chunk_seq, &pending)?;
    }
    if !newline_offsets.is_empty() {
        store.append_line_offsets(body_id, line_seq, &newline_offsets)?;
    }

    let inline_bytes = preview.len() as u64;
    let total_lines = newline_count + 1;
    let truncated = size > inline_bytes;

    // Kind detection mirrors `HttpService::payload`, but runs on the preview.
    let body_kind = if preview.is_empty() {
        "empty"
    } else if preview.contains(&0) || std::str::from_utf8(&preview).is_err() {
        "binary"
    } else if meta.content_type.contains("json")
        || serde_json::from_slice::<serde_json::Value>(&preview).is_ok()
    {
        "json"
    } else {
        "text"
    };
    let body = if body_kind == "binary" {
        base64::engine::general_purpose::STANDARD.encode(&preview)
    } else {
        String::from_utf8_lossy(&preview).into_owned()
    };

    store.finish(
        body_id,
        size,
        total_lines,
        body_kind,
        &declared.clone().unwrap_or_default(),
    )?;

    let time_ms = meta.started.elapsed().as_millis() as u64;
    let timings = meta.timings.finish(time_ms, meta.ttfb_ms, &meta.protocol, meta.https);
    let raw_response = wire_response(
        &meta.protocol,
        meta.status,
        &meta.status_text,
        &meta.headers,
        &preview,
        body_kind == "binary",
        truncated,
    );

    Ok(ResponsePayload {
        request_id: request_id.to_string(),
        status: meta.status,
        status_text: meta.status_text.clone(),
        ok: meta.ok,
        time_ms,
        size: size as usize,
        url: meta.url.clone(),
        resolved_url: meta.resolved_url.clone(),
        missing_variables: meta.missing_variables.clone(),
        headers: meta.headers.clone(),
        body,
        body_kind: body_kind.to_string(),
        truncated,
        timings,
        raw_request: meta.raw_request.clone(),
        raw_response,
        body_ref: Some(body_id.to_string()),
        content_encoding: applied_chain,
        total_lines,
        inline_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::io::Cursor;

    // Real compressed payloads for the plaintext below, produced with Node's
    // zlib (gzipSync / deflateSync / deflateRawSync / brotliCompressSync /
    // zstdCompressSync). Embedded as bytes so the codec tests need no server.
    const PLAIN: &[u8] = b"reqora streaming body test\nline two\nline three\n";
    const GZIP: &[u8] = &[0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x13, 0x2b, 0x4a, 0x2d, 0xcc, 0x2f, 0x4a, 0x54, 0x28, 0x2e, 0x29, 0x4a, 0x4d, 0xcc, 0xcd, 0xcc, 0x4b, 0x57, 0x48, 0xca, 0x4f, 0xa9, 0x54, 0x28, 0x49, 0x2d, 0x2e, 0xe1, 0xca, 0xc9, 0xcc, 0x4b, 0x55, 0x28, 0x29, 0xcf, 0x87, 0x32, 0x32, 0x8a, 0x52, 0x53, 0xb9, 0x00, 0x58, 0x4d, 0xea, 0x3e, 0x2f, 0x00, 0x00, 0x00];
    const DEFLATE_ZLIB: &[u8] = &[0x78, 0x9c, 0x2b, 0x4a, 0x2d, 0xcc, 0x2f, 0x4a, 0x54, 0x28, 0x2e, 0x29, 0x4a, 0x4d, 0xcc, 0xcd, 0xcc, 0x4b, 0x57, 0x48, 0xca, 0x4f, 0xa9, 0x54, 0x28, 0x49, 0x2d, 0x2e, 0xe1, 0xca, 0xc9, 0xcc, 0x4b, 0x55, 0x28, 0x29, 0xcf, 0x87, 0x32, 0x32, 0x8a, 0x52, 0x53, 0xb9, 0x00, 0xad, 0x38, 0x11, 0x43];
    const DEFLATE_RAW: &[u8] = &[0x2b, 0x4a, 0x2d, 0xcc, 0x2f, 0x4a, 0x54, 0x28, 0x2e, 0x29, 0x4a, 0x4d, 0xcc, 0xcd, 0xcc, 0x4b, 0x57, 0x48, 0xca, 0x4f, 0xa9, 0x54, 0x28, 0x49, 0x2d, 0x2e, 0xe1, 0xca, 0xc9, 0xcc, 0x4b, 0x55, 0x28, 0x29, 0xcf, 0x87, 0x32, 0x32, 0x8a, 0x52, 0x53, 0xb9, 0x00];
    const BROTLI: &[u8] = &[0x1b, 0x2e, 0x00, 0xe8, 0x15, 0xa1, 0xd2, 0xdd, 0xc6, 0xbe, 0x67, 0xb9, 0x6f, 0xc3, 0x2d, 0x99, 0x10, 0x6c, 0xc0, 0x81, 0x43, 0x96, 0x70, 0xb4, 0x1f, 0x34, 0xcd, 0xe0, 0x43, 0x44, 0xe6, 0xa3, 0x75, 0x86, 0x03, 0x1a, 0xc4, 0xae, 0xba, 0xe2, 0xd8, 0x37, 0xd8, 0x04];
    const ZSTD: &[u8] = &[0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x2f, 0x79, 0x01, 0x00, 0x72, 0x65, 0x71, 0x6f, 0x72, 0x61, 0x20, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d, 0x69, 0x6e, 0x67, 0x20, 0x62, 0x6f, 0x64, 0x79, 0x20, 0x74, 0x65, 0x73, 0x74, 0x0a, 0x6c, 0x69, 0x6e, 0x65, 0x20, 0x74, 0x77, 0x6f, 0x0a, 0x6c, 0x69, 0x6e, 0x65, 0x20, 0x74, 0x68, 0x72, 0x65, 0x65, 0x0a];
    const STACK_GZIP_BR: &[u8] = &[0x0b, 0x1e, 0x80, 0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x13, 0x2b, 0x4a, 0x2d, 0xcc, 0x2f, 0x4a, 0x54, 0x28, 0x2e, 0x29, 0x4a, 0x4d, 0xcc, 0xcd, 0xcc, 0x4b, 0x57, 0x48, 0xca, 0x4f, 0xa9, 0x54, 0x28, 0x49, 0x2d, 0x2e, 0xe1, 0xca, 0xc9, 0xcc, 0x4b, 0x55, 0x28, 0x29, 0xcf, 0x87, 0x32, 0x32, 0x8a, 0x52, 0x53, 0xb9, 0x00, 0x58, 0x4d, 0xea, 0x3e, 0x2f, 0x00, 0x00, 0x00, 0x03];

    async fn decode(encoded: &[u8], chain: &[&str]) -> Vec<u8> {
        let reader: Box<dyn AsyncBufRead + Unpin + Send> =
            Box::new(BufReader::new(Cursor::new(encoded.to_vec())));
        let encodings: Vec<String> = chain.iter().map(|name| name.to_string()).collect();
        let mut decoded = decode_chain(reader, &encodings).await.unwrap();
        let mut out = Vec::new();
        decoded.read_to_end(&mut out).await.unwrap();
        out
    }

    #[tokio::test]
    async fn gzip_stream_is_decoded() {
        assert_eq!(decode(GZIP, &["gzip"]).await, PLAIN);
    }

    #[tokio::test]
    async fn deflate_stream_is_decoded_in_both_wire_formats() {
        assert_eq!(decode(DEFLATE_ZLIB, &["deflate"]).await, PLAIN);
        assert_eq!(decode(DEFLATE_RAW, &["deflate"]).await, PLAIN);
    }

    #[tokio::test]
    async fn brotli_stream_is_decoded() {
        assert_eq!(decode(BROTLI, &["br"]).await, PLAIN);
    }

    #[tokio::test]
    async fn zstd_stream_is_decoded() {
        assert_eq!(decode(ZSTD, &["zstd"]).await, PLAIN);
    }

    #[tokio::test]
    async fn stacked_encodings_are_peeled_in_reverse_order() {
        assert_eq!(decode(STACK_GZIP_BR, &["gzip", "br"]).await, PLAIN);
    }

    #[tokio::test]
    async fn identity_and_unknown_tokens_pass_bytes_through() {
        assert_eq!(decode(PLAIN, &[]).await, PLAIN);
        assert_eq!(decode(PLAIN, &["identity"]).await, PLAIN);
    }

    #[test]
    fn only_declared_codecs_are_considered_decodable() {
        assert!(["gzip", "x-gzip", "deflate", "br", "zstd"]
            .iter()
            .all(|name| is_known(name)));
        assert!(!is_known("compress"));
        assert!(!is_known(""));
    }
}
