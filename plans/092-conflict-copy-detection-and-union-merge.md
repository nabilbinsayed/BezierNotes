# Plan 092: Cloud Conflict-Copy Detection & Union Merge

| Field | Value |
|---|---|
| **Priority** | P1 (the headline feature of v1.0) |
| **Effort** | L (~800 lines: merge engine, IPC, UI, CLI) |
| **Category** | Feature / Multi-Device Sync |
| **Depends on** | 090, 091 |
| **Status** | DONE (2026-11-08; see Outcome) |

## Why

When the same PDF is edited on two machines between syncs, every sync client forks it:
- **Google Drive** and **Dropbox**: `notes (1).pdf` / `notes (conflicted copy 2026-11-06).pdf`,
- **OneDrive**: `notes-DESKTOP-ABC.pdf`,
- **Syncthing**: `notes.sync-conflict-20261106-101500-ABCDEFG.pdf`,
- **Nextcloud**: `notes (conflicted copy …).pdf`.

Users then hand-copy ink between files, or lose some. No FOSS notes app merges these properly (`SPEC.md` §5). With Plan 091's clocks and tombstones, BezierNotes can merge them losslessly in one click.

## Design

### Merge engine (`inkwell-core/src/merge.rs`)
`merge(base: Option<&Document>, a: &Document, b: &Document) -> MergeResult { doc, report }`
- Objects: union by ID. An object is dropped if a tombstone for it exists on either side with a clock ≥ the object's `created` clock.
- Mutable objects (text, image placement, bookmarks): last-writer-wins on `modified` clock. Record both versions in the report when both sides changed the same object (`report.conflicts`).
- Pages: union by `page_id`, order by `order_key`. A page tombstoned on one side but with new ink on the other is **kept** (ink beats deletion; report it).
- `clock = max(a.clock, b.clock)`; `peers` = pointwise max.
- Pure function, no I/O, property-tested: commutative, associative, idempotent (`merge(a, a) == a`).

### Base PDF reconciliation
Merging requires both files to share the same base PDF. Check `/Inkw_BaseHash` (Plan 088):
- equal: merge sidecars, write one generation on top of the shared base;
- different: refuse with a clear message ("these are different documents"), offering to open side by side in split view instead.

### Detection
- On open, and when the external-change check (Plan 086) fires, scan the file's directory for conflict-sibling patterns of *this* file name (the patterns above, case-insensitive, strict regexes, same extension).
- Banner: "Another version of this notebook was found (from **Drive conflict, 2 hours ago**). [Merge] [Open side by side] [Ignore]".
- External change on the same path (Plan 090 banner): the primary action becomes **Merge**. Merge the on-disk version with the in-memory session (treat the session as `a`, disk as `b`, no common base). No more choosing between Reload and Keep mine.

### Merge preview UI
- A drawer listing: +N strokes from the other copy, −M deleted, K text notes changed on both sides (with both texts shown, the LWW winner preselected and switchable).
- Thumbnails of affected pages with the incoming ink tinted for 2 s after merge.
- Merge is a single undoable transaction (reuse the Plan 084 transaction shape).
- After a successful merge + save: offer to move the conflict copy to the OS trash (never hard-delete; Prohibited-actions parity with our own safety rules).

### CLI
`beziernotes merge <a.pdf> <b.pdf> -o <out.pdf>` (a small bin target in `inkwell-app/src-tauri` or a separate `inkwell-cli` crate). Useful for scripting and makes the engine testable end-to-end without the UI.

## Scope
- New: `inkwell/crates/inkwell-core/src/merge.rs`, `tests/merge_prop.rs`.
- `inkwell-app/src-tauri/src/commands.rs`: `find_conflict_siblings`, `preview_merge`, `apply_merge`.
- `inkwell-app/src/js/ui/merge-drawer.js` (new), `main.js` banner wiring, `styles.css`.

## Verification
- Property tests: commutativity, associativity, idempotence, "no object loss unless tombstoned".
- Integration: simulate two devices (two `Document`s from the same base, different device IDs, interleaved edits incl. delete-vs-edit and page insert on both), save both to real PDFs, merge via CLI, then `qpdf --check` and reopen, comparing against the expected union.
- Smoke: banner appears for a `name (1).pdf` sibling; merge preview counts are correct; undo restores the pre-merge state.

## STOP Conditions
- STOP if a merge ever drops an object that is not tombstoned. Data loss in the merge feature would destroy trust in the product.
- STOP if base hashes differ but merge proceeds anyway.

## Outcome (2026-11-08)

**Merge engine** (`inkwell-core/src/merge.rs`): `merge(ours, theirs) -> MergeResult { doc, report }`.
- Per object, it keeps the newest version (by `modified` clock) and the newest tombstone. The object is alive unless the tombstone is newer than its version. This state is a join-semilattice, so the merge is commutative, associative and idempotent without a common base. The `base` parameter from the plan is therefore unnecessary and was dropped.
- **Delete vs. edit.** A delete wins over an edit only when the delete is newer, rather than the plan's "tombstone ≥ created". Under the plan's rule, an edit made after a delete on another device would be lost.
- **Pages.** A page survives its own deletion while any live object is on it ("ink beats deletion"). Pages are sorted by `(order_key, page_id)`. Z-order is creation clock, then position.
- **Conflicts.** An object is a conflict only if each copy holds a version the other copy's `peers` clock shows it hasn't seen. Two sequential edits never count. `take_text` applies a user's choice; the next save stamps it with a clock newer than both versions.
- **Refusals.** Unstamped copies, and copies holding two objects with one id, are refused rather than collapsed. This came up when a test generator produced colliding ids: collapsing would have dropped an object, which is the plan's STOP condition.
- **Whole files.** `merge_files` checks `base_fingerprint`, the SHA-256 of `writable_base`, and refuses different PDFs (`DifferentBase`). It writes one generation on the shared base.

