use crate::state::{disk_stamp_for, AppState, CachedPageBitmap, WalOp};
use serde::{Deserialize, Serialize};
use tauri::State;
use std::sync::Arc;
use std::path::{Path, PathBuf};
use std::time::Instant;
use pdfium_render::prelude::*;
use inkwell_core::{Document, Sample, Stroke, ToolKind, Brush, PdfFile, SidecarStatus, wal::{atomic_write, Wal, WalEntry}};

/// RAII guard for `AppState::active_tile_renders`: tracks how many visible tile
/// requests are outstanding so idle prefetch can step aside.
struct ActiveTileRenderGuard<'a>(&'a std::sync::atomic::AtomicUsize);

impl Drop for ActiveTileRenderGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

/// Look up a memoized page text model.
fn cached_page_text(state: &AppState, page_index: u32) -> Option<Arc<inkwell_pdf::PageTextData>> {
    state
        .page_text_cache
        .lock()
        .ok()
        .and_then(|cache| cache.get(&page_index).cloned())
}

/// Memoize a freshly extracted page text model, with a hard cap so a very long
/// document cannot grow the cache without bound.
fn store_page_text(
    state: &AppState,
    page_index: u32,
    data: inkwell_pdf::PageTextData,
) -> Arc<inkwell_pdf::PageTextData> {
    let arc = Arc::new(data);
    if let Ok(mut cache) = state.page_text_cache.lock() {
        if cache.len() > 2048 {
            cache.clear();
        }
        cache.insert(page_index, arc.clone());
    }
    arc
}

fn init_wal_worker(wal: Wal) -> std::sync::mpsc::Sender<WalOp> {
    let (tx, rx) = std::sync::mpsc::channel::<WalOp>();
    std::thread::spawn(move || {
        let mut wal = wal;
        while let Ok(op) = rx.recv() {
            match op {
                WalOp::Append(entry) => {
                    if let Err(e) = wal.append(&entry) {
                        eprintln!("[inkwell] Background WAL append error: {e}");
                    }
                }
                WalOp::Truncate(ack) => {
                    if let Err(e) = wal.truncate() {
                        eprintln!("[inkwell] Background WAL truncate error: {e}");
                    }
                    if let Some(sender) = ack {
                        let _ = sender.send(());
                    }
                }
                WalOp::Discard(ack) => {
                    if let Err(e) = wal.truncate() {
                        eprintln!("[inkwell] Background WAL discard truncate error: {e}");
                    }
                    if let Some(sender) = ack {
                        let _ = sender.send(());
                    }
                    break;
                }
                WalOp::Close => break,
            }
        }
    });
    tx
}

fn hash_bytes_fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

fn parse_stroke_id(s: &str) -> u128 {
    let s_clean = s.trim_start_matches("0x");
    if s_clean.len() == 32 {
        u128::from_str_radix(s_clean, 16).unwrap_or(0)
    } else {
        s.parse::<u128>().or_else(|_| u128::from_str_radix(s_clean, 16)).unwrap_or_else(|_| {
            hash_bytes_fnv1a(s.as_bytes()) as u128
        })
    }
}

