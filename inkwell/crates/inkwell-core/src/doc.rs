//! Document model and the sidecar container.

use crate::clock::{self, Clock, DeviceId, DeviceIdentity, Fnv, ObjClock, ObjectId, Peer, Tombstone};
use crate::codec;
use crate::ink::{Stroke, NOMINAL_HZ};
pub use crate::shape::ShapeObject;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SheetKind {
    /// A page that came from the imported PDF. Bounded.
    BoundedPage { source_pdf_page: usize },
    /// An unbounded region. Materialised into real pages on save; the true
    /// unbounded coordinates live here so reopening is exact.
    FreeCanvas,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Layer {
    pub name: String,
    pub visible: bool,
    #[serde(skip)]
    pub strokes: Vec<Stroke>,
}

impl Layer {
    pub fn new(name: impl Into<String>) -> Self {
        Self { name: name.into(), visible: true, strokes: Vec::new() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageObject {
    pub id: String,
    pub sheet: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub data_url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextObject {
    pub id: String,
    pub sheet: usize,
    pub x: f64,
    pub y: f64,
    pub text: String,
    pub font_size: f64,
    pub color: String,
    pub bold: bool,
    pub italic: bool,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Bookmark {
    pub id: String,
    pub page: usize,
    pub label: String,
    #[serde(default)]
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sheet {
    pub kind: SheetKind,
    pub layers: Vec<Layer>,
    #[serde(default)]
    pub images: Vec<ImageObject>,
    #[serde(default)]
    pub text_objects: Vec<TextObject>,
    #[serde(default)]
    pub template: Option<String>,
    /// Parametric shapes (Plan 095), drawn above strokes, below text notes.
    /// Not written when empty, so documents without shapes encode exactly as
    /// before.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shapes: Vec<ShapeObject>,
    /// Stable identity across devices (Plan 091). `0` = not assigned yet: base
    /// PDF pages get one derived from the base file at open
    /// (`Document::assign_base_page_ids`), new pages one at the next save.
    #[serde(default, with = "clock::hex_u128")]
    pub page_id: u128,
    /// Fractional position key (`clock::key_between`); page order is the
    /// order of these keys. Empty = not assigned yet.
    #[serde(default)]
    pub order_key: String,
}

impl Sheet {
    pub fn bounded(page: usize) -> Self {
        Self {
            kind: SheetKind::BoundedPage { source_pdf_page: page },
            layers: vec![Layer::new("Ink")],
            images: Vec::new(),
            text_objects: Vec::new(),
            template: None,
            shapes: Vec::new(),
            page_id: 0,
            order_key: String::new(),
        }
    }
    /// An infinite canvas sheet (Plan 097): no PDF page behind it; its
    /// content is tiled into pages on save (`pdf::CANVAS_TILE`).
    pub fn canvas() -> Self {
        Self {
            kind: SheetKind::FreeCanvas,
            layers: vec![Layer::new("Ink")],
            images: Vec::new(),
            text_objects: Vec::new(),
            template: Some("dot".into()),
            shapes: Vec::new(),
            page_id: 0,
            order_key: String::new(),
        }
    }

    pub fn blank() -> Self {
        Self {
            kind: SheetKind::BoundedPage { source_pdf_page: usize::MAX },
            layers: vec![Layer::new("Ink")],
            images: Vec::new(),
            text_objects: Vec::new(),
            template: None,
            shapes: Vec::new(),
            page_id: 0,
            order_key: String::new(),
        }
    }
    pub fn strokes(&self) -> impl Iterator<Item = &Stroke> {
        self.layers.iter().flat_map(|l| l.strokes.iter())
    }
    pub fn stroke_count(&self) -> usize {
        self.layers.iter().map(|l| l.strokes.len()).sum()
    }
    pub fn push_image(&mut self, image: ImageObject) {
        if let Some(existing) = self.images.iter_mut().find(|im| im.id == image.id) {
            *existing = image;
        } else {
            self.images.push(image);
        }
    }
    pub fn remove_image(&mut self, id: &str) -> bool {
        if let Some(pos) = self.images.iter().position(|im| im.id == id) {
            self.images.remove(pos);
            true
        } else {
            false
        }
    }
    pub fn upsert_text(&mut self, text_obj: TextObject) {
        if let Some(existing) = self.text_objects.iter_mut().find(|t| t.id == text_obj.id) {
            *existing = text_obj;
        } else {
            self.text_objects.push(text_obj);
        }
    }
    pub fn remove_text(&mut self, id: &str) -> bool {
        if let Some(pos) = self.text_objects.iter().position(|t| t.id == id) {
            self.text_objects.remove(pos);
            true
        } else {
            false
        }
    }
    pub fn remove_shape(&mut self, id: &str) -> bool {
        if let Some(pos) = self.shapes.iter().position(|s| s.id == id) {
            self.shapes.remove(pos);
            true
        } else {
            false
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub model: String,
    pub report_hz: f64,
    pub tilt: bool,
}

impl Default for DeviceInfo {
    fn default() -> Self {
        Self { model: "unknown".into(), report_hz: NOMINAL_HZ, tilt: false }
    }
}

/// A viewport is a window onto the document. Several may exist at once with
/// independent zoom and scroll -- this is what makes the split "PDF left, blank
/// page right" layout cheap. First-class from day one on purpose; retrofitting
/// it later is painful.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Viewport {
    pub sheet: usize,
    pub pan: (f64, f64),
    pub zoom: f64,
}

impl Default for Viewport {
    fn default() -> Self {
        Self { sheet: 0, pan: (0.0, 0.0), zoom: 1.0 }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Document {
    pub generation: u64,
    pub device: DeviceInfo,
    pub sheets: Vec<Sheet>,
    pub viewports: Vec<Viewport>,
    #[serde(default)]
    pub bookmarks: Vec<Bookmark>,
    // --- sync metadata (Plan 091, see `clock`) ---
    /// The largest Lamport value this document has seen.
    #[serde(default)]
    pub clock: u64,
    #[serde(default)]
    pub peers: BTreeMap<DeviceId, Peer>,
    /// Sparse: an object without an entry has zero clocks.
    #[serde(default)]
    pub clocks: BTreeMap<ObjectId, ObjClock>,
    #[serde(default)]
    pub tombstones: BTreeMap<ObjectId, Tombstone>,
    /// Values the user gave the PDF's own form fields (Plan 096), by fully
    /// qualified field name. Only fields the user touched are listed.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub form_values: BTreeMap<String, String>,
    /// Content hashes of every object as last loaded or stamped; what
    /// `restamp` diffs against. A cache, not document state.
    #[serde(skip)]
    known: Known,
}

/// Equality ignores it: two documents with the same content and clocks are
/// equal however they were reached.
#[derive(Debug, Clone, Default)]
struct Known(HashMap<ObjectId, u64>);

impl PartialEq for Known {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}

impl Default for Document {
    fn default() -> Self {
        Self {
            generation: 0,
            device: DeviceInfo::default(),
            sheets: Vec::new(),
            viewports: vec![Viewport::default()],
            bookmarks: Vec::new(),
            clock: 0,
            peers: BTreeMap::new(),
            clocks: BTreeMap::new(),
            tombstones: BTreeMap::new(),
            form_values: BTreeMap::new(),
            known: Known::default(),
        }
    }
}

impl Document {
    /// Create a document shadowing an imported PDF of `n` pages.
    pub fn for_pdf(n_pages: usize) -> Self {
        Self { sheets: (0..n_pages).map(Sheet::bounded).collect(), ..Default::default() }
    }

    pub fn insert_sheet(&mut self, index: usize) {
        let insert_at = index.min(self.sheets.len());
        self.sheets.insert(insert_at, Sheet::bounded(insert_at));
        self.reindex_bounded_sheets();
    }

    pub fn duplicate_sheet(&mut self, index: usize) -> Option<usize> {
        if index >= self.sheets.len() {
            return None;
        }
        let mut cloned = self.sheets[index].clone();
        let target_idx = index + 1;
        let seed = ((index as u128) << 64) | (target_idx as u128);
        for (i, layer) in cloned.layers.iter_mut().enumerate() {
            for (j, stroke) in layer.strokes.iter_mut().enumerate() {
                stroke.id = stroke.id.wrapping_add(seed).wrapping_add(((i * 1000 + j + 1) as u128).wrapping_mul(0x9e3779b97f4a7c15));
            }
        }
        for (i, img) in cloned.images.iter_mut().enumerate() {
            img.sheet = target_idx;
            img.id = format!("{}_dup_{}_{}", img.id, target_idx, i);
        }
        for (i, txt) in cloned.text_objects.iter_mut().enumerate() {
            txt.sheet = target_idx;
            txt.id = format!("{}_dup_{}_{}", txt.id, target_idx, i);
        }
        for (i, sh) in cloned.shapes.iter_mut().enumerate() {
            sh.sheet = target_idx;
            sh.id = format!("{}_dup_{}_{}", sh.id, target_idx, i);
        }
        // A copy is a new page, not a second instance of this one.
        cloned.page_id = 0;
        cloned.order_key.clear();
        self.sheets.insert(target_idx, cloned);
        self.reindex_bounded_sheets();
        Some(target_idx)
    }

    pub fn delete_sheet(&mut self, index: usize) -> bool {
        if index >= self.sheets.len() || self.sheets.len() <= 1 {
            return false;
        }
        self.sheets.remove(index);
        self.reindex_bounded_sheets();
        true
    }

    pub fn reorder_sheet(&mut self, from: usize, to: usize) -> bool {
        if from >= self.sheets.len() || to >= self.sheets.len() {
            return false;
        }
        if from == to {
            return true;
        }
        let sheet = self.sheets.remove(from);
        self.sheets.insert(to, sheet);
        self.reindex_bounded_sheets();
        true
    }

    pub fn reindex_bounded_sheets(&mut self) {
        for (i, sheet) in self.sheets.iter_mut().enumerate() {
            if let SheetKind::BoundedPage { ref mut source_pdf_page } = sheet.kind {
                *source_pdf_page = i;
            }
        }
    }

    pub fn stroke_count(&self) -> usize {
        self.sheets.iter().map(|s| s.stroke_count()).sum()
    }

    pub fn sample_count(&self) -> usize {
        self.sheets.iter().flat_map(|s| s.strokes()).map(|s| s.samples.len()).sum()
    }

    pub fn push_stroke(&mut self, sheet: usize, stroke: Stroke) {
        while self.sheets.len() <= sheet {
            self.sheets.push(Sheet::bounded(self.sheets.len()));
        }
        if let Some(sh) = self.sheets.get_mut(sheet) {
            if sh.layers.is_empty() {
                sh.layers.push(Layer::new("Ink"));
            }
            sh.layers[0].strokes.push(stroke);
        }
    }


    /// Remove a stroke by id from anywhere in the document.
    pub fn remove_stroke(&mut self, id: u128) -> bool {
        for sh in &mut self.sheets {
            for l in &mut sh.layers {
                if let Some(i) = l.strokes.iter().position(|s| s.id == id) {
                    l.strokes.remove(i);
                    return true;
                }
            }
        }
        false
    }

    pub fn push_image(&mut self, sheet: usize, image: ImageObject) {
        self.remove_image(&image.id);
        while self.sheets.len() <= sheet {
            self.sheets.push(Sheet::bounded(self.sheets.len()));
        }
        if let Some(sh) = self.sheets.get_mut(sheet) {
            sh.push_image(image);
        }
    }

    pub fn remove_image(&mut self, id: &str) -> bool {
        for sh in &mut self.sheets {
            if sh.remove_image(id) {
                return true;
            }
        }
        false
    }

    pub fn upsert_text(&mut self, sheet: usize, text_obj: TextObject) {
        self.remove_text(&text_obj.id);
        while self.sheets.len() <= sheet {
            self.sheets.push(Sheet::bounded(self.sheets.len()));
        }
        if let Some(sh) = self.sheets.get_mut(sheet) {
            sh.upsert_text(text_obj);
        }
    }

    pub fn remove_text(&mut self, id: &str) -> bool {
        for sh in &mut self.sheets {
            if sh.remove_text(id) {
                return true;
            }
        }
        false
    }

    /// Insert or replace a shape (by id), moving it to `sheet`.
    pub fn upsert_shape(&mut self, sheet: usize, mut shape: ShapeObject) {
        self.remove_shape(&shape.id);
        while self.sheets.len() <= sheet {
            self.sheets.push(Sheet::bounded(self.sheets.len()));
        }
        shape.sheet = sheet;
        self.sheets[sheet].shapes.push(shape);
    }

    pub fn remove_shape(&mut self, id: &str) -> bool {
        self.sheets.iter_mut().any(|sh| sh.remove_shape(id))
    }

    /// Erase all strokes on a given sheet whose centreline passes within
    /// `radius` (in PDF user-units) of point `(px, py)`.
    /// Returns the IDs of removed strokes.
    pub fn erase_strokes_near(&mut self, sheet: usize, px: f64, py: f64, radius: f64) -> Vec<u128> {
        let mut removed = Vec::new();
        let Some(sh) = self.sheets.get_mut(sheet) else { return removed };
        for layer in &mut sh.layers {
            layer.strokes.retain(|s| {
                let max_r = radius + s.brush.base_width * 0.5;
                if let Some(b) = s.bbox() {
                    if px + max_r < b[0] || px - max_r > b[2] || py + max_r < b[1] || py - max_r > b[3] {
                        return true;
                    }
                }
                let hit = s.samples.iter().any(|samp| {
                    let (sx, sy) = (samp.x, samp.y);
                    (sx - px).hypot(sy - py) < max_r
                });
                if hit { removed.push(s.id); }
                !hit
            });
        }
        removed
    }

    /// Erase all strokes on a given sheet whose bounding box intersects the
    /// axis-aligned rectangle `[x0, y0, x1, y1]` (PDF user-units).
    /// Returns the IDs of removed strokes.
    pub fn erase_strokes_in_rect(&mut self, sheet: usize, x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<u128> {
        let mut removed = Vec::new();
        let (rx0, rx1) = if x0 < x1 { (x0, x1) } else { (x1, x0) };
        let (ry0, ry1) = if y0 < y1 { (y0, y1) } else { (y1, y0) };
        let Some(sh) = self.sheets.get_mut(sheet) else { return removed };
        for layer in &mut sh.layers {
            layer.strokes.retain(|s| {
                if let Some(b) = s.bbox() {
                    if rx1 < b[0] || rx0 > b[2] || ry1 < b[1] || ry0 > b[3] {
                        return true;
                    }
                }
                let hit = s.samples.iter().any(|samp| {
                    samp.x >= rx0 && samp.x <= rx1 && samp.y >= ry0 && samp.y <= ry1
                });
                if hit { removed.push(s.id); }
                !hit
            });
        }
        removed
    }
}

// ---------------------------------------------------------------------------
// Sync metadata (Plan 091)
// ---------------------------------------------------------------------------

/// Object positions are compared at 1/100 pt.
const POS_Q: f64 = 100.0;

fn page_hash(sh: &Sheet) -> u64 {
    let mut h = Fnv::new();
    // `source_pdf_page` is just the current index (see
    // `reindex_bounded_sheets`), so only the kind itself counts.
    h.word(match sh.kind {
        SheetKind::BoundedPage { .. } => 1,
        SheetKind::FreeCanvas => 2,
    });
    h.bytes(sh.template.as_deref().unwrap_or("\0").as_bytes());
    h.bytes(sh.order_key.as_bytes());
    for l in &sh.layers {
        h.bytes(l.name.as_bytes()).word(l.visible as u64);
    }
    h.finish()
}

fn stroke_hash(page: u128, s: &Stroke) -> u64 {
    // Strokes are not immutable in practice: a lasso move rewrites samples in
    // place under the same id. So their content is hashed like any object's.
    // Hashed at the codec's resolution: the save path rebuilds strokes from
    // the frontend's copy, and float noise below what the file can store is
    // not an edit.
    let mut h = Fnv::new();
    h.word(page as u64).word((page >> 64) as u64).word(s.kind.as_u8() as u64);
    for c in s.rgb {
        h.q(c.clamp(0.0, 1.0), 255.0);
    }
    h.q(s.brush.base_width, 100.0).q(s.brush.gamma, 1000.0).q(s.brush.min_ratio, 1000.0);
    for sm in &s.samples {
        h.q(sm.x, codec::QUANT).q(sm.y, codec::QUANT).q(sm.p.clamp(0.0, 1.0), codec::PQUANT).q(sm.t, codec::TQUANT);
    }
    h.finish()
}

fn image_hash(page: u128, im: &ImageObject) -> u64 {
    let mut h = Fnv::new();
    h.word(page as u64).word((page >> 64) as u64);
    h.q(im.x, POS_Q).q(im.y, POS_Q).q(im.width, POS_Q).q(im.height, POS_Q).bytes(im.data_url.as_bytes());
    h.finish()
}

fn text_hash(page: u128, t: &TextObject) -> u64 {
    let mut h = Fnv::new();
    h.word(page as u64).word((page >> 64) as u64);
    h.q(t.x, POS_Q).q(t.y, POS_Q).q(t.width, POS_Q).q(t.height, POS_Q).q(t.font_size, POS_Q);
    h.bytes(t.text.as_bytes()).bytes(t.color.as_bytes()).word(t.bold as u64).word(t.italic as u64);
    h.finish()
}

fn shape_hash(page: u128, s: &ShapeObject) -> u64 {
    let mut h = Fnv::new();
    h.word(page as u64).word((page >> 64) as u64);
    h.bytes(serde_json::to_string(&s.kind).unwrap_or_default().as_bytes());
    for p in &s.points {
        h.q(p[0], POS_Q).q(p[1], POS_Q);
    }
    for c in s.stroke_rgb {
        h.q(c, 255.0);
    }
    h.q(s.stroke_width, POS_Q).q(s.opacity, 1000.0).q(s.corner_radius, POS_Q);
    match s.fill_rgb {
        Some(f) => {
            h.word(1);
            for c in f {
                h.q(c, 255.0);
            }
        }
        None => {
            h.word(0);
        }
    }
    for d in s.dash.iter().flatten() {
        h.q(*d, POS_Q);
    }
    h.word(s.arrow_start as u64).word(s.arrow_end as u64);
    h.finish()
}

fn bookmark_hash(page: u128, b: &Bookmark) -> u64 {
    // By page identity, like every other object: a bookmark whose page index
    // shifts because an earlier page was deleted now points at another page.
    let mut h = Fnv::new();
    h.word(page as u64).word((page >> 64) as u64).bytes(b.label.as_bytes()).word(b.created_at);
    h.finish()
}

impl Document {
    /// Every object with its content hash. Objects are hashed with the id of
    /// the page holding them, so moving one to another page is a change but
    /// reordering pages is not.
    pub(crate) fn object_hashes(&self) -> HashMap<ObjectId, u64> {
        let mut out = HashMap::with_capacity(self.stroke_count() + self.sheets.len() + self.bookmarks.len());
        for sh in &self.sheets {
            let p = sh.page_id;
            // An unassigned page has no identity yet; `restamp` gives it one.
            if p != 0 {
                out.insert(ObjectId::Page(p), page_hash(sh));
            }
            for s in sh.strokes() {
                out.insert(ObjectId::Stroke(s.id), stroke_hash(p, s));
            }
            for im in &sh.images {
                out.insert(ObjectId::Image(im.id.clone()), image_hash(p, im));
            }
            for t in &sh.text_objects {
                out.insert(ObjectId::Text(t.id.clone()), text_hash(p, t));
            }
            for s in &sh.shapes {
                out.insert(ObjectId::Shape(s.id.clone()), shape_hash(p, s));
            }
        }
        for (name, value) in &self.form_values {
            let mut h = Fnv::new();
            h.bytes(value.as_bytes());
            out.insert(ObjectId::Field(name.clone()), h.finish());
        }
        for b in &self.bookmarks {
            let page = self.sheets.get(b.page).map_or(0, |s| s.page_id);
            out.insert(ObjectId::Bookmark(b.id.clone()), bookmark_hash(page, b));
        }
        out
    }

    /// Clocks of one object (zero if it has none).
    pub fn clock_of(&self, id: &ObjectId) -> ObjClock {
        self.clocks.get(id).copied().unwrap_or_default()
    }

    fn tick(&mut self, device: DeviceId) -> Clock {
        self.clock += 1;
        Clock { lamport: self.clock, device }
    }

    /// Raise `clock` to the largest value recorded anywhere in the document,
    /// so the next local tick is newer than everything already in it.
    pub(crate) fn observe_all(&mut self) {
        let mut hi = self.clock;
        for c in self.clocks.values() {
            hi = hi.max(c.created.lamport).max(c.modified.lamport);
        }
        for t in self.tombstones.values() {
            hi = hi.max(t.clock.lamport);
        }
        for p in self.peers.values() {
            hi = hi.max(p.clock);
        }
        self.clock = hi;
    }

    /// Record the current content as the baseline `restamp` diffs against.
    /// Done by `decode_sidecar`; call it after building a document by other
    /// means only if its objects should count as already stamped.
    pub fn seal(&mut self) {
        self.known = Known(self.object_hashes());
    }

    /// Give base PDF pages that have no id yet one derived from the base file
    /// and their position, so two devices opening the same file agree.
    /// `base_fingerprint` identifies the original bytes (e.g. their SHA-256).
    /// Call it at open, before any edit is applied.
    pub fn assign_base_page_ids(&mut self, base_fingerprint: &[u8]) {
        let mut assigned = false;
        for (i, sh) in self.sheets.iter_mut().enumerate() {
            if sh.page_id == 0 {
                sh.page_id = clock::derive_u128(&[b"base-page", base_fingerprint, &(i as u64).to_le_bytes()]);
                assigned = true;
            }
        }
        // Ids are identity, not content: assigning them is not an edit, but
        // it changes every hash on those pages, so re-take the baseline.
        if assigned && !self.known.0.is_empty() {
            self.seal();
        }
    }

    /// Stamp everything that changed since the last `seal`/`restamp` with a
    /// fresh clock from `me`: new objects get `created`, changed ones
    /// `modified`, vanished ones a tombstone. Also assigns missing page ids
    /// and order keys, and collects old tombstones. Call before encoding.
    /// Returns whether anything was stamped.
    pub fn restamp(&mut self, me: &DeviceIdentity, now_s: u64) -> bool {
        self.observe_all();
        let before = self.clock;

        for i in 0..self.sheets.len() {
            if self.sheets[i].page_id == 0 {
                let c = self.tick(me.id);
                self.sheets[i].page_id =
                    clock::derive_u128(&[b"page", &me.id.to_le_bytes(), &c.lamport.to_le_bytes()]);
            }
        }
        self.assign_order_keys();

        let current = self.object_hashes();
        let known = std::mem::take(&mut self.known.0);
        // Deterministic stamping order, so equal edits give equal clocks.
        let mut ids: Vec<&ObjectId> = current.keys().collect();
        ids.sort();
        for id in ids {
            let h = current[id];
            match known.get(id) {
                None => {
                    let c = self.tick(me.id);
                    self.clocks.insert(id.clone(), ObjClock { created: c, modified: c });
                    // Re-added (an undone delete): alive again.
                    self.tombstones.remove(id);
                }
                Some(&old) if old != h => {
                    let c = self.tick(me.id);
                    self.clocks.entry(id.clone()).or_default().modified = c;
                }
                Some(_) => {}
            }
        }
        let mut gone: Vec<&ObjectId> = known.keys().filter(|id| !current.contains_key(*id)).collect();
        gone.sort();
        for id in gone {
            let c = self.tick(me.id);
            self.clocks.remove(id);
            self.tombstones.insert(id.clone(), Tombstone { clock: c, unix_s: now_s });
        }
        self.known = Known(current);

        let stamped = self.clock != before;
        if stamped || !self.peers.contains_key(&me.id) {
            let peer = self.peers.entry(me.id).or_default();
            peer.clock = self.clock;
            peer.label = me.label.clone();
        }
        self.collect_tombstones(now_s);
        stamped
    }

    /// Keep the longest run of pages whose keys are already in order and give
    /// every other page a key between its kept neighbours, so a reorder
    /// changes one key, not every key after it.
    fn assign_order_keys(&mut self) {
        // Page order is (key, page id): a merge can leave two pages with one
        // key (concurrent inserts at the same spot), and that is in order.
        let keys: Vec<Option<(&str, u128)>> = self
            .sheets
            .iter()
            .map(|s| Some((s.order_key.as_str(), s.page_id)).filter(|(k, _)| clock::is_valid_key(k)))
            .collect();
        let keep = clock::longest_increasing(&keys);
        if keep.len() == self.sheets.len() {
            return;
        }
        let mut kept = vec![false; self.sheets.len()];
        for &i in &keep {
            kept[i] = true;
        }
        let mut i = 0;
        while i < self.sheets.len() {
            if kept[i] {
                i += 1;
                continue;
            }
            let start = i;
            let lo = start.checked_sub(1).map(|j| self.sheets[j].order_key.clone());
            // A fresh key must fall strictly between its neighbours' keys; if
            // the next kept page shares the previous one's key, re-key it too.
            while i < self.sheets.len() && (!kept[i] || lo.as_deref().is_some_and(|lo| self.sheets[i].order_key.as_str() <= lo)) {
                i += 1;
            }
            let hi = self.sheets.get(i).map(|s| s.order_key.clone());
            let fresh = clock::keys_between(lo.as_deref(), hi.as_deref(), i - start);
            for (sh, k) in self.sheets[start..i].iter_mut().zip(fresh) {
                sh.order_key = k;
            }
        }
    }

    /// Drop tombstones that are both older than `TOMBSTONE_MIN_AGE_S` and
    /// covered by every known device's clock: no peer can still hold the
    /// object they delete. Conservative on purpose; tombstones are tiny.
    fn collect_tombstones(&mut self, now_s: u64) {
        let Some(floor) = self.peers.values().map(|p| p.clock).min() else { return };
        self.tombstones.retain(|_, t| {
            now_s.saturating_sub(t.unix_s) < clock::TOMBSTONE_MIN_AGE_S || t.clock.lamport > floor
        });
    }
}

// ---------------------------------------------------------------------------
// Sidecar container
// ---------------------------------------------------------------------------
//
//   magic  "IWDC"
//   u8     version (container; still 1, see below)
//   u32LE  json length
//   ..     JSON document skeleton (structure, no sample data)
//   ..     binary stroke payload (codec.rs), strokes in sheet/layer order
//   ..     schema 2: stroke clock column (see `encode_stroke_clocks`)
//
// Schema 2 (Plan 091) adds sync metadata without bumping the container
// version: the skeleton gains fields (`schema`, `clock`, `peers`, `clocks`,
// `tombstones`, per-sheet `page_id`/`order_key`) that older readers ignore,
// and the clock column sits after the codec payload, which older readers
// never look past. So a file saved by this version still opens in an older
// build with every stroke intact; that build just drops the clocks when it
// saves, and the next save here stamps the objects afresh.

pub const SIDECAR_MAGIC: &[u8; 4] = b"IWDC";
pub const SIDECAR_VERSION: u8 = 1;
/// Skeleton schema. 1 = no sync metadata (pre-091), 2 = clocks + tombstones.
pub const SIDECAR_SCHEMA: u32 = 2;
const CLOCK_COLUMN_MAGIC: &[u8; 4] = b"IWCK";

#[derive(Debug)]
pub enum SidecarError {
    BadMagic,
    UnsupportedVersion(u8),
    Truncated,
    Json(String),
    Codec(codec::CodecError),
    StrokeCountMismatch { expected: usize, found: usize },
}

impl std::fmt::Display for SidecarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SidecarError::BadMagic => write!(f, "not an Inkwell sidecar"),
            SidecarError::UnsupportedVersion(v) => write!(f, "sidecar version {v} is newer than this build; open read-only"),
            SidecarError::Truncated => write!(f, "sidecar truncated"),
            SidecarError::Json(e) => write!(f, "sidecar json: {e}"),
            SidecarError::Codec(e) => write!(f, "sidecar payload: {e}"),
            SidecarError::StrokeCountMismatch { expected, found } => {
                write!(f, "skeleton expects {expected} strokes, payload has {found}")
            }
        }
    }
}

impl std::error::Error for SidecarError {}

/// Stroke clocks as a column parallel to the codec payload (JSON would cost
/// ~60 bytes a stroke): a device table index and Lamport value for `created`,
/// then `modified` as a delta from it. Device index 0 is `ZERO_DEVICE`;
/// `devices` lists the rest and goes in the skeleton.
fn encode_stroke_clocks(doc: &Document, strokes: &[&Stroke], devices: &mut Vec<DeviceId>) -> Vec<u8> {
    let mut idx = |d: DeviceId| -> u64 {
        if d == clock::ZERO_DEVICE {
            return 0;
        }
        match devices.iter().position(|&x| x == d) {
            Some(p) => p as u64 + 1,
            None => {
                devices.push(d);
                devices.len() as u64
            }
        }
    };
    let mut out = Vec::with_capacity(4 + strokes.len() * 4);
    out.extend_from_slice(CLOCK_COLUMN_MAGIC);
    for s in strokes {
        let c = doc.clock_of(&ObjectId::Stroke(s.id));
        codec::put_uvarint(&mut out, idx(c.created.device));
        codec::put_uvarint(&mut out, c.created.lamport);
        codec::put_uvarint(&mut out, idx(c.modified.device));
        codec::put_varint(&mut out, c.modified.lamport as i64 - c.created.lamport as i64);
    }
    out
}

fn decode_stroke_clocks(
    buf: &[u8],
    strokes: &[Stroke],
    devices: &[DeviceId],
    into: &mut BTreeMap<ObjectId, ObjClock>,
) -> std::result::Result<(), SidecarError> {
    if buf.is_empty() {
        return Ok(()); // schema 1: no column, every stroke has zero clocks
    }
    if buf.len() < 4 || &buf[..4] != CLOCK_COLUMN_MAGIC {
        return Err(SidecarError::Truncated);
    }
    let dev = |i: u64| -> std::result::Result<DeviceId, SidecarError> {
        match i {
            0 => Ok(clock::ZERO_DEVICE),
            i => devices.get(i as usize - 1).copied().ok_or(SidecarError::Truncated),
        }
    };
    let mut pos = 4usize;
    for s in strokes {
        let cd = dev(codec::get_uvarint(buf, &mut pos).map_err(SidecarError::Codec)?)?;
        let cl = codec::get_uvarint(buf, &mut pos).map_err(SidecarError::Codec)?;
        let md = dev(codec::get_uvarint(buf, &mut pos).map_err(SidecarError::Codec)?)?;
        let ml = cl as i64 + codec::get_varint(buf, &mut pos).map_err(SidecarError::Codec)?;
        let oc = ObjClock {
            created: Clock { lamport: cl, device: cd },
            modified: Clock { lamport: ml.max(0) as u64, device: md },
        };
        if oc != ObjClock::default() {
            into.insert(ObjectId::Stroke(s.id), oc);
        }
    }
    Ok(())
}

pub fn encode_sidecar(doc: &Document) -> Vec<u8> {
    let strokes: Vec<&Stroke> = doc.sheets.iter().flat_map(|s| s.strokes()).collect();
    // Layer::strokes is #[serde(skip)], so the JSON carries structure only and
    // all bulk sample data goes through the compact codec.
    let mut counts = Vec::new();
    for sh in &doc.sheets {
        counts.push(sh.layers.iter().map(|l| l.strokes.len()).collect::<Vec<_>>());
    }
    let mut devices = Vec::new();
    let column = encode_stroke_clocks(doc, &strokes, &mut devices);
    let object_clocks: BTreeMap<&ObjectId, &ObjClock> =
        doc.clocks.iter().filter(|(id, _)| !matches!(id, ObjectId::Stroke(_))).collect();
    let skeleton = serde_json::json!({
        "schema": SIDECAR_SCHEMA,
        "generation": doc.generation,
        "device": doc.device,
        "sheets": doc.sheets,
        "viewports": doc.viewports,
        "bookmarks": doc.bookmarks,
        "layer_stroke_counts": counts,
        "clock": doc.clock,
        "peers": doc.peers,
        "clocks": object_clocks,
        "tombstones": doc.tombstones,
        "stroke_clock_devices": devices,
    });
    // only when present, so documents without form values encode as before
    let mut skeleton = skeleton;
    if !doc.form_values.is_empty() {
        skeleton["form_values"] = serde_json::json!(doc.form_values);
    }
    let json = serde_json::to_vec(&skeleton).expect("skeleton is serialisable");
    let payload = codec::encode(&strokes.into_iter().cloned().collect::<Vec<_>>());

    let mut out = Vec::with_capacity(9 + json.len() + payload.len() + column.len());
    out.extend_from_slice(SIDECAR_MAGIC);
    out.push(SIDECAR_VERSION);
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&json);
    out.extend_from_slice(&payload);
    out.extend_from_slice(&column);
    out
}

fn json_field<T: serde::de::DeserializeOwned + Default>(
    sk: &serde_json::Value,
    key: &str,
) -> std::result::Result<T, SidecarError> {
    match sk.get(key) {
        None | Some(serde_json::Value::Null) => Ok(T::default()),
        Some(v) => serde_json::from_value(v.clone()).map_err(|e| SidecarError::Json(format!("{key}: {e}"))),
    }
}

/// Decodes schema 1 and 2. The result is sealed (`Document::seal`): what was
/// read counts as already stamped.
pub fn decode_sidecar(buf: &[u8]) -> std::result::Result<Document, SidecarError> {
    if buf.len() < 9 || &buf[0..4] != SIDECAR_MAGIC {
        return Err(SidecarError::BadMagic);
    }
    if buf[4] != SIDECAR_VERSION {
        return Err(SidecarError::UnsupportedVersion(buf[4]));
    }
    let jlen = u32::from_le_bytes([buf[5], buf[6], buf[7], buf[8]]) as usize;
    let jend = 9 + jlen;
    if buf.len() < jend {
        return Err(SidecarError::Truncated);
    }
    let sk: serde_json::Value =
        serde_json::from_slice(&buf[9..jend]).map_err(|e| SidecarError::Json(e.to_string()))?;
    let (strokes, used) = codec::decode_prefix(&buf[jend..]).map_err(SidecarError::Codec)?;

    let mut clocks: BTreeMap<ObjectId, ObjClock> = json_field(&sk, "clocks")?;
    clocks.retain(|_, c| *c != ObjClock::default());
    let devices: Vec<DeviceId> = json_field(&sk, "stroke_clock_devices")?;
    decode_stroke_clocks(&buf[jend + used..], &strokes, &devices, &mut clocks)?;

    let mut doc = Document {
        generation: sk["generation"].as_u64().unwrap_or(0),
        device: serde_json::from_value(sk["device"].clone()).unwrap_or_default(),
        sheets: serde_json::from_value(sk["sheets"].clone())
            .map_err(|e| SidecarError::Json(e.to_string()))?,
        viewports: serde_json::from_value(sk["viewports"].clone())
            .unwrap_or_else(|_| vec![Viewport::default()]),
        bookmarks: serde_json::from_value(sk["bookmarks"].clone()).unwrap_or_default(),
        clock: sk["clock"].as_u64().unwrap_or(0),
        peers: json_field(&sk, "peers")?,
        clocks,
        tombstones: json_field(&sk, "tombstones")?,
        form_values: json_field(&sk, "form_values")?,
        known: Known::default(),
    };

    let counts: Vec<Vec<usize>> =
        serde_json::from_value(sk["layer_stroke_counts"].clone()).unwrap_or_default();
    let total: usize = counts.iter().flatten().sum();
    if total != strokes.len() {
        return Err(SidecarError::StrokeCountMismatch { expected: total, found: strokes.len() });
    }

    // redistribute the flat payload back into sheets/layers
    let mut it = strokes.into_iter();
    for (si, sheet) in doc.sheets.iter_mut().enumerate() {
        for (li, layer) in sheet.layers.iter_mut().enumerate() {
            let n = counts.get(si).and_then(|c| c.get(li)).copied().unwrap_or(0);
            layer.strokes = it.by_ref().take(n).collect();
        }
    }
    doc.observe_all();
    doc.seal();
    Ok(doc)
}
