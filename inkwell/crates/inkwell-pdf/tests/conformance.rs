//! Plan 087: file-format conformance harness.
//!
//! Every fixture is saved exactly the way the desktop app saves it (`PdfFile`
//! first, PDFium normalisation as the fallback, see `commands.rs::save_pdf`),
//! then the output is checked against the format contract:
//!
//!   qpdf_check      `qpdf --check` accepts both generations
//!   prefix          the original bytes survive as a byte-identical prefix
//!   sidecar         Layer 3 reads back as the exact document we wrote
//!   pdfium_reopen   PDFium opens the output with the same page count
//!   bounded_growth  a second session saving unchanged ink adds ~nothing
//!
//! Known defects are listed in `KNOWN_FAILURES` with the plan that fixes them.
//! The list is a ratchet: an unlisted failure fails the test, and so does a
//! listed one that starts passing, so fixes must delete their entry.
//!
//! External tools (`qpdf`, PDFium) are optional locally and skipped loudly.
//! Set `BEZIER_CONFORMANCE_STRICT=1` (CI does) to make a missing tool fatal.

use std::path::{Path, PathBuf};
use std::process::Command;

use inkwell_core::doc::{self, Bookmark, Document, TextObject};
use inkwell_core::ink::{Brush, IdGen, StrokeBuilder, ToolKind};
use inkwell_core::pdf::{self, PdfFile, SidecarStatus};
use inkwell_pdf::{init_pdfium, normalise, Pdfium};

/// (fixture file name or "*", check name, plan that owns the fix).
const KNOWN_FAILURES: &[(&str, &str, &str)] = &[
    // PdfFile rejects xref streams, so the app re-serialises through PDFium and
    // the original bytes are lost on first save.
    ("xref_stream.pdf", "prefix", "Plan 088"),
    ("objstm_multi_page.pdf", "prefix", "Plan 088"),
    ("irs_w9.pdf", "prefix", "Plan 088"),
    // Linearized files keep /Root in the first-page trailer; PdfFile reads
    // only the last trailer ("trailer has no /Root") and falls back to PDFium.
    ("linearized.pdf", "prefix", "Plan 088"),
    // Each session re-appends all ink + sidecar on top of earlier generations.
    ("*", "bounded_growth", "Plan 088"),
    // Appended objects are written in plaintext into an encrypted file.
    ("encrypted_aes256.pdf", "qpdf_check", "Plan 088"),
];

fn strict() -> bool {
    std::env::var("BEZIER_CONFORMANCE_STRICT").is_ok_and(|v| v == "1")
}

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn fixture_paths() -> Vec<PathBuf> {
    let root = fixtures_dir();
    let mut v: Vec<PathBuf> = std::fs::read_dir(root.join("conformance"))
        .expect("fixtures/conformance exists (run tools/gen_conformance_fixtures.sh)")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "pdf"))
        .collect();
    v.sort();
    // Real-world files: a government form (xref stream + AcroForm) and a LaTeX paper.
    v.push(root.join("corpus/irs_w9.pdf"));
    v.push(root.join("corpus/arxiv_adam.pdf"));
    v
}

fn name(p: &Path) -> String {
    p.file_name().unwrap().to_string_lossy().into_owned()
}

/// A small but representative document: pressure strokes, a highlighter, a
/// two-point highlighter, a text note and a bookmark on page 0, plus one
/// stroke on the last page.
pub fn representative_doc(n_pages: usize) -> Document {
    let mut d = Document::for_pdf(n_pages);
    let mut ids = IdGen::seeded(0x0087_0087);
    let mut push = |d: &mut Document, sheet: usize, kind: ToolKind, y0: f64, n: usize| {
        let brush = Brush {
            base_width: if kind == ToolKind::Highlighter { 14.0 } else { 2.6 },
            ..Default::default()
        };
        let mut b = StrokeBuilder::new(ids.next_id(), kind, [0.1, 0.2, 0.6], brush, true);
        for i in 0..n {
            let t = i as f64 / (n.max(2) - 1) as f64;
            let p = (std::f64::consts::PI * t).sin().max(0.05);
            b.push(72.0 + t * 300.0, y0 + 8.0 * (t * 17.0).sin(), p, i as f64 * 4.0);
        }
        d.push_stroke(sheet, b.finish(0.0));
    };
    for i in 0..3 {
        push(&mut d, 0, ToolKind::Pen, 120.0 + i as f64 * 40.0, 120);
    }
    push(&mut d, 0, ToolKind::Highlighter, 300.0, 60);
    push(&mut d, 0, ToolKind::Highlighter, 340.0, 2);
    if n_pages > 1 {
        push(&mut d, n_pages - 1, ToolKind::Pen, 200.0, 80);
    }
    d.upsert_text(
        0,
        TextObject {
            id: "txt_conformance".into(),
            sheet: 0,
            x: 80.0,
            y: 420.0,
            text: "Conformance note".into(),
            font_size: 14.0,
            color: "#202040".into(),
            bold: false,
            italic: false,
            width: 180.0,
            height: 24.0,
        },
    );
    d.bookmarks.push(Bookmark { id: "bm1".into(), page: 0, label: "Start".into(), created_at: 1 });
    d.generation = 1;
    canonical(&d)
}

