//! Plan 088: native xref-stream / object-stream / linearized support, and
//! bounded file growth via `pdf::writable_base`.

use inkwell_core::doc::Document;
use inkwell_core::ink::{Brush, IdGen, StrokeBuilder, ToolKind};
use inkwell_core::pdf::{self, PdfFile, SidecarStatus};
use inkwell_core::pdfobj::{self as po, Error};

fn fixture(rel: &str) -> Vec<u8> {
    std::fs::read(format!("{}/../../fixtures/{rel}", env!("CARGO_MANIFEST_DIR"))).expect("fixture")
}

fn doc(pages: usize, strokes: usize) -> Document {
    let mut d = Document::for_pdf(pages);
    let mut ids = IdGen::seeded(88);
    for i in 0..strokes {
        let mut b = StrokeBuilder::new(ids.next_id(), ToolKind::Pen, [0.2, 0.2, 0.5], Brush::default(), true);
        for k in 0..80 {
            b.push(70.0 + k as f64 * 4.0, 100.0 + i as f64 * 20.0 + (k as f64 * 0.3).sin() * 5.0, 0.6, k as f64 * 4.0);
        }
        d.push_stroke(i % pages, b.finish(0.0));
    }
    d.generation = 1;
    d
}

fn save(base: &[u8], d: &Document) -> Vec<u8> {
    let mut f = PdfFile::open(base.to_vec()).expect("opens natively");
    f.write_document(d, pdf::DEFAULT_GROUP).expect("write");
    f.finish()
}

fn newest_section_is_stream(bytes: &[u8]) -> bool {
    let at = po::skip_ws(bytes, po::last_startxref(bytes).unwrap());
    bytes.get(at..at + 4) != Some(b"xref")
}

fn sidecar_strokes(bytes: &[u8]) -> usize {
    match pdf::read_sidecar(bytes).expect("readable") {
        SidecarStatus::Ok(d) => d.stroke_count(),
        _ => panic!("sidecar not Ok"),
    }
}

#[test]
fn xref_stream_pdf_is_appended_to_without_rewriting() {
    let base = fixture("conformance/xref_stream.pdf");
    assert!(newest_section_is_stream(&base), "fixture must use an xref stream");
    let out = save(&base, &doc(1, 3));
    assert!(out.starts_with(&base), "original bytes are a byte-identical prefix");
    assert!(newest_section_is_stream(&out), "an update to an xref-stream file must be an xref stream");
    assert_eq!(PdfFile::open(out.clone()).unwrap().page_count(), 1);
    assert_eq!(sidecar_strokes(&out), 3);
}

#[test]
fn pages_inside_object_streams_are_found() {
    // qpdf --object-streams=generate packs the page tree into /ObjStm.
    let base = fixture("conformance/objstm_multi_page.pdf");
    assert_eq!(PdfFile::open(base.clone()).unwrap().page_count(), 5);
    let out = save(&base, &doc(5, 5));
    assert!(out.starts_with(&base));
    assert_eq!(sidecar_strokes(&out), 5);
    // Materialised object-stream copies must never be written out.
    assert!(out.len() - base.len() < 60_000, "appended {} bytes", out.len() - base.len());
}

#[test]
fn linearized_pdf_inherits_root_from_first_page_trailer() {
    let base = fixture("conformance/linearized.pdf");
    let f = PdfFile::open(base.clone()).expect("linearized opens natively");
    assert_eq!(f.page_count(), 5);
    assert!(save(&base, &doc(5, 2)).starts_with(&base));
}

#[test]
fn encrypted_pdf_is_refused() {
    match PdfFile::open(fixture("conformance/encrypted_aes256.pdf")) {
        Err(Error::Encrypted) => {}
        Err(e) => panic!("wrong error: {e}"),
        Ok(_) => panic!("must not append plaintext objects to an encrypted file"),
    }
}

