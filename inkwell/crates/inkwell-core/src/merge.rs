//! Union merge of two copies of one notebook (Plan 092), built on the sync
//! metadata of Plan 091.
//!
//! Per object, a copy holds at most one *version* (the object, stamped with
//! its `modified` clock) and at most one *tombstone*. The merge keeps, per
//! object, the newest version and the newest tombstone, and the object is
//! alive unless the tombstone is newer than the version. That state is a
//! join-semilattice, so `merge` is commutative, associative and idempotent,
//! and needs no common ancestor: a version that loses to a tombstone, or a
//! tombstone that loses to a version, can be forgotten without changing any
//! later merge's outcome.
//!
//! Deletion vs. edit: an edit stamped after a delete wins, and a delete
//! stamped after the last edit wins. Pages are the exception the spec asks
//! for: a page survives its own deletion while any live object (ink, notes,
//! images, bookmarks) is on it, so ink is never lost to a page delete made on
//! another device.
//!
//! Both copies must be stamped (`Document::restamp`) and share the same base
//! PDF; `merge_files` checks the latter.

use crate::clock::{Clock, ObjClock, ObjectId, Peer, Tombstone};
use crate::doc::{Bookmark, Document, ImageObject, ShapeObject, Sheet, TextObject};
use crate::ink::Stroke;
use std::collections::{BTreeMap, BTreeSet, HashMap};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    /// The first argument: in the app, the open session.
    Ours,
    /// The second argument: the other copy.
    Theirs,
}

#[derive(Debug)]
pub enum MergeError {
    /// A copy has pages without ids: it was not stamped before merging.
    Unstamped,
    /// Two objects of one copy claim the same id; merging would keep only
    /// one of them.
    DuplicateObject(ObjectId),
    /// The copies are annotations on different PDFs.
    DifferentBase,
    Unreadable(String),
}

impl std::fmt::Display for MergeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MergeError::Unstamped => write!(f, "a copy has pages without ids (not stamped before merging)"),
            MergeError::DuplicateObject(id) => write!(f, "two objects share the id {id}"),
            MergeError::DifferentBase => write!(f, "these are different documents: their underlying PDFs differ"),
            MergeError::Unreadable(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for MergeError {}

/// An object both copies changed without seeing the other's change.
#[derive(Debug, Clone, PartialEq)]
pub struct Conflict {
    pub id: ObjectId,
    /// Short human-readable forms of the two versions (a note's text, a
    /// bookmark's label; "edited" for ink and images).
    pub ours: String,
    pub theirs: String,
    /// Which version the merge kept (the newer clock).
    pub winner: Side,
}

/// What the merge did, relative to `Ours`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MergeReport {
    /// Live in the result, not in ours.
    pub added: Vec<ObjectId>,
    /// In ours, deleted in the result.
    pub removed: Vec<ObjectId>,
    /// In both, and the result took their version.
    pub changed: Vec<ObjectId>,
    pub conflicts: Vec<Conflict>,
    /// Pages deleted in one copy but kept because the other has live objects
    /// on them.
    pub pages_kept_by_ink: Vec<u128>,
}

impl MergeReport {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.changed.is_empty() && self.pages_kept_by_ink.is_empty()
    }
}

#[derive(Debug)]
pub struct MergeResult {
    pub doc: Document,
    pub report: MergeReport,
}

