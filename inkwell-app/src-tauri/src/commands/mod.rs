use crate::state::{disk_stamp_for, AppState, CachedPageBitmap, WalOp};
use serde::{Deserialize, Serialize};
use tauri::State;
use std::sync::Arc;
use std::path::{Path, PathBuf};
use std::time::Instant;
use pdfium_render::prelude::*;
use inkwell_core::{Document, Sample, Stroke, ToolKind, Brush, PdfFile, SidecarStatus, wal::{atomic_write, Wal, WalEntry}};
use tauri_plugin_dialog::DialogExt;

// One module per area; each child does `use super::*` so the shared
// helpers and DTOs below stay private to `commands`.
pub mod open;
pub mod render;
pub mod ink;
pub mod save;
pub mod export;
pub mod pages;
pub mod text;
pub mod session;
pub mod window;
pub mod merge;
pub mod forms;

// Helpers shared between sibling modules.
use ink::apply_frontend_payload;
use save::{open_writable_base, rebased_original};

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
        let mut shelve_ack = None;
        while let Ok(op) = rx.recv() {
            match op {
                WalOp::Append(entry, seq) => {
                    if let Err(e) = wal.append_seq(&entry, seq) {
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
                WalOp::TruncateThrough(seq, ack) => {
                    if let Err(e) = wal.truncate_through(seq) {
                        eprintln!("[inkwell] Background WAL trim error: {e}");
                    }
                    if let Some(sender) = ack {
                        let _ = sender.send(());
                    }
                }
                WalOp::Shelve(ack) => {
                    shelve_ack = Some(ack);
                    break;
                }
                WalOp::Close => break,
            }
        }
        if let Some(ack) = shelve_ack {
            // Close the handle first: Windows cannot rename an open file.
            let path = wal.path().to_path_buf();
            drop(wal);
            let shelved = shelved_wal_path(&path);
            if let Err(e) = std::fs::rename(&path, &shelved) {
                eprintln!("[inkwell] Could not set the journal aside ({path:?} -> {shelved:?}): {e}");
            }
            if let Some(sender) = ack {
                let _ = sender.send(());
            }
        }
    });
    tx
}

/// The journal sequence number for an edit: the frontend numbers every
/// journalled mutation (`core/ipc.js`), and a save trims only the records its
/// snapshot covers. Calls without one (older callers) count as "now".
fn journal_seq(state: &AppState, seq: Option<u64>) -> u64 {
    use std::sync::atomic::Ordering;
    match seq {
        Some(s) => {
            state.journal_seq_hi.fetch_max(s, Ordering::AcqRel);
            s
        }
        None => state.journal_seq_hi.load(Ordering::Acquire),
    }
}

/// Where "Don't Save" puts a session's journal: next to the live journal,
/// out of the sync folder, offered back on the next open (see `open_pdf`).
fn shelved_wal_path(wal_path: &Path) -> PathBuf {
    wal_path.with_extension("shelved.bin")
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
        // %LOCALAPPDATA%, not %TEMP%: Storage Sense and cleanup tools purge
        // %TEMP%, which is exactly where a crash journal must survive.
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("BezierNotes")
            .join("wal");
        let _ = std::fs::create_dir_all(&base);
        let target = base.join(&filename);
        // One-time migration of a journal written by an older build.
        let legacy = std::env::temp_dir().join(&filename);
        if !target.exists() && legacy.exists() && std::fs::rename(&legacy, &target).is_err() {
            if std::fs::copy(&legacy, &target).is_ok() {
                let _ = std::fs::remove_file(&legacy);
            }
        }
        target
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
    /// Parametric shapes (Plan 095).
    #[serde(default)]
    pub loaded_shapes: Vec<inkwell_core::shape::ShapeObject>,
    pub outline: Vec<inkwell_pdf::TocItem>,
    #[serde(default)]
    pub bookmarks: Vec<inkwell_core::doc::Bookmark>,
    /// Records in a journal set aside by "Don't Save" on quit (Plan 090).
    #[serde(default)]
    pub shelved_journal_entries: usize,
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
