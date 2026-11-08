//! Plan 095: parametric shapes as native PDF annotations.

use inkwell_core::clock::{DeviceIdentity, ObjectId};
use inkwell_core::doc::{self, Document};
use inkwell_core::pdf::{self, PdfFile, SidecarStatus};
use inkwell_core::shape::{self, PathCmd, ShapeKind, ShapeObject};
use inkwell_core::wal::{Wal, WalEntry};

fn base_pdf() -> Vec<u8> {
    std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/lecture.pdf")).unwrap()
}

fn doc_with_fixtures() -> Document {
    let mut d = Document::for_pdf(1);
    for s in shape::fixtures() {
        d.upsert_shape(0, s);
    }
    d
}

fn save(d: &Document) -> Vec<u8> {
    let mut f = PdfFile::open(base_pdf()).unwrap();
    f.write_document(d, pdf::DEFAULT_GROUP).unwrap();
    f.finish()
}

/// The annotation dictionary carrying `/Inkw_Sid (shp_<id>)`.
fn annot_for<'a>(text: &'a str, id: &str) -> &'a str {
    let key = format!("/Inkw_Sid (shp_{id})");
    let at = text.find(&key).unwrap_or_else(|| panic!("no annotation for {id}"));
    let start = text[..at].rfind("<< /Type /Annot").expect("annotation start");
    &text[start..at + key.len()]
}

#[test]
fn every_kind_is_written_as_its_native_subtype() {
    let out = save(&doc_with_fixtures());
    let text = String::from_utf8_lossy(&out).into_owned();
    for (id, subtype) in [
        ("rect", "/Subtype /Square"),
        ("rounded", "/Subtype /Square"),
        ("ellipse", "/Subtype /Circle"),
        ("tilted", "/Subtype /Polygon"),
        ("arrow", "/Subtype /Line"),
        ("line", "/Subtype /Line"),
        ("triangle", "/Subtype /Polygon"),
        ("zigzag", "/Subtype /PolyLine"),
    ] {
        let a = annot_for(&text, id);
        assert!(a.contains(subtype), "{id}: {a}");
        assert!(a.contains("/AP << /N") && a.contains("/T (BezierNotes)") && a.contains(&format!("/NM ({id})")), "{id}: {a}");
    }
    let a = annot_for(&text, "arrow");
    assert!(a.contains("/LE [/None /ClosedArrow]"), "{a}");
    assert!(annot_for(&text, "line").contains("/LE [/ClosedArrow /ClosedArrow]"));
    assert!(annot_for(&text, "line").contains("/S /D /D [6 4]"));
    assert!(annot_for(&text, "rect").contains("/IC [0.950 0.850 0.200]"));
    // opacity is in the appearance only (an annotation /CA would apply twice)
    assert!(!annot_for(&text, "tilted").contains("/CA"));
    assert!(text.contains("/CA 0.500 /ca 0.500"));
    assert!(annot_for(&text, "rect").contains("/RD ["));
}

#[test]
fn square_and_circle_geometry_matches_their_appearance() {
    // STOP condition: /AP and native geometry must agree. A /Square's /Rect
    // minus /RD is the shape's own box, which is what /AP draws.
    let d = doc_with_fixtures();
    let out = save(&d);
    let text = String::from_utf8_lossy(&out).into_owned();
    let pbox = PdfFile::open(base_pdf()).unwrap().page_box_at(0).unwrap();
    let nums = |s: &str, key: &str| -> Vec<f64> {
        let i = s.find(key).unwrap() + key.len();
        let j = s[i..].find(']').unwrap() + i;
        s[i..j].split_whitespace().map(|v| v.parse().unwrap()).collect()
    };
    for id in ["rect", "ellipse"] {
        let a = annot_for(&text, id);
        let (r, rd) = (nums(a, "/Rect ["), nums(a, "/RD ["));
        let inner = [r[0] + rd[0], r[1] + rd[1], r[2] - rd[2], r[3] - rd[3]];
        let s = d.sheets[0].shapes.iter().find(|s| s.id == id).unwrap();
        let b = s.axis_aligned_box().unwrap();
        let want = [pbox[0] + b[0], pbox[3] - b[3], pbox[0] + b[2], pbox[3] - b[1]];
        for k in 0..4 {
            assert!((inner[k] - want[k]).abs() < 0.01, "{id}: {inner:?} vs {want:?}");
        }
    }
}

fn qpdf_check(bytes: &[u8]) -> Option<bool> {
    use std::process::Command;
    Command::new("qpdf").arg("--version").output().ok().filter(|o| o.status.success())?;
    let dir = tempfile::tempdir().ok()?;
    let p = dir.path().join("shapes.pdf");
    std::fs::write(&p, bytes).ok()?;
    Some(Command::new("qpdf").arg("--check").arg(&p).output().ok()?.status.success())
}