#[test]
fn ten_sessions_do_not_grow_the_file() {
    for rel in ["lecture.pdf", "conformance/xref_stream.pdf"] {
        let original = fixture(rel);
        let d = doc(1, 4);
        let gen1 = save(&original, &d);
        let first = gen1.len() - original.len();
        let mut file = gen1;
        for _ in 0..10 {
            let base = pdf::writable_base(&file);
            assert_eq!(base, &original[..], "{rel}: rebases onto the untouched original");
            file = save(base, &d);
        }
        let total = file.len() - original.len();
        assert!(total <= first + 64, "{rel}: grew from {first} to {total} bytes over 10 sessions");
        assert_eq!(sidecar_strokes(&file), 4);
    }
}

#[test]
fn plain_pdf_has_no_rebase() {
    let original = fixture("lecture.pdf");
    assert_eq!(pdf::writable_base(&original).len(), original.len());
}

/// Append a minimal classic incremental update by "another tool" on top.
fn append_foreign_update(bytes: &[u8]) -> Vec<u8> {
    let prev = po::last_startxref(bytes).unwrap();
    // Our classic-xref output ends in a `trailer` dict carrying /Root.
    let tr = po::last_trailer_dict(bytes).unwrap();
    let r = po::dict_get(bytes, tr, "/Root").unwrap();
    let root = String::from_utf8_lossy(&bytes[r.0..r.1]).into_owned();
    let mut out = bytes.to_vec();
    let off = out.len();
    out.extend_from_slice(b"900 0 obj\n<< /Producer (Some Other Editor) >>\nendobj\n");
    let x = out.len();
    out.extend_from_slice(
        format!("xref\n900 1\n{off:010} 00000 n \ntrailer\n<< /Size 901 /Root {root} /Prev {prev} /Info 900 0 R >>\nstartxref\n{x}\n%%EOF\n")
            .as_bytes(),
    );
    out
}

#[test]
fn a_foreign_update_after_ours_is_never_discarded() {
    let original = fixture("lecture.pdf");
    let gen1 = save(&original, &doc(1, 2));
    let foreign = append_foreign_update(&gen1);
    assert!(PdfFile::open(foreign.clone()).is_ok(), "foreign update is a valid file");
    assert_eq!(
        pdf::writable_base(&foreign).len(),
        foreign.len(),
        "rebasing would drop the other editor's revision"
    );
}

#[test]
fn a_tampered_base_is_not_rebased() {
    let original = fixture("lecture.pdf");
    let mut gen1 = save(&original, &doc(1, 2));
    // Flip one byte inside the original page content; the hash must catch it.
    let i = po::find(&gen1, b"Fourier", 0).expect("text in fixture");
    gen1[i] = b'f';
    assert_eq!(pdf::writable_base(&gen1).len(), gen1.len());
}

#[test]
fn old_sidecar_filespecs_do_not_accumulate_in_af() {
    // Without a rebase (e.g. after a foreign update), each save stacks on the
    // last; /AF must still name only the current sidecar.
    let original = fixture("lecture.pdf");
    let mut file = save(&original, &doc(1, 1));
    for _ in 0..3 {
        file = save(&file, &doc(1, 1));
    }
    let at = po::rfind(&file, b"/AF [").expect("/AF present");
    let end = po::find(&file, b"]", at).unwrap();
    let refs = file[at..end].iter().filter(|&&c| c == b'R').count();
    assert_eq!(refs, 1, "{}", String::from_utf8_lossy(&file[at..=end]));
}

#[test]
fn wrong_xref_offsets_fall_back_to_scanning() {
    // Readers tolerate slightly-off offsets; so must we. Shift every in-use
    // entry by one byte.
    let mut b = fixture("lecture.pdf");
    let x = po::last_startxref(&b).unwrap();
    let t = po::find(&b, b"trailer", x).unwrap();
    let table = String::from_utf8_lossy(&b[x..t]).into_owned();
    let shifted: String = table
        .lines()
        .map(|l| {
            let p: Vec<&str> = l.split_whitespace().collect();
            if p.len() == 3 && p[2] == "n" {
                format!("{:010} {} n \n", p[0].parse::<usize>().unwrap() + 1, p[1])
            } else {
                format!("{l}\n")
            }
        })
        .collect();
    assert_eq!(shifted.len(), t - x, "fixture uses 20-byte entries");
    b.splice(x..t, shifted.bytes());
    let f = PdfFile::open(b).expect("opens via scan fallback");
    assert_eq!(f.page_count(), 1);
}
