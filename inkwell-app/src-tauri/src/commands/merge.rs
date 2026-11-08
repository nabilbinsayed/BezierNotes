//! Cloud conflict copies and merging them into the open notebook (Plan 092).
//!
//! Sync clients fork a file edited on two machines between syncs. These
//! commands find such forks of the open file, preview what merging one in
//! would do, apply the merge to the session, and afterwards move the copy to
//! the OS trash. The merge itself is `inkwell_core::merge` (a pure CRDT
//! join); the session is always `Ours`, the other copy `Theirs`.

use super::*;
use inkwell_core::clock::ObjectId;
use inkwell_core::merge::{self, MergeReport, Side};

/// Which sync client a sibling name looks like it came from, if any. Only
/// copies of `target` itself count: same stem and extension, exactly one of
/// the patterns sync clients use, compared case-insensitively.
pub(crate) fn conflict_source(target: &str, candidate: &str) -> Option<&'static str> {
    let (stem, ext) = target.rsplit_once('.').map_or((target, ""), |(s, e)| (s, e));
    let lower = candidate.to_lowercase();
    let suffix = format!(".{}", ext.to_lowercase());
    let body = lower.strip_suffix(&suffix)?;
    let rest_lower = body.strip_prefix(&stem.to_lowercase())?;
    // the same slice of the original name, for case-sensitive checks (only
    // when lower-casing kept every byte offset, i.e. not for every script)
    let rest = if lower.len() == candidate.len() {
        candidate.get(candidate.len() - suffix.len() - rest_lower.len()..candidate.len() - suffix.len()).unwrap_or("")
    } else {
        ""
    };
    if rest_lower.is_empty() {
        return None;
    }

    // "notes (1).pdf": Google Drive, Dropbox
    if let Some(n) = rest_lower.strip_prefix(" (").and_then(|r| r.strip_suffix(')')) {
        if !n.is_empty() && n.len() <= 3 && n.bytes().all(|b| b.is_ascii_digit()) {
            return Some("Google Drive or Dropbox copy");
        }
        // "notes (conflicted copy 2026-11-06).pdf", "notes (Nabil's conflicted
        // copy 2026-11-06).pdf": Dropbox, Nextcloud
        if n.contains("conflicted copy") {
            return Some("Dropbox or Nextcloud conflict");
        }
        return None;
    }
    // "notes.sync-conflict-20261106-101500-ABCDEFG.pdf": Syncthing
    if let Some(r) = rest_lower.strip_prefix(".sync-conflict-") {
        let parts: Vec<&str> = r.split('-').collect();
        if parts.len() == 3
            && parts[0].len() == 8
            && parts[1].len() == 6
            && parts[0].bytes().chain(parts[1].bytes()).all(|b| b.is_ascii_digit())
            && parts[2].len() == 7
            && parts[2].bytes().all(|b| b.is_ascii_alphanumeric())
        {
            return Some("Syncthing conflict");
        }
        return None;
    }
    // "notes-DESKTOP-ABC123.pdf": OneDrive appends the (upper-case) computer
    // name. Lower case would match too many ordinary names ("notes-v2").
    if let Some(host) = rest.strip_prefix('-') {
        if (2..=15).contains(&host.len())
            && host.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-')
            && host.bytes().any(|b| b.is_ascii_uppercase())
            && !host.starts_with('-')
        {
            return Some("OneDrive conflict");
        }
    }
    None
}

#[derive(Debug, Clone, Serialize)]
pub struct ConflictSibling {
    pub path: String,
    pub name: String,
    pub source: String,
    /// Milliseconds since the Unix epoch.
    pub modified_ms: u64,
}

fn current_path(state: &AppState) -> Result<PathBuf, String> {
    state.pdf_path.lock().map_err(|e| format!("Lock error: {e}"))?.clone().ok_or_else(|| "No document open".to_string())
}

fn session_base(state: &AppState) -> Result<[u8; 32], String> {
    let bytes = state.original_pdf_bytes.lock().map_err(|e| format!("Lock error: {e}"))?.clone().ok_or("No original PDF loaded")?;
    Ok(inkwell_core::pdf::base_fingerprint(&bytes))
}

