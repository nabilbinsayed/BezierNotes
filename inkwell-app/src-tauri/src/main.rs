// Inkwell production Tauri host.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod device;
mod diagnostics;
mod updates;
mod state;
mod stylus_linux;

use state::AppState;

fn main() {
    // WebView2 tuning, Windows only. Must be set before the webview starts.
    #[cfg(target_os = "windows")]
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--disable-features=CalculateNativeWinOcclusion,TouchpadOverscrollHistoryNavigation,OverscrollHistoryNavigation \
         --enable-features=CanvasOopRasterization \
         --enable-gpu-rasterization \
         --enable-zero-copy \
         --disable-renderer-backgrounding \
         --disable-backgrounding-occluded-windows \
         --disable-background-timer-throttling",
    );

    // Linux Wayland & GTK tuning for Hyprland and modern compositors
    #[cfg(target_os = "linux")]
    {
        if std::env::var("GDK_BACKEND").is_err() {
            std::env::set_var("GDK_BACKEND", "wayland,x11");
        }
    }

    // Initialize PDFium once at startup and store in AppState.
    // All commands that need PDFium will borrow this cached instance.
    let app_state = AppState::default();
    match inkwell_pdf::init_pdfium() {
        Ok(pdfium) => {
            eprintln!("[inkwell] PDFium initialized successfully at startup.");
            *app_state.pdfium.lock().unwrap() = Some(pdfium);
        }
        Err(e) => {
            eprintln!(
                "[inkwell] WARNING: PDFium failed to initialize at startup: {e:?}\n\
                 PDF rendering will not work. Ensure pdfium.dll is next to the executable."
            );
        }
    }

    // Panics go to the local crash log (Plan 098) before the default report.
    diagnostics::install_panic_hook();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .setup(|app| {
            use tauri::Manager;
            updates::init(app.handle());
            let state = app.state::<AppState>();
            match app.path().app_config_dir().map_err(|e| e.to_string()).and_then(|dir| device::load_or_create(&dir)) {
                Ok(me) => *state.device.lock().unwrap() = me,
                // Keeps the per-launch identity from AppState::default: files
                // still save, they just look like they came from a new device.
                Err(e) => eprintln!("[inkwell] WARNING: could not load or store this device's identity: {e}"),
            }
            let mut pdfium_guard = state.pdfium.lock().unwrap();
            if pdfium_guard.is_none() {
                if let Ok(res_dir) = app.path().resource_dir() {
                    match inkwell_pdf::init_pdfium_from_dir(&res_dir) {
                        Ok(pdfium) => {
                            eprintln!("[inkwell] PDFium initialized successfully from resource dir: {res_dir:?}");
                            *pdfium_guard = Some(pdfium);
                        }
                        Err(e) => {
                            eprintln!("[inkwell] Could not initialize PDFium from resource dir {res_dir:?}: {e:?}");
                        }
                    }
                }
            }
            if pdfium_guard.is_none() {
                if let Ok(app_dir) = app.path().app_local_data_dir() {
                    if let Ok(pdfium) = inkwell_pdf::init_pdfium_from_dir(&app_dir) {
                        eprintln!("[inkwell] PDFium initialized successfully from app local data dir: {app_dir:?}");
                        *pdfium_guard = Some(pdfium);
                    }
                }
            }
            if pdfium_guard.is_none() {
                eprintln!("[inkwell] WARNING: PDFium shared library could not be located in any standard paths. PDF rendering will be unavailable until PDFium binary is supplied.");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                use tauri::Manager;
                let app_state = window.state::<AppState>();
                let is_dirty = app_state.is_dirty.load(std::sync::atomic::Ordering::Relaxed);
                if is_dirty {
                    use tauri::Emitter;
                    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
                    api.prevent_close();
                    let window_clone = window.clone();
                    // Native, so quitting still works if the page's JS is broken.
                    // Cancel / Esc / closing the dialog = keep working (Plan 090).
                    window.app_handle().dialog()
                        .message("Save your changes before quitting?\n\nIf you don't save, your changes are set aside and offered back the next time you open this file.")
                        .title("Save Changes?")
                        .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
                        .buttons(MessageDialogButtons::YesNoCancelCustom(
                            "Save".into(),
                            "Don't Save".into(),
                            "Cancel".into(),
                        ))
                        .show_with_result(move |choice| match choice {
                            MessageDialogResult::Yes => {
                                let _ = window_clone.emit("app-save-and-close", ());
                            }
                            MessageDialogResult::Custom(label) if label == "Save" => {
                                let _ = window_clone.emit("app-save-and-close", ());
                            }
                            MessageDialogResult::No => quit_without_saving(&window_clone),
                            MessageDialogResult::Custom(label) if label == "Don't Save" => {
                                quit_without_saving(&window_clone)
                            }
                            _ => {}
                        });
                } else {
                    let _ = app_state.wal.lock().map(|mut g| {
                        if let Some(tx) = g.take() {
                            let _ = tx.send(crate::state::WalOp::Close);
                        }
                    });
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::open::open_pdf,
            commands::open::open_pdf_dialog,
            commands::open::open_pdf_bytes,
            commands::open::create_blank_document,
            commands::render::render_tile,
            commands::render::prefetch_page,
            commands::ink::commit_stroke,
            commands::ink::delete_stroke,
            commands::ink::erase_strokes_near,
            commands::ink::erase_strokes_in_rect,
            commands::session::check_external_file_change,
            commands::save::save_pdf,
            commands::merge::find_conflict_siblings,
            commands::ink::journal_shape_mutation,
            commands::forms::get_form_fields,
            diagnostics::log_frontend_error,
            diagnostics::open_logs_folder,
            diagnostics::diagnostic_info,
            updates::check_for_update,
            updates::install_update,
            commands::pages::add_canvas_page,
            commands::forms::set_form_value,
            commands::merge::preview_merge,
            commands::merge::apply_merge,
            commands::merge::trash_conflict_copy,
            commands::save::save_pdf_dialog,
            commands::export::export_pdf_custom,
            commands::export::export_pdf_custom_dialog,
            commands::ink::get_document_info,
            commands::pages::insert_blank_page,
            commands::text::search_pdf,
            commands::text::get_page_text_spans,
            commands::text::get_page_text_data,
            commands::text::get_pdf_outline,
            commands::session::switch_document_session,
            commands::session::close_document_session,
            commands::pages::delete_page,
            commands::pages::duplicate_page,
            commands::pages::rotate_page,
            commands::pages::reorder_page,
            commands::ink::journal_image_mutation,
            commands::ink::journal_text_mutation,
            commands::window::start_stylus_stream,
            commands::window::force_close_window,
            commands::window::set_document_dirty,
            commands::window::log_frontend,
            commands::window::get_initial_file,
            commands::window::minimize_window,
            commands::window::toggle_maximize_window,
            commands::window::close_window,
            commands::window::check_pdfium_status,
            commands::window::autosave_tick,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Inkwell");
}


/// "Don't Save": keep the unsaved work recoverable instead of deleting it.
/// The journal is set aside (closed and renamed) and the next open of the
/// file offers to restore it.
fn quit_without_saving(window: &tauri::Window) {
    use tauri::Manager;
    let state = window.state::<AppState>();
    if let Ok(mut g) = state.wal.lock() {
        if let Some(tx) = g.take() {
            let (ack_tx, ack_rx) = std::sync::mpsc::sync_channel(1);
            let _ = tx.send(crate::state::WalOp::Shelve(Some(ack_tx)));
            let _ = ack_rx.recv_timeout(std::time::Duration::from_secs(2));
        }
    }
    window.app_handle().exit(0);
}
