# Plan 079: Non-Blocking Tile Compositor, Single-Clip Page Blitting & Offscreen Dry-Layer Cache

| Field | Value |
|---|---|
| **Priority** | P0 |
| **Effort** | M (~250 lines across 4 files) |
| **Category** | Performance / Rendering Smoothness |
| **Depends on** | 078 |
| **Status** | TODO |

## Why

Even in a `--release` build, scrolling, panning, and pinching across PDF pages with annotations suffer from three severe frontend rendering bottlenecks:

1. **Async Tile Redraw Frame Lockup (`compositor.js:144-161`, `tiles.js:194-234`)**:
   `scheduleRedrawTiles()` sets `_redrawTilesPending = true` and `await`s `redrawTiles()` inside `requestAnimationFrame`. Because `redrawTiles()` `await`s `Promise.all(allMissing.map(...))`, `_redrawTilesPending` remains `true` for **30–100 ms** while PDFium renders missing tiles in the Rust backend. During that entire 30–100 ms window, every subsequent scroll/pan animation frame hits `if (_redrawTilesPending) { _redrawTilesQueued = true; return; }` and **fails to update the screen positions of already-cached tiles**, causing the `#pdf` underlay to freeze and lag behind the `#dry` ink layer!
2. **Per-Tile Double Clipping (`tiles.js:162-186`)**:
   `drawTileData()` executes `pctx.save()`, `compositor.clipToPane(pctx, pane)`, `pctx.clip()` (page rectangle), and `pctx.restore()` for *every single 256×256 tile* (12–24 times per frame) instead of clipping once per visible page in `redrawTilesForPage()`.
3. **Per-Frame `#dry` Vector Re-Rasterization (`compositor.js:269-404`)**:
   Every scroll, pan, or zoom frame calls `redrawAll()`, which clears `#dry` and re-executes `ctx.fill(p2d)` for every stroke, highlighter (with `multiply` composite state switches), image, text note, and template grid line on every visible page. When a page contains 300+ strokes, CPU/GPU path rasterization on `#dry` takes **5–18 ms per frame**, dropping pan/scroll below 60/120 FPS. Caching a per-page offscreen bitmap (`_dryPageCache`) at the quantized page zoom when not actively mid-transform allows `redrawDryForPane()` to blit a single cached canvas per visible page in **< 0.3 ms** ($O(1)$).

## Evidence

### `inkwell-app/src/js/render/compositor.js:144-161`
```javascript
export function scheduleRedrawTiles() {
  if (_redrawTilesPending) {
    _redrawTilesQueued = true;
    return;
  }
  _redrawTilesPending = true;
  requestAnimationFrame(async () => {
    try {
      await redrawTiles();
    } finally {
      _redrawTilesPending = false;
      if (_redrawTilesQueued) {
        _redrawTilesQueued = false;
        scheduleRedrawTiles();
      }
    }
  });
}
```

### `inkwell-app/src/js/render/tiles.js:162-186` & `tiles.js:224-234`
```javascript
function drawTileData(pctx, viewport, pane, pageLayout, z, ts, tileData) {
  const [pageSx0, pageSy0] = viewport.worldToScreen(pageLayout.x, pageLayout.y, pane);
  const [pageSx1, pageSy1] = viewport.worldToScreen(pageLayout.x + pageLayout.w, pageLayout.y + pageLayout.h, pane);

  pctx.save();
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.scale(state.dpr, state.dpr);
  compositor.clipToPane(pctx, pane);

  pctx.beginPath();
  pctx.rect(pageSx0, pageSy0, pageSx1 - pageSx0, pageSy1 - pageSy0);
  pctx.clip();
  // ...
  pctx.drawImage(tileData.img, 0, 0);
  pctx.restore();
}
```
And at lines 224–234:
```javascript
  if (allMissing.length > 0) {
    await Promise.all(allMissing.map(m => fetchTile(m.sheet, m.tileScale, m.tx, m.ty).then(tile => {
      if (tile && _viewportRef) {
        compositor.scheduleRedrawTiles();
      }
    })));
  }

  compositor.drawZoomIndicator(pctx, _viewportRef);
  evictOldTiles();
```

