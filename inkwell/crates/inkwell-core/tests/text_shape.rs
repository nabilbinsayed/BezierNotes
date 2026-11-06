//! Plan 089: shaped vector glyph appearances for text notes.

use inkwell_core::doc::{Document, TextObject};
use inkwell_core::pdf::{self, PdfFile};
use inkwell_core::pdfobj as po;
use inkwell_core::text_shape;

/// Widths Chromium's canvas reports for the app's font stack
/// (`Inter, "Noto Sans Bengali"`), measured with Chromium 2026-11 on the
/// bundled fonts. Chrome shapes with HarfBuzz, so agreeing on width also
/// checks that rustybuzz shaped the same glyphs (conjuncts, kerning).
const CHROME_WIDTHS: &[(&str, f64, bool, bool, f64)] = &[
    ("café Ünïcödé — naïve façade (x²)", 18.0, false, false, 280.735),
    ("Hello, world", 12.0, false, false, 67.512),
    ("Bold heading", 24.0, true, false, 148.247),
    ("Italic text", 16.0, false, true, 68.391),
    ("বাংলা গণিত: ক্ষ ক্ত স্ত্র কি কৌ", 18.0, false, false, 205.171),
    ("সেকেন্ড লাইন", 14.0, true, false, 76.969),
    ("Mixed এবং text", 16.0, false, false, 110.652),
];

#[test]
fn line_widths_match_the_app_canvas() {
    for &(text, size, bold, italic, chrome) in CHROME_WIDTHS {
        let ours = text_shape::line_width(text, size, bold, italic);
        let err = (ours - chrome).abs() / chrome;
        assert!(err < 0.005, "{text:?} @{size}: ours {ours:.3} vs Chrome {chrome:.3} ({:.2}% off)", err * 100.0);
    }
}

#[test]
fn baseline_matches_chrome_text_baseline_top() {
    // Chromium puts the alphabetic baseline 80.0625 px below `top` at 100 px.
    assert!((text_shape::baseline_ratio() - 0.800_625).abs() < 0.001, "{}", text_shape::baseline_ratio());
}

#[test]
fn bengali_conjuncts_and_reordering_are_shaped() {
    // ক্ষ (KA + VIRAMA + SSA) is one conjunct glyph, not three.
    let runs = text_shape::shaped_glyphs("ক্ষ");
    assert_eq!(runs.len(), 1);
    assert!(runs[0].0, "Bengali text must use the Bengali face");
    assert_eq!(runs[0].1.len(), 1, "conjunct should form a single glyph: {:?}", runs[0].1);

    // কি: the I-sign is typed after KA but drawn before it.
    let ki = &text_shape::shaped_glyphs("কি")[0].1;
    let ka = &text_shape::shaped_glyphs("ক")[0].1;
    assert_eq!(ki.len(), 2);
    assert_eq!(ki[1], ka[0], "KA must come second after reordering: {ki:?}");
}

#[test]
fn runs_split_by_script_with_spaces_in_the_primary_face() {
    let runs = text_shape::shaped_glyphs("Bold এবং mix");
    let kinds: Vec<bool> = runs.iter().map(|r| r.0).collect();
    assert_eq!(kinds, vec![false, true, false], "Latin, Bengali, Latin");
}

fn save_note(text: &str, bold: bool, italic: bool) -> Vec<u8> {
    let base = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/lecture.pdf")).unwrap();
    let mut d = Document::for_pdf(1);
    d.upsert_text(
        0,
        TextObject {
            id: "txt_t".into(),
            sheet: 0,
            x: 50.0,
            y: 60.0,
            text: text.into(),
            font_size: 14.0,
            color: "#102030".into(),
            bold,
            italic,
            width: 40.0,
            height: 20.0,
        },
    );
    let mut f = PdfFile::open(base).unwrap();
    f.write_document(&d, pdf::DEFAULT_GROUP).unwrap();
    f.finish()
}

/// Decode the FreeText annotation's /Contents back to a Rust string.
fn contents_of(bytes: &[u8]) -> String {
    let at = po::rfind(bytes, b"/Subtype /FreeText").expect("FreeText annot");
    let c = po::find(bytes, b"/Contents ", at).unwrap() + 10;
    let end = po::skip_value(bytes, c);
    let raw = &bytes[c..end];
    if raw[0] == b'<' {
        let hex = std::str::from_utf8(&raw[1..raw.len() - 1]).unwrap();
        let units: Vec<u16> =
            (0..hex.len()).step_by(4).map(|i| u16::from_str_radix(&hex[i..i + 4], 16).unwrap()).collect();
        assert_eq!(units[0], 0xFEFF, "UTF-16BE BOM");
        String::from_utf16(&units[1..]).unwrap()
    } else {
        let mut out = String::new();
        let mut it = raw[1..raw.len() - 1].iter();
        while let Some(&b) = it.next() {
            if b == b'\\' {
                match it.next() {
                    Some(b'n') => out.push('\n'),
                    Some(b'r') => out.push('\r'),
                    Some(&c) => out.push(c as char),
                    None => {}
                }
            } else {
                out.push(b as char);
            }
        }
        out
    }
}

#[test]
fn contents_round_trip_every_character_including_newlines() {
    for text in ["plain ascii (with) \\ slashes\nsecond line", "বাংলা গণিত\ncafé ✓"] {
        assert_eq!(contents_of(&save_note(text, false, false)), text);
    }
}

#[test]
fn appearance_uses_paths_not_fonts_and_the_box_fits_the_text() {
    let out = save_note("A fairly long note line that is wider than its box", true, true);
    let tail = &out[std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/lecture.pdf")).unwrap().len()..];
    assert!(po::find(tail, b"/Type1", 0).is_none(), "no standard-14 font resources");
    assert!(po::find(tail, b"/RC ", 0).is_some(), "rich text for re-rendering readers");
    // /Rect width must cover the shaped line, not the stale 40 pt box.
    let at = po::rfind(&out, b"/Subtype /FreeText").unwrap();
    let r = po::find(&out, b"/Rect [", at).unwrap() + 7;
    let e = po::find(&out, b"]", r).unwrap();
    let v: Vec<f64> = std::str::from_utf8(&out[r..e]).unwrap().split_whitespace().map(|t| t.parse().unwrap()).collect();
    let want = text_shape::line_width("A fairly long note line that is wider than its box", 14.0, true, true);
    assert!(v[2] - v[0] >= want, "rect {} narrower than text {want}", v[2] - v[0]);
}

#[test]
fn note_paths_are_filled_outlines() {
    let ops = text_shape::note_paths("ক্ষ x", 12.0, false, false, 20.0);
    assert!(ops.contains(" m\n") && ops.contains(" c\n") && ops.contains("h\n"));
    assert!(!ops.contains("Tj") && !ops.contains("Tf"));
}