/// Derive a safe WAL path for `doc_path` that stays out of the synced folder.
/// Key = hex-encoded FNV-1a of the canonical path bytes.
/// On Windows: uses %TEMP% directly.
/// On Unix/Linux: uses $XDG_STATE_HOME/inkwell/wal (or ~/.local/state/inkwell/wal) to persist across reboots.
fn wal_path_for(doc_path: &Path) -> PathBuf {
    let s = doc_path.to_string_lossy();
    let h = hash_bytes_fnv1a(s.as_bytes());
    let filename = format!("inkwell-wal-{:016x}.bin", h);

    #[cfg(windows)]
    {
        std::env::temp_dir().join(filename)
    }

    #[cfg(not(windows))]
    {
        let base = std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
                home.join(".local").join("state")
            })
            .join("inkwell")
            .join("wal");
        let _ = std::fs::create_dir_all(&base);
        base.join(filename)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageInfo {
    pub page_index: usize,
    pub width_pt: f64,
    pub height_pt: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrontendSample {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub p: f64,
    pub t: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrontendStroke {
    pub id: String,
    pub kind: String,
    pub rgb: [f64; 3],
    pub base_width: f64,
    pub points: Vec<FrontendSample>,
    pub sheet: usize,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrontendImage {
    pub id: String,
    pub sheet: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrontendText {
    pub id: String,
    pub sheet: usize,
    pub x: f64,
    pub y: f64,
    pub text: String,
    pub font_size: f64,
    pub color: String,
    pub bold: bool,
    pub italic: bool,
    pub width: f64,
    pub height: f64,
}

/// Result of opening a PDF: page dimensions plus recovered/loaded strokes, images, texts and outline.
#[derive(Debug, Serialize, Deserialize)]
pub struct OpenPdfResult {
    pub page_infos: Vec<PageInfo>,
    pub recovered_strokes: usize,
    pub recovered_images: usize,
    pub recovered_texts: usize,
    pub loaded_strokes: Vec<FrontendStroke>,
    pub loaded_images: Vec<FrontendImage>,
    pub loaded_texts: Vec<FrontendText>,
    pub outline: Vec<inkwell_pdf::TocItem>,
    #[serde(default)]
    pub bookmarks: Vec<inkwell_core::doc::Bookmark>,
}

#[derive(Debug, Deserialize)]
pub struct RawSampleInput {
    pub x: f64,
    pub y: f64,
    pub pressure: f64,
    pub t_ms: f64,
}

fn extract_frontend_strokes(doc: &Document) -> Vec<FrontendStroke> {
    let mut out = Vec::new();
    for (sheet_idx, sheet) in doc.sheets.iter().enumerate() {
        for stroke in sheet.strokes() {
            let kind_str = match stroke.kind {
                ToolKind::Highlighter => "highlighter",
                ToolKind::Pen => "pen",
            };
            let points = stroke.samples.iter().map(|s| FrontendSample {
                x: s.x,
                y: s.y,
                w: stroke.brush.width_for(s.p),
                p: s.p,
                t: s.t,
            }).collect();
            out.push(FrontendStroke {
                id: stroke.id_hex(),
                kind: kind_str.to_string(),
                rgb: stroke.rgb,
                base_width: stroke.brush.base_width,
                points,
                sheet: sheet_idx,
                deleted: false,
            });
        }
    }
    out
}

fn extract_frontend_images(doc: &Document) -> Vec<FrontendImage> {
    let mut out = Vec::new();
    for sheet in &doc.sheets {
        for img in &sheet.images {
            if img.id.starts_with("template_bg_") || img.id.starts_with("img_template_bg_") {
                continue;
            }
            out.push(FrontendImage {
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
    out
}

fn extract_frontend_texts(doc: &Document) -> Vec<FrontendText> {
    let mut out = Vec::new();
    for sheet in &doc.sheets {
        for txt in &sheet.text_objects {
            out.push(FrontendText {
                id: txt.id.clone(),
                sheet: txt.sheet,
                x: txt.x,
                y: txt.y,
                text: txt.text.clone(),
                font_size: txt.font_size,
                color: txt.color.clone(),
                bold: txt.bold,
                italic: txt.italic,
                width: txt.width,
                height: txt.height,
            });
        }
    }
    out
}

/// Extract page count, dimensions, and table of contents from PDF bytes using PDFium.
/// Falls back to the shallow `PdfFile` reader if PDFium is unavailable.
fn extract_pdf_meta(
    bytes: &[u8],
    state: &AppState,
) -> (Vec<PageInfo>, Vec<inkwell_pdf::TocItem>) {
    let pdfium_guard = state.pdfium.lock().unwrap();
    if let Some(pdfium) = pdfium_guard.as_ref() {
        match pdfium.load_pdf_from_byte_slice(bytes, None) {
            Ok(doc) => {
                let n = doc.pages().len() as usize;
                // FPDF_GetPageSizeByIndexF reads the page box without loading or
                // parsing page content. Loading each page here cost ~0.7s on a
                // 33-page vector textbook and delayed the first paint; the fast
                // size API does the same work in ~1ms.
                let page_infos = (0..n)
                    .map(|i| {
                        let (w, h) = doc.pages()
                            .page_size(i as i32)
                            .map(|r| (r.width().value as f64, r.height().value as f64))
                            .unwrap_or((595.0, 842.0));
                        PageInfo { page_index: i, width_pt: w, height_pt: h, template: None }
                    })
                    .collect();
                let outline = inkwell_pdf::extract_outline(&doc);
                return (page_infos, outline);
            }
            Err(e) => {
                eprintln!("[inkwell] PDFium failed to load PDF for metadata: {e:?}");
            }
        }
    } else {
        eprintln!("[inkwell] PDFium not available — falling back to shallow reader for page info.");
    }

    // Fallback: use the shallow PdfFile reader (only works for classic-xref PDFs)
    let n = PdfFile::open(bytes.to_vec())
        .map(|f| f.page_count())
        .unwrap_or(1);
    let page_infos = (0..n)
        .map(|i| PageInfo { page_index: i, width_pt: 595.0, height_pt: 842.0, template: None })
        .collect();
    (page_infos, Vec::new())
}

use tauri_plugin_dialog::DialogExt;

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
        let result = open_pdf(path_str.clone(), state).await?;
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
pub async fn open_pdf(path_str: String, state: State<'_, AppState>) -> Result<OpenPdfResult, String> {
    let open_started = Instant::now();
    let path = PathBuf::from(&path_str);
    if path_str.contains("..") || path.components().any(|c| c == std::path::Component::ParentDir) {
        return Err("Path traversal components (..) are not permitted in open path".to_string());
    }
    if !path.exists() || !path.is_file() {
        return Err(format!("File does not exist: {path:?}"));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read PDF file: {e}"))?;

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
    *state.original_pdf_bytes.lock().unwrap() = Some(arc_bytes);
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
    *state.original_pdf_bytes.lock().unwrap() = Some(arc_bytes);
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
    })
}

/// Normalize a PDFium page buffer to opaque RGBA by compositing any residual
/// alpha over the white page background. Runs once per rendered page, never per
/// tile, so tile crops stay pure memcpy operations.
fn normalize_page_rgba_in_place(bytes: &mut [u8]) {
    for px in bytes.as_chunks_mut::<4>().0 {
        let a = px[3];
        if a == 255 {
            continue;
        }
        if a == 0 {
            px[0] = 255;
            px[1] = 255;
            px[2] = 255;
            px[3] = 255;
            continue;
        }
        let a16 = a as u16;
        let inv = 255 - a16;
        px[0] = ((px[0] as u16 * a16 + 255 * inv) / 255) as u8;
        px[1] = ((px[1] as u16 * a16 + 255 * inv) / 255) as u8;
        px[2] = ((px[2] as u16 * a16 + 255 * inv) / 255) as u8;
        px[3] = 255;
    }
}

/// Render (or fetch from the LRU cache) a full-page PDFium bitmap at `scale`.
///
/// PDFium page rendering is the expensive part of first paint, so both the
/// visible-tile path and the idle adjacent-page prefetch share this helper.
/// Callers must not hold any state lock when invoking it.
fn page_bitmap_for_scale(
    state: &AppState,
    page: u32,
    scale: f64,
) -> Result<(Arc<Vec<u8>>, u32, u32), String> {
    let arc_bytes = state
        .pdf_bytes
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?
        .clone()
        .ok_or("No PDF loaded")?;

    let (page_w, page_h) = {
        let dim_guard = state.page_dimensions.lock().map_err(|e| format!("Lock error: {e}"))?;
        dim_guard.get(&page).copied().unwrap_or((595.0, 842.0))
    };

    let target_w = ((page_w * scale).round().max(1.0) as i32).min(4096);
    let target_h = ((page_h * scale).round().max(1.0) as i32).min(4096);

    let cached = {
        let mut cache_guard = state.page_bitmap_cache.lock().map_err(|e| format!("Lock error: {e}"))?;
        cache_guard.get(page, target_w, target_h)
    };
    if let Some(cached_data) = cached {
        return Ok(cached_data);
    }

    let pdfium_guard = state.pdfium.lock().map_err(|e| format!("Lock error: {e}"))?;
    let cached_inside = {
        let mut cache_guard = state.page_bitmap_cache.lock().map_err(|e| format!("Lock error: {e}"))?;
        cache_guard.get(page, target_w, target_h)
    };
    if let Some(cached_data) = cached_inside {
        return Ok(cached_data);
    }

    let pdfium = pdfium_guard.as_ref().ok_or_else(|| {
        "PDFium is not available (pdfium.dll was not found at startup). \
         PDF tiles cannot be rendered.".to_string()
    })?;

    let started = Instant::now();
    let mut doc = pdfium
        .load_pdf_from_byte_slice(&arc_bytes, None)
        .map_err(|e| format!("PDFium load error: {e:?}"))?;

    let mut page_obj = doc.pages_mut().get(page as i32).map_err(|e| format!("PDFium page error: {e:?}"))?;

    // Filter out InkWell-authored annotations in-memory so they are not baked into
    // the background bitmap tile (avoiding ghosting and preserving full interactive erasing/selection).
    // Third-party annotations (from Okular, Acrobat, Drawboard, etc.) are preserved and rendered.
    let annot_count = page_obj.annotations().len();
    for i in (0..annot_count).rev() {
        let is_inkwell = if let Ok(annot) = page_obj.annotations().get(i) {
            annot.creator().as_deref() == Some("Inkwell")
        } else {
            false
        };
        if is_inkwell {
            let annots = page_obj.annotations_mut();
            if let Ok(annot) = annots.get(i) {
                let _ = annots.delete_annotation(annot);
            }
        }
    }

    let actual_w = page_obj.width().value as f64;
    let actual_h = page_obj.height().value as f64;
    let target_w = ((actual_w * scale).round().max(1.0) as i32).min(4096);
    let target_h = ((actual_h * scale).round().max(1.0) as i32).min(4096);

    let config = PdfRenderConfig::new()
        .set_target_width(target_w)
        .set_maximum_height(target_h)
        .set_clear_color(PdfColor::WHITE)
        .render_annotations(true);

    let bitmap = page_obj.render_with_config(&config).map_err(|e| {
        format!("PDFium failed to render page {page}: {e:?}")
    })?;

    // PDFium renders with FPDF_REVERSE_BYTE_ORDER (pdfium-render's default), so
    // the buffer is already RGBA. Composite any residual alpha over white ONCE
    // here instead of re-blending every pixel of every tile crop.
    let mut normalized = bitmap.as_raw_bytes();
    normalize_page_rgba_in_place(&mut normalized);
    let rgba = Arc::new(normalized);
    let bw = bitmap.width() as u32;
    let bh = bitmap.height() as u32;

    let mut cache_guard = state.page_bitmap_cache.lock().map_err(|e| format!("Lock error: {e}"))?;
    cache_guard.put(CachedPageBitmap {
        page,
        target_w,
        target_h,
        rgba_bytes: rgba.clone(),
        bitmap_w: bw,
        bitmap_h: bh,
    });

    if let Ok(mut dim_guard) = state.page_dimensions.lock() {
        dim_guard.insert(page, (actual_w, actual_h));
    }

    if std::env::var_os("INKWELL_PROFILE_TILES").is_some() {
        eprintln!("[inkwell/tile] page {page} rendered {bw}x{bh} at scale {scale:.3} in {} ms", started.elapsed().as_millis());
    }

    Ok((rgba, bw, bh))
}

#[tauri::command]
pub async fn render_tile(
    page: u32,
    rect: [f64; 4],
    px: u32,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    // Cap tile resolution to bound the IPC payload size (RGBA = w*h*4 bytes).
    let px = px.clamp(16, 2048);
    if !(rect[0].is_finite() && rect[1].is_finite() && rect[2].is_finite() && rect[3].is_finite())
        || rect[2] <= rect[0]
        || rect[3] <= rect[1]
    {
        return Err(format!("Invalid tile rectangle: {rect:?}"));
    }

    if std::env::var_os("INKWELL_PROFILE_TILES").is_some() {
        eprintln!("[inkwell/tile] request page {page} rect {rect:?} px {px}");
    }

    let rw = (rect[2] - rect[0]).max(1.0);
    let rh = (rect[3] - rect[1]).max(1.0);
    // Standardize scale against the 512pt grid tile size when px >= 64 and rw/rh <= 512,
    // so boundary-clipped tiles (< 512pt wide/tall) hit the same cached full-page bitmap.
    let base_span = if rw <= 512.0 && rh <= 512.0 { 512.0 } else { rw.max(rh) };
    let scale = (px as f64) / base_span;

    // Track that a user-visible tile is waiting so the idle prefetcher can yield
    // instead of holding the PDFium lock for an off-screen page.
    state
        .active_tile_renders
        .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    let (rgba_bytes, bitmap_w, bitmap_h) = {
        let _guard = ActiveTileRenderGuard(&state.active_tile_renders);
        page_bitmap_for_scale(state.inner(), page, scale)?
    };

    // Offload the tile crop to a worker thread. The source page bitmap is
    // normalized RGBA, so cropping is one memcpy per row.
    tauri::async_runtime::spawn_blocking(move || {
        let out_w = (rw * scale).round().max(1.0) as u32;
        let out_h = (rh * scale).round().max(1.0) as u32;

        let x0 = (rect[0] * scale).round().max(0.0) as u32;
        let y0 = (rect[1] * scale).round().max(0.0) as u32;

        let mut rgba_data = vec![255u8; (out_w * out_h * 4) as usize];
        if x0 < bitmap_w && y0 < bitmap_h {
            let copy_cols = out_w.min(bitmap_w.saturating_sub(x0));
            let copy_rows = out_h.min(bitmap_h.saturating_sub(y0));
            let row_bytes = (copy_cols * 4) as usize;

            for row in 0..copy_rows {
                let src_start = (((y0 + row) * bitmap_w + x0) * 4) as usize;
                let src_end = src_start + row_bytes;
                let dst_start = ((row * out_w) * 4) as usize;
                let dst_end = dst_start + row_bytes;
                if src_end <= rgba_bytes.len() {
                    rgba_data[dst_start..dst_end].copy_from_slice(&rgba_bytes[src_start..src_end]);
                }
            }
        }

        let expected_len = (out_w as usize) * (out_h as usize) * 4;
        if rgba_data.len() != expected_len {
            return Err(format!(
                "PDFium returned an invalid tile buffer for page {page}: expected {expected_len} RGBA bytes ({out_w}x{out_h}), got {}",
                rgba_data.len()
            ));
        }

        Ok(tauri::ipc::Response::new(rgba_data))
    })
    .await
    .map_err(|e| format!("Tile worker task failed: {e}"))?
}

/// Warm the full-page bitmap cache for an off-screen page without paying the
/// cost of transferring its pixels to the webview. The frontend calls this from
/// an idle callback for the next page so scrolling lands on a ready bitmap.
#[tauri::command]
pub async fn prefetch_page(
    page: u32,
    px: u32,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let px = px.clamp(64, 2048);
    // Never fight a tile the user is actually waiting on: prefetch is idle work.
    if state
        .active_tile_renders
        .load(std::sync::atomic::Ordering::Acquire)
        > 0
    {
        return Ok(false);
    }
    let scale = (px as f64) / 512.0;
    let started = Instant::now();
    page_bitmap_for_scale(state.inner(), page, scale)?;
    if std::env::var_os("INKWELL_PROFILE_TILES").is_some() {
        eprintln!("[inkwell/tile] prefetched page {page} at scale {scale:.3} in {} ms", started.elapsed().as_millis());
    }
    Ok(true)
}

#[tauri::command]
pub async fn commit_stroke(
    sheet: usize,
    tool: String,
    rgb: [f64; 3],
    base_width: f64,
    samples: Vec<RawSampleInput>,
    client_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
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
        let _ = tx.send(WalOp::Append(WalEntry::Added { sheet, stroke }));
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
pub async fn delete_stroke(stroke_id_str: String, state: State<'_, AppState>) -> Result<bool, String> {
    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;

    let id = parse_stroke_id(&stroke_id_str);
    let removed = doc.remove_stroke(id);
    if removed {
        if let Some(tx) = state.wal.lock().unwrap().as_ref() {
            let _ = tx.send(WalOp::Append(WalEntry::Removed(id)));
        }
        state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(removed)
}

#[tauri::command]
pub async fn journal_image_mutation(
    op: String,
    image: Option<FrontendImage>,
    image_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
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
                }));
            }
        } else if op == "remove" || op == "delete" {
            if let Some(ref id) = image_id {
                let _ = tx.send(WalOp::Append(WalEntry::ImageRemoved { id: id.clone() }));
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
    state: State<'_, AppState>,
) -> Result<bool, String> {
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
                }));
            }
        } else if op == "remove" || op == "delete" {
            if let Some(ref id) = text_id {
                let _ = tx.send(WalOp::Append(WalEntry::TextRemoved { id: id.clone() }));
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
fn apply_frontend_payload(
    state: &AppState,
    images: Option<Vec<FrontendImage>>,
    strokes: Option<Vec<FrontendStroke>>,
    texts: Option<Vec<FrontendText>>,
    bookmarks: Option<Vec<inkwell_core::doc::Bookmark>>,
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

    Ok(())
}

#[tauri::command]
pub async fn save_pdf(
    out_path_str: Option<String>,
    images: Option<Vec<FrontendImage>>,
    strokes: Option<Vec<FrontendStroke>>,
    texts: Option<Vec<FrontendText>>,
    bookmarks: Option<Vec<inkwell_core::doc::Bookmark>>,
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
    let (norm_bytes, mut pdf_file) = match PdfFile::open(original_bytes.to_vec()) {
        Ok(f) => (None, f),
        Err(e) => {
            eprintln!("[inkwell] Base PDF requires normalisation for writing ({e:?})...");
            let pdfium_guard = state.pdfium.lock().unwrap();
            let pdfium = pdfium_guard.as_ref().ok_or_else(|| {
                format!("Failed to open base PDF ({e}) and PDFium is unavailable for normalisation.")
            })?;
            let nb = inkwell_pdf::normalise(pdfium, original_bytes)
                .map_err(|norm_err| format!("PDFium normalisation failed during save: {norm_err:?}"))?;
            let f = PdfFile::open(nb.clone())
                .map_err(|open_err| format!("Failed to parse normalised PDF for writing: {open_err}"))?;
            (Some(nb), f)
        }
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
    let file_option = tauri::async_runtime::spawn_blocking(move || {
        window.dialog()
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
        save_pdf(Some(path_str), images, strokes, texts, bookmarks, state).await
    } else {
        Err("CANCELLED".to_string())
    }
}

/// Re-order/renumber a document's sheets for a page-subset export so that sheet
/// `i` maps to page `i` of the freshly imported subset PDF.
fn remap_document_to_pages(document: &Document, pages: &[u32]) -> Document {
    let old_sheets = document.sheets.clone();
    let mut remapped = document.clone();
    remapped.sheets = pages
        .iter()
        .enumerate()
        .filter_map(|(new_index, old_index)| {
            let mut sheet = old_sheets.get(*old_index as usize)?.clone();
            sheet.kind = inkwell_core::doc::SheetKind::BoundedPage {
                source_pdf_page: new_index,
            };
            Some(sheet)
        })
        .collect();
    remapped
}

/// Build a new PDF containing only `pages` (0-based, in the given order) by
/// importing them through PDFium. Used by custom-range export so the exported
/// file never carries unselected pages.
fn build_page_subset_bytes(
    pdfium: &Pdfium,
    source_bytes: &[u8],
    pages: &[u32],
) -> Result<Vec<u8>, String> {
    let source = pdfium
        .load_pdf_from_byte_slice(source_bytes, None)
        .map_err(|e| format!("PDFium load error: {e:?}"))?;
    let page_count = source.pages().len();
    let mut spec_parts = Vec::new();
    for p in pages {
        if (*p as i32) < page_count {
            spec_parts.push((*p + 1).to_string());
        }
    }
    if spec_parts.is_empty() {
        return Err("No valid pages selected for export".to_string());
    }
    let mut dest = pdfium
        .create_new_pdf()
        .map_err(|e| format!("PDFium could not create the export document: {e:?}"))?;
    dest.pages_mut()
        .copy_pages_from_document(&source, &spec_parts.join(","), 0)
        .map_err(|e| format!("Failed to import selected pages into the export: {e:?}"))?;
    dest.save_to_bytes()
        .map_err(|e| format!("Failed to serialise the exported page subset: {e:?}"))
}

/// Export the live document without mutating the editing session.
///
/// * `selected_pages` — optional 0-based page subset (order preserved).
/// * `flatten` — omit the editable InkWell sidecar / `/Inkw_*` markers so the
///   output is a plain, standards-compliant vector PDF.
///
/// The live `pdf_bytes`, `original_pdf_bytes`, document path, WAL and dirty
/// flag are deliberately left untouched: an export must never corrupt or
/// re-point the session that is currently open.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_pdf_custom(
    out_path_str: String,
    images: Option<Vec<FrontendImage>>,
    strokes: Option<Vec<FrontendStroke>>,
    texts: Option<Vec<FrontendText>>,
    bookmarks: Option<Vec<inkwell_core::doc::Bookmark>>,
    selected_pages: Option<Vec<u32>>,
    flatten: Option<bool>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let path = PathBuf::from(&out_path_str);
    if out_path_str.contains("..") || path.components().any(|c| c == std::path::Component::ParentDir) {
        return Err("Path traversal components (..) are not permitted in the export path".to_string());
    }
    let is_pdf = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false);
    if !is_pdf {
        return Err("Invalid export path: destination file must have a .pdf extension".to_string());
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(format!("Parent directory does not exist: {parent:?}"));
        }
    }

    apply_frontend_payload(state.inner(), images, strokes, texts, bookmarks)?;

    let doc_guard = state.doc.lock().unwrap();
    let live_doc = doc_guard.as_ref().ok_or("No document open")?;
    let orig_guard = state.original_pdf_bytes.lock().unwrap();
    let original_bytes = orig_guard.as_ref().ok_or("No original PDF loaded")?;

    // Resolve the requested page subset (0-based, deduplicated, order preserved).
    let mut subset: Option<Vec<u32>> = None;
    if let Some(pages) = selected_pages.as_ref() {
        if !pages.is_empty() {
            let total_pages = live_doc.sheets.len() as u32;
            let mut cleaned: Vec<u32> = Vec::new();
            for p in pages {
                if *p < total_pages && !cleaned.contains(p) {
                    cleaned.push(*p);
                }
            }
            if cleaned.is_empty() {
                return Err("No valid pages selected for export".to_string());
            }
            let is_identity = cleaned.len() == total_pages as usize
                && cleaned.iter().enumerate().all(|(i, p)| *p == i as u32);
            if !is_identity {
                subset = Some(cleaned);
            }
        }
    }

    // Base bytes + (for a subset) a remapped document.
    let (base_bytes, export_doc_owned): (Vec<u8>, Option<Document>) = match subset {
        Some(pages) => {
            let pdfium_guard = state.pdfium.lock().unwrap();
            let pdfium = pdfium_guard
                .as_ref()
                .ok_or("PDFium is unavailable, so a custom page range cannot be exported")?;
            let bytes = build_page_subset_bytes(pdfium, original_bytes.as_slice(), &pages)?;
            drop(pdfium_guard);

            (bytes, Some(remap_document_to_pages(live_doc, &pages)))
        }
        None => (original_bytes.as_slice().to_vec(), None),
    };

    let (norm_bytes, mut pdf_file) = match PdfFile::open(base_bytes.clone()) {
        Ok(f) => (None, f),
        Err(e) => {
            eprintln!("[inkwell] Export base PDF requires normalisation ({e:?})...");
            let pdfium_guard = state.pdfium.lock().unwrap();
            let pdfium = pdfium_guard.as_ref().ok_or_else(|| {
                format!("Failed to open base PDF ({e}) and PDFium is unavailable for normalisation.")
            })?;
            let nb = inkwell_pdf::normalise(pdfium, &base_bytes)
                .map_err(|norm_err| format!("PDFium normalisation failed during export: {norm_err:?}"))?;
            let f = PdfFile::open(nb.clone())
                .map_err(|open_err| format!("Failed to parse normalised PDF for export: {open_err}"))?;
            (Some(nb), f)
        }
    };
    let _ = norm_bytes;

    let export_doc: &Document = export_doc_owned.as_ref().unwrap_or(live_doc);
    if flatten.unwrap_or(false) {
        pdf_file
            .write_document_flattened(export_doc, inkwell_core::pdf::DEFAULT_GROUP)
            .map_err(|e| format!("Failed to write flattened annotations: {e}"))?;
    } else {
        pdf_file
            .write_document(export_doc, inkwell_core::pdf::DEFAULT_GROUP)
            .map_err(|e| format!("Failed to write document annotations: {e}"))?;
    }

    let final_bytes = pdf_file.finish();
    atomic_write(&path, &final_bytes)
        .map_err(|e| format!("Failed atomic export to {:?}: {e}", path))?;

    // NOTE: intentionally no mutation of state.pdf_bytes / original_pdf_bytes /
    // pdf_path / WAL / is_dirty — an export never touches the live session.
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_pdf_custom_dialog(
    images: Option<Vec<FrontendImage>>,
    strokes: Option<Vec<FrontendStroke>>,
    texts: Option<Vec<FrontendText>>,
    bookmarks: Option<Vec<inkwell_core::doc::Bookmark>>,
    selected_pages: Option<Vec<u32>>,
    flatten: Option<bool>,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let default_name = {
        let current = state.pdf_path.lock().ok().and_then(|p| p.clone());
        let base = current
            .as_ref()
            .and_then(|p| p.file_stem())
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "InkWell Export".to_string());
        if flatten.unwrap_or(false) {
            format!("{base} (flattened).pdf")
        } else {
            format!("{base} (export).pdf")
        }
    };

    let file_option = tauri::async_runtime::spawn_blocking(move || {
        window.dialog()
            .file()
            .add_filter("PDF Document", &["pdf"])
            .set_file_name(&default_name)
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Some(path) = file_option {
        let path_buf = path.into_path().map_err(|e| e.to_string())?;
        let path_str = path_buf.to_string_lossy().to_string();
        export_pdf_custom(path_str, images, strokes, texts, bookmarks, selected_pages, flatten, state).await
    } else {
        Err("CANCELLED".to_string())
    }
}

#[tauri::command]
pub async fn erase_strokes_near(
    sheet: usize,
    px: f64,
    py: f64,
    radius: f64,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;
    let removed = doc.erase_strokes_near(sheet, px, py, radius);
    if !removed.is_empty() {
        if let Some(tx) = state.wal.lock().unwrap().as_ref() {
            for &id in &removed {
                let _ = tx.send(WalOp::Append(WalEntry::Removed(id)));
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
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let mut doc_guard = state.doc.lock().unwrap();
    let doc = doc_guard.as_mut().ok_or("No document open")?;
    let removed = doc.erase_strokes_in_rect(sheet, x0, y0, x1, y1);
    if !removed.is_empty() {
        if let Some(tx) = state.wal.lock().unwrap().as_ref() {
            for &id in &removed {
                let _ = tx.send(WalOp::Append(WalEntry::Removed(id)));
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

#[tauri::command]
pub async fn insert_blank_page(
    index: usize,
    width_pt: f64,
    height_pt: f64,
    state: State<'_, AppState>,
) -> Result<PageInfo, String> {
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
        }));
    }

    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);

    Ok(PageInfo {
        page_index: index,
        width_pt,
        height_pt,
        template: None,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResultItem {
    pub page_index: usize,
    pub snippet: String,
    pub match_count: usize,
}

#[tauri::command]
pub async fn search_pdf(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<SearchResultItem>, String> {
    let query_trimmed = query.trim();
    if query_trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let bytes = state
        .pdf_bytes
        .lock()
        .unwrap()
        .clone()
        .ok_or("No PDF loaded")?;

    let pdfium_guard = state.pdfium.lock().unwrap();
    let pdfium = pdfium_guard.as_ref().ok_or("PDFium not available")?;

    let doc = pdfium
        .load_pdf_from_byte_slice(&bytes, None)
        .map_err(|e| format!("PDFium load error: {e:?}"))?;

    let mut results = Vec::new();
    let q_lower = query_trimmed.to_lowercase();
    let n_pages = doc.pages().len() as usize;

    let q_chars: Vec<char> = q_lower.chars().collect();
    for i in 0..n_pages {
        let page_index = i as u32;
        // Reuse the memoized page text model: a full-document search must not
        // re-parse every page through PDFium on each keystroke.
        let data = match cached_page_text(state.inner(), page_index) {
            Some(cached) => cached,
            None => {
                let extracted = inkwell_pdf::extract_page_text_data(&doc, page_index);
                store_page_text(state.inner(), page_index, extracted)
            }
        };
        if data.text.is_empty() {
            continue;
        }

        let text_chars: Vec<char> = data.text.chars().collect();
        let text_lower: String = data.text.to_lowercase();
        let text_lower_chars: Vec<char> = text_lower.chars().collect();

        if !q_chars.is_empty() {
            if let Some(char_idx) = text_lower_chars.windows(q_chars.len()).position(|w| w == q_chars.as_slice()) {
                let start = char_idx.saturating_sub(40).min(text_chars.len());
                let end = (char_idx + q_chars.len() + 40).min(text_chars.len()).max(start);
                let snippet_str: String = text_chars[start..end].iter().collect();
                let snippet = format!(
                    "{}{}{}",
                    if start > 0 { "…" } else { "" },
                    snippet_str.replace('\n', " "),
                    if end < text_chars.len() { "…" } else { "" }
                );
                let match_count = text_lower_chars.windows(q_chars.len()).filter(|w| *w == q_chars.as_slice()).count();
                results.push(SearchResultItem {
                    page_index: i,
                    snippet,
                    match_count,
                });
            }
        }
    }

    Ok(results)
}

#[tauri::command]
pub async fn get_page_text_spans(
    page_index: usize,
    state: State<'_, AppState>,
) -> Result<Vec<inkwell_pdf::TextSpan>, String> {
    if let Some(cached) = cached_page_text(state.inner(), page_index as u32) {
        return Ok(cached.spans.clone());
    }

    let bytes_opt = state.pdf_bytes.lock().unwrap().clone();
    let Some(bytes) = bytes_opt else {
        return Ok(Vec::new());
    };

    let pdfium_guard = state.pdfium.lock().unwrap();
    let pdfium = pdfium_guard.as_ref().ok_or("PDFium not available")?;

    let doc = pdfium
        .load_pdf_from_byte_slice(&bytes, None)
        .map_err(|e| format!("PDFium load error: {e:?}"))?;

    let data = inkwell_pdf::extract_page_text_data(&doc, page_index as u32);
    let spans = data.spans.clone();
    store_page_text(state.inner(), page_index as u32, data);
    Ok(spans)
}

#[tauri::command]
pub async fn get_page_text_data(
    page_index: usize,
    state: State<'_, AppState>,
) -> Result<inkwell_pdf::PageTextData, String> {
    if let Some(cached) = cached_page_text(state.inner(), page_index as u32) {
        return Ok((*cached).clone());
    }

    let bytes_opt = state.pdf_bytes.lock().unwrap().clone();
    let Some(bytes) = bytes_opt else {
        return Ok(inkwell_pdf::PageTextData {
            page_index,
            text: String::new(),
            lines: Vec::new(),
            chars: Vec::new(),
            spans: Vec::new(),
        });
    };

    let pdfium_guard = state.pdfium.lock().unwrap();
    let pdfium = pdfium_guard.as_ref().ok_or("PDFium not available")?;

    let doc = pdfium
        .load_pdf_from_byte_slice(&bytes, None)
        .map_err(|e| format!("PDFium load error: {e:?}"))?;

    let data = inkwell_pdf::extract_page_text_data(&doc, page_index as u32);
    Ok((*store_page_text(state.inner(), page_index as u32, data)).clone())
}

#[tauri::command]
pub async fn get_pdf_outline(state: State<'_, AppState>) -> Result<Vec<inkwell_pdf::TocItem>, String> {
    let bytes = state
        .pdf_bytes
        .lock()
        .unwrap()
        .clone()
        .ok_or("No PDF loaded")?;

    let pdfium_guard = state.pdfium.lock().unwrap();
    let pdfium = pdfium_guard.as_ref().ok_or("PDFium not available")?;

    let doc = pdfium
        .load_pdf_from_byte_slice(&bytes, None)
        .map_err(|e| format!("PDFium load error: {e:?}"))?;

    Ok(inkwell_pdf::extract_outline(&doc))
}

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

#[tauri::command]
pub async fn delete_page(
    index: usize,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    {
        let doc_guard = state.doc.lock().unwrap();
        let doc = doc_guard.as_ref().ok_or("No document open")?;
        if doc.sheets.len() <= 1 || index >= doc.sheets.len() {
            return Err(format!("Cannot delete page {index} (page out of bounds or only remaining page)"));
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
        let _ = tx.send(WalOp::Append(WalEntry::PageDeleted { index }));
    }

    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(true)
}

#[tauri::command]
pub async fn duplicate_page(
    index: usize,
    state: State<'_, AppState>,
) -> Result<PageInfo, String> {
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
        }));
        for stroke in cloned_strokes {
            let _ = tx.send(WalOp::Append(WalEntry::Added { sheet: target_idx, stroke }));
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
            }));
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
            }));
        }
    }

    Ok(PageInfo {
        page_index: target_idx,
        width_pt: out_w,
        height_pt: out_h,
        template: cloned_template,
    })
}

#[tauri::command]
pub async fn rotate_page(
    index: usize,
    clockwise: bool,
    state: State<'_, AppState>,
) -> Result<PageInfo, String> {
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
        let _ = tx.send(WalOp::Append(WalEntry::PageRotated { index, clockwise }));
    }

    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);

    Ok(PageInfo {
        page_index: index,
        width_pt: out_w,
        height_pt: out_h,
        template: rot_template,
    })
}