/// Conflict copies of `target` in its folder that annotate the same base PDF,
/// newest first.
pub(crate) fn siblings_of(target: &Path, base: &[u8; 32]) -> Vec<ConflictSibling> {
    let (Some(dir), Some(name)) = (target.parent(), target.file_name().and_then(|n| n.to_str())) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Some(cand) = entry.file_name().to_str().map(str::to_string) else { continue };
        let Some(source) = conflict_source(name, &cand) else { continue };
        let path = entry.path();
        // Same name pattern is not enough: it must be a copy of this PDF.
        match std::fs::read(&path) {
            Ok(bytes) if &inkwell_core::pdf::base_fingerprint(&bytes) == base => {}
            Ok(_) => continue,
            Err(e) => {
                eprintln!("[inkwell] Could not read possible conflict copy {path:?}: {e}");
                continue;
            }
        }
        let modified_ms = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        out.push(ConflictSibling { path: path.to_string_lossy().into_owned(), name: cand, source: source.into(), modified_ms });
    }
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.name.cmp(&b.name)));
    out
}

#[tauri::command]
pub async fn find_conflict_siblings(state: State<'_, AppState>) -> Result<Vec<ConflictSibling>, String> {
    let Ok(target) = current_path(&state) else { return Ok(Vec::new()) };
    let base = session_base(&state)?;
    Ok(siblings_of(&target, &base))
}

#[derive(Debug, Clone, Serialize)]
pub struct ConflictDto {
    pub id: String,
    pub kind: String,
    pub ours: String,
    pub theirs: String,
    /// "ours" or "theirs": what the merge keeps unless the user switches.
    pub winner: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct MergePreview {
    pub other_name: String,
    pub added_strokes: usize,
    pub added_other: usize,
    pub removed: usize,
    pub changed: usize,
    pub conflicts: Vec<ConflictDto>,
    pub pages_kept_by_ink: usize,
    /// Merged page indices that gain or change objects.
    pub pages_affected: Vec<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MergeApplied {
    pub preview: MergePreview,
    pub strokes: Vec<FrontendStroke>,
    pub images: Vec<FrontendImage>,
    pub texts: Vec<FrontendText>,
    pub bookmarks: Vec<inkwell_core::doc::Bookmark>,
    pub shapes: Vec<inkwell_core::shape::ShapeObject>,
    /// Hex ids of strokes that came from the other copy (tinted briefly).
    pub incoming_stroke_ids: Vec<String>,
}

fn kind_of(id: &ObjectId) -> &'static str {
    match id {
        ObjectId::Stroke(_) => "ink",
        ObjectId::Image(_) => "image",
        ObjectId::Text(_) => "note",
        ObjectId::Bookmark(_) => "bookmark",
        ObjectId::Page(_) => "page",
        ObjectId::Shape(_) => "shape",
        ObjectId::Field(_) => "form field",
    }
}

fn plain_id(id: &ObjectId) -> String {
    match id {
        ObjectId::Stroke(s) | ObjectId::Page(s) => format!("{s:032x}"),
        ObjectId::Image(s) | ObjectId::Text(s) | ObjectId::Bookmark(s) | ObjectId::Shape(s) | ObjectId::Field(s) => s.clone(),
    }
}

fn page_of(doc: &Document, id: &ObjectId) -> Option<usize> {
    doc.sheets.iter().position(|sh| match id {
        ObjectId::Stroke(s) => sh.strokes().any(|x| x.id == *s),
        ObjectId::Image(i) => sh.images.iter().any(|x| &x.id == i),
        ObjectId::Text(t) => sh.text_objects.iter().any(|x| &x.id == t),
        ObjectId::Page(p) => sh.page_id == *p,
        ObjectId::Shape(s) => sh.shapes.iter().any(|x| &x.id == s),
        ObjectId::Bookmark(_) | ObjectId::Field(_) => false,
    })
}

fn preview_of(name: String, report: &MergeReport, merged: &Document) -> MergePreview {
    let added_strokes = report.added.iter().filter(|i| matches!(i, ObjectId::Stroke(_))).count();
    let added_other = report.added.iter().filter(|i| !matches!(i, ObjectId::Stroke(_) | ObjectId::Page(_))).count();
    let mut pages: Vec<usize> =
        report.added.iter().chain(&report.changed).filter_map(|id| page_of(merged, id)).collect();
    pages.sort_unstable();
    pages.dedup();
    MergePreview {
        other_name: name,
        added_strokes,
        added_other,
        removed: report.removed.iter().filter(|i| !matches!(i, ObjectId::Page(_))).count(),
        changed: report.changed.iter().filter(|i| !matches!(i, ObjectId::Page(_))).count(),
        conflicts: report
            .conflicts
            .iter()
            .map(|c| ConflictDto {
                id: plain_id(&c.id),
                kind: kind_of(&c.id).into(),
                ours: c.ours.clone(),
                theirs: c.theirs.clone(),
                winner: if c.winner == Side::Theirs { "theirs" } else { "ours" }.into(),
            })
            .collect(),
        pages_kept_by_ink: report.pages_kept_by_ink.len(),
        pages_affected: pages,
    }
}

/// The other copy, checked against the session: a copy of the same base
/// PDF (STOP condition: never merge different documents), read the way
/// `open_pdf` reads a file.
fn read_other(state: &AppState, other: &Path) -> Result<Document, String> {
    let bytes = std::fs::read(other).map_err(|e| format!("Could not read {other:?}: {e}"))?;
    if inkwell_core::pdf::base_fingerprint(&bytes) != session_base(state)? {
        return Err(format!(
            "{} is a different document: its underlying PDF differs from this one, so the two can't be merged. Open it separately instead.",
            other.file_name().and_then(|n| n.to_str()).unwrap_or("That file")
        ));
    }
    let pages = PdfFile::open(inkwell_core::pdf::writable_base(&bytes).to_vec())
        .map(|f| f.page_count())
        .map_err(|e| format!("Could not read {other:?}: {e}"))?;
    let mut doc = merge::document_for_merge(&bytes, pages).map_err(|e| e.to_string())?;
    let me = state.device.lock().unwrap().clone();
    doc.restamp(&me, now_s());
    Ok(doc)
}

fn now_s() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default()
}

