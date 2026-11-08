# Plan 090: Spec Autosave, Safe Close Dialog, Non-Blocking Save & "Keep Mine / Save a Copy"

| Field | Value |
|---|---|
| **Priority** | P0 |
| **Effort** | M (~350 lines across 6 files) |
| **Category** | Reliability / Requirement 11 (Autosave) & Requirement 5 (Sync) |
| **Depends on** | 088 (bounded growth makes frequent saves cheap for sync clients) |
| **Status** | DONE (2026-11-08; see Outcome) |

## Why

1. **Autosave is off by default and ignores the spec's policy.** `SPEC.md` §5 defines the policy: flush the PDF on 20 s pen idle, focus loss, a 3-minute ceiling, Ctrl+S and close. Never flush on every edit, because that thrashes cloud sync. `inkwell_core::wal::FlushPolicy` implements exactly this and is tested, but **nothing calls it**. The app instead has a localStorage debounce timer whose default is `0` (disabled).
2. **The quit dialog can destroy work.** On close with unsaved changes, the native dialog is `OkCancel` with text "Click OK to save or Cancel to discard and exit". Everywhere else, *Cancel* means "don't quit". A user who hits Cancel or Esc out of habit loses all unsaved ink, and the WAL is explicitly discarded too.
3. **The external-change banner offers only "Reload".** The spec requires `[Reload] [Keep mine] [Save a copy]` (`SPEC.md` §5). Without *Keep mine* the next save silently overwrites the synced version. Without *Save a copy* there is no safe exit.
4. **`save_pdf` holds `std::sync::Mutex` guards across all PDF generation inside an `async` command.** This blocks a Tokio worker for the whole save, and any concurrent IPC that needs `doc` (tile renders read state too) stalls. Large documents make autosave visibly hitch inking.

## Evidence

- `inkwell-app/src/js/core/state.js:158`: `autosaveDelayMs: parseInt(localStorage.getItem('inkwell_autosave_delay') || '0', 10)`.
- `inkwell-app/src/js/main.js:2687-2693`: debounce-per-mutation timer.
- `inkwell/crates/inkwell-core/src/wal.rs:296-356`: `FlushPolicy::decide`, unused outside tests (`grep -rn FlushPolicy inkwell-app` → none).
- `inkwell-app/src-tauri/src/main.rs:83-110`: `MessageDialogButtons::OkCancel`; the `else` branch sends `WalOp::Discard` and `exit(0)`.
- `inkwell-app/src-tauri/src/commands.rs:1400-1470`: guards on `doc`, `original_pdf_bytes`, `pdfium` held through `write_document` + `finish` + `atomic_write`.

## Steps

### 1. Policy-driven autosave (frontend scheduler, backend decides)
- Add Tauri command `autosave_tick(since_input_s, since_flush_s, focus_lost) -> Option<FlushReason>` wrapping `FlushPolicy::decide` (the single source of truth, already unit-tested).
- In `main.js`, replace the debounce with: a 1 s interval while dirty; `window.blur`/`visibilitychange→hidden` sends `focus_lost`; pen `pointerup` updates `lastInputAt`. When the backend returns a reason, call the existing save path.
- Settings: "Autosave: On (recommended) / Off". **Default On** for documents with a path. Migrate the old `inkwell_autosave_delay` key: any value > 0 maps to On; `0` maps to On as well (it was never a deliberate choice, since 0 was the default). Show the reason in the status pill tooltip ("Saved 12:04 · idle").
- Never autosave while a stroke is in progress (`state.isDrawing`) or a modal is open.

### 2. Three-way close dialog
- Replace the native `OkCancel` with an in-app modal (glassmorphic, 44 px buttons, focus trap, Esc = Cancel): **Save**, **Don't Save**, **Cancel**. Default button = Save.
- *Don't Save* keeps the WAL (do **not** `Discard`). Next open of the same file offers "Recover N unsaved strokes from your last session?". Discarding a journal is a user action in the recovery toast, never a side effect of closing.
- Multiple tabs: list each dirty tab with a checkbox ("Save all").

### 3. External-change banner: Reload / Keep mine / Save a copy
- *Keep mine*: dismiss and mark that the next save is an intentional overwrite (re-stamp `doc_disk_stamp` from the new on-disk metadata).
- *Save a copy*: save-as dialog prefilled `name (BezierNotes copy).pdf`. The session then points at the copy.
- Before Plan 092 lands, *Reload* keeps today's semantics. After 092, the banner gains **Merge** as the primary action.

### 4. Non-blocking save
- Snapshot what's needed under the locks (`doc.clone()` or `Arc<Document>`, the `Arc<Vec<u8>>` base), drop the guards, run `write_document` + `finish` + `atomic_write` in `tauri::async_runtime::spawn_blocking`. Re-take locks only to publish results.
- Guard against overlapping saves with a `save_generation: AtomicU64`. A save whose generation is stale must not overwrite `pdf_bytes`.

### 5. Sweep orphaned save temp files
Plan 087's torture loop shows that a kill during `atomic_write` leaves `.<name>.pdf.inkwell-tmp-<pid>-<n>` next to the document: 25 of 60 kills on a real disk. The document itself is always intact, but these siblings sit inside the user's sync folder and get uploaded. On open and after each successful save, delete siblings matching that exact pattern whose `<pid>` is not a live process. Add a `torture_save.sh` assertion that, after the next successful save, the orphan count is 0.