#[derive(Clone, Copy)]
enum ObjRef<'d> {
    Page(&'d Sheet),
    Stroke(&'d Stroke),
    Image(&'d ImageObject),
    Text(&'d TextObject),
    Bookmark(&'d Bookmark),
    Shape(&'d ShapeObject),
    /// A form field value (no page).
    Field(&'d str, &'d str),
}

#[derive(Clone, Copy)]
struct Version<'d> {
    side: Side,
    /// The page holding the object (its own id for a page).
    page: u128,
    layer: usize,
    /// Position within its list, for a stable z-order among equal clocks.
    index: usize,
    clocks: ObjClock,
    hash: u64,
    obj: ObjRef<'d>,
}

impl Version<'_> {
    /// Newest wins; equal clocks with different content (only possible for
    /// unstamped pre-091 objects) fall back to the content hash, so the
    /// choice never depends on argument order.
    fn rank(&self) -> (Clock, u64) {
        (self.clocks.modified, self.hash)
    }
}

fn collect<'d>(doc: &'d Document, side: Side) -> Result<HashMap<ObjectId, Version<'d>>, MergeError> {
    let hashes = doc.object_hashes();
    let mut out: HashMap<ObjectId, Version<'d>> = HashMap::with_capacity(hashes.len());
    let mut put = |id: ObjectId, page: u128, layer: usize, index: usize, obj: ObjRef<'d>| {
        let hash = hashes.get(&id).copied().unwrap_or_default();
        let clocks = doc.clock_of(&id);
        match out.entry(id) {
            std::collections::hash_map::Entry::Occupied(e) => Err(MergeError::DuplicateObject(e.key().clone())),
            std::collections::hash_map::Entry::Vacant(e) => {
                e.insert(Version { side, page, layer, index, clocks, hash, obj });
                Ok(())
            }
        }
    };
    for (pi, sh) in doc.sheets.iter().enumerate() {
        let p = sh.page_id;
        if p == 0 {
            return Err(MergeError::Unstamped);
        }
        put(ObjectId::Page(p), p, 0, pi, ObjRef::Page(sh))?;
        for (li, l) in sh.layers.iter().enumerate() {
            for (si, s) in l.strokes.iter().enumerate() {
                put(ObjectId::Stroke(s.id), p, li, si, ObjRef::Stroke(s))?;
            }
        }
        for (ii, im) in sh.images.iter().enumerate() {
            put(ObjectId::Image(im.id.clone()), p, 0, ii, ObjRef::Image(im))?;
        }
        for (ti, t) in sh.text_objects.iter().enumerate() {
            put(ObjectId::Text(t.id.clone()), p, 0, ti, ObjRef::Text(t))?;
        }
        for (hi, s) in sh.shapes.iter().enumerate() {
            put(ObjectId::Shape(s.id.clone()), p, 0, hi, ObjRef::Shape(s))?;
        }
    }
    for (fi, (name, value)) in doc.form_values.iter().enumerate() {
        put(ObjectId::Field(name.clone()), 0, 0, fi, ObjRef::Field(name, value))?;
    }
    for (bi, b) in doc.bookmarks.iter().enumerate() {
        // Bookmarks point at a page index; carry the page's identity instead.
        let page = doc.sheets.get(b.page).map(|s| s.page_id).unwrap_or(0);
        put(ObjectId::Bookmark(b.id.clone()), page, 0, bi, ObjRef::Bookmark(b))?;
    }
    Ok(out)
}

fn summary(v: &Version<'_>) -> String {
    match v.obj {
        ObjRef::Text(t) => t.text.clone(),
        ObjRef::Bookmark(b) => b.label.clone(),
        ObjRef::Page(_) => "page settings".into(),
        ObjRef::Stroke(_) => "ink moved or restyled".into(),
        ObjRef::Image(_) => "image moved or resized".into(),
        ObjRef::Shape(_) => "shape moved or restyled".into(),
        ObjRef::Field(_, v) => v.to_string(),
    }
}

/// Whether `doc` holds a version newer than anything `other` has seen from
/// that version's device.
fn unseen_by(v: &Version<'_>, other: &Document) -> bool {
    let m = v.clocks.modified;
    !m.is_zero() && other.peers.get(&m.device).is_none_or(|p| m.lamport > p.clock)
}