#[tauri::command]
pub async fn reorder_page(
    from_index: usize,
    to_index: usize,
    state: State<'_, AppState>,
) -> Result<bool, String> {
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
        let _ = tx.send(WalOp::Append(WalEntry::PageReordered { from_index, to_index }));
    }

    state.is_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(true)
}

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

#[tauri::command]
pub fn check_pdfium_status(state: State<AppState>) -> bool {
    state.pdfium.lock().map(|guard| guard.is_some()).unwrap_or(false)
}


#[cfg(test)]
mod tile_pipeline_tests {
    use super::*;

    #[test]
    fn opaque_pixels_pass_through_unchanged() {
        let mut px = vec![12u8, 34, 56, 255, 200, 100, 50, 255];
        normalize_page_rgba_in_place(&mut px);
        assert_eq!(px, vec![12u8, 34, 56, 255, 200, 100, 50, 255]);
    }

    #[test]
    fn fully_transparent_pixels_become_white() {
        let mut px = vec![0u8, 0, 0, 0, 255, 255, 255, 0];
        normalize_page_rgba_in_place(&mut px);
        assert_eq!(px, vec![255u8; 8]);
    }

    #[test]
    fn partial_alpha_is_composited_over_white() {
        let mut px = vec![0u8, 0, 0, 128];
        normalize_page_rgba_in_place(&mut px);
        // 128/255 of black over white ≈ 127
        assert_eq!(px[3], 255);
        assert!((px[0] as i32 - 127).abs() <= 1, "got {}", px[0]);
        assert!((px[1] as i32 - 127).abs() <= 1, "got {}", px[1]);
        assert!((px[2] as i32 - 127).abs() <= 1, "got {}", px[2]);
    }