### 6. Windows journal location
- `wal_path_for` uses `%TEMP%` on Windows, which Storage Sense and cleanup tools purge. Move it to `%LOCALAPPDATA%\BezierNotes\wal\` (still outside sync folders, Non-Negotiable #4). Migrate an existing journal on first open.

## Verification

```bash
cd inkwell && cargo test --workspace -- --test-threads=1 && cargo clippy --all-targets
cd inkwell-app && python3 test_app_smoke.py
```
New smoke checks: autosave fires after simulated 20 s idle (inject a clock) and on blur, never mid-stroke; close modal has 3 buttons and Esc cancels; *Don't Save* leaves a recoverable journal; banner shows 3 actions and *Keep mine* suppresses the next false alarm; inking frame time during a save of a 1000-stroke document stays < 16 ms.

## STOP Conditions
- STOP if an autosave ever writes while the external-change banner is unresolved. That would overwrite the synced version.
- STOP if moving the save off-thread lets two saves interleave `atomic_write` on the same path.

## Outcome (2026-11-08)

**Autosave (§1).**
- New `js/app/autosave.js` ticks once a second; the backend's `autosave_tick` wraps `FlushPolicy::decide` (20 s idle / focus loss / 3 min), which remains the single source of truth. Blur and hidden-tab trigger an immediate tick with `focus_lost`.
- It never runs mid-stroke (`state.cur`, erasing, lasso, shape), with a modal open, while the change-on-disk banner is unresolved, or within 30 s of a failed autosave (no retry storm).
- Autosaves are silent; the status pill tooltip says "Saved 12:04 · idle".
- The setting is now On/Off (default On, key `inkwell_autosave`). The old `inkwell_autosave_delay` is deliberately ignored, since its default 0 was never a user choice.

**Edits made while a save runs (found while doing §4; a data-loss bug).** `save_pdf` used to truncate the whole journal after writing, and the frontend then marked the document clean. Strokes drawn while the save ran were in neither the saved PDF nor the journal. The fix:
- `core/ipc.js` numbers every journalled call (`seq`, after the JS state holds the edit), and a save sends the number its payload reflects.
- `Wal` records each record's seq; `Wal::truncate_through(n)` drops only records ≤ n, copying kept records byte for byte. Records left over from a crash count as covered.
- The backend keeps `is_dirty` set when newer seqs arrived during the save, and the frontend keeps `isDirty` when `state.editSeq` moved.
- Crash replay is now idempotent (`Added` replaces a stroke with the same id), so a kept record that a save already covered can't duplicate a stroke.
- Tests: core `truncate_through_keeps_edits_made_during_a_save`, `reopened_journal_counts_leftover_records_as_covered`; app `save_trims_only_the_journal_its_snapshot_covers` (mutation-tested: a blanket truncate fails it); smoke T30.

**Close dialog (§2).** A native three-button dialog (`YesNoCancelCustom`: Save / Don't Save / Cancel), kept native on purpose so quitting works even if the page's JS is broken. Cancel, Esc or closing the dialog keeps working. *Don't Save* no longer deletes the journal: `WalOp::Shelve` closes it and renames it to `*.shelved.bin`. The next `open_pdf` of that file reports `shelved_journal_entries`, and the frontend shows a toast with a 44 px **Restore them** action that reopens with `restore_shelved`, folding the records into the live journal before the normal replay. Toasts gained optional actions for this.

**Banner (§3).** Reload / **Keep mine** / **Save a copy** (Save As prefilled `name (BezierNotes copy).pdf`; the session moves to the copy). The bare ✕ is gone: dismissing without choosing would have left autosave paused invisibly. A manual Ctrl+S counts as Keep mine.

**Non-blocking save (§4).** `save_pdf` runs its whole body in `spawn_blocking` (`save_blocking`) under `AppState::save_lock`, from snapshot to publish. Page operations (insert/delete/duplicate/rotate/reorder) take the same lock, so they can't interleave with a save. Inking (`commit_stroke`) doesn't take it. `save_generation` makes a superseded save return without writing (tested). Manual saves may overlap autosaves; the backend orders them.

**Orphaned temps (§5).** `wal::sweep_orphan_temps(target, min_age)` removes only exact `.<name>.inkwell-tmp-<pid>-<n>` siblings that aren't this process's. It runs on open and after every save (60 s minimum age, so another process mid-write is never raced). The torture loop now runs the same sweep after every kill and fails if any temp survives: 200 kills, 0 failures, 122 temps swept.

**Windows journal (§6).** `%LOCALAPPDATA%\BezierNotes\wal\`, with a one-time move of an existing `%TEMP%` journal. Not run on Windows here; it compiles for the host target only, so check it on the Windows CI build.

**Verification.** Rust core 121/121, strict conformance + render diff, app crate 18/18 (new: autosave tick, two save-pipeline tests), clippy clean on both workspaces, boundaries clean, smoke 164/164 (T30: 10 checks), focused suites pass, torture 200/200.

**Not done / limits.**
- **Inactive tabs.** The close dialog covers the active document; inactive tabs' journals stay as they were and replay on next open, which is the old behaviour.
- **Save a copy while drawing.** Edits journalled during the save-as go into the old file's journal, which is discarded.
- **Payload size.** The save payload is still the full stroke list serialised on the JS main thread; for very large documents that, not the PDF write, is the remaining hitch. A later plan could send deltas.
- **No real-app check.** The native dialog and the real save timing were not exercised in the running desktop app.
