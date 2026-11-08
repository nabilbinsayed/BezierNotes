//! Page structure: insert, delete, duplicate, rotate and reorder.

use super::*;

/// Sheets backed by PDF pages. Canvas sheets (Plan 097) always come after
/// them, so PDF page operations stay within `0..pdf_sheets`.
fn pdf_sheet_count(state: &AppState) -> usize {
    state.doc.lock().unwrap().as_ref().map_or(0, |d| {
        d.sheets.iter().filter(|s| s.kind != inkwell_core::SheetKind::FreeCanvas).count()
    })
}

fn refuse_canvas(state: &AppState, index: usize, what: &str) -> Result<(), String> {
    if index >= pdf_sheet_count(state) {
        return Err(format!("Canvas pages can't be {what}; they always come after the document's pages."));
    }
    Ok(())
}

/// Append an infinite canvas page (Plan 097). Its content is tiled into
/// ordinary pages when the document is saved.
#[tauri::command]
pub async fn add_canvas_page(seq: Option<u64>, state: State<'_, AppState>) -> Result<PageInfo, String> {
    let seq = journal_seq(state.inner(), seq);
    let _save_guard = state.save_lock.lock().map_err(|e| format!("Lock error: {e}"))?;
    let info = {
        let mut g = state.doc.lock().unwrap();
        let doc = g.as_mut().ok_or("No document open")?;
        doc.sheets.push(inkwell_core::doc::Sheet::canvas());
        let i = doc.sheets.len() - 1;
        canvas_page_info(i, &doc.sheets[i])
    };
    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        let _ = tx.send(WalOp::Append(WalEntry::CanvasAdded, seq));
    }
    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(info)
}

#[tauri::command]
pub async fn insert_blank_page(
    index: usize,
    width_pt: f64,
    height_pt: f64,
    seq: Option<u64>,
    state: State<'_, AppState>,
) -> Result<PageInfo, String> {
    let seq = journal_seq(state.inner(), seq);
    if index > pdf_sheet_count(state.inner()) {
        return Err("New pages go before the canvas pages; canvas pages always come last.".to_string());
    }
    // Page edits rewrite the base bytes; never interleave with a save's
    // snapshot -> write -> publish (Plan 090).
    let _save_guard = state.save_lock.lock().map_err(|e| format!("Lock error: {e}"))?;
    if !width_pt.is_finite() || !height_pt.is_finite() || width_pt < 72.0 || height_pt < 72.0 || width_pt > 14400.0 || height_pt > 14400.0 {
        return Err(format!("Invalid page dimensions: {width_pt} x {height_pt} pt (must be between 72 and 14400)"));
    }

    // 1. Run fallible PDFium operation first
    let orig_bytes_opt = state.pdf_bytes.lock().unwrap().clone();
    let maybe_new_bytes = if let Some(bytes) = orig_bytes_opt {
        let pdfium_guard = state.pdfium.lock().unwrap();
        let pdfium = pdfium_guard.as_ref().ok_or("PDFium not available for page insertion")?;
        use pdfium_render::prelude::*;
        let mut pdf_doc = pdfium.load_pdf_from_byte_slice(&bytes, None)
            .map_err(|e| format!("PDFium failed to load PDF for page insertion: {e:?}"))?;
        let w = PdfPoints::new(width_pt as f32);
        let h = PdfPoints::new(height_pt as f32);
        let target_idx = (index as i32).min(pdf_doc.pages().len());
        pdf_doc.pages_mut().create_page_at_index(
            PdfPagePaperSize::Custom(w, h),
            target_idx,
        ).map_err(|e| format!("PDFium create_page_at_index failed: {e:?}"))?;
        let new_bytes = pdf_doc.save_to_bytes()
            .map_err(|e| format!("PDFium save_to_bytes failed: {e:?}"))?;
        Some(new_bytes)
    } else {
        None
    };

    // 2. Only mutate doc state after PDFium succeeds
    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;
    doc.insert_sheet(index);

    if let Some(new_bytes) = maybe_new_bytes {
        *state.pdf_bytes.lock().unwrap() = Some(Arc::new(new_bytes.clone()));
        *state.original_pdf_bytes.lock().unwrap() = Some(Arc::new(new_bytes));
    }

    state.clear_page_caches();
    if let Ok(mut dims) = state.page_dimensions.lock() {
        dims.clear();
    }

    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        let _ = tx.send(WalOp::Append(WalEntry::PageInserted {
            index,
            width_pt,
            height_pt,
        }, seq));
    }

    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);

    Ok(PageInfo {
        page_index: index,
        width_pt,
        height_pt,
        template: None,
        canvas: false,
    })
}

