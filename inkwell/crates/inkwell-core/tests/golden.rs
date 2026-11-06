//! Plan 087: golden snapshots of the appended PDF generation.
//!
//! For fixed inputs, the bytes our writer appends (content streams inflated,
//! the binary sidecar replaced by its hash, the random trailer /ID masked)
//! are compared with `tests/golden/<case>.txt`. Any change to Layer 1/2/3
//! output shows up as a reviewable text diff.
//!
//! Regenerate after an intentional format change:
//!   UPDATE_GOLDEN=1 cargo test -p inkwell-core --test golden

use std::io::Read;

use flate2::read::ZlibDecoder;
use inkwell_core::doc::{Document, TextObject};
use inkwell_core::ink::{Brush, Sample, Stroke, ToolKind};
use inkwell_core::pdf::{self, PdfFile};
use sha2::{Digest, Sha256};

fn base() -> Vec<u8> {
    std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/lecture.pdf")).expect("fixture")
}

fn stroke(id: u128, kind: ToolKind, width: f64, pts: &[(f64, f64, f64)]) -> Stroke {
    Stroke {
        id,
        kind,
        rgb: [0.1, 0.2, 0.6],
        brush: Brush { base_width: width, ..Default::default() },
        samples: pts.iter().enumerate().map(|(i, &(x, y, p))| Sample::new(x, y, p, i as f64 * 4.0)).collect(),
    }
}

fn text(id: &str, s: &str, bold: bool, italic: bool) -> TextObject {
    TextObject {
        id: id.into(),
        sheet: 0,
        x: 90.0,
        y: 300.0,
        text: s.into(),
        font_size: 12.0,
        color: "#202040".into(),
        bold,
        italic,
        width: 200.0,
        height: 40.0,
    }
}

/// Render the appended generation as stable, human-readable text.
fn describe(base: &[u8], out: &[u8]) -> String {
    assert!(out.starts_with(base), "prefix invariant");
    let tail = &out[base.len()..];
    let xref_at = memchr::memmem::rfind(tail, b"\nxref\n").map(|i| i + 1).unwrap_or(tail.len());
    let (objects, trailer) = tail.split_at(xref_at);

    let mut s = String::new();
    let mut rest = objects;
    while let Some(end) = memchr::memmem::find(rest, b"\nendobj\n") {
        let obj = &rest[..end];
        rest = &rest[end + 8..];
        match memchr::memmem::find(obj, b"\nstream\n") {
            None => {
                s.push_str(String::from_utf8_lossy(obj).trim());
                s.push_str("\nendobj\n\n");
            }
            Some(si) => {
                let dict = String::from_utf8_lossy(&obj[..si]).into_owned();
                let mut payload = &obj[si + 8..];
                if let Some(e) = memchr::memmem::rfind(payload, b"\nendstream") {
                    payload = &payload[..e];
                }
                let data = if dict.contains("/FlateDecode") {
                    let mut v = Vec::new();
                    ZlibDecoder::new(payload).read_to_end(&mut v).expect("inflate");
                    v
                } else {
                    payload.to_vec()
                };
                // /Length is of the compressed bytes; it depends on the zlib
                // implementation, not on our format, so mask it.
                let dict = mask_length(&dict);
                s.push_str(dict.trim());
                s.push('\n');
                if dict.contains("/EmbeddedFile") {
                    s.push_str(&format!("<sidecar {} bytes sha256={:x}>\n", data.len(), Sha256::digest(&data)));
                } else if data.is_ascii() || std::str::from_utf8(&data).is_ok() {
                    // Content streams are text; escape stray high bytes so a
                    // wrong string encoding shows up in the diff, not as a hash.
                    for line in data.split_inclusive(|&b| b == b'\n') {
                        s.push_str(&line.escape_ascii().to_string().replace("\\n", "\n"));
                    }
                    if !data.ends_with(b"\n") {
                        s.push('\n');
                    }
                } else {
                    s.push_str(&format!("<binary {} bytes sha256={:x}>\n", data.len(), Sha256::digest(&data)));
                }
                s.push_str("endstream\nendobj\n\n");
            }
        }
    }
    // Keep the trailer dictionary (minus the time-derived /ID), drop offsets.
    let tr = String::from_utf8_lossy(trailer);
    if let Some(i) = tr.find("trailer") {
        let t = &tr[i..];
        let t = t.split("startxref").next().unwrap_or(t);
        let masked = match (t.find("/ID"), t.rfind(']')) {
            (Some(a), Some(b)) if b > a => format!("{}/ID <masked>{}", &t[..a], &t[b + 1..]),
            _ => t.to_string(),
        };
        s.push_str(masked.trim());
        s.push('\n');
    }
    s
}

