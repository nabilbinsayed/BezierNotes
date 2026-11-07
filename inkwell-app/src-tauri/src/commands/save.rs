//! Saving into the PDF: writable-base selection (Plan 088), repair-only PDFium, and the save dialogs.

use super::*;

/// The save base for a freshly opened file: the bytes before our previous
/// generation when the file is exactly "base + one BezierNotes generation",
/// otherwise the whole file (see `inkwell_core::pdf::writable_base`).
pub(super) fn rebased_original(bytes: Arc<Vec<u8>>) -> Arc<Vec<u8>> {
    let base_len = inkwell_core::pdf::writable_base(&bytes).len();
    if base_len == bytes.len() {
        bytes
    } else {
        Arc::new(bytes[..base_len].to_vec())
    }
}

/// Open `bytes` for appending a BezierNotes generation.
///
/// Valid PDFs of every xref flavour (classic, xref streams, object streams,
/// linearized) open natively, so their original bytes survive as a prefix.
/// PDFium re-serialisation ("repair") runs only for files our parser cannot
/// read, and the caller is told so it can keep a backup and inform the user.
/// Encrypted files are refused outright: appending plaintext objects to them
/// corrupts them for every other reader.
pub(super) fn open_writable_base(state: &AppState, bytes: &[u8]) -> Result<(Option<Vec<u8>>, PdfFile), String> {
    match PdfFile::open(bytes.to_vec()) {
        Ok(f) => Ok((None, f)),
        Err(inkwell_core::pdfobj::Error::Encrypted) => Err(
            "This PDF is password-protected (encrypted). BezierNotes can't save ink into it yet \
             without breaking it for other apps."
                .to_string(),
        ),
        Err(e) => {
            eprintln!("[inkwell] Base PDF is damaged ({e}); repairing through PDFium");
            let pdfium_guard = state.pdfium.lock().unwrap();
            let pdfium = pdfium_guard
                .as_ref()
                .ok_or_else(|| format!("This PDF is damaged ({e}) and PDFium is unavailable to repair it."))?;
            let nb = inkwell_pdf::normalise(pdfium, bytes)
                .map_err(|norm_err| format!("Repairing the damaged PDF failed: {norm_err:?}"))?;
            let f = PdfFile::open(nb.clone())
                .map_err(|open_err| format!("The repaired PDF still cannot be read: {open_err}"))?;
            Ok((Some(nb), f))
        }
    }
}

/// `notes.pdf` -> `notes.orig.pdf`, next to it.
fn repair_backup_path(target: &Path) -> PathBuf {
    let stem = target.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "document".into());
    target.with_file_name(format!("{stem}.orig.pdf"))
}

#[tauri::command]
pub async fn save_pdf(
    out_path_str: Option<String>,
    images: Option<Vec<FrontendImage>>,
    strokes: Option<Vec<FrontendStroke>>,
    texts: Option<Vec<FrontendText>>,
    bookmarks: Option<Vec<inkwell_core::doc::Bookmark>>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<String, String> {
    apply_frontend_payload(state.inner(), images, strokes, texts, bookmarks)?;

    let doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_ref().ok_or("No document open")?;

    let mut orig_guard = state.original_pdf_bytes.lock().unwrap();
    let original_bytes = orig_guard.as_ref().ok_or("No original PDF loaded")?;

    let target_path = if let Some(p) = out_path_str {
        let path = PathBuf::from(&p);
        if p.contains("..") || path.components().any(|c| c == std::path::Component::ParentDir) {
            return Err("Path traversal components (..) are not permitted in save path".to_string());
        }
        let is_pdf = path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("pdf"))
            .unwrap_or(false);
        if !is_pdf {
            return Err("Invalid save path: destination file must have a .pdf extension".to_string());
        }
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                return Err(format!("Parent directory does not exist: {parent:?}"));
            }
        }
        path
    } else {
        state.pdf_path.lock().map_err(|e| format!("Lock error: {e}"))?.clone().ok_or("No target file path")?
    };

    // Open PDF and append vector ink layers, image annotations, and text annotations
    let (norm_bytes, mut pdf_file) = open_writable_base(state.inner(), original_bytes)?;

    // A repaired file no longer starts with the original bytes, so keep the
    // original once, beside the document, before the first repaired save.
    let repair_backup = if norm_bytes.is_some() {
        let backup = repair_backup_path(&target_path);
        if !backup.exists() {
            atomic_write(&backup, original_bytes)
                .map_err(|e| format!("Could not back up the original before repairing it ({backup:?}): {e}"))?;
        }
        Some(backup)
    } else {
        None
    };

    pdf_file.write_document(doc, inkwell_core::pdf::DEFAULT_GROUP)
        .map_err(|e| format!("Failed to write document annotations: {e}"))?;

    let final_bytes = pdf_file.finish();
    atomic_write(&target_path, &final_bytes)
        .map_err(|e| format!("Failed atomic save to {:?}: {e}", target_path))?;
    // Our own write must never be reported as an external modification.
    state.record_disk_stamp(&target_path);

    // Update in-memory state with the written PDF bytes
    if let Some(nb) = norm_bytes {
        *orig_guard = Some(Arc::new(nb));
    }
    drop(orig_guard);
    drop(doc_guard);
    *state.pdf_bytes.lock().unwrap() = Some(Arc::new(final_bytes));

    let is_save_as = {
        let current_path = state.pdf_path.lock().unwrap();
        current_path.as_ref() != Some(&target_path)
    };
    *state.pdf_path.lock().unwrap() = Some(target_path.clone());
    state.clear_page_caches();

    if is_save_as {
        if let Some(old_tx) = state.wal.lock().unwrap().take() {
            let (ack_tx, ack_rx) = std::sync::mpsc::sync_channel(1);
            let _ = old_tx.send(WalOp::Discard(Some(ack_tx)));
            let _ = ack_rx.recv_timeout(std::time::Duration::from_millis(500));
        }
        let wp = wal_path_for(&target_path);
        match Wal::open(&wp) {
            Ok(wal) => {
                let tx = init_wal_worker(wal);
                *state.wal.lock().unwrap() = Some(tx);
            }
            Err(e) => {
                eprintln!("[inkwell] WAL init failed for Save As ({wp:?}): {e}");
            }
        }
    }

    state.is_dirty.store(false, std::sync::atomic::Ordering::Relaxed);

    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        let (ack_tx, ack_rx) = std::sync::mpsc::sync_channel(1);
        let _ = tx.send(WalOp::Truncate(Some(ack_tx)));
        let _ = ack_rx.recv_timeout(std::time::Duration::from_secs(2));
    }

    if let Some(backup) = repair_backup {
        use tauri::Emitter;
        let _ = window.emit("pdf-repaired", backup.to_string_lossy().to_string());
    }

    Ok(target_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn save_pdf_dialog(
    images: Option<Vec<FrontendImage>>,
    strokes: Option<Vec<FrontendStroke>>,
    texts: Option<Vec<FrontendText>>,
    bookmarks: Option<Vec<inkwell_core::doc::Bookmark>>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let dialog_window = window.clone();
    let file_option = tauri::async_runtime::spawn_blocking(move || {
        dialog_window.dialog()
            .file()
            .add_filter("PDF Document", &["pdf"])
            .set_file_name("Untitled.pdf")
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Some(path) = file_option {
        let path_buf = path.into_path().map_err(|e| e.to_string())?;
        let path_str = path_buf.to_string_lossy().to_string();
        save_pdf(Some(path_str), images, strokes, texts, bookmarks, window, state).await
    } else {
        Err("CANCELLED".to_string())
    }
}
