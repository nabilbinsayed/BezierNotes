# Plan 074: WAL Crash Recovery Integrity, Structural Page Durability, Bookmark Persistence & Undoable Page Ops

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c036ee8..HEAD -- inkwell/crates/inkwell-core/src/doc.rs inkwell/crates/inkwell-core/src/pdf.rs inkwell-app/src-tauri/src/state.rs inkwell-app/src-tauri/src/main.rs inkwell-app/src-tauri/src/commands.rs inkwell-app/src/js/core/document.js inkwell-app/src/js/core/ipc.js inkwell-app/src/js/main.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: M–L
- **Risk**: MED
- **Depends on**: 069
- **Category**: bug | correctness | durability
- **Planned at**: commit `c036ee8`, 2026-10-30

## Why this matters

Ten backend and state-durability bugs currently threaten user data across saves, crashes, and page mutations:
1. **Untruncated WAL resurrects discarded edits (`[BUG-BACKEND-05]`)**: When a user closes InkWell and explicitly chooses to discard unsaved changes (`main.rs:101-108`), or performs a "Save As" to a new file path (`commands.rs:1188-1202`), the old WAL journal is closed via `WalOp::Close` without truncating it. On next launch, `open_pdf` replays all discarded changes back onto the document.
2. **Async WAL truncation race on Save & Quit (`[BUG-BACKEND-06]`)**: `save_pdf` (`commands.rs:1206`) sends `WalOp::Truncate` over an asynchronous channel without waiting for completion; if the app exits immediately after save, the WAL is not truncated before `process::exit(0)`, duplicating strokes on next open.
3. **Bookmarks are 100% lost on save/close (`[BUG-BACKEND-07]` / `[BUG-UI-05]`)**: `state.bookmarks` exists only in frontend memory (`drawers.js:236`); `Document` in `doc.rs`, `save_pdf` in `commands.rs`, and `ipc.savePdf` omit bookmarks completely.
4. **Cross-sheet drag/move duplicates images and text (`[BUG-BACKEND-11]`)**: `Document::push_image` (`doc.rs:261`) and `Document::upsert_text` (`doc.rs:279`) only check for existing IDs on the target sheet, leaving a stale copy on the origin sheet when an image or text note is moved across pages.
5. **WAL replay desynchronizes `page_infos` and `pdf_bytes` on page mutations (`[BUG-BACKEND-04]`)**: `open_pdf` extracts `page_infos` *before* calling `replay_wal_journal`, and `replay_wal_journal` ignores `WalEntry::PageRotated` and never updates `page_infos` or `pdf_bytes` when replaying `PageInserted`, `PageDeleted`, or `PageReordered`. Also, `duplicate_page` (`commands.rs:1648`) never journals the cloned strokes/images/texts to WAL.
6. **Mutating `state.doc` before fallible PDFium calls (`[BUG-BACKEND-10]`)**: `insert_blank_page`, `delete_page`, `duplicate_page`, and `reorder_page` mutate `state.doc` *before* running PDFium operations, leaving backend and frontend out of sync if PDFium returns an error.
7. **Pre-existing `/EmbeddedFiles` wiped on save (`[BUG-BACKEND-12]`)**: `rewrite_catalog` (`pdf.rs:700`) strips `/EmbeddedFiles` and overwrites it with only `[(inkwell.doc) {fs} 0 R]`, deleting any third-party file attachments in the PDF.
8. **Hardcoded `startxref 215` in fallback blank PDF (`[BUG-BACKEND-13]`)**: `create_blank_document` (`commands.rs:511`) hardcodes byte offset `215` even when `w` or `h` digit counts vary.
9. **Page operations cannot be undone (`[BUG-BACKEND-09]`)**: `insertPageAtIndex`, `deletePageAtIndex`, `duplicatePageAtIndex`, and `reorderPageAtIndex` in `document.js` do not push history transactions.

## Current state

- `inkwell-app/src-tauri/src/state.rs:8-12`:
  ```rust
  pub enum WalOp {
      Append(WalEntry),
      Truncate,
      Close,
  }
  ```
