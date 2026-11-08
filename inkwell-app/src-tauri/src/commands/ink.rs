//! Stroke, image and text mutations: WAL journalling, erasing, and syncing the frontend payload into the document.

use super::*;

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn commit_stroke(
    sheet: usize,
    tool: String,
    rgb: [f64; 3],
    base_width: f64,
    samples: Vec<RawSampleInput>,
    client_id: Option<String>,
    seq: Option<u64>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let seq = journal_seq(state.inner(), seq);
    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;

    let tool_kind = match tool.as_str() {
        "highlighter" => ToolKind::Highlighter,
        _ => ToolKind::Pen,
    };

    let stroke_id = if let Some(ref cid) = client_id {
        parse_stroke_id(cid)
    } else {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    };

    let brush = Brush {
        base_width,
        min_ratio: 0.22,
        gamma: 1.0,
    };

    let raw_pts: Vec<Sample> = samples
        .into_iter()
        .map(|s| Sample::new(s.x, s.y, s.pressure.clamp(0.0, 1.0), s.t_ms))
        .collect();

    let pts = if raw_pts.len() > 3 {
        inkwell_core::ink::simplify(&raw_pts, 0.10)
    } else {
        raw_pts
    };

    let stroke = Stroke {
        id: stroke_id,
        kind: tool_kind,
        rgb: [rgb[0], rgb[1], rgb[2]],
        brush,
        samples: pts,
    };

    doc.remove_stroke(stroke_id);
    doc.push_stroke(sheet, stroke.clone());

    // Offload WAL append to background worker thread channel.
    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        let _ = tx.send(WalOp::Append(WalEntry::Added { sheet, stroke }, seq));
    }

    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(client_id.unwrap_or_else(|| stroke_id.to_string()))
}

fn frontend_stroke_to_core(fs: &FrontendStroke) -> Option<Stroke> {
    let id = parse_stroke_id(&fs.id);
    let kind = match fs.kind.as_str() {
        "highlighter" => ToolKind::Highlighter,
        _ => ToolKind::Pen,
    };
    let brush = Brush {
        base_width: fs.base_width,
        gamma: 1.0,
        min_ratio: if kind == ToolKind::Highlighter { 1.0 } else { 0.22 },
    };
    let raw_samples: Vec<Sample> = fs.points.iter().map(|p| Sample {
        x: p.x,
        y: p.y,
        p: p.p,
        t: p.t,
    }).collect();

    let is_rect = inkwell_core::ink::is_axis_aligned_rect(&raw_samples).is_some();
    let samples = if !is_rect && raw_samples.len() > 3 {
        inkwell_core::ink::simplify(&raw_samples, 0.10)
    } else {
        raw_samples
    };

    Some(Stroke {
        id,
        kind,
        rgb: fs.rgb,
        brush,
        samples,
    })
}

#[tauri::command]
pub async fn delete_stroke(stroke_id_str: String, seq: Option<u64>,
    state: State<'_, AppState>) -> Result<bool, String> {
    let seq = journal_seq(state.inner(), seq);
    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;

    let id = parse_stroke_id(&stroke_id_str);
    let removed = doc.remove_stroke(id);
    if removed {
        if let Some(tx) = state.wal.lock().unwrap().as_ref() {
            let _ = tx.send(WalOp::Append(WalEntry::Removed(id), seq));
        }
        state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
        return Ok(true);
    }
    // The frontend keeps shapes in its stroke list (Plan 095): a delete of
    // one arrives here too.
    if doc.remove_shape(&stroke_id_str) {
        if let Some(tx) = state.wal.lock().unwrap().as_ref() {
            let _ = tx.send(WalOp::Append(WalEntry::ShapeRemoved { id: stroke_id_str }, seq));
        }
        state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
        return Ok(true);
    }
    Ok(false)
}

/// Create or edit a shape (`op` = "upsert") or delete one ("remove"),
/// journalled like a stroke commit.
#[tauri::command]
pub async fn journal_shape_mutation(
    op: String,
    shape: Option<inkwell_core::shape::ShapeObject>,
    shape_id: Option<String>,
    seq: Option<u64>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let seq = journal_seq(state.inner(), seq);
    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;
    let entry = match op.as_str() {
        "upsert" | "add" => {
            let s = shape.ok_or("upsert needs a shape")?;
            if s.sheet > 10_000 || s.points.len() < 2 || s.points.len() > 10_000 {
                return Err("invalid shape".to_string());
            }
            doc.upsert_shape(s.sheet, s.clone());
            WalEntry::ShapeUpsert { shape: s }
        }
        "remove" | "delete" => {
            let id = shape_id.ok_or("remove needs a shape id")?;
            doc.remove_shape(&id);
            WalEntry::ShapeRemoved { id }
        }
        other => return Err(format!("unknown shape op {other:?}")),
    };
    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        let _ = tx.send(WalOp::Append(entry, seq));
    }
    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(true)
}

