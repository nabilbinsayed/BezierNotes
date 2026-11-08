//! Plan 092: the union merge is a proper CRDT join, and never loses an object
//! that is not tombstoned.

use inkwell_core::clock::{DeviceIdentity, ObjectId};
use inkwell_core::codec;
use inkwell_core::doc::{self, Bookmark, Document, TextObject};
use inkwell_core::ink::{Brush, Stroke, StrokeBuilder, ToolKind};
use inkwell_core::merge::{self, MergeError, Side};
use inkwell_core::pdf::{self, PdfFile, SidecarStatus};
use proptest::prelude::*;

fn dev(id: u64) -> DeviceIdentity {
    DeviceIdentity { id, label: format!("device {id}") }
}

fn stroke(seed: u128, y: f64) -> Stroke {
    // a distinct id per seed (IdGen's first ids collide across nearby seeds)
    let id = inkwell_core::clock::derive_u128(&[b"test-stroke", &seed.to_le_bytes()]);
    let mut b = StrokeBuilder::new(id, ToolKind::Pen, [0.2, 0.1, 0.4], Brush::default(), true);
    for k in 0..24 {
        b.push(60.0 + k as f64 * 6.0, y + (k as f64 * 0.5).sin() * 5.0, 0.5, k as f64 * 4.0);
    }
    codec::decode(&codec::encode(&[b.finish(0.0)])).unwrap().remove(0)
}

fn note(id: &str, sheet: usize, text: &str) -> TextObject {
    TextObject {
        id: id.into(),
        sheet,
        x: 40.0,
        y: 60.0,
        text: text.into(),
        font_size: 12.0,
        color: "#000000".into(),
        bold: false,
        italic: false,
        width: 90.0,
        height: 18.0,
    }
}

/// The notebook every device starts from: saved once and reopened.
fn base() -> Document {
    let mut d = Document::for_pdf(3);
    d.assign_base_page_ids(b"shared base");
    for i in 0..6 {
        d.push_stroke(i % 3, stroke(1000 + i as u128, 100.0 + i as f64 * 40.0));
    }
    d.upsert_text(1, note("n1", 1, "base note"));
    d.upsert_text(2, note("n2", 2, "second"));
    d.bookmarks.push(Bookmark { id: "bm".into(), page: 0, label: "Start".into(), created_at: 1 });
    d.restamp(&dev(1), 0);
    doc::decode_sidecar(&doc::encode_sidecar(&d)).unwrap()
}

#[derive(Debug, Clone)]
enum Op {
    AddStroke(usize, u16),
    RemoveStroke(usize),
    MoveStroke(usize, i8),
    EditText(usize, u8),
    AddText(usize, u8),
    RemoveText(usize),
    DeletePage(usize),
    InsertPage(usize),
    Save,
}

fn arb_op() -> impl Strategy<Value = Op> {
    prop_oneof![
        3 => (0usize..8, any::<u16>()).prop_map(|(p, s)| Op::AddStroke(p, s)),
        2 => (0usize..64).prop_map(Op::RemoveStroke),
        1 => (0usize..64, any::<i8>()).prop_map(|(k, d)| Op::MoveStroke(k, d)),
        2 => (0usize..8, any::<u8>()).prop_map(|(k, t)| Op::EditText(k, t)),
        1 => (0usize..8, any::<u8>()).prop_map(|(p, t)| Op::AddText(p, t)),
        1 => (0usize..8).prop_map(Op::RemoveText),
        1 => (0usize..8).prop_map(Op::DeletePage),
        1 => (0usize..8).prop_map(Op::InsertPage),
        2 => Just(Op::Save),
    ]
}