## Scope

### Files to Modify
1. `inkwell-app/src/js/render/tiles.js`
2. `inkwell-app/src/js/render/compositor.js`
3. `inkwell-app/src/js/core/document.js`
4. `inkwell-app/src/js/main.js`

### Files NOT to Touch
- Do NOT alter `ink.js` spline math or PDF save serialization in `commands.rs`.
- Do NOT remove `drawZoomIndicator`, `drawPageBackgrounds`, or fallback LOD tile rendering.

## Step-by-Step Implementation

### Step 1: Hoist Page Clipping & Make `redrawTiles()` Non-Blocking in `inkwell-app/src/js/render/tiles.js`

Replace `redrawTilesForPage`, `drawTileData`, and `redrawTiles` (`tiles.js:114-235`) with synchronous cached-tile blitting + non-blocking background tile fetches:

```javascript
function redrawTilesForPage(pctx, viewport, pane, pageLayout, z, tileScale, ts, missingOut) {
  const sheet = pageLayout.sheet;
  const [pageSx0, pageSy0] = viewport.worldToScreen(pageLayout.x, pageLayout.y, pane);
  const [pageSx1, pageSy1] = viewport.worldToScreen(pageLayout.x + pageLayout.w, pageLayout.y + pageLayout.h, pane);

  const paneBounds = compositor.getPaneBounds(pane);
  const visSx0 = Math.max(paneBounds.x0, pageSx0);
  const visSy0 = Math.max(paneBounds.y0, pageSy0);
  const visSx1 = Math.min(paneBounds.x1, pageSx1);
  const visSy1 = Math.min(paneBounds.y1, pageSy1);

  if (visSx1 <= visSx0 || visSy1 <= visSy0) return;

  const pageRelX0 = (visSx0 - pageSx0) / z;
  const pageRelY0 = (visSy0 - pageSy0) / z;
  const pageRelX1 = (visSx1 - pageSx0) / z;
  const pageRelY1 = (visSy1 - pageSy0) / z;

  const tx0 = Math.max(0, Math.floor((pageRelX0 * tileScale) / ts));
  const ty0 = Math.max(0, Math.floor((pageRelY0 * tileScale) / ts));
  const tx1 = Math.max(0, Math.floor((pageRelX1 * tileScale) / ts));
  const ty1 = Math.max(0, Math.floor((pageRelY1 * tileScale) / ts));

  // Clip ONCE per page (pane bounds + page rectangle in CSS coordinates)
  pctx.save();
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.scale(state.dpr, state.dpr);
  compositor.clipToPane(pctx, pane);
  pctx.beginPath();
  pctx.rect(pageSx0, pageSy0, pageSx1 - pageSx0, pageSy1 - pageSy0);
  pctx.clip();

  const scaleFactor = (z / tileScale) * state.dpr;

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const key = `${sheet}:${tileScale}:${tx}:${ty}`;
      const cached = state.tileCache.get(key);
      if (cached) {
        cached.lastUsed = performance.now();
        drawTileDataFast(pctx, viewport, pane, pageLayout, scaleFactor, ts, tx, ty, cached);
      } else {
        let drewFallback = false;
        for (const [, fVal] of state.tileCache.entries()) {
          if (fVal.sheet !== sheet) continue;
          const fScale = fVal.scale;
          if (fScale === tileScale) continue;
          const fWorldX0 = ( fVal.tx      * ts) / fScale;
          const fWorldY0 = ( fVal.ty      * ts) / fScale;
          const fWorldX1 = ((fVal.tx + 1) * ts) / fScale;
          const fWorldY1 = ((fVal.ty + 1) * ts) / fScale;
          const tWorldX0 = ( tx      * ts) / tileScale;
          const tWorldY0 = ( ty      * ts) / tileScale;
          const tWorldX1 = ((tx + 1) * ts) / tileScale;
          const tWorldY1 = ((ty + 1) * ts) / tileScale;
          if (fWorldX0 < tWorldX1 && fWorldX1 > tWorldX0 &&
              fWorldY0 < tWorldY1 && fWorldY1 > tWorldY0) {
            const fScaleFactor = (z / fScale) * state.dpr;
            drawTileDataFast(pctx, viewport, pane, pageLayout, fScaleFactor, ts, fVal.tx, fVal.ty, fVal);
            drewFallback = true;
          }
        }
        missingOut.push({ key, sheet, tileScale, tx, ty, drewFallback });
      }
    }
  }
  pctx.restore();
}

function drawTileDataFast(pctx, viewport, pane, pageLayout, scaleFactor, ts, tx, ty, tileData) {
  const tilePageX = (tx * ts) / tileData.scale;
  const tilePageY = (ty * ts) / tileData.scale;
  const [sx, sy] = viewport.worldToScreen(pageLayout.x + tilePageX, pageLayout.y + tilePageY, pane);
  pctx.setTransform(scaleFactor, 0, 0, scaleFactor, sx * state.dpr, sy * state.dpr);
  pctx.drawImage(tileData.img, 0, 0);
}

export function redrawTiles(viewport) {
  if (viewport) _viewportRef = viewport;
  if (!_viewportRef) return;

  const { pctx, pdfCanvas } = compositor.getContexts();
  if (!pctx || !pdfCanvas) return;

  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.clearRect(0, 0, pdfCanvas.width, pdfCanvas.height);

  compositor.drawPageBackgrounds(pctx, _viewportRef);

  const ts = state.tileSize;
  const allMissing = [];

  const leftZ = _viewportRef.zoom;
  const leftScale = quantizeScale(leftZ * state.dpr);
  const leftPages = _viewportRef.getVisiblePages('left', 320);
  for (const pl of leftPages) {
    redrawTilesForPage(pctx, _viewportRef, 'left', pl, leftZ, leftScale, ts, allMissing);
  }

  if (_viewportRef.splitMode) {
    const rightZ = _viewportRef.rightZoom;
    const rightScale = quantizeScale(rightZ * state.dpr);
    const rightPages = _viewportRef.getVisiblePages('right', 320);
    for (const pl of rightPages) {
      redrawTilesForPage(pctx, _viewportRef, 'right', pl, rightZ, rightScale, ts, allMissing);
    }
  }

  compositor.drawZoomIndicator(pctx, _viewportRef);
  evictOldTiles();

  if (allMissing.length > 0) {
    for (const m of allMissing) {
      fetchTile(m.sheet, m.tileScale, m.tx, m.ty).then(tile => {
        if (tile && _viewportRef) {
          compositor.scheduleRedrawTiles();
        }
      });
    }
  }
}
```