#[tauri::command]
pub async fn journal_image_mutation(
    op: String,
    image: Option<FrontendImage>,
    image_id: Option<String>,
    seq: Option<u64>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let seq = journal_seq(state.inner(), seq);
    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        if op == "add" || op == "upsert" {
            if let Some(ref img) = image {
                let _ = tx.send(WalOp::Append(WalEntry::ImageAdded {
                    sheet: img.sheet,
                    id: img.id.clone(),
                    x: img.x,
                    y: img.y,
                    width: img.width,
                    height: img.height,
                    data_url: img.data_url.clone(),
                }, seq));
            }
        } else if op == "remove" || op == "delete" {
            if let Some(ref id) = image_id {
                let _ = tx.send(WalOp::Append(WalEntry::ImageRemoved { id: id.clone() }, seq));
            }
        }
    }
    if let Ok(mut doc_guard) = state.doc.lock() {
        if let Some(doc) = doc_guard.as_mut() {
            if op == "add" || op == "upsert" {
                if let Some(ref img) = image {
                    doc.push_image(img.sheet, inkwell_core::doc::ImageObject {
                        id: img.id.clone(),
                        sheet: img.sheet,
                        x: img.x,
                        y: img.y,
                        width: img.width,
                        height: img.height,
                        data_url: img.data_url.clone(),
                    });
                }
            } else if op == "remove" || op == "delete" {
                if let Some(ref id) = image_id {
                    doc.remove_image(id);
                }
            }
        }
    }
    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(true)
}

#[tauri::command]
pub async fn journal_text_mutation(
    op: String,
    text: Option<FrontendText>,
    text_id: Option<String>,
    seq: Option<u64>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let seq = journal_seq(state.inner(), seq);
    if let Some(tx) = state.wal.lock().unwrap().as_ref() {
        if op == "add" || op == "upsert" {
            if let Some(ref t) = text {
                let _ = tx.send(WalOp::Append(WalEntry::TextUpsert {
                    sheet: t.sheet,
                    id: t.id.clone(),
                    x: t.x,
                    y: t.y,
                    text: t.text.clone(),
                    font_size: t.font_size,
                    color: t.color.clone(),
                    bold: t.bold,
                    italic: t.italic,
                    width: t.width,
                    height: t.height,
                }, seq));
            }
        } else if op == "remove" || op == "delete" {
            if let Some(ref id) = text_id {
                let _ = tx.send(WalOp::Append(WalEntry::TextRemoved { id: id.clone() }, seq));
            }
        }
    }
    if let Ok(mut doc_guard) = state.doc.lock() {
        if let Some(doc) = doc_guard.as_mut() {
            if op == "add" || op == "upsert" {
                if let Some(ref t) = text {
                    doc.upsert_text(t.sheet, inkwell_core::doc::TextObject {
                        id: t.id.clone(),
                        sheet: t.sheet,
                        x: t.x,
                        y: t.y,
                        text: t.text.clone(),
                        font_size: t.font_size,
                        color: t.color.clone(),
                        bold: t.bold,
                        italic: t.italic,
                        width: t.width,
                        height: t.height,
                    });
                }
            } else if op == "remove" || op == "delete" {
                if let Some(ref id) = text_id {
                    doc.remove_text(id);
                }
            }
        }
    }
    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(true)
}

