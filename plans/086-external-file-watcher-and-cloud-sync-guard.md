# Plan 086: External File Modification Watcher & Non-Destructive Cloud Sync Reload

| Field | Value |
|---|---|
| **Priority** | P2 |
| **Effort** | S (~140 lines across 4 files) |
| **Category** | Feature / Reliability & Cloud Sync Safety |
| **Depends on** | 081 |
| **Status** | TODO |

## Why

Listed on the official roadmap in `README.md:197-198` (*"External file modification detection (reload prompt on cloud sync changes)"*): users commonly store PDFs inside Nextcloud, Dropbox, Syncthing, iCloud, or Git repositories. If an external sync updates the underlying PDF file on disk while it is open in InkWell, saving without warning could overwrite external changes, or the user could be viewing outdated base pages.
Recording the on-disk `(modified_time, file_len)` snapshot whenever InkWell opens or saves a document—and checking it when the window regains focus—allows InkWell to prompt the user with a non-destructive **Reload Base PDF & Keep Unsaved Ink** banner.

## Evidence

### `inkwell-app/src-tauri/src/state.rs:74-124`
`AppState` tracks `pub doc_path: Mutex<Option<PathBuf>>`, updated during `load_document` and `save_document` in `commands.rs`.

## Scope

### Files to Modify
1. `inkwell-app/src-tauri/src/state.rs`
2. `inkwell-app/src-tauri/src/commands.rs`
3. `inkwell-app/src/js/core/ipc.js`
4. `inkwell-app/src/js/main.js`

### Files NOT to Touch
- Do NOT auto-reload silently without user confirmation if the document has unsaved changes (`state.isDirty`).

## Step-by-Step Implementation

### Step 1: Track On-Disk File Stamp in `AppState` (`inkwell-app/src-tauri/src/state.rs` & `commands.rs`)

1. In `state.rs`, add to `AppState`:
   ```rust
   pub doc_disk_stamp: Mutex<Option<(std::time::SystemTime, u64)>>,
   ```
   And a helper method on `AppState`:
   ```rust
   pub fn record_disk_stamp(&self, path: &std::path::Path) {
       let stamp = std::fs::metadata(path)
           .ok()
           .and_then(|m| Some((m.modified().ok()?, m.len())));
       if let Ok(mut guard) = self.doc_disk_stamp.lock() {
           *guard = stamp;
       }
   }
   ```
2. Call `state.record_disk_stamp(&path)` at the end of `load_document` and `save_document` in `commands.rs`.
3. Add a Tauri command `check_external_file_change(state: State<'_, AppState>) -> Result<bool, String>` in `commands.rs` (and register it in `main.rs` `invoke_handler`):
   - Reads `state.doc_path.lock()`. If `None`, returns `Ok(false)`.
   - Reads current `std::fs::metadata(&path)`. If `(modified, len)` differs from `state.doc_disk_stamp.lock()`, updates `doc_disk_stamp` (so it only triggers once per external modification) and returns `Ok(true)`.

### Step 2: Poll on Window Focus & Offer Non-Destructive Reload in `inkwell-app/src/js/main.js`

1. In `ipc.js`, export `checkExternalFileChange()`:
   ```javascript
   export async function checkExternalFileChange() {
     if (!isTauri()) return false;
     try {
       return !!(await invokeTauri('check_external_file_change', {}));
     } catch (_) {
       return false;
     }
   }
   ```
2. In `main.js`, listen to `window.addEventListener('focus', ...)` and `document.addEventListener('visibilitychange', ...)`:
   - Call `await ipc.checkExternalFileChange()`.
   - When `true` and `state.currentFilePath`:
     - Show a persistent toast/banner with a `"Reload from Disk"` action button (`min-height: 44px`) that reloads the updated PDF from `state.currentFilePath` while preserving any unsaved session annotations (`state.strokes`, `state.images`, `state.textObjects`)!

## Verification

```bash
cd inkwell && cargo test --workspace -- --test-threads=1 && cargo clippy --all-targets
cd ../inkwell-app && python3 test_app_smoke.py
```

## STOP Conditions
- STOP if InkWell's own `save_document` triggers a false-positive external file modification alert—`state.record_disk_stamp(&path)` MUST be called immediately after `atomic_write` inside `save_document`.
