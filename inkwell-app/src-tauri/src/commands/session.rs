//! Multi-document sessions and the external-change guard.

use super::*;

#[tauri::command]
pub async fn switch_document_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut active_id_guard = state.active_session_id.lock().unwrap();
    let mut sessions_guard = state.sessions.lock().unwrap();

    if let Some(ref current_id) = *active_id_guard {
        if current_id == &session_id {
            return Ok(true);
        }
        if let Some(session) = sessions_guard.get_mut(current_id) {
            if let Some(doc) = state.doc.lock().unwrap().take() {
                session.doc = doc;
            }
            session.pdf_path = state.pdf_path.lock().unwrap().clone();
            session.pdf_bytes = state.pdf_bytes.lock().unwrap().clone();
            session.original_pdf_bytes = state.original_pdf_bytes.lock().unwrap().clone();
            session.wal = state.wal.lock().unwrap().take();
            std::mem::swap(&mut session.page_bitmap_cache, &mut *state.page_bitmap_cache.lock().unwrap());
            if let Ok(mut text_cache) = state.page_text_cache.lock() {
                text_cache.clear();
            }
            std::mem::swap(&mut session.page_dimensions, &mut *state.page_dimensions.lock().unwrap());
        }
    }

    if let Some(target) = sessions_guard.get_mut(&session_id) {
        *state.doc.lock().unwrap() = Some(target.doc.clone());
        *state.pdf_path.lock().unwrap() = target.pdf_path.clone();
        *state.pdf_bytes.lock().unwrap() = target.pdf_bytes.clone();
        *state.original_pdf_bytes.lock().unwrap() = target.original_pdf_bytes.clone();
        *state.wal.lock().unwrap() = target.wal.take();
        std::mem::swap(&mut target.page_bitmap_cache, &mut *state.page_bitmap_cache.lock().unwrap());
        if let Ok(mut text_cache) = state.page_text_cache.lock() {
            text_cache.clear();
        }
        std::mem::swap(&mut target.page_dimensions, &mut *state.page_dimensions.lock().unwrap());
        *active_id_guard = Some(session_id);
        Ok(true)
    } else {
        *active_id_guard = Some(session_id);
        Ok(false)
    }
}

#[tauri::command]
pub async fn close_document_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut sessions_guard = state.sessions.lock().unwrap();
    if let Some(mut session) = sessions_guard.remove(&session_id) {
        if let Some(tx) = session.wal.take() {
            let _ = tx.send(crate::state::WalOp::Close);
        }
    }
    let mut active_id_guard = state.active_session_id.lock().unwrap();
    if active_id_guard.as_ref() == Some(&session_id) {
        *active_id_guard = None;
    }
    Ok(true)
}

/// Report whether the open document's backing file changed on disk (cloud sync,
/// another editor, git checkout). The stamp is refreshed on detection so a
/// single external change only prompts once.
#[tauri::command]
pub fn check_external_file_change(state: State<'_, AppState>) -> Result<bool, String> {
    let path = state
        .pdf_path
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?
        .clone();
    let Some(path) = path else {
        return Ok(false);
    };
    let Some(current) = disk_stamp_for(&path) else {
        return Ok(false);
    };

    let mut guard = state
        .doc_disk_stamp
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    match *guard {
        Some(previous) if previous != current => {
            *guard = Some(current);
            Ok(true)
        }
        None => {
            *guard = Some(current);
            Ok(false)
        }
        _ => Ok(false),
    }
}