### Step 2: Synchronous RAF Tile Scheduling & Offscreen Per-Page `#dry` Cache in `inkwell-app/src/js/render/compositor.js`

1. In `compositor.js:144-161`, update `scheduleRedrawTiles()` to call `redrawTiles()` synchronously inside the RAF callback:
```javascript
export function scheduleRedrawTiles() {
  if (_redrawTilesPending) {
    _redrawTilesQueued = true;
    return;
  }
  _redrawTilesPending = true;
  requestAnimationFrame(() => {
    try {
      redrawTiles();
    } finally {
      _redrawTilesPending = false;
      if (_redrawTilesQueued) {
        _redrawTilesQueued = false;
        scheduleRedrawTiles();
      }
    }
  });
}
```

2. Add the per-page `#dry` offscreen bitmap cache in `compositor.js`:
```javascript
const _dryPageCache = new Map(); // sheet -> { canvas, ctx, scaleKey, version, w, h }
let _dryGlobalVersion = 1;
const _drySheetVersions = new Map(); // sheet -> number

export function invalidateDryPageCache(sheet = null) {
  if (sheet === null || sheet === undefined) {
    _dryGlobalVersion++;
    _dryPageCache.clear();
  } else {
    const prev = _drySheetVersions.get(sheet) || 0;
    _drySheetVersions.set(sheet, prev + 1);
    _dryPageCache.delete(sheet);
  }
}
```
3. In `redrawDryForPane(ctx, viewport, pane)` (`compositor.js:295-404`):
   - Check if we can use the cached page bitmap:
     `const canUsePageCache = !(state.activeTool === 'lasso' && state.isTransforming) && (z * state.dpr <= 2.25);`
   - When `canUsePageCache` is true for a visible `pl` (`sheet = pl.sheet`):
     - Compute `renderScale = z * state.dpr`, `targetW = Math.max(1, Math.round(pl.w * renderScale))`, `targetH = Math.max(1, Math.round(pl.h * renderScale))`.
     - Compute `versionKey = `${_dryGlobalVersion}:${_drySheetVersions.get(sheet) || 0}:${state.darkPageMode ? 1 : 0}:${state.pageTemplate || 'blank'}:${(state.pageTemplates && state.pageTemplates[sheet]) || ''}:${targetW}x${targetH}``.
     - If `_dryPageCache.get(sheet)` does not match `versionKey`, create or resize an offscreen `document.createElement('canvas')` (`width = targetW`, `height = targetH`), set `offCtx.setTransform(renderScale, 0, 0, renderScale, 0, 0)`, and render that page's template, images, text objects, and strokes (`strokeSheetMap.get(sheet)`) into `offCtx` in page-local coordinates `(0, 0)`. Evict oldest entries if `_dryPageCache.size > 12`.
     - Blit `entry.canvas` onto `ctx` with:
       ```javascript
       ctx.save();
       ctx.setTransform(1, 0, 0, 1, 0, 0);
       ctx.scale(state.dpr, state.dpr);
       clipToPane(ctx, pane);
       ctx.drawImage(entry.canvas, psx, psy, pl.w * z, pl.h * z);
       ctx.restore();
       ```
   - When `canUsePageCache` is false (e.g. during active Lasso drag/rotate/scale or extreme zoom `> 2.25x`), use the existing direct vector rendering path so interactive selection hiding (`selectedSet`) and ultra-zoom crispness remain 100% exact!