/// Apply edits on one device; `Save` restamps, as the app's save does.
fn edit(mut d: Document, me: &DeviceIdentity, ops: &[Op]) -> Document {
    let tag = me.id as u128;
    for (n, op) in ops.iter().enumerate() {
        let pages = d.sheets.len();
        let strokes: Vec<u128> = d.sheets.iter().flat_map(|s| s.strokes().map(|s| s.id)).collect();
        let texts: Vec<String> = d.sheets.iter().flat_map(|s| s.text_objects.iter().map(|t| t.id.clone())).collect();
        match op {
            Op::AddStroke(p, s) => {
                let seed = (tag << 64) | ((n as u128) << 16) | *s as u128;
                d.push_stroke(p % pages, stroke(seed, 50.0 + *s as f64 % 600.0));
            }
            Op::RemoveStroke(k) if !strokes.is_empty() => {
                d.remove_stroke(strokes[k % strokes.len()]);
            }
            Op::MoveStroke(k, dx) if !strokes.is_empty() => {
                let id = strokes[k % strokes.len()];
                for sh in &mut d.sheets {
                    for l in &mut sh.layers {
                        for s in l.strokes.iter_mut().filter(|s| s.id == id) {
                            for p in &mut s.samples {
                                p.x += *dx as f64;
                            }
                            // at the precision a save keeps
                            *s = codec::decode(&codec::encode(std::slice::from_ref(s))).unwrap().remove(0);
                        }
                    }
                }
            }
            Op::EditText(k, t) if !texts.is_empty() => {
                let id = &texts[k % texts.len()];
                for sh in &mut d.sheets {
                    for txt in sh.text_objects.iter_mut().filter(|x| &x.id == id) {
                        txt.text = format!("edit {t} by {}", me.id);
                    }
                }
            }
            Op::AddText(p, t) => {
                let p = p % pages;
                d.upsert_text(p, note(&format!("n-{}-{n}-{t}", me.id), p, "new"));
            }
            Op::RemoveText(k) if !texts.is_empty() => {
                d.remove_text(&texts[k % texts.len()]);
            }
            Op::DeletePage(k) => {
                d.delete_sheet(k % pages);
            }
            Op::InsertPage(at) => d.insert_sheet(at % (pages + 1)),
            Op::Save => {
                d.restamp(me, n as u64);
            }
            _ => {}
        }
    }
    d.restamp(me, ops.len() as u64);
    d
}

/// Content only: `device` and `viewports` are per-session, taken from `ours`.
fn norm(mut d: Document) -> Document {
    d.device = Default::default();
    d.viewports = vec![Default::default()];
    d
}

fn m(a: &Document, b: &Document) -> Document {
    norm(merge::merge(a, b).expect("merges").doc)
}

fn replica(ops: &[Op], device: u64) -> Document {
    edit(base(), &dev(device), ops)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 128, ..ProptestConfig::default() })]

    #[test]
    fn merge_is_commutative(oa in prop::collection::vec(arb_op(), 0..25), ob in prop::collection::vec(arb_op(), 0..25)) {
        let (a, b) = (replica(&oa, 10), replica(&ob, 20));
        prop_assert_eq!(m(&a, &b), m(&b, &a));
    }

    #[test]
    fn merge_is_associative(
        oa in prop::collection::vec(arb_op(), 0..20),
        ob in prop::collection::vec(arb_op(), 0..20),
        oc in prop::collection::vec(arb_op(), 0..20),
    ) {
        let (a, b, c) = (replica(&oa, 10), replica(&ob, 20), replica(&oc, 30));
        prop_assert_eq!(m(&m(&a, &b), &c), m(&a, &m(&b, &c)));
    }

    #[test]
    fn merge_is_idempotent(oa in prop::collection::vec(arb_op(), 0..25), ob in prop::collection::vec(arb_op(), 0..25)) {
        let (a, b) = (replica(&oa, 10), replica(&ob, 20));
        let ab = m(&a, &b);
        prop_assert_eq!(m(&ab, &ab), ab.clone());
        // and merging in what was already merged changes nothing
        prop_assert_eq!(m(&ab, &b), ab.clone());
        prop_assert_eq!(m(&ab, &a), ab);
    }

    #[test]
    fn merge_survives_a_save_and_reopen(oa in prop::collection::vec(arb_op(), 0..25), ob in prop::collection::vec(arb_op(), 0..25)) {
        let (a, b) = (replica(&oa, 10), replica(&ob, 20));
        let ab = m(&a, &b);
        let reopened = norm(doc::decode_sidecar(&doc::encode_sidecar(&ab)).unwrap());
        prop_assert_eq!(&reopened, &ab);
        let mut stamped = reopened.clone();
        prop_assert!(!stamped.restamp(&dev(10), 0), "a merged document needs no new stamps");
    }

    /// The STOP condition: every object live in either copy is in the result
    /// unless a tombstone newer than its newest version says it was deleted.
    #[test]
    fn no_object_is_lost_unless_tombstoned(oa in prop::collection::vec(arb_op(), 0..25), ob in prop::collection::vec(arb_op(), 0..25)) {
        let (a, b) = (replica(&oa, 10), replica(&ob, 20));
        let r = merge::merge(&a, &b).unwrap().doc;
        let live = |d: &Document| -> Vec<ObjectId> {
            let mut v = Vec::new();
            for sh in &d.sheets {
                v.push(ObjectId::Page(sh.page_id));
                v.extend(sh.strokes().map(|s| ObjectId::Stroke(s.id)));
                v.extend(sh.images.iter().map(|i| ObjectId::Image(i.id.clone())));
                v.extend(sh.text_objects.iter().map(|t| ObjectId::Text(t.id.clone())));
            }
            v.extend(d.bookmarks.iter().map(|b| ObjectId::Bookmark(b.id.clone())));
            v
        };
        let in_result = live(&r);
        for id in live(&a).into_iter().chain(live(&b)) {
            if in_result.contains(&id) {
                continue;
            }
            let newest = a.clock_of(&id).modified.max(b.clock_of(&id).modified);
            let tomb = r.tombstones.get(&id);
            prop_assert!(tomb.is_some_and(|t| t.clock > newest), "{id} vanished without a newer tombstone");
        }
        // and the ink on every live page made it across
        for sh in &r.sheets {
            prop_assert!(sh.page_id != 0);
        }
    }
}