- `inkwell/crates/inkwell-core/src/doc.rs:261-286`:
  ```rust
      pub fn push_image(&mut self, sheet: usize, image: ImageObject) {
          self.ensure_sheet(sheet);
          let sh = &mut self.sheets[sheet];
          if let Some(pos) = sh.images.iter().position(|img| img.id == image.id) {
              sh.images[pos] = image;
          } else {
              sh.images.push(image);
          }
      }
  ...
      pub fn upsert_text(&mut self, sheet: usize, text_obj: TextObject) {
          self.ensure_sheet(sheet);
          let sh = &mut self.sheets[sheet];
          if let Some(pos) = sh.text_objects.iter().position(|t| t.id == text_obj.id) {
              sh.text_objects[pos] = text_obj;
          } else {
              sh.text_objects.push(text_obj);
          }
      }
  ```
- `inkwell-app/src-tauri/src/commands.rs:501-515`:
  ```rust
      let minimal = format!(
          "%PDF-1.4\n\
           1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n\
           2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n\
           3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.2} {:.2}] /Contents 4 0 R >>\nendobj\n\
           4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n\
           xref\n0 5\n\
           0000000000 65535 f \n\
           0000000009 00000 n \n\
           0000000058 00000 n \n\
           0000000115 00000 n \n\
           0000000204 00000 n \n\
           trailer\n<< /Size 5 /Root 1 0 R >>\n\
           startxref\n215\n%%EOF\n",
          w, h
      );
  ```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust Workspace Tests | `cd inkwell && cargo test --workspace -- --test-threads=1` | exit 0, all tests pass |
| Rust Clippy | `cd inkwell && cargo clippy --all-targets` | exit 0, 0 warnings |
| App Smoke Tests | `cd inkwell-app && python3 test_app_smoke.py` | exit 0, all checks pass |

## Scope

**In scope**:
- `inkwell/crates/inkwell-core/src/doc.rs`
- `inkwell/crates/inkwell-core/src/pdf.rs`
- `inkwell/crates/inkwell-core/tests/integration.rs`
- `inkwell-app/src-tauri/src/state.rs`
- `inkwell-app/src-tauri/src/main.rs`
- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell-app/src/js/core/document.js`
- `inkwell-app/src/js/core/ipc.js`
- `inkwell-app/src/js/main.js`
- `inkwell-app/test_app_smoke.py`

**Out of scope**:
- Tool additions (Plan 075) and shortcut UI (Plan 076).

## Steps

### Step 1: Fix cross-sheet object duplication, bookmark persistence in `Document` sidecar, and `/EmbeddedFiles` preservation in `inkwell-core`

1. In `inkwell/crates/inkwell-core/src/doc.rs`:
   - Add `#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)] pub struct Bookmark { pub id: String, pub page: usize, pub label: String, #[serde(default)] pub created_at: u64 }` and add `#[serde(default)] pub bookmarks: Vec<Bookmark>` to `pub struct Document`.
   - In `Document::push_image` (line 261) and `Document::upsert_text` (line 279), call `self.remove_image(&image.id);` and `self.remove_text(&text_obj.id);` first before inserting into `self.sheets[sheet]`, guaranteeing an image or text object never exists on two sheets simultaneously after a cross-sheet move.
2. In `inkwell/crates/inkwell-core/src/pdf.rs` (`rewrite_catalog`, lines 699–707):
   - When `/EmbeddedFiles` already exists in `/Names`, preserve any existing `/Names [...]` entries whose key is not `(inkwell.doc)` and append `(inkwell.doc) {fs} 0 R` so third-party embedded files survive incremental save.
3. Add unit tests in `inkwell/crates/inkwell-core/tests/integration.rs` verifying:
   - Moving an image/text from sheet 0 to sheet 1 via `push_image`/`upsert_text` removes it from sheet 0.
   - `Document.bookmarks` round-trips losslessly through `pdf::save` and `pdf::read_sidecar`.

**Verify**: `cd inkwell && cargo test --workspace -- --test-threads=1 && cargo clippy --all-targets` → exit 0, 0 warnings.

### Step 2: Fix WAL `Truncate` synchronization, `Discard` on exit/Save-As, dynamic `startxref`, and PDFium-first page mutations in `src-tauri`

1. In `inkwell-app/src-tauri/src/state.rs`:
   - Change `WalOp::Truncate` to `WalOp::Truncate(Option<std::sync::mpsc::SyncSender<()>>)` and add `WalOp::Discard(Option<std::sync::mpsc::SyncSender<()>>)` which truncates the WAL before closing the worker.