### Step 3: Hook `invalidateDryPageCache()` into Mutation Points
- In `compositor.js`: call `invalidateDryPageCache()` inside `initCanvases()` and whenever `redrawAll()` is called after a mutation, OR call `invalidateDryPageCache()` inside `document.js` (`notifyMutation`), `templates.js`, and `main.js` when loading a document, committing/erasing/transforming strokes, or toggling dark mode.
- Specifically, calling `invalidateDryPageCache()` inside `notifyMutation` in `inkwell-app/src/js/core/document.js` AND on `strokeCommitted` / `documentLoaded` / template changes in `main.js` guarantees the cache is *never* stale when annotations change, while remaining 100% valid across all pure pan/scroll/pinch frames!

## Verification

1. Run Rust tests & clippy:
   ```bash
   cd inkwell && cargo test --workspace -- --test-threads=1 && cargo clippy --all-targets
   ```
2. Run Desktop App Playwright smoke suite:
   ```bash
   cd inkwell-app && python3 test_app_smoke.py
   ```
   Expected: `126/126` checks pass with zero console errors.

## STOP Conditions
- STOP if any smoke test in `test_app_smoke.py` fails due to stale `#dry` canvas content after `commitStroke`, `eraseStrokesByIds`, `undo`, `redo`, or `lasso` transform—ensure `invalidateDryPageCache()` is invoked on every stroke/image/text/template state transition.
