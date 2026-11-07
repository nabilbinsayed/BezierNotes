//! Window chrome, stylus streaming, dirty flag, logging and PDFium status.

use super::*;

#[tauri::command]
pub async fn start_stylus_stream(
    channel: tauri::ipc::Channel<crate::stylus_linux::StylusMessage>,
) -> Result<(), String> {
    let is_running = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    crate::stylus_linux::spawn_stylus_worker(channel, is_running);
    Ok(())
}

#[tauri::command]
pub async fn force_close_window(app_handle: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Ok(mut wal_guard) = state.wal.lock() {
        if let Some(tx) = wal_guard.take() {
            let _ = tx.send(crate::state::WalOp::Close);
        }
    };
    app_handle.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn set_document_dirty(dirty: bool, state: State<'_, AppState>) -> Result<(), String> {
    state.is_dirty.store(dirty, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn log_frontend(msg: String) {
    eprintln!("[frontend] {msg}");
}

#[tauri::command]
pub fn get_initial_file() -> Option<String> {
    std::env::args().nth(1).filter(|p| !p.starts_with('-'))
}

#[tauri::command]
pub async fn minimize_window(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn toggle_maximize_window(window: tauri::Window) -> Result<(), String> {
    let is_max = window.is_maximized().map_err(|e| e.to_string())?;
    if is_max {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn close_window(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn check_pdfium_status(state: State<AppState>) -> bool {
    state.pdfium.lock().map(|guard| guard.is_some()).unwrap_or(false)
}
