//! Plan 097: infinite canvas sheets are tiled into real pages on save.

use inkwell_core::doc::{Document, Sheet, SheetKind};
use inkwell_core::ink::{Brush, Stroke, StrokeBuilder, ToolKind};
use inkwell_core::pdf::{self, PdfFile, SidecarStatus, CANVAS_TILE};

fn base() -> Vec<u8> {
    std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/corpus/sample_multi_page.pdf")).unwrap()
}

fn line(id: u128, pts: &[(f64, f64)]) -> Stroke {
    let mut b = StrokeBuilder::new(id, ToolKind::Pen, [0.1, 0.1, 0.5], Brush { base_width: 4.0, ..Default::default() }, false);
    for (i, (x, y)) in pts.iter().enumerate() {
        b.push(*x, *y, 0.8, i as f64 * 8.0);
    }
    b.finish(0.0)
}

/// A document with its PDF pages plus one canvas whose ink touches all
/// tiles of a 3 x 2 grid.
fn doc_with_canvas() -> Document {
    let n = PdfFile::open(base()).unwrap().page_count();
    let mut d = Document::for_pdf(n);
    d.sheets.push(Sheet::canvas());
    let ci = d.sheets.len() - 1;
    let (w, h) = CANVAS_TILE;
    let mut id = 1;
    for row in 0..2 {
        for col in 0..3 {
            let (x, y) = (col as f64 * w + 100.0, row as f64 * h + 100.0);
            d.push_stroke(ci, line(id, &[(x, y), (x + 200.0, y + 50.0), (x + 300.0, y + 300.0)]));
            id += 1;
        }
    }
    d
}

fn save(base: &[u8], d: &Document) -> Vec<u8> {
    let mut f = PdfFile::open(base.to_vec()).unwrap();
    f.write_document(d, pdf::DEFAULT_GROUP).unwrap();
    f.finish()
}

fn qpdf_ok(bytes: &[u8]) -> Option<bool> {
    use std::process::Command;
    Command::new("qpdf").arg("--version").output().ok().filter(|o| o.status.success())?;
    let dir = tempfile::tempdir().ok()?;
    let p = dir.path().join("c.pdf");
    std::fs::write(&p, bytes).ok()?;
    Some(Command::new("qpdf").arg("--check").arg(&p).output().ok()?.status.success())
}

#[test]
fn a_3_by_2_canvas_saves_as_6_extra_valid_pages() {
    let b = base();
    let n = PdfFile::open(b.clone()).unwrap().page_count();
    let out = save(&b, &doc_with_canvas());
    assert!(out.starts_with(&b));
    if let Some(ok) = qpdf_ok(&out) {
        assert!(ok, "qpdf --check");
    }
    let f = PdfFile::open(out.clone()).unwrap();
    assert_eq!(f.page_count(), n + 6);
    assert_eq!(f.real_page_count(), n, "tiles are not the document's own pages");
    assert_eq!(String::from_utf8_lossy(&out).matches("/Inkw_CanvasTile").count(), 6);
}

#[test]
fn the_canvas_reopens_as_one_editable_sheet_and_resaving_does_not_stack() {
    let b = base();
    let d = doc_with_canvas();
    let out = save(&b, &d);
    let SidecarStatus::Ok(back) = pdf::read_sidecar(&out).unwrap() else { panic!() };
    let canvas = back.sheets.iter().find(|s| s.kind == SheetKind::FreeCanvas).expect("canvas sheet");
    assert_eq!(canvas.stroke_count(), 6);
    let again = save(pdf::writable_base(&out), &back);
    assert_eq!(PdfFile::open(again).unwrap().page_count(), PdfFile::open(b).unwrap().page_count() + 6);
}

#[test]
fn erasing_all_ink_removes_the_tiles() {
    let b = base();
    let n = PdfFile::open(b.clone()).unwrap().page_count();
    let out = save(&b, &doc_with_canvas());
    let mut empty = doc_with_canvas();
    for s in &mut empty.sheets {
        for l in &mut s.layers {
            l.strokes.clear();
        }
    }
    // rebased (the usual save), and also on top of a file whose base holds
    // tiles (what a PDFium page operation can leave): no orphan pages either way
    assert_eq!(PdfFile::open(save(pdf::writable_base(&out), &empty)).unwrap().page_count(), n);
    assert_eq!(PdfFile::open(save(&out, &empty)).unwrap().page_count(), n);
}

#[test]
fn canvas_content_at_negative_coordinates_still_gets_a_page() {
    let mut d = Document::for_pdf(PdfFile::open(base()).unwrap().page_count());
    d.sheets.push(Sheet::canvas());
    let ci = d.sheets.len() - 1;
    d.push_stroke(ci, line(9, &[(-300.0, -200.0), (-100.0, -50.0)]));
    let out = save(&base(), &d);
    let f = PdfFile::open(out).unwrap();
    assert_eq!(f.page_count() - f.real_page_count(), 1);
}
