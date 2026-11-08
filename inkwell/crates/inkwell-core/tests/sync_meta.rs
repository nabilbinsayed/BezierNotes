//! Plan 091: sync metadata (Lamport clocks, tombstones, page identity and
//! order keys) and compatibility with sidecars written before it.

use inkwell_core::clock::{self, Clock, DeviceIdentity, ObjectId};
use inkwell_core::codec;
use inkwell_core::doc::{self, Bookmark, Document, TextObject};
use inkwell_core::ink::{Brush, IdGen, Stroke, StrokeBuilder, ToolKind};
use inkwell_core::pdf::{self, PdfFile, SidecarStatus};
use inkwell_core::wal::{Wal, WalEntry};
use proptest::prelude::*;
use sha2::{Digest, Sha256};

fn fixture(rel: &str) -> Vec<u8> {
    std::fs::read(format!("{}/../../fixtures/{rel}", env!("CARGO_MANIFEST_DIR"))).expect("fixture")
}

fn me() -> DeviceIdentity {
    DeviceIdentity { id: 0xA11CE, label: "laptop".into() }
}

fn stroke(ids: &mut IdGen, y: f64) -> Stroke {
    let mut b = StrokeBuilder::new(ids.next_id(), ToolKind::Pen, [0.1, 0.1, 0.1], Brush::default(), true);
    for k in 0..50 {
        b.push(60.0 + k as f64 * 4.0, y + (k as f64 * 0.3).sin() * 4.0, 0.5, k as f64 * 4.0);
    }
    // as the codec stores it, so documents compare equal after a round trip
    codec::decode(&codec::encode(&[b.finish(0.0)])).unwrap().remove(0)
}

fn note(id: &str, sheet: usize, text: &str) -> TextObject {
    TextObject {
        id: id.into(),
        sheet,
        x: 50.0,
        y: 80.0,
        text: text.into(),
        font_size: 12.0,
        color: "#000000".into(),
        bold: false,
        italic: false,
        width: 100.0,
        height: 20.0,
    }
}

fn roundtrip(d: &Document) -> Document {
    doc::decode_sidecar(&doc::encode_sidecar(d)).expect("decodes")
}

/// A stamped three-page document.
fn stamped_doc() -> (Document, IdGen) {
    let mut ids = IdGen::seeded(91);
    let mut d = Document::for_pdf(3);
    d.assign_base_page_ids(b"base");
    for i in 0..6 {
        d.push_stroke(i % 3, stroke(&mut ids, 100.0 + i as f64 * 30.0));
    }
    d.upsert_text(1, note("t1", 1, "hello"));
    d.bookmarks.push(Bookmark { id: "b1".into(), page: 2, label: "End".into(), created_at: 5 });
    assert!(d.restamp(&me(), 1_000));
    (d, ids)
}

// --- v1 compatibility (STOP condition: every pre-091 file must still open) ---

fn assert_v1_notes_content(d: &Document) {
    // Written by the pre-091 build: 5 base pages + 1 inserted, page 0 moved to
    // index 3, 12 strokes, one image, one text, one bookmark, a template.
    assert_eq!(d.sheets.len(), 6);
    assert_eq!(d.stroke_count(), 12);
    assert_eq!(d.generation, 3);
    assert_eq!(d.sheets.iter().map(|s| s.images.len()).sum::<usize>(), 1);
    let texts: Vec<&TextObject> = d.sheets.iter().flat_map(|s| &s.text_objects).collect();
    assert_eq!(texts.len(), 1);
    assert_eq!(texts[0].text, "Hello v1 — নমস্কার");
    assert_eq!(d.bookmarks.len(), 1);
    assert_eq!(d.sheets.iter().filter(|s| s.template.as_deref() == Some("grid")).count(), 1);
    // and nothing pre-091 carries sync metadata
    assert_eq!(d.clock, 0);
    assert!(d.clocks.is_empty() && d.tombstones.is_empty() && d.peers.is_empty());
    assert!(d.sheets.iter().all(|s| s.page_id == 0 && s.order_key.is_empty()));
}

#[test]
fn v1_sidecar_fixture_decodes_with_every_object() {
    let d = doc::decode_sidecar(&fixture("v1/notes_v1.iwdc")).expect("v1 sidecar decodes");
    assert_v1_notes_content(&d);
}

