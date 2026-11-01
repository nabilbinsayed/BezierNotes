# Plan 069: PDF Rendering Fidelity, BGRA Channel Fix, Annotation Isolation & Tile Cache Scale

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c036ee8..HEAD -- inkwell-app/src-tauri/src/commands.rs inkwell/crates/inkwell-pdf/src/rasterizer.rs inkwell/crates/inkwell-core/src/pdf.rs inkwell-app/src/js/render/compositor.js inkwell-app/src/js/render/tiles.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug | perf | correctness
- **Planned at**: commit `c036ee8`, 2026-10-30

## Why this matters

Five rendering and PDF pipeline defects currently degrade visual quality and performance:
1. **Inverted Red and Blue channels on all PDF tiles**: `pdfium-render`'s `PdfBitmap::as_raw_bytes()` returns unnormalized `BGRA` pixels (`[B, G, R, A]`), but both `commands.rs:765-767` and `rasterizer.rs:75-78` read index `0` as Red and index `2` as Blue, swapping red and blue across every rendered PDF page.
2. **Permanent tile ghosting of saved images and text notes**: `render_tile` (`commands.rs:693-706`) strips InkWell-authored annotations before rasterizing the background bitmap by checking `annot.creator().as_deref() == Some("Inkwell")` (the PDF `/T` entry). However, `emit_image_annot` (`pdf.rs:554-561`) and `emit_text_annot` (`pdf.rs:640-650`) omit `/T (Inkwell)`. When a saved PDF is reopened, images, text boxes, and background templates are permanently baked into the background tile bitmap and double-rendered on `#dry`, leaving immovable ghosts when moved or deleted.
3. **0% bitmap cache hit rate on boundary tiles**: `commands.rs:641-643` and `rasterizer.rs:32` compute `scale = (px as f64) / rw.max(rh)`. Because right-edge and bottom-edge tiles clamp `rect` to `page_w` / `page_h` (`rw < 512` or `rh < 512`), their computed `scale` and `target_w`/`target_h` differ from interior `512x512` tiles, causing full-page PDFium re-rasterization on every margin tile.
4. **Stale tile overdraw & right-pane starvation during pan/zoom**: `compositor.js:159-175` awaits the left pane before starting the right pane and aborts if `_redrawTilesEpoch` increments, starving the right pane. Meanwhile, `tiles.js:222-228` paints resolved tiles without checking if `drawEpoch` is still current, flashing stale zoom tiles over crisp ones.
5. **Broken tile cache LRU**: `tiles.js:212-215` reads from `tileCache` without refreshing key insertion order in the `Map`, so `evictTileCache` evicts active viewport tiles in FIFO order instead of LRU order.

## Current state

- `inkwell-app/src-tauri/src/commands.rs:641-643` and `761-778`:
  ```rust
    let rw = (rect[2] - rect[0]).max(1.0);
    let rh = (rect[3] - rect[1]).max(1.0);
    let scale = (px as f64) / rw.max(rh);
  ...
                    if src_idx + 3 < bgra_bytes.len() {
                        let r = bgra_bytes[src_idx];
                        let g = bgra_bytes[src_idx + 1];
                        let b = bgra_bytes[src_idx + 2];
                        let a = bgra_bytes[src_idx + 3] as u32;
  ```
- `inkwell/crates/inkwell-pdf/src/rasterizer.rs:26-33` and `74-90`:
  ```rust
        let rw = (rect[2] - rect[0]).max(1.0);
        let rh = (rect[3] - rect[1]).max(1.0);
        let page_w = p.width().value as f64;
        let page_h = p.height().value as f64;
        let scale = (px as f64) / rw.max(rh);
  ...
                if src_idx + 3 < bgra_bytes.len() {
                    let (r, g, b, a) = (
                        bgra_bytes[src_idx],
                        bgra_bytes[src_idx + 1],
                        bgra_bytes[src_idx + 2],
                        bgra_bytes[src_idx + 3] as u32,
                    );
  ```