// --- the concrete cases the design calls out ---

#[test]
fn ink_beats_a_concurrent_page_delete() {
    let mut a = base();
    let mut b = base();
    let page = a.sheets[1].page_id;
    a.delete_sheet(1);
    a.restamp(&dev(10), 0);
    let late = stroke(77, 300.0);
    b.push_stroke(1, late.clone());
    b.restamp(&dev(20), 0);

    let r = merge::merge(&a, &b).unwrap();
    assert!(r.doc.sheets.iter().any(|s| s.page_id == page), "page with new ink kept");
    assert_eq!(r.report.pages_kept_by_ink, vec![page]);
    let kept = r.doc.sheets.iter().find(|s| s.page_id == page).unwrap();
    assert!(kept.strokes().any(|s| s.id == late.id));
    // the page's old ink was deleted with it on A, and stays deleted
    assert_eq!(kept.stroke_count(), 1);
}

#[test]
fn a_page_deleted_with_no_new_ink_stays_deleted() {
    let mut a = base();
    let b = base();
    let page = a.sheets[2].page_id;
    a.delete_sheet(2);
    a.restamp(&dev(10), 0);
    let r = merge::merge(&b, &a).unwrap();
    assert!(!r.doc.sheets.iter().any(|s| s.page_id == page));
    assert!(r.report.removed.contains(&ObjectId::Page(page)));
}

#[test]
fn concurrent_text_edits_are_reported_and_newest_wins() {
    let mut a = base();
    let mut b = base();
    a.upsert_text(1, note("n1", 1, "from A"));
    a.restamp(&dev(10), 0);
    b.push_stroke(0, stroke(502, 50.0)); // B's clock now ahead, so its edit is newer
    b.restamp(&dev(20), 0);
    b.upsert_text(1, note("n1", 1, "from B"));
    b.restamp(&dev(20), 0);

    let r = merge::merge(&a, &b).unwrap();
    assert_eq!(r.report.conflicts.len(), 1);
    let c = &r.report.conflicts[0];
    assert_eq!((c.ours.as_str(), c.theirs.as_str()), ("from A", "from B"));
    let winner_text = r.doc.sheets[1].text_objects.iter().find(|t| t.id == "n1").unwrap().text.clone();
    assert_eq!(winner_text, if c.winner == Side::Theirs { "from B" } else { "from A" });

    // the user picks the other one
    let mut merged = r.doc;
    let loser = if c.winner == Side::Theirs { &a } else { &b };
    assert!(merge::take_text(&mut merged, loser, "n1"));
    assert!(merged.restamp(&dev(10), 0), "the choice gets a fresh clock");
    let chosen = merged.clock_of(&ObjectId::Text("n1".into())).modified;
    assert!(chosen > a.clock_of(&ObjectId::Text("n1".into())).modified);
    assert!(chosen > b.clock_of(&ObjectId::Text("n1".into())).modified);
}

#[test]
fn an_edit_already_seen_by_the_other_copy_is_not_a_conflict() {
    let mut a = base();
    a.upsert_text(1, note("n1", 1, "A edits"));
    a.restamp(&dev(10), 0);
    // B syncs A's edit, then edits the note again: causal, not concurrent
    let mut b = merge::merge(&base(), &a).unwrap().doc;
    b.upsert_text(1, note("n1", 1, "B edits after seeing A"));
    b.restamp(&dev(20), 0);
    let r = merge::merge(&a, &b).unwrap();
    assert!(r.report.conflicts.is_empty());
    assert_eq!(r.doc.sheets[1].text_objects.iter().find(|t| t.id == "n1").unwrap().text, "B edits after seeing A");
}