**Fixes to Plan 091 found by the property tests.**
- **Bookmark hashing.** Bookmarks were hashed by page *index*. A page delete then moved a bookmark onto the next page without stamping it, leaving two copies with different versions under one clock. Bookmarks are now hashed by page id, like every other object.
- **Page order keys.** Restamp required strictly increasing order keys. Concurrent inserts at the same spot can merge into equal keys, and restamp then re-keyed (re-stamped) a merged document that hadn't changed. Page order is now `(key, page_id)` everywhere. A page inserted between two equal keys re-keys its neighbour, so `key_between` always gets `lo < hi`.

**CLI.** `beziernotes merge <a.pdf> <b.pdf> -o <out.pdf>` (`inkwell-core/src/bin/beziernotes.rs`). It prints the report and exits 1 for different documents. Tried on fixtures, the output passes `qpdf --check`.

**App** (`src-tauri/src/commands/merge.rs`):
- `find_conflict_siblings` recognises names from Google Drive/Dropbox (`name (1)`), Dropbox/Nextcloud (`(… conflicted copy …)`), OneDrive (`name-HOSTNAME`, upper case only, so `notes-v2` doesn't match) and Syncthing (`.sync-conflict-YYYYMMDD-HHMMSS-XXXXXXX`). Each match must also share the open file's base PDF.
- `preview_merge` and `apply_merge` first bring the session up to date with the frontend payload, as a save does, and stamp it. Both run under `save_lock`. They refuse a merge that would change the page count, which keeps sheets one-to-one with the PDF.
- `None` as the other path means "the open file as it is on disk now", which is how the change-on-disk banner merges.
- `trash_conflict_copy` moves only a verified sibling to the OS trash, using the new `trash` 5 dependency. Nothing is hard-deleted.

**Frontend** (`js/ui/merge.js`):
- After opening a file, a banner names the conflict copy's source and age, with **Merge** and **Not now**.
- The preview modal lists added, deleted and updated items and the pages affected. Notes edited on both sides show both texts as 44 px radio choices, with the newer one preselected.
- **Merge and save** applies the merge as one `replace_annotations` undo step (new in `core/document.js`), highlights incoming ink for 2 s (`overlays.drawMergeHighlights`), saves, and then offers **Move copy to Trash**.
- The change-on-disk banner now leads with **Merge**.

**Verification.**
- **Core.** `tests/merge_prop.rs` (13 tests): three simulated devices make random edits (add, delete or move ink; edit, add or delete notes; delete or insert pages; save). Proptests check commutativity, associativity, idempotence (including re-merging an input), save/reopen with no new stamps, and "nothing vanishes without a newer tombstone". They passed 128 cases each in CI and 3,000 in a stress run. Concrete tests cover:
  - ink beating a page delete;
  - a page delete without new ink sticking;
  - concurrent note edits (reported, with the choice re-stamped);
  - causal edits not being conflicts;
  - edit-after-delete and delete-after-edit;
  - refusal of unstamped copies;
  - a two-device, real-PDF merge that keeps the original bytes as a prefix and passes `qpdf --check`;
  - refusal of different PDFs.
- **App.** Conflict name patterns (positive and negative), the base-PDF filter, and an end-to-end `apply_merge` of a real conflict copy.
- **Smoke.** T31 adds 9 checks: banner, preview counts, conflict choice, apply, highlight, save, trash, undo/redo, banner Merge, and refusal.
- **Totals.**
  - Rust 153/153; app crate 24/24; smoke 173/173.
  - Clippy clean on both workspaces; strict conformance + render diff pass; boundaries clean.
  - All five focused suites pass; torture 60/60.

**Not done / limits.**
- **No "Open side by side".** The app has no view for two different files at once; split view shows two panes of one document. The banner offers Merge / Not now, and the "different document" error says to open the file separately.
- **Page structure edits block merging.** Inserting, deleting, rotating or reordering pages rewrites the session's PDF bytes, so its base differs from the copy's. That merge is refused (STOP condition), not attempted. Merging page structure needs page-level ops on the base PDF (a later plan).
- **Unsaved merge.** A merge is not journalled. It is saved immediately, but if that save fails and the app then crashes, the merge is lost. The conflict copy is still there and is offered again.
- **Conflict choices.** Only note conflicts are switchable in the UI; ink, image and bookmark conflicts keep the newer version (the preview says so).
- **Inactive tabs.** Conflict copies are looked for only for the document that was just opened.
- **No real-app check.** Real sync-client folders, the OS trash and the native flow were not exercised in the desktop app.