/// The document as Layer 3 can represent it (samples quantised by the codec).
pub fn canonical(d: &Document) -> Document {
    doc::decode_sidecar(&doc::encode_sidecar(d)).expect("sidecar round-trips")
}

/// Mirror of `commands.rs::save_pdf`: open the base with our writer, falling
/// back to PDFium normalisation, then append one generation.
fn save_like_app(pdfium: Option<&Pdfium>, base: &[u8], d: &Document) -> Result<Vec<u8>, String> {
    let mut f = match PdfFile::open(base.to_vec()) {
        Ok(f) => f,
        Err(e) => {
            let pdfium = pdfium.ok_or_else(|| format!("needs normalisation ({e}) but PDFium unavailable"))?;
            let nb = normalise(pdfium, base).map_err(|e| format!("normalise: {e:?}"))?;
            PdfFile::open(nb).map_err(|e| format!("open normalised: {e}"))?
        }
    };
    f.write_document(d, pdf::DEFAULT_GROUP).map_err(|e| format!("write_document: {e}"))?;
    Ok(f.finish())
}

/// Page count as the app sees it (PDFium when available, else our parser).
fn page_count(pdfium: Option<&Pdfium>, bytes: &[u8]) -> Result<usize, String> {
    if let Some(p) = pdfium {
        let doc = p.load_pdf_from_byte_slice(bytes, None).map_err(|e| format!("PDFium load: {e:?}"))?;
        return Ok(doc.pages().len() as usize);
    }
    PdfFile::open(bytes.to_vec()).map(|f| f.page_count()).map_err(|e| e.to_string())
}

pub fn tool_available(cmd: &str) -> bool {
    Command::new(cmd).arg("--version").output().is_ok_and(|o| o.status.success())
}

/// `qpdf --check`; exit 0 = clean, 3 = warnings, 2 = errors. Warnings count
/// as failures: a reader that warns is a reader that may "repair" our file.
pub fn qpdf_check(bytes: &[u8]) -> Result<(), String> {
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let p = dir.path().join("check.pdf");
    std::fs::write(&p, bytes).map_err(|e| e.to_string())?;
    let out = Command::new("qpdf").arg("--check").arg(&p).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let mut msg = String::from_utf8_lossy(&out.stderr).into_owned();
    msg.push_str(&String::from_utf8_lossy(&out.stdout));
    let first: Vec<&str> = msg.lines().filter(|l| !l.trim().is_empty()).take(4).collect();
    Err(format!("qpdf exit {:?}: {}", out.status.code(), first.join(" | ")))
}

fn sidecar_doc(bytes: &[u8]) -> Result<Document, String> {
    match pdf::read_sidecar(bytes).map_err(|e| e.to_string())? {
        SidecarStatus::Ok(d) => Ok(d),
        SidecarStatus::Absent => Err("sidecar absent".into()),
        SidecarStatus::Corrupt(e) => Err(format!("sidecar corrupt: {e}")),
        SidecarStatus::Stale(_) => Err("sidecar stale".into()),
    }
}

#[derive(Debug)]
struct Failure {
    fixture: String,
    check: &'static str,
    detail: String,
}

fn is_known(f: &str, check: &str) -> Option<&'static str> {
    KNOWN_FAILURES
        .iter()
        .find(|(kf, kc, _)| (*kf == f || *kf == "*") && *kc == check)
        .map(|(_, _, plan)| *plan)
}

