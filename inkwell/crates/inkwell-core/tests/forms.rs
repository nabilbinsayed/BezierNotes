//! Plan 096: filling AcroForm fields.

use inkwell_core::clock::{DeviceIdentity, ObjectId};
use inkwell_core::doc::{self, Document};
use inkwell_core::forms::FieldKind;
use inkwell_core::pdf::{self, PdfFile, SidecarStatus};
use inkwell_core::wal::{Wal, WalEntry};
use std::collections::BTreeMap;

fn fixture(rel: &str) -> Vec<u8> {
    std::fs::read(format!("{}/../../fixtures/{rel}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn values(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn fill(base: &[u8], vals: BTreeMap<String, String>) -> Vec<u8> {
    let mut f = PdfFile::open(base.to_vec()).unwrap();
    let mut d = Document::for_pdf(f.page_count());
    d.form_values = vals;
    f.write_document(&d, pdf::DEFAULT_GROUP).unwrap();
    f.finish()
}

fn qpdf_ok(bytes: &[u8]) -> Option<bool> {
    use std::process::Command;
    Command::new("qpdf").arg("--version").output().ok().filter(|o| o.status.success())?;
    let dir = tempfile::tempdir().ok()?;
    let p = dir.path().join("f.pdf");
    std::fs::write(&p, bytes).ok()?;
    Some(Command::new("qpdf").arg("--check").arg(&p).output().ok()?.status.success())
}

fn field_values(bytes: &[u8]) -> BTreeMap<String, String> {
    PdfFile::open(bytes.to_vec()).unwrap().form_fields().fields.into_iter().map(|f| (f.name, f.value)).collect()
}

#[test]
fn every_field_kind_is_read() {
    let info = PdfFile::open(fixture("forms/all_fields.pdf")).unwrap().form_fields();
    let kinds: Vec<(&str, FieldKind)> = info.fields.iter().map(|f| (f.name.as_str(), f.kind)).collect();
    assert_eq!(kinds, vec![
        ("name", FieldKind::Text), ("notes", FieldKind::Text), ("zip", FieldKind::Text),
        ("agree", FieldKind::Checkbox), ("size", FieldKind::Radio), ("country", FieldKind::Combo),
        ("colour", FieldKind::List), ("id", FieldKind::Text), ("city", FieldKind::Text),
    ]);
    let get = |n: &str| info.fields.iter().find(|f| f.name == n).unwrap();
    assert_eq!(get("name").value, "Ada Lovelace");
    assert!(get("notes").multiline && get("zip").comb && get("zip").max_len == Some(5));
    assert!(get("id").read_only);
    assert_eq!(get("city").quadding, 1);
    assert_eq!(get("country").options[2], ("jp".into(), "Japan".into()));
    let size: Vec<_> = get("size").widgets.iter().map(|w| w.on_state.clone().unwrap()).collect();
    assert_eq!(size, vec!["Small", "Large"]);
    assert!(!info.has_scripts && !info.xfa);
}

#[test]
fn filled_values_are_written_with_appearances_and_reread() {
    let base = fixture("forms/all_fields.pdf");
    let out = fill(&base, values(&[
        ("name", "নমস্কার Ada"), ("notes", "line one\nline two"), ("zip", "12345"), ("agree", "Yes"),
        ("size", "Large"), ("country", "jp"), ("colour", "Green"), ("id", "hacked"), ("city", "Dhaka"),
    ]));
    assert!(out.starts_with(&base), "append-only");
    if let Some(ok) = qpdf_ok(&out) {
        assert!(ok, "qpdf --check");
    }
    let v = field_values(&out);
    assert_eq!(v["name"], "নমস্কার Ada");
    assert_eq!(v["notes"], "line one\nline two");
    assert_eq!(v["agree"], "Yes");
    assert_eq!(v["size"], "Large");
    assert_eq!(v["country"], "jp");
    assert_eq!(v["id"], "fixed-123", "read-only fields are never written");
    let text = String::from_utf8_lossy(&out[base.len()..]).into_owned();
    assert!(text.contains("/AS /Large") && text.contains("/AS /Off"), "radio widgets switched");
    assert!(text.contains("/AS /Yes"));
    // every written text widget got an /AP (STOP: never /V without one)
    for name in ["name", "notes", "zip", "country", "colour", "city"] {
        let f = PdfFile::open(out.clone()).unwrap().form_fields().fields.into_iter().find(|f| f.name == name).unwrap();
        let w = f.widgets[0].obj;
        let at = text.find(&format!("\n{w} 0 obj")).unwrap_or_else(|| panic!("{name}'s widget not rewritten"));
        let body = &text[at..at + text[at..].find("endobj").unwrap()];
        assert!(body.contains("/AP << /N"), "{name}: {body}");
    }
}

#[test]
fn values_round_trip_through_the_sidecar_and_resaving_does_not_stack() {
    let base = fixture("forms/all_fields.pdf");
    let mut d = Document::for_pdf(1);
    d.form_values = values(&[("name", "Grace"), ("agree", "Yes")]);
    d.assign_base_page_ids(b"x");
    d.restamp(&DeviceIdentity { id: 3, label: "t".into() }, 0);
    let mut f = PdfFile::open(base.clone()).unwrap();
    f.write_document(&d, pdf::DEFAULT_GROUP).unwrap();
    let once = f.finish();
    let SidecarStatus::Ok(back) = pdf::read_sidecar(&once).unwrap() else { panic!() };
    assert_eq!(back.form_values, d.form_values);
    assert!(back.clocks.contains_key(&ObjectId::Field("name".into())));
    // second save rebases on the original: one generation, same values
    let mut f = PdfFile::open(pdf::writable_base(&once).to_vec()).unwrap();
    f.write_document(&back, pdf::DEFAULT_GROUP).unwrap();
    let twice = f.finish();
    assert_eq!(field_values(&twice)["name"], "Grace");
    assert!(twice.len() < once.len() + once.len() / 2, "no stacked generations");
}

#[test]
fn a_real_irs_form_with_object_streams_is_filled() {
    let base = fixture("corpus/irs_w9.pdf");
    let info = PdfFile::open(base.clone()).unwrap().form_fields();
    assert!(info.fields.len() >= 20 && info.xfa, "W-9 is an XFA hybrid with an AcroForm");
    let text = info.fields.iter().find(|f| f.kind == FieldKind::Text).unwrap().name.clone();
    let check = info.fields.iter().find(|f| f.kind == FieldKind::Checkbox).unwrap();
    let on = check.widgets[0].on_state.clone().unwrap();
    let out = fill(&base, values(&[(&text, "Nabil Bin Sayed"), (&check.name, &on)]));
    assert!(out.starts_with(&base));
    if let Some(ok) = qpdf_ok(&out) {
        assert!(ok);
    }
    let v = field_values(&out);
    assert_eq!(v[&text], "Nabil Bin Sayed");
    assert_eq!(v[&check.name], on);
}

#[test]
fn field_values_merge_last_writer_wins_and_are_journalled() {
    let a_dev = DeviceIdentity { id: 1, label: "a".into() };
    let b_dev = DeviceIdentity { id: 2, label: "b".into() };
    let mut base = Document::for_pdf(1);
    base.assign_base_page_ids(b"x");
    base.form_values = values(&[("name", "first")]);
    base.restamp(&a_dev, 0);
    let base = doc::decode_sidecar(&doc::encode_sidecar(&base)).unwrap();
    let mut a = base.clone();
    a.form_values.insert("city".into(), "Dhaka".into());
    a.restamp(&a_dev, 0);
    let mut b = base.clone();
    b.form_values.insert("other".into(), "x".into());
    b.restamp(&b_dev, 0);
    b.form_values.insert("name".into(), "second".into());
    b.restamp(&b_dev, 0);
    let r = inkwell_core::merge::merge(&a, &b).unwrap().doc;
    assert_eq!(r.form_values["name"], "second");
    assert_eq!(r.form_values["city"], "Dhaka");

    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("j");
    Wal::open(&p).unwrap().append(&WalEntry::FieldValue { name: "name".into(), value: "x".into() }).unwrap();
    assert_eq!(Wal::replay(&p).unwrap(), vec![WalEntry::FieldValue { name: "name".into(), value: "x".into() }]);
}