type Payload = (
    Option<Vec<FrontendImage>>,
    Option<Vec<FrontendStroke>>,
    Option<Vec<FrontendText>>,
    Option<Vec<inkwell_core::doc::Bookmark>>,
    Option<Vec<inkwell_core::shape::ShapeObject>>,
);

/// Bring the session up to date with the frontend (as a save does), stamp
/// it, and merge `other` into a copy of it.
fn merged_with(state: &AppState, other: &Path, payload: Payload) -> Result<(merge::MergeResult, Document), String> {
    let theirs = read_other(state, other)?;
    let (images, strokes, texts, bookmarks, shapes) = payload;
    apply_frontend_payload(state, images, strokes, texts, bookmarks, shapes)?;
    let me = state.device.lock().unwrap().clone();
    let ours = {
        let mut g = state.doc.lock().unwrap();
        let d = g.as_mut().ok_or("No document open")?;
        d.restamp(&me, now_s());
        d.clone()
    };
    let result = merge::merge(&ours, &theirs).map_err(|e| e.to_string())?;
    // The PDF's pages and the document's sheets must stay one-to-one; with a
    // shared base they always are, but never let a merge break that.
    if result.doc.sheets.len() != ours.sheets.len() {
        return Err("The two copies have different pages, so they can't be merged automatically. Open them separately instead.".into());
    }
    Ok((result, theirs))
}

fn display_name(p: &Path) -> String {
    p.file_name().and_then(|n| n.to_str()).unwrap_or("the other copy").to_string()
}

/// `None` = the open file's current version on disk (after an external
/// change). Otherwise it must be a conflict copy of the open file.
fn resolve_other(state: &AppState, other_path: Option<String>) -> Result<PathBuf, String> {
    let target = current_path(state)?;
    let Some(p) = other_path else { return Ok(target) };
    let p = PathBuf::from(p);
    let name = target.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let cand = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    if p.parent() != target.parent() || conflict_source(name, cand).is_none() {
        return Err(format!("{cand} is not a conflict copy of {name}"));
    }
    Ok(p)
}