fn check_fixture(pdfium: Option<&Pdfium>, has_qpdf: bool, path: &Path, out: &mut Vec<Failure>, ran: &mut Vec<(String, &'static str)>) {
    let fx = name(path);
    let base = std::fs::read(path).expect("read fixture");
    let mut fail = |check: &'static str, detail: String| out.push(Failure { fixture: fx.clone(), check, detail });

    let n_pages = match page_count(pdfium, &base) {
        Ok(n) => n,
        Err(e) => {
            fail("pdfium_reopen", format!("input: {e}"));
            return;
        }
    };
    let d = representative_doc(n_pages);

    // ---- session 1 -------------------------------------------------------
    let gen1 = match save_like_app(pdfium, &base, &d) {
        Ok(b) => b,
        Err(e) => {
            fail("sidecar", format!("save failed: {e}"));
            return;
        }
    };
    ran.extend([(fx.clone(), "prefix"), (fx.clone(), "sidecar"), (fx.clone(), "pdfium_reopen")]);

    if !gen1.starts_with(&base) {
        fail("prefix", format!("original {} bytes not preserved as prefix of {} byte output", base.len(), gen1.len()));
    }
    match sidecar_doc(&gen1) {
        Ok(back) if back == d => {}
        Ok(back) => fail(
            "sidecar",
            format!("document differs: {} vs {} strokes", back.stroke_count(), d.stroke_count()),
        ),
        Err(e) => fail("sidecar", e),
    }
    match page_count(pdfium, &gen1) {
        Ok(n) if n == n_pages => {}
        Ok(n) => fail("pdfium_reopen", format!("page count {n_pages} -> {n}")),
        Err(e) => fail("pdfium_reopen", e),
    }
    if has_qpdf {
        ran.push((fx.clone(), "qpdf_check"));
        if let Err(e) = qpdf_check(&gen1) {
            fail("qpdf_check", format!("gen1: {e}"));
        }
    }

    // ---- session 2: reopen the saved file and save the same ink again -----
    // `open_pdf` makes the whole on-disk file the base (commands.rs:621).
    let d2 = sidecar_doc(&gen1).unwrap_or_else(|_| d.clone());
    match save_like_app(pdfium, &gen1, &d2) {
        Ok(gen2) => {
            ran.push((fx.clone(), "bounded_growth"));
            let first = gen1.len().saturating_sub(base.len());
            let total = gen2.len().saturating_sub(base.len());
            if total > first + 1024 {
                fail(
                    "bounded_growth",
                    format!("session 1 appended {first} B; after session 2 the file is {total} B over the original"),
                );
            }
            if has_qpdf {
                if let Err(e) = qpdf_check(&gen2) {
                    fail("qpdf_check", format!("gen2: {e}"));
                }
            }
        }
        Err(e) => fail("bounded_growth", format!("second save failed: {e}")),
    }
}

#[test]
fn pdf_output_conforms_across_fixture_corpus() {
    let has_qpdf = tool_available("qpdf");
    let pdfium = init_pdfium().ok();
    if !has_qpdf || pdfium.is_none() {
        let msg = format!("conformance: qpdf available={has_qpdf}, PDFium available={}", pdfium.is_some());
        assert!(!strict(), "{msg} (BEZIER_CONFORMANCE_STRICT=1 requires both)");
        eprintln!("WARNING {msg}; checks needing them are skipped");
    }

    let mut failures = Vec::new();
    let mut ran = Vec::new();
    for p in fixture_paths() {
        check_fixture(pdfium.as_ref(), has_qpdf, &p, &mut failures, &mut ran);
    }

    let mut unexpected = Vec::new();
    for f in &failures {
        match is_known(&f.fixture, f.check) {
            Some(plan) => eprintln!("known [{plan}] {} / {}: {}", f.fixture, f.check, f.detail),
            None => unexpected.push(format!("{} / {}: {}", f.fixture, f.check, f.detail)),
        }
    }
    // Ratchet: a known entry whose check ran and never failed means a fix
    // landed. A wildcard entry is fixed only once no fixture fails it.
    let failed = |fx: &str, check: &str| failures.iter().any(|f| (fx == "*" || f.fixture == fx) && f.check == check);
    let fixed: Vec<String> = KNOWN_FAILURES
        .iter()
        .filter(|(fx, check, _)| ran.iter().any(|(r, c)| (*fx == "*" || r == fx) && c == check))
        .filter(|(fx, check, _)| !failed(fx, check))
        .map(|(fx, check, plan)| format!("{fx} / {check} ({plan})"))
        .collect();

    let mut report = String::new();
    if !unexpected.is_empty() {
        report += &format!("unexpected conformance failures:\n  {}\n", unexpected.join("\n  "));
    }
    if !fixed.is_empty() {
        report += &format!("known failures that now pass; delete them from KNOWN_FAILURES:\n  {}\n", fixed.join("\n  "));
    }
    assert!(report.is_empty(), "{report}");
}