- `inkwell/crates/inkwell-core/src/pdf.rs:554-562` and `640-651`:
  ```rust
        let annot = self.add(
            format!(
                "<< /Type /Annot /Subtype /Stamp /F 4 /Rect [{}] \
                 /AP << /N {ap} 0 R >> /Inkw_Sid ({sid}) >>",
                fmt_rect(&annot_rect)
            )
            .into_bytes(),
        );
  ...
        let annot = self.add(
            format!(
                "<< /Type /Annot /Subtype /FreeText /F 4 /Rect [{}] \
                 /Contents {escaped_contents} \
                 /DA ({font_tag} {:.2} Tf {:.3} {:.3} {:.3} rg) \
                 /AP << /N {ap} 0 R >> /Inkw_Sid ({sid}) >>",
                fmt_rect(&annot_rect),
                fs, cr, cg, cb
            )
            .into_bytes(),
        );
  ```
- `inkwell-app/src/js/render/compositor.js:153-179`:
  ```javascript
  export async function redrawTiles() {
    if (!_tctx || !_tilesCanvas || !_viewport) return;
    const drawEpoch = ++_redrawTilesEpoch;
    _tctx.setTransform(1, 0, 0, 1, 0, 0);
    _tctx.clearRect(0, 0, _tilesCanvas.width, _tilesCanvas.height);

    for (const pane of visiblePanes()) {
      const visiblePages = _viewport.getVisiblePages(pane);
      for (const pl of visiblePages) {
        const pi = state.pageInfos && state.pageInfos[pl.sheet];
        templates.drawPageBackground(_tctx, pl, _viewport, pi, state.dpr, pane);
      }
      if (visiblePages.length) {
        const bounds = paneBounds(pane);
        await Promise.all(visiblePages.map(pl => {
          const pi = state.pageInfos[pl.sheet];
          return pi ? tiles.redrawTilesForPage(_tctx, pane, pi, pl, _viewport, state.dpr, bounds, clipToPane) : Promise.resolve();
        }));
        if (drawEpoch !== _redrawTilesEpoch) {
          return; // Stale render superseded by a newer draw request; drop
        }
      }
    }

    overlays.drawZoomIndicator(_tctx, _viewport, state.dpr, visiblePanes(), paneBounds);
    tiles.evictTileCache();
  }
  ```
- `inkwell-app/src/js/render/tiles.js:211-229`:
  ```javascript
      const trKey = `${pl.sheet}:${tr.join(',')}:${px}`;
      if (tileCache.has(trKey)) {
        drawTileData(ctx, tileCache.get(trKey), tr, pl, pane, pi, viewport, dpr, clipPaneFn);
        return;
      }

      const fallback = findCachedTileFallback(pl.sheet, tr);
      if (fallback) {
        drawTileData(ctx, fallback, tr, pl, pane, pi, viewport, dpr, clipPaneFn);
      }

      const result = await fetchTile(pl.sheet, tr, px);
      if (!result || !result.data) return;

      const visibleNow = viewport.getVisiblePages(pane);
      if (visibleNow.some(v => v.sheet === pl.sheet)) {
        drawTileData(ctx, result.data, tr, pl, pane, pi, viewport, dpr, clipPaneFn);
      }
  ```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rust Workspace Tests | `cd inkwell && cargo test --workspace -- --test-threads=1` | exit 0, all tests pass |
| Rust Clippy | `cd inkwell && cargo clippy --all-targets` | exit 0, 0 warnings |
| App Smoke Tests | `cd inkwell-app && python3 test_app_smoke.py` | exit 0, all checks pass |

## Scope

**In scope**:
- `inkwell-app/src-tauri/src/commands.rs`
- `inkwell/crates/inkwell-pdf/src/rasterizer.rs`
- `inkwell/crates/inkwell-core/src/pdf.rs`
- `inkwell/crates/inkwell-core/tests/integration.rs`
- `inkwell-app/src/js/render/compositor.js`
- `inkwell-app/src/js/render/tiles.js`
- `inkwell-app/test_app_smoke.py`