#[tauri::command]
pub async fn preview_merge(
    other_path: Option<String>,
    images: Option<Vec<FrontendImage>>,
    strokes: Option<Vec<FrontendStroke>>,
    texts: Option<Vec<FrontendText>>,
    bookmarks: Option<Vec<inkwell_core::doc::Bookmark>>,
    shapes: Option<Vec<inkwell_core::shape::ShapeObject>>,
    state: State<'_, AppState>,
) -> Result<MergePreview, String> {
    let other = resolve_other(&state, other_path)?;
    let _guard = state.save_lock.lock().map_err(|e| format!("Lock error: {e}"))?;
    let (result, _) = merged_with(&state, &other, (images, strokes, texts, bookmarks, shapes))?;
    Ok(preview_of(display_name(&other), &result.report, &result.doc))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn apply_merge(
    other_path: Option<String>,
    take_ours: Option<Vec<String>>,
    take_theirs: Option<Vec<String>>,
    images: Option<Vec<FrontendImage>>,
    strokes: Option<Vec<FrontendStroke>>,
    texts: Option<Vec<FrontendText>>,
    bookmarks: Option<Vec<inkwell_core::doc::Bookmark>>,
    shapes: Option<Vec<inkwell_core::shape::ShapeObject>>,
    state: State<'_, AppState>,
) -> Result<MergeApplied, String> {
    let other = resolve_other(&state, other_path.clone())?;
    let _guard = state.save_lock.lock().map_err(|e| format!("Lock error: {e}"))?;
    let applied = apply_merge_locked(&state, &other, (images, strokes, texts, bookmarks, shapes), take_ours, take_theirs)?;
    if other_path.is_none() {
        // The merge now includes what changed on disk: the next save may
        // replace it without raising the change banner again.
        state.record_disk_stamp(&other);
    }
    Ok(applied)
}

pub(crate) fn apply_merge_locked(
    state: &AppState,
    other: &Path,
    payload: Payload,
    take_ours: Option<Vec<String>>,
    take_theirs: Option<Vec<String>>,
) -> Result<MergeApplied, String> {
    let (result, theirs) = merged_with(state, other, payload)?;
    // the session as merged: up to date with the frontend and stamped
    let ours = state.doc.lock().unwrap().clone().ok_or("No document open")?;
    let merge::MergeResult { mut doc, report } = result;
    // Conflicts the user resolved the other way. Only notes are switchable;
    // the chosen version gets a fresh clock at the next save.
    for id in take_ours.unwrap_or_default() {
        merge::take_text(&mut doc, &ours, &id);
    }
    for id in take_theirs.unwrap_or_default() {
        merge::take_text(&mut doc, &theirs, &id);
    }
    let preview = preview_of(display_name(other), &report, &doc);
    let incoming_stroke_ids = report
        .added
        .iter()
        .chain(&report.changed)
        .filter_map(|id| match id {
            ObjectId::Stroke(s) => Some(format!("{s:032x}")),
            _ => None,
        })
        .collect();
    let applied = MergeApplied {
        preview,
        strokes: extract_frontend_strokes(&doc),
        images: extract_frontend_images(&doc),
        texts: extract_frontend_texts(&doc),
        bookmarks: doc.bookmarks.clone(),
        shapes: doc.sheets.iter().flat_map(|s| s.shapes.iter().cloned()).collect(),
        incoming_stroke_ids,
    };
    *state.doc.lock().unwrap() = Some(doc);
    state.is_dirty.store(true, std::sync::atomic::Ordering::Release);
    Ok(applied)
}

/// After a merge: move the conflict copy to the OS trash (never a hard
/// delete), so it can still be restored from there.
#[tauri::command]
pub async fn trash_conflict_copy(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let p = resolve_other(&state, Some(path))?;
    trash::delete(&p).map_err(|e| format!("Could not move {} to the trash: {e}", display_name(&p)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_client_conflict_names_are_recognised() {
        let t = "Lecture Notes.pdf";
        for (cand, src) in [
            ("Lecture Notes (1).pdf", "Google Drive or Dropbox copy"),
            ("lecture notes (12).PDF", "Google Drive or Dropbox copy"),
            ("Lecture Notes (conflicted copy 2026-11-06).pdf", "Dropbox or Nextcloud conflict"),
            ("Lecture Notes (Nabil's conflicted copy 2026-11-06).pdf", "Dropbox or Nextcloud conflict"),
            ("Lecture Notes (conflicted copy 2026-11-06 101500).pdf", "Dropbox or Nextcloud conflict"),
            ("Lecture Notes-DESKTOP-ABC123.pdf", "OneDrive conflict"),
            ("Lecture Notes.sync-conflict-20261106-101500-ABCDEFG.pdf", "Syncthing conflict"),
        ] {
            assert_eq!(conflict_source(t, cand), Some(src), "{cand}");
        }
    }

    #[test]
    fn ordinary_names_are_not_conflicts() {
        let t = "notes.pdf";
        for cand in [
            "notes.pdf",
            "notes-v2.pdf",
            "notes (draft).pdf",
            "notes (1234).pdf",
            "notes (1).txt",
            "other notes (1).pdf",
            "notes (BezierNotes copy).pdf",
            "notes.orig.pdf",
            ".notes.pdf.inkwell-tmp-12-3",
            "notes.sync-conflict-2026.pdf",
            "notes-.pdf",
            "notes-A.pdf",
        ] {
            assert_eq!(conflict_source(t, cand), None, "{cand}");
        }
    }

    fn ink(seed: u128) -> Stroke {
        let id = inkwell_core::clock::derive_u128(&[b"app-merge-test", &seed.to_le_bytes()]);
        let mut b = inkwell_core::ink::StrokeBuilder::new(id, ToolKind::Pen, [0.0, 0.0, 0.0], Brush::default(), false);
        for k in 0..12 {
            b.push(80.0 + k as f64 * 7.0, 100.0 + seed as f64 * 20.0, 0.5, k as f64);
        }
        let mut s = b.finish(0.0);
        s.samples = inkwell_core::ink::simplify(&s.samples, 0.10);
        s
    }

    #[test]
    fn merging_a_conflict_copy_unions_both_devices_work() {
        use inkwell_core::clock::DeviceIdentity;
        let dir = tempfile::tempdir().unwrap();
        let lecture = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../inkwell/fixtures/lecture.pdf")).unwrap();
        let fp = inkwell_core::pdf::base_fingerprint(&lecture);
        let pages = PdfFile::open(lecture.clone()).unwrap().page_count();

        // what both devices had after the last sync
        let mut shared = Document::for_pdf(pages);
        shared.assign_base_page_ids(&fp);
        shared.push_stroke(0, ink(1));
        shared.push_stroke(0, ink(2));
        shared.restamp(&DeviceIdentity { id: 7, label: "laptop".into() }, 0);
        let shared = inkwell_core::doc::decode_sidecar(&inkwell_core::doc::encode_sidecar(&shared)).unwrap();

        // the tablet's fork: deletes stroke 1, adds stroke 3
        let mut tablet = shared.clone();
        tablet.remove_stroke(ink(1).id);
        tablet.push_stroke(0, ink(3));
        tablet.restamp(&DeviceIdentity { id: 9, label: "tablet".into() }, 0);
        let mut f = PdfFile::open(lecture.clone()).unwrap();
        f.write_document(&tablet, inkwell_core::pdf::DEFAULT_GROUP).unwrap();
        let target = dir.path().join("notes.pdf");
        let copy = dir.path().join("notes (1).pdf");
        std::fs::write(&target, &lecture).unwrap();
        std::fs::write(&copy, f.finish()).unwrap();

        // this session (the laptop) adds stroke 4 and hasn't saved
        let state = AppState::default();
        let mut session = shared.clone();
        session.push_stroke(0, ink(4));
        *state.doc.lock().unwrap() = Some(session);
        *state.original_pdf_bytes.lock().unwrap() = Some(Arc::new(lecture.clone()));
        *state.pdf_path.lock().unwrap() = Some(target.clone());

        assert_eq!(siblings_of(&target, &fp).len(), 1);
        let other = resolve_other(&state, Some(copy.to_string_lossy().into_owned())).unwrap();
        let applied = apply_merge_locked(&state, &other, (None, None, None, None, None), None, None).unwrap();
        let ids: Vec<u128> = state.doc.lock().unwrap().as_ref().unwrap().sheets[0].strokes().map(|s| s.id).collect();
        assert!(!ids.contains(&ink(1).id), "the tablet's delete holds");
        for keep in [2, 3, 4] {
            assert!(ids.contains(&ink(keep).id), "stroke {keep} survives");
        }
        assert_eq!(applied.preview.added_strokes, 1);
        assert_eq!(applied.preview.removed, 1);
        assert_eq!(applied.incoming_stroke_ids, vec![format!("{:032x}", ink(3).id)]);
        assert_eq!(applied.strokes.len(), 3);
        assert!(state.is_dirty.load(std::sync::atomic::Ordering::Acquire));

        // never a file outside the conflict patterns
        assert!(resolve_other(&state, Some(dir.path().join("other.pdf").to_string_lossy().into_owned())).is_err());
    }

    #[test]
    fn siblings_must_share_the_base_pdf() {
        let dir = tempfile::tempdir().unwrap();
        let lecture = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../inkwell/fixtures/lecture.pdf")).unwrap();
        let other = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../inkwell/fixtures/corpus/sample_multi_page.pdf")).unwrap();
        let target = dir.path().join("notes.pdf");
        std::fs::write(&target, &lecture).unwrap();
        std::fs::write(dir.path().join("notes (1).pdf"), &lecture).unwrap();
        std::fs::write(dir.path().join("notes (2).pdf"), &other).unwrap();
        std::fs::write(dir.path().join("notes-v2.pdf"), &lecture).unwrap();
        let found = siblings_of(&target, &inkwell_core::pdf::base_fingerprint(&lecture));
        let names: Vec<&str> = found.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["notes (1).pdf"]);
    }
}
