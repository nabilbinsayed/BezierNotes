# Plan 063: Backend Tile Cache Concurrency, Memory Budget & Normalisation Caching

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 3bf08b7..HEAD -- inkwell-app/src-tauri/src/commands.rs inkwell-app/src-tauri/src/state.rs inkwell-app/src/js/render/tiles.js inkwell-app/src/js/render/compositor.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf | concurrency | memory
- **Planned at**: commit `3bf08b7`, 2026-10-07

## Why this matters

Tile rendering and document saving must remain fast and lean:
1. When multiple grid tiles on an uncached page miss concurrently, all requests queue behind `pdfium.lock()` and sequentially re-rasterize the exact same full 4K page 4x to 12x because double-checked locking is missing.
2. `PageBitmapLruCache` bounds only entry count (`max_entries: 16`), allowing 16 4K page bitmaps to consume over 1 GB of uncompressed RAM in the background.
3. Every save on a modern xref-stream PDF re-runs a full PDFium `normalise()` decompress-and-serialize cycle because `state.original_pdf_bytes` is never updated with the normalized bytes.
4. If a tile fetch fails once due to transient lock contention, `fetchTile` caches `null`, permanently blacking out that tile until the application restarts.
5. Rapid panning or zooming drops subsequent tile redraw requests while `_redrawTilesPending` is true.

Landing this plan eliminates thundering herd tile stalls, bounds backend memory to a strict 256MB budget, makes saves instantaneous, and prevents permanent tile blackouts.

## Current state

- `inkwell-app/src-tauri/src/commands.rs:622-639`:
  `render_tile` checks `state.page_bitmap_cache` under a temporary lock, releases it, and then acquires `state.pdfium` without checking the cache again.
- `inkwell-app/src-tauri/src/state.rs:23-55`:
  `PageBitmapLruCache` tracks only entry count (`max_entries: 16`) without byte size tracking.
- `inkwell-app/src-tauri/src/commands.rs:1093-1119`:
  `save_pdf` re-runs `normalise` on `original_bytes` on every save; `state.original_pdf_bytes` is never updated.
- `inkwell-app/src/js/render/tiles.js:146`:
  `fetchTile` catches errors and sets `tileCache.set(key, null)`, treating failures as permanent hits.
- `inkwell-app/src/js/render/tiles.js:23-35, 89`:
  `tileCache.get(key)` does not refresh the key's iteration position in the JavaScript Map, causing active on-screen tiles to be evicted prematurely.
- `inkwell-app/src/js/render/compositor.js:133-143`:
  `scheduleRedrawTiles` early-returns without queuing if `_redrawTilesPending` is true.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Desktop Smoke Test | `cd inkwell-app; py -3 test_app_smoke.py` | exit 0, all 75+ checks pass |
| Tauri Clippy | `cd inkwell-app/src-tauri; cargo clippy --all-targets` | exit 0, zero warnings |

## Scope

**In scope**:
- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell-app/src-tauri/src/state.rs`
- `inkwell-app/src/js/render/tiles.js`
- `inkwell-app/src/js/render/compositor.js`

**Out of scope**:
- PDFium C FFI bindings (`inkwell-pdf`).

## Steps

### Step 1: Implement double-checked locking in `render_tile`

In `inkwell-app/src-tauri/src/commands.rs:620-645`:
1. Check `state.page_bitmap_cache` first. If hit, crop and return the tile.
2. If miss, acquire `state.pdfium.lock()`.
3. Check `state.page_bitmap_cache` a SECOND time immediately inside the lock.
4. If an earlier concurrent request already rasterized and inserted the page bitmap while this request was waiting, use the cached bitmap immediately without re-rasterizing.

**Verify**: `cargo clippy --all-targets` in `src-tauri` exits 0.

### Step 2: Enforce memory byte budget on `PageBitmapLruCache`

In `inkwell-app/src-tauri/src/state.rs:23-55`:
1. Add `current_bytes: usize` and `max_bytes: usize` (e.g. 256 * 1024 * 1024 = 256 MB) to `PageBitmapLruCache`.
2. On `put()`, calculate `new_bytes = entry.bgra_bytes.len()`.
3. Evict entries from the front of `entries` while `self.current_bytes + new_bytes > self.max_bytes || self.entries.len() >= self.max_entries`.
4. Update `self.current_bytes` on insertion and eviction.

**Verify**: Verify memory usage stays bounded during high-DPI zoom/pan testing.

### Step 3: Cache normalized PDF bytes in `original_pdf_bytes`

In `inkwell-app/src-tauri/src/commands.rs:1090-1120` (`save_pdf`):
1. When `inkwell_pdf::normalise(pdfium, original_bytes)` succeeds (producing `nb`), update:
   ```rust
   *orig_guard = Some(Arc::new(nb.clone()));
   ```
2. Subsequent save calls can open `original_bytes` directly with `PdfFile::open` without invoking PDFium normalisation.

**Verify**: Verify second save executes in under 20ms.

### Step 4: Fix tile cache eviction order, transient retry & queued redraws

1. In `inkwell-app/src/js/render/tiles.js`:
   - In `fetchTile`: remove `tileCache.set(key, null)` from the catch block so transient errors can be retried on the next pass.
   - On cache hits in `fetchTile`:
     ```javascript
     const val = tileCache.get(key);
     tileCache.delete(key);
     tileCache.set(key, val);
     ```
     This moves active on-screen tiles to the end of the Map, protecting them from FIFO eviction.
2. In `inkwell-app/src/js/render/compositor.js`:
   - Introduce `_redrawTilesQueued = false`.
   - If `scheduleRedrawTiles()` is called while `_redrawTilesPending === true`, set `_redrawTilesQueued = true`.
   - In the `finally` block of `redrawTiles()`, if `_redrawTilesQueued === true`, reset it and call `scheduleRedrawTiles()`.

**Verify**: `cd inkwell-app; py -3 test_app_smoke.py` passes all checks.

## Done criteria

- [ ] Uncached tile misses reuse page bitmaps rasterized by concurrent sibling requests via double-checked locking.
- [ ] Backend page bitmap memory is bounded to 256 MB.
- [ ] Saves on xref-stream PDFs do not re-run PDFium normalization on every save.
- [ ] Transient tile fetch errors are retried rather than permanently caching black tiles.
- [ ] Rapid zooming/panning does not strand blank tiles due to dropped redraw requests.
- [ ] All smoke tests and clippy checks pass.
