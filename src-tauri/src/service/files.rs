//! Import/export helpers: native file dialogs (rfd) plus UTF-8 text IO.
//!
//! The rfd sync dialog API must not run on the macOS main thread, so both
//! functions run inside `spawn_blocking` on the tokio blocking pool.

use reqora_core::error::AppError;
use reqora_core::service::body_store::BodyStore;
use crate::service::grpc::GrpcFileRef;
use serde::Serialize;
use std::io::{BufWriter, Write};
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub name: String,
    pub content: String,
}

/// Result of writing a spooled response body to a user-chosen file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedBodyFile {
    pub path: String,
    pub size: u64,
}

/// Show an open dialog, then read the chosen file as UTF-8 text.
/// Cancelling the dialog is reported as `AppError::FileCancelled`.
pub async fn pick_and_read_text() -> Result<PickedFile, AppError> {
    tokio::task::spawn_blocking(|| {
        let Some(path) = rfd::FileDialog::new().pick_file() else {
            return Err(AppError::FileCancelled);
        };
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".into());
        let content = std::fs::read_to_string(&path).map_err(|_| {
            AppError::Storage(format!("无法以 UTF-8 文本读取: {}", path.display()))
        })?;
        Ok(PickedFile { name, content })
    })
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?
}

/// Pick one or more `.proto` files and read them as UTF-8 text. Paths are
/// returned because protox resolves `import` statements relative to them.
/// Cancelling the dialog is reported as `AppError::FileCancelled`.
pub async fn pick_proto_files() -> Result<Vec<GrpcFileRef>, AppError> {
    tokio::task::spawn_blocking(|| {
        let Some(paths) = rfd::FileDialog::new()
            .add_filter("Protocol Buffers", &["proto"])
            .pick_files()
        else {
            return Err(AppError::FileCancelled);
        };
        let mut files = Vec::new();
        for path in paths {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "file.proto".into());
            let content = std::fs::read_to_string(&path).map_err(|_| {
                AppError::Storage(format!("无法以 UTF-8 文本读取: {}", path.display()))
            })?;
            files.push(GrpcFileRef {
                name,
                path: path.display().to_string(),
                content,
            });
        }
        Ok(files)
    })
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?
}

/// Show a save dialog (with `file_name` pre-filled), then write UTF-8 text.
/// Returns the path the user actually chose.
pub async fn save_text(file_name: String, contents: String) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || {
        let Some(path) = rfd::FileDialog::new().set_file_name(&file_name).save_file()
        else {
            return Err(AppError::FileCancelled);
        };
        std::fs::write(&path, contents.as_bytes())
            .map_err(|_| AppError::Storage(format!("写入文件失败: {}", path.display())))?;
        Ok(path.display().to_string())
    })
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?
}

/// Copy a spooled body to `path` in bounded slices. The BodyStore holds raw
/// **decoded** bytes, so this stays binary-safe (unlike `save_text`, which is
/// UTF-8 only). Split out from the dialog so the copy is unit-testable.
pub fn write_body_to_path(store: &BodyStore, body_id: &str, path: &Path) -> Result<u64, AppError> {
    let info = store
        .info(body_id)?
        .ok_or_else(|| AppError::Storage("响应体缓存已失效，请重新发送后再下载".to_string()))?;
    let file = std::fs::File::create(path)
        .map_err(|error| AppError::Storage(format!("创建文件失败: {error}")))?;
    let mut writer = BufWriter::new(file);
    const SLICE: u64 = 2 * 1024 * 1024;
    let mut offset: u64 = 0;
    while offset < info.size {
        let bytes = store.read_range(body_id, offset, SLICE)?;
        if bytes.is_empty() {
            break;
        }
        writer
            .write_all(&bytes)
            .map_err(|error| AppError::Storage(format!("写入文件失败: {error}")))?;
        offset += bytes.len() as u64;
    }
    writer
        .flush()
        .map_err(|error| AppError::Storage(format!("写入文件失败: {error}")))?;
    Ok(offset)
}

/// "Send and download": copy a full spooled response body into a file the user
/// picks, without ever materialising it in the WebView. The dialog + copy run
/// on the blocking pool because rfd must not touch the macOS main thread.
pub async fn save_response_body(
    store: &BodyStore,
    body_id: &str,
    file_name: &str,
) -> Result<SavedBodyFile, AppError> {
    let store = store.clone();
    let body_id = body_id.to_string();
    let file_name = file_name.to_string();
    tokio::task::spawn_blocking(move || {
        // Fail fast when the spill was evicted, before prompting for a path.
        store.info(&body_id)?.ok_or_else(|| {
            AppError::Storage("响应体缓存已失效，请重新发送后再下载".to_string())
        })?;
        let Some(path) = rfd::FileDialog::new().set_file_name(&file_name).save_file()
        else {
            return Err(AppError::FileCancelled);
        };
        let size = write_body_to_path(&store, &body_id, &path)?;
        Ok(SavedBodyFile {
            path: path.display().to_string(),
            size,
        })
    })
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqora_core::service::body_store::CHUNK_BYTES;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(suffix: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("reqora-download-{nonce}-{suffix}"))
    }

    #[test]
    fn writes_spooled_binary_body_verbatim() {
        let db = temp_path("bodies.db");
        let out = temp_path("payload.bin");
        let store = BodyStore::new(&db).unwrap();
        // Two chunks straddle the CHUNK_BYTES boundary with non-UTF8 bytes.
        let mut payload = vec![0u8; 64 * 1024 + 37];
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte = (index % 251) as u8;
        }
        store.begin("body-1").unwrap();
        store
            .append_chunk("body-1", 0, &payload[..CHUNK_BYTES])
            .unwrap();
        store
            .append_chunk("body-1", 1, &payload[CHUNK_BYTES..])
            .unwrap();
        store
            .finish("body-1", payload.len() as u64, 1, "binary", "")
            .unwrap();

        let written = write_body_to_path(&store, "body-1", &out).unwrap();
        assert_eq!(written, payload.len() as u64);
        assert_eq!(std::fs::read(&out).unwrap(), payload);

        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&db);
        let _ = std::fs::remove_file(format!("{}-wal", db.display()));
        let _ = std::fs::remove_file(format!("{}-shm", db.display()));
    }
}
