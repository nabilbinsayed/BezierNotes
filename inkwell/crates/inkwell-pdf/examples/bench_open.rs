//! Profiling harness for the PDF open path: page-box lookup, sidecar parsing,
//! PDFium load, full-page rasterisation and the fast page-size API.
//!
//! Run with `cargo run -q -p inkwell-pdf --example bench_open -- <file.pdf>`.

use std::time::Instant;
use pdfium_render::prelude::*;

fn main() {
    let path = std::env::args().nth(1).expect("usage: bench_open <pdf>");
    let t0 = Instant::now();
    let bytes = std::fs::read(&path).expect("read");
    println!("read             {:8.1} ms  {} bytes", t0.elapsed().as_secs_f64()*1000.0, bytes.len());

    let t = Instant::now();
    let pdfium = inkwell_pdf::init_pdfium().expect("pdfium");
    println!("init pdfium      {:8.1} ms", t.elapsed().as_secs_f64()*1000.0);

    let t = Instant::now();
    let doc = pdfium.load_pdf_from_byte_slice(&bytes, None).expect("load");
    println!("load document    {:8.1} ms  {} pages", t.elapsed().as_secs_f64()*1000.0, doc.pages().len());

    let t = Instant::now();
    let mut dims = Vec::new();
    for i in 0..doc.pages().len() {
        let p = doc.pages().page_size(i).expect("page size");
        dims.push((p.width().value, p.height().value));
    }
    println!("page sizes fast  {:8.1} ms  first={:?}", t.elapsed().as_secs_f64()*1000.0, dims.first());

    let t = Instant::now();
    let mut dims_slow = Vec::new();
    for i in 0..doc.pages().len() {
        let p = doc.pages().get(i).expect("page");
        dims_slow.push((p.width().value, p.height().value));
    }
    println!("page loads slow  {:8.1} ms  first={:?}", t.elapsed().as_secs_f64()*1000.0, dims_slow.first());

    let t = Instant::now();
    let trailer = inkwell_core::pdfobj::last_trailer_dict(&bytes);
    println!("sidecar trailer  {:8.1} ms  {:?}", t.elapsed().as_secs_f64()*1000.0, trailer.as_ref().map(|_| "ok"));
    let root = trailer.as_ref().ok().and_then(|tr| inkwell_core::pdfobj::dict_get(&bytes, *tr, "/Root").and_then(|r| inkwell_core::pdfobj::as_ref_num(&bytes, r)));
    let t = Instant::now();
    let root_obj = root.and_then(|n| inkwell_core::pdfobj::find_object(&bytes, n));
    println!("sidecar root obj {:8.1} ms  found={}", t.elapsed().as_secs_f64()*1000.0, root_obj.is_some());

    let t = Instant::now();
    match inkwell_core::pdf::read_sidecar(&bytes) {
        Ok(inkwell_core::pdf::SidecarStatus::Ok(d)) | Ok(inkwell_core::pdf::SidecarStatus::Stale(d)) => {
            println!("read sidecar     {:8.1} ms  strokes={}", t.elapsed().as_secs_f64()*1000.0, d.stroke_count());
        }
        other => println!("read sidecar     {:8.1} ms  status={:?}", t.elapsed().as_secs_f64()*1000.0, other.map(|_| "none").map_err(|e| e.to_string())),
    }

    let t = Instant::now();
    let outline = inkwell_pdf::extract_outline(&doc);
    println!("extract outline  {:8.1} ms  nodes={}", t.elapsed().as_secs_f64()*1000.0, outline.len());
    drop(doc);

    // Simulate current render_tile behavior: reload the whole document before
    // rendering the first tile of a page.
    for &page_index in &[0usize, 1, 5, 10, 20] {
        if page_index >= dims.len() { continue; }
        let t = Instant::now();
        let d = pdfium.load_pdf_from_byte_slice(&bytes, None).expect("load2");
        let load_ms = t.elapsed().as_secs_f64()*1000.0;
        let t2 = Instant::now();
        let page = d.pages().get(page_index as i32).expect("page2");
        let (w, h) = dims[page_index];
        let config = PdfRenderConfig::new()
            .set_target_width((w*1.0).round() as i32)
            .set_maximum_height((h*1.0).round() as i32)
            .set_clear_color(PdfColor::WHITE)
            .render_annotations(true);
        let bmp = page.render_with_config(&config).expect("render");
        println!("page {:>2} reload {:7.1} ms render {:7.1} ms  {}x{}", page_index,
            load_ms, t2.elapsed().as_secs_f64()*1000.0, bmp.width(), bmp.height());
    }
}
