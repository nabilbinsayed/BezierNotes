# Plan 092: Cloud Conflict-Copy Detection & Union Merge

| Field | Value |
|---|---|
| **Priority** | P1 (the headline feature of v1.0) |
| **Effort** | L (~800 lines: merge engine, IPC, UI, CLI) |
| **Category** | Feature / Multi-Device Sync |
| **Depends on** | 090, 091 |
| **Status** | TODO |

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