#[tauri::command]
pub async fn delete_page(
    index: usize,
    seq: Option<u64>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let seq = journal_seq(state.inner(), seq);
    // Page edits rewrite the base bytes; never interleave with a save's
    // snapshot -> write -> publish (Plan 090).
    let _save_guard = state.save_lock.lock().map_err(|e| format!("Lock error: {e}"))?;
    {
        let mut doc_guard = state.doc.lock().unwrap();
        let doc = doc_guard.as_mut().ok_or("No document open")?;
        if doc.sheets.len() <= 1 || index >= doc.sheets.len() {
            return Err(format!("Cannot delete page {index} (page out of bounds or only remaining page)"));
        }
        // A canvas page has no PDF page behind it: drop the sheet only.
        if doc.sheets[index].kind == inkwell_core::SheetKind::FreeCanvas {
            doc.sheets.remove(index);
            if let Some(tx) = state.wal.lock().unwrap().as_ref() {
                let _ = tx.send(WalOp::Append(WalEntry::CanvasRemoved { index }, seq));
            }
            state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
            return Ok(true);
        }
    }

    let orig_bytes_opt = state.pdf_bytes.lock().unwrap().clone();
    let maybe_new_bytes = if let Some(bytes) = orig_bytes_opt {
        let pdfium_guard = state.pdfium.lock().unwrap();
        if let Some(pdfium) = pdfium_guard.as_ref() {
            let src_doc = pdfium.load_pdf_from_byte_slice(&bytes, None)
                .map_err(|e| format!("PDFium failed to load PDF for page deletion: {e:?}"))?;
            let total_pages = src_doc.pages().len();
            let mut dest_doc = pdfium.create_new_pdf()
                .map_err(|e| format!("PDFium create_new_pdf failed: {e:?}"))?;

            if index > 0 {
                dest_doc.pages_mut().copy_page_range_from_document(
                    &src_doc,
                    0..=(index as i32 - 1),
                    0,
                ).map_err(|e| format!("PDFium copy before failed: {e:?}"))?;
            }
            if (index as i32 + 1) < total_pages {
                let dest_len = dest_doc.pages().len();
                dest_doc.pages_mut().copy_page_range_from_document(
                    &src_doc,
                    (index as i32 + 1)..=(total_pages - 1),
                    dest_len,
                ).map_err(|e| format!("PDFium copy after failed: {e:?}"))?;
            }

            let new_bytes = dest_doc.save_to_bytes()
                .map_err(|e| format!("PDFium save_to_bytes failed: {e:?}"))?;
            Some(new_bytes)
        } else {
            None
        }
    } else {
        None
    };

    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;
    if !doc.delete_sheet(index) {
        return Err(format!("Cannot delete page {index} (page out of bounds or only remaining page)"));
    }

    if let Some(new_bytes) = maybe_new_bytes {
        *state.pdf_bytes.lock().unwrap() = Some(Arc::new(new_bytes.clone()));
        *state.original_pdf_bytes.lock().unwrap() = Some(Arc::new(new_bytes));
    }

    state.clear_page_caches();
    if let Ok(mut dims) = state.page_dimensions.lock() {
        dims.clear();
    }

    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        let _ = tx.send(WalOp::Append(WalEntry::PageDeleted { index }, seq));
    }

    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(true)
}