/// Merge two stamped copies of one notebook. Pure; see the module docs for
/// the rules. Non-content fields (`device`, `viewports`) come from `ours`.
pub fn merge(ours: &Document, theirs: &Document) -> Result<MergeResult, MergeError> {
    let va = collect(ours, Side::Ours)?;
    let vb = collect(theirs, Side::Theirs)?;

    // newest tombstone per id
    let mut tombs: BTreeMap<ObjectId, Tombstone> = ours.tombstones.clone();
    for (id, t) in &theirs.tombstones {
        let e = tombs.entry(id.clone()).or_insert(*t);
        if t.clock > e.clock {
            *e = *t;
        }
    }

    // newest version per id
    let mut ids: BTreeSet<&ObjectId> = va.keys().collect();
    ids.extend(vb.keys());
    let mut winners: BTreeMap<ObjectId, Version<'_>> = BTreeMap::new();
    let mut report = MergeReport::default();
    for id in ids {
        let w = match (va.get(id), vb.get(id)) {
            (Some(a), Some(b)) => {
                if a.hash != b.hash && unseen_by(a, theirs) && unseen_by(b, ours) {
                    report.conflicts.push(Conflict {
                        id: id.clone(),
                        ours: summary(a),
                        theirs: summary(b),
                        winner: if b.rank() > a.rank() { Side::Theirs } else { Side::Ours },
                    });
                }
                if b.rank() > a.rank() { *b } else { *a }
            }
            (Some(a), None) => *a,
            (None, Some(b)) => *b,
            (None, None) => unreachable!("id came from one of the maps"),
        };
        winners.insert(id.clone(), w);
    }

    let beaten = |id: &ObjectId, w: &Version<'_>| tombs.get(id).is_some_and(|t| t.clock > w.clocks.modified);

    // live non-page objects, and the pages they keep alive
    let mut live: BTreeSet<ObjectId> = BTreeSet::new();
    let mut pages_in_use: BTreeSet<u128> = BTreeSet::new();
    for (id, w) in &winners {
        if !matches!(id, ObjectId::Page(_)) && !beaten(id, w) {
            live.insert(id.clone());
            if w.page != 0 {
                pages_in_use.insert(w.page);
            }
        }
    }
    let mut pages: Vec<(&str, u128, &Sheet)> = Vec::new();
    for (id, w) in &winners {
        let (ObjectId::Page(p), ObjRef::Page(sh)) = (id, w.obj) else { continue };
        let own = !beaten(id, w);
        if own || pages_in_use.contains(p) {
            if !own {
                report.pages_kept_by_ink.push(*p);
            }
            live.insert(id.clone());
            pages.push((sh.order_key.as_str(), *p, sh));
        }
    }
    pages.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));

    // assemble
    let mut doc = Document::default();
    doc.generation = ours.generation.max(theirs.generation);
    doc.device = ours.device.clone();
    doc.viewports = ours.viewports.clone();
    let mut page_index: HashMap<u128, usize> = HashMap::new();
    for (i, (_, p, sh)) in pages.iter().enumerate() {
        let mut s = (*sh).clone();
        for l in &mut s.layers {
            l.strokes.clear();
        }
        s.images.clear();
        s.text_objects.clear();
        s.shapes.clear();
        doc.sheets.push(s);
        page_index.insert(*p, i);
    }

    // z-order: creation clock, then position in the copy it came from
    let mut placed: Vec<(&ObjectId, &Version<'_>)> =
        winners.iter().filter(|(id, _)| live.contains(*id) && !matches!(id, ObjectId::Page(_))).collect();
    placed.sort_by(|(ia, a), (ib, b)| (a.clocks.created, a.index, *ia).cmp(&(b.clocks.created, b.index, *ib)));
    for (_, w) in placed {
        let pi = page_index.get(&w.page).copied();
        match w.obj {
            ObjRef::Stroke(s) => {
                let sh = &mut doc.sheets[pi.expect("a live object's page is live")];
                if sh.layers.is_empty() {
                    sh.layers.push(crate::doc::Layer::new("Ink"));
                }
                let li = if w.layer < sh.layers.len() { w.layer } else { 0 };
                sh.layers[li].strokes.push(s.clone());
            }
            ObjRef::Image(im) => {
                let pi = pi.expect("a live object's page is live");
                let mut im = im.clone();
                im.sheet = pi;
                doc.sheets[pi].images.push(im);
            }
            ObjRef::Text(t) => {
                let pi = pi.expect("a live object's page is live");
                let mut t = t.clone();
                t.sheet = pi;
                doc.sheets[pi].text_objects.push(t);
            }
            ObjRef::Field(name, value) => {
                doc.form_values.insert(name.to_string(), value.to_string());
            }
            ObjRef::Shape(sh) => {
                let pi = pi.expect("a live object's page is live");
                let mut sh = sh.clone();
                sh.sheet = pi;
                doc.sheets[pi].shapes.push(sh);
            }
            ObjRef::Bookmark(b) => {
                let mut b = b.clone();
                // A bookmark whose page index was out of range in its copy
                // keeps that index, clamped into the merged document.
                b.page = pi.unwrap_or_else(|| b.page.min(doc.sheets.len().saturating_sub(1)));
                doc.bookmarks.push(b);
            }
            ObjRef::Page(_) => unreachable!("pages were filtered out"),
        }
    }
    doc.reindex_bounded_sheets();

    for id in &live {
        let c = winners[id].clocks;
        if c != ObjClock::default() {
            doc.clocks.insert(id.clone(), c);
        }
    }
    for (id, t) in &tombs {
        // A tombstone a live object beat is forgotten; one that only lost to
        // "ink beats deletion" stays, so the page goes once the ink does.
        let keep = match winners.get(id) {
            Some(w) => beaten(id, w),
            None => true,
        };
        if keep {
            doc.tombstones.insert(id.clone(), *t);
        }
    }
    doc.peers = merge_peers(&ours.peers, &theirs.peers);
    doc.clock = ours.clock.max(theirs.clock);
    doc.observe_all();
    doc.seal();

    // report, relative to ours
    for (id, w) in &winners {
        let alive = live.contains(id);
        match va.get(id) {
            None if alive => report.added.push(id.clone()),
            Some(_) if !alive => report.removed.push(id.clone()),
            Some(a) if alive && w.side == Side::Theirs && w.hash != a.hash => report.changed.push(id.clone()),
            _ => {}
        }
    }
    Ok(MergeResult { doc, report })
}