#[test]
fn v1_pdf_fixtures_open_and_resave_as_schema_2() {
    let bytes = fixture("v1/notes_v1.pdf");
    let SidecarStatus::Ok(mut d) = pdf::read_sidecar(&bytes).unwrap() else { panic!("v1 sidecar not Ok") };
    assert_v1_notes_content(&d);

    // open → stamp → save → reopen keeps every object and now has clocks
    let base = pdf::writable_base(&bytes).to_vec();
    d.assign_base_page_ids(&Sha256::digest(&base));
    assert!(d.restamp(&me(), 10), "first save assigns page order keys");
    let mut f = PdfFile::open(bytes.clone()).unwrap();
    f.write_document(&d, pdf::DEFAULT_GROUP).unwrap();
    let out = f.finish();
    let SidecarStatus::Ok(back) = pdf::read_sidecar(&out).unwrap() else { panic!("resaved sidecar not Ok") };
    assert_eq!(back, d);
    assert_eq!(back.stroke_count(), 12);
    assert!(back.sheets.iter().all(|s| s.page_id != 0 && clock::is_valid_key(&s.order_key)));

    let small = fixture("v1/xref_stream_v1.pdf");
    let SidecarStatus::Ok(d1) = pdf::read_sidecar(&small).unwrap() else { panic!("v1 sidecar not Ok") };
    assert_eq!(d1.stroke_count(), 1);
}

#[test]
fn a_v1_object_counts_as_zero_clock_not_as_new_until_saved() {
    let d = doc::decode_sidecar(&fixture("v1/notes_v1.iwdc")).unwrap();
    let id = ObjectId::Stroke(d.sheets.iter().flat_map(|s| s.strokes()).next().unwrap().id);
    assert_eq!(d.clock_of(&id).created, Clock::ZERO);
}

/// What a pre-091 reader does with a sidecar: container version 1, JSON
/// fields it knows (unknown ones ignored), then the codec payload, ignoring
/// whatever follows it.
#[test]
fn schema_2_sidecar_stays_readable_by_the_pre_091_decoder() {
    let (d, _) = stamped_doc();
    let buf = doc::encode_sidecar(&d);
    assert_eq!(buf[4], 1, "container version unchanged");
    let jlen = u32::from_le_bytes([buf[5], buf[6], buf[7], buf[8]]) as usize;
    let sk: serde_json::Value = serde_json::from_slice(&buf[9..9 + jlen]).unwrap();
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct OldSheet {
        kind: inkwell_core::SheetKind,
        layers: Vec<serde_json::Value>,
        #[serde(default)]
        images: Vec<serde_json::Value>,
        #[serde(default)]
        text_objects: Vec<TextObject>,
        #[serde(default)]
        template: Option<String>,
    }
    let sheets: Vec<OldSheet> = serde_json::from_value(sk["sheets"].clone()).expect("old sheet shape");
    assert_eq!(sheets.len(), 3);
    let strokes = codec::decode(&buf[9 + jlen..]).expect("old codec ignores the clock column");
    assert_eq!(strokes.len(), d.stroke_count());
    let counts: Vec<Vec<usize>> = serde_json::from_value(sk["layer_stroke_counts"].clone()).unwrap();
    assert_eq!(counts.iter().flatten().sum::<usize>(), strokes.len());
}

// --- clocks round-trip and restamp semantics ---

#[test]
fn stamped_document_round_trips_with_all_clocks() {
    let (d, _) = stamped_doc();
    assert!(d.clock > 0);
    assert!(!d.clocks.is_empty());
    assert_eq!(d.peers[&me().id].label, "laptop");
    assert_eq!(roundtrip(&d), d);
}

#[test]
fn restamp_without_changes_stamps_nothing() {
    let (mut d, _) = stamped_doc();
    let before = d.clone();
    assert!(!d.restamp(&me(), 2_000));
    assert_eq!(d, before);
    // nor after a save/open round trip
    let mut back = roundtrip(&d);
    assert!(!back.restamp(&me(), 3_000));
}

