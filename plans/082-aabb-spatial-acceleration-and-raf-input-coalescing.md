# Plan 082: Fast AABB Spatial Indexing for Lasso, Selection Bounds, Eraser & RAF Input Coalescing

| Field | Value |
|---|---|
| **Priority** | P1 |
| **Effort** | S (~120 lines across 4 files) |
| **Category** | Performance / Hit-Testing & Input Responsiveness |
| **Depends on** | 079 |
| **Status** | TODO |

## Why

1. **`getSelectionBounds` Loops Over All Points of All Selected Strokes on Every Hover (`overlays.js:7-60`, `main.js:1719`)**:
   In `main.js:1719`, every hovered `pointermove` when the Lasso tool is active calls `lassoTool.getHandleAtScreen(sx, sy, viewport)`, which calls `getSelectionBounds(viewport)`. Inside `overlays.js:25-36`, `getSelectionBounds` loops over every point `p` of every selected stroke (`for (const p of pts)`), even though every stroke already maintains a precomputed `s.bbox = [minX, minY, maxX, maxY]` in page-local coordinates (`ink.js:525-534`)!
2. **`selectObjectsInPolygon` & `findObjectAtWorld` Lack AABB Pre-Filtering (`lasso.js:434-553`)**:
   - `selectObjectsInPolygon()` runs $O(V)$ ray-casting (`pointInPolygon`) on every point of every stroke across *every page in the document* without first checking if the stroke's bounding box intersects the lasso polygon's bounding box!
   - `findObjectAtWorld()` tests `Math.hypot` and `distToSegment` on every segment of every stroke on `targetSheet` without first checking if `(px, py)` is within `s.bbox ± radius`!
3. **Unthrottled `textSelection.onPointerMove` on 240Hz `pointerrawupdate` (`main.js:1731-1733`)**:
   When dragging a text selection (`state.activeTool === 'text-select' && state.isTextSelecting`), `handlePointerMove` is triggered on every `pointerrawupdate` (up to 240Hz), running character distance scans, array filtering, and `scheduleRedrawAll()` multiple times per display frame.

## Evidence

### `inkwell-app/src/js/render/overlays.js:25-36`
```javascript
  for (const s of selStrokes) {
    if (s.deleted) continue;
    const pl = viewport.getPageLayout(s.sheet || 0);
    const pts = s.points || s._pts || [];
    for (const p of pts) {
      const wx = pl.x + p.x;
      const wy = pl.y + p.y;
      if (wx < minX) minX = wx;
      if (wy < minY) minY = wy;
      if (wx > maxX) maxX = wx;
      if (wy > maxY) maxY = wy;
    }
  }
```

### `inkwell-app/src/js/tools/lasso.js:434-451`
```javascript
  for (const s of state.strokes) {
    if (s.deleted) continue;
    const pl = viewport.getPageLayout(s.sheet || 0);
    const pts = s.points || s._pts || [];
    if (!pts.length) continue;

    let hit = false;
    for (const p of pts) {
      if (pointInPolygon(pl.x + p.x, pl.y + p.y, polygon)) {
        hit = true;
        break;
      }
    }
    if (hit) selectedStrokes.push(s);
  }
```

## Scope

### Files to Modify
1. `inkwell-app/src/js/render/overlays.js`
2. `inkwell-app/src/js/tools/lasso.js`
3. `inkwell-app/src/js/tools/eraser.js`
4. `inkwell-app/src/js/main.js`

### Files NOT to Touch
- Do NOT change the external return signature of `getSelectionBounds`, `findObjectAtWorld`, or `selectObjectsInPolygon`.

## Step-by-Step Implementation

### Step 1: Use `s.bbox` in `getSelectionBounds` (`inkwell-app/src/js/render/overlays.js:25-38`)

