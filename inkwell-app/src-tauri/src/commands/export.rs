//! Exporting copies: page ranges, flattening, and the export dialogs. Never mutates the live session.

use super::*;

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
    shapes: Option<Vec<inkwell_core::shape::ShapeObject>>,
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

    apply_frontend_payload(state.inner(), images, strokes, texts, bookmarks, shapes)?;

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

    // An export is a new file, so a repaired base needs no backup.
    let (_repaired, mut pdf_file) = open_writable_base(state.inner(), &base_bytes)?;

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
    shapes: Option<Vec<inkwell_core::shape::ShapeObject>>,
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
        export_pdf_custom(path_str, images, strokes, texts, bookmarks, shapes, selected_pages, flatten, state).await
    } else {
        Err("CANCELLED".to_string())
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
