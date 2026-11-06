//! Plan 087: `open(save(doc)) == doc` for randomly generated documents.
//!
//! "Equal" means equal to the document as Layer 3 can represent it: the codec
//! quantises samples (see `codec::QUANT`), so the property is stated against
//! `canonical(doc)`, and canonicalisation itself must be idempotent.

use inkwell_core::doc::{self, Bookmark, Document, ImageObject, TextObject};
use inkwell_core::ink::{Brush, Sample, Stroke, ToolKind};
use inkwell_core::pdf::{self, PdfFile, SidecarStatus};
use proptest::prelude::*;

/// 1x1 transparent PNG: images must be decodable for the visual layer.
const PNG_1X1: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

fn base_pdf() -> Vec<u8> {
    // Five classic-xref pages, so multi-sheet documents exercise every page.
    std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/corpus/sample_multi_page.pdf"))
        .expect("fixture")
}
const PAGES: usize = 5;

/// `qpdf --check` when qpdf is installed (CI installs it); `None` = skipped.
fn qpdf_check(bytes: &[u8]) -> Option<Result<(), String>> {
    use std::process::Command;
    Command::new("qpdf").arg("--version").output().ok().filter(|o| o.status.success())?;
    let dir = tempfile::tempdir().ok()?;
    let p = dir.path().join("prop.pdf");
    std::fs::write(&p, bytes).ok()?;
    let out = Command::new("qpdf").arg("--check").arg(&p).output().ok()?;
    Some(if out.status.success() {
        Ok(())
    } else {
        Err(format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
    })
}

fn canonical(d: &Document) -> Document {
    doc::decode_sidecar(&doc::encode_sidecar(d)).expect("sidecar decodes")
}

fn arb_samples() -> impl Strategy<Value = Vec<Sample>> {
    prop::collection::vec((-40.0f64..900.0, -40.0f64..900.0, 0.0f64..=1.0, 0.0f64..40.0), 1..200).prop_map(|raw| {
        let mut t = 0.0;
        raw.into_iter()
            .map(|(x, y, p, dt)| {
                t += dt;
                Sample::new(x, y, p, t)
            })
            .collect()
    })
}

fn arb_stroke() -> impl Strategy<Value = Stroke> {
    (
        any::<u128>(),
        prop_oneof![Just(ToolKind::Pen), Just(ToolKind::Highlighter)],
        [0.0f64..=1.0, 0.0f64..=1.0, 0.0f64..=1.0],
        (0.2f64..40.0, 0.3f64..3.0, 0.0f64..1.0),
        arb_samples(),
    )
        .prop_map(|(id, kind, rgb, (base_width, gamma, min_ratio), samples)| Stroke {
            id,
            kind,
            rgb,
            brush: Brush { base_width, gamma, min_ratio },
            samples,
        })
}

/// Text that stresses PDF string escaping and non-ASCII handling.
fn arb_text() -> impl Strategy<Value = String> {
    prop_oneof![
        "[ -~]{0,40}",
        "[()\\\\\n\r\t ]{1,12}",
        "\\PC{0,24}",
        Just("বাংলা গণিত".to_string()),
    ]
}

fn arb_text_obj(sheet: usize) -> impl Strategy<Value = TextObject> {
    ("[a-z0-9]{1,10}", 0.0f64..500.0, 0.0f64..700.0, arb_text(), 6.0f64..48.0, any::<(bool, bool)>(), 10.0f64..300.0, 10.0f64..120.0)
        .prop_map(move |(id, x, y, text, font_size, (bold, italic), width, height)| TextObject {
            id: format!("txt_{id}"),
            sheet,
            x,
            y,
            text,
            font_size,
            color: "#204080".into(),
            bold,
            italic,
            width,
            height,
        })
}

fn arb_image(sheet: usize) -> impl Strategy<Value = ImageObject> {
    ("[a-z0-9]{1,10}", 0.0f64..400.0, 0.0f64..600.0, 5.0f64..200.0, 5.0f64..200.0).prop_map(move |(id, x, y, width, height)| {
        ImageObject { id: format!("img_{id}"), sheet, x, y, width, height, data_url: PNG_1X1.into() }
    })
}

fn arb_document() -> impl Strategy<Value = Document> {
    let sheet = |i: usize| {
        (
            prop::collection::vec(arb_stroke(), 0..8),
            prop::collection::vec(arb_text_obj(i), 0..3),
            prop::collection::vec(arb_image(i), 0..2),
            prop::option::of(prop_oneof![Just("grid".to_string()), Just("dark".to_string())]),
        )
    };
    (
        (sheet(0), sheet(1), sheet(2), sheet(3), sheet(4)),
        prop::collection::vec(("[a-z]{1,6}", 0..PAGES, "\\PC{0,20}", any::<u32>()), 0..4),
        1u64..1000,
    )
        .prop_map(|(sheets, bookmarks, generation)| {
            let mut d = Document::for_pdf(PAGES);
            let (s0, s1, s2, s3, s4) = sheets;
            for (i, (strokes, texts, images, template)) in [s0, s1, s2, s3, s4].into_iter().enumerate() {
                for s in strokes {
                    d.push_stroke(i, s);
                }
                for t in texts {
                    d.upsert_text(i, t);
                }
                for im in images {
                    d.push_image(i, im);
                }
                d.sheets[i].template = template;
            }
            d.bookmarks = bookmarks
                .into_iter()
                .map(|(id, page, label, ts)| Bookmark { id, page, label, created_at: ts as u64 })
                .collect();
            d.generation = generation;
            d
        })
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 32, ..ProptestConfig::default() })]

    #[test]
    fn canonicalisation_is_idempotent(d in arb_document()) {
        let c = canonical(&d);
        prop_assert_eq!(canonical(&c), c);
    }

    #[test]
    fn save_then_read_returns_the_same_document(d in arb_document()) {
        let base = base_pdf();
        let want = canonical(&d);

        let mut f = PdfFile::open(base.clone()).expect("classic base opens");
        f.write_document(&d, pdf::DEFAULT_GROUP).expect("write");
        let out = f.finish();

        prop_assert!(out.starts_with(&base), "original bytes must be a prefix");
        if let Some(Err(e)) = qpdf_check(&out) {
            prop_assert!(false, "qpdf --check rejected the output: {}", e);
        }
        let reopened = PdfFile::open(out.clone()).expect("output reopens in our parser");
        prop_assert_eq!(reopened.page_count(), PAGES);
        match pdf::read_sidecar(&out).expect("sidecar readable") {
            SidecarStatus::Ok(back) => prop_assert_eq!(&back, &want),
            other => prop_assert!(false, "sidecar not Ok: {}", match other {
                SidecarStatus::Absent => "absent".to_string(),
                SidecarStatus::Corrupt(e) => format!("corrupt: {e}"),
                SidecarStatus::Stale(_) => "stale".to_string(),
                SidecarStatus::Ok(_) => unreachable!(),
            }),
        }

        // A second generation on top must still round-trip (the app reopens
        // and saves the same file every session).
        let mut f2 = PdfFile::open(out).expect("gen1 reopens");
        f2.write_document(&want, pdf::DEFAULT_GROUP).expect("write gen2");
        let out2 = f2.finish();
        match pdf::read_sidecar(&out2).expect("gen2 sidecar readable") {
            SidecarStatus::Ok(back) => prop_assert_eq!(&back, &want),
            _ => prop_assert!(false, "gen2 sidecar not Ok"),
        }
    }
}