**Out of scope**:
- Split-pane layout ratio and divider UI (handled in Plan 071).
- Inking and brush math (handled in Plan 070).

## Steps

### Step 1: Fix BGRA-to-RGBA channel order and boundary tile scale in Rust rasterizers

1. In `inkwell-app/src-tauri/src/commands.rs`:
   - At line 643, replace `let scale = (px as f64) / rw.max(rh);` with:
     ```rust
     // Standardize scale against the 512pt grid tile size when px >= 64 and rw/rh <= 512,
     // so boundary-clipped tiles (< 512pt wide/tall) hit the same cached full-page bitmap.
     let base_span = if rw <= 512.0 && rh <= 512.0 { 512.0 } else { rw.max(rh) };
     let scale = (px as f64) / base_span;
     ```
   - At lines 765–767, read byte 0 as Blue and byte 2 as Red from PDFium's `BGRA` buffer:
     ```rust
     let b = bgra_bytes[src_idx];
     let g = bgra_bytes[src_idx + 1];
     let r = bgra_bytes[src_idx + 2];
     let a = bgra_bytes[src_idx + 3] as u32;
     ```
2. In `inkwell/crates/inkwell-pdf/src/rasterizer.rs`:
   - At line 32, apply the same `base_span` scale calculation:
     ```rust
     let base_span = if rw <= 512.0 && rh <= 512.0 { 512.0 } else { rw.max(rh) };
     let scale = (px as f64) / base_span;
     ```
   - At lines 75–79, unpack `(b, g, r, a)` in BGRA order:
     ```rust
     let (b, g, r, a) = (
         bgra_bytes[src_idx],
         bgra_bytes[src_idx + 1],
         bgra_bytes[src_idx + 2],
         bgra_bytes[src_idx + 3] as u32,
     );
     ```

**Verify**: `cd inkwell && cargo clippy --all-targets` → exit 0, 0 warnings.

### Step 2: Add `/T (Inkwell)` creator tag to image and text annotations in `pdf.rs`

1. In `inkwell/crates/inkwell-core/src/pdf.rs`:
   - In `emit_image_annot` (lines 554–561), include `/T (Inkwell)`:
     ```rust
     let annot = self.add(
         format!(
             "<< /Type /Annot /Subtype /Stamp /F 4 /Rect [{}] \
              /T (Inkwell) /AP << /N {ap} 0 R >> /Inkw_Sid ({sid}) >>",
             fmt_rect(&annot_rect)
         )
         .into_bytes(),
     );
     ```
   - In `emit_text_annot` (lines 640–650), include `/T (Inkwell)`:
     ```rust
     let annot = self.add(
         format!(
             "<< /Type /Annot /Subtype /FreeText /F 4 /Rect [{}] \
              /T (Inkwell) /Contents {escaped_contents} \
              /DA ({font_tag} {:.2} Tf {:.3} {:.3} {:.3} rg) \
              /AP << /N {ap} 0 R >> /Inkw_Sid ({sid}) >>",
             fmt_rect(&annot_rect),
             fs, cr, cg, cb
         )
         .into_bytes(),
     );
     ```
2. In `inkwell/crates/inkwell-core/tests/integration.rs`, add a unit test `image_and_text_annots_carry_inkwell_creator_tag` that saves a document with an `ImageObject` and a `TextObject` and asserts the output PDF bytes contain `/Subtype /Stamp` and `/Subtype /FreeText` dictionaries each bearing `/T (Inkwell)`.

**Verify**: `cd inkwell && cargo test --workspace -- --test-threads=1` → exit 0, all tests pass including `image_and_text_annots_carry_inkwell_creator_tag`.

### Step 3: Fix tile epoch validation, parallel dual-pane tile rendering, and LRU cache promotion in frontend