Replace the inner `for (const p of pts)` loop in `getSelectionBounds(viewport)` with an $O(1)$ `s.bbox` lookup (falling back to computing and caching `s.bbox` if missing):
```javascript
  for (const s of selStrokes) {
    if (s.deleted) continue;
    const pl = viewport.getPageLayout(s.sheet || 0);
    if (!s.bbox && window.Ink && window.Ink.computeBBox) {
      s.bbox = window.Ink.computeBBox(s);
    }
    if (s.bbox && Number.isFinite(s.bbox[0])) {
      const wx0 = pl.x + s.bbox[0];
      const wy0 = pl.y + s.bbox[1];
      const wx1 = pl.x + s.bbox[2];
      const wy1 = pl.y + s.bbox[3];
      if (wx0 < minX) minX = wx0;
      if (wy0 < minY) minY = wy0;
      if (wx1 > maxX) maxX = wx1;
      if (wy1 > maxY) maxY = wy1;
    } else {
      const pts = s.points || s._pts || [];
      for (const p of pts) {
        const wx = pl.x + p.x;
        const wy = pl.y + p.y;
        if (wx < minX) minX = wx;
        if (wy < minY) minY = wy;
        if (wx > maxX) maxX = wx;
        if (wy > maxY) maxY = wy;
      }
    }
  }
```

### Step 2: Add Polygon & Point AABB Rejection in `inkwell-app/src/js/tools/lasso.js`

1. In `selectObjectsInPolygon(polygon, viewport)` (`lasso.js:428-478`):
   Compute the polygon's world AABB first:
   ```javascript
   let polyMinX = Infinity, polyMinY = Infinity, polyMaxX = -Infinity, polyMaxY = -Infinity;
   for (let i = 0; i < polygon.length; i++) {
     const px = polygon[i][0], py = polygon[i][1];
     if (px < polyMinX) polyMinX = px;
     if (py < polyMinY) polyMinY = py;
     if (px > polyMaxX) polyMaxX = px;
     if (py > polyMaxY) polyMaxY = py;
   }
   ```
   Inside `for (const s of state.strokes)`:
   ```javascript
   if (!s.bbox && window.Ink && window.Ink.computeBBox) {
     s.bbox = window.Ink.computeBBox(s);
   }
   if (s.bbox) {
     if (pl.x + s.bbox[2] < polyMinX || pl.x + s.bbox[0] > polyMaxX ||
         pl.y + s.bbox[3] < polyMinY || pl.y + s.bbox[1] > polyMaxY) {
       continue;
     }
   }
   ```

2. In `findObjectAtWorld(wx, wy, viewport, radius = 10)` (`lasso.js:522-550`):
   Compute `const px = wx - pl.x; const py = wy - pl.y;` once before the stroke loop, and inside `for (let i = (state.strokes || []).length - 1; i >= 0; i--)`:
   ```javascript
   const pad = radius + (s.base_width || 4);
   if (s.bbox && (px < s.bbox[0] - pad || px > s.bbox[2] + pad || py < s.bbox[1] - pad || py > s.bbox[3] + pad)) {
     continue;
   }
   ```

3. In `inkwell-app/src/js/tools/eraser.js:84-118`:
   Ensure `s.bbox` is checked against `(px, py)` and `r + (s.base_width || 4)` before iterating `pts`.

### Step 3: Coalesce `textSelection.onPointerMove` in `inkwell-app/src/js/main.js:1730-1735`

In `main.js`, skip `pointerrawupdate` events for `text-select` so `textSelection.onPointerMove` only runs on display-aligned `pointermove` events (or coalesce via `requestAnimationFrame`):
```javascript
    if (state.activeTool === 'text-select') {
      if (e.type === 'pointerrawupdate') return;
      if (state.isTextSelecting) {
        textSelection.onPointerMove(e, viewport, sx, sy, activePane);
      }
      return;
    }
```

## Verification

1. Run Desktop App Playwright smoke suite:
   ```bash
   cd inkwell-app && python3 test_app_smoke.py
   ```
   Expected: `126/126` checks pass.

## STOP Conditions
- STOP if `s.bbox` is not updated after a Lasso move/rotate/scale transform—verify that `commitTransform` in `lasso.js` calls `window.Ink.computeBBox(s)` when updating `s.points`.
