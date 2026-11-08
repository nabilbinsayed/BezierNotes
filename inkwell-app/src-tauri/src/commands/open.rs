//! Opening documents: file dialog, path, bytes, blank whiteboard, and WAL crash replay.

use super::*;

#[tauri::command]
pub async fn open_pdf_dialog(window: tauri::Window, state: State<'_, AppState>) -> Result<(String, OpenPdfResult), String> {
    let file_option = tauri::async_runtime::spawn_blocking(move || {
        window.dialog()
            .file()
            .add_filter("PDF Document", &["pdf"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Some(path) = file_option {
        let path_buf = path.into_path().map_err(|e| e.to_string())?;
        let path_str = path_buf.to_string_lossy().to_string();
        let result = open_pdf(path_str.clone(), None, state).await?;
        Ok((path_str, result))
    } else {
        Err("CANCELLED".to_string())
    }
}

fn replay_wal_journal(
    path: &Path,
    doc: &mut Document,
    page_infos: &mut Vec<PageInfo>,
) -> (usize, usize, usize, Vec<FrontendImage>, Vec<FrontendText>) {
    let wp = wal_path_for(path);
    let mut recovered_strokes = 0usize;
    let mut recovered_images = 0usize;
    let mut recovered_texts = 0usize;
    let mut images_map: std::collections::HashMap<String, FrontendImage> = std::collections::HashMap::new();
    let mut texts_map: std::collections::HashMap<String, FrontendText> = std::collections::HashMap::new();

    if let Ok(entries) = Wal::replay(&wp) {
        if !entries.is_empty() {
            eprintln!("[inkwell] Replaying {} WAL entries for {:?}", entries.len(), path);
            for entry in entries {
                match entry {
                    WalEntry::Added { sheet, stroke } => {
                        // Idempotent: a record a save already covered (kept
                        // because it arrived mid-save) replaces, never duplicates.
                        doc.remove_stroke(stroke.id);
                        doc.push_stroke(sheet, stroke);
                        recovered_strokes += 1;
                    }
                    WalEntry::Removed(id) => {
                        doc.remove_stroke(id);
                    }
                    WalEntry::PageInserted { index, width_pt, height_pt } => {
                        doc.insert_sheet(index);
                        let clamped = index.min(page_infos.len());
                        page_infos.insert(clamped, PageInfo {
                            page_index: clamped,
                            width_pt,
                            height_pt,
                            template: None,
                        });
                        for (i, p) in page_infos.iter_mut().enumerate() {
                            p.page_index = i;
                        }
                    }
                    WalEntry::PageDeleted { index } => {
                        if index < doc.sheets.len() && doc.sheets.len() > 1 {
                            doc.sheets.remove(index);
                            if index < page_infos.len() {
                                page_infos.remove(index);
                                for (i, p) in page_infos.iter_mut().enumerate() {
                                    p.page_index = i;
                                }
                            }
                        }
                    }
                    WalEntry::PageReordered { from_index, to_index } => {
                        if from_index < doc.sheets.len() && to_index < doc.sheets.len() && from_index != to_index {
                            let sheet = doc.sheets.remove(from_index);
                            doc.sheets.insert(to_index, sheet);
                            if from_index < page_infos.len() && to_index < page_infos.len() {
                                let p = page_infos.remove(from_index);
                                page_infos.insert(to_index, p);
                                for (i, p) in page_infos.iter_mut().enumerate() {
                                    p.page_index = i;
                                }
                            }
                        }
                    }
                    WalEntry::PageRotated { index, clockwise } => {
                        let (orig_w, orig_h) = if let Some(pi) = page_infos.get_mut(index) {
                            let w = pi.width_pt;
                            let h = pi.height_pt;
                            std::mem::swap(&mut pi.width_pt, &mut pi.height_pt);
                            (w, h)
                        } else {
                            (595.0, 842.0)
                        };
                        if let Some(sheet) = doc.sheets.get_mut(index) {
                            for l in &mut sheet.layers {
                                for s in &mut l.strokes {
                                    for sample in &mut s.samples {
                                        if clockwise {
                                            let old_x = sample.x;
                                            let old_y = sample.y;
                                            sample.x = orig_h - old_y;
                                            sample.y = old_x;
                                        } else {
                                            let old_x = sample.x;
                                            let old_y = sample.y;
                                            sample.x = old_y;
                                            sample.y = orig_w - old_x;
                                        }
                                    }
                                }
                            }
                            for img in &mut sheet.images {
                                let old_x = img.x;
                                let old_y = img.y;
                                let old_w = img.width;
                                let old_h = img.height;
                                if clockwise {
                                    img.x = orig_h - old_y - old_h;
                                    img.y = old_x;
                                    img.width = old_h;
                                    img.height = old_w;
                                } else {
                                    img.x = old_y;
                                    img.y = orig_w - old_x - old_w;
                                    img.width = old_h;
                                    img.height = old_w;
                                }
                            }
                            for txt in &mut sheet.text_objects {
                                let old_x = txt.x;
                                let old_y = txt.y;
                                let old_w = txt.width;
                                let old_h = txt.height;
                                if clockwise {
                                    txt.x = orig_h - old_y - old_h;
                                    txt.y = old_x;
                                    txt.width = old_h;
                                    txt.height = old_w;
                                } else {
                                    txt.x = old_y;
                                    txt.y = orig_w - old_x - old_w;
                                    txt.width = old_h;
                                    txt.height = old_w;
                                }
                            }
                        }
                    }
                    WalEntry::ImageAdded { sheet, id, x, y, width, height, data_url } => {
                        doc.push_image(sheet, inkwell_core::doc::ImageObject {
                            id: id.clone(),
                            sheet,
                            x,
                            y,
                            width,
                            height,
                            data_url: data_url.clone(),
                        });
                        images_map.insert(id.clone(), FrontendImage { id, sheet, x, y, width, height, data_url });
                        recovered_images += 1;
                    }
                    WalEntry::ImageRemoved { id } => {
                        doc.remove_image(&id);
                        images_map.remove(&id);
                    }
                    WalEntry::TextUpsert { sheet, id, x, y, text, font_size, color, bold, italic, width, height } => {
                        doc.upsert_text(sheet, inkwell_core::doc::TextObject {
                            id: id.clone(),
                            sheet,
                            x,
                            y,
                            text: text.clone(),
                            font_size,
                            color: color.clone(),
                            bold,
                            italic,
                            width,
                            height,
                        });
                        texts_map.insert(id.clone(), FrontendText { id, sheet, x, y, text, font_size, color, bold, italic, width, height });
                        recovered_texts += 1;
                    }
                    WalEntry::TextRemoved { id } => {
                        doc.remove_text(&id);
                        texts_map.remove(&id);
                    }
                }
            }
        }
    }

    let wal_images: Vec<FrontendImage> = doc.sheets.iter().enumerate().flat_map(|(s_idx, s)| {
        s.images.iter().filter(|im| images_map.contains_key(&im.id)).map(move |img| FrontendImage {
            id: img.id.clone(),
            sheet: s_idx,
            x: img.x,
            y: img.y,
            width: img.width,
            height: img.height,
            data_url: img.data_url.clone(),
        })
    }).collect();

    let wal_texts: Vec<FrontendText> = doc.sheets.iter().enumerate().flat_map(|(s_idx, s)| {
        s.text_objects.iter().filter(|tx| texts_map.contains_key(&tx.id)).map(move |txt| FrontendText {
            id: txt.id.clone(),
            sheet: s_idx,
            x: txt.x,
            y: txt.y,
            text: txt.text.clone(),
            font_size: txt.font_size,
            color: txt.color.clone(),
            bold: txt.bold,
            italic: txt.italic,
            width: txt.width,
            height: txt.height,
        })
    }).collect();

    (
        recovered_strokes,
        recovered_images,
        recovered_texts,
        wal_images,
        wal_texts,
    )
}

#[tauri::command]
pub async fn open_pdf(
    path_str: String,
    restore_shelved: Option<bool>,
    state: State<'_, AppState>,
) -> Result<OpenPdfResult, String> {
    let open_started = Instant::now();
    let path = PathBuf::from(&path_str);
    if path_str.contains("..") || path.components().any(|c| c == std::path::Component::ParentDir) {
        return Err("Path traversal components (..) are not permitted in open path".to_string());
    }
    if !path.exists() || !path.is_file() {
        return Err(format!("File does not exist: {path:?}"));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read PDF file: {e}"))?;
    // Temps from saves that were killed mid-write sit in the (synced) folder.
    inkwell_core::wal::sweep_orphan_temps(&path, std::time::Duration::from_secs(60));

    // A journal set aside by "Don't Save" is offered back, never replayed
    // silently; on "Restore" the frontend reopens with restore_shelved.
    let shelved = shelved_wal_path(&wal_path_for(&path));
    let shelved_journal_entries = if restore_shelved.unwrap_or(false) {
        restore_shelved_journal(&path, &shelved)?;
        0
    } else {
        Wal::replay(&shelved).map(|e| e.len()).unwrap_or(0)
    };

    let arc_bytes = Arc::new(bytes);
    let (mut page_infos, outline) = extract_pdf_meta(&arc_bytes, &state);
    let n_pages = page_infos.len();

    let mut doc = match inkwell_core::pdf::read_sidecar(&arc_bytes) {
        Ok(SidecarStatus::Ok(d)) | Ok(SidecarStatus::Stale(d)) => {
            eprintln!("[inkwell] Loaded sidecar with {} strokes from {:?}", d.stroke_count(), path);
            let mut d = d;
            while d.sheets.len() < n_pages {
                d.sheets.push(inkwell_core::doc::Sheet::bounded(d.sheets.len()));
            }
            d
        }
        _ => Document::for_pdf(n_pages),
    };
    // Before the journal replays: page ids are identity, not an edit.
    if doc.sheets.iter().any(|s| s.page_id == 0) {
        doc.assign_base_page_ids(&inkwell_core::pdf::base_fingerprint(&arc_bytes));
    }

    for (i, pi) in page_infos.iter_mut().enumerate() {
        if let Some(sheet) = doc.sheets.get(i) {
            if let Some(ref t) = sheet.template {
                pi.template = Some(t.clone());
            } else if let Some(t_img) = sheet.images.iter().find(|im| im.id.starts_with("template_bg_") || im.id.starts_with("img_template_bg_")) {
                let parts: Vec<&str> = t_img.id.split('_').collect();
                if parts.len() >= 4 {
                    pi.template = Some(parts[3..].join("_"));
                } else {
                    pi.template = Some("dark".to_string());
                }
            }
        }
    }

    // Replay WAL entries if journal exists from a previous crash
    let (recovered_strokes, recovered_images, recovered_texts, wal_images, wal_texts) =
        replay_wal_journal(&path, &mut doc, &mut page_infos);

    let mut loaded_images = extract_frontend_images(&doc);
    let mut loaded_texts = extract_frontend_texts(&doc);

    for w_img in wal_images {
        if !loaded_images.iter().any(|im| im.id == w_img.id) {
            loaded_images.push(w_img);
        }
    }
    for w_txt in wal_texts {
        if let Some(pos) = loaded_texts.iter().position(|t| t.id == w_txt.id) {
            loaded_texts[pos] = w_txt;
        } else {
            loaded_texts.push(w_txt);
        }
    }

    let loaded_strokes = extract_frontend_strokes(&doc);
    let doc_bookmarks = doc.bookmarks.clone();

    *state.doc.lock().unwrap() = Some(doc);
    *state.pdf_path.lock().unwrap() = Some(path.clone());
    *state.pdf_bytes.lock().unwrap() = Some(arc_bytes.clone());
    *state.original_pdf_bytes.lock().unwrap() = Some(rebased_original(arc_bytes));
    state.clear_page_caches();
    state.record_disk_stamp(&path);

    if let Ok(mut dim_guard) = state.page_dimensions.lock() {
        dim_guard.clear();
        for pi in &page_infos {
            dim_guard.insert(pi.page_index as u32, (pi.width_pt, pi.height_pt));
        }
    }

    // Open WAL in temp dir (not the synced folder).
    let wp = wal_path_for(&path);
    if let Some(old_tx) = state.wal.lock().unwrap().take() {
        let _ = old_tx.send(WalOp::Close);
    }
    match Wal::open(&wp) {
        Ok(wal) => {
            let tx = init_wal_worker(wal);
            *state.wal.lock().unwrap() = Some(tx);
        }
        Err(e) => { eprintln!("[inkwell] WAL init failed ({wp:?}): {e}"); }
    }

    eprintln!("[inkwell] Opened PDF: {:?} — {} pages, {} loaded strokes, {} loaded images, {} loaded texts, {} outline nodes in {} ms", path, n_pages, loaded_strokes.len(), loaded_images.len(), loaded_texts.len(), outline.len(), open_started.elapsed().as_millis());
    Ok(OpenPdfResult {
        page_infos,
        recovered_strokes,
        recovered_images,
        recovered_texts,
        loaded_strokes,
        loaded_images,
        loaded_texts,
        outline,
        bookmarks: doc_bookmarks,
        shelved_journal_entries,
    })
}

#[tauri::command]
pub async fn create_blank_document(
    title: Option<String>,
    width_pt: Option<f64>,
    height_pt: Option<f64>,
    state: State<'_, AppState>,
) -> Result<OpenPdfResult, String> {
    // A brand-new board has no user file yet: forget any previous on-disk stamp
    // so a stale path can never trigger the external-change banner.
    state.clear_disk_stamp();
    let doc_title = title.unwrap_or_else(|| "Untitled Whiteboard.pdf".to_string());
    let w = width_pt.unwrap_or(841.89);
    let h = height_pt.unwrap_or(595.28);
    if !w.is_finite() || !h.is_finite() || w < 72.0 || h < 72.0 || w > 14400.0 || h > 14400.0 {
        return Err(format!("Invalid whiteboard dimensions: {w} x {h} pt (must be between 72 and 14400)"));
    }

    let pdf_bytes = {
        let pdfium_guard = state.pdfium.lock().unwrap();
        if let Some(pdfium) = pdfium_guard.as_ref() {
            use pdfium_render::prelude::*;
            let mut doc = pdfium.create_new_pdf().map_err(|e| e.to_string())?;
            doc.pages_mut().create_page_at_index(
                PdfPagePaperSize::Custom(PdfPoints::new(w as f32), PdfPoints::new(h as f32)),
                0,
            ).map_err(|e| e.to_string())?;
            doc.save_to_bytes().map_err(|e| e.to_string())?
        } else {
            let header = "%PDF-1.7\n";
            let obj1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
            let obj2 = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
            let obj3 = format!(
                "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.2} {:.2}] /Resources <<>> >>\nendobj\n",
                w, h
            );
            let off1 = header.len();
            let off2 = off1 + obj1.len();
            let off3 = off2 + obj2.len();
            let startxref = off3 + obj3.len();
            let xref_and_trailer = format!(
                "xref\n0 4\n0000000000 65535 f \n{:010} 00000 n \n{:010} 00000 n \n{:010} 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
                off1, off2, off3, startxref
            );
            format!("{header}{obj1}{obj2}{obj3}{xref_and_trailer}").into_bytes()
        }
    };

    open_pdf_bytes(doc_title, pdf_bytes, state).await
}

#[tauri::command]
pub async fn open_pdf_bytes(name: String, bytes: Vec<u8>, state: State<'_, AppState>) -> Result<OpenPdfResult, String> {
    let open_started = Instant::now();
    // Derive a stable temp-file name from the content so different PDFs that
    // happen to share a file name get distinct WAL journals (and re-opening the
    // same dropped file still recovers its crash journal).
    let h = hash_bytes_fnv1a(&bytes[..bytes.len().min(8192)]);
    let clean_name = Path::new(&name)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.chars().filter(|c| c.is_alphanumeric() || *c == '.' || *c == '-' || *c == '_').collect::<String>())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "document.pdf".to_string());
    let path = std::env::temp_dir().join(format!("inkwell-{:016x}-{}", h, clean_name));
    let _ = std::fs::write(&path, &bytes);

    let arc_bytes = Arc::new(bytes);
    let (mut page_infos, outline) = extract_pdf_meta(&arc_bytes, &state);
    let n_pages = page_infos.len();

    let mut doc = match inkwell_core::pdf::read_sidecar(&arc_bytes) {
        Ok(SidecarStatus::Ok(d)) | Ok(SidecarStatus::Stale(d)) => {
            eprintln!("[inkwell] Loaded sidecar with {} strokes from bytes ({})", d.stroke_count(), name);
            let mut d = d;
            while d.sheets.len() < n_pages {
                d.sheets.push(inkwell_core::doc::Sheet::bounded(d.sheets.len()));
            }
            d
        }
        _ => Document::for_pdf(n_pages),
    };
    // Before the journal replays: page ids are identity, not an edit.
    if doc.sheets.iter().any(|s| s.page_id == 0) {
        doc.assign_base_page_ids(&inkwell_core::pdf::base_fingerprint(&arc_bytes));
    }

    for (i, pi) in page_infos.iter_mut().enumerate() {
        if let Some(sheet) = doc.sheets.get(i) {
            if let Some(ref t) = sheet.template {
                pi.template = Some(t.clone());
            } else if let Some(t_img) = sheet.images.iter().find(|im| im.id.starts_with("template_bg_") || im.id.starts_with("img_template_bg_")) {
                let parts: Vec<&str> = t_img.id.split('_').collect();
                if parts.len() >= 4 {
                    pi.template = Some(parts[3..].join("_"));
                } else {
                    pi.template = Some("dark".to_string());
                }
            }
        }
    }

    let (recovered_strokes, recovered_images, recovered_texts, wal_images, wal_texts) =
        replay_wal_journal(&path, &mut doc, &mut page_infos);

    let mut loaded_images = extract_frontend_images(&doc);
    let mut loaded_texts = extract_frontend_texts(&doc);

    for w_img in wal_images {
        if !loaded_images.iter().any(|im| im.id == w_img.id) {
            loaded_images.push(w_img);
        }
    }
    for w_txt in wal_texts {
        if let Some(pos) = loaded_texts.iter().position(|t| t.id == w_txt.id) {
            loaded_texts[pos] = w_txt;
        } else {
            loaded_texts.push(w_txt);
        }
    }

    let loaded_strokes = extract_frontend_strokes(&doc);
    let doc_bookmarks = doc.bookmarks.clone();

    *state.doc.lock().unwrap() = Some(doc);
    *state.pdf_path.lock().unwrap() = Some(path.clone());
    *state.pdf_bytes.lock().unwrap() = Some(arc_bytes.clone());
    *state.original_pdf_bytes.lock().unwrap() = Some(rebased_original(arc_bytes));
    state.clear_page_caches();
    state.record_disk_stamp(&path);

    if let Ok(mut dim_guard) = state.page_dimensions.lock() {
        dim_guard.clear();
        for pi in &page_infos {
            dim_guard.insert(pi.page_index as u32, (pi.width_pt, pi.height_pt));
        }
    }

    let wp = wal_path_for(&path);
    if let Some(old_tx) = state.wal.lock().unwrap().take() {
        let _ = old_tx.send(WalOp::Close);
    }
    match Wal::open(&wp) {
        Ok(wal) => {
            let tx = init_wal_worker(wal);
            *state.wal.lock().unwrap() = Some(tx);
        }
        Err(e) => { eprintln!("[inkwell] WAL init failed ({wp:?}): {e}"); }
    }

    eprintln!("[inkwell] Opened PDF bytes: {:?} — {} pages, {} loaded strokes, {} loaded images, {} loaded texts, {} outline nodes in {} ms", name, n_pages, loaded_strokes.len(), loaded_images.len(), loaded_texts.len(), outline.len(), open_started.elapsed().as_millis());
    Ok(OpenPdfResult {
        page_infos,
        recovered_strokes,
        recovered_images,
        recovered_texts,
        loaded_strokes,
        loaded_images,
        loaded_texts,
        outline,
        bookmarks: doc_bookmarks,
        shelved_journal_entries: 0,
    })
}

/// Move a set-aside journal's records into the live journal for `doc_path`,
/// so the normal crash replay that follows brings them back, then delete it.
fn restore_shelved_journal(doc_path: &Path, shelved: &Path) -> Result<(), String> {
    let entries = Wal::replay(shelved).map_err(|e| format!("Could not read the set-aside changes: {e}"))?;
    if entries.is_empty() {
        let _ = std::fs::remove_file(shelved);
        return Ok(());
    }
    let mut live = Wal::open(wal_path_for(doc_path)).map_err(|e| format!("Could not open the journal: {e}"))?;
    for e in &entries {
        live.append(e).map_err(|e| format!("Could not restore the set-aside changes: {e}"))?;
    }
    drop(live);
    std::fs::remove_file(shelved).map_err(|e| format!("Restored, but could not remove {shelved:?}: {e}"))?;
    eprintln!("[inkwell] Restored {} set-aside journal records for {doc_path:?}", entries.len());
    Ok(())
}