    #[test]
    fn trailing_bytes_without_a_full_pixel_are_ignored() {
        let mut px = vec![10u8, 20, 30, 255, 7];
        normalize_page_rgba_in_place(&mut px);
        assert_eq!(px, vec![10u8, 20, 30, 255, 7]);
    }
}

#[cfg(test)]
mod export_pipeline_tests {
    use super::*;

    fn count_bytes(hay: &[u8], needle: &[u8]) -> usize {
        if needle.is_empty() || hay.len() < needle.len() {
            return 0;
        }
        hay.windows(needle.len()).filter(|w| *w == needle).count()
    }

    /// PDFium is a process-global singleton, so tests that initialise it are
    /// serialised here and stay correct under `cargo test`'s default parallelism.
    static PDFIUM_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn pdfium_test_guard() -> std::sync::MutexGuard<'static, ()> {
        PDFIUM_TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn sample_doc(sheets: usize) -> Document {
        let mut doc = Document::default();
        for i in 0..sheets {
            let mut sheet = inkwell_core::doc::Sheet::bounded(i);
            sheet.kind = inkwell_core::doc::SheetKind::BoundedPage { source_pdf_page: i };
            doc.sheets.push(sheet);
        }
        doc
    }

    #[test]
    fn remap_reorders_and_renumbers_sheets() {
        let doc = sample_doc(5);
        let remapped = remap_document_to_pages(&doc, &[2, 0, 4]);
        assert_eq!(remapped.sheets.len(), 3);
        for (new_index, sheet) in remapped.sheets.iter().enumerate() {
            match sheet.kind {
                inkwell_core::doc::SheetKind::BoundedPage { source_pdf_page } => {
                    assert_eq!(source_pdf_page, new_index);
                }
                _ => panic!("expected bounded page"),
            }
        }
    }