1. In `inkwell-app/src/js/render/compositor.js`:
   - Export `export function getTilesEpoch() { return _redrawTilesEpoch; }`.
   - In `redrawTiles()` (lines 159–175), first draw page backgrounds synchronously for all `visiblePanes()`, then dispatch tile rendering for all visible panes concurrently via `Promise.all(visiblePanes().map(...))`, passing `drawEpoch` (or checking `isCurrentEpoch: () => drawEpoch === _redrawTilesEpoch`) into `tiles.redrawTilesForPage`:
     ```javascript
     const panes = visiblePanes();
     for (const pane of panes) {
       const visiblePages = _viewport.getVisiblePages(pane);
       for (const pl of visiblePages) {
         const pi = state.pageInfos && state.pageInfos[pl.sheet];
         templates.drawPageBackground(_tctx, pl, _viewport, pi, state.dpr, pane);
       }
     }
     const isCurrentEpoch = () => drawEpoch === _redrawTilesEpoch;
     await Promise.all(panes.map(async pane => {
       const visiblePages = _viewport.getVisiblePages(pane);
       if (!visiblePages.length) return;
       const bounds = paneBounds(pane);
       await Promise.all(visiblePages.map(pl => {
         const pi = state.pageInfos && state.pageInfos[pl.sheet];
         return pi
           ? tiles.redrawTilesForPage(_tctx, pane, pi, pl, _viewport, state.dpr, bounds, clipToPane, isCurrentEpoch)
           : Promise.resolve();
       }));
     }));
     if (!isCurrentEpoch()) return;
     ```
2. In `inkwell-app/src/js/render/tiles.js`:
   - Update `redrawTilesForPage(ctx, pane, pi, pl, viewport, dpr, bounds, clipPaneFn, isCurrentEpoch = () => true)`:
   - On cache hit (lines 212–215), promote the entry to most-recently-used before drawing:
     ```javascript
     if (tileCache.has(trKey)) {
       const cached = tileCache.get(trKey);
       tileCache.delete(trKey);
       tileCache.set(trKey, cached);
       if (isCurrentEpoch()) {
         drawTileData(ctx, cached, tr, pl, pane, pi, viewport, dpr, clipPaneFn);
       }
       return;
     }
     ```
   - After `const result = await fetchTile(pl.sheet, tr, px);` (line 222), check `if (!result || !result.data || !isCurrentEpoch()) return;` before calling `drawTileData`.

**Verify**: `cd inkwell-app && python3 test_app_smoke.py` → exit 0, all checks pass.

## Test plan

- Rust test `image_and_text_annots_carry_inkwell_creator_tag` in `inkwell/crates/inkwell-core/tests/integration.rs`.
- Smoke test assertion in `inkwell-app/test_app_smoke.py` verifying that `compositor.getTilesEpoch` increments on `redrawTiles` and that cache hits promote keys to the end of `tileCache`.

## Done criteria

- [ ] `cd inkwell && cargo test --workspace -- --test-threads=1` exits 0
- [ ] `cd inkwell && cargo clippy --all-targets` exits 0 with 0 warnings
- [ ] `cd inkwell-app && python3 test_app_smoke.py` exits 0
- [ ] `grep -n "/T (Inkwell)" inkwell/crates/inkwell-core/src/pdf.rs` returns 3 matches (ink, image, and text annotations)
- [ ] `plans/README.md` status row updated to `DONE`

## STOP conditions

- The code at the locations in "Current state" doesn't match the excerpts.
- Any existing Rust test or Playwright smoke test fails after Step 1–3.

## Maintenance notes

- Whenever a new PDF annotation subtype is added in `pdf.rs` (such as `/Highlight` or `/Underline` in Plan 073), always include `/T (Inkwell)` and `/Inkw_Sid (...)` so `render_tile` filters it out of background bitmaps and `rewrite_page` replaces it cleanly on incremental save.