fn mask_length(dict: &str) -> String {
    match dict.find("/Length ") {
        Some(i) => {
            let rest = &dict[i + 8..];
            let n = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
            format!("{}/Length <n>{}", &dict[..i], &rest[n..])
        }
        None => dict.to_string(),
    }
}

fn check(case: &str, d: &Document) {
    let base = base();
    let mut f = PdfFile::open(base.clone()).expect("open");
    f.write_document(d, pdf::DEFAULT_GROUP).expect("write");
    let got = describe(&base, &f.finish());

    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden").join(format!("{case}.txt"));
    if std::env::var("UPDATE_GOLDEN").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &got).unwrap();
        return;
    }
    let want = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("missing {path:?}; run with UPDATE_GOLDEN=1 to create it"));
    if got != want {
        let first = got.lines().zip(want.lines()).position(|(a, b)| a != b).unwrap_or(0);
        panic!(
            "golden mismatch for {case} at line {}:\n  want: {}\n  got:  {}\n(run UPDATE_GOLDEN=1 if intentional, then review the diff)",
            first + 1,
            want.lines().nth(first).unwrap_or("<eof>"),
            got.lines().nth(first).unwrap_or("<eof>"),
        );
    }
}

fn doc_with(strokes: Vec<Stroke>, texts: Vec<TextObject>) -> Document {
    let mut d = Document::for_pdf(1);
    for s in strokes {
        d.push_stroke(0, s);
    }
    for t in texts {
        d.upsert_text(0, t);
    }
    d.generation = 1;
    d
}

#[test]
fn golden_single_dot() {
    check("single_dot", &doc_with(vec![stroke(1, ToolKind::Pen, 4.0, &[(200.0, 200.0, 0.7)])], vec![]));
}

#[test]
fn golden_two_point_highlighter() {
    // Regression guard for the flat-quad fix in commit 88600be.
    let s = stroke(2, ToolKind::Highlighter, 14.0, &[(100.0, 400.0, 0.5), (300.0, 400.0, 0.5)]);
    check("two_point_highlighter", &doc_with(vec![s], vec![]));
}

#[test]
fn golden_axis_aligned_rect() {
    let pts = [(100.0, 100.0, 0.5), (300.0, 100.0, 0.5), (300.0, 250.0, 0.5), (100.0, 250.0, 0.5), (100.0, 100.0, 0.5)];
    check("axis_aligned_rect", &doc_with(vec![stroke(3, ToolKind::Pen, 2.0, &pts)], vec![]));
}

#[test]
fn golden_long_scribble() {
    let pts: Vec<(f64, f64, f64)> = (0..700)
        .map(|i| {
            let t = i as f64 / 699.0;
            (60.0 + t * 450.0, 500.0 + 30.0 * (t * 40.0).sin(), 0.2 + 0.7 * (t * 9.0).sin().abs())
        })
        .collect();
    check("long_scribble", &doc_with(vec![stroke(4, ToolKind::Pen, 2.6, &pts)], vec![]));
}

#[test]
fn golden_text_styles() {
    let texts = vec![
        text("txt_regular", "Regular (with parens) \\ backslash", false, false),
        text("txt_bold", "Bold", true, false),
        text("txt_italic", "Italic", false, true),
        text("txt_bolditalic", "Bold italic", true, true),
    ];
    check("text_styles", &doc_with(vec![], texts));
}

#[test]
fn golden_non_ascii_text() {
    // Records today's behaviour (UTF-8 bytes in a WinAnsi font). Plan 089
    // replaces this appearance with shaped glyph outlines; this snapshot is
    // expected to change then.
    check("non_ascii_text", &doc_with(vec![], vec![text("txt_bn", "café বাংলা", false, false)]));
}
