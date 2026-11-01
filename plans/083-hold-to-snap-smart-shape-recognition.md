# Plan 083: Hold-to-Snap Smart Shape Recognition (Freehand Ink-to-Shape)

| Field | Value |
|---|---|
| **Priority** | P1 |
| **Effort** | M (~240 lines across 4 files) |
| **Category** | Feature / Smart Inking |
| **Depends on** | 080 |
| **Status** | TODO |

## Why

In modern digital note-taking environments (GoodNotes, Notability, Apple Notes), users should not have to constantly switch between the freehand **Pen/Highlighter** tool and the **Shape** tool just to draw a straight underline, box an equation, circle a term, or sketch a triangle. By detecting when the user **holds the stylus still for ~380 ms at the end of a freehand stroke**, InkWell can automatically recognize and snap rough freehand lines, rectangles, ellipses/circles, and triangles into crisp geometric vector strokes—while allowing a single `Ctrl+Z` (or `Esc` before lifting) to revert to the original freehand stroke!

## Evidence

### `inkwell-app/src/js/ink.js:629-718`
`ink.js` already provides `generateShapePoints(kind, p0, p1, baseW)` for `'line'`, `'arrow'`, `'rect'`, `'ellipse'`, and `'triangle'`, plus `rdpSimplify(pts, eps)` (`ink.js:126-152`).

### `inkwell-app/src/js/tools/pen.js:64-175`
`pen.js` handles `onPointerDown`, `onPointerMove`, and `onPointerUp` for `'pen'`, `'highlighter'`, and `'shape'`. Currently, `'pen'` and `'highlighter'` always commit raw freehand points.

## Scope

### Files to Modify
1. `inkwell-app/src/js/ink.js`
2. `inkwell-app/src/js/tools/pen.js`
3. `inkwell-app/src/js/core/state.js`
4. `inkwell-app/test_app_smoke.py`

### Files NOT to Touch
- Do NOT alter the dedicated `shape` tool's behavior (`state.activeTool === 'shape'`).

## Step-by-Step Implementation

### Step 1: Add `recognizeFreehandShape(pts, baseW)` in `inkwell-app/src/js/ink.js`

Add and export `recognizeFreehandShape(pts, baseW = 2.5)` in `ink.js` (and expose it on `window.Ink.recognizeFreehandShape`):

1. **Preconditions**:
   - Require `Array.isArray(pts) && pts.length >= 6`.
   - Compute total arc length $L = \sum_{i=1}^{N-1} \text{hypot}(p_i.x - p_{i-1}.x, p_i.y - p_{i-1}.y)$ and bounding box $[x_{\min}, y_{\min}, x_{\max}, y_{\max}]$, $W = x_{\max} - x_{\min}$, $H = y_{\max} - y_{\min}$.
   - If $L < 28$, return `null`.

2. **Straight Line Classification**:
   - Compute endpoint distance $D = \text{hypot}(p_{N-1}.x - p_0.x, p_{N-1}.y - p_0.y)$.
   - Compute maximum perpendicular distance $d_{\max}$ of all points $p_i$ from segment $p_0 \to p_{N-1}$.
   - If $D / L \ge 0.90$ and $d_{\max} \le \max(8, 0.055 \cdot L)$:
     - Snap to horizontal/vertical/45° if within $4^\circ$ of a cardinal/diagonal axis.
     - Return `{ kind: 'line', points: generateShapePoints('line', p0, pEnd, baseW) }`.