2. In `inkwell-app/src-tauri/src/main.rs` (line 104):
   - When the user discards unsaved changes on exit, send `WalOp::Discard` with a sync channel and wait up to 500ms before exiting so discarded changes are never replayed on next launch.
3. In `inkwell-app/src-tauri/src/commands.rs`:
   - In `save_pdf` (lines 1188–1208): when saving to a new path ("Save As"), send `WalOp::Discard` to the old WAL worker before spawning the new one; when truncating the active WAL after save, pass a `sync_channel(1)` to `WalOp::Truncate(Some(ack_tx))` and wait for `ack_rx.recv_timeout(Duration::from_secs(2))` before returning.
   - Accept `bookmarks: Option<Vec<inkwell_core::doc::Bookmark>>` in `save_pdf` and return `bookmarks` in `PdfLoadResult` (`open_pdf`, `open_pdf_bytes`, `create_blank_document`).
   - In `create_blank_document` (lines 501–515), dynamically compute byte offsets for objects 1..4 and `xref` instead of hardcoding `startxref 215`.
   - In `insert_blank_page`, `delete_page`, `duplicate_page`, and `reorder_page`, perform the fallible PDFium operation *first* and only mutate `state.doc` after `new_bytes` succeeds; in `duplicate_page`, also journal cloned strokes, images, and text objects on `target_idx` to the WAL; in `replay_wal_journal`, replay structural page entries (`PageInserted`, `PageDeleted`, `PageReordered`, `PageRotated`) against `page_infos` so recovered page counts always match `doc.sheets.len()`.

**Verify**: `cd inkwell && cargo test --workspace -- --test-threads=1 && cargo clippy --all-targets` → exit 0, 0 warnings.

### Step 3: Wire bookmark persistence and undoable page operations in frontend (`ipc.js`, `document.js`, `main.js`)

1. In `inkwell-app/src/js/core/ipc.js`:
   - Include `bookmarks: (state.bookmarks || []).map(b => ({ id: String(b.id), page: Number(b.page) || 0, label: String(b.label || ''), created_at: Number(b.createdAt || 0) }))` in `savePdf`.
2. In `inkwell-app/src/js/main.js`:
   - In `handlePdfLoadResult`, restore `state.bookmarks = (res.bookmarks || []).map(b => ({ id: b.id, page: b.page, label: b.label, createdAt: b.created_at || Date.now() }))`.
   - Mark document dirty (`documentOps` / `toolbar.updateSaveStatusUI('dirty')`) when bookmarks are added or deleted in `drawers.js`.
3. In `inkwell-app/src/js/core/document.js`:
   - Record undo/redo transactions in `insertPageAtIndex`, `duplicatePageAtIndex`, `deletePageAtIndex`, and `reorderPageAtIndex` (with `{ recordHistory = true }` option) and handle `insert_page`, `duplicate_page`, `delete_page`, and `reorder_page` in `performUndo()` and `performRedo()`, emitting the corresponding `documentChanged` events so `main.js` calls the matching backend IPC (`ipc.deletePage`, `ipc.insertBlankPage`, `ipc.reorderPage`).

**Verify**: `cd inkwell-app && python3 test_app_smoke.py` → exit 0.

## Test plan

- Rust integration tests in `inkwell/crates/inkwell-core/tests/integration.rs` for cross-sheet image/text move deduplication, bookmark sidecar persistence, and `/EmbeddedFiles` preservation.
- Frontend smoke tests in `inkwell-app/test_app_smoke.py` verifying that `insertPageAtIndex`, `deletePageAtIndex`, and `reorderPageAtIndex` can be undone and redone via `performUndo()` / `performRedo()`, and that `ipc.savePdf` serializes `state.bookmarks`.

## Done criteria

- [ ] `cd inkwell && cargo test --workspace -- --test-threads=1` exits 0
- [ ] `cd inkwell && cargo clippy --all-targets` exits 0 with 0 warnings
- [ ] `cd inkwell-app && python3 test_app_smoke.py` exits 0
- [ ] `plans/README.md` status row updated to `DONE`

## STOP conditions

- Any existing Rust or Playwright smoke test fails.
- The code at the locations in "Current state" doesn't match the excerpts.

## Maintenance notes

- Any new document-level collection added to `state` in the frontend (like `bookmarks`) must also be added to `inkwell_core::doc::Document` and `ipc.savePdf`.