    #[test]
    fn remap_ignores_out_of_range_pages() {
        let doc = sample_doc(3);
        let remapped = remap_document_to_pages(&doc, &[0, 99, 1]);
        assert_eq!(remapped.sheets.len(), 2);
    }

    #[test]
    fn page_subset_contains_only_the_selected_pages() {
        let _guard = pdfium_test_guard();
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../inkwell/fixtures/corpus/sample_multi_page.pdf"
        );
        let bytes = match std::fs::read(fixture) {
            Ok(b) => b,
            Err(_) => return, // fixture not present in this checkout
        };
        let pdfium = match inkwell_pdf::init_pdfium() {
            Ok(p) => p,
            Err(_) => return, // PDFium unavailable: graceful skip
        };
        let total = pdfium.load_pdf_from_byte_slice(&bytes, None).unwrap().pages().len();
        if total < 3 {
            return;
        }
        let subset = build_page_subset_bytes(&pdfium, &bytes, &[2, 0]).expect("subset");
        let out = pdfium.load_pdf_from_byte_slice(&subset, None).expect("reload subset");
        assert_eq!(out.pages().len(), 2, "subset must contain exactly the requested pages");
    }

    #[test]
    fn export_writes_real_annotations_onto_a_page_subset() {
        let _guard = pdfium_test_guard();
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../inkwell/fixtures/corpus/sample_multi_page.pdf"
        );
        let bytes = match std::fs::read(fixture) {
            Ok(b) => b,
            Err(_) => return,
        };
        let pdfium = match inkwell_pdf::init_pdfium() {
            Ok(p) => p,
            Err(_) => return,
        };
        let total = pdfium.load_pdf_from_byte_slice(&bytes, None).unwrap().pages().len();
        if total < 3 {
            return;
        }

        // Export pages [2, 0] with a stroke on the first exported sheet only.
        let subset = build_page_subset_bytes(&pdfium, &bytes, &[2, 0]).expect("subset");
        let mut doc = sample_doc(2);
        let brush = inkwell_core::Brush::default();
        let mut stroke = inkwell_core::Stroke::new(
            0x1234_5678,
            inkwell_core::ToolKind::Pen,
            [0.9, 0.1, 0.1],
            brush,
        );
        stroke.samples.push(inkwell_core::Sample::new(50.0, 60.0, 0.7, 0.0));
        stroke.samples.push(inkwell_core::Sample::new(110.0, 78.0, 0.75, 4.0));
        stroke.samples.push(inkwell_core::Sample::new(180.0, 90.0, 0.8, 8.0));
        doc.push_stroke(0, stroke);
        let remapped = remap_document_to_pages(&doc, &[0, 1]);

        let mut pdf_file = PdfFile::open(subset).expect("subset must open in the writer");
        assert_eq!(pdf_file.page_count(), 2, "subset must expose exactly two pages");
        pdf_file
            .write_document(&remapped, inkwell_core::pdf::DEFAULT_GROUP)
            .expect("annotations must write onto the subset");
        let out = pdf_file.finish();

        assert_eq!(
            count_bytes(&out, b"/Subtype /Ink"),
            1,
            "exactly the one exported stroke must be present"
        );
        assert_eq!(count_bytes(&out, b"/Type /Annot"), 1);
        assert_eq!(count_bytes(&out, b"/AP <<"), 1, "the ink needs an appearance stream");
        assert!(
            count_bytes(&out, b"/Inkw_Doc") >= 1,
            "an editable export keeps the InkWell sidecar marker"
        );
        assert!(out.ends_with(b"%%EOF\n"));
    }

    #[test]
    fn flattened_export_of_a_subset_has_no_editable_markers() {
        let _guard = pdfium_test_guard();
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../inkwell/fixtures/corpus/sample_multi_page.pdf"
        );
        let bytes = match std::fs::read(fixture) {
            Ok(b) => b,
            Err(_) => return,
        };
        let pdfium = match inkwell_pdf::init_pdfium() {
            Ok(p) => p,
            Err(_) => return,
        };
        let total = pdfium.load_pdf_from_byte_slice(&bytes, None).unwrap().pages().len();
        if total < 2 {
            return;
        }
        let subset = build_page_subset_bytes(&pdfium, &bytes, &[1, 0]).expect("subset");
        let doc = sample_doc(2);
        let mut pdf_file = PdfFile::open(subset).expect("subset must open in the writer");
        pdf_file
            .write_document_flattened(&doc, inkwell_core::pdf::DEFAULT_GROUP)
            .expect("flattened export");
        let out = pdf_file.finish();
        assert_eq!(
            count_bytes(&out, b"/Inkw_Doc"),
            0,
            "flattened export must not carry the editable sidecar marker"
        );
        assert_eq!(
            count_bytes(&out, b"/EmbeddedFiles"),
            0,
            "flattened export must not embed the editable sidecar"
        );
        assert_eq!(count_bytes(&out, b"/Subtype /Ink"), 0, "no strokes were supplied");
    }

    #[test]
    fn page_subset_is_a_standalone_parseable_pdf() {
        let _guard = pdfium_test_guard();
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../inkwell/fixtures/corpus/sample_simple.pdf"
        );
        let bytes = match std::fs::read(fixture) {
            Ok(b) => b,
            Err(_) => return,
        };
        let pdfium = match inkwell_pdf::init_pdfium() {
            Ok(p) => p,
            Err(_) => return,
        };
        let subset = build_page_subset_bytes(&pdfium, &bytes, &[0]).expect("subset");
        assert!(subset.starts_with(b"%PDF"), "exported subset must be a real PDF header");
        assert!(PdfFile::open(subset).is_ok(), "inkwell writer must be able to re-open the subset");
    }
}