#[tauri::command]
pub async fn duplicate_page(
    index: usize,
    seq: Option<u64>,
    state: State<'_, AppState>,
) -> Result<PageInfo, String> {
    let seq = journal_seq(state.inner(), seq);
    refuse_canvas(state.inner(), index, "duplicated")?;
    // Page edits rewrite the base bytes; never interleave with a save's
    // snapshot -> write -> publish (Plan 090).
    let _save_guard = state.save_lock.lock().map_err(|e| format!("Lock error: {e}"))?;
    let target_idx = index + 1;
    {
        let doc_guard = state.doc.lock().unwrap();
        let doc = doc_guard.as_ref().ok_or("No document open")?;
        if index >= doc.sheets.len() {
            return Err(format!("Page index {index} out of bounds"));
        }
    }

    let mut out_w = 595.0;
    let mut out_h = 842.0;

    let orig_bytes_opt = state.pdf_bytes.lock().unwrap().clone();
    let maybe_new_bytes = if let Some(bytes) = orig_bytes_opt {
        let pdfium_guard = state.pdfium.lock().unwrap();
        if let Some(pdfium) = pdfium_guard.as_ref() {
            let src_doc = pdfium.load_pdf_from_byte_slice(&bytes, None)
                .map_err(|e| format!("PDFium failed to load src PDF for duplicate: {e:?}"))?;
            if let Ok(src_page) = src_doc.pages().get(index as i32) {
                out_w = src_page.width().value as f64;
                out_h = src_page.height().value as f64;
            }
            let mut dest_doc = pdfium.load_pdf_from_byte_slice(&bytes, None)
                .map_err(|e| format!("PDFium failed to load dest PDF for duplicate: {e:?}"))?;
            dest_doc.pages_mut().copy_page_from_document(
                &src_doc,
                index as i32,
                target_idx as i32,
            ).map_err(|e| format!("PDFium copy_page_from_document failed: {e:?}"))?;

            let new_bytes = dest_doc.save_to_bytes()
                .map_err(|e| format!("PDFium save_to_bytes failed: {e:?}"))?;
            Some(new_bytes)
        } else {
            None
        }
    } else {
        None
    };

    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;
    doc.duplicate_sheet(index).ok_or_else(|| format!("Page index {index} out of bounds"))?;

    let cloned_strokes: Vec<_> = doc.sheets.get(target_idx).map(|s| s.strokes().cloned().collect()).unwrap_or_default();
    let cloned_images: Vec<_> = doc.sheets.get(target_idx).map(|s| s.images.clone()).unwrap_or_default();
    let cloned_texts: Vec<_> = doc.sheets.get(target_idx).map(|s| s.text_objects.clone()).unwrap_or_default();
    let cloned_template = doc.sheets.get(target_idx).and_then(|s| s.template.clone());
    drop(doc_guard);

    if let Some(new_bytes) = maybe_new_bytes {
        *state.pdf_bytes.lock().unwrap() = Some(Arc::new(new_bytes.clone()));
        *state.original_pdf_bytes.lock().unwrap() = Some(Arc::new(new_bytes));
    }

    state.clear_page_caches();
    if let Ok(mut dims) = state.page_dimensions.lock() {
        dims.clear();
    }

    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        let _ = tx.send(WalOp::Append(WalEntry::PageInserted {
            index: target_idx,
            width_pt: out_w,
            height_pt: out_h,
        }, seq));
        for stroke in cloned_strokes {
            let _ = tx.send(WalOp::Append(WalEntry::Added { sheet: target_idx, stroke }, seq));
        }
        for img in cloned_images {
            let _ = tx.send(WalOp::Append(WalEntry::ImageAdded {
                sheet: target_idx,
                id: img.id,
                x: img.x,
                y: img.y,
                width: img.width,
                height: img.height,
                data_url: img.data_url,
            }, seq));
        }
        for txt in cloned_texts {
            let _ = tx.send(WalOp::Append(WalEntry::TextUpsert {
                sheet: target_idx,
                id: txt.id,
                x: txt.x,
                y: txt.y,
                text: txt.text,
                font_size: txt.font_size,
                color: txt.color,
                bold: txt.bold,
                italic: txt.italic,
                width: txt.width,
                height: txt.height,
            }, seq));
        }
    }

    Ok(PageInfo {
        page_index: target_idx,
        width_pt: out_w,
        height_pt: out_h,
        template: cloned_template,
        canvas: false,
    })
}

