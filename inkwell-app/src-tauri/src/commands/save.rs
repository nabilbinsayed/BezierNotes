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
#[allow(clippy::too_many_arguments)]
pub async fn save_pdf(
    out_path_str: Option<String>,
    images: Option<Vec<FrontendImage>>,
    strokes: Option<Vec<FrontendStroke>>,
    texts: Option<Vec<FrontendText>>,
    bookmarks: Option<Vec<inkwell_core::doc::Bookmark>>,
    journal_seq: Option<u64>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let target_override = out_path_str.map(|p| validate_save_path(&p)).transpose()?;
    // Numbered before queueing: a later save always supersedes this one.
    let generation = state.save_generation.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1;

    // Writing a large PDF takes a while; doing it on a Tokio worker stalled
    // every other IPC that needed one (Plan 090). The whole save runs on the
    // blocking pool instead, under `save_lock` from snapshot to publish.
    let app = { use tauri::Manager; window.app_handle().clone() };
    let payload = (images, strokes, texts, bookmarks);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        save_blocking(&state, generation, target_override, payload, journal_seq)
    })
    .await
    .map_err(|e| format!("Save task failed: {e}"))??;

    if let Some(backup) = outcome.repair_backup {
        use tauri::Emitter;
        let _ = window.emit("pdf-repaired", backup.to_string_lossy().to_string());
    }
    Ok(outcome.path.to_string_lossy().to_string())
}

struct SaveOutcome {
    path: PathBuf,
    repair_backup: Option<PathBuf>,
}

type SavePayload = (
    Option<Vec<FrontendImage>>,
    Option<Vec<FrontendStroke>>,
    Option<Vec<FrontendText>>,
    Option<Vec<inkwell_core::doc::Bookmark>>,
);

fn validate_save_path(p: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(p);
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
    Ok(path)
}