/// Mirror the frontend's authoritative object lists into the backend document
/// model. Used by both incremental save and custom export so the two paths can
/// never diverge in what they write.
pub(super) fn apply_frontend_payload(
    state: &AppState,
    images: Option<Vec<FrontendImage>>,
    strokes: Option<Vec<FrontendStroke>>,
    texts: Option<Vec<FrontendText>>,
    bookmarks: Option<Vec<inkwell_core::doc::Bookmark>>,
    shapes: Option<Vec<inkwell_core::shape::ShapeObject>>,
) -> Result<(), String> {
    // If frontend provided the active stroke list, sync doc state completely
    if let Some(ref stroke_list) = strokes {
        for fs in stroke_list {
            if fs.sheet > 10_000 {
                return Err("stroke sheet index out of bounds".to_string());
            }
        }
        let mut doc_guard = state.doc.lock().unwrap();
        if let Some(doc) = doc_guard.as_mut() {
            for sheet in &mut doc.sheets {
                for layer in &mut sheet.layers {
                    layer.strokes.clear();
                }
            }
            for fs in stroke_list {
                if !fs.deleted {
                    if let Some(core_stroke) = frontend_stroke_to_core(fs) {
                        while doc.sheets.len() <= fs.sheet {
                            doc.sheets.push(inkwell_core::doc::Sheet::bounded(doc.sheets.len()));
                        }
                        if doc.sheets[fs.sheet].layers.is_empty() {
                            doc.sheets[fs.sheet].layers.push(inkwell_core::doc::Layer::new("Ink"));
                        }
                        doc.sheets[fs.sheet].layers[0].strokes.push(core_stroke);
                    }
                }
            }
            doc.reindex_bounded_sheets();
        }
    }

    // If frontend provided the active images list, sync doc state completely
    if let Some(ref img_list) = images {
        let mut doc_guard = state.doc.lock().unwrap();
        if let Some(doc) = doc_guard.as_mut() {
            for sheet in &mut doc.sheets {
                sheet.images.clear();
            }
            for img in img_list {
                while doc.sheets.len() <= img.sheet {
                    doc.sheets.push(inkwell_core::doc::Sheet::bounded(doc.sheets.len()));
                }
                if img.id.starts_with("template_bg_") || img.id.starts_with("img_template_bg_") {
                    let parts: Vec<&str> = img.id.split('_').collect();
                    if parts.len() >= 4 {
                        doc.sheets[img.sheet].template = Some(parts[3..].join("_"));
                    }
                }
                doc.sheets[img.sheet].images.push(inkwell_core::doc::ImageObject {
                    id: img.id.clone(),
                    sheet: img.sheet,
                    x: img.x,
                    y: img.y,
                    width: img.width,
                    height: img.height,
                    data_url: img.data_url.clone(),
                });
            }
        }
    }

    // If frontend provided the active text objects list, sync doc state completely
    if let Some(ref text_list) = texts {
        let mut doc_guard = state.doc.lock().unwrap();
        if let Some(doc) = doc_guard.as_mut() {
            for sheet in &mut doc.sheets {
                sheet.text_objects.clear();
            }
            for t in text_list {
                if !t.text.trim().is_empty() {
                    while doc.sheets.len() <= t.sheet {
                        doc.sheets.push(inkwell_core::doc::Sheet::bounded(doc.sheets.len()));
                    }
                    doc.sheets[t.sheet].text_objects.push(inkwell_core::doc::TextObject {
                        id: t.id.clone(),
                        sheet: t.sheet,
                        x: t.x,
                        y: t.y,
                        text: t.text.clone(),
                        font_size: t.font_size,
                        color: t.color.clone(),
                        bold: t.bold,
                        italic: t.italic,
                        width: t.width,
                        height: t.height,
                    });
                }
            }
        }
    }

    if let Some(ref bm_list) = bookmarks {
        let mut doc_guard = state.doc.lock().unwrap();
        if let Some(doc) = doc_guard.as_mut() {
            doc.bookmarks = bm_list.clone();
        }
    }

    // Parametric shapes (Plan 095): the frontend's list is authoritative.
    if let Some(shape_list) = shapes {
        if shape_list.iter().any(|s| s.sheet > 10_000) {
            return Err("shape sheet index out of bounds".to_string());
        }
        let mut doc_guard = state.doc.lock().unwrap();
        if let Some(doc) = doc_guard.as_mut() {
            for sheet in &mut doc.sheets {
                sheet.shapes.clear();
            }
            for s in shape_list {
                doc.upsert_shape(s.sheet, s);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn erase_strokes_near(
    sheet: usize,
    px: f64,
    py: f64,
    radius: f64,
    seq: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let seq = journal_seq(state.inner(), seq);
    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;
    let removed = doc.erase_strokes_near(sheet, px, py, radius);
    if !removed.is_empty() {
        if let Some(tx) = state.wal.lock().unwrap().as_ref() {
            for &id in &removed {
                let _ = tx.send(WalOp::Append(WalEntry::Removed(id), seq));
            }
        }
        state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(removed.into_iter().map(|id| id.to_string()).collect())
}

#[tauri::command]
pub async fn erase_strokes_in_rect(
    sheet: usize,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    seq: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let seq = journal_seq(state.inner(), seq);
    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;
    let removed = doc.erase_strokes_in_rect(sheet, x0, y0, x1, y1);
    if !removed.is_empty() {
        if let Some(tx) = state.wal.lock().unwrap().as_ref() {
            for &id in &removed {
                let _ = tx.send(WalOp::Append(WalEntry::Removed(id), seq));
            }
        }
        state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(removed.into_iter().map(|id| id.to_string()).collect())
}

#[tauri::command]
pub async fn get_document_info(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_ref().ok_or("No document open")?;

    Ok(serde_json::json!({
        "sheets": doc.sheets.len(),
        "strokes": doc.stroke_count(),
        "samples": doc.sample_count(),
    }))
}