#[tauri::command]
pub async fn rotate_page(
    index: usize,
    clockwise: bool,
    seq: Option<u64>,
    state: State<'_, AppState>,
) -> Result<PageInfo, String> {
    let seq = journal_seq(state.inner(), seq);
    refuse_canvas(state.inner(), index, "rotated")?;
    // Page edits rewrite the base bytes; never interleave with a save's
    // snapshot -> write -> publish (Plan 090).
    let _save_guard = state.save_lock.lock().map_err(|e| format!("Lock error: {e}"))?;
    let orig_bytes_opt = state.pdf_bytes.lock().unwrap().clone();
    let mut orig_w = 595.0;
    let mut orig_h = 842.0;

    if let Some(bytes) = orig_bytes_opt {
        let pdfium_guard = state.pdfium.lock().unwrap();
        if let Some(pdfium) = pdfium_guard.as_ref() {
            let mut pdf_doc = pdfium.load_pdf_from_byte_slice(&bytes, None)
                .map_err(|e| format!("PDFium failed to load PDF for rotation: {e:?}"))?;
            if let Ok(mut page) = pdf_doc.pages_mut().get(index as i32) {
                orig_w = page.width().value as f64;
                orig_h = page.height().value as f64;
                if clockwise {
                    let _ = page.rotate_clockwise_degrees(90.0);
                } else {
                    let _ = page.rotate_counter_clockwise_degrees(90.0);
                }
            }
            let new_bytes = pdf_doc.save_to_bytes()
                .map_err(|e| format!("PDFium save_to_bytes failed: {e:?}"))?;
            *state.pdf_bytes.lock().unwrap() = Some(Arc::new(new_bytes.clone()));
            *state.original_pdf_bytes.lock().unwrap() = Some(Arc::new(new_bytes));
        }
    }

    let out_w = orig_h;
    let out_h = orig_w;

    let mut doc_guard = state.doc.lock().unwrap();
    let rot_template = if let Some(doc) = doc_guard.as_mut() {
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
            sheet.template.clone()
        } else {
            None
        }
    } else {
        None
    };
    drop(doc_guard);

    state.clear_page_caches();
    if let Ok(mut dims) = state.page_dimensions.lock() {
        dims.clear();
    }

    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        let _ = tx.send(WalOp::Append(WalEntry::PageRotated { index, clockwise }, seq));
    }

    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);

    Ok(PageInfo {
        page_index: index,
        width_pt: out_w,
        height_pt: out_h,
        template: rot_template,
        canvas: false,
    })
}

#[tauri::command]
pub async fn reorder_page(
    from_index: usize,
    to_index: usize,
    seq: Option<u64>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let seq = journal_seq(state.inner(), seq);
    refuse_canvas(state.inner(), from_index.max(to_index), "moved")?;
    // Page edits rewrite the base bytes; never interleave with a save's
    // snapshot -> write -> publish (Plan 090).
    let _save_guard = state.save_lock.lock().map_err(|e| format!("Lock error: {e}"))?;
    if from_index == to_index {
        return Ok(true);
    }
    {
        let doc_guard = state.doc.lock().unwrap();
        let doc = doc_guard.as_ref().ok_or("No document open")?;
        if from_index >= doc.sheets.len() || to_index >= doc.sheets.len() {
            return Err("Page indices out of bounds".to_string());
        }
    }

    let orig_bytes_opt = state.pdf_bytes.lock().unwrap().clone();
    let maybe_new_bytes = if let Some(bytes) = orig_bytes_opt {
        let pdfium_guard = state.pdfium.lock().unwrap();
        if let Some(pdfium) = pdfium_guard.as_ref() {
            let src_doc = pdfium.load_pdf_from_byte_slice(&bytes, None)
                .map_err(|e| format!("PDFium failed to load src PDF for reorder: {e:?}"))?;
            let total_pages = src_doc.pages().len() as usize;
            if from_index >= total_pages || to_index >= total_pages {
                return Err("Page indices out of bounds for PDF".to_string());
            }
            let mut page_indices: Vec<i32> = (0..total_pages as i32).collect();
            let moved = page_indices.remove(from_index);
            page_indices.insert(to_index, moved);

            let mut dest_doc = pdfium.create_new_pdf()
                .map_err(|e| format!("PDFium create_new_pdf failed: {e:?}"))?;

            for &idx in &page_indices {
                let dest_len = dest_doc.pages().len();
                dest_doc.pages_mut().copy_page_from_document(&src_doc, idx, dest_len)
                    .map_err(|e| format!("PDFium copy failed during reorder: {e:?}"))?;
            }

            let new_bytes = dest_doc.save_to_bytes()
                .map_err(|e| format!("PDFium save_to_bytes failed: {e:?}"))?;
            Some(new_bytes)
        } else {
            None
        }
    } else {
        None
    };

    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;
    if !doc.reorder_sheet(from_index, to_index) {
        return Err("Page indices out of bounds".to_string());
    }

    if let Some(new_bytes) = maybe_new_bytes {
        *state.pdf_bytes.lock().unwrap() = Some(Arc::new(new_bytes.clone()));
        *state.original_pdf_bytes.lock().unwrap() = Some(Arc::new(new_bytes));
    }

    state.clear_page_caches();
    if let Ok(mut dims) = state.page_dimensions.lock() {
        dims.clear();
    }

    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        let _ = tx.send(WalOp::Append(WalEntry::PageReordered { from_index, to_index }, seq));
    }

    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(true)
}