#[test]
fn shapes_round_trip_through_the_sidecar_and_pass_qpdf() {
    let mut d = doc_with_fixtures();
    d.assign_base_page_ids(b"x");
    d.restamp(&DeviceIdentity { id: 5, label: "t".into() }, 0);
    let out = save(&d);
    if let Some(ok) = qpdf_check(&out) {
        assert!(ok, "qpdf --check");
    }
    let SidecarStatus::Ok(back) = pdf::read_sidecar(&out).unwrap() else { panic!("sidecar") };
    assert_eq!(back.sheets[0].shapes, d.sheets[0].shapes);
    assert!(back.clocks.contains_key(&ObjectId::Shape("arrow".into())), "shapes are stamped");
    // and a second save replaces, not duplicates, our shape annotations
    let mut f = PdfFile::open(pdf::writable_base(&out).to_vec()).unwrap();
    f.write_document(&back, pdf::DEFAULT_GROUP).unwrap();
    let twice = f.finish();
    let n = |b: &[u8]| String::from_utf8_lossy(b).matches("/Inkw_Sid (shp_rect)").count();
    assert_eq!(n(&twice), 1);
}

#[test]
fn shapes_are_journalled_and_replayed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("j.bin");
    let s = shape::fixtures().remove(4);
    {
        let mut w = Wal::open(&path).unwrap();
        w.append(&WalEntry::ShapeUpsert { shape: s.clone() }).unwrap();
        w.append(&WalEntry::ShapeRemoved { id: "rect".into() }).unwrap();
    }
    let back = Wal::replay(&path).unwrap();
    assert_eq!(back, vec![WalEntry::ShapeUpsert { shape: s }, WalEntry::ShapeRemoved { id: "rect".into() }]);
}

#[test]
fn shapes_take_part_in_merge() {
    let me = DeviceIdentity { id: 3, label: "a".into() };
    let other = DeviceIdentity { id: 4, label: "b".into() };
    let mut base = Document::for_pdf(1);
    base.assign_base_page_ids(b"x");
    base.upsert_shape(0, shape::fixtures().remove(0));
    base.restamp(&me, 0);
    let base = doc::decode_sidecar(&doc::encode_sidecar(&base)).unwrap();
    let mut a = base.clone();
    a.upsert_shape(0, shape::fixtures().remove(4));
    a.restamp(&me, 0);
    let mut b = base.clone();
    b.remove_shape("rect");
    b.restamp(&other, 0);
    let r = inkwell_core::merge::merge(&a, &b).unwrap().doc;
    let ids: Vec<&str> = r.sheets[0].shapes.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, vec!["arrow"], "a's new arrow kept, b's delete of the rect honoured");
}

#[test]
fn affine_maps_keep_shapes_exact() {
    // rotating a rect's control points rotates the rect (no re-fitting)
    let s = shape::fixtures().remove(0);
    let (c, s30) = (30f64.to_radians().cos(), 30f64.to_radians().sin());
    let rot = |q: [f64; 2]| [q[0] * c - q[1] * s30, q[0] * s30 + q[1] * c];
    let r = ShapeObject { points: s.points.iter().map(|q| rot(*q)).collect(), ..s.clone() };
    let want: Vec<[f64; 2]> = s.corners().unwrap().iter().map(|q| rot(*q)).collect();
    for (g, w) in r.corners().unwrap().iter().zip(&want) {
        assert!((g[0] - w[0]).abs() < 1e-9 && (g[1] - w[1]).abs() < 1e-9);
    }
    assert!(r.axis_aligned_box().is_none(), "a rotated rect is no longer a /Square");
    assert_eq!(r.kind, ShapeKind::Rect);
}

/// The canvas renderer (`ink.js` `shapeOutline`) is a port of `outline`;
/// this file pins what both must produce. The smoke suite (T33) checks the
/// JS side against it.
#[test]
fn canvas_cross_check_fixture_is_current() {
    let cmd = |c: &PathCmd| -> serde_json::Value {
        match c {
            PathCmd::MoveTo(p) => serde_json::json!(["M", p[0], p[1]]),
            PathCmd::LineTo(p) => serde_json::json!(["L", p[0], p[1]]),
            PathCmd::CurveTo(a, b, e) => serde_json::json!(["C", a[0], a[1], b[0], b[1], e[0], e[1]]),
            PathCmd::Close => serde_json::json!(["Z"]),
        }
    };
    let cases: Vec<serde_json::Value> = shape::fixtures()
        .iter()
        .map(|s| {
            serde_json::json!({
                "shape": s,
                "outline": s.outline().iter().map(cmd).collect::<Vec<_>>(),
                "heads": s.arrow_heads(),
                "bbox": s.bbox(),
            })
        })
        .collect();
    let got = serde_json::to_string_pretty(&cases).unwrap() + "\n";
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/shape_paths.json");
    if std::env::var("UPDATE_GOLDEN").is_ok_and(|v| v == "1") {
        std::fs::write(&path, &got).unwrap();
        return;
    }
    let want = std::fs::read_to_string(&path).expect("missing shape_paths.json; run with UPDATE_GOLDEN=1");
    assert_eq!(got, want, "shape geometry changed: run UPDATE_GOLDEN=1 and update ink.js shapeOutline to match");
}