#[test]
fn restamp_stamps_exactly_what_changed() {
    let (d0, mut ids) = stamped_doc();
    let mut d = roundtrip(&d0);
    let hi = d.clock;
    let other = DeviceIdentity { id: 0xB0B, label: "tablet".into() };

    let new_stroke = stroke(&mut ids, 400.0);
    let new_id = ObjectId::Stroke(new_stroke.id);
    d.push_stroke(0, new_stroke);
    d.upsert_text(1, note("t1", 1, "hello, edited"));
    let gone = d.sheets[2].layers[0].strokes[0].id;
    d.remove_stroke(gone);
    let untouched = ObjectId::Stroke(d.sheets[1].layers[0].strokes[0].id);
    assert!(d.restamp(&other, 5_000));

    let c = d.clock_of(&new_id);
    assert!(c.created.lamport > hi && c.created.device == other.id && c.modified == c.created);
    let t = d.clock_of(&ObjectId::Text("t1".into()));
    assert!(t.modified.lamport > hi && t.created.lamport <= hi, "edit bumps modified only");
    assert_eq!(d.clock_of(&untouched), d0.clock_of(&untouched));
    let tomb = d.tombstones[&ObjectId::Stroke(gone)];
    assert!(tomb.clock.lamport > hi && tomb.unix_s == 5_000);
    assert!(!d.clocks.contains_key(&ObjectId::Stroke(gone)));
    assert_eq!(d.peers.len(), 2);
    assert_eq!(d.peers[&other.id].clock, d.clock);
}

#[test]
fn moving_a_stroke_in_place_is_a_modification() {
    // the lasso tool moves strokes without changing their id
    let (mut d, _) = stamped_doc();
    let id = d.sheets[0].layers[0].strokes[0].id;
    let before = d.clock_of(&ObjectId::Stroke(id));
    for s in &mut d.sheets[0].layers[0].strokes[0].samples {
        s.x += 10.0;
    }
    d.restamp(&me(), 0);
    let after = d.clock_of(&ObjectId::Stroke(id));
    assert_eq!(after.created, before.created);
    assert!(after.modified > before.modified);
}

#[test]
fn undoing_a_delete_revives_the_object() {
    let (mut d, _) = stamped_doc();
    let s = d.sheets[0].layers[0].strokes[0].clone();
    d.remove_stroke(s.id);
    d.restamp(&me(), 0);
    assert!(d.tombstones.contains_key(&ObjectId::Stroke(s.id)));
    d.push_stroke(0, s.clone());
    d.restamp(&me(), 0);
    assert!(!d.tombstones.contains_key(&ObjectId::Stroke(s.id)));
    assert!(d.clocks.contains_key(&ObjectId::Stroke(s.id)));
}

#[test]
fn page_reorder_rekeys_one_page_and_leaves_objects_alone() {
    let mut ids = IdGen::seeded(7);
    let mut d = Document::for_pdf(8);
    d.assign_base_page_ids(b"base");
    for i in 0..8 {
        d.push_stroke(i, stroke(&mut ids, 200.0));
    }
    d.restamp(&me(), 0);
    let keys_before: Vec<String> = d.sheets.iter().map(|s| s.order_key.clone()).collect();
    let stroke_clocks: Vec<_> = d.sheets.iter().flat_map(|s| s.strokes()).map(|s| d.clock_of(&ObjectId::Stroke(s.id))).collect();

    d.reorder_sheet(7, 0); // last page to the front
    d.restamp(&me(), 0);
    let keys: Vec<&str> = d.sheets.iter().map(|s| s.order_key.as_str()).collect();
    assert!(keys.windows(2).all(|w| w[0] < w[1]), "keys follow page order: {keys:?}");
    let changed = d.sheets.iter().filter(|s| !keys_before.contains(&s.order_key)).count();
    assert_eq!(changed, 1, "only the moved page gets a new key");
    let moved = ObjectId::Page(d.sheets[0].page_id);
    let pages_modified = d
        .sheets
        .iter()
        .filter(|s| d.clock_of(&ObjectId::Page(s.page_id)).modified != d.clock_of(&ObjectId::Page(s.page_id)).created)
        .count();
    assert_eq!(pages_modified, 1);
    assert!(d.clock_of(&moved).modified > d.clock_of(&moved).created);
    let mut after: Vec<_> = d.sheets.iter().flat_map(|s| s.strokes()).map(|s| d.clock_of(&ObjectId::Stroke(s.id))).collect();
    let mut before = stroke_clocks;
    after.sort_by_key(|c| c.created);
    before.sort_by_key(|c| c.created);
    assert_eq!(after, before, "reordering pages does not touch the strokes on them");
}

#[test]
fn duplicated_and_inserted_pages_get_their_own_identity() {
    let (mut d, _) = stamped_doc();
    d.duplicate_sheet(0).unwrap();
    d.insert_sheet(4);
    d.restamp(&me(), 0);
    let mut ids: Vec<u128> = d.sheets.iter().map(|s| s.page_id).collect();
    assert!(ids.iter().all(|&i| i != 0));
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), d.sheets.len(), "page ids are unique");
    let keys: Vec<&str> = d.sheets.iter().map(|s| s.order_key.as_str()).collect();
    assert!(keys.windows(2).all(|w| w[0] < w[1]));
}

