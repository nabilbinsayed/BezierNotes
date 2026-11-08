use std::sync::{Arc, Mutex};
use std::sync::mpsc::Sender;
use std::collections::HashMap;
use inkwell_core::{Document, wal::WalEntry};
use std::path::PathBuf;
use inkwell_pdf::Pdfium;

pub enum WalOp {
    /// An entry plus the frontend journal sequence number it was sent with.
    Append(WalEntry, u64),
    Truncate(Option<std::sync::mpsc::SyncSender<()>>),
    Discard(Option<std::sync::mpsc::SyncSender<()>>),
    /// After a save: drop the records its snapshot covered (seq <= n).
    TruncateThrough(u64, Option<std::sync::mpsc::SyncSender<()>>),
    /// "Don't Save" on quit: close the journal and set it aside (renamed, not
    /// deleted) so the next open of the document can offer to restore it.
    Shelve(Option<std::sync::mpsc::SyncSender<()>>),
    Close,
}

pub struct CachedPageBitmap {
    pub page: u32,
    pub target_w: i32,
    pub target_h: i32,
    /// Normalized, opaque RGBA pixels (alpha already composited over white), so
    /// tile crops are plain row memcpys on every cache hit.
    pub rgba_bytes: Arc<Vec<u8>>,
    pub bitmap_w: u32,
    pub bitmap_h: u32,
}

pub struct PageBitmapLruCache {
    pub entries: Vec<CachedPageBitmap>,
    pub max_entries: usize,
    pub current_bytes: usize,
    pub max_bytes: usize,
}

impl PageBitmapLruCache {
    pub fn new(max_entries: usize) -> Self {
        Self {
            entries: Vec::with_capacity(max_entries),
            max_entries,
            current_bytes: 0,
            max_bytes: 256 * 1024 * 1024, // 256 MB budget
        }
    }

    pub fn get(&mut self, page: u32, target_w: i32, target_h: i32) -> Option<(Arc<Vec<u8>>, u32, u32)> {
        if let Some(pos) = self.entries.iter().position(|c| c.page == page && c.target_w == target_w && c.target_h == target_h) {
            let item = self.entries.remove(pos);
            let res = (item.rgba_bytes.clone(), item.bitmap_w, item.bitmap_h);
            self.entries.push(item);
            Some(res)
        } else {
            None
        }
    }

    pub fn put(&mut self, entry: CachedPageBitmap) {
        if let Some(pos) = self.entries.iter().position(|c| c.page == entry.page && c.target_w == entry.target_w && c.target_h == entry.target_h) {
            let old = self.entries.remove(pos);
            self.current_bytes = self.current_bytes.saturating_sub(old.rgba_bytes.len());
        }
        let new_bytes = entry.rgba_bytes.len();
        while !self.entries.is_empty() && (self.current_bytes + new_bytes > self.max_bytes || self.entries.len() >= self.max_entries) {
            let evicted = self.entries.remove(0);
            self.current_bytes = self.current_bytes.saturating_sub(evicted.rgba_bytes.len());
        }
        self.current_bytes += new_bytes;
        self.entries.push(entry);
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.current_bytes = 0;
    }
}

pub struct DocumentSession {
    pub doc: Document,
    pub pdf_path: Option<PathBuf>,
    pub pdf_bytes: Option<Arc<Vec<u8>>>,
    pub original_pdf_bytes: Option<Arc<Vec<u8>>>,
    pub wal: Option<Sender<WalOp>>,
    pub page_bitmap_cache: PageBitmapLruCache,
    pub page_dimensions: HashMap<u32, (f64, f64)>,
}

