# Plan 061: State & Transaction Integrity

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 3bf08b7..HEAD -- inkwell-app/src/js/core/document.js inkwell-app/src/js/main.js inkwell-app/src/js/core/clipboard.js inkwell-app/src/js/tools/pen.js inkwell-app/src-tauri/src/commands.rs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug | correctness
- **Planned at**: commit `3bf08b7`, 2026-10-07

## Why this matters

A digital notebook cannot afford state desynchronization or data loss during editing sessions:
1. Transforming ink with the Lasso tool drops stroke metadata (`sheet`, `kind`, `rgb`, `base_width`), causing undo/redo to turn transformed handwriting black and move it to page 1 while duplicating strokes in the Rust backend.
2. Lasso batch deletions delete items on the frontend canvas but never call backend deletion IPCs or WAL journals.
3. In-flight handwriting strokes crossing page boundaries calculate coordinates relative to the adjacent page while fixing the sheet index to the starting page, producing massive diagonal spikes across the document.
4. When exiting with unsaved changes, cancelling the file picker still force-closes the window and drops work.
5. Saving an untitled document fails to update `state.currentDocPath`, disabling autosave and re-prompting the save dialog on `Ctrl+S`.
6. Pasted objects suffer a race condition on immediate `Ctrl+Z` because transaction recording is deferred behind dynamic `import('./history.js')`.

Landing this plan guarantees 100% state and transaction fidelity across undo, redo, transforms, batch deletions, saves, and page transitions.

## Current state

- `inkwell-app/src/js/core/document.js:303-308`:
  `commitTransform` records only `id` and `points` in `initialStrokes` and `finalStrokes`. On undo/redo, `main.js:1640-1642` falls back to `sheet: 0`, `kind: 'pen'`, and default width.
- `inkwell-app/src-tauri/src/commands.rs:800`:
  `commit_stroke` calls `doc.push_stroke(sheet, stroke.clone())` unconditionally, adding duplicates when strokes are updated or transformed.
- `inkwell-app/src/js/core/clipboard.js:193` & `main.js:1614-1633`:
  `documentOps.deleteObjectsBatch` is called on deletion, but `documentChanged` has zero listener for `type === 'delete_objects'`, failing to invoke `ipc.deleteStroke`, `ipc.journalImageMutation('delete')`, or `ipc.journalTextMutation('delete')`.
- `inkwell-app/src/js/tools/pen.js:101-104`:
  `consumeSample` calls `viewport.worldToPage(ptWorld[0], ptWorld[1])` on every point sample, which swaps sheet origins when crossing page margins while `state.cur.sheet` remains fixed.
- `inkwell-app/src/js/main.js:189, 1560`:
  `file.save` awaits `ipc.savePdf` but does not capture the returned destination path or set `state.currentDocPath`.
- `inkwell-app/src/js/main.js:1654-1663`:
  `app-save-and-close` unconditionally calls `window.forceCloseWindow()` even when `file.save` was cancelled or errored.
- `inkwell-app/src/js/main.js:151-157`:
  `prepareAllImagesForSave` generates `template_bg_${sheetIdx}` and appends all `nonDeletedImages` from `state.images`, compounding duplicate template PNGs into the sidecar on every save cycle.
- `inkwell-app/src/js/core/clipboard.js:322-330`:
  `pasteClipboard` records history transactions asynchronously via dynamic `import('./history.js').then(...)`. Immediate `Ctrl+Z` undoes the previous action instead of the paste.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Desktop Smoke Test | `cd inkwell-app; py -3 test_app_smoke.py` | exit 0, all 75+ checks pass |
| Rust Workspace Tests | `cd inkwell; cargo test --workspace -- --test-threads=1` | exit 0, all 78 tests pass |
| Tauri Clippy | `cd inkwell-app/src-tauri; cargo clippy --all-targets` | exit 0, zero warnings |

## Scope

