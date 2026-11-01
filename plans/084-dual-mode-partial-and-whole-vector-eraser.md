# Plan 084: Dual-Mode Eraser — Partial (Segment-Splitting) Vector Eraser & Whole-Stroke Eraser

| Field | Value |
|---|---|
| **Priority** | P1 |
| **Effort** | M (~230 lines across 5 files) |
| **Category** | Feature / Precision Vector Erasing |
| **Depends on** | 080 |
| **Status** | TODO |

## Why

Currently, `inkwell-app/src/js/tools/eraser.js` only implements **Whole-Stroke Erase**: touching any point of a long diagram border, underline, or handwriting word deletes the entire stroke. Adding a **Partial (Segment-Splitting) Vector Eraser** mode alongside Whole-Stroke mode allows users to erase just a small section of a stroke—cleanly splitting the remaining vector stroke into 0, 1, or 2+ independent vector ribbon strokes while strictly preserving `AGENTS.md` Rule #1 (100% vector filled ribbon outlines, zero raster masks).

## Evidence

### `inkwell-app/src/js/tools/eraser.js:84-125`
`eraseAtPoint(wx, wy, viewport)` iterates `state.strokes`, finds any stroke within `r = 10 / viewport.zoom`, and calls `doc.eraseStrokesByIds(toDeleteIds, { recordUndo: false })`.

### `inkwell-app/src/js/core/document.js:110-165`
`document.js` manages `addStroke`, `eraseStrokesByIds`, `undo()`, and `redo()`.

## Scope

### Files to Modify
1. `inkwell-app/src/js/core/state.js`
2. `inkwell-app/src/js/tools/eraser.js`
3. `inkwell-app/src/js/core/document.js`
4. `inkwell-app/src/index.html` & `inkwell-app/src/js/main.js`
5. `inkwell-app/test_app_smoke.py`

### Files NOT to Touch
- Do NOT use canvas `destination-out` bitmap masking—all split strokes must be true vector `StrokeRecord` objects built via `window.Ink.buildStrokeRecord`.

## Step-by-Step Implementation

### Step 1: Add `eraserMode` & `eraserRadius` to `inkwell-app/src/js/core/state.js`

Add to `state`:
```javascript
  eraserMode: 'stroke', // 'stroke' | 'partial'
  eraserRadius: 12,
```

### Step 2: Implement Vector Segment Splitting in `inkwell-app/src/js/tools/eraser.js`

1. Add and export `splitStrokeByCircle(stroke, cx, cy, r)`:
   - Given a stroke's page-local `pts = stroke.points || stroke._pts || []`, if `pts.length < 2`, return `null`.
   - Subdivide any segment longer than `Math.max(2.5, r * 0.45)` before testing against `(cx, cy, r)` so long straight lines (such as shape edges or underlines) split accurately right at the eraser boundary!
   - Partition the dense point list into contiguous sequences of points that lie **outside** the circle (`Math.hypot(p.x - cx, p.y - cy) > r`).
   - Whenever a segment crosses from outside to inside (or inside to outside) of the circle of radius `r`, compute the exact circle-segment intersection point `p_intersect` via quadratic root finding and append `p_intersect` as the clean cap of that surviving sub-path!
   - Filter surviving sub-paths to those with `subPts.length >= 2` and arc length $\ge 1.5\text{ pt}$.
   - For each surviving sub-path, build a new stroke record via `window.Ink.buildStrokeRecord(subPts, stroke.rgb, stroke.base_width, stroke.sheet, stroke.kind)`.

2. In `eraseAtPoint(wx, wy, viewport)`:
   - When `state.eraserMode !== 'partial'`, execute the existing whole-stroke deletion path.
   - When `state.eraserMode === 'partial'`:
     - Find strokes on `targetSheet` whose `bbox` and geometry intersect `(px, py)` within radius `r = (state.eraserRadius || 12) / viewport.zoom`.
     - For each hit stroke `s`, compute `fragments = splitStrokeByCircle(s, px, py, r)`.
     - Call `doc.replaceStrokeWithFragments(s, fragments, { recordUndo: false })` and record the original stroke in `state.erasedInGesture` and created fragment IDs in `state.addedFragmentsInGesture` so `onPointerUp` pushes a single atomic undo entry!

### Step 3: Support Atomic Undo/Redo & WAL Sync for Split Erasing in `inkwell-app/src/js/core/document.js` and `main.js`

1. In `document.js`:
   - Add `replaceStrokeWithFragments(oldStroke, newStrokes, { recordUndo = true } = {})`:
     - Marks `oldStroke.deleted = true` and removes it from `state.strokes`.
     - Pushes each `ns` in `newStrokes` to `state.strokes`.
     - Emits `notifyMutation('split_erase_stroke', { removed: [oldStroke], added: newStrokes })`.
   - In `undo()` and `redo()` (`document.js`), handle `'erase_strokes'` entries that also carry an optional `addedStrokes` array (from partial erasing):
     - On `undo`: mark `addedStrokes` as deleted (`eraseStrokesByIds`) and restore `removed` strokes!
     - On `redo`: mark `removed` strokes as deleted and restore `addedStrokes`!
2. In `main.js`, wire `'split_erase_stroke'` in `on('documentChanged', ...)` to call `ipc.deleteStroke(oldStroke.id)` and `ipc.commitStroke(ns)` for each fragment so the WAL journal and saved PDF stay 100% synchronized!
3. In `index.html` & `main.js`, add a compact toggle button or context option on `#tool-eraser` (clicking `#tool-eraser` when already active toggles between `Whole Stroke` and `Partial Split` eraser with a clear status toast and `title` indicator).

## Verification

1. Run Desktop App Playwright smoke suite (including a new check for `splitStrokeByCircle` and `eraserMode = 'partial'`):
   ```bash
   cd inkwell-app && python3 test_app_smoke.py
   ```

## STOP Conditions
- STOP if partial erasing leaves orphaned fragments in the backend WAL on undo/redo—every fragment added or removed must emit the standard `commitStroke` / `deleteStroke` IPC calls.