pub struct AppState {
    pub doc: Mutex<Option<Document>>,
    pub pdf_path: Mutex<Option<PathBuf>>,
    pub pdf_bytes: Mutex<Option<Arc<Vec<u8>>>>,
    /// Pristine bytes from the originally opened file. Never mutated by save
    /// cycles. Used as the base for image embedding to prevent compounding
    /// duplicate image objects across repeated saves.
    pub original_pdf_bytes: Mutex<Option<Arc<Vec<u8>>>>,
    pub wal: Mutex<Option<Sender<WalOp>>>,
    /// Cached PDFium instance — initialized once at startup.
    /// All commands borrow this instead of calling init_pdfium() per call.
    pub pdfium: Mutex<Option<Pdfium>>,
    /// Multi-page in-memory LRU cache for rendered full-page PDFium bitmaps
    /// to avoid redundant page rasterization across tiles on active/split/adjacent pages.
    pub page_bitmap_cache: Mutex<PageBitmapLruCache>,
    /// Memoized per-page text model (chars, lines, spans) so text selection,
    /// span lookups and full-document search never re-parse the PDF.
    pub page_text_cache: Mutex<HashMap<u32, Arc<inkwell_pdf::text::PageTextData>>>,
    /// Number of in-flight visible-tile renders. Idle page prefetch checks this
    /// and yields immediately so it can never stall a tile the user is waiting on.
    pub active_tile_renders: std::sync::atomic::AtomicUsize,
    /// Pre-extracted page dimensions (width_pt, height_pt) for instant tile bounds calculation.
    pub page_dimensions: Mutex<HashMap<u32, (f64, f64)>>,
    /// Snapshot of the on-disk (modified_time, file_len) of the open document.
    /// Used to detect changes made by cloud sync or other applications.
    pub doc_disk_stamp: Mutex<Option<(std::time::SystemTime, u64)>>,
    /// Multi-document session map for tab switching and isolation
    pub sessions: Mutex<HashMap<String, DocumentSession>>,
    pub active_session_id: Mutex<Option<String>>,
    pub is_dirty: std::sync::atomic::AtomicBool,
    /// Incremented when a save starts. A save whose number is no longer the
    /// latest skips its disk write, so an older snapshot can never land on
    /// disk after a newer one.
    pub save_generation: std::sync::atomic::AtomicU64,
    /// Held from a save's snapshot to its publish, and by page edits, so
    /// the two never interleave. Inking does not take it.
    pub save_lock: Mutex<()>,
    /// Highest frontend journal sequence number seen. A save leaves the
    /// document dirty when this has moved past its snapshot.
    pub journal_seq_hi: std::sync::atomic::AtomicU64,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            doc: Mutex::new(None),
            pdf_path: Mutex::new(None),
            pdf_bytes: Mutex::new(None),
            original_pdf_bytes: Mutex::new(None),
            wal: Mutex::new(None),
            pdfium: Mutex::new(None),
            page_bitmap_cache: Mutex::new(PageBitmapLruCache::new(16)),
            page_text_cache: Mutex::new(HashMap::new()),
            active_tile_renders: std::sync::atomic::AtomicUsize::new(0),
            page_dimensions: Mutex::new(HashMap::new()),
            doc_disk_stamp: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            active_session_id: Mutex::new(None),
            is_dirty: std::sync::atomic::AtomicBool::new(false),
            save_generation: std::sync::atomic::AtomicU64::new(0),
            save_lock: Mutex::new(()),
            journal_seq_hi: std::sync::atomic::AtomicU64::new(0),
        }
    }
}

impl AppState {
    /// Remember the current on-disk stamp for `path` so our own save/load can
    /// never be reported back to the user as an external modification.
    pub fn record_disk_stamp(&self, path: &std::path::Path) {
        let stamp = disk_stamp_for(path);
        if let Ok(mut guard) = self.doc_disk_stamp.lock() {
            *guard = stamp;
        }
    }

    /// Clear the tracked disk stamp (no document open).
    pub fn clear_disk_stamp(&self) {
        if let Ok(mut guard) = self.doc_disk_stamp.lock() {
            *guard = None;
        }
    }

    /// Drop every derived per-page cache (rasterized bitmaps + extracted text).
    /// Must be called on document load, page insertion/deletion/rotation and
    /// session switches so no stale page content can ever be served.
    pub fn clear_page_caches(&self) {
        if let Ok(mut cache) = self.page_bitmap_cache.lock() {
            cache.clear();
        }
        if let Ok(mut cache) = self.page_text_cache.lock() {
            cache.clear();
        }
    }
}

/// Current `(modified_time, file_len)` stamp for `path`, or `None` when the
/// file is missing/unreadable. Used to detect out-of-band modifications.
pub fn disk_stamp_for(path: &std::path::Path) -> Option<(std::time::SystemTime, u64)> {
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.modified().ok()?, metadata.len()))
}

#[cfg(test)]
mod disk_stamp_tests {
    use super::*;

    #[test]
    fn stamp_changes_when_the_file_is_modified_externally() {
        let dir = std::env::temp_dir().join(format!("inkwell-stamp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("document.pdf");
        std::fs::write(&path, b"%PDF-1.4\n").expect("write");
        let first = disk_stamp_for(&path).expect("first stamp");

        std::fs::write(&path, b"%PDF-1.4\n% externally changed\n").expect("rewrite");
        let second = disk_stamp_for(&path).expect("second stamp");
        assert_ne!(first, second, "an external write must change the stamp");

        // Stabilises once nothing else touches the file.
        let third = disk_stamp_for(&path).expect("third stamp");
        assert_eq!(second, third);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_files_have_no_stamp() {
        let path = std::env::temp_dir().join("inkwell-definitely-missing-stamp.pdf");
        let _ = std::fs::remove_file(&path);
        assert!(disk_stamp_for(&path).is_none());
    }
}