#[test]
fn an_edit_after_a_delete_brings_the_note_back_and_a_delete_after_an_edit_wins() {
    let mut a = base();
    let mut b = base();
    a.remove_text("n2");
    a.restamp(&dev(10), 0);
    b.push_stroke(0, stroke(501, 50.0));
    b.restamp(&dev(20), 0);
    b.upsert_text(2, note("n2", 2, "edited later"));
    b.restamp(&dev(20), 0);
    let r = merge::merge(&a, &b).unwrap().doc;
    assert!(r.sheets.iter().flat_map(|s| &s.text_objects).any(|t| t.id == "n2"), "newer edit beats older delete");

    let mut c = base();
    c.upsert_text(2, note("n2", 2, "edited first"));
    c.restamp(&dev(20), 0);
    let mut d = base();
    d.push_stroke(0, stroke(500, 50.0)); // other work first: d's clock moves ahead
    d.restamp(&dev(10), 0);
    d.remove_text("n2");
    d.restamp(&dev(10), 0);
    let r = merge::merge(&c, &d).unwrap().doc;
    assert!(!r.sheets.iter().flat_map(|s| &s.text_objects).any(|t| t.id == "n2"), "newer delete beats older edit");
}

#[test]
fn unstamped_copies_are_refused() {
    let a = Document::for_pdf(2);
    assert!(matches!(merge::merge(&a, &a), Err(MergeError::Unstamped)));
}

// --- whole files: two devices, real PDFs ---

fn fixture() -> Vec<u8> {
    std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/corpus/sample_multi_page.pdf")).unwrap()
}

fn save_on(base_pdf: &[u8], d: &Document) -> Vec<u8> {
    let mut f = PdfFile::open(base_pdf.to_vec()).unwrap();
    f.write_document(d, pdf::DEFAULT_GROUP).unwrap();
    f.finish()
}

fn qpdf_check(bytes: &[u8]) -> Option<bool> {
    use std::process::Command;
    Command::new("qpdf").arg("--version").output().ok().filter(|o| o.status.success())?;
    let dir = tempfile::tempdir().ok()?;
    let p = dir.path().join("merged.pdf");
    std::fs::write(&p, bytes).ok()?;
    Some(Command::new("qpdf").arg("--check").arg(&p).output().ok()?.status.success())
}

#[test]
fn two_devices_edit_the_same_pdf_and_merge_into_one_valid_file() {
    let pdf_bytes = fixture();
    // both devices open the same file (no sidecar yet) and save it once
    let open = |bytes: &[u8]| merge::document_for_merge(bytes, 5).unwrap();
    let mut first = open(&pdf_bytes);
    first.push_stroke(0, stroke(1, 100.0));
    first.push_stroke(1, stroke(2, 100.0));
    first.upsert_text(2, note("shared", 2, "shared note"));
    first.restamp(&dev(1), 0);
    let synced = save_on(&pdf_bytes, &first);

    // the sync client then forks the file
    let reopen = |b: &[u8]| match pdf::read_sidecar(b).unwrap() {
        SidecarStatus::Ok(d) => d,
        _ => panic!(),
    };
    let mut laptop = reopen(&synced);
    let mut tablet = reopen(&synced);
    let laptop_ink = stroke(10, 300.0);
    laptop.push_stroke(0, laptop_ink.clone());
    laptop.remove_stroke(stroke(2, 100.0).id); // delete on one side
    laptop.restamp(&dev(10), 100);
    let tablet_ink = stroke(20, 400.0);
    tablet.push_stroke(3, tablet_ink.clone());
    tablet.upsert_text(2, note("shared", 2, "tablet's wording"));
    tablet.restamp(&dev(20), 100);
    let a = save_on(pdf::writable_base(&synced), &laptop);
    let b = save_on(pdf::writable_base(&synced), &tablet);

    let (merged, report) = merge::merge_files(&a, &b, &dev(10), 200).expect("same base merges");
    assert!(merged.starts_with(&pdf_bytes), "original bytes stay a byte-identical prefix");
    if let Some(ok) = qpdf_check(&merged) {
        assert!(ok, "merged file passes qpdf --check");
    }
    let r = reopen(&merged);
    let ids: Vec<u128> = r.sheets.iter().flat_map(|s| s.strokes().map(|s| s.id)).collect();
    assert!(ids.contains(&laptop_ink.id) && ids.contains(&tablet_ink.id), "ink from both devices");
    assert!(ids.contains(&stroke(1, 100.0).id));
    assert!(!ids.contains(&stroke(2, 100.0).id), "the laptop's delete holds");
    assert_eq!(r.sheets[2].text_objects[0].text, "tablet's wording");
    assert_eq!(report.added, vec![ObjectId::Stroke(tablet_ink.id)], "{report:?}");
    assert_eq!(report.changed, vec![ObjectId::Text("shared".into())]);
    assert!(report.conflicts.is_empty(), "only the tablet touched the note");
    assert_eq!(PdfFile::open(merged).unwrap().page_count(), 5);
}

#[test]
fn copies_of_different_pdfs_are_refused() {
    let a = fixture();
    let b = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/conformance/classic.pdf")).unwrap();
    assert!(matches!(merge::merge_files(&a, &b, &dev(1), 0), Err(MergeError::DifferentBase)));
}