#[test]
fn base_page_ids_are_deterministic_across_independent_opens() {
    let bytes = fixture("corpus/sample_multi_page.pdf");
    let fp = Sha256::digest(&bytes);
    let mut a = Document::for_pdf(5);
    let mut b = Document::for_pdf(5);
    a.assign_base_page_ids(&fp);
    b.assign_base_page_ids(&fp);
    let ia: Vec<u128> = a.sheets.iter().map(|s| s.page_id).collect();
    assert_eq!(ia, b.sheets.iter().map(|s| s.page_id).collect::<Vec<_>>());
    assert!(ia.iter().all(|&i| i != 0));
    let mut c = Document::for_pdf(5);
    c.assign_base_page_ids(&Sha256::digest(b"another file"));
    assert_ne!(ia[0], c.sheets[0].page_id);
}

#[test]
fn tombstones_are_collected_only_when_old_and_covered_by_every_peer() {
    let (mut d, _) = stamped_doc();
    let gone = d.sheets[0].layers[0].strokes[0].id;
    d.remove_stroke(gone);
    d.restamp(&me(), 1_000);
    let key = ObjectId::Stroke(gone);
    // a peer that has not caught up keeps it alive however old it is
    d.peers.insert(0xB0B, clock::Peer { clock: 1, label: "tablet".into() });
    d.push_stroke(1, stroke(&mut IdGen::seeded(3), 50.0));
    d.restamp(&me(), 1_000 + clock::TOMBSTONE_MIN_AGE_S + 1);
    assert!(d.tombstones.contains_key(&key));
    // once every peer is past it and it is old enough, it goes
    d.peers.get_mut(&0xB0B).unwrap().clock = d.clock;
    d.push_stroke(1, stroke(&mut IdGen::seeded(4), 60.0));
    d.restamp(&me(), 1_000 + clock::TOMBSTONE_MIN_AGE_S - 1);
    assert!(d.tombstones.contains_key(&key), "too young");
    d.push_stroke(1, stroke(&mut IdGen::seeded(5), 70.0));
    d.restamp(&me(), 1_000 + clock::TOMBSTONE_MIN_AGE_S + 1);
    assert!(!d.tombstones.contains_key(&key));
}

// --- Lamport monotonicity across a crash and journal replay ---

#[test]
fn lamport_clock_stays_monotonic_across_wal_replay() {
    let (d, mut ids) = stamped_doc();
    let saved = doc::encode_sidecar(&d);
    let saved_clock = d.clock;

    // edits after the save go to the journal; then the app dies
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("j.bin");
    let late = stroke(&mut ids, 500.0);
    {
        let mut w = Wal::open(&path).unwrap();
        w.append(&WalEntry::Added { sheet: 1, stroke: late.clone() }).unwrap();
        w.append(&WalEntry::Removed(d.sheets[0].layers[0].strokes[0].id)).unwrap();
    }

    // reopen: sidecar, then replay, then the next save stamps
    let mut back = doc::decode_sidecar(&saved).unwrap();
    assert_eq!(back.clock, saved_clock);
    for e in Wal::replay(&path).unwrap() {
        match e {
            WalEntry::Added { sheet, stroke } => {
                back.remove_stroke(stroke.id);
                back.push_stroke(sheet, stroke);
            }
            WalEntry::Removed(id) => {
                back.remove_stroke(id);
            }
            _ => unreachable!(),
        }
    }
    assert!(back.restamp(&me(), 0));
    assert!(back.clock > saved_clock);
    assert!(back.clock_of(&ObjectId::Stroke(late.id)).created.lamport > saved_clock);
    assert!(back.tombstones.values().all(|t| t.clock.lamport > saved_clock));
    // replaying the same journal twice (a kept record a save already covered)
    // changes nothing
    let snapshot = back.clone();
    back.remove_stroke(late.id);
    back.push_stroke(1, late);
    assert!(!back.restamp(&me(), 0));
    assert_eq!(back, snapshot);
}

// --- size budget ---