fn merge_peers(a: &BTreeMap<u64, Peer>, b: &BTreeMap<u64, Peer>) -> BTreeMap<u64, Peer> {
    let mut out = a.clone();
    for (d, p) in b {
        match out.get_mut(d) {
            None => {
                out.insert(*d, p.clone());
            }
            Some(e) => {
                if (p.clock, &p.label) > (e.clock, &e.label) {
                    *e = p.clone();
                }
            }
        }
    }
    out
}

/// Take `from`'s version of the text note `id` into a merged document, for
/// a conflict the user resolved the other way. The note is left unsealed, so
/// the next `restamp` gives it a clock newer than both versions.
pub fn take_text(merged: &mut Document, from: &Document, id: &str) -> bool {
    let Some((page, t)) = from
        .sheets
        .iter()
        .find_map(|sh| sh.text_objects.iter().find(|t| t.id == id).map(|t| (sh.page_id, t.clone())))
    else {
        return false;
    };
    let Some(pi) = merged.sheets.iter().position(|s| s.page_id == page) else { return false };
    merged.remove_text(id);
    let mut t = t;
    t.sheet = pi;
    merged.sheets[pi].text_objects.push(t);
    true
}

// ---------------------------------------------------------------------------
// Whole files
// ---------------------------------------------------------------------------

/// A copy's document ready to merge: its sidecar (or an empty document when
/// it has none), with base page ids assigned the way the app assigns them at
/// open.
pub fn document_for_merge(bytes: &[u8], page_count: usize) -> Result<Document, MergeError> {
    use crate::pdf::{read_sidecar, SidecarStatus};
    let mut doc = match read_sidecar(bytes).map_err(|e| MergeError::Unreadable(e.to_string()))? {
        SidecarStatus::Ok(d) | SidecarStatus::Stale(d) => d,
        SidecarStatus::Absent => Document::for_pdf(page_count),
        SidecarStatus::Corrupt(e) => {
            return Err(MergeError::Unreadable(format!("its BezierNotes data is damaged ({e})")));
        }
    };
    while doc.sheets.len() < page_count {
        doc.sheets.push(Sheet::bounded(doc.sheets.len()));
    }
    if doc.sheets.iter().any(|s| s.page_id == 0) {
        doc.assign_base_page_ids(&crate::pdf::base_fingerprint(bytes));
    }
    Ok(doc)
}

/// Merge two saved copies of one notebook into new file bytes: the merged
/// document written as one generation on the shared base PDF. Refuses copies
/// of different PDFs. `me` stamps anything a copy left unstamped (files
/// saved before Plan 091).
pub fn merge_files(
    a: &[u8],
    b: &[u8],
    me: &crate::clock::DeviceIdentity,
    now_s: u64,
) -> Result<(Vec<u8>, MergeReport), MergeError> {
    if crate::pdf::base_fingerprint(a) != crate::pdf::base_fingerprint(b) {
        return Err(MergeError::DifferentBase);
    }
    let pages = |bytes: &[u8]| -> Result<usize, MergeError> {
        crate::pdf::PdfFile::open(crate::pdf::writable_base(bytes).to_vec())
            .map(|f| f.page_count())
            .map_err(|e| MergeError::Unreadable(e.to_string()))
    };
    let mut da = document_for_merge(a, pages(a)?)?;
    let mut db = document_for_merge(b, pages(b)?)?;
    da.restamp(me, now_s);
    db.restamp(me, now_s);
    let MergeResult { doc, report } = merge(&da, &db)?;
    // one generation on the shared base, as every save writes (Plan 088)
    let mut f = crate::pdf::PdfFile::open(crate::pdf::writable_base(a).to_vec()).map_err(|e| MergeError::Unreadable(e.to_string()))?;
    f.write_document(&doc, crate::pdf::DEFAULT_GROUP).map_err(|e| MergeError::Unreadable(e.to_string()))?;
    Ok((f.finish(), report))
}