**In scope**:
- `inkwell-app/src/js/core/document.js`
- `inkwell-app/src/js/core/clipboard.js`
- `inkwell-app/src/js/main.js`
- `inkwell-app/src/js/tools/pen.js`
- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell-app/test_app_smoke.py`

**Out of scope**:
- PDF parser / writer implementation (`inkwell/crates/inkwell-core/src/pdf.rs`).

## Steps

### Step 1: Preserve stroke metadata during Lasso transform and update backend strokes cleanly

1. In `inkwell-app/src/js/core/document.js:299-318` (`commitTransform`):
   - In `initialStrokes` and `finalStrokes`, serialize full stroke metadata: `{ id: s.id, sheet: s.sheet, kind: s.kind, rgb: s.rgb, base_width: s.base_width || s.baseWidth, points: s.points.map(p => ({ ...p })) }`.
2. In `inkwell-app/src/js/main.js:1640-1644` (`undo_transform_objects` / `redo_transform_objects`):
   - Pass the preserved `s.sheet`, `s.kind`, `s.rgb`, and `s.base_width` to `ipc.commitStroke`.
3. In `inkwell-app/src-tauri/src/commands.rs:795-805` (`commit_stroke`):
   - Before `push_stroke`, remove any existing stroke matching `core_stroke.id` from `doc.sheets` to replace it in-place instead of creating duplicates.

**Verify**: `cd inkwell; cargo test --workspace -- --test-threads=1` and `cd inkwell-app; py -3 test_app_smoke.py`.

### Step 2: Wire lasso batch deletion to backend and WAL journal

1. In `inkwell-app/src/js/main.js:1558-1635`, add a listener for `type === 'delete_objects'`:
   - For every stroke in `data.strokes`: call `ipc.deleteStroke(s.id)`.
   - For every image in `data.images`: call `ipc.journalImageMutation('delete', null, img.id)`.
   - For every text in `data.textObjects`: call `ipc.journalTextMutation('delete', null, t.id)`.

**Verify**: `test_app_smoke.py` T12 WAL mutation assertions pass.

### Step 3: Anchor in-flight stroke coordinates to originating sheet layout

1. In `inkwell-app/src/js/tools/pen.js:101-105` (`consumeSample`):
   - Instead of querying `viewport.worldToPage(ptWorld[0], ptWorld[1])` on every sample, use the originating sheet layout fixed at pen-down:
     ```javascript
     const pl = viewport.getPageLayout(state.cur.sheet || 0);
     const px = ptWorld[0] - pl.x;
     const py = ptWorld[1] - pl.y;
     ```
   - This ensures continuous handwriting strokes near or across page borders never suffer coordinate distortion.

**Verify**: `test_app_smoke.py` T10 synthetic pen assertions pass.

### Step 4: Fix exit save cancellation and untitled document active path

1. In `inkwell-app/src/js/main.js`:
   - In `file.save`:
     ```javascript
     const savedPath = await ipc.savePdf(state.currentDocPath, state.strokes, imagesToSave, state.textObjects);
     if (savedPath) {
       state.currentDocPath = savedPath;
       state.currentDocTitle = savedPath.split(/[\\/]/).pop();
       state.isDirty = false;
       return true;
     }
     return false;
     ```
   - In `app-save-and-close` listener:
     ```javascript
     const success = await file.save();
     if (success) {
       window.forceCloseWindow();
     }
     ```
     If the user cancels the save dialog or save fails, do NOT close the window.

**Verify**: Verify cancelling save dialog leaves window open.

### Step 5: Deduplicate template backgrounds & eliminate clipboard undo race condition

1. In `inkwell-app/src/js/main.js:151-157` (`prepareAllImagesForSave`):
   - Filter `state.images` to exclude any images where `img.id.startsWith('template_bg_')` before concatenating freshly generated template backgrounds.
2. In `inkwell-app/src/js/core/clipboard.js`:
   - Replace dynamic `import('./history.js')` with top-level static `import * as history from './history.js';`.
   - Record `add_objects` transaction synchronously in `pasteClipboard` before returning.
3. In `inkwell-app/src/js/core/document.js:361-410` (`insertPageAtIndex`):
   - Synchronize `pi.page_index = idx` for all entries in `state.pageInfos` after splicing.

**Verify**: `cd inkwell-app; py -3 test_app_smoke.py` → all checks pass.

## Done criteria

- [ ] Lasso transform undo/redo preserves stroke color, width, kind, and sheet location.
- [ ] Backend document does not accumulate duplicate stroke entries upon transform or re-commit.
- [ ] Batch deletion via Lasso deletes items from backend document and WAL journal.
- [ ] Handwriting strokes near page margins remain anchored to originating page coordinates.
- [ ] Cancelling save on app exit aborts window closure and preserves user work.
- [ ] Saving an untitled document sets `state.currentDocPath`, enabling silent autosave.
- [ ] Sidecar does not compound duplicate template PNGs across save cycles.
- [ ] Immediate `Ctrl+Z` after paste cleanly undoes the pasted objects.
- [ ] All smoke tests and workspace tests pass with zero warnings.