#[test]
fn clocks_add_at_most_five_percent_to_a_5000_stroke_sidecar() {
    let mut ids = IdGen::seeded(5000);
    let mut d = Document::for_pdf(20);
    d.assign_base_page_ids(b"base");
    for i in 0..5000 {
        d.push_stroke(i % 20, stroke(&mut ids, 50.0 + (i % 40) as f64 * 18.0));
    }
    // worst case: clocks from several devices
    for (k, dev) in [1u64, 2, 3].iter().enumerate() {
        d.push_stroke(0, stroke(&mut ids, 10.0 + k as f64));
        d.restamp(&DeviceIdentity { id: *dev * 0x1234_5678_9ABC, label: format!("dev{dev}") }, 0);
    }
    let v2 = doc::encode_sidecar(&d).len();

    // the same document as the pre-091 encoder wrote it
    let strokes: Vec<Stroke> = d.sheets.iter().flat_map(|s| s.strokes().cloned()).collect();
    let mut sheets = serde_json::to_value(&d.sheets).unwrap();
    for s in sheets.as_array_mut().unwrap() {
        let o = s.as_object_mut().unwrap();
        o.remove("page_id");
        o.remove("order_key");
    }
    let counts: Vec<Vec<usize>> = d.sheets.iter().map(|s| s.layers.iter().map(|l| l.strokes.len()).collect()).collect();
    let json = serde_json::to_vec(&serde_json::json!({
        "generation": d.generation, "device": d.device, "sheets": sheets,
        "viewports": d.viewports, "bookmarks": d.bookmarks, "layer_stroke_counts": counts,
    }))
    .unwrap();
    let v1 = 9 + json.len() + codec::encode(&strokes).len();
    let growth = v2 as f64 / v1 as f64 - 1.0;
    eprintln!("[size] v1 {v1} bytes, v2 {v2} bytes, +{:.2}%", growth * 100.0);
    assert!(growth <= 0.05, "sidecar grew {:.2}%", growth * 100.0);
}

// --- order keys ---

#[test]
fn bulk_keys_stay_short() {
    let keys = clock::keys_between(None, None, 2000);
    assert!(keys.windows(2).all(|w| w[0] < w[1]));
    assert!(keys.iter().all(|k| clock::is_valid_key(k)));
    let longest = keys.iter().map(|k| k.len()).max().unwrap();
    assert!(longest <= 4, "longest key {longest}");
}

proptest! {
    #[test]
    fn inserting_between_keys_always_fits(ops in prop::collection::vec(0usize..1000, 1..300)) {
        let mut keys: Vec<String> = Vec::new();
        for op in ops {
            let at = if keys.is_empty() { 0 } else { op % (keys.len() + 1) };
            let lo = at.checked_sub(1).map(|i| keys[i].as_str());
            let hi = keys.get(at).map(|k| k.as_str());
            let k = clock::key_between(lo, hi);
            prop_assert!(clock::is_valid_key(&k), "invalid key {k:?}");
            prop_assert!(lo.is_none_or(|lo| lo < k.as_str()) && hi.is_none_or(|hi| k.as_str() < hi));
            keys.insert(at, k);
        }
    }

    #[test]
    fn stamped_documents_round_trip(n in 1usize..40, pages in 1usize..6, seed in any::<u64>()) {
        let mut ids = IdGen::seeded(seed as u128);
        let mut d = Document::for_pdf(pages);
        for i in 0..n {
            d.push_stroke(i % pages, stroke(&mut ids, 40.0 + i as f64 * 7.0));
        }
        d.restamp(&me(), seed % 10_000);
        if n > 3 {
            let id = d.sheets[0].layers[0].strokes[0].id;
            d.remove_stroke(id);
            d.restamp(&DeviceIdentity { id: seed | 1, label: "x".into() }, 0);
        }
        prop_assert_eq!(roundtrip(&d), d);
    }
}

proptest! {
    /// The save path re-simplifies the frontend's copy of every stroke
    /// (`frontend_stroke_to_core`). If that changed an already simplified
    /// stroke, every save would stamp every stroke as modified.
    #[test]
    fn simplify_is_idempotent(raw in prop::collection::vec((-3.0f64..3.0, -3.0f64..3.0, -0.07f64..0.07), 4..300)) {
        // smooth pressure, as a pen reports it, so RDP (not the pressure
        // inflection rule) decides most points
        let (mut x, mut y, mut p) = (100.0, 100.0, 0.5f64);
        let pts: Vec<inkwell_core::ink::Sample> = raw.iter().enumerate().map(|(i, (dx, dy, dp))| {
            x += dx;
            y += dy;
            p = (p + dp).clamp(0.0, 1.0);
            inkwell_core::ink::Sample::new(x, y, p, i as f64 * 4.0)
        }).collect();
        let once = inkwell_core::ink::simplify(&pts, 0.10);
        let twice = inkwell_core::ink::simplify(&once, 0.10);
        prop_assert_eq!(once.len(), twice.len());
    }
}