fn save_blocking(
    state: &AppState,
    generation: u64,
    target_override: Option<PathBuf>,
    payload: SavePayload,
    journal_seq: Option<u64>,
) -> Result<SaveOutcome, String> {
    use std::sync::atomic::Ordering;
    let _save_guard = state.save_lock.lock().map_err(|e| format!("Lock error: {e}"))?;

    let target_path = match target_override {
        Some(p) => p,
        None => state.pdf_path.lock().map_err(|e| format!("Lock error: {e}"))?.clone().ok_or("No target file path")?,
    };
    // A newer save was queued while this one waited: it carries a newer
    // payload, so applying and writing this one would only go backwards.
    if state.save_generation.load(Ordering::Acquire) != generation {
        return Ok(SaveOutcome { path: target_path, repair_backup: None });
    }

    let (images, strokes, texts, bookmarks) = payload;
    apply_frontend_payload(state, images, strokes, texts, bookmarks)?;

    // Snapshot, then release the document so inking (commit_stroke) never
    // waits on PDF generation.
    let doc = state.doc.lock().unwrap().clone().ok_or("No document open")?;
    let original_bytes = state.original_pdf_bytes.lock().unwrap().clone().ok_or("No original PDF loaded")?;

    // Open PDF and append vector ink layers, image annotations, and text annotations
    let (norm_bytes, mut pdf_file) = open_writable_base(state, &original_bytes)?;

    // A repaired file no longer starts with the original bytes, so keep the
    // original once, beside the document, before the first repaired save.
    let repair_backup = if norm_bytes.is_some() {
        let backup = repair_backup_path(&target_path);
        if !backup.exists() {
            atomic_write(&backup, &original_bytes)
                .map_err(|e| format!("Could not back up the original before repairing it ({backup:?}): {e}"))?;
        }
        Some(backup)
    } else {
        None
    };

    pdf_file.write_document(&doc, inkwell_core::pdf::DEFAULT_GROUP)
        .map_err(|e| format!("Failed to write document annotations: {e}"))?;

    let final_bytes = pdf_file.finish();
    atomic_write(&target_path, &final_bytes)
        .map_err(|e| format!("Failed atomic save to {:?}: {e}", target_path))?;
    // Our own write must never be reported as an external modification.
    state.record_disk_stamp(&target_path);
    // Earlier interrupted saves may have left temps in the (synced) folder.
    let swept = inkwell_core::wal::sweep_orphan_temps(&target_path, std::time::Duration::from_secs(60));
    if swept > 0 {
        eprintln!("[inkwell] Removed {swept} orphaned save temp file(s) next to {target_path:?}");
    }

    // Update in-memory state with the written PDF bytes
    if let Some(nb) = norm_bytes {
        *state.original_pdf_bytes.lock().unwrap() = Some(Arc::new(nb));
    }
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

    // Trim only what this snapshot covers: edits journalled while the save
    // ran stay in the journal, and the document stays dirty for them.
    let snapshot_seq = journal_seq.unwrap_or_else(|| state.journal_seq_hi.load(Ordering::Acquire));
    state.is_dirty.store(state.journal_seq_hi.load(Ordering::Acquire) > snapshot_seq, Ordering::Relaxed);
    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        let (ack_tx, ack_rx) = std::sync::mpsc::sync_channel(1);
        let op = match journal_seq {
            Some(s) => WalOp::TruncateThrough(s, Some(ack_tx)),
            None => WalOp::Truncate(Some(ack_tx)),
        };
        let _ = tx.send(op);
        let _ = ack_rx.recv_timeout(std::time::Duration::from_secs(2));
    }

    Ok(SaveOutcome { path: target_path, repair_backup })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn save_pdf_dialog(
    images: Option<Vec<FrontendImage>>,
    strokes: Option<Vec<FrontendStroke>>,
    texts: Option<Vec<FrontendText>>,
    bookmarks: Option<Vec<inkwell_core::doc::Bookmark>>,
    journal_seq: Option<u64>,
    default_name: Option<String>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let dialog_window = window.clone();
    let file_name = default_name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "Untitled.pdf".to_string());
    let file_option = tauri::async_runtime::spawn_blocking(move || {
        dialog_window.dialog()
            .file()
            .add_filter("PDF Document", &["pdf"])
            .set_file_name(&file_name)
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Some(path) = file_option {
        let path_buf = path.into_path().map_err(|e| e.to_string())?;
        let path_str = path_buf.to_string_lossy().to_string();
        save_pdf(Some(path_str), images, strokes, texts, bookmarks, journal_seq, window, state).await
    } else {
        Err("CANCELLED".to_string())
    }
}

#[cfg(test)]
mod save_pipeline_tests {
    use super::*;
    use inkwell_core::ink::{IdGen, StrokeBuilder};

    fn fixture() -> Vec<u8> {
        std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../inkwell/fixtures/lecture.pdf")).expect("fixture")
    }

    fn stroke(id: u128) -> Stroke {
        let mut b = StrokeBuilder::new(id, ToolKind::Pen, [0.0, 0.0, 0.0], Brush::default(), false);
        for k in 0..20 {
            b.push(80.0 + k as f64 * 5.0, 100.0, 0.5, k as f64);
        }
        b.finish(0.0)
    }

    /// A session on a temp copy of the fixture, journalling to a temp file
    /// (never the real per-user journal directory).
    fn session(dir: &Path) -> (AppState, PathBuf, PathBuf) {
        let target = dir.join("notes.pdf");
        let bytes = fixture();
        std::fs::write(&target, &bytes).unwrap();
        let state = AppState::default();
        *state.doc.lock().unwrap() = Some(Document::for_pdf(1));
        *state.original_pdf_bytes.lock().unwrap() = Some(Arc::new(bytes.clone()));
        *state.pdf_bytes.lock().unwrap() = Some(Arc::new(bytes));
        *state.pdf_path.lock().unwrap() = Some(target.clone());
        let journal = dir.join("journal.bin");
        *state.wal.lock().unwrap() = Some(init_wal_worker(Wal::open(&journal).unwrap()));
        (state, target, journal)
    }

    #[test]
    fn save_trims_only_the_journal_its_snapshot_covers() {
        let dir = tempfile::tempdir().unwrap();
        let (state, target, journal) = session(dir.path());
        let mut ids = IdGen::seeded(90);
        {
            let tx = state.wal.lock().unwrap().clone().unwrap();
            for seq in 1..=3u64 {
                let s = stroke(ids.next_id());
                state.doc.lock().unwrap().as_mut().unwrap().push_stroke(0, s.clone());
                tx.send(WalOp::Append(WalEntry::Added { sheet: 0, stroke: s }, seq)).unwrap();
            }
        }
        state.journal_seq_hi.store(3, std::sync::atomic::Ordering::Release);
        let generation = state.save_generation.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1;

        // The snapshot reflects edits up to seq 2; edit 3 arrived mid-save.
        save_blocking(&state, generation, None, (None, None, None, None), Some(2)).expect("save");

        let saved = std::fs::read(&target).unwrap();
        assert!(saved.starts_with(&fixture()), "original bytes preserved");
        assert!(matches!(inkwell_core::pdf::read_sidecar(&saved).unwrap(), SidecarStatus::Ok(_)));
        let left = Wal::replay(&journal).unwrap();
        assert_eq!(left.len(), 1, "only the edit after the snapshot stays journalled");
        assert!(state.is_dirty.load(std::sync::atomic::Ordering::Acquire), "still dirty for edit 3");
    }

    #[test]
    fn a_superseded_save_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (state, target, _journal) = session(dir.path());
        let before = std::fs::read(&target).unwrap();
        state.save_generation.store(5, std::sync::atomic::Ordering::Release);
        save_blocking(&state, 4, None, (None, None, None, None), Some(0)).expect("superseded save is not an error");
        assert_eq!(std::fs::read(&target).unwrap(), before, "an older snapshot must not reach disk");
    }
}