3. **Closed Loop Classification (Triangle, Rectangle, Ellipse/Circle)**:
   - Check if the stroke is approximately closed: $D \le \max(32, 0.24 \cdot L)$ and $W \ge 16$ and $H \ge 16$.
   - Simplify the loop with `const simplified = rdpSimplify(pts, Math.max(4, 0.045 * Math.hypot(W, H)))`.
   - Drop the closing vertex if it is within $0.20 \cdot \text{hypot}(W, H)$ of `simplified[0]` to count distinct corners `corners`.
   - **Triangle (`corners.length === 3`)**:
     - Generate a closed 3-edge polygon connecting `corners[0] -> corners[1] -> corners[2] -> corners[0]` with dense interpolated points (`w: baseW * 0.68`, `p: 0.5`).
     - Return `{ kind: 'triangle', points: triPoints }`.
   - **Rectangle (`corners.length === 4`)**:
     - Verify internal angles at the 4 corners are within $[62^\circ, 118^\circ]$.
     - Return `{ kind: 'rect', points: generateShapePoints('rect', { x: minX, y: minY, w: baseW * 0.68, p: 0.5 }, { x: maxX, y: maxY, w: baseW * 0.68, p: 0.5 }, baseW) }`.
   - **Ellipse / Circle**:
     - Compute center $(cx, cy) = ((x_{\min} + x_{\max}) / 2, (y_{\min} + y_{\max}) / 2)$ and radii $(rx, ry) = (W / 2, H / 2)$.
     - Compute mean normalized radial deviation $\varepsilon = \frac{1}{N} \sum \left| \sqrt{\left(\frac{p_i.x - cx}{rx}\right)^2 + \left(\frac{p_i.y - cy}{ry}\right)^2} - 1 \right|$.
     - If $\varepsilon \le 0.17$:
       - If $|W - H| / \max(W, H) \le 0.14$, equalize $rx = ry = (W + H) / 4$ to snap to a true circle!
       - Return `{ kind: 'ellipse', points: generateShapePoints('ellipse', { x: cx - rx, y: cy - ry, w: baseW * 0.68, p: 0.5 }, { x: cx + rx, y: cy + ry, w: baseW * 0.68, p: 0.5 }, baseW) }`.

4. Return `null` if no geometric primitive matches confidently.

### Step 2: Add Hold-to-Snap Dwell Timer in `inkwell-app/src/js/tools/pen.js`

1. In `state.js`, add `smartShapeHoldEnabled: true`, `holdSnappedShape: null`, and `preSnapRawPts: null`.
2. In `pen.js`:
   - Maintain module-level `let _holdTimer = null;` and `let _holdAnchor = null;`.
   - Export `cancelHoldSnapTimer()` that clears `_holdTimer`.
   - In `onPointerDown`: clear `_holdTimer`, reset `state.holdSnappedShape = null`, `state.preSnapRawPts = null`, `_holdAnchor = { x: px, y: py }`.
   - In `onPointerMove`:
     - If `state.holdSnappedShape`:
       - If `state.holdSnappedShape.kind === 'line'`, dragging after snap adjusts the line endpoint `p1 = { x: px, y: py }` live!
       - Return after calling `renderActiveWetStroke(pane, viewport)`.
     - If `!_holdAnchor || Math.hypot(px - _holdAnchor.x, py - _holdAnchor.y) > 2.8`:
       - `_holdAnchor = { x: px, y: py }`;
       - Reset `_holdTimer` (`clearTimeout(_holdTimer)`).
       - If `state.smartShapeHoldEnabled !== false && (state.activeTool === 'pen' || state.activeTool === 'highlighter')`:
         - Schedule `_holdTimer = setTimeout(() => { ... }, 380)` which calls `window.Ink.recognizeFreehandShape(state.rawPts, baseW)`.
         - When a shape is recognized:
           - Save `state.preSnapRawPts = state.rawPts.slice()`.
           - Replace `state.rawPts = recognized.points`, clear `state._wetChunks = []`, `state._wetChunkedIndex = 0`, set `state.holdSnappedShape = recognized`, and call `renderActiveWetStroke(pane, viewport)`.

### Step 3: Add Playwright Smoke Check in `inkwell-app/test_app_smoke.py`

Add a check verifying `window.Ink.recognizeFreehandShape` recognizes a freehand line, rectangle, and circle and returns valid point arrays.

## Verification

```bash
cd inkwell-app && python3 test_app_smoke.py
```

## STOP Conditions
- STOP if cursive handwriting or small quick strokes trigger false-positive shape snaps—the $380\text{ ms}$ stationary dwell timer plus $L \ge 28$ minimum arc length must both be satisfied before snapping.
